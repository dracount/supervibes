import { h } from '../lib/preact.module.js';
import { useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState } from '../state/store.js';

function fmtTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function ActivityFeed({ style }) {
  const logEntries = useStore(s => s.logEntries);
  const feedFilter = useStore(s => s.feedFilter);
  const sessions = useStore(s => s.sessions);
  const bodyRef = useRef(null);

  // Auto-scroll
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logEntries]);

  // Filter entries
  let filtered = logEntries;
  if (feedFilter === 'errors') {
    filtered = logEntries.filter(e =>
      e.type === 'stop' || e.type === 'exit' || e.type === 'intervention' || e.type === 'human'
    );
  } else if (feedFilter.startsWith('agent:')) {
    const agentName = feedFilter.substring(6);
    filtered = logEntries.filter(e => e.agent === agentName);
  }

  // Unique agent names for filter chips
  const agentNames = [...new Set(logEntries.filter(e => e.agent).map(e => e.agent))];

  function setFilter(f) {
    setState({ feedFilter: f });
  }

  function handleEntryClick(entry) {
    if (entry.agent) {
      setState({ selectedAgent: entry.agent });
    }
  }

  return html`
    <div class="activity-feed" style=${style}>
      <div class="feed-header">
        <span class="feed-title">Activity</span>
        <div class="feed-filters">
          <button class="feed-chip ${feedFilter === 'all' ? 'active' : ''}"
            onClick=${() => setFilter('all')}>All</button>
          <button class="feed-chip ${feedFilter === 'errors' ? 'active' : ''}"
            onClick=${() => setFilter('errors')}>Errors</button>
          ${agentNames.map(name => html`
            <button class="feed-chip ${feedFilter === 'agent:' + name ? 'active' : ''}"
              onClick=${() => setFilter('agent:' + name)}>${name}</button>
          `)}
        </div>
      </div>
      <div class="feed-body" ref=${bodyRef}>
        ${filtered.length === 0 && html`
          <div class="feed-empty">No activity yet</div>
        `}
        ${filtered.map((entry, i) => html`
          <div class="feed-entry type-${entry.type} ${entry.agent ? 'clickable' : ''}"
               onClick=${() => handleEntryClick(entry)} key=${`${entry.type}-${entry.time?.getTime?.() || i}-${i}`}>
            <span class="feed-time">${fmtTime(entry.time)}</span>
            <span class="feed-icon">${entry.icon}</span>
            <span class="feed-msg">${entry.msg}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}
