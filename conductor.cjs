"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  createTaskStatus, calculateRetryDelay, isTaskTimedOut, canRetryTask,
  TASK_STATES, TASK_TYPES, WAIT_CONDITION_TYPES,
  DEFAULT_WAIT_POLL_INTERVAL, DEFAULT_WAIT_TIMEOUT,
} = require("./task-schema.cjs");

/**
 * ConductorExecutor - Manages task state, timeouts, retries, and wait conditions
 * for a structured task plan.
 *
 * Emits events instead of calling broadcast() directly, allowing the caller
 * (server.cjs) to wire events to SSE broadcasting.
 *
 * Events emitted:
 *   - 'taskStarted'       (taskName, taskStatus)
 *   - 'taskCompleted'     (taskName, taskStatus)
 *   - 'taskFailed'        (taskName, error, taskStatus)
 *   - 'taskTimedOut'      (taskName, taskStatus)
 *   - 'retryScheduled'    (taskName, delay, taskStatus)
 *   - 'statusChanged'     (fullTaskStatusMap)
 *   - 'waitConditionMet'  (taskName, taskStatus)
 *   - 'waitConditionTimedOut' (taskName, taskStatus)
 *   - 'workflowTimeout'   ()
 *   - 'retryReady'        (taskName, task, taskStatus)
 *   - 'fileChange'         (changeRecord) — file change detected in watched directory
 *   - 'log'               (message)  — informational messages for controller output
 */
class ConductorExecutor extends EventEmitter {
  /**
   * @param {Object} plan - Validated task plan with .tasks array
   * @param {Object} options
   * @param {Function} [options.findProjectDir] - Returns project directory path
   */
  constructor(plan, options = {}) {
    super();
    this.plan = plan;
    this.taskStatus = {};     // task name -> status object
    this.retryQueue = [];     // [{taskName, retryAt}]
    this._timers = {
      taskTimeout: null,      // setInterval for per-task timeout checks
      workflowTimeout: null,  // setTimeout for workflow-level timeout
      waitCondition: null,    // setInterval for WAIT condition polling
      retryQueue: null,       // setInterval for retry queue processing
    };
    this._stopped = false;
    this._findProjectDir = options.findProjectDir || (() => null);

    // File change tracking
    this._watchers = new Map();       // taskName -> fs.FSWatcher
    this._fileChanges = [];           // capped at 500
    this._debounceTimers = new Map(); // taskName -> { timer, pending[] }
  }

  // ---- Initialization ----

  /**
   * Initialize task status for all tasks in the plan.
   */
  initTaskStatus() {
    this.taskStatus = {};
    for (const task of this.plan.tasks) {
      this.taskStatus[task.name] = createTaskStatus(task);
    }
    this.emit("statusChanged", this.taskStatus);
  }

  // ---- Lifecycle ----

  /**
   * Start execution — set up timeout checking, wait conditions, retry queue.
   * Also initializes WAIT task states.
   */
  start() {
    this._stopped = false;

    // Start workflow-level timeout if configured
    if (this.plan.timeoutSeconds) {
      this._startWorkflowTimeout(this.plan.timeoutSeconds);
    }

    // Start per-task timeout monitoring
    this._startTaskTimeoutMonitoring();

    // Start retry queue processing
    this._startRetryQueueProcessing();

    // Start WAIT condition polling
    this._startWaitConditionPolling();

    // Initialize WAIT task states
    for (const task of this.plan.tasks) {
      const ts = this.taskStatus[task.name];
      if (ts && task.taskType === TASK_TYPES.WAIT && task.waitCondition) {
        ts.status = TASK_STATES.WAITING;
        ts.startedAt = Date.now();
      }
    }
    this.emit("statusChanged", this.taskStatus);
  }

  /**
   * Stop all execution — clear all timers.
   */
  stop() {
    this._stopped = true;
    this._clearAllTimers();
    this._closeAllWatchers();
    this.retryQueue = [];
  }

  // ---- Task Status Accessors ----

  /**
   * Get the full task status map.
   * @returns {Object} taskName -> status object
   */
  getTaskStatus() {
    return this.taskStatus;
  }

  /**
   * Get status for a single task.
   * @param {string} taskName
   * @returns {Object|null}
   */
  getTask(taskName) {
    return this.taskStatus[taskName] || null;
  }

