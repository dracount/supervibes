#!/usr/bin/env node
"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const POLL_INTERVAL_MS = 1000;
const FILE_WATCH_INTERVAL_MS = 500;

/**
 * Encodes a project directory path into Claude's JSONL directory name.
 * e.g. /home/david/foo → -home-david-foo
 * Handles both forward and back slashes for cross-platform compatibility.
 */
function encodeProjectPath(dir) {
  const absDir = path.resolve(dir);
  return absDir.replace(/[/\\]/g, "-");
}

/**
 * JsonlMonitor watches Claude Code JSONL session files to track agent state,
 * token usage, and session IDs for crash recovery.
 */
class JsonlMonitor extends EventEmitter {
  constructor() {
    super();
    this._sessions = new Map(); // tmuxName → { workDir, projectDir, initialFiles, sessionFile, watcher, offset, state, tokens, lastActivity, sessionId }
    this._pollTimer = null;
  }

  /**
   * Register a tmux session to monitor.
   * @param {string} tmuxName - The tmux session name (without cc- prefix)
   * @param {string} workDir - The working directory of the session
   */
  registerSession(tmuxName, workDir) {
    if (this._sessions.has(tmuxName)) return;

    const encoded = encodeProjectPath(workDir);
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, encoded);

    // Snapshot existing JSONL files so we can detect new ones
    let initialFiles = new Set();
    try {
      if (fs.existsSync(projectDir)) {
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
        initialFiles = new Set(files);
      }
    } catch (_) {}

    this._sessions.set(tmuxName, {
      workDir,
      projectDir,
      initialFiles,
      sessionFile: null,
      watcher: null,
      offset: 0,
      state: "idle", // idle, active, tool_use
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      lastActivity: Date.now(),
      sessionId: null,
      conversationBuffer: [],  // last 200 conversation events
      contextWarned: false,
    });

