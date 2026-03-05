# HiveMind Phase 2 — "Deep Visibility" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real-time conversation streaming, run history persistence, and file change tracking to the HiveMind dashboard — turning it from a control surface into a full observability platform.

**Architecture:** Extend `jsonl-monitor.cjs` to emit parsed conversation events (thinking, tool calls, text) via a new SSE `agentConversation` event. Add `fs.watch` on the project directory to track file changes. Persist completed runs as JSON files in `~/.multi-claude/history/`. Dashboard gets a conversation viewer in Agent Detail, a file changes panel, and a history overlay.

**Tech Stack:** Same as Phase 1 — Preact + HTM (ESM, no build step), server.cjs extensions, native `fs.watch`, JSON file persistence. Zero new npm dependencies.

**Design Doc:** `docs/plans/2026-03-05-hivemind-dashboard-design.md` (sections 5.3, 5.6-5.8, 6 Phase 2)

---

## Task 1: Extend JsonlMonitor to Parse Conversation Events

**Files:**
- Modify: `jsonl-monitor.cjs`

**Context:** The JSONL monitor already watches session files and parses lines for state/token tracking. We need to extend `_processLine()` to also emit parsed conversation events that the dashboard can display.

JSONL message structure (from Claude Code session files):
- `type: "assistant"` → `message.content[]` contains blocks:
  - `{type: "thinking", thinking: "..."}` — extended thinking
  - `{type: "text", text: "..."}` — text response
  - `{type: "tool_use", id: "...", name: "Read", input: {...}}` — tool call
- `type: "user"` → `message.content[]` can contain:
  - `{type: "tool_result", tool_use_id: "...", content: "..."}` — tool result

**Step 1: Add conversation event emission to _processLine**

In `jsonl-monitor.cjs`, extend `_processLine()` to emit a `conversation` event with parsed content blocks. Add a `_conversationBuffer` Map to each session to hold recent events (capped at 200).

```javascript
// Inside _processLine, after existing assistant message handling:

// Emit conversation events for dashboard
if (msg.message && msg.message.content && Array.isArray(msg.message.content)) {
  const role = msg.message.role || msg.type;
  for (const block of msg.message.content) {
    if (block.type === 'thinking') {
      this.emit('conversation', tmuxName, {
        type: 'thinking',
        content: block.thinking,
        timestamp: Date.now(),
      });
    } else if (block.type === 'text') {
      this.emit('conversation', tmuxName, {
        type: 'text',
        content: block.text,
        timestamp: Date.now(),
      });
    } else if (block.type === 'tool_use') {
      this.emit('conversation', tmuxName, {
        type: 'tool_call',
        toolName: block.name,
        toolId: block.id,
        input: block.input,
        timestamp: Date.now(),
      });
    } else if (block.type === 'tool_result') {
      this.emit('conversation', tmuxName, {
        type: 'tool_result',
        toolId: block.tool_use_id,
        content: typeof block.content === 'string'
          ? block.content.substring(0, 2000)
          : JSON.stringify(block.content).substring(0, 2000),
        timestamp: Date.now(),
      });
    }
  }
}
```

Also add a `getConversation(tmuxName)` method that returns the buffered events (for late-joining dashboard clients):

```javascript
getConversation(tmuxName) {
  const info = this._sessions.get(tmuxName);
  return info ? [...(info.conversationBuffer || [])] : [];
}
```

Extend the session info in `registerSession()` to include:
```javascript
conversationBuffer: [],  // last 200 conversation events
```

In the conversation emit block, also push to buffer:
```javascript
const evt = { type: '...', ... };
info.conversationBuffer.push(evt);
if (info.conversationBuffer.length > 200) info.conversationBuffer.shift();
this.emit('conversation', tmuxName, evt);
```

**Step 2: Commit**

```bash
git add jsonl-monitor.cjs
git commit -m "feat(phase2): extend JsonlMonitor to emit parsed conversation events"
```

---

## Task 2: Wire Conversation Events to SSE + Add Conversation Init

**Files:**
- Modify: `server.cjs`

**Context:** The server already listens to JsonlMonitor `stateChange` and `turnComplete` events and broadcasts them via SSE. We need to add a listener for the new `conversation` event, broadcast it, and include conversation buffers in the `init` event for late-joining clients.

**Step 1: Add conversation event listener where monitor events are wired**

Find the section in `server.cjs` where `state.monitor.on("stateChange", ...)` is called. Add alongside it:

```javascript
state.monitor.on("conversation", (name, evt) => {
  broadcast("agentConversation", { agent: name, ...evt });
});
```

**Step 2: Add conversation data to SSE init event**

In the `/api/stream` handler, add agent conversation buffers to `initData`:

```javascript
// After existing initData properties, before sending:
if (state.monitor) {
  const convos = {};
  for (const name of state.sessions) {
    const buf = state.monitor.getConversation(name);
    if (buf.length > 0) convos[name] = buf;
  }
  if (Object.keys(convos).length > 0) initData.agentConversations = convos;
}
```

**Step 3: Commit**

```bash
git add server.cjs
git commit -m "feat(phase2): broadcast agentConversation SSE events + init data"
```

---

## Task 3: Dashboard — Store and Subscribe to Conversation Events

