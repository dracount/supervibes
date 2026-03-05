# HiveMind — Multi-Claude Orchestration Dashboard Redesign

**Date**: 2026-03-05
**Status**: Approved (Claude + Gemini Pro + Gemini Flash consensus)
**Scope**: Full UI/UX redesign — phased from visual overhaul to infrastructure evolution

---

## 1. Vision

Transform the Multi-Claude dashboard from a "log viewer" into a **Mission Control** paradigm — NASA ground control meets Grafana meets Bloomberg Terminal. The user commands a fleet of AI agents with real-time telemetry, spatial awareness, live intervention, and historical analysis.

**Core experience**: Data-dense, dark, every pixel earns its place. The normal/healthy state is quiet; only issues scream for attention.

---

## 2. Phased Architecture

### Phase 1 — "Mission Control" (MVP)

**Goal**: Transform the dashboard from passive monitor to active command center.

**Technology**: Preact + HTM (tagged template literals) via ESM — zero build step, ~4KB total framework overhead. Native ES modules for file separation. Single `index.html` entry point imports `app.js`, which imports component modules.

**Deliverables**:
- Dependency graph as interactive centerpiece (SVG, manual topological layout)
- New visual design language (void theme, state-driven color system)
- Agent Detail Panel replacing terminals sidebar
- Intervention system (pause/inject/approve/kill via new API endpoints)
- Global Emergency Stop (kill -9 all processes immediately, don't wait for graceful shutdown)
- Simple JSONL tail in Agent Detail Panel (moved up from Phase 2)
- "Human" node type — tasks route to user for input/approval
- Redesigned Activity Feed with inline intervention actions
- Keyboard shortcuts + Cmd+K command palette
- Telemetry bar (cost burn rate, token flow, task progress)

**New server endpoints**:
- `POST /api/agent/:name/pause` — pause tmux session (SIGSTOP)
- `POST /api/agent/:name/resume` — resume tmux session (SIGCONT)
- `POST /api/agent/:name/inject` — send custom prompt mid-run
- `POST /api/agent/:name/kill` — kill with optional restart
- `POST /api/agent/:name/approve` — resolve human gate, unblock dependents
- `POST /api/estop` — emergency halt all agents (kill -9, save state)
- `GET /api/agent/:name/tail` — stream last N lines of JSONL session

**New SSE events**:
- `intervention` — broadcast when human intervenes (appears in feed)
- `humanGate` — notify dashboard a task is waiting for human input

**Zero new npm dependencies.**

### Phase 2 — "Deep Visibility"

**Goal**: See inside every agent. Record everything. Compare and learn.

**Technology additions**: elkjs (~80KB, proper Sugiyama graph layout), optional Vite dev mode (still builds to single bundle for production).

**Deliverables**:
- Full conversation streaming in Agent Detail Panel (parsed tool calls, thinking, responses)
- File change tracker with inline diff view (fs.watch on project dir)
- Run history persistence (`~/.multi-claude/history/<timestamp>.json`)
- History view with search/filter
- Compare mode (side-by-side run metrics and timelines)
- Replay mode with timeline scrubber
- elkjs graph layout for larger DAGs (10+ nodes)
- Context window size warnings (prevent DOM crash from large JSONL)
- Virtualized/paginated conversation view

**New server capabilities**:
- `SSE agentConversation` — parsed JSONL conversation events (tool calls, responses, thinking)
- `SSE fileChange` — fs.watch events on project directory
- `GET /api/files/diff` — git diff for specific file
- `GET /api/history` — list past runs
- `GET /api/history/:id` — load specific run
- `GET /api/history/compare/:a/:b` — comparison data
- Auto-save run data on workflow completion

**New npm dependencies**: elkjs (graph layout)

### Phase 3 — "HiveMind"

**Goal**: Production-grade, cross-platform, extensible platform.

**Technology migration**: Preact + Vite build system, Canvas/WebGL graph rendering, SQLite persistence, node-pty execution.

**Deliverables**:
- node-pty replacing tmux (cross-platform: Windows, Mac, Linux without tmux)
- SQLite for persistent history + cross-run analytics (better-sqlite3)
- Canvas 2D graph rendering for large DAGs (50+ nodes), WebGL fallback
- Plugin/extension system (hook into lifecycle events, add custom panels)
- WebSocket + xterm.js for terminal streaming
- Agent branching/forking ("duplicate agent state, try two prompts")
- Token bidding system (agents request higher limits from orchestrator)
- MAX_CONCURRENT_AGENTS limiter (prevent API rate limit hits)
- Structured pub/sub agent communication (in-process, Redis adapter for multi-machine)
- Optional Docker isolation per agent

**New npm dependencies**: node-pty, better-sqlite3, vite (dev), xterm.js

---

## 3. Visual Design Language

### Color System

```css
/* Background layers */
--bg-void:     #0a0a12;    /* deepest — canvas */
--bg-surface:  #12121e;    /* cards, panels */
--bg-elevated: #1a1a2e;    /* modals, popovers */
--bg-hover:    #222240;    /* interactive hover */

/* Agent state spectrum */
--state-active:    #00ff88;  /* neon green — working */
--state-thinking:  #7c5cff;  /* electric purple — reasoning */
--state-tool-use:  #ff9f1c;  /* amber — executing tools */
--state-waiting:   #3a86ff;  /* blue — blocked/waiting */
--state-completed: #06d6a0;  /* teal — done */
--state-failed:    #ef476f;  /* coral red — error */
--state-retrying:  #ffd166;  /* gold — retry in progress */
--state-idle:      #404060;  /* muted — not running */
--state-human:     #e040fb;  /* magenta — waiting for human */

/* Telemetry */
--telem-cost:   #ff6b6b;  /* money — slightly alarming */
--telem-tokens: #4ecdc4;  /* token flow — cool */
--telem-time:   #ffe66d;  /* elapsed — warm */

/* Text */
--text-primary:   #e8e8f0;
--text-secondary: #8888a8;
--text-muted:     #555570;

/* Borders */
--border-subtle: rgba(255, 255, 255, 0.06);
--border-active: rgba(255, 255, 255, 0.12);
```

### Typography

- **UI text**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`
- **Monospace/data**: `"JetBrains Mono", "SF Mono", "Fira Code", Menlo, Consolas, monospace`
- **Sizes**: 11px data values, 13px body text, 14px labels/headers, 18px section titles

### Animation & Effects

- **State transitions**: 150ms ease-out
- **Panel reveals**: 300ms ease-out
- **Glow effects**: Only on selected node + error states (avoid perf issues with many glowing elements)
- **Pulse**: Only for `retrying` and `human-gate` states
- **Hardware acceleration**: Use `transform` and `opacity` for animations, avoid `box-shadow` animation on multiple elements
- **Healthy = quiet**: Normal running state should be visually calm. Only anomalies draw the eye.

---

## 4. Information Architecture

### Primary Dashboard Layout

```
+------------------------------------------------------------------+
| COMMAND BAR                                                       |
| [goal input]  [controls]  |  elapsed  cost  tokens  progress     |
+---------------------------+--------------------------------------+
|                           |                                      |
|    TOPOLOGY GRAPH         |    AGENT DETAIL PANEL                |
|    (dependency DAG)       |    (selected agent deep-dive)        |
|                           |                                      |
|    [nodes + edges]        |    Status / Task / Files / Telemetry |
|                           |    [Conversation tail]               |
|                           |    [Pause] [Inject] [Restart]        |
+---------------------------+--------------------------------------+
| ACTIVITY FEED  [filters]  |  inline intervention actions         |
+------------------------------------------------------------------+
```

- Graph and Detail Panel split the main area (~60/40)
- Activity Feed is a collapsible bottom panel
- All panels are resizable via drag handles
- Keyboard-driven: `1-9` select agents, `Space` pause, `I` inject, `G` toggle graph/list

### Overlay Views

| View | Trigger | Phase |
|------|---------|-------|
| Command Palette | Cmd+K | 1 |
| History | Cmd+K → "history" | 2 |
| Compare | Select 2 runs in History | 2 |
| Replay | Click "replay" on history entry | 2 |
| Settings | Gear icon or Cmd+K → "settings" | 1 |

---

## 5. Core Components

### 5.1 Command Bar

**Phase 1.** Replaces current header + controls bar.

**Idle state**:
```
 HiveMind   [Enter your goal...                ]  Sonnet v  Auto v  0 iters v  [x] Structured   [> START]
```

**Running state** (controls collapse, telemetry appears):
```
 HiveMind   "Build a space shooter game"   [|| PAUSE ALL]  [X E-STOP]
 3:42 elapsed   $2.14 ($0.009/s)   45.2K tokens   [====------] 4/6 tasks
```

### 5.2 Topology Graph

**Phase 1.** The centerpiece. SVG-rendered dependency DAG.

**Node anatomy**:
```
+-------------------+
| * api             |  <- state dot (colored) + name
| Sr. Backend Eng   |  <- role (muted)
| [========--] 78%  |  <- progress bar
| 12.4K tok  $0.38  |  <- telemetry
+-------------------+
```

**Layout algorithm** (Phase 1, manual):
1. `computeExecutionPhases()` already gives us parallel groups
2. Phase index → x-position (column), evenly spaced
3. Within phase → y-position (stacked, centered)
4. Edges: SVG `<path>` with cubic bezier curves
5. Phase labels above each column

**Human node** (special):
```
+-------------------+
| @ HUMAN           |  <- magenta state dot
| Waiting for input |
| "Please provide   |
|  the API key..."  |
| [Respond] [Skip]  |
+-------------------+
```

**Interactions**:
- Click → select (opens Detail Panel)
- Right-click → context menu: Pause, Kill, Restart, Inject, View Conversation
- Edges: animated dashes when dependency is pending, solid green when resolved

### 5.3 Agent Detail Panel

**Phase 1.** Right sidebar showing deep info about selected agent.

**Sections** (all collapsible):
1. **Header**: Name, role, state badge, elapsed time
2. **Task**: Description, owned files, expected output checklist (checkmarks update live)
3. **Retry/Timeout**: Attempt count, timeout bar, retry logic type
4. **Prompts Sent**: All prompts injected by controller or human
5. **JSONL Tail**: Last ~50 lines of agent session (auto-scrolling via `overflow-anchor: auto`)
6. **Telemetry**: Token breakdown (in/out/cache), cost
7. **Actions**: [Pause] [Inject Prompt] [Kill & Restart] buttons

**Phase 2 additions**:
- Full conversation stream (tool calls, thinking, responses — parsed from JSONL)
- File changes panel (files created/modified by this agent)

### 5.4 Activity Feed

**Phase 1.** Bottom panel, redesigned from current log.

**Features**:
- Filter chips: All | Errors | Agent: [name] | Phase: [n]
- Inline action buttons on failure events: [Retry] [Inject Fix] [Skip]
- Click any entry → selects that agent in graph
- Color-coded by event type (same state colors)
- Merged consecutive thinking entries (existing behavior, kept)

### 5.5 Command Palette

**Phase 1.** Triggered by Cmd+K.

**Actions**:
- Jump to agent by name
- Toggle views (graph/list, raw log)
- Quick actions: pause all, resume all, E-stop
- Search activity feed
- (Phase 2) Search history, open compare

### 5.6 History View (Phase 2)

Run cards with: goal, outcome badge, cost, duration, task count, model used.

**Actions per run**: Replay, Compare, Fork (re-run with modified plan), Delete.

**Search/filter**: By goal text, date range, model, outcome, cost range.

### 5.7 Compare View (Phase 2)

Side-by-side metrics:
- Duration, cost, tokens, tasks passed/failed, retries
- Parallel task timeline bars
- Auto-generated verdict ("Opus was 40% faster but 4.2x more expensive")

### 5.8 Replay Mode (Phase 2)

Timeline scrubber that replays the saved event stream. Graph animates to match replay position. Playback speed: 1x, 2x, 4x, 10x.

---

## 6. Server Capabilities

### Phase 1 — New Endpoints

```
POST /api/agent/:name/pause     Pause agent (SIGSTOP to tmux pane process)
POST /api/agent/:name/resume    Resume agent (SIGCONT)
POST /api/agent/:name/inject    Send custom prompt to agent mid-run
     Body: { prompt: "..." }
POST /api/agent/:name/kill      Kill agent, optionally restart
     Body: { restart: true/false }
POST /api/agent/:name/approve   Resolve human gate, unblock dependents
     Body: { response: "..." }  (optional human input)
POST /api/estop                 Emergency halt — kill -9 ALL processes immediately
GET  /api/agent/:name/tail      Last N lines of JSONL session
     Query: ?lines=50
```

### Phase 1 — New SSE Events

```
intervention    { agent, action, timestamp, detail }
humanGate       { agent, question, taskName }
```

### Phase 2 — New Endpoints & Events

```
GET  /api/history               List past runs (metadata only)
GET  /api/history/:id           Load full run data
GET  /api/history/compare/:a/:b Comparison data for two runs
GET  /api/files/diff            Git diff for a file path
SSE  agentConversation          { agent, type: "thinking"|"tool_call"|"tool_result"|"text", content }
SSE  fileChange                 { path, type: "create"|"modify"|"delete", agent }
```

### Phase 3 — Infrastructure

```
Agent runtime abstraction: PtyAgent | DockerAgent | RemoteAgent
SQLite schema: runs, events, analytics views
Plugin API: register hooks, panels, agent runtimes
WebSocket: /ws/terminal/:name (xterm.js streaming)
Pub/sub: channel.publish(topic, data), channel.subscribe(topic, handler)
```

---

## 7. Technology Stack

| Layer | Phase 1 | Phase 2 | Phase 3 |
|-------|---------|---------|---------|
| **Framework** | Preact + HTM (ESM, no build) | Same + optional Vite dev | Vite build required |
| **Graph** | Manual topological SVG | elkjs Sugiyama layout | Canvas 2D / WebGL |
| **Server** | server.cjs + new endpoints | + JSONL parser, fs.watch | + node-pty, better-sqlite3 |
| **Persistence** | In-memory | JSON files | SQLite |
| **Execution** | tmux (unchanged) | tmux (unchanged) | node-pty + optional Docker |
| **Comms** | SSE + REST | SSE + REST | + WebSocket (terminals) |
| **New deps** | 0 (Preact/HTM via CDN or vendored) | elkjs | node-pty, better-sqlite3, vite, xterm.js |

---

## 8. File Structure (Phase 1)

```
public/
  index.html              Entry point, minimal — imports app.js
  lib/
    preact.module.js      Vendored Preact ESM (~4KB)
    htm.module.js         Vendored HTM ESM (~1KB)
  src/
    app.js                Root component, SSE connection, state management
    components/
      CommandBar.js       Goal input, controls, telemetry
      TopologyGraph.js    SVG dependency graph
      AgentDetail.js      Right panel — agent deep-dive
      ActivityFeed.js     Bottom panel — event stream
      CommandPalette.js   Cmd+K overlay
      HumanGate.js        Human input prompt within graph node
    graph/
      layout.js           Topological sort → coordinates
      edges.js            SVG bezier path generation
    state/
      store.js            Centralized state (Preact signals or simple pub/sub)
      sse.js              SSE connection + event routing
      api.js              REST API calls (intervention, history)
    styles/
      theme.css           CSS custom properties (color system)
      components.css      Component styles
```

All files served statically by server.cjs from `public/`. No build step. Native ES modules.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| SVG graph performance with many nodes | Phase 1 targets 3-6 nodes. Phase 2 adds elkjs. Phase 3 moves to Canvas. |
| CSS glow tanking FPS | Glow only on selected + error nodes. Use `will-change: transform` sparingly. |
| Large JSONL crashing Agent Detail | Virtualize/paginate. Show last 50 lines with "load more." Phase 2 adds proper virtualization. |
| Intervention breaking agent mid-tool-call | Warn in UI if agent state is `tool_use`. Inject waits for idle. |
| E-stop not fast enough | kill -9 immediately, don't wait for graceful shutdown. Save state after kill. |
| Human gate blocking indefinitely | Auto-timeout with configurable duration. UI shows elapsed wait time. |
| tmux session parsing brittleness | Existing system already handles this. No regression risk since tmux layer is unchanged in Phase 1-2. |

---

## 10. Design Review Notes

### Approved by Claude (synthesizer) + Gemini Pro + Gemini Flash

**Key decisions from review**:
- Preact + HTM over Vanilla JS (Pro's feedback) — framework DX without build complexity
- Manual SVG layout over elkjs in Phase 1 (Flash's feedback) — sufficient for target node count
- tmux preserved through Phase 2 (defending against Pro's suggestion to skip) — don't rewrite execution during UI redesign
- JSON files over SQLite for Phase 2 history (Flash's feedback) — simpler, greppable, transparent
- Conversation streaming (JSONL tail) moved to Phase 1 (Flash's feedback) — critical for trust
- Human-as-a-Node in Phase 1 (Pro's suggestion) — transforms monitor into co-pilot
- Global E-Stop in Phase 1 (Pro's suggestion) — prevents runaway costs
- SSE + REST over WebSocket for Phase 1-2 (both agree) — simpler, sufficient
- Quiet healthy states, loud errors (both agree) — avoid animation noise
