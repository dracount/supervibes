#!/usr/bin/env node
/**
 * @deprecated Use terminal-manager.cjs instead.
 * This tmux-based backend is preserved as a fallback for environments where
 * node-pty fails to build (native addon). Enable with: TMUX_FALLBACK=1
 *
 * terminal-manager.cjs provides the same API surface using node-pty,
 * eliminating the tmux dependency for cross-platform support.
 */
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PREFIX = "cc-";
const MSG_DIR = path.join(os.tmpdir(), "multi-claude-messages");

// --- validation ---

const VALID_NAME = /^[a-zA-Z0-9_-]+$/;
const VALID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function validateName(name) {
  if (!VALID_NAME.test(name)) {
    console.error(`Invalid session name: ${name} (must match ${VALID_NAME})`);
    process.exit(1);
  }
}

function validateSessionId(id) {
  if (!VALID_UUID.test(id)) {
    console.error(`Invalid session ID: ${id} (must be a UUID)`);
    process.exit(1);
  }
}

function validatePath(p) {
  // Ensure it's a resolved absolute path with no shell metacharacters
  const resolved = path.resolve(p);
  if (/[;&|`$(){}]/.test(resolved)) {
    console.error(`Invalid path (contains shell metacharacters): ${resolved}`);
    process.exit(1);
  }
  return resolved;
}

// --- helpers ---

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trimEnd();
  } catch (e) {
    return e.stdout ? e.stdout.trimEnd() : "";
  }
}

function sessionName(name) {
  return `${PREFIX}${name}`;
}

// --- core functions ---

function listSessions() {
  const raw = run("tmux list-sessions -F '#{session_name}' 2>/dev/null");
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((s) => s.startsWith(PREFIX))
    .map((s) => s.slice(PREFIX.length));
}

function startSession(name, workDir) {
  const sess = sessionName(name);

  // check if session already exists
  const existing = run(`tmux has-session -t ${sess} 2>/dev/null; echo $?`);
  if (existing === "0") {
    console.log(`Session '${name}' already exists.`);
    return;
  }

  const pathEnv = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

  // Unset CLAUDECODE so nested Claude Code sessions don't detect a parent
  run(
    `tmux new-session -d -s ${sess} -x 120 -y 40 -c "${workDir}" ` +
      `-e "CLAUDECODE=" ` +
      `-e "CLAUDE_CODE_ENTRYPOINT=" ` +
      `-e "TERM=xterm-256color" ` +
      `-e "PATH=${pathEnv}"`
  );

  // Unset at the tmux environment level too (prevents inheritance on attach)
  run(`tmux set-environment -t ${sess} -u CLAUDECODE 2>/dev/null`);
  run(`tmux set-environment -t ${sess} -u CLAUDE_CODE_ENTRYPOINT 2>/dev/null`);

  // Also send unset commands into the shell to be safe
  run(`tmux send-keys -t ${sess} 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null' Enter`);

  // Export MSG_DIR so workers can find the message board
  run(`tmux send-keys -t ${sess} 'export MULTI_CLAUDE_MSG_DIR="${MSG_DIR}" 2>/dev/null' Enter`);

  console.log(`Started session '${name}' in ${workDir} (attach with: tmux attach -t ${sess})`);
}

function stopSession(name) {
  const sess = sessionName(name);
  run(`tmux kill-session -t ${sess} 2>/dev/null`);
  console.log(`Stopped session '${name}'`);
}

function stopAll() {
  const sessions = listSessions();
  for (const name of sessions) {
    run(`tmux kill-session -t ${sessionName(name)} 2>/dev/null`);
  }
  clearMessages();
  console.log(
    sessions.length > 0
      ? `Stopped all sessions: ${sessions.join(", ")}`
      : "No active sessions."
  );
}

function sendKeys(name, text) {
  const sess = sessionName(name);
  if (text === "") {
    run(`tmux send-keys -t ${sess} Enter`);
  } else if (text.length > 200) {
    // Use load-buffer with a named buffer to avoid race conditions between sessions
    const bufName = `cc-${process.pid}-${Date.now()}`;
    const tmpFile = path.join(os.tmpdir(), bufName);
    try {
      fs.writeFileSync(tmpFile, text);
      run(`tmux load-buffer -b ${bufName} "${tmpFile}"`);
      run(`tmux paste-buffer -b ${bufName} -t ${sess}`);
      run(`tmux delete-buffer -b ${bufName} 2>/dev/null`);
      run(`tmux send-keys -t ${sess} Enter`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      run(`tmux delete-buffer -b ${bufName} 2>/dev/null`);
    }
  } else {
    const escaped = text.replace(/'/g, "'\\''");
    run(`tmux send-keys -t ${sess} -l '${escaped}'`);
    run(`tmux send-keys -t ${sess} Enter`);
  }
}

function readPane(name, lines = 50) {
  const sess = sessionName(name);
  const output = run(`tmux capture-pane -t ${sess} -p -S -${lines}`);
  console.log(output);
}

function restoreSession(name, sessionId, workDir) {
  const sess = sessionName(name);

  // Kill existing session if any
  run(`tmux kill-session -t ${sess} 2>/dev/null`);

  const pathEnv = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

  // Create fresh tmux session (same env setup as startSession)
  run(
    `tmux new-session -d -s ${sess} -x 120 -y 40 -c "${workDir}" ` +
      `-e "CLAUDECODE=" ` +
      `-e "CLAUDE_CODE_ENTRYPOINT=" ` +
      `-e "TERM=xterm-256color" ` +
      `-e "PATH=${pathEnv}"`
  );

  run(`tmux set-environment -t ${sess} -u CLAUDECODE 2>/dev/null`);
  run(`tmux set-environment -t ${sess} -u CLAUDE_CODE_ENTRYPOINT 2>/dev/null`);
  run(`tmux send-keys -t ${sess} 'unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null' Enter`);

  // Launch Claude Code with --resume
  const resumeCmd = `claude --resume "${sessionId}" --dangerously-skip-permissions`;
  const escaped = resumeCmd.replace(/'/g, "'\\''");
  run(`tmux send-keys -t ${sess} -l '${escaped}'`);
  run(`tmux send-keys -t ${sess} Enter`);

  console.log(`Restored session '${name}' (session: ${sessionId}) in ${workDir}`);
}

function createWorktree(name, baseDir) {
  const absBase = path.resolve(baseDir);
  const worktreeDir = path.join(absBase, ".worktrees", name);
  const branch = `cc-${name}`;

  // Ensure .worktrees directory exists
  const worktreesRoot = path.join(absBase, ".worktrees");
  if (!fs.existsSync(worktreesRoot)) {
    fs.mkdirSync(worktreesRoot, { recursive: true });
  }

  // Clean up stale branch if exists
  try {
    execSync(`git -C "${absBase}" branch -D "${branch}" 2>/dev/null`, { encoding: "utf-8", timeout: 10000 });
  } catch (_) {}

  // Remove stale worktree entry if exists
  try {
    execSync(`git -C "${absBase}" worktree remove --force "${worktreeDir}" 2>/dev/null`, { encoding: "utf-8", timeout: 10000 });
  } catch (_) {}

  // Create the worktree
  try {
    execSync(`git -C "${absBase}" worktree add "${worktreeDir}" -b "${branch}" HEAD`, {
      encoding: "utf-8",
      timeout: 15000,
    });
  } catch (e) {
    console.error(`Failed to create worktree: ${e.message}`);
    process.exit(1);
  }

  // Print path to stdout (captured by controller)
  console.log(worktreeDir);
}

function cleanupWorktrees(baseDir) {
  const absBase = path.resolve(baseDir);
  const worktreesRoot = path.join(absBase, ".worktrees");

  if (!fs.existsSync(worktreesRoot)) {
    console.log("No .worktrees directory found.");
    return;
  }

  // Remove each worktree entry
  try {
    const entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const wtPath = path.join(worktreesRoot, entry.name);
        try {
          execSync(`git -C "${absBase}" worktree remove --force "${wtPath}" 2>/dev/null`, {
            encoding: "utf-8",
            timeout: 10000,
          });
          console.log(`Removed worktree: ${entry.name}`);
        } catch (_) {
          // Force-remove the directory if git worktree remove fails
          try {
            fs.rmSync(wtPath, { recursive: true, force: true });
            console.log(`Force-removed: ${entry.name}`);
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // Prune stale worktree refs
  try {
    execSync(`git -C "${absBase}" worktree prune`, { encoding: "utf-8", timeout: 10000 });
  } catch (_) {}

  // Delete cc-* branches
  try {
    const branches = execSync(`git -C "${absBase}" branch --list "cc-*"`, {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    if (branches) {
      for (const b of branches.split("\n")) {
        const branchName = b.trim().replace(/^\* /, "");
        if (branchName) {
          try {
            execSync(`git -C "${absBase}" branch -D "${branchName}"`, { encoding: "utf-8", timeout: 10000 });
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // Remove .worktrees directory
  try {
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
  } catch (_) {}

  console.log("Worktree cleanup complete.");
}

// --- Inter-agent messaging ---

function ensureMsgDir() {
  if (!fs.existsSync(MSG_DIR)) {
    fs.mkdirSync(MSG_DIR, { recursive: true });
  }
}

function writeMessage(from, to, content) {
  ensureMsgDir();
  const msg = {
    from,
    to,
    timestamp: new Date().toISOString(),
    content,
  };
  const msgFile = path.join(MSG_DIR, "messages.jsonl");
  fs.appendFileSync(msgFile, JSON.stringify(msg) + "\n");
  console.log(`Message sent: ${from} -> ${to}`);
}

function readMessages(name) {
  const msgFile = path.join(MSG_DIR, "messages.jsonl");
  if (!fs.existsSync(msgFile)) {
    console.log("No messages.");
    return;
  }
  const lines = fs.readFileSync(msgFile, "utf-8").split("\n").filter(l => l.trim());
  const msgs = lines
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(m => m && (m.to === name || m.to === "*"));

  if (msgs.length === 0) {
    console.log("No messages for " + name);
  } else {
    for (const m of msgs) {
      console.log(`[${m.timestamp}] ${m.from} -> ${m.to}: ${m.content}`);
    }
  }
}

function readAllMessages() {
  const msgFile = path.join(MSG_DIR, "messages.jsonl");
  if (!fs.existsSync(msgFile)) {
    console.log("No messages.");
    return;
  }
  const content = fs.readFileSync(msgFile, "utf-8").trim();
  console.log(content || "No messages.");
}

function clearMessages() {
  try {
    const msgFile = path.join(MSG_DIR, "messages.jsonl");
    if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
  } catch (_) {}
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    return;
  }

  const flag = args[0];

  switch (flag) {
    case "--start": {
      const name = args[1];
      const workDir = args[2];
      if (!name || !workDir) {
        console.error("Usage: --start <name> <working-dir>");
        process.exit(1);
      }
      validateName(name);
      startSession(name, validatePath(workDir));
      break;
    }
    case "--cmd": {
      const name = args[1];
      const text = args[2];
      if (!name || text === undefined) {
        console.error('Usage: --cmd <name> "command text"');
        process.exit(1);
      }
      validateName(name);
      sendKeys(name, text);
      break;
    }
    case "--read": {
      const name = args[1];
      const lines = args[2] ? parseInt(args[2], 10) : 50;
      if (!name) {
        console.error("Usage: --read <name> [lines]");
        process.exit(1);
      }
      validateName(name);
      readPane(name, lines);
      break;
    }
    case "--stop": {
      const name = args[1];
      if (!name) {
        console.error("Usage: --stop <name>");
        process.exit(1);
      }
      validateName(name);
      stopSession(name);
      break;
    }
    case "--stop-all": {
      stopAll();
      break;
    }
    case "--list": {
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log("No active sessions.");
      } else {
        console.log("Active sessions:");
        for (const s of sessions) {
          console.log(`  ${s}`);
        }
      }
      break;
    }
    case "--restore": {
      const name = args[1];
      const sessionId = args[2];
      const workDir = args[3];
      if (!name || !sessionId || !workDir) {
        console.error("Usage: --restore <name> <sessionId> <working-dir>");
        process.exit(1);
      }
      validateName(name);
      validateSessionId(sessionId);
      restoreSession(name, sessionId, validatePath(workDir));
      break;
    }
    case "--worktree": {
      const name = args[1];
      const baseDir = args[2];
      if (!name || !baseDir) {
        console.error("Usage: --worktree <name> <base-dir>");
        process.exit(1);
      }
      validateName(name);
      createWorktree(name, validatePath(baseDir));
      break;
    }
    case "--help":
    case "-h": {
      printUsage();
      break;
    }
    case "--msg": {
      const action = args[1];
      if (action === "write") {
        const from = args[2];
        const to = args[3];
        const content = args[4];
        if (!from || !to || !content) {
          console.error('Usage: --msg write <from> <to> "message"');
          process.exit(1);
        }
        validateName(from);
        if (to !== "*") validateName(to);
        writeMessage(from, to, content);
      } else if (action === "read") {
        const name = args[2];
        if (!name) {
          console.error("Usage: --msg read <name>");
          process.exit(1);
        }
        validateName(name);
        readMessages(name);
      } else if (action === "read-all") {
        readAllMessages();
      } else {
        console.error("Usage: --msg <write|read|read-all> ...");
        process.exit(1);
      }
      break;
    }
    case "--signal": {
      const name = args[1];
      const sig = args[2] || 'SIGSTOP';
      if (!name) {
        console.error('Usage: --signal <name> <signal>');
        process.exit(1);
      }
      validateName(name);
      const VALID_SIGNALS = new Set(['SIGSTOP', 'SIGCONT', 'SIGTERM', 'SIGKILL', 'SIGUSR1', 'SIGUSR2', 'SIGHUP']);
      if (!VALID_SIGNALS.has(sig)) {
        console.error(`Invalid signal: ${sig} (allowed: ${[...VALID_SIGNALS].join(', ')})`);
        process.exit(1);
      }
      const sess = sessionName(name);
      try {
        const pid = execSync(`tmux display-message -t "${sess}" -p "#{pane_pid}"`, { encoding: 'utf-8' }).trim();
        if (!/^\d+$/.test(pid)) {
          console.error(`Invalid PID from tmux: ${pid}`);
          process.exit(1);
        }
        execSync(`kill -s ${sig} -${pid}`, { encoding: 'utf-8' });
        console.log(`Sent ${sig} to ${name} (pid group ${pid})`);
      } catch (e) {
        console.error(`Failed to signal ${name}: ${e.message}`);
        process.exit(1);
      }
      break;
    }
    case "--cleanup-worktrees": {
      const baseDir = args[1];
      if (!baseDir) {
        console.error("Usage: --cleanup-worktrees <base-dir>");
        process.exit(1);
      }
      cleanupWorktrees(validatePath(baseDir));
      break;
    }
    default:
      console.error(`Unknown flag: ${flag}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  --start <name> <dir>    Start a new terminal session
  --cmd <name> "text"     Send command to a session
  --read <name> [lines]   Read output (default 50 lines)
  --stop <name>           Stop a session
  --stop-all              Stop all sessions
  --list                  List active sessions
  --restore <n> <sid> <d> Restore a crashed session with --resume
  --worktree <n> <dir>    Create a git worktree for agent <n>
  --cleanup-worktrees <d> Remove all worktrees and cc-* branches
  --msg write <f> <t> "m" Send message from <f> to <t>
  --msg read <name>       Read messages for <name>
  --msg read-all          Read all messages`);
}

main();
