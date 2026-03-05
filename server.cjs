#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync, spawn } = require("child_process");
const {
  buildSystemPrompt,
  buildGoalPrompt,
  buildIterationPrompt,
  buildReviewPrompt,
  buildTerminalInstruction,
  buildModelInstruction,
  buildPlanningPrompt,
  buildExecutionPrompt,
} = require("./prompts.cjs");
const { JsonlMonitor } = require("./jsonl-monitor.cjs");
const {
  validatePlan, extractPlanFromOutput, createTaskStatus, calculateRetryDelay,
  isTaskTimedOut, canRetryTask, TASK_STATES, TASK_TYPES,
  WAIT_CONDITION_TYPES, DEFAULT_WAIT_POLL_INTERVAL, DEFAULT_WAIT_TIMEOUT,
} = require("./task-schema.cjs");
const { ProjectMemory, extractLearnings, extractIssues, scanFileStructure } = require("./memory.cjs");
const { HookRunner } = require("./hooks.cjs");

const PORT = 3456;

// --- Desktop notifications (safe: uses execFileSync with arg arrays, no shell) ---

function notify(title, body) {
  try {
    if (process.platform === "darwin") {
      execFileSync("osascript", ["-e", `display notification "${body}" with title "${title}"`], { timeout: 5000, stdio: "ignore" });
    } else {
      execFileSync("notify-send", [title, body], { timeout: 5000, stdio: "ignore" });
    }
  } catch (_) {
    // Notifications are best-effort; silently ignore failures
  }
}
const TMUX_CONTROL = path.join(__dirname, "tmux-control.cjs");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BUFFER_LINES = 500;
const POLL_INTERVAL_MS = 2000;
const SESSION_STATE_FILE = path.join(__dirname, ".session-state.json");

const SYSTEM_PROMPT = buildSystemPrompt(TMUX_CONTROL);

// --- State ---

const state = {
  running: false,
  controllerProcess: null,
  controllerOutput: [],   // ring buffer, max MAX_BUFFER_LINES
  goal: "",
  terminalCount: "auto",
  model: "sonnet",
  iterations: 0,          // total iterations requested
  currentIteration: 0,    // 0 = initial build, 1+ = improvement iterations
  reviewDone: false,       // mandatory review completed?
  phase: "idle",           // "planning", "build", "review", "iteration", "postcheck", "idle"
  postChecks: null,        // array of {check, pass, msg} after post-checks run
  sessions: [],
  sseClients: [],
  pollInterval: null,
  monitor: null,
  restoreAttempts: {},  // name → count, prevents infinite restore loops
  // --- CrewAI-inspired features ---
  taskPlan: null,          // structured TaskPlan from planning phase
  taskStatus: {},          // name → { status, validation, attempts, startedAt, ... }
  memory: null,            // ProjectMemory instance
  hooks: null,             // HookRunner instance
  // --- Conductor-inspired features ---
  workflowTimeoutTimer: null,   // setTimeout handle for workflow-level timeout
  taskTimeoutInterval: null,    // setInterval handle for per-task timeout checks
  waitConditionInterval: null,  // setInterval handle for WAIT condition polling
  workflowStartedAt: null,      // timestamp when workflow execution started
  retryQueue: [],               // [{taskName, retryAt}] tasks waiting to be retried
  retryInterval: null,          // setInterval for retry queue processing
};

// --- Helpers ---

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function pushControllerLine(line) {
  state.controllerOutput.push(line);
  if (state.controllerOutput.length > MAX_BUFFER_LINES) {
    state.controllerOutput.shift();
  }
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = state.sseClients.length - 1; i >= 0; i--) {
    try {
      state.sseClients[i].write(msg);
    } catch (_) {
      state.sseClients.splice(i, 1);
    }
  }
}