**Files:**
- Modify: `public/src/state/store.js`
- Modify: `public/src/state/sse.js`

**Step 1: Add conversation state to store**

In `store.js`, add to the initial state object:

```javascript
// Agent conversations — name → [{type, content, timestamp, ...}]
agentConversations: {},
```

**Step 2: Handle agentConversation SSE event**

In `sse.js`, add a new event listener after the existing ones:

```javascript
eventSource.addEventListener('agentConversation', (e) => {
  const d = JSON.parse(e.data);
  const convos = { ...getState().agentConversations };
  const list = convos[d.agent] ? [...convos[d.agent]] : [];
  list.push({ type: d.type, content: d.content, toolName: d.toolName, toolId: d.toolId, input: d.input, timestamp: d.timestamp });
  // Cap at 200 per agent
  if (list.length > 200) list.splice(0, list.length - 200);
  convos[d.agent] = list;
  setState({ agentConversations: convos });
});
```

**Step 3: Handle init event conversation data**

In the `init` event listener in `sse.js`, add after existing setState:

```javascript
if (d.agentConversations) {
  setState({ agentConversations: d.agentConversations });
}
```

**Step 4: Commit**

```bash
git add public/src/state/store.js public/src/state/sse.js
git commit -m "feat(phase2): store + SSE wiring for agent conversation events"
```

---

## Task 4: Conversation Viewer Component

**Files:**
- Create: `public/src/components/ConversationView.js`
- Create: `public/src/styles/conversation.css`
- Modify: `public/index.html` (add CSS link)

**Step 1: Create ConversationView component**

This component renders parsed conversation events for a selected agent. It replaces the raw JSONL tail in the Agent Detail panel.

```javascript
// public/src/components/ConversationView.js
import { h } from '../lib/preact.module.js';
import { useRef, useEffect, useState } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '...' : str;
}

function ThinkingBlock({ content }) {
  const [expanded, setExpanded] = useState(false);
  const preview = truncate(content, 120);
  const needsExpand = content && content.length > 120;

  return html`
    <div class="conv-block conv-thinking" onClick=${() => needsExpand && setExpanded(!expanded)}>
      <div class="conv-block-label">
        <span class="conv-icon">&#x25C6;</span> Thinking
        ${needsExpand && html`<span class="conv-expand">${expanded ? '[-]' : '[+]'}</span>`}
      </div>
      <div class="conv-block-content">${expanded ? content : preview}</div>
    </div>
  `;
}

function TextBlock({ content }) {
  return html`
    <div class="conv-block conv-text">
      <div class="conv-block-content">${content}</div>
    </div>
  `;
}

function ToolCallBlock({ toolName, input }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  const preview = truncate(inputStr, 100);

  return html`
    <div class="conv-block conv-tool-call" onClick=${() => setExpanded(!expanded)}>
      <div class="conv-block-label">
        <span class="conv-icon">&#x25B8;</span> ${toolName}
        <span class="conv-expand">${expanded ? '[-]' : '[+]'}</span>
      </div>
      ${expanded && html`<pre class="conv-block-content">${inputStr}</pre>`}
      ${!expanded && html`<div class="conv-block-content conv-muted">${preview}</div>`}
    </div>
  `;
}

function ToolResultBlock({ content }) {
  const [expanded, setExpanded] = useState(false);
  const preview = truncate(content, 80);
  const needsExpand = content && content.length > 80;

  return html`
    <div class="conv-block conv-tool-result" onClick=${() => needsExpand && setExpanded(!expanded)}>
      <div class="conv-block-label">
        <span class="conv-icon">&#x25C0;</span> Result
        ${needsExpand && html`<span class="conv-expand">${expanded ? '[-]' : '[+]'}</span>`}
      </div>
      <div class="conv-block-content">${expanded ? content : preview}</div>
    </div>
  `;
}

export function ConversationView({ events }) {
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // Detect if user scrolled up (disable auto-scroll)
  function onScroll(e) {
    const el = e.target;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }

  if (!events || events.length === 0) {
    return html`<div class="conv-empty">No conversation data yet</div>`;
  }

  return html`
    <div class="conv-container" ref=${containerRef} onScroll=${onScroll}>
      ${events.map((evt, i) => {
        if (evt.type === 'thinking') return html`<${ThinkingBlock} key=${i} content=${evt.content} />`;
        if (evt.type === 'text') return html`<${TextBlock} key=${i} content=${evt.content} />`;
        if (evt.type === 'tool_call') return html`<${ToolCallBlock} key=${i} toolName=${evt.toolName} input=${evt.input} />`;
        if (evt.type === 'tool_result') return html`<${ToolResultBlock} key=${i} content=${evt.content} />`;
        return null;
      })}
      ${!autoScroll && html`
        <button class="conv-scroll-btn" onClick=${() => { setAutoScroll(true); }}>
          &#x25BC; Jump to latest
        </button>
      `}
    </div>
  `;
}
```

**Step 2: Create conversation.css**

