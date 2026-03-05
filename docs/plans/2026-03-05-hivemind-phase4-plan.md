# HiveMind Phase 4 — Infrastructure Modernization

**Date:** 2026-03-05
**Branch:** `feature/hivemind-phase4`
**Approach:** Replace external dependencies with in-process alternatives; add production-grade concurrency control

## Scope

Phase 4 replaces tmux with node-pty for cross-platform terminal management, migrates from SSE to WebSocket for bidirectional communication, adds SQLite for persistent history, and introduces a MAX_CONCURRENT_AGENTS limiter. These are the highest-impact, most-feasible items from the design doc's "HiveMind" vision.

**In scope:**
- node-pty replacing tmux-control.cjs (eliminates tmux dependency, enables Windows/Mac/Linux)
- WebSocket migration (replaces SSE, enables xterm.js terminal streaming)
- SQLite for persistent history + analytics (replaces JSON file persistence from Phase 3)
- MAX_CONCURRENT_AGENTS concurrency limiter
- Canvas 2D graph rendering for large DAGs (50+ nodes)

**Not in scope (defer to Phase 5+):**
- Plugin/extension system
- Agent branching/forking
- Token bidding system
- Docker isolation
- Structured pub/sub with Redis adapter
- xterm.js full terminal emulator in dashboard (Phase 4 builds the WebSocket + node-pty plumbing; xterm.js UI is Phase 5)

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| node-pty via in-process API, not CLI | tmux-control.cjs is a CLI subprocess invoked via `execSync`. node-pty provides a direct JS API — no shell escaping, no subprocess overhead, no tmux install requirement |
| `ws` library for WebSocket | Standard, minimal, production-grade. No framework overhead. Runs on same HTTP server |
| `better-sqlite3` for SQLite | Synchronous API fits the existing blocking model. Zero-config, single-file database. Cross-platform |
| Adapter pattern for terminal backend | New `terminal-manager.cjs` exposes same logical API (`start`, `stop`, `sendKeys`, `readOutput`, `list`) but backed by node-pty. tmux-control.cjs preserved as fallback |
| WebSocket coexists with SSE initially | SSE endpoints remain during migration. Dashboard switches to WebSocket. Old SSE removed in final cleanup |
| Canvas 2D (not WebGL) for graph | Simpler, sufficient for 50-200 nodes, no GPU dependency. ELK layout engine already available from Phase 2 |

---

## Milestone 1: Terminal Manager (node-pty)

**Goal:** Replace all tmux subprocess calls with in-process node-pty management.

### Task 1: Create TerminalManager class

**File:** `terminal-manager.cjs` (new, ~300 lines)

```js
const pty = require('node-pty');

class TerminalManager {
  constructor(options = {}) {
    this._sessions = new Map(); // name -> { pty, buffer, workDir, exitCode }
    this._maxBufferLines = options.maxBufferLines || 500;
  }

  // Core API (matches tmux-control.cjs logical operations)
  startSession(name, workDir)        // spawn pty, set env, return session info
  stopSession(name)                  // kill pty process
  stopAll()                          // kill all sessions
  sendKeys(name, text)               // write to pty stdin (+ '\r' for Enter)
  readOutput(name, lines = 50)       // return last N lines from ring buffer
  listSessions()                     // return active session names
  getSession(name)                   // return session metadata
  isAlive(name)                      // check if pty process is running

  // Restoration
  restoreSession(name, sessionId, workDir)  // start new pty, run `claude --resume`

  // Worktree management (delegates to git CLI — no tmux dependency)
  createWorktree(name, baseDir)      // same git worktree logic
  cleanupWorktrees(baseDir)          // same cleanup logic

  // Events (via EventEmitter)
  // 'output'   (name, data)   — pty output chunk
  // 'exit'     (name, code)   — pty process exited
  // 'error'    (name, error)  — pty error
}
```