function runTmux(...args) {
  try {
    return execSync(`node ${TMUX_CONTROL} ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

// Safe variant: passes args as array to avoid shell injection
function runTmuxSafe(...args) {
  try {
    return execFileSync("node", [TMUX_CONTROL, ...args], {
      encoding: "utf-8",
      timeout: 15000,
    }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

function pollTerminals() {
  try {
    const listOutput = runTmux("--list");
    const sessions = [];
    if (listOutput && !listOutput.includes("No active sessions")) {
      const lines = listOutput.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && trimmed !== "Active sessions:") {
          sessions.push(trimmed);
        }
      }
    }
    state.sessions = sessions;

    // Register new sessions with JSONL monitor
    if (state.monitor) {
      for (const name of sessions) {
        const workDir = getWorkDirForSession(name);
        if (workDir) state.monitor.registerSession(name, workDir);
      }
    }

    // Auto-recovery: detect disappeared sessions that had active JSONL state
    if (state.monitor && state.running) {
      const savedState = loadSessionState();
      const agentInfo = state.monitor.getAll();
      for (const [name, info] of Object.entries(agentInfo)) {
        if (info.sessionId && info.state !== "idle" && !sessions.includes(name)) {
          // Cap restore attempts to prevent infinite loops
          const attempts = state.restoreAttempts[name] || 0;
          if (attempts >= 2) continue;
          state.restoreAttempts[name] = attempts + 1;

          const saved = savedState[name];
          if (saved && saved.sessionId && saved.workDir) {
            const restoreMsg = `[Auto-restoring crashed session: ${name} (attempt ${attempts + 1}/2)]`;
            pushControllerLine(restoreMsg);
            broadcast("controller", { line: restoreMsg });
            notify("Multi-Claude", `Auto-restoring crashed agent: ${name}`);
            try {
              runTmux(`--restore ${name} ${saved.sessionId} "${saved.workDir}"`);
            } catch (_) {}
          }
        }
      }
    }

    broadcast("terminals", { sessions });
  } catch (_) {}
}

// --- Conductor-inspired: Task timeout monitoring ---

function startTaskTimeoutMonitoring() {
  if (state.taskTimeoutInterval) return;
  state.taskTimeoutInterval = setInterval(() => {
    if (!state.taskPlan || !state.running) return;

    for (const task of state.taskPlan.tasks) {
      const ts = state.taskStatus[task.name];
      if (!ts) continue;

      if (isTaskTimedOut(ts)) {
        const elapsed = Math.round((Date.now() - ts.startedAt) / 1000);
        const timeoutMsg = `[TIMEOUT] Task "${task.name}" exceeded ${ts.timeoutSeconds}s limit (ran for ${elapsed}s)`;
        pushControllerLine(timeoutMsg);
        broadcast("controller", { line: timeoutMsg });
        notify("Multi-Claude", `Task timed out: ${task.name}`);

        // Kill the worker's tmux session
        try { runTmux(`--stop ${task.name}`); } catch (_) {}

        if (canRetryTask(ts)) {
          // Schedule retry
          ts.status = TASK_STATES.RETRYING;
          ts.error = `Timed out after ${elapsed}s`;
          const delay = calculateRetryDelay(ts.retryLogic, ts.retryDelaySeconds, ts.attempts);
          const retryMsg = `[RETRY] Scheduling retry for "${task.name}" (attempt ${ts.attempts + 1}/${ts.maxAttempts}) in ${Math.round(delay / 1000)}s`;
          pushControllerLine(retryMsg);
          broadcast("controller", { line: retryMsg });
          state.retryQueue.push({ taskName: task.name, retryAt: Date.now() + delay });
        } else {
          // No more retries
          if (ts.optional) {
            ts.status = TASK_STATES.COMPLETED_WITH_ERRORS;
            ts.error = `Timed out after ${elapsed}s (optional task, continuing)`;
            const optMsg = `[OPTIONAL] Task "${task.name}" timed out but is optional — continuing workflow`;
            pushControllerLine(optMsg);
            broadcast("controller", { line: optMsg });
          } else {
            ts.status = TASK_STATES.TIMED_OUT;
            ts.error = `Timed out after ${elapsed}s (no retries remaining)`;
          }
          ts.completedAt = Date.now();
        }
        broadcast("taskStatus", { taskStatus: state.taskStatus });
      }
    }
  }, 5000); // Check every 5 seconds
}

function stopTaskTimeoutMonitoring() {
  if (state.taskTimeoutInterval) {
    clearInterval(state.taskTimeoutInterval);
    state.taskTimeoutInterval = null;
  }
}

// --- Conductor-inspired: Workflow-level timeout ---

function startWorkflowTimeout(timeoutSeconds) {
  if (!timeoutSeconds || timeoutSeconds <= 0) return;
  if (state.workflowTimeoutTimer) clearTimeout(state.workflowTimeoutTimer);

  state.workflowStartedAt = Date.now();
  state.workflowTimeoutTimer = setTimeout(() => {
    const msg = `[WORKFLOW TIMEOUT] Workflow exceeded ${timeoutSeconds}s limit — terminating all tasks`;
    pushControllerLine(msg);
    broadcast("controller", { line: msg });
    notify("Multi-Claude", "Workflow timed out!");

    // Mark all in-progress tasks as timed out
    for (const [name, ts] of Object.entries(state.taskStatus)) {
      if (ts.status === TASK_STATES.IN_PROGRESS || ts.status === TASK_STATES.WAITING || ts.status === TASK_STATES.RETRYING) {
        ts.status = TASK_STATES.TIMED_OUT;
        ts.completedAt = Date.now();
        ts.error = "Workflow timeout exceeded";
      } else if (ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.SCHEDULED) {
        ts.status = TASK_STATES.CANCELLED;
        ts.error = "Cancelled due to workflow timeout";
      }
    }
    broadcast("taskStatus", { taskStatus: state.taskStatus });

    // Stop everything
    stopController();
  }, timeoutSeconds * 1000);

  const timeoutMsg = `[WORKFLOW] Timeout set: ${timeoutSeconds}s (${Math.round(timeoutSeconds / 60)}min)`;
  pushControllerLine(timeoutMsg);
  broadcast("controller", { line: timeoutMsg });
}

function stopWorkflowTimeout() {
  if (state.workflowTimeoutTimer) {
    clearTimeout(state.workflowTimeoutTimer);
    state.workflowTimeoutTimer = null;
  }
}

// --- Conductor-inspired: Retry queue processing ---

function startRetryQueueProcessing() {
  if (state.retryInterval) return;
  state.retryInterval = setInterval(() => {
    if (!state.running || state.retryQueue.length === 0) return;

    const now = Date.now();
    const ready = state.retryQueue.filter(r => now >= r.retryAt);
    state.retryQueue = state.retryQueue.filter(r => now < r.retryAt);

    for (const item of ready) {
      const ts = state.taskStatus[item.taskName];
      if (!ts || ts.status !== TASK_STATES.RETRYING) continue;

      const task = state.taskPlan.tasks.find(t => t.name === item.taskName);
      if (!task) continue;

      const retryMsg = `[RETRY] Restarting task "${item.taskName}" (attempt ${ts.attempts + 1}/${ts.maxAttempts})`;
      pushControllerLine(retryMsg);
      broadcast("controller", { line: retryMsg });

      // Reset task state for retry
      ts.status = TASK_STATES.SCHEDULED;
      ts.startedAt = null;
      ts.error = null;
      broadcast("taskStatus", { taskStatus: state.taskStatus });

      // Restart the worker tmux session
      retryWorkerTask(task);
    }
  }, 3000);
}

function stopRetryQueueProcessing() {
  if (state.retryInterval) {
    clearInterval(state.retryInterval);
    state.retryInterval = null;
  }
  state.retryQueue = [];
}

/**
 * Retry a single worker task by restarting its tmux session.
 * The controller is still running — we restart just this worker.
 */
function retryWorkerTask(task) {
  const ts = state.taskStatus[task.name];
  if (!ts) return;

  try {
    // Stop old session if it exists
    try { runTmux(`--stop ${task.name}`); } catch (_) {}

    // Get the working directory from controller output
    const workDir = getWorkDirForSession(task.name) || __dirname;

    // Start new session
    runTmux(`--start ${task.name} "${workDir}"`);

    // Mark as in_progress
    ts.status = TASK_STATES.IN_PROGRESS;
    ts.attempts++;
    ts.startedAt = Date.now();
    broadcast("taskStatus", { taskStatus: state.taskStatus });

    // Launch Claude Code in the new session
    const model = state.model || "sonnet";
    setTimeout(() => {
      runTmux(`--cmd ${task.name} "claude --dangerously-skip-permissions --model ${model}"`);
      setTimeout(() => {
        runTmux(`--cmd ${task.name} ""`);
        setTimeout(() => {
          // Send the worker prompt
          const { buildWorkerPrompt } = require("./task-schema.cjs");
          const memoryContext = state.memory ? state.memory.buildContext() : "";
          const prompt = buildWorkerPrompt(task, state.taskPlan.sharedContext || "", memoryContext);
          // Escape for shell — replace double quotes with escaped
          const escaped = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
          runTmux(`--cmd ${task.name} "${escaped}"`);
          setTimeout(() => {
            runTmux(`--cmd ${task.name} ""`);
          }, 1000);
        }, 2000);
      }, 1000);
    }, 2000);

    const msg = `[RETRY] Worker "${task.name}" restarted (attempt ${ts.attempts}/${ts.maxAttempts})`;
    pushControllerLine(msg);
    broadcast("controller", { line: msg });
  } catch (e) {
    const errMsg = `[RETRY ERROR] Failed to restart "${task.name}": ${e.message}`;
    pushControllerLine(errMsg);
    broadcast("controller", { line: errMsg });
    ts.status = TASK_STATES.FAILED;
    ts.completedAt = Date.now();
    ts.error = `Retry restart failed: ${e.message}`;
    broadcast("taskStatus", { taskStatus: state.taskStatus });
  }
}

// --- Conductor-inspired: WAIT condition checking ---

function startWaitConditionPolling() {
  if (state.waitConditionInterval) return;
  state.waitConditionInterval = setInterval(() => {
    if (!state.taskPlan || !state.running) return;

    for (const task of state.taskPlan.tasks) {
      const ts = state.taskStatus[task.name];
      if (!ts || ts.status !== TASK_STATES.WAITING) continue;
      if (!ts.waitCondition) continue;

      let conditionMet = false;
      const projectDir = findProjectDir() || __dirname;

      if (ts.waitCondition.type === WAIT_CONDITION_TYPES.FILE_EXISTS) {
        const filePath = path.resolve(projectDir, ts.waitCondition.target);
        conditionMet = fs.existsSync(filePath);
      } else if (ts.waitCondition.type === WAIT_CONDITION_TYPES.HTTP_READY) {
        try {
          execSync(`curl -sf -o /dev/null --max-time 3 "${ts.waitCondition.target}"`, {
            timeout: 5000, stdio: "pipe"
          });
          conditionMet = true;
        } catch (_) {
          conditionMet = false;
        }
      }

      if (conditionMet) {
        const waitMsg = `[WAIT] Condition met for "${task.name}" (${ts.waitCondition.type}: ${ts.waitCondition.target})`;
        pushControllerLine(waitMsg);
        broadcast("controller", { line: waitMsg });
        ts.status = TASK_STATES.SCHEDULED;
        broadcast("taskStatus", { taskStatus: state.taskStatus });
      } else {
        // Check WAIT timeout
        const waitTimeout = (ts.waitCondition.timeoutSeconds || DEFAULT_WAIT_TIMEOUT) * 1000;
        if (ts.startedAt && (Date.now() - ts.startedAt) > waitTimeout) {
          const waitTimeoutMsg = `[WAIT TIMEOUT] Task "${task.name}" wait condition not met within ${ts.waitCondition.timeoutSeconds || DEFAULT_WAIT_TIMEOUT}s`;
          pushControllerLine(waitTimeoutMsg);
          broadcast("controller", { line: waitTimeoutMsg });
          if (ts.optional) {
            ts.status = TASK_STATES.COMPLETED_WITH_ERRORS;
            ts.error = "Wait condition timed out (optional task)";
          } else {
            ts.status = TASK_STATES.TIMED_OUT;
            ts.error = "Wait condition timed out";
          }
          ts.completedAt = Date.now();
          broadcast("taskStatus", { taskStatus: state.taskStatus });
        }
      }
    }
  }, (DEFAULT_WAIT_POLL_INTERVAL) * 1000);
}

function stopWaitConditionPolling() {
  if (state.waitConditionInterval) {
    clearInterval(state.waitConditionInterval);
    state.waitConditionInterval = null;
  }
}

// --- Conductor-inspired: Failure workflow ---

function runFailureWorkflow(failedTasks) {
  if (!state.taskPlan) return;

  const failureDescription = state.taskPlan.failureWorkflow;
  if (!failureDescription && failedTasks.length === 0) return;

  const failureMsg = `\n--- Failure Workflow: Diagnosing ${failedTasks.length} failed task(s) ---\n`;
  pushControllerLine(failureMsg);
  broadcast("controller", { line: failureMsg });

  const failureSummary = failedTasks.map(name => {
    const ts = state.taskStatus[name];
    return `- ${name}: ${ts.status} (${ts.error || "unknown error"}, attempts: ${ts.attempts}/${ts.maxAttempts})`;
  }).join("\n");

  const diagMsg = `Failed tasks:\n${failureSummary}`;
  pushControllerLine(diagMsg);
  broadcast("controller", { line: diagMsg });
  notify("Multi-Claude", `${failedTasks.length} task(s) failed — check dashboard`);

  // Fire hook if available
  if (state.hooks && state.hooks.hasHooks) {
    state.hooks.run("tasks.failed", {
      failedTasks: failedTasks.map(name => ({
        name,
        ...state.taskStatus[name],
      })),
    });
  }
}

// --- Conductor-inspired: Cleanup all Conductor timers ---

function stopConductorTimers() {
  stopTaskTimeoutMonitoring();
  stopWorkflowTimeout();
  stopRetryQueueProcessing();
  stopWaitConditionPolling();
}

function startPolling() {
  if (state.pollInterval) return;
  state.pollInterval = setInterval(pollTerminals, POLL_INTERVAL_MS);
  // Do an immediate poll
  pollTerminals();
}

function stopPolling() {
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
}

// --- Shared helper: find workDir for a session name from controller output ---

function getWorkDirForSession(name) {
  const startRegex = new RegExp(`--start\\s+${name}\\s+(\\S+)`);
  for (const line of state.controllerOutput) {
    const m = startRegex.exec(line);
    if (m && m[1]) return path.resolve(__dirname, m[1]);
  }
  return null;
}

// --- Session state persistence ---

function saveSessionState() {
  if (!state.monitor) return;
  const all = state.monitor.getAll();
  const stateMap = {};
  for (const [name, info] of Object.entries(all)) {
    if (info.sessionId) {
      const workDir = getWorkDirForSession(name);
      if (workDir) {
        stateMap[name] = { sessionId: info.sessionId, workDir };
      }
    }
  }
  try {
    fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(stateMap, null, 2));
  } catch (_) {}
}

function loadSessionState() {
  try {
    if (fs.existsSync(SESSION_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_STATE_FILE, "utf-8"));
    }
  } catch (_) {}
  return {};
}

function clearSessionState() {
  try { fs.unlinkSync(SESSION_STATE_FILE); } catch (_) {}
}

// --- Project directory detection ---

function findProjectDir() {
  // Scan controller output for --start <name> <dir> commands to find working directories
  const startRegex = /--start\s+\S+\s+(\S+)/;
  const dirs = new Set();
  for (const line of state.controllerOutput) {
    const m = startRegex.exec(line);
    if (m && m[1]) {
      const dir = path.resolve(__dirname, m[1]);
      if (fs.existsSync(dir)) dirs.add(dir);
    }
  }

  // Return the first dir that contains an index.html (most likely the web project)
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }

  // Fallback: scan __dirname for subdirs containing index.html
  try {
    const entries = fs.readdirSync(__dirname, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "public") {
        const candidate = path.join(__dirname, entry.name);
        if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
      }
    }
  } catch (_) {}

  // Last resort: if __dirname itself has an index.html created by workers
  // (unlikely but handle it)
  return dirs.size > 0 ? [...dirs][0] : null;
}

// --- Post-build checks ---

async function runPostChecks(projectDir) {
  const results = [];

  if (!projectDir || !fs.existsSync(projectDir)) {
    results.push({ check: "Project directory", pass: false, msg: "Could not find project directory" });
    return results;
  }

  // Check 1: index.html exists (web projects)
  const indexPath = path.join(projectDir, "index.html");
  if (fs.existsSync(indexPath)) {
    const stat = fs.statSync(indexPath);
    results.push({ check: "index.html exists", pass: stat.size > 0, msg: stat.size > 0 ? `${stat.size} bytes` : "File is empty (0 bytes)" });
  } else {
    results.push({ check: "index.html exists", pass: false, msg: "Not found" });
  }

  // Check 2: node --check on every .js file
  try {
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".js"));
    for (const file of files) {
      const filePath = path.join(projectDir, file);
      try {
        execSync(`node --check "${filePath}"`, { encoding: "utf-8", timeout: 10000, stdio: "pipe" });
        results.push({ check: `node --check ${file}`, pass: true, msg: "Syntax OK" });
      } catch (e) {
        const errMsg = (e.stderr || e.message || "").split("\n")[0].trim();
        results.push({ check: `node --check ${file}`, pass: false, msg: errMsg || "Syntax error" });
      }
    }
    if (files.length === 0) {
      results.push({ check: "JS syntax check", pass: true, msg: "No .js files found" });
    }
  } catch (_) {
    results.push({ check: "JS syntax check", pass: false, msg: "Could not list files" });
  }

  // Check 3: serve and curl test
  let servePid = null;
  try {
    const serveProc = spawn("npx", ["-y", "serve", projectDir, "-p", "8099", "-s"], {
      stdio: "pipe",
      detached: true,
    });
    servePid = serveProc.pid;

    // Wait 3 seconds for server to start
    await new Promise(r => setTimeout(r, 3000));

    try {
      const httpCode = execSync(
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:8099`,
        { encoding: "utf-8", timeout: 10000, stdio: "pipe" }
      ).trim();
      results.push({
        check: "HTTP serve test",
        pass: httpCode === "200",
        msg: `HTTP ${httpCode}`,
      });
    } catch (e) {
      results.push({ check: "HTTP serve test", pass: false, msg: "curl failed: " + (e.message || "").split("\n")[0] });
    }

    // Kill the serve process
    try { process.kill(-servePid, "SIGTERM"); } catch (_) {}
    try { execSync(`kill ${servePid} 2>/dev/null; pkill -f "serve.*8099" 2>/dev/null`, { timeout: 5000, stdio: "pipe" }); } catch (_) {}
  } catch (e) {
    results.push({ check: "HTTP serve test", pass: false, msg: "Could not start server: " + (e.message || "").split("\n")[0] });
    if (servePid) {
      try { process.kill(-servePid, "SIGTERM"); } catch (_) {}
      try { execSync(`kill ${servePid} 2>/dev/null`, { timeout: 5000, stdio: "pipe" }); } catch (_) {}
    }
  }

  return results;
}

