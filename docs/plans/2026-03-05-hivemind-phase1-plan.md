# HiveMind Phase 1 — "Mission Control" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the Multi-Claude dashboard from a log viewer into an interactive Mission Control interface with a dependency graph centerpiece, agent detail panels, live intervention, and a new visual design language.

**Architecture:** Preact + HTM via vendored ESM modules (zero build step). New `public/src/` directory with component modules. Server gets ~6 new intervention API endpoints. Existing `server.cjs` routing and `tmux-control.cjs` execution layer are preserved — only additive changes.

**Tech Stack:** Preact (4KB, vendored ESM), HTM (1KB, vendored ESM), SVG for graph rendering, CSS custom properties for theming, native ES modules for file organization.

**Design Doc:** `docs/plans/2026-03-05-hivemind-dashboard-design.md`

---

## Task 1: Scaffold File Structure + Vendor Preact/HTM

**Files:**
- Create: `public/src/app.js`
- Create: `public/src/lib/preact.module.js` (vendored)
- Create: `public/src/lib/htm.module.js` (vendored)
- Create: `public/src/lib/preact-hooks.module.js` (vendored)
- Create: `public/index-v2.html` (new entry point, old stays at `index.html`)
- Create: `public/src/styles/theme.css`

**Step 1: Create directory structure**

```bash
mkdir -p public/src/{components,graph,state,styles,lib}
```

**Step 2: Vendor Preact, HTM, and hooks from ESM CDN**

```bash
curl -o public/src/lib/preact.module.js "https://esm.sh/preact@10.25.4?bundle-deps&no-dts"
curl -o public/src/lib/preact-hooks.module.js "https://esm.sh/preact@10.25.4/hooks?bundle-deps&no-dts"
curl -o public/src/lib/htm.module.js "https://esm.sh/htm@3.1.1?bundle-deps&no-dts"
```

If CDN downloads fail or produce wrapper files, use the alternative approach: create minimal shim files that re-export from CDN at runtime:

```javascript
// public/src/lib/preact.module.js
export { h, render, Component, Fragment, createRef, toChildArray } from 'https://esm.sh/preact@10.25.4';
```

**Step 3: Create `public/src/styles/theme.css`**

The full HiveMind color system and base styles:

```css
:root {
  /* Background layers */
  --bg-void:     #0a0a12;
  --bg-surface:  #12121e;
  --bg-elevated: #1a1a2e;
  --bg-hover:    #222240;

  /* Agent state spectrum */
  --state-active:    #00ff88;
  --state-thinking:  #7c5cff;
  --state-tool-use:  #ff9f1c;
  --state-waiting:   #3a86ff;
  --state-completed: #06d6a0;
  --state-failed:    #ef476f;
  --state-retrying:  #ffd166;
  --state-idle:      #404060;
  --state-human:     #e040fb;

  /* Telemetry */
  --telem-cost:   #ff6b6b;
  --telem-tokens: #4ecdc4;
  --telem-time:   #ffe66d;

  /* Text */
  --text-primary:   #e8e8f0;
  --text-secondary: #8888a8;
  --text-muted:     #555570;

  /* Borders */
  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-active: rgba(255, 255, 255, 0.12);

  /* Sizing */
  --font-mono: "JetBrains Mono", "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --text-xs: 11px;
  --text-sm: 12px;
  --text-md: 13px;
  --text-lg: 14px;
  --text-xl: 18px;

  /* Transitions */
  --transition-fast: 150ms ease-out;
  --transition-normal: 300ms ease-out;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg-void);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--text-md);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border-active); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
```

**Step 4: Create `public/index-v2.html` entry point**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HiveMind</title>
  <link rel="stylesheet" href="/src/styles/theme.css">
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/app.js"></script>
</body>
</html>
```

**Step 5: Create `public/src/app.js` — minimal shell**

```javascript
import { h, render } from './lib/preact.module.js';
import { useState } from './lib/preact-hooks.module.js';
import htm from './lib/htm.module.js';

export const html = htm.bind(h);

function App() {
  return html`
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:var(--state-active);font-family:var(--font-mono);">
      HiveMind — Mission Control loading...
    </div>
  `;
}

render(h(App, null), document.getElementById('app'));
```

**Step 6: Verify it loads**

```bash
cd /home/david/multi_claude && node server.cjs &
sleep 1
curl -s http://localhost:3456/index-v2.html | head -10
# Expected: the HTML with <script type="module" src="/src/app.js">
kill %1
```

**Step 7: Commit**

```bash
git add public/src/ public/index-v2.html
git commit -m "feat: scaffold HiveMind Phase 1 — Preact+HTM, theme CSS, app shell"
```

---

## Task 2: State Store + SSE Connection

**Files:**
- Create: `public/src/state/store.js`
- Create: `public/src/state/sse.js`
- Create: `public/src/state/api.js`

**Step 1: Create `public/src/state/store.js` — simple reactive store using Preact signals pattern**

```javascript
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
  agentSessionIds: {},   // name -> sessionId

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

// Hook for Preact components
import { useState, useEffect } from '../lib/preact-hooks.module.js';

export function useStore(selector) {
  const [val, setVal] = useState(() => selector(getState()));
  useEffect(() => {
    return subscribe((s) => {
      const next = selector(s);
      setVal(prev => prev === next ? prev : next);
    });
  }, []);
  return val;
}

// Convenience: force all components to re-render
export function forceUpdate() {
  listeners.forEach(fn => fn(state));
}
```

**Step 2: Create `public/src/state/sse.js` — SSE connection manager**

```javascript
import { setState, getState } from './store.js';

let eventSource = null;

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

  // Merge consecutive think entries
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
  setState({ controllerLines: lines, logEntries: entries });

  // Track sessions from --start lines
  const sm = startRegex.exec(line);
  if (sm && !s.sessions.includes(sm[1])) {
    setState({ sessions: [...s.sessions, sm[1]] });
  }
}