**Key implementation details:**
- Each pty spawns `/bin/bash` (or `cmd.exe` on Windows, `zsh` on macOS if available)
- Ring buffer per session (configurable, default 500 lines) for `readOutput()`
- Environment: unset `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` (same nesting bypass as tmux-control)
- On Windows: use `conpty` backend (node-pty handles this automatically)
- `sendKeys()` handles the same cases: empty string = Enter, long text = direct write, normal text = write + '\r'
- Signal support: `signal(name, sig)` — sends signal to pty child process group

**Platform-specific behavior:**
```js
const shell = process.platform === 'win32' ? 'cmd.exe'
            : process.env.SHELL || '/bin/bash';
```

### Task 2: Integrate TerminalManager into server.cjs

**Changes to `server.cjs`:**
- Replace `const TMUX_CONTROL = ...` with `const { TerminalManager } = require('./terminal-manager.cjs')`
- Instantiate: `const tm = new TerminalManager()`
- Replace all `runTmux('--start ...')` → `tm.startSession(name, workDir)`
- Replace all `runTmux('--stop ...')` → `tm.stopSession(name)`
- Replace all `runTmux('--stop-all')` → `tm.stopAll()`
- Replace all `runTmux('--cmd ...')` → `tm.sendKeys(name, text)`
- Replace all `runTmux('--read ...')` → `tm.readOutput(name, lines)`
- Replace all `runTmux('--list')` → `tm.listSessions()`
- Replace all `runTmux('--restore ...')` → `tm.restoreSession(name, sessionId, workDir)`
- Replace all `runTmux('--signal ...')` → `tm.signal(name, sig)`
- Replace all `runTmux('--worktree ...')` → `tm.createWorktree(name, baseDir)`
- Replace all `runTmux('--cleanup-worktrees ...')` → `tm.cleanupWorktrees(baseDir)`

**Impact:** ~35 call sites in server.cjs use `runTmux`/`runTmuxSafe`. All become direct method calls. This eliminates:
- `execSync`/`execFileSync` subprocess overhead per call
- Shell escaping bugs (the current `retryWorkerTask` has manual quote escaping)
- tmux installation requirement

**`pollTerminals()` rewrite:**
- Currently shells out to `tmux list-sessions`. Replace with `tm.listSessions()` (in-memory, instant)
- Wire `tm.on('exit', (name, code))` to detect crashed sessions instead of polling

### Task 3: Wire pty output to JSONL monitor

**Changes:**
- `tm.on('output', (name, data))` feeds the same output stream that `readPane` provided
- `JsonlMonitor.registerSession()` no longer needs to know about tmux — just needs the workDir
- `state.monitor` continues to work unmodified (it watches JSONL files, not tmux)
- Controller output capture: `tm.on('output', (name, data))` for the controller pty replaces the current `spawn` stdout/stderr handling

### Task 4: Remove tmux dependency from prompts

**Changes to `prompts.cjs`:**
- `buildSystemPrompt()` currently references `TMUX_CONTROL` path. Update to reference `terminal-manager` API instead
- Worker prompts no longer mention tmux. Workers don't interact with terminal management directly (they're just Claude Code sessions) — so this is mostly doc cleanup
- Controller prompt: update tool descriptions to reflect direct API instead of CLI commands

### Task 5: Deprecate tmux-control.cjs

- Keep `tmux-control.cjs` in repo but mark deprecated with header comment
- Add `TMUX_FALLBACK` env var: if set, server.cjs uses tmux-control.cjs instead of terminal-manager.cjs
- This provides escape hatch for environments where node-pty fails to build (native addon)

---

## Milestone 2: WebSocket Migration

**Goal:** Replace SSE with WebSocket for bidirectional, lower-latency communication.

### Task 6: Add WebSocket server

**File:** `ws-server.cjs` (new, ~150 lines)

```js
const WebSocket = require('ws');

class WsServer {
  constructor(httpServer) {
    this.wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
    this._clients = new Set();
    this.wss.on('connection', (ws) => this._onConnect(ws));
  }

  broadcast(event, data) {
    const msg = JSON.stringify({ event, data });
    for (const ws of this._clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  _onConnect(ws) {
    this._clients.add(ws);
    ws.on('close', () => this._clients.delete(ws));
    ws.on('message', (raw) => this._onMessage(ws, raw));
    // Send init data on connect (same as SSE init)
    this.emit('clientConnected', ws);
  }

  _onMessage(ws, raw) {
    // Handle client -> server messages (future: inject prompt, pause/resume)
    const msg = JSON.parse(raw);
    this.emit('clientMessage', ws, msg);
  }

  sendTo(ws, event, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }
}
```

