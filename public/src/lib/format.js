import { html } from './html.js';

export function formatDuration(ms) {
  if (!ms) return '-';
  const s = typeof ms === 'number' && ms > 1000 ? Math.floor(ms / 1000) : ms;
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function outcomeBadge(outcome, { large = false } = {}) {
  const lower = (outcome || '').toLowerCase();
  let bg, color;
  if (lower === 'completed' || lower === 'success') {
    bg = 'rgba(6, 214, 160, 0.2)'; color = 'var(--state-completed, #81c784)';
  } else if (lower === 'failed') {
    bg = 'rgba(239, 71, 111, 0.2)'; color = 'var(--state-failed, #ef9a9a)';
  } else if (lower === 'stopped') {
    bg = 'rgba(255, 209, 102, 0.2)'; color = 'var(--state-retrying, #ffd54f)';
  } else {
    bg = 'rgba(255,255,255,0.08)'; color = 'var(--text-secondary, #aaa)';
  }
  return html`<span style=${{
    display: 'inline-block',
    padding: large ? '6px 20px' : '2px 8px',
    borderRadius: large ? '6px' : '4px',
    fontSize: large ? '16px' : '11px',
    fontWeight: large ? 700 : 600,
    background: bg,
    color: color,
    textTransform: 'uppercase',
    letterSpacing: large ? '1px' : '0.5px',
  }}>${outcome || 'unknown'}</span>`;
}