export function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/stream');

  eventSource.addEventListener('init', (e) => {
    const d = JSON.parse(e.data);
    // Re-parse controller output into log entries
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
      workflowStartedAt: d.workflowStartedAt || null,
    });
  });

  eventSource.addEventListener('controller', (e) => {
    const d = JSON.parse(e.data);
    processControllerLine(d.line);
  });

  eventSource.addEventListener('terminals', (e) => {
    const d = JSON.parse(e.data);
    setState({ sessions: d.sessions || [] });
  });

  eventSource.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    const update = { running: d.running, phase: d.phase };
    if (d.currentIteration !== undefined) update.currentIteration = d.currentIteration;
    if (d.iterations !== undefined) update.iterations = d.iterations;
    if (d.postChecks) update.postChecks = d.postChecks;
    if (d.workflowStartedAt) update.workflowStartedAt = d.workflowStartedAt;
    if (!d.running) { update.sessions = []; update.workflowStartedAt = null; }
    setState(update);
  });

  eventSource.addEventListener('plan', (e) => {
    const d = JSON.parse(e.data);
    setState({ taskPlan: d.plan });
  });

  eventSource.addEventListener('taskStatus', (e) => {
    const d = JSON.parse(e.data);
    setState({ taskStatus: d.taskStatus });
  });

  eventSource.addEventListener('agentState', (e) => {
    const d = JSON.parse(e.data);
    const agentStates = { ...getState().agentStates };
    agentStates[d.name] = { state: d.state, tokens: d.tokens };
    setState({ agentStates });
  });

  eventSource.addEventListener('sessionMapped', (e) => {
    const d = JSON.parse(e.data);
    const agentSessionIds = { ...getState().agentSessionIds };
    agentSessionIds[d.name] = d.sessionId;
    setState({ agentSessionIds });
  });

  eventSource.addEventListener('guardrails', (e) => {
    const d = JSON.parse(e.data);
    setState({ guardrailResults: d.results });
  });

  eventSource.addEventListener('postChecks', (e) => {
    const d = JSON.parse(e.data);
    setState({ postChecks: d.checks });
  });

  eventSource.addEventListener('intervention', (e) => {
    const d = JSON.parse(e.data);
    const entries = [...getState().logEntries];
    entries.push({
      type: 'intervention',
      icon: '\u26a1',
      msg: `[${d.action}] ${d.agent}: ${d.detail || ''}`,
      time: new Date(d.timestamp),
      agent: d.agent,
    });
    setState({ logEntries: entries });
  });

  eventSource.addEventListener('humanGate', (e) => {
    const d = JSON.parse(e.data);
    const entries = [...getState().logEntries];
    entries.push({
      type: 'human',
      icon: '@',
      msg: `Human input needed for ${d.agent}: ${d.question}`,
      time: new Date(),
      agent: d.agent,
    });
    setState({ logEntries: entries });
  });

  eventSource.onerror = () => {};
}

export function disconnectSSE() {
  if (eventSource) { eventSource.close(); eventSource = null; }
}
```

**Step 3: Create `public/src/state/api.js` — REST API calls**

```javascript
export async function startBuild({ goal, terminalCount, model, iterations, structured }) {
  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, terminalCount, model, iterations, structured }),
  });
  return res.json();
}

export async function stopBuild() {
  await fetch('/api/stop', { method: 'POST' });
}

export async function emergencyStop() {
  await fetch('/api/estop', { method: 'POST' });
}

export async function pauseAgent(name) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/pause`, { method: 'POST' });
  return res.json();
}

export async function resumeAgent(name) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/resume`, { method: 'POST' });
  return res.json();
}

export async function injectPrompt(name, prompt) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return res.json();
}

export async function killAgent(name, restart = false) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restart }),
  });
  return res.json();
}

export async function approveGate(name, response = '') {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  });
  return res.json();
}

export async function getAgentTail(name, lines = 50) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/tail?lines=${lines}`);
  return res.json();
}
```

**Step 4: Verify modules load**

Update `public/src/app.js`:

```javascript
import { h, render } from './lib/preact.module.js';
import { useState, useEffect } from './lib/preact-hooks.module.js';
import htm from './lib/htm.module.js';
import { getState, setState, useStore } from './state/store.js';
import { connectSSE } from './state/sse.js';

export const html = htm.bind(h);

function App() {
  const running = useStore(s => s.running);
  const phase = useStore(s => s.phase);

  useEffect(() => { connectSSE(); }, []);

  return html`
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:var(--state-active);font-family:var(--font-mono);flex-direction:column;gap:8px;">
      <div>HiveMind — Mission Control</div>
      <div style="color:var(--text-secondary);font-size:var(--text-xs);">
        Status: ${running ? phase : 'idle'} | Connected to SSE
      </div>
    </div>
  `;
}

render(h(App, null), document.getElementById('app'));
```

**Step 5: Test SSE connection works**

```bash
cd /home/david/multi_claude && node server.cjs &
sleep 1
curl -s http://localhost:3456/index-v2.html | grep "module"
# Expected: <script type="module" src="/src/app.js">
kill %1
```

**Step 6: Commit**

```bash
git add public/src/state/ public/src/app.js
git commit -m "feat: state store, SSE connection, and API client for HiveMind"
```

---

## Task 3: Command Bar Component

**Files:**
- Create: `public/src/components/CommandBar.js`
- Create: `public/src/styles/command-bar.css`
- Modify: `public/src/app.js`

**Step 1: Create `public/src/styles/command-bar.css`**

```css
.command-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.command-bar .brand {
  font-family: var(--font-mono);
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--state-active);
  white-space: nowrap;
  letter-spacing: -0.5px;
}

.command-bar .goal-input {
  flex: 1;
  padding: 7px 12px;
  background: var(--bg-void);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: var(--text-md);
  font-family: var(--font-ui);
  outline: none;
  transition: border-color var(--transition-fast);
}
.command-bar .goal-input:focus { border-color: var(--state-waiting); }
.command-bar .goal-input:disabled { opacity: 0.5; }

.command-bar select {
  padding: 7px 10px;
  background: var(--bg-void);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: var(--text-sm);
  outline: none;
  cursor: pointer;
}

.command-bar .btn {
  padding: 7px 14px;
  border: none;
  border-radius: 6px;
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--transition-fast);
  white-space: nowrap;
}
.command-bar .btn:hover { opacity: 0.85; }
.command-bar .btn:disabled { opacity: 0.3; cursor: not-allowed; }
.command-bar .btn-start { background: var(--state-completed); color: #000; }
.command-bar .btn-stop { background: var(--state-failed); color: #fff; }
.command-bar .btn-estop {
  background: #ff0040;
  color: #fff;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 1px;
  animation: none;
}
.command-bar .btn-estop:hover { background: #ff2060; }

.command-bar .toggle-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}

/* Telemetry bar — shown when running */
.telemetry-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 5px 16px;
  background: var(--bg-void);
  border-bottom: 1px solid var(--border-subtle);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  flex-shrink: 0;
}
.telemetry-bar .telem-item { display: flex; align-items: center; gap: 4px; }
.telemetry-bar .telem-label { color: var(--text-muted); }
.telemetry-bar .telem-value { color: var(--text-primary); }
.telemetry-bar .telem-cost { color: var(--telem-cost); font-weight: 600; }
.telemetry-bar .telem-time { color: var(--telem-time); }
.telemetry-bar .telem-tokens { color: var(--telem-tokens); }

.telemetry-bar .progress-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-elevated);
  border-radius: 2px;
  overflow: hidden;
  min-width: 80px;
}
.telemetry-bar .progress-fill {
  height: 100%;
  background: var(--state-active);
  border-radius: 2px;
  transition: width 1s linear;
}
.telemetry-bar .progress-fill.warning { background: var(--telem-time); }
.telemetry-bar .progress-fill.danger { background: var(--state-failed); }
```