**Wire into server.cjs:**
- `const wsServer = new WsServer(server)` after HTTP server creation
- `wsServer.on('clientConnected', (ws) => wsServer.sendTo(ws, 'init', buildInitData()))`
- All existing `broadcast()` calls in server.cjs also call `wsServer.broadcast()`

### Task 7: Migrate dashboard to WebSocket

**Changes to `public/src/state/sse.js` → rename to `public/src/state/connection.js`:**

```js
let ws = null;

export function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (event) => {
    const { event: eventName, data } = JSON.parse(event.data);
    handleEvent(eventName, data);
  };
  ws.onclose = () => setTimeout(connect, 2000); // auto-reconnect
}

function handleEvent(eventName, data) {
  // Same handler logic as current SSE handlers
}
```

- `app.js`: replace `connectSSE()` with `connect()` from new module
- Heartbeat: WebSocket has built-in ping/pong. Remove SSE keepalive logic
- All SSE event names stay the same — just transport changes

### Task 8: Add client-to-server commands via WebSocket

**New capability:** Dashboard can send commands to server without REST API.

```js
// Client sends:
ws.send(JSON.stringify({ action: 'inject', agent: 'worker-1', prompt: '...' }));
ws.send(JSON.stringify({ action: 'pause', agent: 'worker-1' }));
ws.send(JSON.stringify({ action: 'resume', agent: 'worker-1' }));
ws.send(JSON.stringify({ action: 'kill', agent: 'worker-1' }));
```

**Server handles in `wsServer.on('clientMessage')`** — routes to same handler functions as REST endpoints. This is an optional enhancement that simplifies the REST API surface, but REST endpoints remain for CLI/curl usage.

### Task 9: Remove SSE endpoints

After WebSocket migration is confirmed working:
- Remove `GET /api/events` SSE endpoint from server.cjs
- Remove `state.sseClients[]` management (or delegate to StateManager only for backward compat)
- Remove SSE heartbeat interval
- Keep REST endpoints (`GET /api/status`, `POST /api/start`, etc.) — WebSocket is for streaming, REST is for actions

---

## Milestone 3: SQLite Persistence

**Goal:** Replace JSON file history with SQLite. Enable cross-run analytics.

### Task 10: Create database module

**File:** `database.cjs` (new, ~200 lines)

