#!/usr/bin/env node
"use strict";

const { execSync, execFileSync, spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

function notify(title, body) {
  try {
    if (process.platform === "darwin") {
      execFileSync("osascript", ["-e", `display notification "${body}" with title "${title}"`], { timeout: 5000, stdio: "ignore" });
    } else {
      execFileSync("notify-send", [title, body], { timeout: 5000, stdio: "ignore" });
    }
  } catch (_) {}
}
const {
  buildSystemPrompt,
  buildGoalPrompt,
  buildReviewPrompt,
  buildTerminalInstruction,
  buildModelInstruction,
  buildPlanningPrompt,
  buildExecutionPrompt,
} = require("./prompts.cjs");
const { validatePlan, extractPlanFromOutput } = require("./task-schema.cjs");

const TMUX_CONTROL = path.join(__dirname, "tmux-control.cjs");
const SYSTEM_PROMPT = buildSystemPrompt(TMUX_CONTROL);

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Spawn claude -p and capture its output as a string.
 * Returns { code, output }.
 */
function spawnAndCapture(prompt, env) {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(
      "claude",
      ["--dangerously-skip-permissions", "-p", prompt, "--output-format", "stream-json"],
      { stdio: ["ignore", "pipe", "inherit"], cwd: __dirname, env }
    );
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      // Also print assistant text to stderr for visibility
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "assistant" && msg.message && msg.message.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) process.stderr.write(block.text);
            }
          }
          if (msg.type === "result" && msg.result) {
            const t = typeof msg.result === "string" ? msg.result : (msg.result.text || "");
            if (t) process.stderr.write(t);
          }
        } catch (_) {}
      }
    });
    child.on("exit", (code) => resolve({ code, output }));
  });
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("");
  console.log("  ╔══════════════════════════════════╗");
  console.log("  ║    Nested Claude Code Launcher    ║");
  console.log("  ╚══════════════════════════════════╝");
  console.log("");

  const goal = await ask(rl, "  Goal: ");
  if (!goal) {
    console.log("  No goal provided. Exiting.");
    rl.close();
    return;
  }

  const terminalsInput = await ask(rl, "  Terminals [auto]: ");
  const structuredInput = await ask(rl, "  Structured mode [Y/n]: ");
  rl.close();

  const terminalCount = terminalsInput === "" || terminalsInput.toLowerCase() === "auto"
    ? "auto"
    : parseInt(terminalsInput, 10);
  const useStructured = structuredInput.toLowerCase() !== "n";

  const terminalInstruction = buildTerminalInstruction(terminalCount);
  const modelInstruction = buildModelInstruction("sonnet");

  console.log("");
  console.log(`  Goal:       ${goal}`);
  console.log(`  Terminals:  ${terminalCount}`);
  console.log(`  Structured: ${useStructured ? "yes" : "no"}`);
  console.log("");

  const env = Object.assign({}, process.env);
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  let prompt;

  if (useStructured) {
    // Phase 1: Planning
    console.log("  ┌──────────────────────────────────────┐");
    console.log("  │   Planning phase...                   │");
    console.log("  └──────────────────────────────────────┘");
    console.log("");

    const planningPrompt = buildPlanningPrompt(
      TMUX_CONTROL, goal, "", terminalInstruction, modelInstruction
    );

    const { code: planCode, output: planOutput } = await spawnAndCapture(planningPrompt, env);

    if (planCode !== 0) {
      console.log("\n  Planning failed — falling back to legacy mode.\n");
      prompt = buildGoalPrompt(SYSTEM_PROMPT, terminalInstruction, modelInstruction, goal);
    } else {
      const plan = extractPlanFromOutput(planOutput);
      if (!plan) {
        console.log("\n  No structured plan found — falling back to legacy mode.\n");
        prompt = buildGoalPrompt(SYSTEM_PROMPT, terminalInstruction, modelInstruction, goal);
      } else {
        const validation = validatePlan(plan);
        if (!validation.valid) {
          console.log(`\n  Plan validation errors: ${validation.errors.join("; ")}`);
          console.log("  Falling back to legacy mode.\n");
          prompt = buildGoalPrompt(SYSTEM_PROMPT, terminalInstruction, modelInstruction, goal);
        } else {
          console.log("");
          console.log(`  Plan created: ${plan.tasks.length} tasks`);
          for (const t of plan.tasks) {
            const deps = t.dependencies && t.dependencies.length > 0 ? ` [after: ${t.dependencies.join(", ")}]` : "";
            console.log(`    - ${t.name} (${t.role || "worker"}): ${t.description.substring(0, 80)}${deps}`);
          }
          console.log("");

          // Phase 2: Build execution prompt from plan
          prompt = buildExecutionPrompt(TMUX_CONTROL, plan, "", modelInstruction);
        }
      }
    }
  } else {
    prompt = buildGoalPrompt(SYSTEM_PROMPT, terminalInstruction, modelInstruction, goal);
  }

  console.log("  Starting controller...");
  console.log("");

  const child = spawn(
    "claude",
    ["--dangerously-skip-permissions", "-p", prompt],
    {
      stdio: "inherit",
      cwd: __dirname,
      env,
    }
  );

  child.on("exit", (code) => {
    // Cleanup tmux sessions from build
    try {
      execSync(`node ${TMUX_CONTROL} --stop-all`, { stdio: "inherit" });
    } catch (_) {}

    if (code !== 0) {
      notify("Multi-Claude", `Build controller crashed (exit code ${code})`);
      console.log(`\n  Build controller exited with code ${code}`);
      process.exit(code || 1);
    }

    // --- Mandatory review round ---
    console.log("");
    console.log("  ┌──────────────────────────────────────┐");
    console.log("  │   Mandatory Review Round starting...  │");
    console.log("  └──────────────────────────────────────┘");
    console.log("");

    const reviewTerminalInstruction = buildTerminalInstruction("auto");
    const reviewPrompt = buildReviewPrompt(SYSTEM_PROMPT, reviewTerminalInstruction, modelInstruction, goal);

    const reviewChild = spawn(
      "claude",
      ["--dangerously-skip-permissions", "-p", reviewPrompt],
      {
        stdio: "inherit",
        cwd: __dirname,
        env,
      }
    );

    reviewChild.on("exit", (reviewCode) => {
      // Cleanup tmux sessions from review
      try {
        execSync(`node ${TMUX_CONTROL} --stop-all`, { stdio: "inherit" });
      } catch (_) {}

      notify("Multi-Claude", reviewCode === 0 ? "Build complete" : `Review failed (exit code ${reviewCode})`);
      console.log("");
      console.log(`  Review round complete (exit code ${reviewCode})`);
      process.exit(reviewCode || 0);
    });
  });
}

main();