**Step 2: Create `public/src/components/CommandBar.js`**

```javascript
import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../app.js';
import { useStore, setState } from '../state/store.js';
import { startBuild, stopBuild, emergencyStop } from '../state/api.js';

const MODEL_PRICING = {
  sonnet: { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreation: 3.75 },
  opus:   { input: 15.0, output: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },
  haiku:  { input: 0.80, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
};

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export function CommandBar() {
  const running = useStore(s => s.running);
  const phase = useStore(s => s.phase);
  const model = useStore(s => s.model);
  const agentStates = useStore(s => s.agentStates);
  const taskPlan = useStore(s => s.taskPlan);
  const taskStatus = useStore(s => s.taskStatus);
  const workflowStartedAt = useStore(s => s.workflowStartedAt);

  const [goal, setGoal] = useState('');
  const [termCount, setTermCount] = useState('auto');
  const [selModel, setSelModel] = useState('sonnet');
  const [iters, setIters] = useState(0);
  const [structured, setStructured] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  // Elapsed timer
  useEffect(() => {
    if (!workflowStartedAt) { setElapsed(0); return; }
    const iv = setInterval(() => {
      setElapsed(Math.round((Date.now() - workflowStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [workflowStartedAt]);

  // Compute totals
  let totalIn = 0, totalOut = 0, totalCR = 0, totalCW = 0;
  for (const a of Object.values(agentStates)) {
    const t = a.tokens || {};
    totalIn += t.input || 0;
    totalOut += t.output || 0;
    totalCR += t.cacheRead || 0;
    totalCW += t.cacheCreation || 0;
  }
  const pricing = MODEL_PRICING[selModel] || MODEL_PRICING.sonnet;
  const cost = (totalIn * pricing.input + totalOut * pricing.output +
    totalCR * pricing.cacheRead + totalCW * pricing.cacheCreation) / 1000000;
  const burnRate = elapsed > 0 ? cost / elapsed : 0;

  // Task progress
  const tasks = taskPlan ? taskPlan.tasks || [] : [];
  const completedTasks = Object.values(taskStatus).filter(t =>
    t.status === 'completed' || t.status === 'completed_with_errors'
  ).length;
  const totalTasks = tasks.length;
  const progressPct = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  async function handleStart() {
    if (!goal.trim()) return;
    await startBuild({ goal: goal.trim(), terminalCount: termCount, model: selModel, iterations: iters, structured });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !running) handleStart();
  }

  return html`
    <div class="command-bar">
      <span class="brand">HiveMind</span>
      <input class="goal-input"
        placeholder="Enter your goal..."
        value=${goal}
        onInput=${e => setGoal(e.target.value)}
        onKeyDown=${handleKeyDown}
        disabled=${running}
      />
      <select value=${selModel} onChange=${e => setSelModel(e.target.value)} disabled=${running}>
        <option value="sonnet">Sonnet</option>
        <option value="opus">Opus</option>
        <option value="haiku">Haiku</option>
      </select>
      <select value=${termCount} onChange=${e => setTermCount(e.target.value)} disabled=${running}>
        <option value="auto">Auto</option>
        ${[1,2,3,4,5,6].map(n => html`<option value=${String(n)}>${n}T</option>`)}
      </select>
      <select value=${String(iters)} onChange=${e => setIters(parseInt(e.target.value))} disabled=${running}>
        ${[0,1,2,3,4,5].map(n => html`<option value=${String(n)}>${n} iter</option>`)}
      </select>
      <label class="toggle-label">
        <input type="checkbox" checked=${structured} onChange=${e => setStructured(e.target.checked)} disabled=${running} />
        Structured
      </label>
      ${!running && html`<button class="btn btn-start" onClick=${handleStart}>START</button>`}
      ${running && html`<button class="btn btn-stop" onClick=${stopBuild}>STOP</button>`}
      ${running && html`<button class="btn btn-estop" onClick=${emergencyStop}>E-STOP</button>`}
    </div>
    ${running && html`
      <div class="telemetry-bar">
        <div class="telem-item">
          <span class="telem-label">Phase:</span>
          <span class="telem-value">${phase}</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Time:</span>
          <span class="telem-value telem-time">${fmtTime(elapsed)}</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Cost:</span>
          <span class="telem-value telem-cost">$${cost.toFixed(2)}</span>
          <span class="telem-label">($${burnRate.toFixed(3)}/s)</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Tokens:</span>
          <span class="telem-value telem-tokens">${formatTokens(totalIn + totalOut)}</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Tasks:</span>
          <span class="telem-value">${completedTasks}/${totalTasks}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${progressPct}%"></div>
        </div>
      </div>
    `}
  `;
}
```

**Step 3: Update `public/src/app.js` to render CommandBar**

```javascript
import { h, render } from './lib/preact.module.js';
import { useEffect } from './lib/preact-hooks.module.js';
import htm from './lib/htm.module.js';
import { connectSSE } from './state/sse.js';
import { CommandBar } from './components/CommandBar.js';

export const html = htm.bind(h);

function App() {
  useEffect(() => { connectSSE(); }, []);

  return html`
    <${CommandBar} />
    <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-family:var(--font-mono);">
      Graph + Detail Panel coming next...
    </div>
  `;
}

render(h(App, null), document.getElementById('app'));
```