```js
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), '.multi-claude', 'history.db');

class HistoryDB {
  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');  // better concurrent read perf
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        model TEXT,
        terminal_count INTEGER,
        outcome TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        duration INTEGER,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        file_changes_count INTEGER DEFAULT 0,
        summary_json TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        status TEXT,
        duration INTEGER,
        attempts INTEGER DEFAULT 1,
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id);
    `);
  }

  saveRun(runData) { /* INSERT into runs + tasks */ }
  getRuns(limit = 20, offset = 0) { /* SELECT from runs */ }
  getRun(id) { /* SELECT run + tasks */ }
  deleteRun(id) { /* DELETE from runs (cascade deletes tasks) */ }
  getAnalytics() { /* aggregate queries: avg duration, success rate, cost trends */ }
  close() { this.db.close(); }
}
```

### Task 11: Migrate history endpoints to SQLite

**Changes to server.cjs (or separate history routes):**
- Replace `saveRunHistory()` (JSON file writer from Phase 3) with `db.saveRun()`
- Replace `GET /api/history` → `db.getRuns(limit, offset)`
- Replace `GET /api/history/:id` → `db.getRun(id)`
- Replace `DELETE /api/history/:id` → `db.deleteRun(id)`
- Add `GET /api/analytics` → `db.getAnalytics()` (new endpoint)

**Migration path:**
- On first startup, if JSON history files exist in `~/.multi-claude/history/`, import them into SQLite
- After successful import, rename JSON directory to `history-migrated/`

### Task 12: Add analytics endpoint

**Endpoint:** `GET /api/analytics`

```json
{
  "totalRuns": 47,
  "avgDuration": 180000,
  "successRate": 0.85,
  "totalCost": 124.50,
  "costPerRun": [
    { "date": "2026-03-01", "cost": 2.45, "runs": 3 },
    { "date": "2026-03-02", "cost": 5.10, "runs": 5 }
  ],
  "modelUsage": {
    "sonnet": 30,
    "opus": 12,
    "haiku": 5
  },
  "avgTasksPerRun": 6.2,
  "retryRate": 0.12
}
```

Computed via SQL aggregation. Cached for 60 seconds to avoid repeated queries.

### Task 13: Analytics panel in dashboard

**File:** `public/src/components/AnalyticsPanel.js` (new)

- Accessible from CommandPalette ("View Analytics") or keyboard shortcut
- Shows: total runs, success rate, average duration, cost trends (simple bar chart via Canvas 2D)
- Model usage breakdown
- Lightweight — no charting library, just Canvas rectangles + text

---

## Milestone 4: Concurrency Limiter

**Goal:** Prevent API rate limit hits by limiting simultaneous agent spawns.

### Task 14: Add MAX_CONCURRENT_AGENTS to ConductorExecutor

**Changes to `conductor.cjs`:**

```js
class ConductorExecutor extends EventEmitter {
  constructor(plan, options = {}) {
    // ...existing...
    this._maxConcurrent = options.maxConcurrentAgents || Infinity;
  }

  /**
   * Returns tasks that are ready to start (dependencies met, not blocked by concurrency limit).
   * @returns {string[]} task names eligible to start
   */
  getReadyTasks() {
    const inProgress = Object.values(this.taskStatus)
      .filter(ts => ts.status === TASK_STATES.IN_PROGRESS).length;

    if (inProgress >= this._maxConcurrent) return [];

    const slots = this._maxConcurrent - inProgress;
    const ready = [];

    for (const task of this.plan.tasks) {
      const ts = this.taskStatus[task.name];
      if (ts.status !== TASK_STATES.PENDING && ts.status !== TASK_STATES.SCHEDULED) continue;
      if (!this._dependenciesMet(task)) continue;
      ready.push(task.name);
      if (ready.length >= slots) break;
    }
    return ready;
  }
}
```

**Configuration:**
- Plan-level: `plan.maxConcurrentAgents` (set in plan YAML/JSON)
- CLI flag: `--max-agents N` passed to server.cjs
- Dashboard: editable in CommandBar before starting a build
- Default: `Infinity` (no limit, current behavior)

### Task 15: Queue visualization in dashboard

**Changes to topology graph:**
- Queued tasks (ready but waiting for slot) get a distinct "queued" visual state
- Show concurrency meter: "3/5 agents active" badge in header
- Pulsing border on queued nodes to indicate "waiting for slot"

**Changes to store:**
- Add `maxConcurrentAgents` to state
- Add `queuedTasks` computed from task status

### Task 16: Backpressure handling

**When at capacity:**
- New tasks are held in SCHEDULED state until a slot opens
- `conductor.on('taskCompleted')` triggers `getReadyTasks()` to fill freed slots
- WAIT tasks that become ready respect the concurrency limit too
- Retry tasks get priority over new tasks (configurable)

**Server.cjs integration:**
- Controller checks `conductor.getReadyTasks()` before issuing `--start` commands
- Existing flow: controller reads plan → starts all tasks at once. New flow: controller starts up to N tasks, then starts more as slots free up

---

## Milestone 5: Canvas Graph Renderer

**Goal:** Handle 50+ node DAGs without DOM performance issues.

### Task 17: Canvas-based TopologyGraph

**File:** `public/src/graph/CanvasGraph.js` (new, ~400 lines)

**Replaces:** Current SVG-based `TopologyGraph.js` for graphs above a threshold (e.g., >20 nodes)

```js
class CanvasGraph {
  constructor(canvas, options = {}) {
    this.ctx = canvas.getContext('2d');
    this._nodes = new Map();  // id -> { x, y, w, h, label, status, ... }
    this._edges = [];         // [{ from, to }]
    this._camera = { x: 0, y: 0, zoom: 1 };
    this._hoveredNode = null;
    this._selectedNode = null;
  }

