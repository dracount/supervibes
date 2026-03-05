# HiveMind Phase 3 — Observability & History

**Date:** 2026-03-05
**Branch:** `feature/hivemind-phase3`
**Approach:** Observability-first — render the data already flowing, add history, refactor server

## Scope

Phase 3 absorbs remaining Phase 2 work (11 unfinished tasks) and adds:
- Server-side refactoring (StateManager, ConductorExecutor extraction)
- Conversation viewer + context meters + error details (observability UI)
- File change tracking (server + dashboard)
- Run history persistence + browsing
- Workflow summaries + polish

**Not in scope:** Hook lifecycle wiring, build step changes, WebSocket migration, database.

## Architecture Decisions

- Preact with no build step (ES modules, HTM) — preserved
- SSE for server→client streaming — preserved
- tmux-based execution — preserved
- History persisted as JSON files (no database)
- New server modules extracted as CommonJS classes

---

## Milestone 1: Server Refactoring

### Task 1: Extract StateManager class

**File:** `state-manager.cjs` (new)

```js
class StateManager extends EventEmitter {
  constructor() {
    // Owns: running, phase, goal, model, terminalCount, iterations,
    //       currentIteration, sessions, stopped, reviewDone,
    //       sseClients[], workflowStartedAt, postChecks
  }
  broadcast(event, data)    // send SSE to all clients
  addClient(res)            // register SSE client
  removeClient(res)         // unregister SSE client
  reset()                   // clear workflow state
  toInitData()              // serialize for late-joining clients
}
```

**Changes to `server.cjs`:**
- Import and instantiate StateManager
- Replace `state.running`, `state.phase`, etc. with `sm.running`, `sm.phase`
- Replace `broadcast()` calls with `sm.broadcast()`
- Replace SSE client management with `sm.addClient()`/`sm.removeClient()`
- Execution state stays local: `controllerProcess`, `controllerOutput`, `monitor`

### Task 2: Extract ConductorExecutor class

**File:** `conductor.cjs` (new)

```js
class ConductorExecutor extends EventEmitter {
  constructor(plan, monitor, stateManager) {
    // Owns: taskStatus, retryQueue, taskTimeoutInterval,
    //       waitConditionTimers, conductorTimers
  }
  start()                          // begin conductor execution
  stop()                           // cancel all tasks + timers
  getTaskStatus()                  // return current taskStatus map
  getSummary()                     // compute workflow summary
  // Internal:
  _startTask(taskName)
  _completeTask(taskName, output)
  _failTask(taskName, error)
  _checkTimeouts()
  _scheduleRetry(taskName)
  _checkWaitConditions()
}
// Emits: taskStarted, taskCompleted, taskFailed, taskTimedOut,
//        retryScheduled, waitConditionMet, allTasksComplete
```

**Key design:** ConductorExecutor OWNS `taskStatus` and `retryQueue` directly — no shared mutable state with server.cjs. Server listens to emitted events for SSE broadcasting.

**Changes to `server.cjs`:**
- `startConductorExecution()` replaced by creating ConductorExecutor instance
- Conductor timer setup/teardown moved into ConductorExecutor
- server.cjs wires events: `conductor.on('taskStarted', (name) => sm.broadcast('taskStatus', ...))`

### Task 3: Add workflow summary endpoint

**Endpoint:** `GET /api/workflow/summary`

```json
{
  "totalTasks": 8,
  "completed": 6,
  "failed": 1,
  "timedOut": 1,
  "retried": 2,
  "totalDuration": 245000,
  "phases": [
    { "name": "phase-1", "duration": 120000, "taskCount": 4 }
  ],
  "costEstimate": 2.45
}
```

Computed from ConductorExecutor.getSummary() or taskStatus if conductor not active.

### Task 4: Add agent context endpoint

**Endpoint:** `GET /api/agents/context`

```json
{
  "agents": {
    "worker-1": {
      "inputTokens": 85000,
      "outputTokens": 12000,
      "cacheRead": 45000,
      "contextWarned": false,
      "estimatedContextPct": 42
    }
  }
}
```

Reads from `monitor._sessions`. `estimatedContextPct` uses latest `input_tokens` as rough proxy (labeled as estimate in UI).

---

## Milestone 2: Observability UI

