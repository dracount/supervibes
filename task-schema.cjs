#!/usr/bin/env node
"use strict";

/**
 * Structured task and plan schemas for the multi-claude orchestrator.
 * Provides validation, worker prompt building, and execution order computation.
 * Enhanced with Conductor-inspired retry, timeout, and state management.
 */

// --- Constants (Conductor-inspired) ---

const TASK_STATES = {
  PENDING: "pending",
  SCHEDULED: "scheduled",
  WAITING: "waiting",       // waiting for a WAIT condition
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  RETRYING: "retrying",
  CANCELLED: "cancelled",
  COMPLETED_WITH_ERRORS: "completed_with_errors", // optional task that failed
};

const RETRY_LOGIC = {
  FIXED: "FIXED",
  EXPONENTIAL_BACKOFF: "EXPONENTIAL_BACKOFF",
};

const TASK_TYPES = {
  SIMPLE: "SIMPLE",
  WAIT: "WAIT",
};

const WAIT_CONDITION_TYPES = {
  FILE_EXISTS: "file_exists",
  HTTP_READY: "http_ready",
};

// Defaults
const DEFAULT_RETRY_COUNT = 0;
const DEFAULT_RETRY_DELAY_SECONDS = 30;
const DEFAULT_TIMEOUT_SECONDS = 0; // 0 = no timeout
const DEFAULT_WAIT_POLL_INTERVAL = 5;
const DEFAULT_WAIT_TIMEOUT = 120;

/**
 * Validate a single TaskDefinition object.
 * @param {Object} task
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTask(task) {
  const errors = [];
  if (!task.name || typeof task.name !== "string") errors.push("task.name is required");
  if (!task.description || typeof task.description !== "string") errors.push("task.description is required");
  if (task.ownedFiles && !Array.isArray(task.ownedFiles)) errors.push("task.ownedFiles must be an array");
  if (task.dependencies && !Array.isArray(task.dependencies)) errors.push("task.dependencies must be an array");
  if (task.expectedOutput) {
    if (task.expectedOutput.files && !Array.isArray(task.expectedOutput.files))
      errors.push("expectedOutput.files must be an array");
    if (task.expectedOutput.exports && !Array.isArray(task.expectedOutput.exports))
      errors.push("expectedOutput.exports must be an array");
    if (task.expectedOutput.patterns && !Array.isArray(task.expectedOutput.patterns))
      errors.push("expectedOutput.patterns must be an array");
  }

  // Validate Conductor-inspired fields
  if (task.taskType && !Object.values(TASK_TYPES).includes(task.taskType)) {
    errors.push(`task.taskType must be one of: ${Object.values(TASK_TYPES).join(", ")}`);
  }
  if (task.retryCount !== undefined) {
    if (typeof task.retryCount !== "number" || task.retryCount < 0 || task.retryCount > 10) {
      errors.push("task.retryCount must be a number between 0 and 10");
    }
  }
  if (task.retryLogic && !Object.values(RETRY_LOGIC).includes(task.retryLogic)) {
    errors.push(`task.retryLogic must be one of: ${Object.values(RETRY_LOGIC).join(", ")}`);
  }
  if (task.retryDelaySeconds !== undefined && (typeof task.retryDelaySeconds !== "number" || task.retryDelaySeconds < 0)) {
    errors.push("task.retryDelaySeconds must be a non-negative number");
  }
  if (task.timeoutSeconds !== undefined && (typeof task.timeoutSeconds !== "number" || task.timeoutSeconds < 0)) {
    errors.push("task.timeoutSeconds must be a non-negative number");
  }
  if (task.optional !== undefined && typeof task.optional !== "boolean") {
    errors.push("task.optional must be a boolean");
  }

  // Validate WAIT conditions
  if (task.taskType === TASK_TYPES.WAIT || task.waitCondition) {
    if (!task.waitCondition) {
      errors.push("WAIT tasks must have a waitCondition");
    } else {
      if (!Object.values(WAIT_CONDITION_TYPES).includes(task.waitCondition.type)) {
        errors.push(`waitCondition.type must be one of: ${Object.values(WAIT_CONDITION_TYPES).join(", ")}`);
      }
      if (!task.waitCondition.target || typeof task.waitCondition.target !== "string") {
        errors.push("waitCondition.target is required (file path or URL)");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an entire TaskPlan object.
 * @param {Object} plan
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePlan(plan) {
  const errors = [];
  if (!plan.goal) errors.push("plan.goal is required");
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    errors.push("plan.tasks must be a non-empty array");
    return { valid: false, errors };
  }

  // Validate workflow-level timeout
  if (plan.timeoutSeconds !== undefined) {
    if (typeof plan.timeoutSeconds !== "number" || plan.timeoutSeconds < 0) {
      errors.push("plan.timeoutSeconds must be a non-negative number");
    }
  }

  {
    const names = new Set();
    for (const task of plan.tasks) {
      const r = validateTask(task);
      errors.push(...r.errors.map(e => `${task.name || "unknown"}: ${e}`));
      if (task.name) {
        if (names.has(task.name)) errors.push(`Duplicate task name: ${task.name}`);
        names.add(task.name);
      }
    }
    // Validate dependency references
    for (const task of plan.tasks) {
      if (task.dependencies) {
        for (const dep of task.dependencies) {
          if (!names.has(dep)) errors.push(`${task.name}: dependency "${dep}" not found in plan`);
        }
      }
    }

    // Check for circular dependencies
    const visited = new Set();
    const recStack = new Set();
    function hasCycle(taskName) {
      if (recStack.has(taskName)) return true;
      if (visited.has(taskName)) return false;
      visited.add(taskName);
      recStack.add(taskName);
      const task = plan.tasks.find(t => t.name === taskName);
      if (task && task.dependencies) {
        for (const dep of task.dependencies) {
          if (hasCycle(dep)) return true;
        }
      }
      recStack.delete(taskName);
      return false;
    }
    for (const task of plan.tasks) {
      if (hasCycle(task.name)) {
        errors.push(`Circular dependency detected involving task: ${task.name}`);
        break;
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Compute execution phases from dependency graph (topological sort).
 * Returns array of phases, each phase is an array of task names that can run in parallel.
 * @param {Object[]} tasks
 * @returns {string[][]}
 */