```css
/* public/src/styles/conversation.css */

.conv-container {
  flex: 1;
  overflow-y: auto;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.5;
  position: relative;
  min-height: 0;
}

.conv-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
}

.conv-block {
  margin-bottom: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  border-left: 2px solid transparent;
}

.conv-block-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.conv-icon {
  font-size: 8px;
}

.conv-expand {
  margin-left: auto;
  font-size: 9px;
  color: var(--text-muted);
  cursor: pointer;
}

.conv-block-content {
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  max-height: 300px;
  overflow-y: auto;
}

.conv-block-content pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10px;
}

.conv-muted {
  color: var(--text-muted);
}

/* Thinking blocks */
.conv-thinking {
  border-left-color: var(--state-thinking);
  background: rgba(124, 92, 255, 0.05);
  cursor: pointer;
}
.conv-thinking .conv-block-label { color: var(--state-thinking); }

/* Text blocks */
.conv-text {
  border-left-color: var(--state-active);
  background: rgba(0, 255, 136, 0.04);
}
.conv-text .conv-block-label { color: var(--state-active); }
.conv-text .conv-block-content { color: var(--text-primary); }

/* Tool call blocks */
.conv-tool-call {
  border-left-color: var(--state-tool-use);
  background: rgba(255, 159, 28, 0.05);
  cursor: pointer;
}
.conv-tool-call .conv-block-label { color: var(--state-tool-use); }

/* Tool result blocks */
.conv-tool-result {
  border-left-color: var(--text-muted);
  background: rgba(255, 255, 255, 0.02);
  cursor: pointer;
}
.conv-tool-result .conv-block-label { color: var(--text-muted); }

/* Scroll to bottom button */
.conv-scroll-btn {
  position: sticky;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  display: block;
  margin: 4px auto 0;
  padding: 3px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-active);
  border-radius: 10px;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
}
.conv-scroll-btn:hover { background: var(--bg-hover); }
```

**Step 3: Add CSS link to index.html**

After the existing CSS links in `public/index.html`, add:
```html
<link rel="stylesheet" href="/src/styles/conversation.css">
```

**Step 4: Commit**

```bash
git add public/src/components/ConversationView.js public/src/styles/conversation.css public/index.html
git commit -m "feat(phase2): ConversationView component + styles"
```

---

## Task 5: Integrate ConversationView into AgentDetail

**Files:**
- Modify: `public/src/components/AgentDetail.js`

**Context:** Replace the raw JSONL tail section with a tabbed view: "Conversation" (default) and "Raw" (existing tail). The conversation view uses real-time parsed events from the store.

**Step 1: Import and integrate ConversationView**

Add import at top of `AgentDetail.js`:
```javascript
import { ConversationView } from './ConversationView.js';
```

Add `agentConversations` to the store subscriptions:
```javascript
const agentConversations = useStore(s => s.agentConversations);
```

Add a tab state for switching between conversation and raw views:
```javascript
const [detailTab, setDetailTab] = useState('conversation'); // 'conversation' | 'raw'
```

Replace the tail section (`${tailLines.length > 0 && html`<div class="agent-tail"...`) with:

```javascript
${html`
  <div class="agent-detail-tabs">
    <button class="tab-btn ${detailTab === 'conversation' ? 'active' : ''}"
      onClick=${() => setDetailTab('conversation')}>Conversation</button>
    <button class="tab-btn ${detailTab === 'raw' ? 'active' : ''}"
      onClick=${() => setDetailTab('raw')}>Raw</button>
  </div>
  ${detailTab === 'conversation'
    ? html`<${ConversationView} events=${agentConversations[selectedAgent] || []} />`
    : tailLines.length > 0
      ? html`<div class="agent-tail" ref=${tailRef}>${tailLines.join('\n')}</div>`
      : html`<div class="agent-tail" style="color:var(--text-muted)">No output yet</div>`
  }
`}
```

**Step 2: Add tab styles to agent-detail.css**

```css
/* Detail panel tabs */
.agent-detail-tabs {
  display: flex;
  gap: 0;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.tab-btn {
  flex: 1;
  padding: 5px 8px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast);
}
.tab-btn:hover { color: var(--text-secondary); }
.tab-btn.active {
  color: var(--text-primary);
  border-bottom-color: var(--state-thinking);
}
```

**Step 3: Commit**

```bash
git add public/src/components/AgentDetail.js public/src/styles/agent-detail.css
git commit -m "feat(phase2): integrate ConversationView into AgentDetail with tabs"
```

---

## Task 6: File Change Tracker — Server Side

**Files:**
- Modify: `server.cjs`

**Context:** Use `fs.watch` (recursive) on the project directory to detect file creates/modifies/deletes while a workflow is running. Broadcast `fileChange` SSE events. Track which agent likely made the change by correlating timestamps with agent activity.

**Step 1: Add file watcher state and functions**

Add to the state object in `server.cjs`:
```javascript
fileWatcher: null,           // fs.watch handle
fileChanges: [],             // [{path, type, agent, timestamp}] — capped at 500
```

Add a file watcher module near the helper functions:

```javascript
// --- File Change Tracking ---

function startFileWatcher(projectDir) {
  if (state.fileWatcher) return;
  if (!projectDir || !fs.existsSync(projectDir)) return;

  state.fileChanges = [];
  try {
    state.fileWatcher = fs.watch(projectDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Skip noise: .git, node_modules, .claude, hidden files
      if (filename.startsWith('.git/') || filename.startsWith('.git\\')) return;
      if (filename.includes('node_modules/') || filename.includes('node_modules\\')) return;
      if (filename.startsWith('.claude/') || filename.startsWith('.claude\\')) return;
      if (filename.endsWith('.jsonl')) return;

      const fullPath = path.join(projectDir, filename);
      let changeType;
      try {
        fs.statSync(fullPath);
        changeType = eventType === 'rename' ? 'create' : 'modify';
      } catch (_) {
        changeType = 'delete';
      }

      // Correlate with most recently active agent
      let likelyAgent = null;
      if (state.monitor) {
        const agents = state.monitor.getAll();
        let latestActivity = 0;
        for (const [name, info] of Object.entries(agents)) {
          if (info.state !== 'idle' && info.lastActivity > latestActivity) {
            latestActivity = info.lastActivity;
            likelyAgent = name;
          }
        }
      }

      const evt = {
        path: filename,
        type: changeType,
        agent: likelyAgent,
        timestamp: Date.now(),
      };

      state.fileChanges.push(evt);
      if (state.fileChanges.length > 500) state.fileChanges.shift();

      broadcast('fileChange', evt);
    });
  } catch (e) {
    // fs.watch may not support recursive on all platforms
    console.error('File watcher failed:', e.message);
  }
}

