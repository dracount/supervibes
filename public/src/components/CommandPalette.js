import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState, getState } from '../state/store.js';
import { pauseAgent, resumeAgent, emergencyStop, stopBuild } from '../state/api.js';

function buildActions() {
  const s = getState();
  const actions = [];

  // Agent selection
  if (s.taskPlan && s.taskPlan.tasks) {
    for (const task of s.taskPlan.tasks) {
      actions.push({
        id: 'agent:' + task.name,
        icon: '\u25c9',
        label: `Go to agent: ${task.name}`,
        category: 'agents',
        action: () => setState({ selectedAgent: task.name, showCommandPalette: false }),
      });
    }
  }

  // Session agents
  for (const name of s.sessions) {
    if (!actions.find(a => a.id === 'agent:' + name)) {
      actions.push({
        id: 'agent:' + name,
        icon: '\u25c9',
        label: `Go to agent: ${name}`,
        category: 'agents',
        action: () => setState({ selectedAgent: name, showCommandPalette: false }),
      });
    }
  }

  // Commands
  if (s.running) {
    actions.push({
      id: 'cmd:stop', icon: '\u25a0', label: 'Stop build', shortcut: '',
      category: 'commands',
      action: () => { stopBuild(); setState({ showCommandPalette: false }); },
    });
    actions.push({
      id: 'cmd:estop', icon: '\u26a1', label: 'Emergency stop', shortcut: '',
      category: 'commands',
      action: () => { emergencyStop(); setState({ showCommandPalette: false }); },
    });

    if (s.selectedAgent) {
      actions.push({
        id: 'cmd:pause', icon: '\u23f8', label: `Pause ${s.selectedAgent}`, shortcut: 'Space',
        category: 'commands',
        action: () => { pauseAgent(s.selectedAgent); setState({ showCommandPalette: false }); },
      });
      actions.push({
        id: 'cmd:resume', icon: '\u25b6', label: `Resume ${s.selectedAgent}`, shortcut: 'Space',
        category: 'commands',
        action: () => { resumeAgent(s.selectedAgent); setState({ showCommandPalette: false }); },
      });
    }
  }

  // Workflow summary
  if (s.workflowSummary) {
    actions.push({
      id: 'view:summary', icon: '\u2611', label: 'View last workflow summary', shortcut: '',
      category: 'view',
      action: () => {
        setState({ showCommandPalette: false, showWorkflowSummaryRequested: true });
      },
    });
  }

  // View toggles
  actions.push({
    id: 'view:history', icon: '\ud83d\udcdc', label: 'View Run History', shortcut: '\u2318H',
    category: 'view',
    action: () => setState({ showHistory: true, showCommandPalette: false }),
  });
  actions.push({
    id: 'view:deselect', icon: '\u2715', label: 'Deselect agent', shortcut: 'Esc',
    category: 'view',
    action: () => setState({ selectedAgent: null, showCommandPalette: false }),
  });
  actions.push({
    id: 'view:filter-all', icon: '\u2261', label: 'Feed: show all', shortcut: '',
    category: 'view',
    action: () => setState({ feedFilter: 'all', showCommandPalette: false }),
  });
  actions.push({
    id: 'view:filter-errors', icon: '!', label: 'Feed: show errors only', shortcut: '',
    category: 'view',
    action: () => setState({ feedFilter: 'errors', showCommandPalette: false }),
  });

  return actions;
}

function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return true;
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function CommandPalette() {
  const show = useStore(s => s.showCommandPalette);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (show) {
      setQuery('');
      setHighlighted(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [show]);

  if (!show) return null;

  const actions = buildActions();
  const filtered = actions.filter(a => fuzzyMatch(query, a.label));

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      setState({ showCommandPalette: false });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(h => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      if (filtered[highlighted]) {
        filtered[highlighted].action();
      }
    }
  }

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) {
      setState({ showCommandPalette: false });
    }
  }

  return html`
    <div class="command-palette-overlay" onClick=${handleOverlayClick}>
      <div class="command-palette">
        <input class="command-palette-input" ref=${inputRef}
          placeholder="Type a command..."
          value=${query}
          onInput=${e => { setQuery(e.target.value); setHighlighted(0); }}
          onKeyDown=${handleKeyDown}
        />
        <div class="command-palette-list">
          ${filtered.length === 0 && html`
            <div class="command-palette-empty">No matching commands</div>
          `}
          ${filtered.map((item, i) => html`
            <div class="command-palette-item ${i === highlighted ? 'highlighted' : ''}"
                 onClick=${() => item.action()}>
              <span class="cp-icon">${item.icon}</span>
              <span class="cp-label">${item.label}</span>
              ${item.shortcut && html`<span class="cp-shortcut">${item.shortcut}</span>`}
            </div>
          `)}
        </div>
      </div>
    </div>
  `;
}
