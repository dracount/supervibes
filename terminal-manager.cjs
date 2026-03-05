#!/usr/bin/env node
"use strict";

const pty = require("node-pty");
const { execSync } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MSG_DIR = path.join(os.tmpdir(), "multi-claude-messages");
const VALID_SIGNALS = new Set([
  "SIGSTOP", "SIGCONT", "SIGTERM", "SIGKILL",
  "SIGUSR1", "SIGUSR2", "SIGHUP",
]);

/**
 * TerminalManager — node-pty backend replacing tmux-control.cjs.
 *
 * Provides the same logical API surface:
 *   startSession, stopSession, stopAll, sendKeys, readOutput,
 *   listSessions, getSession, isAlive, restoreSession,
 *   createWorktree, cleanupWorktrees, signal
 *
 * Emits: 'output' (name, data), 'exit' (name, code), 'error' (name, err)
 */
class TerminalManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._sessions = new Map(); // name -> { pty, buffer, workDir, exitCode, pid }
    this._maxBufferLines = options.maxBufferLines || 500;

    // Ensure clean shutdown
    const cleanup = () => this.stopAll();
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
  }

  /**
   * Detect the platform-appropriate shell.
   */
  _getShell() {
    if (process.platform === "win32") return "cmd.exe";
    return process.env.SHELL || "/bin/bash";
  }

  /**
   * Build environment for spawned pty — unset nesting vars.
   */
  _buildEnv(workDir) {
    const env = Object.assign({}, process.env);
    // Nesting bypass: unset Claude Code detection vars
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    env.TERM = "xterm-256color";
    env.MULTI_CLAUDE_MSG_DIR = MSG_DIR;
    return env;
  }

  /**
   * Spawn a new pty session.
   * @param {string} name - Session name (e.g. "worker-1")
   * @param {string} workDir - Working directory
   * @returns {{ name: string, pid: number }}
   */
  startSession(name, workDir) {
    // Kill existing session with same name
    if (this._sessions.has(name)) {
      this.stopSession(name);
    }

    const resolvedDir = path.resolve(workDir);
    const shell = this._getShell();
    const env = this._buildEnv(resolvedDir);

    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: resolvedDir,
      env,
    });

    const session = {
      pty: proc,
      buffer: [],       // ring buffer of output lines
      partial: "",       // incomplete line accumulator
      workDir: resolvedDir,
      exitCode: null,
      pid: proc.pid,
      alive: true,
    };

    proc.onData((data) => {
      this._appendOutput(name, session, data);
      this.emit("output", name, data);
    });

    proc.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      session.alive = false;
      // Flush partial line
      if (session.partial) {
        session.buffer.push(session.partial);
        session.partial = "";
        this._trimBuffer(session);
      }
      this.emit("exit", name, exitCode);
    });

    this._sessions.set(name, session);

    // Send unset commands into the shell for extra safety
    proc.write("unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT 2>/dev/null\r");

    return { name, pid: proc.pid };
  }

  /**
   * Kill a pty session.
   */
  stopSession(name) {
    const session = this._sessions.get(name);
    if (!session) return;
    try {
      if (session.alive) {
        session.pty.kill();
      }
    } catch (_) {}
    session.alive = false;
    this._sessions.delete(name);
  }

  /**
   * Kill all sessions. Also clears inter-agent messages.
   */
  stopAll() {
    for (const [name] of this._sessions) {
      this.stopSession(name);
    }
    this._clearMessages();
  }

  /**
   * Write text to pty stdin.
   * Empty string sends Enter. Otherwise writes text + carriage return.
   */
  sendKeys(name, text) {
    const session = this._sessions.get(name);
    if (!session || !session.alive) return;

    if (text === "") {
      // Just send Enter
      session.pty.write("\r");
    } else {
      // Write text + Enter
      session.pty.write(text + "\r");
    }
  }

  /**
   * Read last N lines from the ring buffer.
   * @returns {string} output text
   */
  readOutput(name, lines = 50) {
    const session = this._sessions.get(name);
    if (!session) return "";
    const buf = session.buffer;
    const start = Math.max(0, buf.length - lines);
    return buf.slice(start).join("\n");
  }

  /**
   * List active session names.
   * @returns {string[]}
   */
  listSessions() {
    const names = [];
    for (const [name, session] of this._sessions) {
      if (session.alive) names.push(name);
    }
    return names;
  }

  /**
   * Get session metadata.
   * @returns {{ name, workDir, pid, exitCode, alive, bufferLines } | null}
   */
  getSession(name) {
    const session = this._sessions.get(name);
    if (!session) return null;
    return {
      name,
      workDir: session.workDir,
      pid: session.pid,
      exitCode: session.exitCode,
      alive: session.alive,
      bufferLines: session.buffer.length,
    };
  }

  /**
   * Check if a session's pty process is still running.
   */
  isAlive(name) {
    const session = this._sessions.get(name);
    return session ? session.alive : false;
  }

  /**
   * Restore a crashed session by spawning a new pty and running `claude --resume`.
   */
  restoreSession(name, sessionId, workDir) {
    // Kill existing if any
    this.stopSession(name);

    // Start fresh session
    this.startSession(name, workDir);

    // Launch Claude Code with --resume
    const resumeCmd = `claude --resume "${sessionId}" --dangerously-skip-permissions`;
    this.sendKeys(name, resumeCmd);
  }

  /**
   * Send a signal to the pty child process group.
   * @param {string} name - Session name
   * @param {string} sig - Signal name (e.g. "SIGSTOP", "SIGCONT")
   */
  signal(name, sig) {
    if (!VALID_SIGNALS.has(sig)) {
      throw new Error(`Invalid signal: ${sig} (allowed: ${[...VALID_SIGNALS].join(", ")})`);
    }
    const session = this._sessions.get(name);
    if (!session || !session.alive) {
      throw new Error(`Session '${name}' not found or not alive`);
    }
    // Send signal to the process group (negative PID)
    try {
      process.kill(-session.pid, sig);
    } catch (e) {
      // Fallback: send to the process directly
      try {
        process.kill(session.pid, sig);
      } catch (e2) {
        throw new Error(`Failed to signal ${name} (pid ${session.pid}): ${e2.message}`);
      }
    }
  }

  // --- Git worktree management (delegates to git CLI) ---

  /**
   * Create a git worktree for an agent.
   * @returns {string} worktree directory path
   */
  createWorktree(name, baseDir) {
    const absBase = path.resolve(baseDir);
    const worktreeDir = path.join(absBase, ".worktrees", name);
    const branch = `cc-${name}`;
    const worktreesRoot = path.join(absBase, ".worktrees");

    if (!fs.existsSync(worktreesRoot)) {
      fs.mkdirSync(worktreesRoot, { recursive: true });
    }

    // Clean up stale branch
    try {
      execSync(`git -C "${absBase}" branch -D "${branch}" 2>/dev/null`, {
        encoding: "utf-8", timeout: 10000,
      });
    } catch (_) {}

    // Remove stale worktree entry
    try {
      execSync(`git -C "${absBase}" worktree remove --force "${worktreeDir}" 2>/dev/null`, {
        encoding: "utf-8", timeout: 10000,
      });
    } catch (_) {}

    // Create the worktree
    try {
      execSync(`git -C "${absBase}" worktree add "${worktreeDir}" -b "${branch}" HEAD`, {
        encoding: "utf-8", timeout: 15000,
      });
    } catch (e) {
      throw new Error(`Failed to create worktree: ${e.message}`);
    }

    return worktreeDir;
  }

  /**
   * Remove all worktrees and cc-* branches.
   */
  cleanupWorktrees(baseDir) {
    const absBase = path.resolve(baseDir);
    const worktreesRoot = path.join(absBase, ".worktrees");

    if (!fs.existsSync(worktreesRoot)) return;

    // Remove each worktree entry
    try {
      const entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const wtPath = path.join(worktreesRoot, entry.name);
          try {
            execSync(`git -C "${absBase}" worktree remove --force "${wtPath}" 2>/dev/null`, {
              encoding: "utf-8", timeout: 10000,
            });
          } catch (_) {
            try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch (_) {}
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
        encoding: "utf-8", timeout: 10000,
      }).trim();
      if (branches) {
        for (const b of branches.split("\n")) {
          const branchName = b.trim().replace(/^\* /, "");
          if (branchName) {
            try {
              execSync(`git -C "${absBase}" branch -D "${branchName}"`, {
                encoding: "utf-8", timeout: 10000,
              });
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    // Remove .worktrees directory
    try { fs.rmSync(worktreesRoot, { recursive: true, force: true }); } catch (_) {}
  }

  // --- Inter-agent messaging (same as tmux-control.cjs) ---

  writeMessage(from, to, content) {
    this._ensureMsgDir();
    const msg = {
      from, to,
      timestamp: new Date().toISOString(),
      content,
    };
    const msgFile = path.join(MSG_DIR, "messages.jsonl");
    fs.appendFileSync(msgFile, JSON.stringify(msg) + "\n");
  }

  readMessages(name) {
    const msgFile = path.join(MSG_DIR, "messages.jsonl");
    if (!fs.existsSync(msgFile)) return [];
    const lines = fs.readFileSync(msgFile, "utf-8").split("\n").filter(l => l.trim());
    return lines
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(m => m && (m.to === name || m.to === "*"));
  }

  readAllMessages() {
    const msgFile = path.join(MSG_DIR, "messages.jsonl");
    if (!fs.existsSync(msgFile)) return "";
    return fs.readFileSync(msgFile, "utf-8").trim();
  }

  // --- Internal helpers ---

  /**
   * Append pty output data to the ring buffer, splitting by newlines.
   */
  _appendOutput(name, session, data) {
    // Strip ANSI escape sequences for cleaner buffer storage
    const cleaned = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const text = session.partial + cleaned;
    const lines = text.split("\n");

    // Last element is either empty (complete line) or a partial
    session.partial = lines.pop() || "";

    for (const line of lines) {
      session.buffer.push(line);
    }
    this._trimBuffer(session);
  }

  /**
   * Trim buffer to max size.
   */
  _trimBuffer(session) {
    if (session.buffer.length > this._maxBufferLines) {
      session.buffer = session.buffer.slice(-this._maxBufferLines);
    }
  }

  _ensureMsgDir() {
    if (!fs.existsSync(MSG_DIR)) {
      fs.mkdirSync(MSG_DIR, { recursive: true });
    }
  }

  _clearMessages() {
    try {
      const msgFile = path.join(MSG_DIR, "messages.jsonl");
      if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
    } catch (_) {}
  }
}

module.exports = { TerminalManager };