function stopFileWatcher() {
  if (state.fileWatcher) {
    state.fileWatcher.close();
    state.fileWatcher = null;
  }
}
```

**Step 2: Start/stop file watcher with workflow lifecycle**

In `spawnExecutionPhase()` (or wherever `state.workflowStartedAt` is set), add after the monitor is created:

```javascript
const projectDir = findProjectDir();
if (projectDir) startFileWatcher(projectDir);
```

In `finishRun()`, add before clearing state:

```javascript
stopFileWatcher();
```

In the `estop` handler, add:

```javascript
stopFileWatcher();
```

**Step 3: Add file changes to SSE init and add diff endpoint**

In the `/api/stream` init data, add:
```javascript
initData.fileChanges = state.fileChanges || [];
```

Add a new route before the static files section:

```javascript
if (pathname === '/api/files/diff' && req.method === 'GET') {
  const filePath = url.searchParams.get('path');
  if (!filePath) return sendJson(res, 400, { error: 'path parameter required' });
  try {
    const projectDir = findProjectDir();
    if (!projectDir) return sendJson(res, 404, { error: 'No project directory' });
    const diff = execSync(`git diff -- ${JSON.stringify(filePath)}`, {
      cwd: projectDir, encoding: 'utf-8', timeout: 5000,
    });
    return sendJson(res, 200, { path: filePath, diff: diff || '(no changes)' });
  } catch (e) {
    return sendJson(res, 200, { path: filePath, diff: '(git diff unavailable)' });
  }
}
```

**Step 4: Commit**

```bash
git add server.cjs
git commit -m "feat(phase2): file change tracker with fs.watch + diff endpoint"
```

---

## Task 7: File Change Tracker — Dashboard

**Files:**
- Create: `public/src/components/FileChanges.js`
- Modify: `public/src/state/store.js`
- Modify: `public/src/state/sse.js`
- Modify: `public/src/state/api.js`
- Modify: `public/src/components/AgentDetail.js`
- Modify: `public/src/styles/agent-detail.css`

**Step 1: Add file changes to store**

In `store.js`, add to initial state:
```javascript
fileChanges: [],  // [{path, type, agent, timestamp}]
```

**Step 2: Handle fileChange SSE event in sse.js**

```javascript
eventSource.addEventListener('fileChange', (e) => {
  const d = JSON.parse(e.data);
  const changes = [...getState().fileChanges, d];
  if (changes.length > 500) changes.splice(0, changes.length - 500);
  setState({ fileChanges: changes });
});
```

In the `init` handler:
```javascript
if (d.fileChanges) setState({ fileChanges: d.fileChanges });
```

**Step 3: Add getDiff to api.js**

```javascript
export async function getFileDiff(filePath) {
  const res = await fetch(`/api/files/diff?path=${encodeURIComponent(filePath)}`);
  return res.json();
}
```

**Step 4: Create FileChanges component**

```javascript
// public/src/components/FileChanges.js
import { h } from '../lib/preact.module.js';
import { useState } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { getFileDiff } from '../state/api.js';

function changeIcon(type) {
  if (type === 'create') return '+';
  if (type === 'delete') return 'x';
  return '~';
}

function changeColor(type) {
  if (type === 'create') return 'var(--state-active)';
  if (type === 'delete') return 'var(--state-failed)';
  return 'var(--state-tool-use)';
}

