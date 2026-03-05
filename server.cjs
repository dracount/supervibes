#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
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
  validatePlan, extractPlanFromOutput, TASK_STATES,
} = require("./task-schema.cjs");
const { ProjectMemory, extractLearnings, extractIssues, scanFileStructure } = require("./memory.cjs");
const { HookRunner } = require("./hooks.cjs");
const { StateManager } = require("./state-manager.cjs");
const { ConductorExecutor } = require("./conductor.cjs");
const { WsServer } = require("./ws-server.cjs");
const { HistoryDB } = require("./database.cjs");

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

// --- Terminal backend: node-pty (default) or tmux (fallback) ---
const useTmuxFallback = !!process.env.TMUX_FALLBACK;
const tm = useTmuxFallback
  ? null
  : new (require("./terminal-manager.cjs").TerminalManager)({ maxBufferLines: MAX_BUFFER_LINES });
const SESSION_STATE_FILE = path.join(__dirname, ".session-state.json");
const HISTORY_DIR = path.join(os.homedir(), ".multi-claude", "history");

const SYSTEM_PROMPT = buildSystemPrompt(TMUX_CONTROL);

// --- State ---

const sm = new StateManager();
let wsServer = null; // Initialized after HTTP server starts

// --- SQLite History Database ---
const historyDb = new HistoryDB();
// Migrate existing JSON history files on first startup
try {
  const imported = historyDb.migrateFromJson(HISTORY_DIR);
  if (imported > 0) console.log(`[DB] Migrated ${imported} history files from JSON to SQLite`);
} catch (e) {
  console.error("[DB] JSON migration error:", e.message);
}

const state = {
  controllerProcess: null,
  controllerOutput: [],   // ring buffer, max MAX_BUFFER_LINES
  pollInterval: null,
  monitor: null,
  restoreAttempts: {},  // name → count, prevents infinite restore loops
  // --- CrewAI-inspired features ---
  taskPlan: null,          // structured TaskPlan from planning phase
  memory: null,            // ProjectMemory instance
  hooks: null,             // HookRunner instance
  guardrailResults: null,  // last guardrail results map (for late-joining SSE clients)
  // --- Conductor-inspired features (managed by ConductorExecutor) ---
  conductor: null,         // ConductorExecutor instance — owns taskStatus, retryQueue, timers
  workflowSummary: null,   // last workflow summary object (for late-joining SSE clients)
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
  sm.broadcast(event, data);
  if (wsServer) wsServer.broadcast(event, data);
}

// --- tmux CLI wrappers (used only when TMUX_FALLBACK=1) ---

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

// --- Unified terminal operations (delegates to node-pty or tmux) ---

function tmStartSession(name, workDir) {
  if (tm) {
    tm.startSession(name, workDir);
    if (state.monitor) state.monitor.registerSession(name, workDir);
  } else {
    runTmux(`--start ${name} "${workDir}"`);
  }
}

function tmStopSession(name) {
  if (tm) { tm.stopSession(name); } else { runTmux(`--stop ${name}`); }
}

function tmStopAll() {
  if (tm) { tm.stopAll(); } else { runTmux("--stop-all"); }
}

function tmSendKeys(name, text) {
  if (tm) {
    tm.sendKeys(name, text);
  } else if (text === "") {
    runTmux(`--cmd ${name} ""`);
  } else {
    runTmuxSafe("--cmd", name, text);
  }
}

function tmReadOutput(name, lines = 50) {
  if (tm) { return tm.readOutput(name, lines); }
  return runTmux(`--read ${name} ${lines}`);
}

function tmListSessions() {
  if (tm) { return tm.listSessions(); }
  const listOutput = runTmux("--list");
  const sessions = [];
  if (listOutput && !listOutput.includes("No active sessions")) {
    for (const line of listOutput.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && trimmed !== "Active sessions:") sessions.push(trimmed);
    }
  }
  return sessions;
}

function tmRestoreSession(name, sessionId, workDir) {
  if (tm) {
    tm.restoreSession(name, sessionId, workDir);
    if (state.monitor) state.monitor.registerSession(name, workDir);
  } else {
    runTmux(`--restore ${name} ${sessionId} "${workDir}"`);
  }
}

function tmSignal(name, sig) {
  if (tm) { tm.signal(name, sig); } else { runTmux(`--signal ${name} ${sig}`); }
}

function tmCleanupWorktrees(baseDir) {
  if (tm) { tm.cleanupWorktrees(baseDir); } else { runTmux(`--cleanup-worktrees "${baseDir}"`); }
}