**Step 4: Add CSS import to index-v2.html**

Add to `<head>`:
```html
<link rel="stylesheet" href="/src/styles/command-bar.css">
```

**Step 5: Verify visually**

```bash
cd /home/david/multi_claude && node server.cjs &
sleep 1
# Open http://localhost:3456/index-v2.html in browser
# Expected: HiveMind brand, goal input, model/terminal selects, START button
# Type a goal, click START — telemetry bar should appear
kill %1
```

**Step 6: Commit**

```bash
git add public/src/components/CommandBar.js public/src/styles/command-bar.css public/src/app.js public/index-v2.html
git commit -m "feat: Command Bar with telemetry, controls, and E-stop"
```

---

## Task 4: Topology Graph — Layout Algorithm

**Files:**
- Create: `public/src/graph/layout.js`
- Create: `public/src/graph/edges.js`

**Step 1: Create `public/src/graph/layout.js` — topological sort to coordinates**

```javascript
/**
 * Compute graph layout from a task plan.
 * Returns { nodes: [{name, x, y, w, h, phase}], edges: [{from, to, points}] }
 *
 * Algorithm: phase-based column layout
 * - X: phase index * column width
 * - Y: index within phase * row height, centered vertically
 */

const NODE_W = 180;
const NODE_H = 90;
const COL_GAP = 60;
const ROW_GAP = 24;

export function computeLayout(plan, containerW, containerH) {
  if (!plan || !plan.tasks || plan.tasks.length === 0) {
    return { nodes: [], edges: [], phases: [] };
  }

  const tasks = plan.tasks;
  const phases = computePhases(tasks);

  // Compute node positions
  const nodes = [];
  const nodeMap = {}; // name -> node

  const totalCols = phases.length;
  const totalW = totalCols * (NODE_W + COL_GAP) - COL_GAP;
  const offsetX = Math.max(40, (containerW - totalW) / 2);

  for (let pi = 0; pi < phases.length; pi++) {
    const phase = phases[pi];
    const totalRows = phase.length;
    const totalH = totalRows * (NODE_H + ROW_GAP) - ROW_GAP;
    const offsetY = Math.max(20, (containerH - totalH) / 2);

    for (let ri = 0; ri < phase.length; ri++) {
      const taskName = phase[ri];
      const task = tasks.find(t => t.name === taskName);
      const x = offsetX + pi * (NODE_W + COL_GAP);
      const y = offsetY + ri * (NODE_H + ROW_GAP);

      const node = { name: taskName, x, y, w: NODE_W, h: NODE_H, phase: pi, task };
      nodes.push(node);
      nodeMap[taskName] = node;
    }
  }

  // Compute edges
  const edges = [];
  for (const task of tasks) {
    if (!task.dependencies) continue;
    for (const dep of task.dependencies) {
      const from = nodeMap[dep];
      const to = nodeMap[task.name];
      if (from && to) {
        edges.push({
          from: dep,
          to: task.name,
          x1: from.x + from.w,
          y1: from.y + from.h / 2,
          x2: to.x,
          y2: to.y + to.h / 2,
        });
      }
    }
  }

  return { nodes, edges, phases };
}

function computePhases(tasks) {
  const phases = [];
  const done = new Set();
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const phase = remaining.filter(t =>
      (t.dependencies || []).every(d => done.has(d))
    );
    if (phase.length === 0) {
      phases.push(remaining.map(t => t.name));
      break;
    }
    phases.push(phase.map(t => t.name));
    for (const t of phase) done.add(t.name);
    remaining = remaining.filter(t => !done.has(t.name));
  }

  return phases;
}

export { NODE_W, NODE_H };
```

**Step 2: Create `public/src/graph/edges.js` — SVG bezier path generation**

```javascript
/**
 * Generate an SVG path string for a dependency edge.
 * Uses a cubic bezier curve from source right edge to target left edge.
 */
export function edgePath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1);
  const cpOffset = Math.max(40, dx * 0.4);
  return `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`;
}
```

**Step 3: Verify layout algorithm**

```bash
cd /home/david/multi_claude
node -e "
const { computeLayout } = require('./public/src/graph/layout.js');
" 2>&1 || echo "Note: ES modules — will test in browser"
```