function computeExecutionPhases(tasks) {
  const phases = [];
  const done = new Set();
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const phase = remaining.filter(t =>
      (t.dependencies || []).every(d => done.has(d))
    );
    if (phase.length === 0) {
      // Circular dependency — dump remaining into one phase
      phases.push(remaining.map(t => t.name));
      break;
    }
    phases.push(phase.map(t => t.name));
    for (const t of phase) {
      done.add(t.name);
    }
    remaining = remaining.filter(t => !done.has(t.name));
  }

  return phases;
}

/**
 * Format execution phases as human-readable text for prompts.
 * @param {Object[]} tasks
 * @returns {string}
 */
function formatExecutionOrder(tasks) {
  const phases = computeExecutionPhases(tasks);
  return phases.map((p, i) =>
    `Phase ${i + 1}: ${p.join(", ")} (start simultaneously)`
  ).join("\n");
}

/**
 * Build a worker prompt from a TaskDefinition + shared context.
 * Includes role/backstory, ownership, expected output, timeout, and memory context.
 * @param {Object} task
 * @param {string} sharedContext
 * @param {string} [memoryContext]
 * @returns {string}
 */
function buildWorkerPrompt(task, sharedContext, memoryContext) {
  let prompt = "";

  // Role/backstory
  if (task.role || task.backstory) {
    prompt += "## Your Role\n\n";
    if (task.role) prompt += `You are a ${task.role}.\n`;
    if (task.backstory) prompt += `${task.backstory}\n`;
    prompt += "\n";
  }

  // Task description
  prompt += `## Your Task\n\n${task.description}\n\n`;

  // File ownership
  if (task.ownedFiles && task.ownedFiles.length > 0) {
    prompt += `## File Ownership\n\nYou own: ${task.ownedFiles.join(", ")}. Do NOT create or edit files outside these paths.\n\n`;
  }

  // Expected output
  if (task.expectedOutput) {
    prompt += "## Expected Output\n\n";
    if (task.expectedOutput.files && task.expectedOutput.files.length > 0) {
      prompt += `Files to create: ${task.expectedOutput.files.join(", ")}\n`;
    }
    if (task.expectedOutput.exports && task.expectedOutput.exports.length > 0) {
      prompt += `Required exports: ${task.expectedOutput.exports.join(", ")}\n`;
    }
    prompt += "\n";
  }

  // Timeout awareness
  if (task.timeoutSeconds && task.timeoutSeconds > 0) {
    const mins = Math.round(task.timeoutSeconds / 60);
    prompt += `## Time Limit\n\nYou have approximately ${mins} minute${mins !== 1 ? "s" : ""} to complete this task. Focus on the essentials first, then polish if time allows.\n\n`;
  }

  // Shared context
  if (sharedContext) {
    prompt += `## Project Context\n\n${sharedContext}\n\n`;
  }

  // Memory from prior runs
  if (memoryContext) {
    prompt += `## Learnings from Previous Runs\n\n${memoryContext}\n\n`;
  }

  return prompt;
}