### Task 5: ConversationView component

**File:** `public/src/components/ConversationView.js` (new)

**Props:** `agentName` (string)

**Reads:** `agentConversations[agentName]` from store

**Renders chronological list:**
- `thinking` blocks: collapsible, muted gray, monospace, collapsed by default
- `text` blocks: normal text styling
- `tool_call` blocks: tool name badge (blue pill) + collapsible input JSON
- `tool_result` blocks: collapsible output, truncation indicator if content was truncated

**Behavior:**
- Auto-scrolls to bottom on new events
- Shows "No conversation data yet" empty state
- Inline CSS (matches existing component pattern — no separate CSS files)
- Click thinking block header to expand/collapse

### Task 6: Tabbed AgentDetail

**File:** `public/src/components/AgentDetail.js` (modify)

**Replace current single-view with 3 tabs:**

| Tab | Content |
|-----|---------|
| Conversation | `<ConversationView>` for selected agent |
| Files | Owned files list + expected outputs checklist + FileChanges (when available) |
| Telemetry | Tokens, cost, context meter, retry history timeline |

- Preserve existing action buttons (pause/resume/inject/restart) above tabs
- Preserve existing error display at top
- Default to Conversation tab when agent selected
- Tab state stored locally (not in global store)

### Task 7: Context window meters

**Depends on:** Task 6

**In topology graph nodes:**
- Small horizontal bar at bottom of each node
- Color: green (<50%), yellow (50-75%), red (>75%), pulsing red (warning fired)
- Width proportional to estimated context usage

**In AgentDetail Telemetry tab:**
- Larger meter with numeric label: "~42% context (est.)"
- Explicitly labeled as estimate

**Data source:**
- `agentStates[name].tokens` for current token counts
- `contextWarnings[name]` for warning-fired state
- Approximate: `(inputTokens + cacheRead) / 200000 * 100` capped at 100%

### Task 8: Enhanced error display

**Depends on:** Task 6

**In AgentDetail (when task failed/timed_out):**
- Red banner with failure reason from `taskStatus[name].error`
- If postChecks available: expandable section showing pass/fail per check
- If guardrailResults available: expandable section showing violations
- "Last events before failure" section: last 5 conversation events

**In topology graph:**
- Failed nodes: red fill + small error icon (existing)
- Timed-out nodes: orange fill + clock icon (new)

**In ActivityFeed:**
- Enhanced "errors" filter: includes `failed`, `timed_out`, `intervention`, guardrail violations

### Task 9: Retry history in AgentDetail

**Depends on:** Task 6

**In Telemetry tab:**
- Section: "Retry History"
- Data from taskStatus: `attempts`, `maxAttempts`, `retryPolicy`, timestamps per attempt
- Visual: horizontal timeline with dots per attempt
  - Green dot = success
  - Red dot = failure
  - Orange dot = timeout
  - Gray dot = pending/future
- Hover dot for details: attempt number, duration, error message
- Shows retry policy label (FIXED / EXPONENTIAL_BACKOFF) and delay

---

## Milestone 3: File Change Tracking

### Task 10: Server-side file watcher

**Location:** `conductor.cjs` (inside ConductorExecutor)

**When a task starts:**
- Watch the task's `workDir` using `fs.watch` (native OS events, more efficient than `fs.watchFile`)
- Debounce events: collect changes over 200ms window, then emit batch
- Record: `{ path, type: 'created'|'modified'|'deleted', agent, task, timestamp, size }`
- Cap: max 50 watched directories per workflow

**State:**
- `fileChanges` array in server state (capped at 500 entries)
- Broadcast `fileChange` SSE event per batch
- Include `fileChanges` in SSE init data for late joiners

**Cleanup:**
- Stop all watchers when task completes or workflow ends
- Handle ENOENT gracefully (directory deleted during execution)

### Task 11: File changes store + SSE handler

**Files:** `public/src/state/store.js`, `public/src/state/sse.js`

- Add `fileChanges: []` to store initial state
- Add `fileChange` SSE event handler (cap at 500, splice oldest)
- Add `d.fileChanges` init data handling

### Task 12: FileChanges component

**Depends on:** Task 6, Task 11

**File:** `public/src/components/FileChanges.js` (new)