  setLayout(elkResult) { /* position nodes from ELK layout */ }
  render() { /* draw all nodes + edges to canvas */ }

  // Interaction
  _onMouseMove(e) { /* hit-test nodes, update hover */ }
  _onClick(e) { /* select node, emit 'nodeSelected' event */ }
  _onWheel(e) { /* zoom */ }

  // Pan + zoom
  _screenToWorld(x, y) { /* transform screen coords to world coords */ }
  _worldToScreen(x, y) { /* inverse transform */ }
}
```

**Node rendering:**
- Rounded rectangles with status-color fill (same colors as current SVG nodes)
- Label text centered, truncated if too long
- Context meter bar at bottom of each node
- Status icons (retry badge, timeout clock, error indicator) drawn as simple shapes
- Selected node: bright border highlight

**Performance targets:**
- 60fps pan/zoom for up to 200 nodes
- Hit-testing via spatial index (simple grid-based, not R-tree — sufficient for <500 nodes)
- Edges drawn as bezier curves with arrowheads

### Task 18: Graph renderer switching

**Changes to `TopologyGraph.js` component:**

```js
function TopologyGraph({ nodes, edges, ... }) {
  const threshold = 20;
  if (nodes.length > threshold) {
    return html`<${CanvasGraph} nodes=${nodes} edges=${edges} ... />`;
  }
  // existing SVG renderer for small graphs
  return html`<svg>...</svg>`;
}
```

- SVG renderer preserved for small graphs (simpler, more accessible)
- Canvas renderer used when node count exceeds threshold
- Both receive same props, same node/edge data format
- User can force canvas mode via CommandPalette ("Use Canvas Graph")

### Task 19: Minimap for large graphs

**In CanvasGraph:**
- Small overview rectangle in bottom-right corner (150x100px)
- Shows all nodes as dots, viewport rectangle as outline
- Click minimap to navigate
- Only shown when zoom < 0.5 or graph is significantly larger than viewport

---

## Milestone 6: Integration & Polish

### Task 20: Package.json and native addon setup

- Create `package.json` with dependencies: `node-pty`, `better-sqlite3`, `ws`
- Add `postinstall` script for native addon building guidance
- Add `engines` field: `{ "node": ">=18" }`
- Document build requirements for each platform:
  - Linux: `apt install build-essential python3`
  - macOS: Xcode command line tools
  - Windows: `windows-build-tools` or Visual Studio Build Tools

### Task 21: End-to-end integration testing

- Verify: start workflow → node-pty spawns agents → WebSocket streams updates → SQLite saves history
- Verify: MAX_CONCURRENT_AGENTS limits spawns correctly
- Verify: crash recovery works with node-pty (detect exit event, restore session)
- Verify: Canvas graph renders 50-node test plan correctly
- Verify: tmux fallback (`TMUX_FALLBACK=1`) still works

### Task 22: Final cleanup

- Remove SSE client management from StateManager (WebSocket only)
- Update all prompts to not reference tmux
- Update CLAUDE.md / README with new setup instructions
- Clean up unused `runTmux`/`runTmuxSafe` functions

---

## Dependency Graph

```
Milestone 1 (Terminal Manager):
  Task 1 (TerminalManager) ── Task 2 (server.cjs integration) ── Task 3 (pty→monitor wiring)
  Task 1 ── Task 4 (prompt updates)
  Task 2 ── Task 5 (tmux deprecation)

Milestone 2 (WebSocket):
  Task 6 (WsServer) ── Task 7 (dashboard migration) ── Task 9 (SSE removal)
  Task 6 ── Task 8 (client→server commands)

Milestone 3 (SQLite):
  Task 10 (database module) ── Task 11 (history migration) ── Task 12 (analytics endpoint) ── Task 13 (analytics panel)

