import { h } from '../lib/preact.module.js';
import { useRef, useEffect, useState, useCallback } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState } from '../state/store.js';
import { computeLayout, NODE_W, NODE_H } from '../graph/layout.js';
import { edgePath } from '../graph/edges.js';
import { CanvasGraph } from '../graph/CanvasGraph.js';

const CANVAS_THRESHOLD = 20;

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function getNodeState(name, agentStates, taskStatus, queuedTasks) {
  const agent = agentStates[name];
  const task = taskStatus[name];
  if (agent && agent.state && agent.state !== 'idle') return agent.state;
  if (task) {
    if (task.status === 'in_progress') return 'active';
    if (task.status === 'completed') return 'completed';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'retrying') return 'retrying';
    if (task.status === 'waiting') return 'waiting';
    if (task.status === 'timed_out') return 'timed_out';
    if (task.status === 'completed_with_errors') return 'completed';
  }
  // Check if task is queued (ready but waiting for concurrency slot)
  if (queuedTasks && queuedTasks.includes(name)) return 'queued';
  return 'idle';
}

function stateColor(state) {
  const map = {
    active: 'var(--state-active)', thinking: 'var(--state-thinking)',
    tool_use: 'var(--state-tool-use)', waiting: 'var(--state-waiting)',
    completed: 'var(--state-completed)', failed: 'var(--state-failed)',
    timed_out: '#ff9800', queued: '#ab47bc',
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
  const contextWarnings = useStore(s => s.contextWarnings);
  const logEntries = useStore(s => s.logEntries);
  const selectedAgent = useStore(s => s.selectedAgent);
  const forceCanvas = useStore(s => s.forceCanvasGraph);
  const queuedTasks = useStore(s => s.queuedTasks);
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

  const handleSelectAgent = useCallback((name) => {
    setState({ selectedAgent: name });
  }, []);

  if (!taskPlan || !taskPlan.tasks || taskPlan.tasks.length === 0) {
    return html`<div class="topology-graph" ref=${containerRef}>
      <div class="graph-empty">Waiting for execution plan...</div>
    </div>`;
  }

  // Switch to Canvas renderer for large graphs or when forced
  const useCanvas = forceCanvas || taskPlan.tasks.length > CANVAS_THRESHOLD;

  if (useCanvas) {
    return html`<div class="topology-graph" ref=${containerRef}>
      <${CanvasGraph}
        taskPlan=${taskPlan}
        taskStatus=${taskStatus}
        agentStates=${agentStates}
        contextWarnings=${contextWarnings}
        logEntries=${logEntries}
        selectedAgent=${selectedAgent}
        onSelectAgent=${handleSelectAgent}
        queuedTasks=${queuedTasks}
      />
    </div>`;
  }

  // SVG renderer for small graphs
  const interventionAgents = new Set();
  if (logEntries) {
    for (const entry of logEntries) {
      if (entry.type === 'intervention' && entry.agent) {
        interventionAgents.add(entry.agent);
      }
    }
  }

  const { nodes, edges, phases } = computeLayout(taskPlan, size.w, size.h);

  function selectNode(name) {
    setState({ selectedAgent: selectedAgent === name ? null : name });
  }

  return html`
    <div class="topology-graph" ref=${containerRef}>
      <svg viewBox="0 0 ${size.w} ${size.h}" xmlns="http://www.w3.org/2000/svg">
        <style>
          @keyframes ctxPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        </style>
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
          const state = getNodeState(n.name, agentStates, taskStatus, queuedTasks);
          const tokens = agentStates[n.name]?.tokens || {};
          const totalTok = (tokens.input || 0) + (tokens.output || 0);
          const isSelected = selectedAgent === n.name;
          const task = n.task || {};
          const hasIntervention = interventionAgents.has(n.name);

          return html`
            <g class="graph-node state-${state} ${isSelected ? 'selected' : ''}"
               onClick=${() => selectNode(n.name)}>
              <rect x=${n.x} y=${n.y} width=${n.w} height=${n.h} />
              <!-- State dot -->
              <circle class="node-state-dot" cx=${n.x + 14} cy=${n.y + 16} r="4"
                fill=${stateColor(state)} />
              <!-- Intervention badge -->
              ${hasIntervention && html`
                <circle cx=${n.x + 7} cy=${n.y + 7} r="7"
                  fill="#f59e0b" stroke="var(--bg-surface)" stroke-width="1" />
                <text x=${n.x + 7} y=${n.y + 10} text-anchor="middle"
                  style="font-size:9px;fill:#000;font-weight:700;pointer-events:none;">!</text>
              `}
              ${state === 'timed_out' && html`
                <text x=${n.x + n.w - 12} y=${n.y + 16} text-anchor="end"
                  style="font-size:9px;font-weight:700;fill:#ff9800;font-family:var(--font-mono);">T/O</text>
              `}
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
                width=${(n.w - 20) * (state === 'completed' ? 1 : state === 'active' ? 0.5 : state === 'failed' || state === 'timed_out' ? 1 : 0)}
                height="4" rx="2" fill=${stateColor(state)} />
              <!-- Telemetry -->
              <text class="node-telem" x=${n.x + 10} y=${n.y + 72}>
                ${formatTokens(totalTok)} tok
              </text>
              <!-- Context usage bar -->
              ${(() => {
                const ctxIn = tokens.input || 0;
                const ctxCache = tokens.cacheRead || 0;
                if (ctxIn === 0 && ctxCache === 0) return null;
                const ctxPct = Math.min(100, Math.round(((ctxIn + ctxCache) / 200000) * 100));
                const ctxColor = ctxPct > 75 ? '#f44336' : ctxPct >= 50 ? '#ff9800' : '#4caf50';
                const hasWarning = !!contextWarnings[n.name];
                return html`
                  <rect x=${n.x + 10} y=${n.y + n.h - 8} width=${n.w - 20} height="4" rx="2"
                    fill="#333" />
                  <rect x=${n.x + 10} y=${n.y + n.h - 8}
                    width=${(n.w - 20) * (ctxPct / 100)}
                    height="4" rx="2" fill=${ctxColor}
                    style=${hasWarning ? 'animation: ctxPulse 1s ease-in-out infinite' : ''} />
                `;
              })()}
            </g>
          `;
        })}
      </svg>
    </div>
  `;
}
