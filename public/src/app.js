import { h, render } from './lib/preact.module.js';
import { useEffect, useState, useRef, useCallback } from './lib/preact-hooks.module.js';
import { html } from './lib/html.js';
import { connectSSE } from './state/sse.js';
import { getState, setState, useStore } from './state/store.js';
import { pauseAgent, resumeAgent } from './state/api.js';
import { CommandBar } from './components/CommandBar.js';
import { TopologyGraph } from './components/TopologyGraph.js';
import { AgentDetail } from './components/AgentDetail.js';
import { ActivityFeed } from './components/ActivityFeed.js';
import { CommandPalette } from './components/CommandPalette.js';
import { HistoryView } from './components/HistoryView.js';
import { WorkflowSummary } from './components/WorkflowSummary.js';

function useResizeH(initialHeight) {
  const [height, setHeight] = useState(initialHeight);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      setHeight(Math.max(80, Math.min(500, startH.current + delta)));
    }
    function onUp() {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [height]);

  return [height, onMouseDown, dragging.current];
}

function App() {
  const [feedHeight, onFeedResize, feedDragging] = useResizeH(200);

  // SSE connection with auto-reconnect
  useEffect(() => {
    connectSSE();
    const iv = setInterval(() => {
      // Reconnect if disconnected
      connectSSE();
    }, 30000);
    return () => clearInterval(iv);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKey(e) {
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setState({ showCommandPalette: !getState().showCommandPalette });
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'h') {
        e.preventDefault();
        setState({ showHistory: !getState().showHistory });
        return;
      }

      if (e.key === 'Escape') {
        const s = getState();
        if (s.showCommandPalette) {
          setState({ showCommandPalette: false });
        } else if (s.showHistory) {
          setState({ showHistory: false, historySelectedRun: null });
        } else if (s.selectedAgent) {
          setState({ selectedAgent: null });
        }
        return;
      }

      if (isInput) return;

      if (e.key >= '1' && e.key <= '9') {
        const s = getState();
        const tasks = s.taskPlan?.tasks || [];
        const idx = parseInt(e.key) - 1;
        if (idx < tasks.length) {
          setState({ selectedAgent: tasks[idx].name });
        }
        return;
      }

      if (e.key === ' ' && getState().selectedAgent && getState().running) {
        e.preventDefault();
        const agent = getState().selectedAgent;
        const agentState = getState().agentStates[agent];
        if (agentState && agentState.state === 'paused') {
          resumeAgent(agent);
        } else {
          pauseAgent(agent);
        }
        return;
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return html`
    <${CommandBar} />
    <div class="main-content">
      <${TopologyGraph} />
      <${AgentDetail} />
    </div>
    <div class="resize-handle-h ${feedDragging ? 'active' : ''}" onMouseDown=${onFeedResize}></div>
    <${ActivityFeed} style=${{ height: feedHeight + 'px' }} />
    <div class="shortcut-hint">\u2318K palette \u00b7 \u2318H history \u00b7 1-9 agents \u00b7 Space pause \u00b7 Esc deselect</div>
    <${CommandPalette} />
    <${HistoryView} />
    <${WorkflowSummary} />
  `;
}

render(h(App, null), document.getElementById('app'));