Milestone 4 (Concurrency):
  Task 14 (MAX_CONCURRENT in conductor) ── Task 15 (queue viz) ── Task 16 (backpressure)

Milestone 5 (Canvas):
  Task 17 (CanvasGraph) ── Task 18 (renderer switching) ── Task 19 (minimap)

Milestone 6 (Polish):
  Task 20 (package.json) — independent, do first
  Task 21 (integration tests) — depends on M1 + M2 + M3 + M4
  Task 22 (cleanup) — depends on Task 21
```

## Parallelization Opportunities

These milestone groups can be worked on simultaneously:

| Group | Tasks | Dependencies |
|-------|-------|-------------|
| Terminal Manager | 1, 2, 3, 4, 5 | Sequential chain |
| WebSocket | 6, 7, 8, 9 | Sequential chain, independent of M1 |
| SQLite | 10, 11, 12, 13 | Sequential chain, independent of M1/M2 |
| Concurrency | 14, 15, 16 | Sequential, needs conductor.cjs from Phase 3 |
| Canvas | 17, 18, 19 | Sequential, independent of all server work |
| Polish | 20, 21, 22 | 20 independent; 21, 22 depend on all |

**Max parallelism:** 5 independent streams (M1 through M5) can proceed simultaneously. Package.json (Task 20) should be done first as other milestones need the npm dependencies.

**Suggested execution order for single developer:**
1. Task 20 (package.json) — unblocks everything
2. Tasks 1-3 (TerminalManager core) + Tasks 6-7 (WebSocket core) in parallel
3. Tasks 10-11 (SQLite core) + Task 14 (concurrency core) in parallel
4. Remaining UI tasks (13, 15, 17-19) in parallel
5. Tasks 21-22 (integration + cleanup)

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| node-pty native addon fails to build | Keep tmux-control.cjs as fallback, `TMUX_FALLBACK=1` env var. Document platform build requirements |
| node-pty on Windows has different behavior | Test on WSL2 first (current platform). Windows CMD differences isolated in TerminalManager shell detection |
| better-sqlite3 native addon fails | Same native addon risk. Fallback: JSON file persistence still works from Phase 3 |
| WebSocket reconnection drops events | Client buffers last event ID, server replays missed events on reconnect (or accept small gap — dashboard is observability, not mission-critical) |
| Canvas graph interaction bugs | Keep SVG renderer for small graphs. Canvas only activates above threshold. User can toggle |
| MAX_CONCURRENT breaks existing plans | Default is Infinity (no change). Only activated when explicitly configured |
| Large migration surface in server.cjs | Task 2 (tmux→node-pty) touches ~35 call sites. Do as atomic find-replace, test after each logical group |
| node-pty process cleanup on crash | Register `process.on('exit')` and `process.on('SIGTERM')` to kill all pty children. Also periodic liveness check |

## Commit Plan

```
chore(phase4): add package.json with node-pty, better-sqlite3, ws dependencies
feat(phase4): TerminalManager class (node-pty backend)
feat(phase4): integrate TerminalManager into server.cjs (replace tmux calls)
feat(phase4): wire pty output to JsonlMonitor + controller capture
feat(phase4): update prompts to remove tmux references
feat(phase4): deprecate tmux-control.cjs with TMUX_FALLBACK env var
feat(phase4): WebSocket server (ws-server.cjs)
feat(phase4): migrate dashboard from SSE to WebSocket
feat(phase4): client-to-server commands via WebSocket
feat(phase4): remove SSE endpoints
feat(phase4): SQLite database module (history.db)
feat(phase4): migrate history endpoints to SQLite
feat(phase4): analytics endpoint + dashboard panel
feat(phase4): MAX_CONCURRENT_AGENTS limiter in ConductorExecutor
feat(phase4): concurrency queue visualization
feat(phase4): backpressure handling for task scheduling
feat(phase4): Canvas 2D graph renderer for large DAGs
feat(phase4): graph renderer switching (SVG/Canvas threshold)
feat(phase4): minimap for large canvas graphs
feat(phase4): end-to-end integration verification
feat(phase4): final cleanup (remove SSE, update docs)
```