// --- Controller process ---

function buildPrompt(goal, terminalCount, model, iteration) {
  const terminalInstruction = buildTerminalInstruction(terminalCount);
  const modelInstruction = buildModelInstruction(model);

  if (iteration === 0) {
    return buildGoalPrompt(SYSTEM_PROMPT, terminalInstruction, modelInstruction, goal);
  }
  return buildIterationPrompt(SYSTEM_PROMPT, terminalInstruction, modelInstruction, goal, iteration);
}

function spawnControllerWithPrompt(prompt, model) {
  const env = Object.assign({}, process.env);
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const child = spawn("claude", [
    "--dangerously-skip-permissions",
    "-p", prompt,
    "--model", model || "sonnet",
    "--output-format", "stream-json",
    "--verbose",
  ], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  state.controllerProcess = child;

  // Track task state transitions from controller's tmux-control commands
  const trackTaskStateFromCommand = (command) => {
    if (!state.taskPlan || !command) return;

    // Detect --start <name> commands → mark task as SCHEDULED
    const startMatch = /--start\s+(\S+)/.exec(command);
    if (startMatch) {
      const name = startMatch[1];
      const ts = state.taskStatus[name];
      if (ts && (ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.SCHEDULED)) {
        ts.status = TASK_STATES.SCHEDULED;
        broadcast("taskStatus", { taskStatus: state.taskStatus });
      }
    }

    // Detect --cmd <name> "<prompt>" with content → mark task as IN_PROGRESS
    const cmdMatch = /--cmd\s+(\S+)\s+["'](.+)["']/.exec(command);
    if (cmdMatch && cmdMatch[2].trim().length > 0) {
      const name = cmdMatch[1];
      const ts = state.taskStatus[name];
      if (ts && (ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.SCHEDULED)) {
        ts.status = TASK_STATES.IN_PROGRESS;
        ts.attempts = Math.max(ts.attempts, 1);
        if (!ts.startedAt) ts.startedAt = Date.now();
        broadcast("taskStatus", { taskStatus: state.taskStatus });
      }
    }
  };

  let lineBuf = "";

  const processJsonLine = (raw) => {
    if (!raw.trim()) return;
    try {
      const msg = JSON.parse(raw);
      let line = null;

      // stream-json message types we care about:
      if (msg.type === "assistant" && msg.message) {
        // Assistant text/tool_use blocks
        const content = msg.message.content || [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            line = block.text;
          } else if (block.type === "tool_use") {
            const input = block.input || {};
            if (input.command) {
              line = "$ " + input.command;
              // Track task state transitions from tmux-control commands
              trackTaskStateFromCommand(input.command);
            } else {
              line = "[tool: " + block.name + "]";
            }
          }
          if (line) {
            // Split multi-line text into individual lines
            for (const l of line.split("\n")) {
              pushControllerLine(l);
              broadcast("controller", { line: l });
            }
            line = null;
          }
        }
      } else if (msg.type === "result" && msg.result) {
        // Final result text
        const text = typeof msg.result === "string" ? msg.result : (msg.result.text || "");
        if (text) {
          for (const l of text.split("\n")) {
            pushControllerLine(l);
            broadcast("controller", { line: l });
          }
        }
      } else if (msg.type === "content_block_delta" && msg.delta) {
        // Streaming text delta
        const text = msg.delta.text || "";
        if (text) {
          for (const l of text.split("\n")) {
            if (l) {
              pushControllerLine(l);
              broadcast("controller", { line: l });
            }
          }
        }
      }
    } catch (_) {
      // Not valid JSON, emit raw
      pushControllerLine(raw);
      broadcast("controller", { line: raw });
    }
  };

  const handleStdout = (chunk) => {
    lineBuf += chunk.toString();
    const parts = lineBuf.split("\n");
    lineBuf = parts.pop();
    for (const line of parts) {
      processJsonLine(line);
    }
  };

  const handleStderr = (chunk) => {
    const text = stripAnsi(chunk.toString());
    for (const line of text.split("\n")) {
      if (line.trim()) {
        pushControllerLine(line);
        broadcast("controller", { line });
      }
    }
  };

  child.stdout.on("data", handleStdout);
  child.stderr.on("data", handleStderr);

  return { child, flushBuffer: () => {
    if (lineBuf.length > 0) {
      processJsonLine(lineBuf);
      lineBuf = "";
    }
  }};
}

function spawnController(goal, terminalCount, model, iteration) {
  const prompt = buildPrompt(goal, terminalCount, model, iteration || 0);
  const { child, flushBuffer } = spawnControllerWithPrompt(prompt, model);

  state.running = true;
  state.goal = goal;
  state.terminalCount = terminalCount;
  state.model = model || "sonnet";
  state.controllerOutput = [];
  state.sessions = [];
  state.phase = iteration === 0 ? "build" : "iteration";

  // Create JSONL monitor
  if (!state.monitor) {
    state.monitor = new JsonlMonitor();
    state.monitor.on("sessionMapped", (tmuxName, sessionId) => {
      broadcast("sessionMapped", { name: tmuxName, sessionId });
      // Persist session state for crash recovery
      saveSessionState();
    });
    state.monitor.on("stateChange", (tmuxName, agentState, tokens) => {
      broadcast("agentState", { name: tmuxName, state: agentState, tokens });
    });
    state.monitor.on("turnComplete", (tmuxName, durationMs) => {
      broadcast("turnComplete", { name: tmuxName, durationMs });
    });
    state.monitor.on("conversation", (name, evt) => {
      broadcast("agentConversation", { agent: name, ...evt });
    });
    state.monitor.on("contextWarning", (name, data) => {
      broadcast("contextWarning", { agent: name, ...data });
    });
  }

  broadcast("status", {
    running: true,
    goal,
    terminalCount,
    phase: state.phase,
    currentIteration: state.currentIteration,
    iterations: state.iterations,
  });

  if (iteration === 0) {
    notify("Multi-Claude", "Build started");
  } else {
    notify("Multi-Claude", `Iteration ${iteration} starting`);
  }

  child.on("exit", (code) => {
    flushBuffer();
    state.controllerProcess = null;
    stopPolling();

    // Cleanup tmux sessions
    try { runTmux("--stop-all"); } catch (_) {}
    state.sessions = [];
    broadcast("terminals", { sessions: [] });

    if (state.stopped) {
      // User stopped — end immediately
      finishRun("Stopped by user");
      return;
    }

    if (code !== 0) {
      notify("Multi-Claude", `Controller crashed (exit code ${code})`);
      finishRun(`Controller exited with code ${code}`);
      return;
    }

    // --- Post-exit state machine ---

    // After initial build (iteration 0) or an iteration: do mandatory review if not done
    if (!state.reviewDone) {
      state.reviewDone = true;
      state.phase = "review";

      const reviewMsg = "\n--- Mandatory Review Round starting ---\n";
      pushControllerLine(reviewMsg);
      broadcast("controller", { line: reviewMsg });
      broadcast("status", { running: true, phase: "review" });
      notify("Multi-Claude", "Review round starting");

      setTimeout(() => {
        spawnReviewController(goal, model);
      }, 2000);
      return;
    }

    // After review: continue with user-requested improvement iterations
    if (state.currentIteration < state.iterations) {
      state.currentIteration++;
      state.phase = "iteration";

      const iterMsg = `\n--- Iteration ${state.currentIteration} of ${state.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", {
        running: true,
        phase: "iteration",
        currentIteration: state.currentIteration,
        iterations: state.iterations,
      });

      // Reset reviewDone so iteration also gets reviewed
      state.reviewDone = false;

      setTimeout(() => {
        spawnController(state.goal, state.terminalCount, state.model, state.currentIteration);
      }, 2000);
      return;
    }

    // All iterations done — run post-checks
    runPostChecksPhase();
  });

  startPolling();
}

function spawnReviewController(goal, model) {
  const terminalInstruction = buildTerminalInstruction("auto");
  const modelInstruction = buildModelInstruction(model);
  const prompt = buildReviewPrompt(SYSTEM_PROMPT, terminalInstruction, modelInstruction, goal);
  const { child, flushBuffer } = spawnControllerWithPrompt(prompt, model);

  broadcast("status", { running: true, phase: "review" });

  child.on("exit", (code) => {
    flushBuffer();
    state.controllerProcess = null;
    stopPolling();

    // Cleanup tmux sessions
    try { runTmux("--stop-all"); } catch (_) {}
    state.sessions = [];
    broadcast("terminals", { sessions: [] });

    if (state.stopped) {
      finishRun("Stopped by user");
      return;
    }

    const reviewEndMsg = `\n--- Review Round complete (exit code ${code}) ---\n`;
    pushControllerLine(reviewEndMsg);
    broadcast("controller", { line: reviewEndMsg });

    // After review: continue with improvement iterations if any remain
    if (code === 0 && state.currentIteration < state.iterations) {
      state.currentIteration++;
      state.phase = "iteration";

      const iterMsg = `\n--- Iteration ${state.currentIteration} of ${state.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", {
        running: true,
        phase: "iteration",
        currentIteration: state.currentIteration,
        iterations: state.iterations,
      });

      // Reset reviewDone so iteration also gets reviewed
      state.reviewDone = false;

      setTimeout(() => {
        spawnController(state.goal, state.terminalCount, state.model, state.currentIteration);
      }, 2000);
      return;
    }

    // All done — run post-checks
    runPostChecksPhase();
  });

  startPolling();
}

