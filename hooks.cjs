#!/usr/bin/env node
"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOOKS_FILE = ".multi-claude-hooks.json";

/**
 * Event bus / hook runner for lifecycle events.
 * Looks for a .multi-claude-hooks.json config file in the provided search directories.
 *
 * Config format:
 * {
 *   "hooks": {
 *     "build.started": ["./hooks/notify.sh"],
 *     "worker.completed": ["./hooks/validate.sh"],
 *     ...
 *   }
 * }
 *
 * Hook scripts receive event info via environment variables:
 *   MULTI_CLAUDE_EVENT - event name (e.g. "build.started")
 *   MULTI_CLAUDE_CONTEXT - JSON-encoded context object
 */
class HookRunner {
  /**
   * @param {string[]} searchDirs - directories to search for the hooks config file
   */
  constructor(searchDirs) {
    this._hooks = {};
    this._configDir = searchDirs[0] || ".";
    this._loadConfig(searchDirs);
  }

  _loadConfig(searchDirs) {
    for (const dir of searchDirs) {
      const filePath = path.join(dir, HOOKS_FILE);
      if (fs.existsSync(filePath)) {
        try {
          const config = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          this._hooks = config.hooks || {};
          this._configDir = dir;
          return;
        } catch (_) {}
      }
    }
  }

  /**
   * Run all hooks for an event. Best-effort — failures don't propagate.
   * @param {string} event - e.g. "build.started", "worker.completed"
   * @param {Object} context - event context passed as JSON env var
   * @returns {Promise<Object[]>} results array
   */
  async run(event, context) {
    const scripts = this._hooks[event];
    if (!scripts || scripts.length === 0) return [];
    const results = [];
    for (const script of scripts) {
      const scriptPath = path.resolve(this._configDir, script);
      try {
        await new Promise((resolve) => {
          execFile(scriptPath, [], {
            env: {
              ...process.env,
              MULTI_CLAUDE_EVENT: event,
              MULTI_CLAUDE_CONTEXT: JSON.stringify(context || {}),
            },
            timeout: 30000,
          }, (err, stdout, stderr) => {
            if (err && stderr) {
              console.error(`[Hook ${event}] ${script}: ${stderr.trim().split("\n")[0]}`);
            }
            results.push({ script, ok: !err, stdout, stderr });
            resolve();
          });
        });
      } catch (e) {
        results.push({ script, ok: false, error: e.message });
      }
    }
    return results;
  }

  /** List all registered event types */
  get events() { return Object.keys(this._hooks); }

  /** Check if any hooks are configured */
  get hasHooks() { return Object.keys(this._hooks).length > 0; }
}

module.exports = { HookRunner, HOOKS_FILE };
