"use strict";

const { EventEmitter } = require("events");

/**
 * StateManager — owns core workflow state and SSE broadcasting.
 *
 * Extracted from server.cjs to separate state management from orchestration
 * logic. All SSE client management and broadcasting goes through this class.
 *
 * Fields owned:
 *   running, phase, goal, model, terminalCount, iterations, currentIteration,
 *   sessions, stopped, reviewDone, sseClients, workflowStartedAt, postChecks
 */
class StateManager extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.phase = "idle"; // "planning", "build", "review", "iteration", "postcheck", "idle"
    this.goal = "";
    this.model = "sonnet";
    this.terminalCount = "auto";
    this.iterations = 0;        // total iterations requested
    this.currentIteration = 0;  // 0 = initial build, 1+ = improvement iterations
    this.sessions = [];
    this.stopped = false;
    this.reviewDone = false;
    this.sseClients = [];
    this.workflowStartedAt = null;
    this.postChecks = null;     // array of {check, pass, msg} after post-checks run
  }

  /**
   * Broadcast an SSE event to all connected clients.
   * Dead clients are automatically pruned.
   */
  broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (let i = this.sseClients.length - 1; i >= 0; i--) {
      try {
        this.sseClients[i].write(msg);
      } catch (_) {
        this.sseClients.splice(i, 1);
      }
    }
  }

  /**
   * Register an SSE client response object.
   */
  addClient(res) {
    this.sseClients.push(res);
  }

  /**
   * Remove an SSE client response object.
   */
  removeClient(res) {
    const idx = this.sseClients.indexOf(res);
    if (idx !== -1) this.sseClients.splice(idx, 1);
  }

  /**
   * Reset workflow state to idle defaults.
   */
  reset() {
    this.running = false;
    this.phase = "idle";
    this.sessions = [];
    this.stopped = false;
    this.reviewDone = false;
    this.workflowStartedAt = null;
    this.postChecks = null;
  }

  /**
   * Return the subset of init data that StateManager owns,
   * for late-joining SSE clients.
   */
  toInitData() {
    return {
      running: this.running,
      goal: this.goal,
      terminalCount: this.terminalCount,
      model: this.model,
      iterations: this.iterations,
      currentIteration: this.currentIteration,
      phase: this.phase,
      reviewDone: this.reviewDone,
      postChecks: this.postChecks,
      sessions: this.sessions,
      workflowStartedAt: this.workflowStartedAt,
    };
  }
}

module.exports = { StateManager };