async function runPostChecksPhase() {
  state.phase = "postcheck";
  const postMsg = "\n--- Running post-build checks ---\n";
  pushControllerLine(postMsg);
  broadcast("controller", { line: postMsg });
  broadcast("status", { running: true, phase: "postcheck" });

  const projectDir = findProjectDir();
  const dirMsg = `[Post-check] Project directory: ${projectDir || "not found"}`;
  pushControllerLine(dirMsg);
  broadcast("controller", { line: dirMsg });

  const results = await runPostChecks(projectDir);
  state.postChecks = results;

  // Broadcast each result
  for (const r of results) {
    const statusStr = r.pass ? "PASS" : "FAIL";
    const line = `[Post-check] ${statusStr}: ${r.check} — ${r.msg}`;
    pushControllerLine(line);
    broadcast("controller", { line });
  }

  broadcast("postChecks", { checks: results });

  const allPass = results.every(r => r.pass);
  const summaryMsg = allPass
    ? "\n--- All post-build checks passed ---\n"
    : "\n--- Some post-build checks FAILED ---\n";
  pushControllerLine(summaryMsg);
  broadcast("controller", { line: summaryMsg });
  notify("Multi-Claude", allPass ? "All checks passed" : "Some checks FAILED");

  finishRun(null);
}