export function FileChanges({ changes }) {
  const [diffPath, setDiffPath] = useState(null);
  const [diffContent, setDiffContent] = useState('');

  async function showDiff(filePath) {
    if (diffPath === filePath) { setDiffPath(null); return; }
    setDiffPath(filePath);
    setDiffContent('Loading...');
    try {
      const data = await getFileDiff(filePath);
      setDiffContent(data.diff || '(empty)');
    } catch (_) {
      setDiffContent('(failed to load diff)');
    }
  }

  if (!changes || changes.length === 0) {
    return html`<div class="conv-empty">No file changes tracked</div>`;
  }

  // Deduplicate: keep latest change per path
  const byPath = new Map();
  for (const c of changes) {
    byPath.set(c.path, c);
  }
  const unique = [...byPath.values()].sort((a, b) => b.timestamp - a.timestamp);

  return html`
    <div class="file-changes-list">
      ${unique.map(c => html`
        <div class="file-change-row" onClick=${() => showDiff(c.path)}>
          <span class="file-change-icon" style="color:${changeColor(c.type)}">${changeIcon(c.type)}</span>
          <span class="file-change-path">${c.path}</span>
          ${c.agent && html`<span class="file-change-agent">${c.agent}</span>`}
        </div>
        ${diffPath === c.path && html`
          <pre class="file-change-diff">${diffContent}</pre>
        `}
      `)}
    </div>
  `;
}
```

**Step 5: Add a "Files" tab to AgentDetail**

In `AgentDetail.js`, add import:
```javascript
import { FileChanges } from './FileChanges.js';
```

Subscribe to `fileChanges` from the store:
```javascript
const fileChanges = useStore(s => s.fileChanges);
```

Update the tab state to support 3 tabs: `'conversation' | 'files' | 'raw'`

Update the tabs section:
```javascript
<div class="agent-detail-tabs">
  <button class="tab-btn ${detailTab === 'conversation' ? 'active' : ''}"
    onClick=${() => setDetailTab('conversation')}>Conversation</button>
  <button class="tab-btn ${detailTab === 'files' ? 'active' : ''}"
    onClick=${() => setDetailTab('files')}>Files</button>
  <button class="tab-btn ${detailTab === 'raw' ? 'active' : ''}"
    onClick=${() => setDetailTab('raw')}>Raw</button>
</div>
```

For the files tab content, filter changes to the selected agent:
```javascript
${detailTab === 'files'
  ? html`<${FileChanges} changes=${fileChanges.filter(c => c.agent === selectedAgent)} />`
  : ...
}
```

**Step 6: Add file changes styles to agent-detail.css**

```css
/* File changes */
.file-changes-list {
  padding: 6px 10px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.file-change-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  cursor: pointer;
  border-radius: 3px;
}
.file-change-row:hover { background: var(--bg-hover); }
.file-change-icon {
  font-weight: 700;
  width: 12px;
  text-align: center;
  flex-shrink: 0;
}
.file-change-path {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.file-change-agent {
  color: var(--text-muted);
  font-size: 9px;
  flex-shrink: 0;
}
.file-change-diff {
  margin: 2px 0 6px 18px;
  padding: 6px 8px;
  background: var(--bg-void);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.4;
}
```

**Step 7: Commit**

```bash
git add public/src/components/FileChanges.js public/src/state/store.js public/src/state/sse.js public/src/state/api.js public/src/components/AgentDetail.js public/src/styles/agent-detail.css
git commit -m "feat(phase2): file changes component with inline diff in AgentDetail"
```

---

## Task 8: Run History — Server Persistence

**Files:**
- Modify: `server.cjs`

**Context:** On workflow completion, save the full run data to `~/.multi-claude/history/<timestamp>.json`. Add endpoints to list, load, and compare runs.

**Step 1: Add history directory constant and save function**

```javascript
const HISTORY_DIR = path.join(os.homedir(), '.multi-claude', 'history');

function saveRunHistory() {
  try {
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const id = ts;

    // Gather agent token data
    const agentTokens = {};
    if (state.monitor) {
      const all = state.monitor.getAll();
      for (const [name, info] of Object.entries(all)) {
        agentTokens[name] = { ...info.tokens };
      }
    }

    const runData = {
      id,
      goal: state.goal,
      model: state.model,
      startedAt: state.workflowStartedAt,
      finishedAt: Date.now(),
      duration: state.workflowStartedAt ? Date.now() - state.workflowStartedAt : 0,
      outcome: determineOutcome(),
      iterations: state.iterations,
      taskPlan: state.taskPlan,
      taskStatus: state.taskStatus,
      agentTokens,
      fileChanges: state.fileChanges || [],
      postChecks: state.postChecks,
      summary: generateWorkflowSummary(),
    };

    const filePath = path.join(HISTORY_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(runData, null, 2));
    return id;
  } catch (e) {
    console.error('Failed to save run history:', e.message);
    return null;
  }
}

function determineOutcome() {
  const statuses = Object.values(state.taskStatus);
  if (statuses.some(t => t.status === 'failed' || t.status === 'timed_out')) return 'failure';
  if (statuses.every(t => t.status === 'completed' || t.status === 'completed_with_errors')) return 'success';
  return 'partial';
}
```

**Step 2: Call saveRunHistory from finishRun**

In `finishRun()`, add before the "Save project memory" section:

```javascript
// Save run history
saveRunHistory();
```

**Step 3: Add history API endpoints**

Add these routes before the `estop` handler:

```javascript
// --- History endpoints ---

if (pathname === '/api/history' && req.method === 'GET') {
  try {
    if (!fs.existsSync(HISTORY_DIR)) return sendJson(res, 200, { runs: [] });
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    const runs = files.slice(0, 50).map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf-8'));
        return {
          id: data.id,
          goal: data.goal,
          model: data.model,
          startedAt: data.startedAt,
          finishedAt: data.finishedAt,
          duration: data.duration,
          outcome: data.outcome,
          taskCount: data.taskPlan?.tasks?.length || 0,
        };
      } catch (_) { return null; }
    }).filter(Boolean);
    return sendJson(res, 200, { runs });
  } catch (e) {
    return sendJson(res, 500, { error: 'Failed to read history' });
  }
}