    // Start polling if not already
    if (!this._pollTimer) {
      this._pollTimer = setInterval(() => this._pollForNewFiles(), POLL_INTERVAL_MS);
    }
  }

  /**
   * Get state of all monitored sessions.
   * @returns {Object} Map of tmuxName → { state, tokens, lastActivity, sessionId }
   */
  getAll() {
    const result = {};
    for (const [name, info] of this._sessions) {
      result[name] = {
        state: info.state,
        tokens: { ...info.tokens },
        lastActivity: info.lastActivity,
        sessionId: info.sessionId,
      };
    }
    return result;
  }

  /**
   * Get the Claude session ID for a tmux session.
   * @param {string} tmuxName
   * @returns {string|null}
   */
  getSessionId(tmuxName) {
    const info = this._sessions.get(tmuxName);
    return info ? info.sessionId : null;
  }

  /**
   * Get buffered conversation events for a session (for late-joining clients).
   * @param {string} tmuxName
   * @returns {Array}
   */
  getConversation(tmuxName) {
    const info = this._sessions.get(tmuxName);
    return info ? [...(info.conversationBuffer || [])] : [];
  }

  /**
   * Stop monitoring all sessions.
   */
  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    for (const [name, info] of this._sessions) {
      if (info.watcher) {
        fs.unwatchFile(info.sessionFile);
        info.watcher = null;
      }
    }
    this._sessions.clear();
  }

  // --- Internal ---

  _pollForNewFiles() {
    for (const [tmuxName, info] of this._sessions) {
      if (info.sessionFile) continue; // Already found

      try {
        if (!fs.existsSync(info.projectDir)) continue;

        const currentFiles = fs.readdirSync(info.projectDir).filter(f => f.endsWith(".jsonl"));
        const newFiles = currentFiles.filter(f => !info.initialFiles.has(f));

        if (newFiles.length > 0) {
          // Pick the newest file (sort by mtime)
          let newest = newFiles[0];
          let newestMtime = 0;
          for (const f of newFiles) {
            try {
              const stat = fs.statSync(path.join(info.projectDir, f));
              if (stat.mtimeMs > newestMtime) {
                newestMtime = stat.mtimeMs;
                newest = f;
              }
            } catch (_) {}
          }

          const filePath = path.join(info.projectDir, newest);
          info.sessionFile = filePath;

          // Extract session ID from filename (UUID part before .jsonl)
          const match = newest.match(/^([0-9a-f-]{36})\.jsonl$/);
          if (match) {
            info.sessionId = match[1];
            this.emit("sessionMapped", tmuxName, match[1]);
          }

          // Start watching the file
          info.offset = 0;
          this._readNewLines(tmuxName, info);
          info.watcher = true;
          fs.watchFile(filePath, { interval: FILE_WATCH_INTERVAL_MS }, () => {
            this._readNewLines(tmuxName, info);
          });
        }
      } catch (_) {}
    }
  }

  _readNewLines(tmuxName, info) {
    if (!info.sessionFile) return;

    try {
      const stat = fs.statSync(info.sessionFile);
      if (stat.size <= info.offset) return;

      const fd = fs.openSync(info.sessionFile, "r");
      let text;
      try {
        const buf = Buffer.alloc(stat.size - info.offset);
        fs.readSync(fd, buf, 0, buf.length, info.offset);
        text = buf.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }

      info.offset = stat.size;
      const lines = text.split("\n").filter(l => l.trim());

      for (const line of lines) {
        this._processLine(tmuxName, info, line);
      }
    } catch (_) {}
  }

  _processLine(tmuxName, info, line) {
    try {
      const msg = JSON.parse(line);
      info.lastActivity = Date.now();

      if (msg.type === "assistant" && msg.message) {
        // Track state from stop_reason
        const stopReason = msg.message.stop_reason;
        let newState;
        if (stopReason === null || stopReason === undefined) {
          newState = "active";
        } else if (stopReason === "tool_use") {
          newState = "tool_use";
        } else {
          newState = "idle"; // end_turn, max_tokens, etc.
        }

        if (newState !== info.state) {
          info.state = newState;
          this.emit("stateChange", tmuxName, newState, { ...info.tokens });
        }

        // Accumulate usage
        const usage = msg.message.usage || {};
        if (usage.input_tokens) info.tokens.input += usage.input_tokens;
        if (usage.output_tokens) info.tokens.output += usage.output_tokens;
        if (usage.cache_read_input_tokens) info.tokens.cacheRead += usage.cache_read_input_tokens;
        if (usage.cache_creation_input_tokens) info.tokens.cacheCreation += usage.cache_creation_input_tokens;

        // Context window warning
        const totalContext = info.tokens.input + info.tokens.cacheRead;
        if (totalContext > 150000 && !info.contextWarned) {
          info.contextWarned = true;
          this.emit('contextWarning', tmuxName, { totalContext, limit: 200000 });
        }
      }

      // Emit conversation events for dashboard
      if (msg.message && msg.message.content && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          let evt = null;
          if (block.type === 'thinking') {
            evt = { type: 'thinking', content: block.thinking, timestamp: Date.now() };
          } else if (block.type === 'text') {
            evt = { type: 'text', content: block.text, timestamp: Date.now() };
          } else if (block.type === 'tool_use') {
            evt = { type: 'tool_call', toolName: block.name, toolId: block.id, input: block.input, timestamp: Date.now() };
          } else if (block.type === 'tool_result') {
            evt = {
              type: 'tool_result',
              toolId: block.tool_use_id,
              content: typeof block.content === 'string'
                ? block.content.substring(0, 2000)
                : JSON.stringify(block.content).substring(0, 2000),
              timestamp: Date.now(),
            };
          }
          if (evt) {
            info.conversationBuffer.push(evt);
            if (info.conversationBuffer.length > 200) info.conversationBuffer.shift();
            this.emit('conversation', tmuxName, evt);
          }
        }
      }

      if (msg.type === "system" && msg.subtype === "turn_duration") {
        const durationMs = msg.duration_ms || (msg.duration_seconds ? msg.duration_seconds * 1000 : 0);
        if (durationMs > 0) {
          this.emit("turnComplete", tmuxName, durationMs);
        }
      }
    } catch (_) {
      // Not valid JSON, skip
    }
  }
}

module.exports = { JsonlMonitor, encodeProjectPath };