function generateWorkflowSummary() {
  const counts = { completed: 0, failed: 0, timed_out: 0, cancelled: 0, completed_with_errors: 0, retried: 0 };
  for (const [name, ts] of Object.entries(state.taskStatus)) {
    if (counts[ts.status] !== undefined) counts[ts.status]++;
    if (ts.attempts > 1) counts.retried++;
  }

  const totalTasks = Object.keys(state.taskStatus).length;
  const elapsed = state.workflowStartedAt
    ? Math.round((Date.now() - state.workflowStartedAt) / 1000)
    : 0;

  let summary = `\n=== WORKFLOW SUMMARY ===\n`;
  summary += `Tasks: ${totalTasks} total`;
  if (counts.completed > 0) summary += `, ${counts.completed} completed`;
  if (counts.completed_with_errors > 0) summary += `, ${counts.completed_with_errors} completed with errors`;
  if (counts.failed > 0) summary += `, ${counts.failed} failed`;
  if (counts.timed_out > 0) summary += `, ${counts.timed_out} timed out`;
  if (counts.cancelled > 0) summary += `, ${counts.cancelled} cancelled`;
  if (counts.retried > 0) summary += ` (${counts.retried} retried)`;
  if (elapsed > 0) summary += `\nDuration: ${elapsed}s (${Math.round(elapsed / 60)}min)`;
  summary += `\n========================\n`;

  return summary;
}

function finishRun(reason) {
  state.running = false;
  state.phase = "idle";
  stopConductorTimers();

  if (reason) {
    pushControllerLine(`\n[${reason}]`);
    broadcast("controller", { line: `\n[${reason}]` });
  }

  // Generate Conductor-style workflow summary
  if (state.taskPlan && Object.keys(state.taskStatus).length > 0) {
    const summary = generateWorkflowSummary();
    pushControllerLine(summary);
    broadcast("controller", { line: summary });
  }

  notify("Multi-Claude", reason ? `Build finished: ${reason}` : "Build complete");

  // Save project memory and clean up worktrees
  const projectDir = findProjectDir();
  if (projectDir) {
    if (state.taskPlan) {
      try {
        const mem = new ProjectMemory(projectDir);
        mem.addRun({
          goal: state.goal,
          outcome: reason ? "failure" : "success",
          architecture: state.taskPlan.architecture || "",
          fileStructure: scanFileStructure(projectDir),
          learnings: extractLearnings(state.controllerOutput),
          issues: extractIssues(state.controllerOutput, state.postChecks),
          decisions: [],
        });
      } catch (_) {}
    }
    try { runTmux(`--cleanup-worktrees "${projectDir}"`); } catch (_) {}
  }

  // Fire hooks
  if (state.hooks && state.hooks.hasHooks) {
    state.hooks.run("build.completed", {
      goal: state.goal,
      outcome: reason || "success",
      postChecks: state.postChecks,
    });
  }
  // Stop JSONL monitor
  if (state.monitor) {
    state.monitor.stop();
    state.monitor = null;
  }
  clearSessionState();

  if (state.iterations > 0 && !state.stopped) {
    pushControllerLine(`[All ${state.iterations} iteration(s) complete]`);
    broadcast("controller", { line: `[All ${state.iterations} iteration(s) complete]` });
  }

  broadcast("status", {
    running: false,
    phase: "idle",
    postChecks: state.postChecks,
  });
  state.stopped = false;
}

