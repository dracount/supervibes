// Minimal pub/sub store — no dependencies
// Components call store.subscribe(listener), get notified on changes

const state = {
  // Connection
  running: false,
  phase: 'idle', // idle, planning, build, iteration, review, postcheck
  goal: '',
  model: 'sonnet',
  terminalCount: 'auto',
  iterations: 0,
  currentIteration: 0,
  structured: true,

  // Agents
  sessions: [],
  agentStates: {},      // name -> { state, tokens }
  // Plan & Tasks
  taskPlan: null,
  taskStatus: {},

  // Activity
  logEntries: [],
  controllerLines: [],

  // Telemetry
  workflowStartedAt: null,
  postChecks: null,
  guardrailResults: null,

  // Connection status
  sseConnected: false,

  // Agent conversations — name → [{type, content, timestamp, ...}]
  agentConversations: {},

  // Context warnings
  contextWarnings: {},  // name → { totalContext, limit }

  // File changes
  fileChanges: [],  // [{path, type, agent, task, timestamp}]

  // Workflow summary
  workflowSummary: null,
  showWorkflowSummaryRequested: false,

  // History
  showHistory: false,
  historyRuns: [],
  historySelectedRun: null,

  // UI
  selectedAgent: null,
  feedFilter: 'all', // all, errors, agent:<name>
  showCommandPalette: false,
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(partial) {
  Object.assign(state, partial);
  listeners.forEach(fn => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Shallow equality for objects/arrays
function shallowEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// Hook for Preact components
import { useState, useEffect } from '../lib/preact-hooks.module.js';

export function useStore(selector) {
  const [val, setVal] = useState(() => selector(getState()));
  useEffect(() => {
    return subscribe((s) => {
      const next = selector(s);
      setVal(prev => shallowEqual(prev, next) ? prev : next);
    });
  }, []);
  return val;
}

// Convenience: force all components to re-render
export function forceUpdate() {
  listeners.forEach(fn => fn(state));
}