const historyMatch = pathname.match(/^\/api\/history\/(.+)$/);
if (historyMatch && req.method === 'GET') {
  const id = decodeURIComponent(historyMatch[1]);

  // Compare mode: /api/history/compare/idA/idB
  const compareMatch = id.match(/^compare\/(.+?)\/(.+)$/);
  if (compareMatch) {
    const [, idA, idB] = compareMatch;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, `${idA}.json`), 'utf-8'));
      const b = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, `${idB}.json`), 'utf-8'));
      return sendJson(res, 200, { a, b });
    } catch (e) {
      return sendJson(res, 404, { error: 'Run not found' });
    }
  }

  // Single run: /api/history/:id
  try {
    const filePath = path.join(HISTORY_DIR, `${id}.json`);
    if (!filePath.startsWith(HISTORY_DIR)) return sendJson(res, 403, { error: 'Forbidden' });
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return sendJson(res, 200, data);
  } catch (e) {
    return sendJson(res, 404, { error: 'Run not found' });
  }
}
```

**Step 4: Commit**

```bash
git add server.cjs
git commit -m "feat(phase2): run history persistence + list/load/compare API"
```

---

## Task 9: History API Client Functions

**Files:**
- Modify: `public/src/state/api.js`

**Step 1: Add history API functions**

```javascript
export async function getHistoryList() {
  const res = await fetch('/api/history');
  return res.json();
}