function stopController() {
  state.stopped = true;
  if (state.controllerProcess) {
    state.controllerProcess.kill("SIGTERM");
    // Give it a moment, then force kill
    setTimeout(() => {
      if (state.controllerProcess) {
        try { state.controllerProcess.kill("SIGKILL"); } catch (_) {}
      }
    }, 3000);
  }
  try { runTmux("--stop-all"); } catch (_) {}
  // Clean up worktrees
  const projectDir = findProjectDir();
  if (projectDir) {
    try { runTmux(`--cleanup-worktrees "${projectDir}"`); } catch (_) {}
  }
  // Stop JSONL monitor
  if (state.monitor) {
    state.monitor.stop();
    state.monitor = null;
  }
  // Stop Conductor timers
  stopConductorTimers();
  clearSessionState();
  stopPolling();
  state.running = false;
  state.phase = "idle";
  state.sessions = [];

  broadcast("status", { running: false, phase: "idle" });
  broadcast("terminals", { sessions: [] });
}

// --- Structured planning and execution (CrewAI-inspired) ---

/**
 * Run guardrails validation on task outputs.
 * Checks file existence, exports, and string patterns.
 */
function runGuardrails(projectDir, plan) {
  const results = {};
  const failedTasks = [];

  for (const task of plan.tasks) {
    const ts = state.taskStatus[task.name];

    // Skip tasks that are already terminally failed/timed out (no expected output to check)
    if (ts && (ts.status === TASK_STATES.TIMED_OUT || ts.status === TASK_STATES.CANCELLED)) {
      continue;
    }

    if (!task.expectedOutput) {
      // Mark tasks without expected output as completed (e.g. qa)
      if (!ts || ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.IN_PROGRESS) {
        if (ts) {
          ts.status = TASK_STATES.COMPLETED;
          ts.completedAt = Date.now();
        } else {
          state.taskStatus[task.name] = createTaskStatus(task);
          state.taskStatus[task.name].status = TASK_STATES.COMPLETED;
          state.taskStatus[task.name].completedAt = Date.now();
        }
      }
      continue;
    }
    const taskResult = { files: [], exports: [], patterns: [] };

    // Check file existence
    if (task.expectedOutput.files) {
      for (const file of task.expectedOutput.files) {
        const filePath = path.join(projectDir, file);
        const exists = fs.existsSync(filePath);
        const stat = exists ? fs.statSync(filePath) : null;
        taskResult.files.push({
          file,
          exists,
          size: stat ? stat.size : 0,
          pass: exists && stat.size > 0,
        });
      }
    }

    // Check exports (search for strings in output files)
    if (task.expectedOutput.exports) {
      for (const exp of task.expectedOutput.exports) {
        let found = false;
        for (const file of (task.expectedOutput.files || [])) {
          try {
            const content = fs.readFileSync(path.join(projectDir, file), "utf-8");
            if (content.includes(exp)) { found = true; break; }
          } catch (_) {}
        }
        taskResult.exports.push({ export: exp, found });
      }
    }

    // Check patterns (simple string search)
    if (task.expectedOutput.patterns) {
      for (const pat of task.expectedOutput.patterns) {
        let matched = false;
        for (const file of (task.expectedOutput.files || [])) {
          try {
            const content = fs.readFileSync(path.join(projectDir, file), "utf-8");
            if (content.includes(pat)) { matched = true; break; }
          } catch (_) {}
        }
        taskResult.patterns.push({ pattern: pat, matched });
      }
    }

    results[task.name] = taskResult;
    const allPass = [
      ...taskResult.files.map(f => f.pass),
      ...taskResult.exports.map(e => e.found),
      ...taskResult.patterns.map(p => p.matched),
    ].every(Boolean);

    if (ts) {
      ts.validation = taskResult;
      if (allPass) {
        ts.status = TASK_STATES.COMPLETED;
        ts.completedAt = Date.now();
      } else if (canRetryTask(ts)) {
        // Schedule retry
        ts.status = TASK_STATES.RETRYING;
        ts.error = "Guardrail validation failed";
        const delay = calculateRetryDelay(ts.retryLogic, ts.retryDelaySeconds, ts.attempts);
        const retryMsg = `[RETRY] Guardrails failed for "${task.name}" — scheduling retry (attempt ${ts.attempts + 1}/${ts.maxAttempts}) in ${Math.round(delay / 1000)}s`;
        pushControllerLine(retryMsg);
        broadcast("controller", { line: retryMsg });
        state.retryQueue.push({ taskName: task.name, retryAt: Date.now() + delay });
      } else if (ts.optional) {
        ts.status = TASK_STATES.COMPLETED_WITH_ERRORS;
        ts.completedAt = Date.now();
        ts.error = "Guardrail validation failed (optional task)";
      } else {
        ts.status = TASK_STATES.FAILED;
        ts.completedAt = Date.now();
        ts.error = "Guardrail validation failed";
        failedTasks.push(task.name);
      }
    }
  }

  broadcast("guardrails", { results });
  broadcast("taskStatus", { taskStatus: state.taskStatus });

  // Log results
  for (const [name, result] of Object.entries(results)) {
    const failures = [
      ...result.files.filter(f => !f.pass).map(f => `missing: ${f.file}`),
      ...result.exports.filter(e => !e.found).map(e => `export not found: ${e.export}`),
      ...result.patterns.filter(p => !p.matched).map(p => `pattern not matched: ${p.pattern}`),
    ];
    const line = failures.length === 0
      ? `[Guardrail] ${name}: ALL PASS`
      : `[Guardrail] ${name}: FAILURES - ${failures.join(", ")}`;
    pushControllerLine(line);
    broadcast("controller", { line });
  }

  // Run failure workflow if there are non-retryable failures
  if (failedTasks.length > 0) {
    runFailureWorkflow(failedTasks);
  }
}

/**
 * Two-phase flow: Phase 1 — Planning.
 * Spawns a lightweight Claude invocation that outputs a JSON plan.
 */