  /**
   * Get retry queue length.
   * @returns {number}
   */
  getRetryQueueLength() {
    return this.retryQueue.length;
  }

  // ---- Task State Transitions ----

  /**
   * Mark a task as scheduled (session started).
   * Called when the controller issues a --start command for a task.
   * @param {string} taskName
   */
  scheduleTask(taskName) {
    const ts = this.taskStatus[taskName];
    if (!ts) return;
    if (ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.SCHEDULED) {
      ts.status = TASK_STATES.SCHEDULED;
      this.emit("statusChanged", this.taskStatus);
    }
  }

  /**
   * Mark a task as started (in progress).
   * Called when the controller sends a command/prompt to a task's session.
   * @param {string} taskName
   */
  startTask(taskName) {
    const ts = this.taskStatus[taskName];
    if (!ts) return;
    if (ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.SCHEDULED) {
      ts.status = TASK_STATES.IN_PROGRESS;
      ts.attempts = Math.max(ts.attempts, 1);
      if (!ts.startedAt) ts.startedAt = Date.now();
      this.emit("taskStarted", taskName, ts);
      this.emit("statusChanged", this.taskStatus);
    }
  }

  /**
   * Mark a task as completed.
   * @param {string} taskName
   * @param {Object} [validation] - Optional guardrail validation result
   */
  completeTask(taskName, validation) {
    const ts = this.taskStatus[taskName];
    if (!ts) return;
    ts.status = TASK_STATES.COMPLETED;
    ts.completedAt = Date.now();
    if (validation) ts.validation = validation;
    this.emit("taskCompleted", taskName, ts);
    this.emit("statusChanged", this.taskStatus);
  }

  /**
   * Mark a task as failed — handles retry logic.
   * If the task can be retried, schedules a retry instead of final failure.
   * @param {string} taskName
   * @param {string} error - Error description
   * @returns {{ retrying: boolean }} Whether a retry was scheduled
   */
  failTask(taskName, error) {
    const ts = this.taskStatus[taskName];
    if (!ts) return { retrying: false };

    if (canRetryTask(ts)) {
      // Schedule retry
      ts.status = TASK_STATES.RETRYING;
      ts.error = error;
      const delay = calculateRetryDelay(ts.retryLogic, ts.retryDelaySeconds, ts.attempts);
      this.retryQueue.push({ taskName, retryAt: Date.now() + delay });

      this.emit("retryScheduled", taskName, delay, ts);
      this.emit("statusChanged", this.taskStatus);
      return { retrying: true };
    }

    // No more retries
    if (ts.optional) {
      ts.status = TASK_STATES.COMPLETED_WITH_ERRORS;
      ts.error = error + " (optional task)";
    } else {
      ts.status = TASK_STATES.FAILED;
      ts.error = error;
    }
    ts.completedAt = Date.now();

    this.emit("taskFailed", taskName, error, ts);
    this.emit("statusChanged", this.taskStatus);
    return { retrying: false };
  }

  /**
   * Set validation result on a task (from guardrails).
   * @param {string} taskName
   * @param {Object} validation
   */
  setValidation(taskName, validation) {
    const ts = this.taskStatus[taskName];
    if (ts) ts.validation = validation;
  }

  /**
   * Ensure a task status entry exists (creates one if missing).
   * Used by guardrails when a task without expectedOutput needs marking.
   * @param {string} taskName
   * @returns {Object} the task status entry
   */
  ensureTaskStatus(taskName) {
    if (!this.taskStatus[taskName]) {
      const task = this.plan.tasks.find(t => t.name === taskName);
      if (task) {
        this.taskStatus[taskName] = createTaskStatus(task);
      }
    }
    return this.taskStatus[taskName];
  }

  /**
   * Reset a task for retry (called when retry fires).
   * @param {string} taskName
   */
  resetTaskForRetry(taskName) {
    const ts = this.taskStatus[taskName];
    if (!ts) return;
    ts.status = TASK_STATES.SCHEDULED;
    ts.startedAt = null;
    ts.error = null;
    this.emit("statusChanged", this.taskStatus);
  }

  /**
   * Mark a task as in-progress for retry (after worker restart).
   * @param {string} taskName
   */
  markRetryInProgress(taskName) {
    const ts = this.taskStatus[taskName];
    if (!ts) return;
    ts.status = TASK_STATES.IN_PROGRESS;
    ts.attempts++;
    ts.startedAt = Date.now();
    this.emit("taskStarted", taskName, ts);
    this.emit("statusChanged", this.taskStatus);
  }

