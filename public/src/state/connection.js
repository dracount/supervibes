import { setState, getState } from './store.js';

let ws = null;
let reconnectTimer = null;

// Line parsing (ported from old dashboard)
const cmdRegex = /--cmd\s+(\S+)\s+"([^"]*)"/;
const cmdRegexSingle = /--cmd\s+(\S+)\s+'([^']*)'/;
const startRegex = /--start\s+(\S+)\s+(\S+)/;
const readRegex = /--read\s+(\S+)/;
const stopAllRegex = /--stop-all/;
const stopRegex = /--stop\s+(\S+)/;

function extractPrompt(line) {
  let m = cmdRegex.exec(line);
  if (!m) m = cmdRegexSingle.exec(line);
  if (m && m[2] !== '') return { name: m[1], text: m[2] };
  return null;
}

function isNoiseLine(line) {
  const t = line.trim();
  if (t.length < 15) return true;
  if (/^[-=~_#*]{4,}$/.test(t)) return true;
  if (/^\s*[\[{]/.test(t) && /[\]}]\s*$/.test(t)) return true;
  if (/^\[tool:\s/.test(t)) return true;
  if (/^(node|tmux|send-keys|capture-pane|kill-session)/.test(t)) return true;
  if (/^tmux-control\.cjs/.test(t)) return true;
  return false;
}

function parseLine(line) {
  if (line.includes('Mandatory Review Round starting'))
    return { type: 'review', icon: '*', msg: 'Mandatory Review Round starting' };
  if (line.includes('Review Round complete'))
    return { type: 'review', icon: '*', msg: line.trim() };
  if (line.includes('[Post-check]'))
    return { type: 'postcheck', icon: '?', msg: line.replace('[Post-check] ', '').trim() };
  if (line.includes('post-build checks'))
    return { type: 'postcheck', icon: '?', msg: line.trim() };

  let m = startRegex.exec(line);
  if (m) return { type: 'start', icon: '+', msg: 'Started terminal', detail: m[1], dir: m[2] };

  const p = extractPrompt(line);
  if (p) return { type: 'prompt', icon: '>', msg: 'Prompt to ' + p.name, detail: p.text, agent: p.name };

  m = readRegex.exec(line);
  if (m && !startRegex.test(line))
    return { type: 'read', icon: '~', msg: 'Reading output from ' + m[1], agent: m[1] };

  if (stopAllRegex.test(line))
    return { type: 'stop', icon: 'x', msg: 'Stopping all terminals' };

  m = stopRegex.exec(line);
  if (m && !stopAllRegex.test(line))
    return { type: 'stop', icon: 'x', msg: 'Stopped terminal ' + m[1], agent: m[1] };

  if (line.includes('[Controller exited'))
    return { type: 'exit', icon: '!', msg: line.trim() };

  if (isNoiseLine(line)) return null;

  if (/VERIFICATION COMPLETE|QA REPORT|REVIEW COMPLETE|ALL CHECKS PASS/i.test(line))
    return { type: 'verify', icon: '\u2713', msg: line.trim() };

  if (/^\s*\d+[\.\)]\s+\S/.test(line) || /\b(break|split|decompos|divid)\w*\s+(the\s+)?work\s+into\b/i.test(line))
    return { type: 'plan', icon: '\u25b8', msg: line.trim() };

  if (/\bYou own\b/i.test(line))
    return { type: 'ownership', icon: '\u25cb', msg: line.trim() };

  return { type: 'think', icon: '\u25c6', msg: line.trim() };
}

let lastThinkTime = 0;

function processControllerLine(line) {
  const s = getState();
  const lines = [...s.controllerLines, line];
  if (lines.length > 500) lines.shift();

  const entry = parseLine(line);
  if (!entry) {
    setState({ controllerLines: lines });
    return;
  }

  entry.time = new Date();
  const entries = [...s.logEntries];
  const now = Date.now();

  if (entry.type === 'think' && entries.length > 0) {
    const last = entries[entries.length - 1];
    if (last.type === 'think' && (now - lastThinkTime) < 500) {
      entries[entries.length - 1] = { ...last, msg: last.msg + '\n' + entry.msg };
      lastThinkTime = now;
      setState({ controllerLines: lines, logEntries: entries });
      return;
    }
  }

  if (entry.type === 'think') lastThinkTime = now;
  entries.push(entry);
  if (entries.length > 1200) entries.splice(0, entries.length - 1000);
  setState({ controllerLines: lines, logEntries: entries });

  const sm = startRegex.exec(line);
  if (sm && !s.sessions.includes(sm[1])) {
    setState({ sessions: [...s.sessions, sm[1]] });
  }
}

// --- Event handlers (same logic as SSE handlers) ---

const eventHandlers = {
  init(d) {
    const entries = [];
    lastThinkTime = 0;
    for (const line of (d.controllerOutput || [])) {
      const entry = parseLine(line);
      if (entry) {
        entry.time = new Date();
        entries.push(entry);
      }
    }
    setState({
      running: d.running,
      phase: d.phase || 'idle',
      goal: d.goal || '',
      model: d.model || 'sonnet',
      terminalCount: d.terminalCount || 'auto',
      iterations: d.iterations || 0,
      currentIteration: d.currentIteration || 0,
      sessions: d.sessions || [],
      controllerLines: d.controllerOutput || [],
      logEntries: entries,
      taskPlan: d.taskPlan || null,
      taskStatus: d.taskStatus || {},
      postChecks: d.postChecks || null,
      guardrailResults: d.guardrailResults || null,
      workflowStartedAt: d.workflowStartedAt || null,
      agentStates: d.agentStates || {},
      agentConversations: d.agentConversations || {},
      contextWarnings: d.contextWarnings || {},
      fileChanges: d.fileChanges || [],
      workflowSummary: d.workflowSummary || null,
      maxConcurrentAgents: d.maxConcurrentAgents || null,
      activeAgentCount: d.activeAgentCount || 0,
      queuedTasks: d.queuedTasks || [],
    });
  },

  controller(d) {
    processControllerLine(d.line);
  },

  terminals(d) {
    setState({ sessions: d.sessions || [] });
  },

  status(d) {
    const prev = getState();
    const update = { running: d.running, phase: d.phase };
    if (d.currentIteration !== undefined) update.currentIteration = d.currentIteration;
    if (d.iterations !== undefined) update.iterations = d.iterations;
    if (d.postChecks) update.postChecks = d.postChecks;
    if (d.workflowStartedAt) update.workflowStartedAt = d.workflowStartedAt;
    if (d.running && !prev.running) {
      update.agentStates = {};
      update.agentConversations = {};
      update.contextWarnings = {};
      update.postChecks = null;
      update.guardrailResults = null;
      update.taskStatus = {};
      update.logEntries = [];
      update.controllerLines = [];
      update.fileChanges = [];
      update.workflowSummary = null;
    }
    if (!d.running) { update.sessions = []; update.workflowStartedAt = null; }
    setState(update);
  },

  plan(d) {
    setState({ taskPlan: d.plan });
  },

  taskStatus(d) {
    const update = { taskStatus: d.taskStatus };
    if (d.maxConcurrentAgents !== undefined) update.maxConcurrentAgents = d.maxConcurrentAgents;
    if (d.activeAgentCount !== undefined) update.activeAgentCount = d.activeAgentCount;
    if (d.queuedTasks !== undefined) update.queuedTasks = d.queuedTasks;
    setState(update);
  },

  agentState(d) {
    const agentStates = { ...getState().agentStates };
    agentStates[d.name] = { state: d.state, tokens: d.tokens };
    setState({ agentStates });
  },

  agentConversation(d) {
    const convos = { ...getState().agentConversations };
    const list = convos[d.agent] ? [...convos[d.agent]] : [];
    list.push({ type: d.type, content: d.content, toolName: d.toolName, toolId: d.toolId, input: d.input, timestamp: d.timestamp });
    if (list.length > 200) list.splice(0, list.length - 200);
    convos[d.agent] = list;
    setState({ agentConversations: convos });
  },

  contextWarning(d) {
    const warnings = { ...getState().contextWarnings, [d.agent]: d };
    setState({ contextWarnings: warnings });
  },

  fileChange(d) {
    const changes = [...getState().fileChanges, d];
    if (changes.length > 500) changes.splice(0, changes.length - 500);
    setState({ fileChanges: changes });
  },

  workflowSummary(d) {
    setState({ workflowSummary: d });
  },

  guardrails(d) {
    setState({ guardrailResults: d.results });
  },

  postChecks(d) {
    setState({ postChecks: d.checks });
  },

  intervention(d) {
    const entries = [...getState().logEntries];
    entries.push({
      type: 'intervention',
      icon: '\u26a1',
      msg: `[${d.action}] ${d.agent}: ${d.detail || ''}`,
      time: new Date(d.timestamp),
      agent: d.agent,
    });
    setState({ logEntries: entries });
  },

  humanGate(d) {
    const entries = [...getState().logEntries];
    entries.push({
      type: 'human',
      icon: '@',
      msg: `Human input needed for ${d.agent}: ${d.question}`,
      time: new Date(),
      agent: d.agent,
    });
    setState({ logEntries: entries });
  },
};

// --- WebSocket connection ---

export function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (ws) { try { ws.close(); } catch (_) {} }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    setState({ sseConnected: true });
  };

  ws.onmessage = (evt) => {
    try {
      const { event, data } = JSON.parse(evt.data);
      const handler = eventHandlers[event];
      if (handler) handler(data);
    } catch (_) {
      // Ignore malformed messages
    }
  };

  ws.onclose = () => {
    setState({ sseConnected: false });
    ws = null;
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    // onclose will fire after onerror, which handles reconnection
  };
}

export function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
}

/**
 * Send a command to the server via WebSocket.
 * Falls back to REST if WebSocket is not connected.
 */
export function sendCommand(action, agent, extra = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action, agent, ...extra }));
    return true;
  }
  return false;
}