**Renders:**
- File changes grouped by agent, sorted by timestamp (newest first)
- Each entry: file path (relative), change type badge (created=green, modified=yellow, deleted=red), timestamp
- Integrated into AgentDetail Files tab
- Shows "No file changes tracked" empty state

---

## Milestone 4: Run History

### Task 13: History persistence

**Directory:** `~/.multi-claude/history/`

**On workflow completion** (in `finishRun()`):
- Call `saveRunHistory(outcome)`
- Generate filename: `{ISO-timestamp}-{goal-slug}.json`
- Goal slug: first 50 chars of goal, lowercased, non-alphanum replaced with `-`

**Saved data:**
```json
{
  "id": "2026-03-05T10-30-00-fix-auth-bug",
  "goal": "Fix authentication bug in login flow",
  "model": "sonnet",
  "terminalCount": 4,
  "outcome": "completed",
  "startedAt": 1772710000000,
  "endedAt": 1772710245000,
  "duration": 245000,
  "tasks": [
    { "name": "task-1", "status": "completed", "duration": 45000, "attempts": 1 },
    { "name": "task-2", "status": "failed", "duration": 30000, "attempts": 3, "error": "..." }
  ],
  "totalTokens": { "input": 500000, "output": 80000 },
  "estimatedCost": 2.45,
  "fileChanges": 12,
  "summary": { "totalTasks": 8, "completed": 7, "failed": 1, "retried": 2 }
}
```

**Limits:**
- Max 100 history files, delete oldest on overflow
- Per-file cap: 1MB (truncate task error messages if needed)
- Total directory cap: 50MB

### Task 14: History REST endpoints

- `GET /api/history?limit=20` — list runs (sorted newest first)
  - Returns: `[{ id, goal, model, outcome, duration, taskCount, estimatedCost, startedAt }]`
- `GET /api/history/:id` — full run detail (the saved JSON)
- `DELETE /api/history/:id` — delete a history file

### Task 15: History API client

**File:** `public/src/state/api.js` (new)

```js
export async function getHistoryList(limit = 20) { ... }
export async function getHistoryRun(id) { ... }
export async function deleteHistoryRun(id) { ... }
```

### Task 16: HistoryView component

**File:** `public/src/components/HistoryView.js` (new)

**Store fields (re-add):**
- `showHistory: false`
- `historyRuns: []`
- `historySelectedRun: null`

**List view:**
- Table: goal, model, outcome (badge), duration, tasks, cost, date
- Click row → detail view
- Delete button per row (with confirmation)

**Detail view:**
- Header: goal, model, outcome, total duration, total cost
- Task breakdown table: name, status, duration, attempts
- Back button to return to list

### Task 17: History integration

- **CommandPalette.js:** Add "View Run History" command
- **app.js:** Add Ctrl+H keyboard shortcut, toggle `showHistory`
- **app.js:** Conditionally render HistoryView when `showHistory === true`
- Update keyboard hints to include Ctrl+H

---

## Milestone 5: Summaries & Polish

### Task 18: Workflow summary generation

**On workflow completion:**
- ConductorExecutor.getSummary() computes summary object
- Broadcast `workflowSummary` SSE event
- Store in state for late joiners
- Include summary in history save (Task 13)

**Summary shape:**
```json
{
  "totalTasks": 8,
  "completed": 6,
  "failed": 1,
  "timedOut": 1,
  "retried": 2,
  "totalDuration": 245000,
  "costEstimate": 2.45,
  "topRetriers": [{ "name": "task-3", "attempts": 3 }],
  "phaseBreakdown": [{ "phase": 1, "tasks": 4, "duration": 120000 }]
}
```

### Task 19: Summary modal

**File:** `public/src/components/WorkflowSummary.js` (new)

- Modal overlay auto-shown on workflow completion
- Shows: outcome badge, task counts (completed/failed/timed_out), total duration, cost, top retried tasks
- Dismissible (click outside or Esc)
- Re-openable from CommandPalette ("View Last Summary")
- Also used in HistoryView detail to show historical run summaries

### Task 20: Graph badges + activity feed improvements

**Topology graph enhancements:**
- Intervention badge: lightning icon on nodes that received pause/kill/inject
- Timeout icon: clock on timed-out nodes
- Badges sourced from ActivityFeed intervention events (match by agent name)