  /**
   * Mark a task as failed due to retry restart error.
   * @param {string} taskName
   * @param {string} error
   */
  markRetryFailed(taskName, error) {
    const ts = this.taskStatus[taskName];
    if (!ts) return;
    ts.status = TASK_STATES.FAILED;
    ts.completedAt = Date.now();
    ts.error = error;
    this.emit("taskFailed", taskName, error, ts);
    this.emit("statusChanged", this.taskStatus);
  }

  // ---- Workflow Summary ----

  /**
   * Compute workflow summary.
   * @param {number|null} workflowStartedAt - Timestamp when workflow started
   * @returns {Object} summary with counts and duration
   */
  getSummary(workflowStartedAt) {
    const counts = {
      completed: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      completed_with_errors: 0,
      retried: 0,
    };

    for (const [, ts] of Object.entries(this.taskStatus)) {
      if (counts[ts.status] !== undefined) counts[ts.status]++;
      if (ts.attempts > 1) counts.retried++;
    }

    const totalTasks = Object.keys(this.taskStatus).length;
    const elapsed = workflowStartedAt
      ? Math.round((Date.now() - workflowStartedAt) / 1000)
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

    return {
      totalTasks,
      counts,
      elapsed,
      summaryText: summary,
    };
  }

  /**
   * Get list of critically failed (non-optional) tasks.
   * @returns {string[]} array of task names
   */
  getCriticalFailures() {
    return Object.entries(this.taskStatus)
      .filter(([, ts]) =>
        (ts.status === TASK_STATES.FAILED || ts.status === TASK_STATES.TIMED_OUT) && !ts.optional
      )
      .map(([name]) => name);
  }

  /**
   * Get failure summary for failed tasks (used by failure workflow).
   * @param {string[]} failedTasks - array of task names
   * @returns {string} formatted summary
   */
  getFailureSummary(failedTasks) {
    return failedTasks.map(name => {
      const ts = this.taskStatus[name];
      return `- ${name}: ${ts.status} (${ts.error || "unknown error"}, attempts: ${ts.attempts}/${ts.maxAttempts})`;
    }).join("\n");
  }

  // ---- File Change Tracking ----

