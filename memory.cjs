#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const MEMORY_FILE = ".multi-claude-memory.json";

/**
 * Project memory persistence — saves learnings, issues, and decisions between runs.
 */
class ProjectMemory {
  constructor(projectDir) {
    this._filePath = path.join(projectDir, MEMORY_FILE);
    this._data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this._filePath)) {
        return JSON.parse(fs.readFileSync(this._filePath, "utf-8"));
      }
    } catch (_) {}
    return { version: 1, runs: [] };
  }

  save() {
    try {
      fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2));
    } catch (_) {}
  }

  /**
   * Add a run entry and persist.
   * @param {Object} runData - { goal, outcome, architecture, fileStructure, learnings, issues, decisions }
   */
  addRun(runData) {
    this._data.runs.push({
      timestamp: new Date().toISOString(),
      ...runData,
    });
    // Keep last 10 runs
    if (this._data.runs.length > 10) {
      this._data.runs = this._data.runs.slice(-10);
    }
    this.save();
  }

  /**
   * Build a context string for injection into controller/worker prompts.
   * Summarizes recent learnings, issues, and decisions.
   * @returns {string}
   */
  buildContext() {
    if (this._data.runs.length === 0) return "";
    const recent = this._data.runs.slice(-3);
    const lines = [];
    for (const run of recent) {
      if (run.learnings && run.learnings.length > 0) {
        lines.push(`Learnings: ${run.learnings.join("; ")}`);
      }
      if (run.issues && run.issues.length > 0) {
        lines.push(`Past issues to avoid: ${run.issues.join("; ")}`);
      }
      if (run.decisions && run.decisions.length > 0) {
        lines.push(`Architectural decisions: ${run.decisions.join("; ")}`);
      }
    }
    return lines.join("\n");
  }

  /** Get the raw data for API responses */
  getData() { return this._data; }
}

/**
 * Extract learnings from controller output lines.
 * @param {string[]} controllerOutput
 * @returns {string[]}
 */
function extractLearnings(controllerOutput) {
  const learnings = [];
  for (const line of controllerOutput) {
    if (/\b(learned|discovered|figured out|the trick is|key insight|note:|important:|remember:|workaround:|solution:)\b/i.test(line)) {
      learnings.push(line.trim().substring(0, 200));
    }
  }
  return learnings.slice(0, 5);
}

/**
 * Extract issues from controller output and post-check results.
 * @param {string[]} controllerOutput
 * @param {Object[]|null} postChecks
 * @returns {string[]}
 */
function extractIssues(controllerOutput, postChecks) {
  const issues = [];
  if (postChecks) {
    for (const check of postChecks) {
      if (!check.pass) issues.push(`${check.check}: ${check.msg}`);
    }
  }
  for (const line of controllerOutput) {
    if (/\b(error|bug|broken|missing import|failed)\b/i.test(line) && line.length > 20 && line.length < 300) {
      issues.push(line.trim().substring(0, 200));
    }
  }
  return issues.slice(0, 10);
}

/**
 * Scan a project directory and return a simple file structure.
 * @param {string} projectDir
 * @returns {Object}
 */
function scanFileStructure(projectDir) {
  const result = {};
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        result[entry.name + "/"] = "directory";
      } else {
        const stat = fs.statSync(path.join(projectDir, entry.name));
        result[entry.name] = stat.size;
      }
    }
  } catch (_) {}
  return result;
}

module.exports = { ProjectMemory, MEMORY_FILE, extractLearnings, extractIssues, scanFileStructure };
