import { h } from '../lib/preact.module.js';
import { useState, useEffect, useCallback } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState } from '../state/store.js';

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function outcomeBadge(outcome) {
  const lower = (outcome || '').toLowerCase();
  let bg, color;
  if (lower === 'completed' || lower === 'success') {
    bg = 'rgba(6, 214, 160, 0.2)'; color = 'var(--state-completed)';
  } else if (lower === 'failed') {
    bg = 'rgba(239, 71, 111, 0.2)'; color = 'var(--state-failed)';
  } else if (lower === 'stopped') {
    bg = 'rgba(255, 209, 102, 0.2)'; color = 'var(--state-retrying)';
  } else {
    bg = 'rgba(255,255,255,0.08)'; color = 'var(--text-secondary)';
  }
  return html`<span style=${{
    display: 'inline-block',
    padding: '6px 20px',
    borderRadius: '6px',
    fontSize: '16px',
    fontWeight: 700,
    background: bg,
    color: color,
    textTransform: 'uppercase',
    letterSpacing: '1px',
  }}>${outcome || 'unknown'}</span>`;
}

export function WorkflowSummary() {
  const summary = useStore(s => s.workflowSummary);
  const [showModal, setShowModal] = useState(false);

  // Auto-show when summary appears
  useEffect(() => {
    if (summary) {
      setShowModal(true);
    }
  }, [summary]);

  // Expose show function for CommandPalette via store
  useEffect(() => {
    // Store the opener function so CommandPalette can call it
    window.__showWorkflowSummary = () => setShowModal(true);
    return () => { delete window.__showWorkflowSummary; };
  }, []);

  // Esc to close
  useEffect(() => {
    if (!showModal) return;
    function handleKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowModal(false);
      }
    }
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [showModal]);

  if (!showModal || !summary) return null;

  const { totalTasks, counts, elapsed, outcome, taskDetails } = summary;
  const retriedTasks = (taskDetails || []).filter(t => t.attempts > 1);

  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) setShowModal(false);
  }

  return html`
    <div style=${overlayStyle} onClick=${handleOverlayClick}>
      <div style=${cardStyle}>
        <!-- Header -->
        <div style=${headerStyle}>
          <span style=${{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Workflow Complete
          </span>
          <button style=${closeBtnStyle} onClick=${() => setShowModal(false)}>
            \u2715
          </button>
        </div>

        <!-- Outcome badge -->
        <div style=${{ textAlign: 'center', padding: '20px 0 16px' }}>
          ${outcomeBadge(outcome)}
        </div>

        <!-- Stats grid 2x2 -->
        <div style=${gridStyle}>
          ${statCard('Total Tasks', totalTasks || 0, 'var(--text-primary)')}
          ${statCard('Completed', counts?.completed || 0, 'var(--state-completed)')}
          ${statCard('Failed', (counts?.failed || 0) + (counts?.timed_out || 0), 'var(--state-failed)')}
          ${statCard('Duration', formatDuration(elapsed), 'var(--telem-time)')}
        </div>

        <!-- Extra counts if present -->
        ${(counts?.completed_with_errors > 0 || counts?.cancelled > 0) && html`
          <div style=${{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '8px', fontSize: '12px' }}>
            ${counts?.completed_with_errors > 0 && html`
              <span style=${{ color: 'var(--state-retrying)' }}>
                ${counts.completed_with_errors} completed with errors
              </span>
            `}
            ${counts?.cancelled > 0 && html`
              <span style=${{ color: 'var(--text-muted)' }}>
                ${counts.cancelled} cancelled
              </span>
            `}
          </div>
        `}

        <!-- Retried tasks -->
        ${retriedTasks.length > 0 && html`
          <div style=${{ marginTop: '16px', padding: '0 4px' }}>
            <div style=${{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Retried Tasks
            </div>
            ${retriedTasks.map(t => html`
              <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', fontSize: '12px', borderRadius: '4px', background: 'rgba(255, 209, 102, 0.06)' }}>
                <span style=${{ color: 'var(--text-primary)' }}>${t.name}</span>
                <span style=${{ color: 'var(--state-retrying)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                  ${t.attempts}/${t.maxAttempts} attempts
                </span>
              </div>
            `)}
          </div>
        `}

        <!-- Close button -->
        <div style=${{ marginTop: '20px', textAlign: 'center' }}>
          <button style=${actionBtnStyle} onClick=${() => setShowModal(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  `;
}

// --- Styles ---

const overlayStyle = {
  position: 'fixed',
  inset: '0',
  background: 'rgba(0, 0, 0, 0.7)',
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const cardStyle = {
  width: '460px',
  maxWidth: '90vw',
  maxHeight: '80vh',
  overflowY: 'auto',
  background: '#1e1e3a',
  borderRadius: '12px',
  border: '1px solid var(--border-active)',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.6)',
  padding: '24px',
};

const headerStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const closeBtnStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--text-muted)',
  fontSize: '16px',
  cursor: 'pointer',
  padding: '4px 8px',
  borderRadius: '4px',
  lineHeight: 1,
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '10px',
};

const actionBtnStyle = {
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid var(--border-active)',
  color: 'var(--text-primary)',
  padding: '8px 24px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '13px',
  fontFamily: 'var(--font-ui)',
};

function statCard(label, value, color) {
  return html`
    <div style=${{
      background: 'rgba(255, 255, 255, 0.04)',
      borderRadius: '8px',
      padding: '14px 16px',
      textAlign: 'center',
    }}>
      <div style=${{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
        ${label}
      </div>
      <div style=${{ fontSize: '22px', fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
        ${value}
      </div>
    </div>
  `;
}