function spawnPlanningPhase(goal, terminalCount, model) {
  state.phase = "planning";
  state.running = true;
  state.goal = goal;
  state.terminalCount = terminalCount;
  state.model = model || "sonnet";
  state.controllerOutput = [];
  state.sessions = [];
  state.taskPlan = null;
  state.taskStatus = {};

  broadcast("status", { running: true, phase: "planning", goal, terminalCount });

  const planMsg = "\n--- Planning phase starting ---\n";
  pushControllerLine(planMsg);
  broadcast("controller", { line: planMsg });
  notify("Multi-Claude", "Planning phase started");

  // Initialize hooks
  state.hooks = new HookRunner([__dirname]);
  if (state.hooks.hasHooks) {
    state.hooks.run("plan.started", { goal });
  }

  // Build planning prompt
  const memoryContext = state.memory ? state.memory.buildContext() : "";
  const terminalInstruction = buildTerminalInstruction(terminalCount);
  const modelInstruction = buildModelInstruction(model);
  const planningPrompt = buildPlanningPrompt(
    TMUX_CONTROL, goal, memoryContext, terminalInstruction, modelInstruction
  );

  // Capture raw output for JSON extraction
  let rawOutput = "";
  const { child, flushBuffer } = spawnControllerWithPrompt(planningPrompt, model);

  // Intercept stdout to capture raw output
  const origListeners = child.stdout.listeners("data").slice();
  child.stdout.removeAllListeners("data");
  child.stdout.on("data", (chunk) => {
    rawOutput += chunk.toString();
    // Forward to original handlers for dashboard streaming
    for (const fn of origListeners) fn(chunk);
  });

  child.on("exit", (code) => {
    flushBuffer();
    state.controllerProcess = null;

    if (state.stopped) {
      finishRun("Stopped by user");
      return;
    }

    if (code !== 0) {
      pushControllerLine("[Planning failed — falling back to legacy mode]");
      broadcast("controller", { line: "[Planning failed — falling back to legacy mode]" });
      spawnController(goal, terminalCount, model, 0);
      return;
    }

    // Extract plan from output
    const plan = extractPlanFromOutput(rawOutput);
    if (!plan) {
      pushControllerLine("[No structured plan found — falling back to legacy mode]");
      broadcast("controller", { line: "[No structured plan found — falling back to legacy mode]" });
      spawnController(goal, terminalCount, model, 0);
      return;
    }

    const validation = validatePlan(plan);
    if (!validation.valid) {
      const errMsg = `[Plan validation errors: ${validation.errors.join("; ")}]`;
      pushControllerLine(errMsg);
      broadcast("controller", { line: errMsg });
      pushControllerLine("[Falling back to legacy mode]");
      broadcast("controller", { line: "[Falling back to legacy mode]" });
      spawnController(goal, terminalCount, model, 0);
      return;
    }

    // Plan is valid — store and broadcast with enhanced status tracking
    state.taskPlan = plan;
    state.taskStatus = {};
    for (const task of plan.tasks) {
      state.taskStatus[task.name] = createTaskStatus(task);
    }

    const planOkMsg = `\n--- Plan created: ${plan.tasks.length} tasks ---\n`;
    pushControllerLine(planOkMsg);
    broadcast("controller", { line: planOkMsg });
    broadcast("plan", { plan });
    broadcast("taskStatus", { taskStatus: state.taskStatus });

    if (state.hooks && state.hooks.hasHooks) {
      state.hooks.run("plan.created", { plan });
    }

    // Proceed to execution
    setTimeout(() => {
      spawnExecutionPhase(plan, model);
    }, 1000);
  });
}

/**
 * Two-phase flow: Phase 2 — Execution.
 * Spawns the controller with the structured plan as context.
 */