// --- Wire node-pty exit events for auto-recovery ---

if (tm) {
  tm.on("exit", (name, code) => {
    if (!sm.running || !state.monitor) return;
    const agentInfo = state.monitor.getAll();
    const info = agentInfo[name];
    if (!info || !info.sessionId || info.state === "idle") return;

    const attempts = state.restoreAttempts[name] || 0;
    if (attempts >= 2) return;
    state.restoreAttempts[name] = attempts + 1;

    const savedState = loadSessionState();
    const saved = savedState[name];
    if (saved && saved.sessionId && saved.workDir) {
      const restoreMsg = `[Auto-restoring crashed session: ${name} (attempt ${attempts + 1}/2)]`;
      pushControllerLine(restoreMsg);
      broadcast("controller", { line: restoreMsg });
      notify("Multi-Claude", `Auto-restoring crashed agent: ${name}`);
      try { tmRestoreSession(name, saved.sessionId, saved.workDir); } catch (_) {}
    }
  });
}

function pollTerminals() {
  try {
    const sessions = tmListSessions();
    sm.sessions = sessions;

    // Register new sessions with JSONL monitor (tmux fallback only; node-pty registers in tmStartSession)
    if (state.monitor && useTmuxFallback) {
      for (const name of sessions) {
        const workDir = getWorkDirForSession(name);
        if (workDir) state.monitor.registerSession(name, workDir);
      }
    }

    // Auto-recovery for tmux fallback (node-pty uses exit event above)
    if (useTmuxFallback && state.monitor && sm.running) {
      const savedState = loadSessionState();
      const agentInfo = state.monitor.getAll();
      for (const [name, info] of Object.entries(agentInfo)) {
        if (info.sessionId && info.state !== "idle" && !sessions.includes(name)) {
          const attempts = state.restoreAttempts[name] || 0;
          if (attempts >= 2) continue;
          state.restoreAttempts[name] = attempts + 1;

          const saved = savedState[name];
          if (saved && saved.sessionId && saved.workDir) {
            const restoreMsg = `[Auto-restoring crashed session: ${name} (attempt ${attempts + 1}/2)]`;
            pushControllerLine(restoreMsg);
            broadcast("controller", { line: restoreMsg });
            notify("Multi-Claude", `Auto-restoring crashed agent: ${name}`);
            try { tmRestoreSession(name, saved.sessionId, saved.workDir); } catch (_) {}
          }
        }
      }
    }

    broadcast("terminals", { sessions });
  } catch (_) {}
}

// --- Conductor: Helper to get task status from conductor (or empty object) ---

function getTaskStatus() {
  return state.conductor ? state.conductor.getTaskStatus() : {};
}

function buildInitData() {
  const initData = Object.assign(sm.toInitData(), {
    controllerOutput: state.controllerOutput,
    taskPlan: state.taskPlan,
    taskStatus: getTaskStatus(),
  });
  if (state.monitor) {
    initData.agentStates = state.monitor.getAll();
    const convos = {};
    for (const name of sm.sessions) {
      const buf = state.monitor.getConversation(name);
      if (buf.length > 0) convos[name] = buf;
    }
    if (Object.keys(convos).length > 0) initData.agentConversations = convos;
    const warnings = {};
    for (const [name, info] of state.monitor._sessions) {
      if (info.contextWarned) {
        const totalContext = info.tokens.input + info.tokens.cacheRead;
        warnings[name] = { agent: name, totalContext, limit: 200000 };
      }
    }
    if (Object.keys(warnings).length > 0) initData.contextWarnings = warnings;
  }
  if (state.guardrailResults) {
    initData.guardrailResults = state.guardrailResults;
  }
  if (state.conductor) {
    const fileChanges = state.conductor.getFileChanges();
    if (fileChanges.length > 0) initData.fileChanges = fileChanges;
    // Concurrency info
    const maxC = state.conductor.getMaxConcurrent();
    initData.maxConcurrentAgents = maxC === Infinity ? null : maxC;
    initData.activeAgentCount = state.conductor.getActiveCount();
    initData.queuedTasks = state.conductor.getQueuedTasks();
  }
  if (state.workflowSummary) {
    initData.workflowSummary = state.workflowSummary;
  }
  return initData;
}

// --- Conductor: Failure workflow ---