export async function getHistoryRun(id) {
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`);
  return res.json();
}

export async function getHistoryCompare(idA, idB) {
  const res = await fetch(`/api/history/compare/${encodeURIComponent(idA)}/${encodeURIComponent(idB)}`);
  return res.json();
}
```

**Step 2: Commit**

```bash
git add public/src/state/api.js
git commit -m "feat(phase2): history API client functions"
```

---

## Task 10: History View Component

**Files:**
- Create: `public/src/components/HistoryView.js`
- Create: `public/src/styles/history.css`
- Modify: `public/index.html` (add CSS link)
- Modify: `public/src/state/store.js`

**Step 1: Add history UI state to store**

In `store.js`, add to initial state:
```javascript
showHistory: false,
historyRuns: [],       // [{id, goal, model, outcome, duration, taskCount, ...}]
historySelectedRun: null, // full run data when viewing detail
```

**Step 2: Create HistoryView component**

```javascript
// public/src/components/HistoryView.js
import { h } from '../lib/preact.module.js';
import { useState, useEffect } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState } from '../state/store.js';
import { getHistoryList, getHistoryRun } from '../state/api.js';

function fmtDuration(ms) {
  if (!ms) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function outcomeBadge(outcome) {
  const colors = { success: 'var(--state-completed)', failure: 'var(--state-failed)', partial: 'var(--state-retrying)' };
  return html`<span class="history-badge" style="background:${colors[outcome] || 'var(--text-muted)'};">${outcome}</span>`;
}

function RunDetail({ run, onBack }) {
  if (!run) return null;

  const taskEntries = Object.entries(run.taskStatus || {});

  return html`
    <div class="history-detail">
      <div class="history-detail-header">
        <button class="history-back-btn" onClick=${onBack}>< Back</button>
        <div class="history-detail-goal">${run.goal}</div>
        ${outcomeBadge(run.outcome)}
      </div>
      <div class="history-detail-meta">
        <span>${run.model}</span>
        <span>${fmtDate(run.startedAt)}</span>
        <span>${fmtDuration(run.duration)}</span>
        <span>${taskEntries.length} tasks</span>
      </div>
      <div class="history-detail-section">
        <div class="agent-section-title">Tasks</div>
        ${taskEntries.map(([name, ts]) => html`
          <div class="history-task-row">
            <span class="history-task-name">${name}</span>
            <span class="history-badge" style="background:${ts.status === 'completed' ? 'var(--state-completed)' : ts.status === 'failed' ? 'var(--state-failed)' : 'var(--text-muted)'};">
              ${ts.status}
            </span>
            ${ts.attempts > 1 && html`<span class="history-retry-badge">${ts.attempts}x</span>`}
          </div>
        `)}
      </div>
      ${run.fileChanges && run.fileChanges.length > 0 && html`
        <div class="history-detail-section">
          <div class="agent-section-title">File Changes (${run.fileChanges.length})</div>
          <div class="file-changes-list">
            ${run.fileChanges.slice(0, 50).map(c => html`
              <div class="file-change-row">
                <span class="file-change-icon" style="color:${c.type === 'create' ? 'var(--state-active)' : c.type === 'delete' ? 'var(--state-failed)' : 'var(--state-tool-use)'}">${c.type === 'create' ? '+' : c.type === 'delete' ? 'x' : '~'}</span>
                <span class="file-change-path">${c.path}</span>
              </div>
            `)}
          </div>
        </div>
      `}
      ${run.summary && html`
        <div class="history-detail-section">
          <div class="agent-section-title">Summary</div>
          <pre class="history-summary">${run.summary}</pre>
        </div>
      `}
    </div>
  `;
}

export function HistoryView() {
  const show = useStore(s => s.showHistory);
  const runs = useStore(s => s.historyRuns);
  const selectedRun = useStore(s => s.historySelectedRun);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (show && runs.length === 0) {
      setLoading(true);
      getHistoryList().then(data => {
        setState({ historyRuns: data.runs || [] });
        setLoading(false);
      }).catch(() => setLoading(false));
    }
  }, [show]);

  if (!show) return null;

  async function viewRun(id) {
    const data = await getHistoryRun(id);
    setState({ historySelectedRun: data });
  }

  function close() {
    setState({ showHistory: false, historySelectedRun: null });
  }

  const filtered = search
    ? runs.filter(r => r.goal.toLowerCase().includes(search.toLowerCase()))
    : runs;

  return html`
    <div class="history-overlay" onClick=${(e) => e.target.classList.contains('history-overlay') && close()}>
      <div class="history-panel">
        <div class="history-header">
          <span class="history-title">Run History</span>
          <button class="history-close" onClick=${close}>x</button>
        </div>

        ${selectedRun
          ? html`<${RunDetail} run=${selectedRun} onBack=${() => setState({ historySelectedRun: null })} />`
          : html`
            <div class="history-search">
              <input placeholder="Search goals..." value=${search}
                onInput=${e => setSearch(e.target.value)} />
            </div>
            <div class="history-list">
              ${loading && html`<div class="conv-empty">Loading...</div>`}
              ${!loading && filtered.length === 0 && html`<div class="conv-empty">No runs found</div>`}
              ${filtered.map(r => html`
                <div class="history-run-card" onClick=${() => viewRun(r.id)}>
                  <div class="history-run-goal">${r.goal}</div>
                  <div class="history-run-meta">
                    ${outcomeBadge(r.outcome)}
                    <span>${r.model}</span>
                    <span>${fmtDuration(r.duration)}</span>
                    <span>${r.taskCount} tasks</span>
                    <span>${fmtDate(r.startedAt)}</span>
                  </div>
                </div>
              `)}
            </div>
          `
        }
      </div>
    </div>
  `;
}
```

**Step 3: Create history.css**

```css
/* public/src/styles/history.css */

.history-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}

.history-panel {
  width: 700px;
  max-width: 90vw;
  max-height: 80vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-active);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.history-title {
  font-size: var(--text-lg);
  font-weight: 700;
  color: var(--text-primary);
}

.history-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
}
.history-close:hover { color: var(--text-primary); }

.history-search {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.history-search input {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-void);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: var(--text-xs);
  outline: none;
}
.history-search input:focus { border-color: var(--state-thinking); }

.history-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.history-run-card {
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background var(--transition-fast);
}
.history-run-card:hover { background: var(--bg-hover); }

.history-run-goal {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
  margin-bottom: 6px;
}

.history-run-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-secondary);
}

.history-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  color: #000;
  text-transform: uppercase;
}

/* Detail view */
.history-detail {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}

.history-detail-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.history-back-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-secondary);
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}
.history-back-btn:hover { background: var(--bg-hover); }

.history-detail-goal {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.history-detail-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.history-detail-section {
  margin-bottom: 16px;
}

.history-task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 11px;
}

.history-task-name {
  font-family: var(--font-mono);
  color: var(--text-primary);
  flex: 1;
}

.history-retry-badge {
  font-size: 9px;
  color: var(--state-retrying);
  font-weight: 600;
}

.history-summary {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  line-height: 1.5;
}
```

**Step 4: Add CSS link to index.html**

```html
<link rel="stylesheet" href="/src/styles/history.css">
```

**Step 5: Commit**

```bash
git add public/src/components/HistoryView.js public/src/styles/history.css public/src/state/store.js public/index.html
git commit -m "feat(phase2): HistoryView component with run list, search, and detail"
```

---

## Task 11: Integrate History Into App + Command Palette

**Files:**
- Modify: `public/src/app.js`
- Modify: `public/src/components/CommandPalette.js`

**Step 1: Add HistoryView to app.js**

Add import:
```javascript
import { HistoryView } from './components/HistoryView.js';
```

Add to the render output, after `<${CommandPalette} />`:
```javascript
<${HistoryView} />
```

**Step 2: Add history command to CommandPalette**

Read the current CommandPalette.js to understand its command list format. Add a "Run History" command that sets `showHistory: true`. Also add `showCommandPalette: false` when opening history:

```javascript
{ label: 'Run History', desc: 'View past runs', action: () => setState({ showHistory: true, showCommandPalette: false }) },
```

**Step 3: Add keyboard shortcut for history**

In `app.js`, add to the `handleKey` function (after the Escape handler):

```javascript
if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
  e.preventDefault();
  setState({ showHistory: !getState().showHistory });
  return;
}
```

**Step 4: Commit**

```bash
git add public/src/app.js public/src/components/CommandPalette.js
git commit -m "feat(phase2): integrate HistoryView into app + command palette + Ctrl+H shortcut"
```

---

## Task 12: Context Window Size Warning

**Files:**
- Modify: `jsonl-monitor.cjs`
- Modify: `server.cjs`
- Modify: `public/src/components/AgentDetail.js`

**Context:** When an agent's total token usage approaches the context window limit, show a warning in the dashboard. Claude's context window is ~200K tokens. Warn at 150K total (input + cache_read).

**Step 1: Add context warning to JsonlMonitor**

In `_processLine()`, after accumulating tokens, check if nearing limit:

```javascript
const totalContext = info.tokens.input + info.tokens.cacheRead;
if (totalContext > 150000 && !info.contextWarned) {
  info.contextWarned = true;
  this.emit('contextWarning', tmuxName, { totalContext, limit: 200000 });
}
```

Add `contextWarned: false` to session info in `registerSession()`.

**Step 2: Broadcast context warning from server**

Where monitor events are wired:

```javascript
state.monitor.on("contextWarning", (name, data) => {
  broadcast("contextWarning", { agent: name, ...data });
});
```

**Step 3: Show warning in AgentDetail**

In the `sse.js` handler, track warnings:
```javascript
eventSource.addEventListener('contextWarning', (e) => {
  const d = JSON.parse(e.data);
  const warnings = { ...getState().contextWarnings, [d.agent]: d };
  setState({ contextWarnings: warnings });
});
```

Add to store initial state:
```javascript
contextWarnings: {},  // name → { totalContext, limit }
```

In `AgentDetail.js`, subscribe and render warning:
```javascript
const contextWarnings = useStore(s => s.contextWarnings);
// ...
${contextWarnings[selectedAgent] && html`
  <div class="agent-section" style="background:rgba(239,71,111,0.1);border-left:3px solid var(--state-failed);">
    <div class="agent-section-title" style="color:var(--state-failed);">Context Warning</div>
    <div class="agent-section-body" style="color:var(--state-failed);">
      ${Math.round(contextWarnings[selectedAgent].totalContext / 1000)}K / ${Math.round(contextWarnings[selectedAgent].limit / 1000)}K tokens used.
      Agent may lose early context.
    </div>
  </div>
`}
```

Place this after the error section, before the tabs.

**Step 4: Commit**

```bash
git add jsonl-monitor.cjs server.cjs public/src/state/store.js public/src/state/sse.js public/src/components/AgentDetail.js
git commit -m "feat(phase2): context window size warning at 150K tokens"
```

---

## Task 13: Update Keyboard Shortcut Hint + Clean Up

**Files:**
- Modify: `public/src/app.js`

**Step 1: Update shortcut hint to include new shortcuts**

```javascript
<div class="shortcut-hint">\u2318K palette \u00b7 \u2318H history \u00b7 1-9 agents \u00b7 Space pause \u00b7 Esc deselect</div>
```

**Step 2: Commit**

```bash
git add public/src/app.js
git commit -m "feat(phase2): update keyboard shortcut hints"
```

---

## Task 14: Final Integration Commit

**Step 1: Verify all files are committed**

```bash
git status
```

**Step 2: Create summary commit (if needed)**

```bash
git add -A
git commit -m "feat: HiveMind Phase 2 — Deep Visibility (conversation streaming, file tracker, run history)"
```

---

## Summary of All Changes

### Server (`server.cjs`)
- New SSE event: `agentConversation` — parsed conversation blocks
- New SSE event: `fileChange` — fs.watch file change events
- New SSE event: `contextWarning` — agent nearing context limit
- New endpoint: `GET /api/files/diff?path=...` — git diff for file
- New endpoint: `GET /api/history` — list past runs
- New endpoint: `GET /api/history/:id` — load specific run
- New endpoint: `GET /api/history/compare/:a/:b` — compare two runs
- `finishRun()` now saves run history to `~/.multi-claude/history/`
- File watcher starts/stops with workflow lifecycle
- Init SSE event includes conversation buffers and file changes

### JSONL Monitor (`jsonl-monitor.cjs`)
- New event: `conversation` — emits parsed thinking/text/tool_call/tool_result blocks
- New event: `contextWarning` — fires when agent exceeds 150K context tokens
- New method: `getConversation(name)` — returns buffered events for late-joining clients
- Session info extended with `conversationBuffer` and `contextWarned`

### Dashboard (New Files)
- `public/src/components/ConversationView.js` — real-time conversation stream viewer
- `public/src/components/FileChanges.js` — file change list with inline diff
- `public/src/components/HistoryView.js` — overlay with run list, search, detail view
- `public/src/styles/conversation.css` — conversation block styles
- `public/src/styles/history.css` — history overlay styles

### Dashboard (Modified Files)
- `public/src/components/AgentDetail.js` — tabbed view (Conversation/Files/Raw), context warning
- `public/src/components/CommandPalette.js` — "Run History" command added
- `public/src/state/store.js` — new state: agentConversations, fileChanges, contextWarnings, showHistory, historyRuns, historySelectedRun
- `public/src/state/sse.js` — handlers for agentConversation, fileChange, contextWarning events
- `public/src/state/api.js` — getFileDiff, getHistoryList, getHistoryRun, getHistoryCompare
- `public/src/app.js` — HistoryView integration, Ctrl+H shortcut, updated hints
- `public/index.html` — new CSS links
- `public/src/styles/agent-detail.css` — tab styles, file change styles

### Zero new npm dependencies.