  /** Directories to ignore when tracking file changes */
  static IGNORED_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '.cache',
    '__pycache__', '.tsbuildinfo', 'coverage', '.nyc_output',
  ]);

  static MAX_FILE_CHANGES = 500;
  static MAX_WATCHERS = 50;
  static DEBOUNCE_MS = 200;

  /**
   * Start watching a task's working directory for file changes.
   * @param {string} taskName - Name of the task/agent
   * @param {string} workDir - Absolute path to the directory to watch
   */
  watchTask(taskName, workDir) {
    // Don't exceed watcher cap
    if (this._watchers.size >= ConductorExecutor.MAX_WATCHERS) {
      this.emit("log", `[FILE WATCH] Max watchers (${ConductorExecutor.MAX_WATCHERS}) reached — skipping "${taskName}"`);
      return;
    }

    // Don't double-watch
    if (this._watchers.has(taskName)) return;

    try {
      if (!fs.existsSync(workDir)) {
        this.emit("log", `[FILE WATCH] Directory not found for "${taskName}": ${workDir} — skipping`);
        return;
      }

      const watcher = fs.watch(workDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Filter out noisy directories
        const parts = filename.split(path.sep);
        for (const part of parts) {
          if (ConductorExecutor.IGNORED_DIRS.has(part)) return;
        }

        // Also ignore common noisy file patterns
        if (filename.endsWith('.swp') || filename.endsWith('.swo') || filename.endsWith('~')) return;

        // Debounce: collect changes over DEBOUNCE_MS then emit batch
        let debounce = this._debounceTimers.get(taskName);
        if (!debounce) {
          debounce = { timer: null, pending: [] };
          this._debounceTimers.set(taskName, debounce);
        }

        debounce.pending.push(filename);

        if (debounce.timer) clearTimeout(debounce.timer);
        debounce.timer = setTimeout(() => {
          const filenames = [...new Set(debounce.pending)]; // deduplicate
          debounce.pending = [];

          for (const fname of filenames) {
            const changeRecord = {
              path: fname,
              type: 'modified',
              agent: taskName,
              timestamp: Date.now(),
            };

            this._fileChanges.push(changeRecord);
            // Cap at MAX_FILE_CHANGES
            while (this._fileChanges.length > ConductorExecutor.MAX_FILE_CHANGES) {
              this._fileChanges.shift();
            }

            this.emit("fileChange", changeRecord);
          }
        }, ConductorExecutor.DEBOUNCE_MS);
      });

      watcher.on("error", (err) => {
        this.emit("log", `[FILE WATCH] Error watching "${taskName}": ${err.message}`);
        this.unwatchTask(taskName);
      });

      this._watchers.set(taskName, watcher);
    } catch (err) {
      // ENOENT or other filesystem errors — skip gracefully
      if (err.code !== 'ENOENT') {
        this.emit("log", `[FILE WATCH] Failed to watch "${taskName}": ${err.message}`);
      }
    }
  }

  /**
   * Stop watching a task's directory.
   * @param {string} taskName
   */
  unwatchTask(taskName) {
    const watcher = this._watchers.get(taskName);
    if (watcher) {
      try { watcher.close(); } catch (_) {}
      this._watchers.delete(taskName);
    }

    const debounce = this._debounceTimers.get(taskName);
    if (debounce) {
      if (debounce.timer) clearTimeout(debounce.timer);
      this._debounceTimers.delete(taskName);
    }
  }

  /**
   * Get a copy of all recorded file changes.
   * @returns {Array} copy of file change records
   */
  getFileChanges() {
    return this._fileChanges.slice();
  }

  /**
   * Close all file watchers (called from stop()).
   * @private
   */
  _closeAllWatchers() {
    for (const taskName of [...this._watchers.keys()]) {
      this.unwatchTask(taskName);
    }
  }

  // ---- Internal: Timeout Monitoring ----

  _startTaskTimeoutMonitoring() {
    if (this._timers.taskTimeout) return;
    this._timers.taskTimeout = setInterval(() => {
      if (this._stopped) return;

      for (const task of this.plan.tasks) {
        const ts = this.taskStatus[task.name];
        if (!ts) continue;

        if (isTaskTimedOut(ts)) {
          const elapsed = Math.round((Date.now() - ts.startedAt) / 1000);
          this.emit("taskTimedOut", task.name, ts);
          this.emit("log", `[TIMEOUT] Task "${task.name}" exceeded ${ts.timeoutSeconds}s limit (ran for ${elapsed}s)`);

          if (canRetryTask(ts)) {
            ts.status = TASK_STATES.RETRYING;
            ts.error = `Timed out after ${elapsed}s`;
            const delay = calculateRetryDelay(ts.retryLogic, ts.retryDelaySeconds, ts.attempts);
            this.retryQueue.push({ taskName: task.name, retryAt: Date.now() + delay });
            this.emit("retryScheduled", task.name, delay, ts);
            this.emit("log", `[RETRY] Scheduling retry for "${task.name}" (attempt ${ts.attempts + 1}/${ts.maxAttempts}) in ${Math.round(delay / 1000)}s`);
          } else {
            if (ts.optional) {
              ts.status = TASK_STATES.COMPLETED_WITH_ERRORS;
              ts.error = `Timed out after ${elapsed}s (optional task, continuing)`;
              this.emit("log", `[OPTIONAL] Task "${task.name}" timed out but is optional — continuing workflow`);
            } else {
              ts.status = TASK_STATES.TIMED_OUT;
              ts.error = `Timed out after ${elapsed}s (no retries remaining)`;
            }
            ts.completedAt = Date.now();
          }
          this.emit("statusChanged", this.taskStatus);
        }
      }
    }, 5000); // Check every 5 seconds
  }

  // ---- Internal: Workflow Timeout ----

  _startWorkflowTimeout(timeoutSeconds) {
    if (!timeoutSeconds || timeoutSeconds <= 0) return;
    if (this._timers.workflowTimeout) clearTimeout(this._timers.workflowTimeout);

    this._timers.workflowTimeout = setTimeout(() => {
      this.emit("log", `[WORKFLOW TIMEOUT] Workflow exceeded ${timeoutSeconds}s limit — terminating all tasks`);

      // Mark all in-progress tasks as timed out
      for (const [, ts] of Object.entries(this.taskStatus)) {
        if (ts.status === TASK_STATES.IN_PROGRESS || ts.status === TASK_STATES.WAITING || ts.status === TASK_STATES.RETRYING) {
          ts.status = TASK_STATES.TIMED_OUT;
          ts.completedAt = Date.now();
          ts.error = "Workflow timeout exceeded";
        } else if (ts.status === TASK_STATES.PENDING || ts.status === TASK_STATES.SCHEDULED) {
          ts.status = TASK_STATES.CANCELLED;
          ts.error = "Cancelled due to workflow timeout";
        }
      }
      this.emit("statusChanged", this.taskStatus);
      this.emit("workflowTimeout");
    }, timeoutSeconds * 1000);

    this.emit("log", `[WORKFLOW] Timeout set: ${timeoutSeconds}s (${Math.round(timeoutSeconds / 60)}min)`);
  }

  // ---- Internal: Retry Queue Processing ----

  _startRetryQueueProcessing() {
    if (this._timers.retryQueue) return;
    this._timers.retryQueue = setInterval(() => {
      if (this._stopped || this.retryQueue.length === 0) return;

      const now = Date.now();
      const ready = this.retryQueue.filter(r => now >= r.retryAt);
      this.retryQueue = this.retryQueue.filter(r => now < r.retryAt);

      for (const item of ready) {
        const ts = this.taskStatus[item.taskName];
        if (!ts || ts.status !== TASK_STATES.RETRYING) continue;

        const task = this.plan.tasks.find(t => t.name === item.taskName);
        if (!task) continue;

        this.emit("log", `[RETRY] Restarting task "${item.taskName}" (attempt ${ts.attempts + 1}/${ts.maxAttempts})`);

        // Reset task state for retry
        ts.status = TASK_STATES.SCHEDULED;
        ts.startedAt = null;
        ts.error = null;
        this.emit("statusChanged", this.taskStatus);

        // Emit event for server.cjs to restart the worker
        this.emit("retryReady", item.taskName, task, ts);
      }
    }, 3000);
  }

  // ---- Internal: Wait Condition Polling ----

  _startWaitConditionPolling() {
    if (this._timers.waitCondition) return;
    this._timers.waitCondition = setInterval(() => {
      if (this._stopped) return;

      for (const task of this.plan.tasks) {
        const ts = this.taskStatus[task.name];
        if (!ts || ts.status !== TASK_STATES.WAITING) continue;
        if (!ts.waitCondition) continue;

        let conditionMet = false;
        const projectDir = this._findProjectDir() || __dirname;

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
          this.emit("log", `[WAIT] Condition met for "${task.name}" (${ts.waitCondition.type}: ${ts.waitCondition.target})`);
          ts.status = TASK_STATES.SCHEDULED;
          this.emit("waitConditionMet", task.name, ts);
          this.emit("statusChanged", this.taskStatus);
        } else {
          // Check WAIT timeout
          const waitTimeout = (ts.waitCondition.timeoutSeconds || DEFAULT_WAIT_TIMEOUT) * 1000;
          if (ts.startedAt && (Date.now() - ts.startedAt) > waitTimeout) {
            this.emit("log", `[WAIT TIMEOUT] Task "${task.name}" wait condition not met within ${ts.waitCondition.timeoutSeconds || DEFAULT_WAIT_TIMEOUT}s`);
            if (ts.optional) {
              ts.status = TASK_STATES.COMPLETED_WITH_ERRORS;
              ts.error = "Wait condition timed out (optional task)";
            } else {
              ts.status = TASK_STATES.TIMED_OUT;
              ts.error = "Wait condition timed out";
            }
            ts.completedAt = Date.now();
            this.emit("waitConditionTimedOut", task.name, ts);
            this.emit("statusChanged", this.taskStatus);
          }
        }
      }
    }, DEFAULT_WAIT_POLL_INTERVAL * 1000);
  }

  // ---- Internal: Timer Cleanup ----

  _clearAllTimers() {
    if (this._timers.taskTimeout) {
      clearInterval(this._timers.taskTimeout);
      this._timers.taskTimeout = null;
    }
    if (this._timers.workflowTimeout) {
      clearTimeout(this._timers.workflowTimeout);
      this._timers.workflowTimeout = null;
    }
    if (this._timers.waitCondition) {
      clearInterval(this._timers.waitCondition);
      this._timers.waitCondition = null;
    }
    if (this._timers.retryQueue) {
      clearInterval(this._timers.retryQueue);
      this._timers.retryQueue = null;
    }
  }
}

module.exports = { ConductorExecutor };