function runFailureWorkflow(failedTasks) {
  if (!state.taskPlan || !state.conductor) return;

  const failureDescription = state.taskPlan.failureWorkflow;
  if (!failureDescription && failedTasks.length === 0) return;

  const failureMsg = `\n--- Failure Workflow: Diagnosing ${failedTasks.length} failed task(s) ---\n`;
  pushControllerLine(failureMsg);
  broadcast("controller", { line: failureMsg });

  const diagMsg = `Failed tasks:\n${state.conductor.getFailureSummary(failedTasks)}`;
  pushControllerLine(diagMsg);
  broadcast("controller", { line: diagMsg });
  notify("Multi-Claude", `${failedTasks.length} task(s) failed — check dashboard`);

  // Fire hook if available
  if (state.hooks && state.hooks.hasHooks) {
    const taskStatus = getTaskStatus();
    state.hooks.run("tasks.failed", {
      failedTasks: failedTasks.map(name => ({
        name,
        ...taskStatus[name],
      })),
    });
  }
}

// --- Conductor: Stop conductor if active ---

function stopConductorTimers() {
  if (state.conductor) {
    state.conductor.stop();
  }
}

/**
 * Retry a single worker task by restarting its terminal session.
 * The controller is still running — we restart just this worker.
 */
function retryWorkerTask(task) {
  if (!state.conductor) return;
  const ts = state.conductor.getTask(task.name);
  if (!ts) return;

  try {
    // Stop old session if it exists
    try { tmStopSession(task.name); } catch (_) {}

    // Get the working directory from controller output
    const workDir = getWorkDirForSession(task.name) || __dirname;

    // Start new session
    tmStartSession(task.name, workDir);

    // Mark as in_progress via conductor
    state.conductor.markRetryInProgress(task.name);

    // Launch Claude Code in the new session
    const model = sm.model || "sonnet";
    setTimeout(() => {
      tmSendKeys(task.name, `claude --dangerously-skip-permissions --model ${model}`);
      setTimeout(() => {
        tmSendKeys(task.name, "");
        setTimeout(() => {
          // Send the worker prompt
          const { buildWorkerPrompt } = require("./task-schema.cjs");
          const memoryContext = state.memory ? state.memory.buildContext() : "";
          const prompt = buildWorkerPrompt(task, state.taskPlan.sharedContext || "", memoryContext);
          tmSendKeys(task.name, prompt);
          setTimeout(() => {
            tmSendKeys(task.name, "");
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
    state.conductor.markRetryFailed(task.name, `Retry restart failed: ${e.message}`);
  }
}

/**
 * Create a ConductorExecutor for a plan and wire up its events.
 */
function createConductor(plan) {
  const conductor = new ConductorExecutor(plan, {
    findProjectDir,
    maxConcurrentAgents: sm.maxConcurrentAgents,
  });

  // Wire conductor events to SSE broadcasting
  conductor.on("statusChanged", (taskStatus) => {
    const maxC = conductor.getMaxConcurrent();
    broadcast("taskStatus", {
      taskStatus,
      maxConcurrentAgents: maxC === Infinity ? null : maxC,
      activeAgentCount: conductor.getActiveCount(),
      queuedTasks: conductor.getQueuedTasks(),
    });
  });

  conductor.on("log", (msg) => {
    pushControllerLine(msg);
    broadcast("controller", { line: msg });
  });

  conductor.on("taskTimedOut", (taskName) => {
    notify("Multi-Claude", `Task timed out: ${taskName}`);
    // Kill the worker's tmux session
    try { tmStopSession(taskName); } catch (_) {}
  });

  conductor.on("workflowTimeout", () => {
    notify("Multi-Claude", "Workflow timed out!");
    stopController();
  });

  // Backpressure: when a task completes, check if queued tasks can now start
  conductor.on("taskCompleted", (taskName) => {
    const ready = conductor.getReadyTasks();
    if (ready.length > 0) {
      const msg = `[CONCURRENCY] Slot freed by "${taskName}" — ${ready.length} task(s) eligible: ${ready.join(", ")}`;
      pushControllerLine(msg);
      broadcast("controller", { line: msg });
    }
  });

  conductor.on("retryReady", (taskName, task) => {
    retryWorkerTask(task);
  });

  conductor.on("fileChange", (change) => {
    broadcast("fileChange", change);
  });

  return conductor;
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
    if (!state.taskPlan || !state.conductor || !command) return;

    // Detect --start <name> commands → mark task as SCHEDULED
    const startMatch = /--start\s+(\S+)/.exec(command);
    if (startMatch) {
      state.conductor.scheduleTask(startMatch[1]);
    }

    // Detect --cmd <name> "<prompt>" with content → mark task as IN_PROGRESS
    const cmdMatch = /--cmd\s+(\S+)\s+["'](.+)["']/.exec(command);
    if (cmdMatch && cmdMatch[2].trim().length > 0) {
      state.conductor.startTask(cmdMatch[1]);
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

function ensureMonitor() {
  if (state.monitor) return;
  state.monitor = new JsonlMonitor();
  state.monitor.on("sessionMapped", (tmuxName, sessionId) => {
    broadcast("sessionMapped", { name: tmuxName, sessionId });
    saveSessionState();
  });
  state.monitor.on("stateChange", (tmuxName, agentState, tokens) => {
    broadcast("agentState", { name: tmuxName, state: agentState, tokens });
  });
  state.monitor.on("conversation", (name, evt) => {
    broadcast("agentConversation", { agent: name, ...evt });
  });
  state.monitor.on("contextWarning", (name, data) => {
    broadcast("contextWarning", { agent: name, ...data });
  });
}

function spawnController(goal, terminalCount, model, iteration) {
  const prompt = buildPrompt(goal, terminalCount, model, iteration || 0);
  const { child, flushBuffer } = spawnControllerWithPrompt(prompt, model);

  sm.running = true;
  sm.goal = goal;
  sm.terminalCount = terminalCount;
  sm.model = model || "sonnet";
  state.controllerOutput = [];
  sm.sessions = [];
  sm.phase = iteration === 0 ? "build" : "iteration";
  state.workflowSummary = null;

  // Create JSONL monitor
  ensureMonitor();

  broadcast("status", {
    running: true,
    goal,
    terminalCount,
    phase: sm.phase,
    currentIteration: sm.currentIteration,
    iterations: sm.iterations,
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
    try { tmStopAll(); } catch (_) {}
    sm.sessions = [];
    broadcast("terminals", { sessions: [] });

    if (sm.stopped) {
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
    if (!sm.reviewDone) {
      sm.reviewDone = true;
      sm.phase = "review";

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
    if (sm.currentIteration < sm.iterations) {
      sm.currentIteration++;
      sm.phase = "iteration";

      const iterMsg = `\n--- Iteration ${sm.currentIteration} of ${sm.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", {
        running: true,
        phase: "iteration",
        currentIteration: sm.currentIteration,
        iterations: sm.iterations,
      });

      // Reset reviewDone so iteration also gets reviewed
      sm.reviewDone = false;

      setTimeout(() => {
        spawnController(sm.goal, sm.terminalCount, sm.model, sm.currentIteration);
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
    try { tmStopAll(); } catch (_) {}
    sm.sessions = [];
    broadcast("terminals", { sessions: [] });

    if (sm.stopped) {
      finishRun("Stopped by user");
      return;
    }

    const reviewEndMsg = `\n--- Review Round complete (exit code ${code}) ---\n`;
    pushControllerLine(reviewEndMsg);
    broadcast("controller", { line: reviewEndMsg });

    // After review: continue with improvement iterations if any remain
    if (code === 0 && sm.currentIteration < sm.iterations) {
      sm.currentIteration++;
      sm.phase = "iteration";

      const iterMsg = `\n--- Iteration ${sm.currentIteration} of ${sm.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", {
        running: true,
        phase: "iteration",
        currentIteration: sm.currentIteration,
        iterations: sm.iterations,
      });

      // Reset reviewDone so iteration also gets reviewed
      sm.reviewDone = false;

      setTimeout(() => {
        spawnController(sm.goal, sm.terminalCount, sm.model, sm.currentIteration);
      }, 2000);
      return;
    }

    // All done — run post-checks
    runPostChecksPhase();
  });

  startPolling();
}

async function runPostChecksPhase() {
  sm.phase = "postcheck";
  const postMsg = "\n--- Running post-build checks ---\n";
  pushControllerLine(postMsg);
  broadcast("controller", { line: postMsg });
  broadcast("status", { running: true, phase: "postcheck" });

  const projectDir = findProjectDir();
  const dirMsg = `[Post-check] Project directory: ${projectDir || "not found"}`;
  pushControllerLine(dirMsg);
  broadcast("controller", { line: dirMsg });

  const results = await runPostChecks(projectDir);
  sm.postChecks = results;

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
  if (!state.conductor) return "";
  return state.conductor.getSummary(sm.workflowStartedAt).summaryText;
}

// --- Run history persistence ---

function computeTotalTokens() {
  if (!state.monitor) return { input: 0, output: 0 };
  const all = state.monitor.getAll();
  let input = 0, output = 0;
  for (const info of Object.values(all)) {
    input += info.tokens.input || 0;
    output += info.tokens.output || 0;
  }
  return { input, output };
}

function saveRunHistory(outcome) {
  try {
    const now = Date.now();
    const isoTimestamp = new Date(now).toISOString();
    const goalSlug = (sm.goal || "unknown")
      .substring(0, 50)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const record = {
      id: `${isoTimestamp}-${goalSlug}`,
      goal: sm.goal,
      model: sm.model,
      terminalCount: sm.terminalCount,
      outcome: outcome,
      startedAt: sm.workflowStartedAt,
      endedAt: now,
      duration: sm.workflowStartedAt ? now - sm.workflowStartedAt : null,
      tasks: Object.entries(getTaskStatus()).map(([name, s]) => ({
        name,
        status: s.status,
        duration: s.completedAt && s.startedAt ? s.completedAt - s.startedAt : null,
        attempts: s.attempts || 1,
        error: s.error ? String(s.error).substring(0, 500) : null,
      })),
      totalTokens: computeTotalTokens(),
      estimatedCost: null,
      summary: state.conductor ? state.conductor.getSummary(sm.workflowStartedAt) : null,
    };

    historyDb.saveRun(record);
  } catch (_) {
    // History saving should never crash the server
  }
}

function finishRun(reason) {
  sm.running = false;
  sm.phase = "idle";
  stopConductorTimers();

  if (reason) {
    pushControllerLine(`\n[${reason}]`);
    broadcast("controller", { line: `\n[${reason}]` });
  }

  // Generate Conductor-style workflow summary
  if (state.taskPlan && state.conductor && Object.keys(getTaskStatus()).length > 0) {
    const summary = generateWorkflowSummary();
    pushControllerLine(summary);
    broadcast("controller", { line: summary });

    // Broadcast structured summary for WorkflowSummary modal
    const structuredSummary = state.conductor.getSummary(sm.workflowStartedAt);
    if (structuredSummary) {
      // Enrich with per-task details for the modal
      structuredSummary.outcome = !reason ? "completed"
        : (reason.toLowerCase().includes("stopped") ? "stopped" : "failed");
      structuredSummary.taskDetails = Object.entries(state.conductor.getTaskStatus()).map(([name, ts]) => ({
        name,
        status: ts.status,
        attempts: ts.attempts,
        maxAttempts: ts.maxAttempts,
        error: ts.error,
        duration: ts.startedAt && ts.completedAt ? ts.completedAt - ts.startedAt : null,
      }));
      state.workflowSummary = structuredSummary;
      broadcast("workflowSummary", structuredSummary);
    }
  }

  notify("Multi-Claude", reason ? `Build finished: ${reason}` : "Build complete");

  // Save project memory and clean up worktrees
  const projectDir = findProjectDir();
  if (projectDir) {
    if (state.taskPlan) {
      try {
        const mem = new ProjectMemory(projectDir);
        mem.addRun({
          goal: sm.goal,
          outcome: reason ? "failure" : "success",
          architecture: state.taskPlan.architecture || "",
          fileStructure: scanFileStructure(projectDir),
          learnings: extractLearnings(state.controllerOutput),
          issues: extractIssues(state.controllerOutput, sm.postChecks),
          decisions: [],
        });
      } catch (_) {}
    }
    try { tmCleanupWorktrees(projectDir); } catch (_) {}
  }

  // Fire hooks
  if (state.hooks && state.hooks.hasHooks) {
    state.hooks.run("build.completed", {
      goal: sm.goal,
      outcome: reason || "success",
      postChecks: sm.postChecks,
    });
  }
  // Persist run history (before monitor is stopped so token data is available)
  saveRunHistory(reason || "completed");

  // Stop JSONL monitor
  if (state.monitor) {
    state.monitor.stop();
    state.monitor = null;
  }
  clearSessionState();

  if (sm.iterations > 0 && !sm.stopped) {
    pushControllerLine(`[All ${sm.iterations} iteration(s) complete]`);
    broadcast("controller", { line: `[All ${sm.iterations} iteration(s) complete]` });
  }

  broadcast("status", {
    running: false,
    phase: "idle",
    postChecks: sm.postChecks,
  });
  sm.stopped = false;
}

function stopController() {
  sm.stopped = true;
  if (state.controllerProcess) {
    state.controllerProcess.kill("SIGTERM");
    // Give it a moment, then force kill
    setTimeout(() => {
      if (state.controllerProcess) {
        try { state.controllerProcess.kill("SIGKILL"); } catch (_) {}
      }
    }, 3000);
  }
  try { tmStopAll(); } catch (_) {}
  // Clean up worktrees
  const projectDir = findProjectDir();
  if (projectDir) {
    try { tmCleanupWorktrees(projectDir); } catch (_) {}
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
  sm.running = false;
  sm.phase = "idle";
  sm.sessions = [];

  broadcast("status", { running: false, phase: "idle" });
  broadcast("terminals", { sessions: [] });
}

// --- Structured planning and execution (CrewAI-inspired) ---

/**
 * Run guardrails validation on task outputs.
 * Checks file existence, exports, and string patterns.
 */
function runGuardrails(projectDir, plan) {
  if (!state.conductor) return;
  const conductor = state.conductor;
  const results = {};
  const failedTasks = [];

  for (const task of plan.tasks) {
    const ts = conductor.getTask(task.name);

    // Skip tasks that are already terminally failed/timed out (no expected output to check)
    if (ts && (ts.status === TASK_STATES.TIMED_OUT || ts.status === TASK_STATES.CANCELLED)) {
      continue;
    }

    if (!task.expectedOutput) {
      // Mark tasks without expected output as completed (e.g. qa)
      if (!ts || ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.IN_PROGRESS) {
        const entry = conductor.ensureTaskStatus(task.name);
        if (entry) {
          conductor.completeTask(task.name);
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
      conductor.setValidation(task.name, taskResult);
      if (allPass) {
        conductor.completeTask(task.name, taskResult);
      } else {
        const result = conductor.failTask(task.name, "Guardrail validation failed");
        if (result.retrying) {
          const retryMsg = `[RETRY] Guardrails failed for "${task.name}" — scheduling retry`;
          pushControllerLine(retryMsg);
          broadcast("controller", { line: retryMsg });
        } else if (!ts.optional && ts.status === TASK_STATES.FAILED) {
          failedTasks.push(task.name);
        }
      }
    }
  }

  state.guardrailResults = results;
  broadcast("guardrails", { results });
  broadcast("taskStatus", { taskStatus: getTaskStatus() });

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
  sm.phase = "planning";
  sm.running = true;
  sm.goal = goal;
  sm.terminalCount = terminalCount;
  sm.model = model || "sonnet";
  state.controllerOutput = [];
  sm.sessions = [];
  state.taskPlan = null;
  state.conductor = null;
  state.workflowSummary = null;
  state.guardrailResults = null;

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

    if (sm.stopped) {
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
    state.conductor = createConductor(plan);
    state.conductor.initTaskStatus();

    const planOkMsg = `\n--- Plan created: ${plan.tasks.length} tasks ---\n`;
    pushControllerLine(planOkMsg);
    broadcast("controller", { line: planOkMsg });
    broadcast("plan", { plan });
    broadcast("taskStatus", { taskStatus: getTaskStatus() });

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
  sm.phase = "build";
  sm.workflowStartedAt = Date.now();
  const memoryContext = state.memory ? state.memory.buildContext() : "";
  const modelInstruction = buildModelInstruction(model);
  const executionPrompt = buildExecutionPrompt(TMUX_CONTROL, plan, memoryContext, modelInstruction);

  const { child, flushBuffer } = spawnControllerWithPrompt(executionPrompt, model);

  broadcast("status", { running: true, phase: "build", goal: sm.goal });
  notify("Multi-Claude", "Build started (structured mode)");

  // Start Conductor-inspired monitoring via ConductorExecutor
  if (state.conductor) {
    state.conductor.start();
  }

  if (state.hooks && state.hooks.hasHooks) {
    state.hooks.run("build.started", { goal: sm.goal, plan });
  }

  // Create JSONL monitor
  ensureMonitor();

  child.on("exit", (code) => {
    flushBuffer();
    state.controllerProcess = null;
    stopPolling();
    stopConductorTimers();

    try { tmStopAll(); } catch (_) {}
    sm.sessions = [];
    broadcast("terminals", { sessions: [] });

    if (sm.stopped) {
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
    const criticalFailures = state.conductor ? state.conductor.getCriticalFailures() : [];
    if (criticalFailures.length > 0) {
      const failMsg = `[WARNING] ${criticalFailures.length} critical task(s) failed — proceeding to review for potential fixes`;
      pushControllerLine(failMsg);
      broadcast("controller", { line: failMsg });
    }

    // Continue to review phase (same state machine as legacy)
    if (!sm.reviewDone) {
      sm.reviewDone = true;
      sm.phase = "review";

      const reviewMsg = "\n--- Mandatory Review Round starting ---\n";
      pushControllerLine(reviewMsg);
      broadcast("controller", { line: reviewMsg });
      broadcast("status", { running: true, phase: "review" });
      notify("Multi-Claude", "Review round starting");

      setTimeout(() => {
        spawnReviewController(sm.goal, model);
      }, 2000);
      return;
    }

    if (sm.currentIteration < sm.iterations) {
      sm.currentIteration++;
      sm.phase = "iteration";
      sm.reviewDone = false;

      const iterMsg = `\n--- Iteration ${sm.currentIteration} of ${sm.iterations} starting ---\n`;
      pushControllerLine(iterMsg);
      broadcast("controller", { line: iterMsg });
      broadcast("status", { running: true, phase: "iteration", currentIteration: sm.currentIteration, iterations: sm.iterations });

      setTimeout(() => {
        spawnController(sm.goal, sm.terminalCount, sm.model, sm.currentIteration);
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
    if (sm.running) {
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
    const maxConcurrentAgents = body.maxConcurrentAgents
      ? Math.max(1, parseInt(body.maxConcurrentAgents, 10))
      : undefined;

    sm.iterations = iterations;
    sm.currentIteration = 0;
    sm.stopped = false;
    sm.reviewDone = false;
    sm.postChecks = null;
    sm.maxConcurrentAgents = maxConcurrentAgents; // Store for conductor creation
    state.guardrailResults = null;
    state.restoreAttempts = {};
    state.taskPlan = null;
    state.hooks = null;
    state.guardrailResults = null;
    // Reset Conductor state
    stopConductorTimers();
    state.conductor = null;
    sm.workflowStartedAt = null;

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
      running: sm.running,
      goal: sm.goal,
      terminalCount: sm.terminalCount,
      model: sm.model,
      iterations: sm.iterations,
      currentIteration: sm.currentIteration,
      phase: sm.phase,
      reviewDone: sm.reviewDone,
      postChecks: sm.postChecks,
      sessions: sm.sessions,
      taskPlan: state.taskPlan,
      taskStatus: getTaskStatus(),
      workflowStartedAt: sm.workflowStartedAt,
      retryQueue: state.conductor ? state.conductor.getRetryQueueLength() : 0,
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
      tmRestoreSession(name, info.sessionId, info.workDir);
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
    return sendJson(res, 200, { plan: state.taskPlan, taskStatus: getTaskStatus() });
  }

  if (pathname === "/api/workflow/summary" && req.method === "GET") {
    const summary = state.conductor
      ? state.conductor.getSummary(sm.workflowStartedAt)
      : { totalTasks: 0, counts: { completed: 0, failed: 0, timed_out: 0, cancelled: 0, completed_with_errors: 0, retried: 0 }, elapsed: 0, summaryText: "" };
    return sendJson(res, 200, summary);
  }

  if (pathname === "/api/agents/context" && req.method === "GET") {
    const agents = {};
    if (state.monitor) {
      for (const [name, info] of state.monitor._sessions) {
        const t = info.tokens;
        const totalInput = t.input + t.cacheRead;
        agents[name] = {
          inputTokens: t.input,
          outputTokens: t.output,
          cacheRead: t.cacheRead,
          cacheCreation: t.cacheCreation,
          contextWarned: info.contextWarned,
          estimatedContextPct: Math.min(100, Math.round((totalInput / 200000) * 100)),
        };
      }
    }
    return sendJson(res, 200, { agents });
  }

  // --- History endpoints (SQLite-backed) ---
  if (pathname === "/api/history" && req.method === "GET") {
    try {
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      const runs = historyDb.getRuns(limit, offset);
      return sendJson(res, 200, runs);
    } catch (e) { console.error("History list error:", e.message); return sendJson(res, 200, []); }
  }

  if (pathname === "/api/analytics" && req.method === "GET") {
    try {
      const analytics = historyDb.getAnalytics();
      return sendJson(res, 200, analytics);
    } catch (e) { console.error("Analytics error:", e.message); return sendJson(res, 500, { error: "Analytics query failed" }); }
  }

  const historyMatch = pathname.match(/^\/api\/history\/(.+)$/);

  if (historyMatch && req.method === "GET") {
    const id = decodeURIComponent(historyMatch[1]);
    try {
      const data = historyDb.getRun(id);
      if (!data) return sendJson(res, 404, { error: "Run not found" });
      return sendJson(res, 200, data);
    } catch (e) { console.error("History GET error:", e.message); return sendJson(res, 500, { error: "Failed to read history" }); }
  }

  if (historyMatch && req.method === "DELETE") {
    const id = decodeURIComponent(historyMatch[1]);
    try {
      const deleted = historyDb.deleteRun(id);
      if (!deleted) return sendJson(res, 404, { error: "Run not found" });
      return sendJson(res, 200, { ok: true });
    } catch (e) { console.error("History DELETE error:", e.message); return sendJson(res, 500, { error: "Failed to delete" }); }
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
        tmSignal(agentName, "SIGSTOP");
        broadcast('intervention', { agent: agentName, action: 'pause', timestamp: Date.now(), detail: 'Agent paused' });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: 'Failed to pause: ' + (e.message || '') });
      }
    }

    if (action === 'resume' && req.method === 'POST') {
      try {
        tmSignal(agentName, "SIGCONT");
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
        tmSendKeys(agentName, prompt);
        setTimeout(() => { try { tmSendKeys(agentName, ""); } catch (_) {} }, 1000);
        broadcast('intervention', { agent: agentName, action: 'inject', timestamp: Date.now(), detail: prompt.substring(0, 100) });
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 500, { error: 'Failed to inject: ' + (e.message || '') });
      }
    }

    if (action === 'kill' && req.method === 'POST') {
      const body = await parseBody(req);
      try {
        tmStopSession(agentName);
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
          tmSendKeys(agentName, body.response);
          setTimeout(() => { try { tmSendKeys(agentName, ""); } catch (_) {} }, 1000);
        } catch (_) {}
      }
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'tail' && req.method === 'GET') {
      const lines = parseInt(url.searchParams.get('lines') || '50');
      try {
        const output = tmReadOutput(agentName, Math.min(lines, 200));
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
    try { tmStopAll(); } catch (_) {}
    if (state.monitor) { state.monitor.stop(); state.monitor = null; }
    stopConductorTimers();
    clearSessionState();
    stopPolling();
    sm.running = false;
    sm.phase = 'idle';
    sm.sessions = [];
    broadcast('status', { running: false, phase: 'idle' });
    broadcast('terminals', { sessions: [] });
    broadcast('intervention', { agent: '*', action: 'estop', timestamp: Date.now(), detail: 'Emergency stop — all agents killed' });
    notify('HiveMind', 'EMERGENCY STOP — all agents killed');
    return sendJson(res, 200, { ok: true });
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

// --- WebSocket server ---

wsServer = new WsServer(server);

wsServer.on("clientConnected", (ws) => {
  wsServer.sendTo(ws, "init", buildInitData());
});

wsServer.on("clientMessage", (ws, msg) => {
  const { action, agent, prompt, restart, response } = msg;
  if (!action || !agent) return;

  try {
    switch (action) {
      case "pause":
        tmSignal(agent, "SIGSTOP");
        broadcast("intervention", { agent, action: "pause", timestamp: Date.now(), detail: "Agent paused" });
        wsServer.sendTo(ws, "actionResult", { ok: true, action, agent });
        break;

      case "resume":
        tmSignal(agent, "SIGCONT");
        broadcast("intervention", { agent, action: "resume", timestamp: Date.now(), detail: "Agent resumed" });
        wsServer.sendTo(ws, "actionResult", { ok: true, action, agent });
        break;

      case "inject": {
        const text = (prompt || "").trim();
        if (!text) {
          wsServer.sendTo(ws, "actionResult", { ok: false, action, agent, error: "Prompt is required" });
          return;
        }
        tmSendKeys(agent, text);
        setTimeout(() => { try { tmSendKeys(agent, ""); } catch (_) {} }, 1000);
        broadcast("intervention", { agent, action: "inject", timestamp: Date.now(), detail: text.substring(0, 100) });
        wsServer.sendTo(ws, "actionResult", { ok: true, action, agent });
        break;
      }

      case "kill":
        tmStopSession(agent);
        broadcast("intervention", { agent, action: "kill", timestamp: Date.now(), detail: restart ? "Killed + restarting" : "Killed" });
        wsServer.sendTo(ws, "actionResult", { ok: true, action, agent });
        break;

      case "approve":
        broadcast("intervention", { agent, action: "approve", timestamp: Date.now(), detail: response || "Approved" });
        if (response) {
          try {
            tmSendKeys(agent, response);
            setTimeout(() => { try { tmSendKeys(agent, ""); } catch (_) {} }, 1000);
          } catch (_) {}
        }
        wsServer.sendTo(ws, "actionResult", { ok: true, action, agent });
        break;

      default:
        wsServer.sendTo(ws, "actionResult", { ok: false, action, agent, error: "Unknown action" });
    }
  } catch (e) {
    wsServer.sendTo(ws, "actionResult", { ok: false, action, agent, error: e.message || String(e) });
  }
});