(ES modules can't be `require()`d — verify via browser console or write a quick test.)

**Step 4: Commit**

```bash
git add public/src/graph/
git commit -m "feat: graph layout algorithm and SVG edge path generation"
```

---

## Task 5: Topology Graph — SVG Component

**Files:**
- Create: `public/src/components/TopologyGraph.js`
- Create: `public/src/styles/graph.css`
- Modify: `public/src/app.js`

**Step 1: Create `public/src/styles/graph.css`**

```css
.topology-graph {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--bg-void);
  min-width: 0;
}

.topology-graph svg {
  width: 100%;
  height: 100%;
}

.graph-node {
  cursor: pointer;
  transition: filter var(--transition-fast);
}
.graph-node:hover rect { stroke-opacity: 0.8; }
.graph-node.selected rect {
  stroke-width: 2;
  filter: drop-shadow(0 0 8px var(--state-active));
}

.graph-node rect {
  fill: var(--bg-surface);
  stroke: var(--border-active);
  stroke-width: 1;
  rx: 8;
  ry: 8;
  transition: stroke var(--transition-fast), filter var(--transition-fast);
}

/* State-based node borders */
.graph-node.state-active rect     { stroke: var(--state-active); }
.graph-node.state-thinking rect   { stroke: var(--state-thinking); }
.graph-node.state-tool_use rect   { stroke: var(--state-tool-use); }
.graph-node.state-waiting rect    { stroke: var(--state-waiting); }
.graph-node.state-completed rect  { stroke: var(--state-completed); }
.graph-node.state-failed rect     { stroke: var(--state-failed); filter: drop-shadow(0 0 6px var(--state-failed)); }
.graph-node.state-retrying rect   { stroke: var(--state-retrying); }
.graph-node.state-idle rect       { stroke: var(--state-idle); }
.graph-node.state-human rect      { stroke: var(--state-human); filter: drop-shadow(0 0 8px var(--state-human)); }

.graph-edge {
  fill: none;
  stroke: var(--border-active);
  stroke-width: 1.5;
  transition: stroke var(--transition-fast);
}
.graph-edge.resolved { stroke: var(--state-completed); stroke-opacity: 0.5; }
.graph-edge.pending {
  stroke-dasharray: 6 4;
  animation: dash-flow 1s linear infinite;
}

@keyframes dash-flow {
  to { stroke-dashoffset: -10; }
}

.phase-label {
  fill: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.node-state-dot { transition: fill var(--transition-fast); }
.node-name { fill: var(--text-primary); font-family: var(--font-mono); font-size: 13px; font-weight: 600; }
.node-role { fill: var(--text-secondary); font-family: var(--font-ui); font-size: 10px; }
.node-telem { fill: var(--text-muted); font-family: var(--font-mono); font-size: 10px; }

/* Empty state */
.graph-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-lg);
}
```

**Step 2: Create `public/src/components/TopologyGraph.js`**

```javascript
import { h } from '../lib/preact.module.js';
import { useRef, useEffect, useState } from '../lib/preact-hooks.module.js';
import { html } from '../app.js';
import { useStore, setState } from '../state/store.js';
import { computeLayout, NODE_W, NODE_H } from '../graph/layout.js';
import { edgePath } from '../graph/edges.js';

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function getNodeState(name, agentStates, taskStatus) {
  const agent = agentStates[name];
  const task = taskStatus[name];
  if (agent && agent.state && agent.state !== 'idle') return agent.state;
  if (task) {
    if (task.status === 'in_progress') return 'active';
    if (task.status === 'completed') return 'completed';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'retrying') return 'retrying';
    if (task.status === 'waiting') return 'waiting';
    if (task.status === 'timed_out') return 'failed';
    if (task.status === 'completed_with_errors') return 'completed';
  }
  return 'idle';
}

function stateColor(state) {
  const map = {
    active: 'var(--state-active)', thinking: 'var(--state-thinking)',
    tool_use: 'var(--state-tool-use)', waiting: 'var(--state-waiting)',
    completed: 'var(--state-completed)', failed: 'var(--state-failed)',
    retrying: 'var(--state-retrying)', idle: 'var(--state-idle)',
    human: 'var(--state-human)',
  };
  return map[state] || map.idle;
}

function isEdgeResolved(fromName, taskStatus) {
  const t = taskStatus[fromName];
  return t && (t.status === 'completed' || t.status === 'completed_with_errors');
}

export function TopologyGraph() {
  const taskPlan = useStore(s => s.taskPlan);
  const taskStatus = useStore(s => s.taskStatus);
  const agentStates = useStore(s => s.agentStates);
  const selectedAgent = useStore(s => s.selectedAgent);
  const containerRef = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 500 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  if (!taskPlan || !taskPlan.tasks || taskPlan.tasks.length === 0) {
    return html`<div class="topology-graph" ref=${containerRef}>
      <div class="graph-empty">Waiting for execution plan...</div>
    </div>`;
  }

  const { nodes, edges, phases } = computeLayout(taskPlan, size.w, size.h);

  function selectNode(name) {
    setState({ selectedAgent: selectedAgent === name ? null : name });
  }

  return html`
    <div class="topology-graph" ref=${containerRef}>
      <svg viewBox="0 0 ${size.w} ${size.h}" xmlns="http://www.w3.org/2000/svg">
        <!-- Phase labels -->
        ${phases.map((phase, pi) => {
          const firstNode = nodes.find(n => n.phase === pi);
          if (!firstNode) return null;
          return html`<text class="phase-label" x=${firstNode.x + NODE_W / 2} y=${12} text-anchor="middle">
            Phase ${pi + 1}
          </text>`;
        })}

        <!-- Edges -->
        ${edges.map(e => {
          const resolved = isEdgeResolved(e.from, taskStatus);
          return html`<path
            class="graph-edge ${resolved ? 'resolved' : 'pending'}"
            d=${edgePath(e.x1, e.y1, e.x2, e.y2)}
          />`;
        })}

        <!-- Nodes -->
        ${nodes.map(n => {
          const state = getNodeState(n.name, agentStates, taskStatus);
          const tokens = agentStates[n.name]?.tokens || {};
          const totalTok = (tokens.input || 0) + (tokens.output || 0);
          const isSelected = selectedAgent === n.name;
          const task = n.task || {};

          return html`
            <g class="graph-node state-${state} ${isSelected ? 'selected' : ''}"
               onClick=${() => selectNode(n.name)}>
              <rect x=${n.x} y=${n.y} width=${n.w} height=${n.h} />
              <!-- State dot -->
              <circle class="node-state-dot" cx=${n.x + 14} cy=${n.y + 16} r="4"
                fill=${stateColor(state)} />
              <!-- Name -->
              <text class="node-name" x=${n.x + 24} y=${n.y + 20}>${n.name}</text>
              <!-- Role -->
              <text class="node-role" x=${n.x + 10} y=${n.y + 38}>
                ${(task.role || '').substring(0, 25)}
              </text>
              <!-- Progress bar background -->
              <rect x=${n.x + 10} y=${n.y + 48} width=${n.w - 20} height="4" rx="2"
                fill="var(--bg-void)" />
              <!-- Progress bar fill (based on state) -->
              <rect x=${n.x + 10} y=${n.y + 48}
                width=${(n.w - 20) * (state === 'completed' ? 1 : state === 'active' ? 0.5 : 0)}
                height="4" rx="2" fill=${stateColor(state)} />
              <!-- Telemetry -->
              <text class="node-telem" x=${n.x + 10} y=${n.y + 72}>
                ${formatTokens(totalTok)} tok
              </text>
            </g>
          `;
        })}
      </svg>
    </div>
  `;
}
```

**Step 3: Update `public/src/app.js` to compose layout**

```javascript
import { h, render } from './lib/preact.module.js';
import { useEffect } from './lib/preact-hooks.module.js';
import htm from './lib/htm.module.js';
import { connectSSE } from './state/sse.js';
import { CommandBar } from './components/CommandBar.js';
import { TopologyGraph } from './components/TopologyGraph.js';

export const html = htm.bind(h);

function App() {
  useEffect(() => { connectSSE(); }, []);

  return html`
    <${CommandBar} />
    <div style="flex:1;display:flex;overflow:hidden;">
      <${TopologyGraph} />
      <div style="width:340px;background:var(--bg-surface);border-left:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-family:var(--font-mono);font-size:11px;">
        Agent Detail Panel — Task 6
      </div>
    </div>
    <div style="height:200px;background:var(--bg-surface);border-top:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-family:var(--font-mono);font-size:11px;">
      Activity Feed — Task 7
    </div>
  `;
}

render(h(App, null), document.getElementById('app'));
```

**Step 4: Add graph CSS import to index-v2.html**

Add to `<head>`:
```html
<link rel="stylesheet" href="/src/styles/graph.css">
```

**Step 5: Verify graph renders**

Start a build with the existing dashboard (port 3456), then visit `/index-v2.html` — the graph should show task nodes laid out in phase columns with edges.

**Step 6: Commit**

```bash
git add public/src/components/TopologyGraph.js public/src/styles/graph.css public/src/graph/ public/src/app.js public/index-v2.html
git commit -m "feat: topology graph — SVG dependency DAG with state-driven visuals"
```

---

## Task 6: Agent Detail Panel

**Files:**
- Create: `public/src/components/AgentDetail.js`
- Create: `public/src/styles/agent-detail.css`
- Modify: `public/src/app.js`

**Step 1: Create `public/src/styles/agent-detail.css`**

```css
.agent-detail {
  width: 340px;
  background: var(--bg-surface);
  border-left: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

.agent-detail-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.agent-header {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.agent-header-name {
  font-family: var(--font-mono);
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-header-role {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-style: italic;
  margin-top: 2px;
}
.agent-header-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.agent-state-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

.agent-sections {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.agent-section {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle);
}
.agent-section-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.agent-section-body {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.5;
}
.agent-section-body pre {
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-file-list {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--state-completed);
}
.agent-file-list div { padding: 1px 0; }

.agent-output-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  padding: 1px 0;
}
.agent-output-check.pass { color: var(--state-completed); }
.agent-output-check.pending { color: var(--text-muted); }

/* JSONL tail */
.agent-tail {
  flex-shrink: 0;
  max-height: 160px;
  overflow-y: auto;
  overflow-anchor: auto;
  background: var(--bg-void);
  border-top: 1px solid var(--border-subtle);
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Intervention actions */
.agent-actions {
  display: flex;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.agent-actions .btn {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-active);
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  transition: background var(--transition-fast);
}
.agent-actions .btn:hover { background: var(--bg-hover); }
.agent-actions .btn-danger { border-color: var(--state-failed); color: var(--state-failed); }
.agent-actions .btn-warn { border-color: var(--state-retrying); color: var(--state-retrying); }

/* Inject prompt modal */
.inject-bar {
  display: flex;
  gap: 6px;
  padding: 8px 14px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.inject-bar input {
  flex: 1;
  padding: 6px 8px;
  background: var(--bg-void);
  border: 1px solid var(--border-active);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  outline: none;
}
.inject-bar input:focus { border-color: var(--state-thinking); }
```

**Step 2: Create `public/src/components/AgentDetail.js`**

```javascript
import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../app.js';
import { useStore } from '../state/store.js';
import { pauseAgent, resumeAgent, injectPrompt, killAgent, getAgentTail } from '../state/api.js';

function stateColor(state) {
  const map = {
    active: 'var(--state-active)', in_progress: 'var(--state-active)',
    thinking: 'var(--state-thinking)', tool_use: 'var(--state-tool-use)',
    waiting: 'var(--state-waiting)', completed: 'var(--state-completed)',
    failed: 'var(--state-failed)', retrying: 'var(--state-retrying)',
    timed_out: 'var(--state-failed)', idle: 'var(--state-idle)',
    completed_with_errors: 'var(--state-retrying)',
  };
  return map[state] || map.idle;
}

function fmtElapsed(startedAt) {
  if (!startedAt) return '';
  const s = Math.round((Date.now() - startedAt) / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

export function AgentDetail() {
  const selectedAgent = useStore(s => s.selectedAgent);
  const taskPlan = useStore(s => s.taskPlan);
  const taskStatus = useStore(s => s.taskStatus);
  const agentStates = useStore(s => s.agentStates);
  const running = useStore(s => s.running);
  const logEntries = useStore(s => s.logEntries);

  const [showInject, setShowInject] = useState(false);
  const [injectText, setInjectText] = useState('');
  const [tailLines, setTailLines] = useState([]);
  const tailRef = useRef(null);

  // Fetch tail periodically when agent selected and running
  useEffect(() => {
    if (!selectedAgent || !running) { setTailLines([]); return; }
    let cancelled = false;
    async function poll() {
      try {
        const data = await getAgentTail(selectedAgent, 30);
        if (!cancelled && data.lines) setTailLines(data.lines);
      } catch (_) {}
    }
    poll();
    const iv = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [selectedAgent, running]);

  // Auto-scroll tail
  useEffect(() => {
    if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
  }, [tailLines]);

  if (!selectedAgent) {
    return html`<div class="agent-detail">
      <div class="agent-detail-empty">Click a node to inspect</div>
    </div>`;
  }

  const task = taskPlan?.tasks?.find(t => t.name === selectedAgent) || {};
  const status = taskStatus[selectedAgent] || {};
  const agent = agentStates[selectedAgent] || {};
  const agentState = agent.state || status.status || 'idle';
  const tokens = agent.tokens || {};

  // Prompts sent to this agent
  const prompts = logEntries
    .filter(e => e.type === 'prompt' && e.agent === selectedAgent)
    .map(e => e.detail);

  async function handleInject() {
    if (!injectText.trim()) return;
    await injectPrompt(selectedAgent, injectText.trim());
    setInjectText('');
    setShowInject(false);
  }

  return html`
    <div class="agent-detail">
      <div class="agent-header">
        <div class="agent-header-name">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${stateColor(agentState)}"></span>
          ${selectedAgent}
        </div>
        ${task.role && html`<div class="agent-header-role">${task.role}</div>`}
        <div class="agent-header-status">
          <span class="agent-state-badge" style="background:${stateColor(agentState)};color:#000;">
            ${(agentState || 'idle').replace(/_/g, ' ')}
          </span>
          ${status.startedAt && html`<span>${fmtElapsed(status.startedAt)} elapsed</span>`}
          ${status.attempts > 0 && html`<span>Attempt ${status.attempts}/${status.maxAttempts}</span>`}
        </div>
      </div>

      <div class="agent-sections">
        ${task.description && html`
          <div class="agent-section">
            <div class="agent-section-title">Task</div>
            <div class="agent-section-body">${task.description}</div>
          </div>
        `}

        ${task.ownedFiles && task.ownedFiles.length > 0 && html`
          <div class="agent-section">
            <div class="agent-section-title">Owned Files</div>
            <div class="agent-file-list">
              ${task.ownedFiles.map(f => html`<div>${f}</div>`)}
            </div>
          </div>
        `}

        ${task.expectedOutput && html`
          <div class="agent-section">
            <div class="agent-section-title">Expected Output</div>
            <div class="agent-section-body">
              ${(task.expectedOutput.files || []).map(f => html`
                <div class="agent-output-check pending">○ ${f}</div>
              `)}
              ${(task.expectedOutput.exports || []).map(e => html`
                <div class="agent-output-check pending">○ export: ${e}</div>
              `)}
            </div>
          </div>
        `}

        ${prompts.length > 0 && html`
          <div class="agent-section">
            <div class="agent-section-title">Prompts Sent (${prompts.length})</div>
            <div class="agent-section-body">
              ${prompts.map((p, i) => html`
                <div style="margin-bottom:4px;">
                  <span style="color:var(--state-waiting);font-size:10px;">#${i + 1}</span>
                  <pre>${p}</pre>
                </div>
              `)}
            </div>
          </div>
        `}

        <div class="agent-section">
          <div class="agent-section-title">Telemetry</div>
          <div class="agent-section-body" style="font-family:var(--font-mono);">
            <div>In: ${(tokens.input || 0).toLocaleString()} | Out: ${(tokens.output || 0).toLocaleString()}</div>
            <div>Cache R: ${(tokens.cacheRead || 0).toLocaleString()} | W: ${(tokens.cacheCreation || 0).toLocaleString()}</div>
          </div>
        </div>

        ${status.error && html`
          <div class="agent-section">
            <div class="agent-section-title" style="color:var(--state-failed);">Error</div>
            <div class="agent-section-body" style="color:var(--state-failed);font-style:italic;">
              ${status.error}
            </div>
          </div>
        `}
      </div>

      ${tailLines.length > 0 && html`
        <div class="agent-tail" ref=${tailRef}>
          ${tailLines.join('\n')}
        </div>
      `}

      ${showInject && html`
        <div class="inject-bar">
          <input placeholder="Inject prompt..." value=${injectText}
            onInput=${e => setInjectText(e.target.value)}
            onKeyDown=${e => e.key === 'Enter' && handleInject()}
            autofocus />
          <button class="btn" style="flex:none;padding:6px 12px;background:var(--state-thinking);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:10px;"
            onClick=${handleInject}>Send</button>
        </div>
      `}

      ${running && html`
        <div class="agent-actions">
          <button class="btn" onClick=${() => pauseAgent(selectedAgent)}>Pause</button>
          <button class="btn" onClick=${() => resumeAgent(selectedAgent)}>Resume</button>
          <button class="btn" onClick=${() => setShowInject(!showInject)}>Inject</button>
          <button class="btn btn-danger" onClick=${() => killAgent(selectedAgent, true)}>Restart</button>
        </div>
      `}
    </div>
  `;
}
```

**Step 3: Update `public/src/app.js` to include AgentDetail**

Replace the placeholder `<div>` with:
```javascript
import { AgentDetail } from './components/AgentDetail.js';
// ... in the render:
<${AgentDetail} />
```

**Step 4: Add CSS import, verify, commit**

```bash
git add public/src/components/AgentDetail.js public/src/styles/agent-detail.css public/src/app.js public/index-v2.html
git commit -m "feat: Agent Detail Panel with telemetry, prompts, tail, and intervention"
```

---

## Task 7: Activity Feed

**Files:**
- Create: `public/src/components/ActivityFeed.js`
- Create: `public/src/styles/activity-feed.css`
- Modify: `public/src/app.js`

This task creates the filterable activity feed with inline intervention actions. The component renders log entries from the store, supports filter chips (All, Errors, by agent), and shows action buttons on failure entries.

**Implementation**: Same pattern as Tasks 5-6 — Preact component with `useStore`, CSS file, wire into `app.js`. The log entry parsing is already handled by `sse.js`. The component maps `logEntries` to styled rows with time, icon, message, and optional inline actions.

**Key details**:
- Filter state stored in `store.js` as `feedFilter`
- Entries colored by `type` (same colors as old dashboard but using CSS variables)
- Auto-scroll with `overflow-anchor: auto`
- Click entry with `agent` field → `setState({ selectedAgent: entry.agent })`
- Failure entries show [Retry] [Skip] buttons

**Commit message**: `"feat: Activity Feed with filters and inline intervention actions"`

---

## Task 8: Server — Intervention API Endpoints

**Files:**
- Modify: `server.cjs` (add routes at ~line 1665, before `/api/stream`)
- Modify: `tmux-control.cjs` (add `--signal` and `--pid` commands)

**Step 1: Add signal support to tmux-control.cjs**

Add a new `--signal` command that sends a signal to the process running in a tmux pane:

```javascript
// In the switch statement, add:
case '--signal': {
  const name = args[1];
  const sig = args[2] || 'SIGSTOP';
  if (!name) { console.error('Usage: --signal <name> <signal>'); process.exit(1); }
  const session = sessionName(name);
  // Get the PID of the process in the pane
  const pid = execSync(`tmux display-message -t "${session}" -p "#{pane_pid}"`, { encoding: 'utf-8' }).trim();
  if (pid) {
    // Send signal to the process group (child processes too)
    execSync(`kill -s ${sig} -${pid}`, { encoding: 'utf-8' });
    console.log(`Sent ${sig} to ${name} (pid group ${pid})`);
  }
  break;
}
```

**Step 2: Add intervention endpoints to server.cjs**

Insert before the `/api/stream` route (line ~1665):

```javascript
// --- Intervention endpoints ---

// Agent name validation
const agentNameRegex = /^\/api\/agent\/([a-zA-Z0-9_-]+)\/(pause|resume|inject|kill|approve|tail)$/;

if (agentNameRegex.test(pathname)) {
  const [, agentName, action] = pathname.match(agentNameRegex);

  if (action === 'pause' && req.method === 'POST') {
    try {
      runTmux(`--signal ${agentName} SIGSTOP`);
      broadcast('intervention', { agent: agentName, action: 'pause', timestamp: Date.now(), detail: 'Agent paused' });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: 'Failed to pause: ' + (e.message || '') });
    }
  }

  if (action === 'resume' && req.method === 'POST') {
    try {
      runTmux(`--signal ${agentName} SIGCONT`);
      broadcast('intervention', { agent: agentName, action: 'resume', timestamp: Date.now(), detail: 'Agent resumed' });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: 'Failed to resume: ' + (e.message || '') });
    }
  }

  if (action === 'inject' && req.method === 'POST') {
    const body = await parseBody(req);
    const prompt = (body.prompt || '').trim();
    if (!prompt) return sendJson(res, 400, { error: 'Prompt is required' });
    try {
      runTmux(`--cmd ${agentName} "${prompt.replace(/"/g, '\\"')}"`);
      // Send Enter to confirm
      setTimeout(() => { try { runTmux(`--cmd ${agentName} ""`); } catch (_) {} }, 1000);
      broadcast('intervention', { agent: agentName, action: 'inject', timestamp: Date.now(), detail: prompt.substring(0, 100) });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: 'Failed to inject: ' + (e.message || '') });
    }
  }

  if (action === 'kill' && req.method === 'POST') {
    const body = await parseBody(req);
    try {
      runTmux(`--stop ${agentName}`);
      broadcast('intervention', { agent: agentName, action: 'kill', timestamp: Date.now(), detail: body.restart ? 'Killed + restarting' : 'Killed' });
      // TODO: restart logic if body.restart — respawn tmux session and resend task
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 500, { error: 'Failed to kill: ' + (e.message || '') });
    }
  }

  if (action === 'approve' && req.method === 'POST') {
    const body = await parseBody(req);
    broadcast('intervention', { agent: agentName, action: 'approve', timestamp: Date.now(), detail: body.response || 'Approved' });
    // If there's a response, inject it to the agent
    if (body.response) {
      try {
        runTmux(`--cmd ${agentName} "${body.response.replace(/"/g, '\\"')}"`);
        setTimeout(() => { try { runTmux(`--cmd ${agentName} ""`); } catch (_) {} }, 1000);
      } catch (_) {}
    }
    return sendJson(res, 200, { ok: true });
  }

  if (action === 'tail' && req.method === 'GET') {
    const lines = parseInt(url.searchParams.get('lines') || '50');
    try {
      const output = runTmux(`--read ${agentName} ${Math.min(lines, 200)}`);
      return sendJson(res, 200, { lines: output.split('\n') });
    } catch (e) {
      return sendJson(res, 200, { lines: [] });
    }
  }
}