/**
 * Create an initial task status entry with Conductor-inspired tracking.
 * @param {Object} task - TaskDefinition
 * @returns {Object} task status object
 */
function createTaskStatus(task) {
  return {
    status: TASK_STATES.PENDING,
    validation: null,
    attempts: 0,
    maxAttempts: (task.retryCount || DEFAULT_RETRY_COUNT) + 1,
    startedAt: null,
    completedAt: null,
    timeoutSeconds: task.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
    optional: task.optional || false,
    taskType: task.taskType || TASK_TYPES.SIMPLE,
    retryLogic: task.retryLogic || RETRY_LOGIC.FIXED,
    retryDelaySeconds: task.retryDelaySeconds || DEFAULT_RETRY_DELAY_SECONDS,
    error: null,
    waitCondition: task.waitCondition || null,
  };
}

/**
 * Calculate retry delay based on retry logic.
 * @param {string} retryLogic - FIXED or EXPONENTIAL_BACKOFF
 * @param {number} baseDelay - base delay in seconds
 * @param {number} attemptNumber - current attempt (1-based)
 * @returns {number} delay in milliseconds
 */
function calculateRetryDelay(retryLogic, baseDelay, attemptNumber) {
  if (retryLogic === RETRY_LOGIC.EXPONENTIAL_BACKOFF) {
    return baseDelay * Math.pow(2, attemptNumber - 1) * 1000;
  }
  // FIXED
  return baseDelay * 1000;
}

/**
 * Check if a task has exceeded its timeout.
 * @param {Object} taskStatus
 * @returns {boolean}
 */
function isTaskTimedOut(taskStatus) {
  if (!taskStatus.timeoutSeconds || taskStatus.timeoutSeconds <= 0) return false;
  if (!taskStatus.startedAt) return false;
  if (taskStatus.status !== TASK_STATES.IN_PROGRESS) return false;
  const elapsed = (Date.now() - taskStatus.startedAt) / 1000;
  return elapsed > taskStatus.timeoutSeconds;
}

/**
 * Check if a task can be retried.
 * @param {Object} taskStatus
 * @returns {boolean}
 */
function canRetryTask(taskStatus) {
  return taskStatus.attempts < taskStatus.maxAttempts;
}

/**
 * Extract a JSON plan from stream-json output.
 * Looks for ```json ... ``` code blocks in the assembled text.
 * @param {string} rawOutput - raw stream-json output
 * @returns {Object|null}
 */
function extractPlanFromOutput(rawOutput) {
  const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n\s*```/;

  // Assemble text from stream-json messages
  let fullText = "";
  const lines = rawOutput.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "assistant" && msg.message && msg.message.content) {
        for (const block of msg.message.content) {
          if (block.type === "text") fullText += block.text;
        }
      }
      if (msg.type === "result" && msg.result) {
        fullText += typeof msg.result === "string" ? msg.result : (msg.result.text || "");
      }
    } catch (_) {}
  }

  // Try to extract JSON from assembled text
  const m = jsonBlockRegex.exec(fullText);
  if (m) {
    try { return JSON.parse(m[1]); } catch (_) {}
  }

  // Fallback: try direct parse of full text
  try { return JSON.parse(fullText.trim()); } catch (_) {}

  // Fallback: try the raw output itself
  const m2 = jsonBlockRegex.exec(rawOutput);
  if (m2) {
    try { return JSON.parse(m2[1]); } catch (_) {}
  }

  return null;
}

module.exports = {
  // Constants
  TASK_STATES,
  RETRY_LOGIC,
  TASK_TYPES,
  WAIT_CONDITION_TYPES,
  DEFAULT_RETRY_COUNT,
  DEFAULT_RETRY_DELAY_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_WAIT_POLL_INTERVAL,
  DEFAULT_WAIT_TIMEOUT,
  // Functions
  validateTask,
  validatePlan,
  computeExecutionPhases,
  formatExecutionOrder,
  buildWorkerPrompt,
  createTaskStatus,
  calculateRetryDelay,
  isTaskTimedOut,
  canRetryTask,
  extractPlanFromOutput,
};
