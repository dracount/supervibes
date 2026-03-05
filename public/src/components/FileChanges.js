import { h } from '../lib/preact.module.js';
import { useMemo } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore } from '../state/store.js';

function formatTimestamp(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diff = Math.round((now - new Date(ts).getTime()) / 1000);
  if (diff < 0 || isNaN(diff)) return '';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  // Fallback to HH:MM:SS
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) {
    return '';
  }
}

const typeBadgeColors = {
  modified: '#ff9800',
  created: '#4caf50',
  deleted: '#f44336',
};

function TypeBadge({ type }) {
  const color = typeBadgeColors[type] || '#888';
  return html`
    <span style=${{
      display: 'inline-block',
      padding: '1px 6px',
      fontSize: '10px',
      fontWeight: 600,
      borderRadius: '8px',
      background: color + '22',
      color: color,
      letterSpacing: '0.3px',
      textTransform: 'lowercase',
      flexShrink: 0,
    }}>${type || 'unknown'}</span>
  `;
}

export default function FileChanges({ agentName }) {
  const fileChanges = useStore(s => s.fileChanges);

  const grouped = useMemo(() => {
    if (!fileChanges || fileChanges.length === 0) return [];

    // Filter by agent if prop provided
    let filtered = fileChanges;
    if (agentName) {
      filtered = fileChanges.filter(fc => fc.agent === agentName);
    }

    // Sort newest first
    const sorted = [...filtered].sort((a, b) => {
      const tA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tB - tA;
    });

    // Group by agent
    const groups = {};
    for (const fc of sorted) {
      const key = fc.agent || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(fc);
    }

    return Object.entries(groups);
  }, [fileChanges, agentName]);

  if (!grouped || grouped.length === 0) {
    return html`
      <div style=${{
        padding: '16px',
        color: '#666',
        fontSize: '13px',
        fontStyle: 'italic',
      }}>
        No file changes tracked
      </div>
    `;
  }

  return html`
    <div style=${{ padding: '0' }}>
      ${grouped.map(([agent, changes]) => html`
        <div key=${agent}>
          ${!agentName && html`
            <div style=${{
              padding: '6px 12px',
              fontSize: '11px',
              fontWeight: 600,
              color: '#aaa',
              background: 'rgba(255,255,255,0.03)',
              borderBottom: '1px solid #333',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>${agent}</div>
          `}
          ${changes.map((fc, i) => html`
            <div key=${i} style=${{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 12px',
              borderBottom: '1px solid #2a2a3a',
              fontSize: '12px',
            }}>
              <${TypeBadge} type=${fc.type} />
              <span style=${{
                fontFamily: 'var(--font-mono, monospace)',
                color: '#ccc',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: '12px',
              }}>${fc.path || ''}</span>
              <span style=${{
                fontSize: '10px',
                color: '#666',
                flexShrink: 0,
                fontFamily: 'var(--font-mono, monospace)',
              }}>${formatTimestamp(fc.timestamp)}</span>
            </div>
          `)}
        </div>
      `)}
    </div>
  `;
}