// Emergency stop
if (pathname === '/api/estop' && req.method === 'POST') {
  // Kill everything immediately — no graceful shutdown
  if (state.controllerProcess) {
    try { state.controllerProcess.kill('SIGKILL'); } catch (_) {}
    state.controllerProcess = null;
  }
  try { runTmux('--stop-all'); } catch (_) {}
  if (state.monitor) { state.monitor.stop(); state.monitor = null; }
  stopConductorTimers();
  clearSessionState();
  stopPolling();
  state.running = false;
  state.phase = 'idle';
  state.sessions = [];
  broadcast('status', { running: false, phase: 'idle' });
  broadcast('terminals', { sessions: [] });
  broadcast('intervention', { agent: '*', action: 'estop', timestamp: Date.now(), detail: 'Emergency stop — all agents killed' });
  notify('HiveMind', 'EMERGENCY STOP — all agents killed');
  return sendJson(res, 200, { ok: true });
}
```

**Step 3: Verify endpoints**

```bash
# Start a build, then test:
curl -X POST http://localhost:3456/api/estop
# Expected: {"ok":true}
```

**Step 4: Commit**

```bash
git add server.cjs tmux-control.cjs
git commit -m "feat: intervention API — pause, resume, inject, kill, approve, estop, tail"
```

---

## Task 9: Command Palette + Keyboard Shortcuts

**Files:**
- Create: `public/src/components/CommandPalette.js`
- Create: `public/src/styles/command-palette.css`
- Modify: `public/src/app.js` (add keyboard listener + component)

The command palette is a Cmd+K overlay with fuzzy search. Actions include: jump to agent, pause/resume all, E-stop, toggle views, search feed.

Keyboard shortcuts (global listener in `app.js`):
- `Cmd+K` / `Ctrl+K` → toggle command palette
- `1-9` → select agent by index (when no input focused)
- `Space` → pause/resume selected agent
- `Escape` → deselect agent / close palette

**Commit message**: `"feat: Command Palette and keyboard shortcuts"`

---

## Task 10: Final Integration + App Layout Polish

**Files:**
- Modify: `public/src/app.js` (final layout composition)
- Modify: `public/index-v2.html` (all CSS imports)
- Create: `public/src/styles/layout.css` (resizable panels, global layout)

Wire all components together. Add resize handles between graph/detail and main/feed. Ensure SSE reconnection works. Test full flow: start a build, see graph populate, click nodes, use intervention buttons, use keyboard shortcuts.

**Commit message**: `"feat: HiveMind Phase 1 complete — Mission Control dashboard"`

---

## Task 11: Cutover + Cleanup

**Files:**
- Rename: `public/index.html` → `public/index-legacy.html`
- Rename: `public/index-v2.html` → `public/index.html`

Keep the legacy dashboard accessible at `/index-legacy.html` as a fallback.

**Commit message**: `"chore: promote HiveMind dashboard as default, preserve legacy"`

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Scaffold + Vendor Preact/HTM | `public/src/`, theme CSS, entry point |
| 2 | State Store + SSE | `store.js`, `sse.js`, `api.js` |
| 3 | Command Bar | Component + CSS + telemetry |
| 4 | Graph Layout Algorithm | `layout.js`, `edges.js` |
| 5 | Topology Graph SVG | Component + CSS |
| 6 | Agent Detail Panel | Component + CSS + tail + inject |
| 7 | Activity Feed | Component + CSS + filters |
| 8 | Server Intervention APIs | 6 endpoints + tmux signal |
| 9 | Command Palette + Keys | Component + global listener |
| 10 | Integration + Polish | Final layout, resize, testing |
| 11 | Cutover | Promote new dashboard |

---

Plan complete and saved to `docs/plans/2026-03-05-hivemind-phase1-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?