function spawnExecutionPhase(plan, model) {
  state.phase = "build";
  state.workflowStartedAt = Date.now();
  const memoryContext = state.memory ? state.memory.buildContext() : "";
  const modelInstruction = buildModelInstruction(model);
  const executionPrompt = buildExecutionPrompt(TMUX_CONTROL, plan, memoryContext, modelInstruction);

  const { child, flushBuffer } = spawnControllerWithPrompt(executionPrompt, model);

  broadcast("status", { running: true, phase: "build", goal: state.goal });
  notify("Multi-Claude", "Build started (structured mode)");

  // Start Conductor-inspired monitoring
  if (plan.timeoutSeconds) {
    startWorkflowTimeout(plan.timeoutSeconds);
  }
  startTaskTimeoutMonitoring();
  startRetryQueueProcessing();
  startWaitConditionPolling();

  // Initialize WAIT task states
  for (const task of plan.tasks) {
    const ts = state.taskStatus[task.name];
    if (ts && task.taskType === TASK_TYPES.WAIT && task.waitCondition) {
      ts.status = TASK_STATES.WAITING;
      ts.startedAt = Date.now();
      broadcast("taskStatus", { taskStatus: state.taskStatus });
    }
  }

  if (state.hooks && state.hooks.hasHooks) {
    state.hooks.run("build.started", { goal: state.goal, plan });
  }

  // Create JSONL monitor
  if (!state.monitor) {
    state.monitor = new JsonlMonitor();
    state.monitor.on("sessionMapped", (tmuxName, sessionId) => {
      broadcast("sessionMapped", { name: tmuxName, sessionId });
      saveSessionState();
    });
    state.monitor.on("stateChange", (tmuxName, agentState, tokens) => {
      broadcast("agentState", { name: tmuxName, state: agentState, tokens });
    });
    state.monitor.on("turnComplete", (tmuxName, durationMs) => {
      broadcast("turnComplete", { name: tmuxName, durationMs });
    });
    state.monitor.on("conversation", (name, evt) => {
      broadcast("agentConversation", { agent: name, ...evt });
    });
    state.monitor.on("contextWarning", (name, data) => {
      broadcast("contextWarning", { agent: name, ...data });
    });
  }

  child.on("exit", (code) => {
    flushBuffer();
    state.controllerProcess = null;
    stopPolling();
    stopConductorTimers();

    try { runTmux("--stop-all"); } catch (_) {}
    state.sessions = [];
    broadcast("terminals", { sessions: [] });

    if (state.stopped) {
      finishRun("Stopped by user");
      return;
    }

    if (code !== 0) {
      notify("Multi-Claude", `Controller crashed (exit code ${code})`);
      finishRun(`Controller exited with code ${code}`);
      return;
    }

    // Run guardrails if we have a plan
    const projectDir = findProjectDir();
    if (state.taskPlan && projectDir) {
      runGuardrails(projectDir, state.taskPlan);
    }

    // Check for non-optional failed tasks — if any exist, still continue to review
    // (review phase may fix them)
    const criticalFailures = Object.entries(state.taskStatus)
      .filter(([_, ts]) => ts.status === TASK_STATES.FAILED || ts.status === TASK_STATES.TIMED_OUT)
      .filter(([_, ts]) => !ts.optional);
    if (criticalFailures.length > 0) {
      const failMsg = `[WARNING] ${criticalFailures.length} critical task(s) failed — proceeding to review for potential fixes`;
      pushControllerLine(failMsg);
      broadcast("controller", { line: failMsg });
    }

    // Continue to review phase (same state machine as legacy)
    if (!state.reviewDone) {
      state.reviewDone = true;
      state.phase = "review";

      const reviewMsg = "\n--- Mandatory Review Round starting ---\n";
      pushControllerLine(reviewMsg);
      broadcast("controller", { line: reviewMsg });
      broadcast("status", { running: true, phase: "review" });
      notify("Multi-Claude", "Review round starting");

      setTimeout(() => {
        spawnReviewController(state.goal, model);
      }, 2000);
      return;
    }

    if (state.currentIteration < state.iterations) {
      state.currentIteration++;
      state.phase = "iteration";
      state.reviewDone = false;

      const iterMsg = `\n--- Iteration ${state.currentIteration} of ${state.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", { running: true, phase: "iteration", currentIteration: state.currentIteration, iterations: state.iterations });

      setTimeout(() => {
        spawnController(state.goal, state.terminalCount, state.model, state.currentIteration);
      }, 2000);
      return;
    }

    runPostChecksPhase();
  });

  startPolling();
}

// --- HTTP Server ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (_) { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // --- API Routes ---

  if (pathname === "/api/start" && req.method === "POST") {
    if (state.running) {
      return sendJson(res, 400, { error: "Already running" });
    }
    const body = await parseBody(req);
    const goal = (body.goal || "").trim();
    if (!goal) {
      return sendJson(res, 400, { error: "Goal is required" });
    }
    const terminalCount = body.terminalCount === "auto" || !body.terminalCount
      ? "auto"
      : parseInt(body.terminalCount, 10);
    const model = body.model || "sonnet";
    const iterations = Math.min(Math.max(parseInt(body.iterations) || 0, 0), 5);

    const structured = body.structured !== false; // default true

    state.iterations = iterations;
    state.currentIteration = 0;
    state.stopped = false;
    state.reviewDone = false;
    state.postChecks = null;
    state.restoreAttempts = {};
    state.taskPlan = null;
    state.taskStatus = {};
    state.hooks = null;
    // Reset Conductor state
    stopConductorTimers();
    state.workflowStartedAt = null;
    state.retryQueue = [];

    // Load project memory before planning so prior learnings are available
    state.memory = null;
    const projectDir = findProjectDir();
    if (projectDir) {
      try { state.memory = new ProjectMemory(projectDir); } catch (_) {}
    }

    if (structured) {
      spawnPlanningPhase(goal, terminalCount, model);
    } else {
      spawnController(goal, terminalCount, model, 0);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/stop" && req.method === "POST") {
    stopController();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/status" && req.method === "GET") {
    return sendJson(res, 200, {
      running: state.running,
      goal: state.goal,
      terminalCount: state.terminalCount,
      model: state.model,
      iterations: state.iterations,
      currentIteration: state.currentIteration,
      phase: state.phase,
      reviewDone: state.reviewDone,
      postChecks: state.postChecks,
      sessions: state.sessions,
      taskPlan: state.taskPlan,
      taskStatus: state.taskStatus,
      workflowStartedAt: state.workflowStartedAt,
      retryQueue: state.retryQueue.length,
    });
  }

  if (pathname === "/api/restore" && req.method === "POST") {
    const body = await parseBody(req);
    const name = body.name;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return sendJson(res, 400, { error: "Invalid or missing name" });
    }
    const saved = loadSessionState();
    const info = saved[name];
    if (!info || !info.sessionId || !info.workDir) {
      return sendJson(res, 404, { error: "No saved session state for " + name });
    }
    // Validate saved values before passing to shell
    if (!/^[0-9a-f-]{36}$/.test(info.sessionId)) {
      return sendJson(res, 400, { error: "Invalid session ID in saved state" });
    }
    try {
      runTmux(`--restore ${name} ${info.sessionId} "${info.workDir}"`);
      notify("Multi-Claude", `Restored agent: ${name}`);
      return sendJson(res, 200, { ok: true, sessionId: info.sessionId });
    } catch (e) {
      return sendJson(res, 500, { error: "Restore failed: " + (e.message || "") });
    }
  }

  if (pathname === "/api/agents" && req.method === "GET") {
    const agents = state.monitor ? state.monitor.getAll() : {};
    return sendJson(res, 200, agents);
  }

  if (pathname === "/api/plan" && req.method === "GET") {
    return sendJson(res, 200, { plan: state.taskPlan, taskStatus: state.taskStatus });
  }

  if (pathname === "/api/memory" && req.method === "GET") {
    const memData = state.memory ? state.memory.getData() : null;
    return sendJson(res, 200, { memory: memData });
  }

  if (pathname === "/api/messages" && req.method === "GET") {
    // Read messages from the shared message file
    const msgFile = path.join(require("os").tmpdir(), "multi-claude-messages", "messages.jsonl");
    let messages = [];
    try {
      if (fs.existsSync(msgFile)) {
        messages = fs.readFileSync(msgFile, "utf-8").split("\n")
          .filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
          .filter(Boolean);
      }
    } catch (_) {}
    return sendJson(res, 200, { messages });
  }

  // --- Intervention endpoints ---

  const agentMatch = pathname.match(/^\/api\/agent\/([a-zA-Z0-9_-]+)\/(pause|resume|inject|kill|approve|tail)$/);
  if (agentMatch) {
    const [, agentName, action] = agentMatch;

    if (action === 'pause' && req.method === 'POST') {
      try {
        runTmux(`--signal ${agentName} SIGSTOP`);
        broadcast('intervention', { agent: agentName, action: 'pause', timestamp: Date.now(), detail: 'Agent paused' });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: 'Failed to pause: ' + (e.message || '') });
      }
    }

    if (action === 'resume' && req.method === 'POST') {
      try {
        runTmux(`--signal ${agentName} SIGCONT`);
        broadcast('intervention', { agent: agentName, action: 'resume', timestamp: Date.now(), detail: 'Agent resumed' });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: 'Failed to resume: ' + (e.message || '') });
      }
    }

    if (action === 'inject' && req.method === 'POST') {
      const body = await parseBody(req);
      const prompt = (body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'Prompt is required' });
      try {
        runTmuxSafe('--cmd', agentName, prompt);
        setTimeout(() => { try { runTmuxSafe('--cmd', agentName, ''); } catch (_) {} }, 1000);
        broadcast('intervention', { agent: agentName, action: 'inject', timestamp: Date.now(), detail: prompt.substring(0, 100) });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: 'Failed to inject: ' + (e.message || '') });
      }
    }

    if (action === 'kill' && req.method === 'POST') {
      const body = await parseBody(req);
      try {
        runTmux(`--stop ${agentName}`);
        broadcast('intervention', { agent: agentName, action: 'kill', timestamp: Date.now(), detail: body.restart ? 'Killed + restarting' : 'Killed' });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: 'Failed to kill: ' + (e.message || '') });
      }
    }

    if (action === 'approve' && req.method === 'POST') {
      const body = await parseBody(req);
      broadcast('intervention', { agent: agentName, action: 'approve', timestamp: Date.now(), detail: body.response || 'Approved' });
      if (body.response) {
        try {
          runTmuxSafe('--cmd', agentName, body.response);
          setTimeout(() => { try { runTmuxSafe('--cmd', agentName, ''); } catch (_) {} }, 1000);
        } catch (_) {}
      }
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'tail' && req.method === 'GET') {
      const lines = parseInt(url.searchParams.get('lines') || '50');
      try {
        const output = runTmux(`--read ${agentName} ${Math.min(lines, 200)}`);
        return sendJson(res, 200, { lines: output.split('\n') });
      } catch (e) {
        return sendJson(res, 200, { lines: [] });
      }
    }
  }

  // Emergency stop
  if (pathname === '/api/estop' && req.method === 'POST') {
    if (state.controllerProcess) {
      try { state.controllerProcess.kill('SIGKILL'); } catch (_) {}
      state.controllerProcess = null;
    }
    try { runTmux('--stop-all'); } catch (_) {}
    if (state.monitor) { state.monitor.stop(); state.monitor = null; }
    stopConductorTimers();
    clearSessionState();
    stopPolling();
    state.running = false;
    state.phase = 'idle';
    state.sessions = [];
    broadcast('status', { running: false, phase: 'idle' });
    broadcast('terminals', { sessions: [] });
    broadcast('intervention', { agent: '*', action: 'estop', timestamp: Date.now(), detail: 'Emergency stop — all agents killed' });
    notify('HiveMind', 'EMERGENCY STOP — all agents killed');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    state.sseClients.push(res);

    // Send init event with current state
    const initData = {
      running: state.running,
      goal: state.goal,
      terminalCount: state.terminalCount,
      model: state.model,
      iterations: state.iterations,
      currentIteration: state.currentIteration,
      phase: state.phase,
      reviewDone: state.reviewDone,
      postChecks: state.postChecks,
      controllerOutput: state.controllerOutput,
      sessions: state.sessions,
      taskPlan: state.taskPlan,
      taskStatus: state.taskStatus,
      workflowStartedAt: state.workflowStartedAt,
    };
    // Add conversation buffers for late-joining clients
    if (state.monitor) {
      const convos = {};
      for (const name of state.sessions) {
        const buf = state.monitor.getConversation(name);
        if (buf.length > 0) convos[name] = buf;
      }
      if (Object.keys(convos).length > 0) initData.agentConversations = convos;
    }
    res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);

    req.on("close", () => {
      const idx = state.sseClients.indexOf(res);
      if (idx !== -1) state.sseClients.splice(idx, 1);
    });
    return;
  }

  // --- Static Files ---

  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (_) {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
});
