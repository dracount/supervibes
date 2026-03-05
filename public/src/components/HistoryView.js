import { h } from '../lib/preact.module.js';
import { useState, useEffect } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState } from '../state/store.js';
import { getHistoryList, getHistoryRun, deleteHistoryRun } from '../state/api.js';
import { formatDuration, outcomeBadge } from '../lib/format.js';

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}

function formatCost(cost) {
  if (cost == null) return '-';
  return '$' + Number(cost).toFixed(2);
}

export function HistoryView() {
  const showHistory = useStore(s => s.showHistory);
  const historyRuns = useStore(s => s.historyRuns);
  const historySelectedRun = useStore(s => s.historySelectedRun);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch history list on mount
  useEffect(() => {
    if (!showHistory) return;
    setLoading(true);
    setError(null);
    getHistoryList(50)
      .then(runs => {
        setState({ historyRuns: runs });
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [showHistory]);

  if (!showHistory) return null;

  function close() {
    setState({ showHistory: false, historySelectedRun: null });
  }

  async function selectRun(id) {
    setLoading(true);
    setError(null);
    try {
      const run = await getHistoryRun(id);
      setState({ historySelectedRun: run });
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleDelete(e, id) {
    e.stopPropagation();
    if (!confirm('Delete this run from history?')) return;
    try {
      await deleteHistoryRun(id);
      const runs = await getHistoryList(50);
      setState({ historyRuns: runs });
    } catch (err) {
      setError(err.message);
    }
  }

  function goBack() {
    setState({ historySelectedRun: null });
  }

  // Overlay styles
  const overlayStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: '#1a1a2e',
    zIndex: 100,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const headerStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid #333',
    flexShrink: 0,
  };

  const contentStyle = {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    justifyContent: 'center',
    padding: '16px',
  };

  const innerStyle = {
    width: '100%',
    maxWidth: '900px',
  };

  const closeBtnStyle = {
    background: 'none',
    border: '1px solid #555',
    color: '#ccc',
    padding: '4px 12px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
  };

  // Detail view
  if (historySelectedRun) {
    const run = historySelectedRun;
    const tasks = run.tasks || run.taskStatus || [];
    const summary = run.workflowSummary || {};
    const taskArray = Array.isArray(tasks) ? tasks : Object.entries(tasks).map(([name, t]) => ({ name, ...t }));

    return html`
      <div style=${overlayStyle}>
        <div style=${headerStyle}>
          <div style=${{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button style=${closeBtnStyle} onClick=${goBack}>Back</button>
            <span style=${{ color: '#e0e0e0', fontSize: '15px', fontWeight: 600 }}>
              ${run.goal || 'Untitled run'}
            </span>
          </div>
          <button style=${closeBtnStyle} onClick=${close}>Close</button>
        </div>

        <div style=${contentStyle}>
          <div style=${innerStyle}>
            ${error && html`<div style=${{ color: '#ef9a9a', marginBottom: '12px' }}>${error}</div>`}

            <!-- Summary cards -->
            <div style=${{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: '12px',
              marginBottom: '20px',
            }}>
              ${summaryCard('Outcome', outcomeBadge(run.outcome || run.phase))}
              ${summaryCard('Model', html`<span style=${{ color: '#e0e0e0' }}>${run.model || '-'}</span>`)}
              ${summaryCard('Duration', html`<span style=${{ color: '#e0e0e0' }}>${formatDuration(run.duration || run.durationMs)}</span>`)}
              ${summaryCard('Cost', html`<span style=${{ color: '#e0e0e0' }}>${formatCost(run.totalCost || run.cost)}</span>`)}
            </div>

            <!-- Workflow summary counts -->
            ${(summary.totalTasks || summary.completed || summary.failed) && html`
              <div style=${{
                display: 'flex', gap: '16px', marginBottom: '16px',
                fontSize: '13px', color: '#aaa',
              }}>
                ${summary.totalTasks != null && html`<span>Total: ${summary.totalTasks}</span>`}
                ${summary.completed != null && html`<span style=${{ color: '#81c784' }}>Completed: ${summary.completed}</span>`}
                ${summary.failed != null && html`<span style=${{ color: '#ef9a9a' }}>Failed: ${summary.failed}</span>`}
              </div>
            `}

            <!-- Task breakdown table -->
            ${taskArray.length > 0 && html`
              <div style=${{ marginTop: '8px' }}>
                <div style=${{ fontSize: '14px', fontWeight: 600, color: '#e0e0e0', marginBottom: '8px' }}>
                  Task Breakdown
                </div>
                <table style=${{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style=${{ borderBottom: '1px solid #444' }}>
                      <th style=${thStyle}>Name</th>
                      <th style=${thStyle}>Status</th>
                      <th style=${thStyle}>Duration</th>
                      <th style=${thStyle}>Attempts</th>
                      <th style=${thStyle}>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${taskArray.map((t, i) => html`
                      <tr style=${{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                        <td style=${tdStyle}>${t.name || '-'}</td>
                        <td style=${tdStyle}>${outcomeBadge(t.status)}</td>
                        <td style=${tdStyle}>${formatDuration(t.duration || (t.completedAt && t.startedAt ? t.completedAt - t.startedAt : null))}</td>
                        <td style=${tdStyle}>${t.attempts || t.attempt || '-'}</td>
                        <td style=${{ ...tdStyle, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          ${t.error ? (t.error.length > 80 ? t.error.slice(0, 80) + '...' : t.error) : '-'}
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  // List view
  return html`
    <div style=${overlayStyle}>
      <div style=${headerStyle}>
        <span style=${{ color: '#e0e0e0', fontSize: '15px', fontWeight: 600 }}>Run History</span>
        <button style=${closeBtnStyle} onClick=${close}>Close</button>
      </div>

      <div style=${contentStyle}>
        <div style=${innerStyle}>
          ${error && html`<div style=${{ color: '#ef9a9a', marginBottom: '12px' }}>${error}</div>`}
          ${loading && html`<div style=${{ color: '#888', marginBottom: '12px' }}>Loading...</div>`}

          ${!loading && historyRuns.length === 0 && html`
            <div style=${{
              color: '#666',
              fontSize: '14px',
              textAlign: 'center',
              padding: '40px 0',
              fontStyle: 'italic',
            }}>
              No run history yet
            </div>
          `}

          ${historyRuns.length > 0 && html`
            <table style=${{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style=${{ borderBottom: '1px solid #444' }}>
                  <th style=${thStyle}>Goal</th>
                  <th style=${thStyle}>Model</th>
                  <th style=${thStyle}>Outcome</th>
                  <th style=${thStyle}>Duration</th>
                  <th style=${thStyle}>Tasks</th>
                  <th style=${thStyle}>Cost</th>
                  <th style=${thStyle}>Date</th>
                  <th style=${{ ...thStyle, width: '30px' }}></th>
                </tr>
              </thead>
              <tbody>
                ${historyRuns.map((run, i) => html`
                  <tr
                    style=${{
                      background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                    }}
                    onClick=${() => selectRun(run.id)}
                    onMouseEnter=${(e) => { e.currentTarget.style.background = 'rgba(79,195,247,0.08)'; }}
                    onMouseLeave=${(e) => { e.currentTarget.style.background = i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent'; }}
                  >
                    <td style=${{ ...tdStyle, maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      ${run.goal ? (run.goal.length > 60 ? run.goal.slice(0, 60) + '...' : run.goal) : '-'}
                    </td>
                    <td style=${tdStyle}>
                      <span style=${{
                        display: 'inline-block',
                        padding: '1px 6px',
                        borderRadius: '3px',
                        fontSize: '10px',
                        background: 'rgba(255,255,255,0.08)',
                        color: '#aaa',
                      }}>${run.model || '-'}</span>
                    </td>
                    <td style=${tdStyle}>${outcomeBadge(run.outcome || run.phase)}</td>
                    <td style=${tdStyle}>${formatDuration(run.duration || run.durationMs)}</td>
                    <td style=${tdStyle}>${run.taskCount != null ? run.taskCount : (run.tasks ? (Array.isArray(run.tasks) ? run.tasks.length : Object.keys(run.tasks).length) : '-')}</td>
                    <td style=${tdStyle}>${formatCost(run.totalCost || run.cost)}</td>
                    <td style=${tdStyle}>${formatDate(run.startedAt || run.timestamp || run.date)}</td>
                    <td style=${tdStyle}>
                      <button
                        style=${{
                          background: 'none',
                          border: 'none',
                          color: '#f44336',
                          cursor: 'pointer',
                          fontSize: '14px',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          lineHeight: 1,
                        }}
                        onClick=${(e) => handleDelete(e, run.id)}
                        title="Delete run"
                      >x</button>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </div>
      </div>
    </div>
  `;
}

// Shared table styles
const thStyle = {
  textAlign: 'left',
  padding: '8px 10px',
  color: '#888',
  fontWeight: 600,
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  whiteSpace: 'nowrap',
};

const tdStyle = {
  padding: '8px 10px',
  color: '#ccc',
  borderBottom: '1px solid rgba(255,255,255,0.04)',
};

function summaryCard(label, valueHtml) {
  return html`
    <div style=${{
      background: 'rgba(255,255,255,0.04)',
      borderRadius: '6px',
      padding: '12px 16px',
    }}>
      <div style=${{ fontSize: '11px', color: '#888', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        ${label}
      </div>
      <div style=${{ fontSize: '14px' }}>
        ${valueHtml}
      </div>
    </div>
  `;
}