**ActivityFeed improvements:**
- Error filter enhanced: catches `failed`, `timed_out`, `intervention`, guardrail violations
- Each feed entry includes task correlation when available (which task triggered the event)
- Visual distinction for intervention entries (yellow background)

### Task 21: Final integration + verification

- Audit all SSE event names match between server broadcasts and frontend handlers
- Verify late-joining client init data includes: agentConversations, contextWarnings, fileChanges, workflowSummary
- Test workflow lifecycle: start → plan → execute → complete → summary modal → history save
- Clean up dead code, unused state fields
- Update keyboard shortcut hints for Ctrl+H
- Run through all tabs in AgentDetail with live data

---

## Dependency Graph

```
Milestone 1 (Refactoring):
  Task 1 (StateManager) ──┬── Task 2 (ConductorExecutor)
                           ├── Task 3 (Summary endpoint)
                           └── Task 4 (Context endpoint)

Milestone 2 (Observability):
  Task 5 (ConversationView) ── Task 6 (Tabbed AgentDetail) ──┬── Task 7 (Context meters)
                                                               ├── Task 8 (Error display)
                                                               └── Task 9 (Retry history)

Milestone 3 (File Tracking):
  Task 2 (ConductorExecutor) ── Task 10 (Server watcher) ── Task 11 (Store+SSE) ── Task 12 (FileChanges component)
  Task 6 (Tabbed AgentDetail) ── Task 12

Milestone 4 (History):
  Task 3 (Summary endpoint) ── Task 13 (Persistence) ── Task 14 (REST) ── Task 15 (API client) ── Task 16 (HistoryView) ── Task 17 (Integration)

Milestone 5 (Polish):
  Task 2 ── Task 18 (Summary generation) ── Task 19 (Summary modal)
  Task 20 (Badges + feed) — independent
  Task 21 (Final) — depends on all
```

## Parallelization Opportunities

These task groups can be worked on simultaneously by different agents:

| Group | Tasks | Dependencies |
|-------|-------|-------------|
| Server refactoring | 1, 2, 3, 4 | Sequential (1 → 2, 1 → 3, 1 → 4) |
| Conversation UI | 5, 6 | Sequential (5 → 6), independent of server refactoring |
| Context/Error UI | 7, 8, 9 | All depend on Task 6, can parallelize with each other |
| File tracking | 10, 11, 12 | Sequential, depends on Task 2 and Task 6 |
| History | 13-17 | Sequential chain, depends on Task 3 |
| Polish | 18, 19, 20 | 18→19 sequential, 20 independent |

**Max parallelism:** After Tasks 1, 5, 6 complete, up to 4 independent work streams can proceed.

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| StateManager extraction breaks server.cjs | Incremental: extract broadcast() first, then state fields one group at a time. Run tests between each step. |
| ConductorExecutor boundary too complex | Keep a thin orchestration facade in server.cjs that delegates to ConductorExecutor. Don't try to move everything at once. |
| fs.watch unreliable on some platforms | Debounce (200ms), graceful ENOENT handling, fall back to fs.watchFile if needed |
| History files grow too large | Per-file 1MB cap, truncate error messages, keep max 100 files, 50MB total cap |
| Context estimate inaccurate | Label as "~estimate" in UI, use latest input_tokens not cumulative sum |
| Too many SSE events from file watcher | Batch file changes over 200ms windows, cap at 500 total stored |

## Commit Plan

```
feat(phase3): extract StateManager class from server.cjs
feat(phase3): extract ConductorExecutor class
feat(phase3): add workflow summary + context endpoints
feat(phase3): ConversationView component
feat(phase3): tabbed AgentDetail (Conversation/Files/Telemetry)
feat(phase3): context window meters + warning badges
feat(phase3): enhanced error display + retry history
feat(phase3): server-side file change tracking
feat(phase3): file changes store, SSE handler, FileChanges component
feat(phase3): run history persistence + REST endpoints
feat(phase3): HistoryView component + API client
feat(phase3): history integration (CommandPalette, Ctrl+H)
feat(phase3): workflow summary generation + modal
feat(phase3): graph badges + activity feed improvements
feat(phase3): final integration + verification
```
