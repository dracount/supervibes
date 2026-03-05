import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef, useMemo } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore } from '../state/store.js';

// --- Sub-components for each event type ---

function ThinkingBlock({ content, timestamp }) {
  const [expanded, setExpanded] = useState(false);

  return html`
    <div style=${{
      margin: '4px 0',
      borderLeft: '3px solid #555',
      borderRadius: '2px',
    }}>
      <div
        onClick=${() => setExpanded(!expanded)}
        style=${{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
          cursor: 'pointer',
          userSelect: 'none',
          color: '#999',
          fontSize: '12px',
          fontFamily: 'var(--font-mono, monospace)',
        }}
      >
        <span style=${{ fontSize: '10px', transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          \u25b6
        </span>
        <span>Thinking...</span>
        ${timestamp && html`<span style=${{ marginLeft: 'auto', fontSize: '10px', color: '#666' }}>${formatTime(timestamp)}</span>`}
      </div>
      ${expanded && html`
        <div style=${{
          padding: '6px 12px',
          color: '#888',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: '11px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.4',
          maxHeight: '300px',
          overflowY: 'auto',
        }}>
          ${content || ''}
        </div>
      `}
    </div>
  `;
}

function TextBlock({ content, timestamp }) {
  return html`
    <div style=${{
      margin: '4px 0',
      padding: '6px 10px',
      color: '#e0e0e0',
      fontSize: '13px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      lineHeight: '1.5',
      borderLeft: '3px solid #6b9eff',
      borderRadius: '2px',
    }}>
      <div style=${{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
        <span style=${{ fontSize: '10px', color: '#777', fontFamily: 'var(--font-mono, monospace)' }}>assistant</span>
        ${timestamp && html`<span style=${{ fontSize: '10px', color: '#666' }}>${formatTime(timestamp)}</span>`}
      </div>
      <div>${content || ''}</div>
    </div>
  `;
}

function ToolCallBlock({ toolName, input, toolId, timestamp }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = useMemo(() => {
    if (!input) return '';
    try {
      return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    } catch (_) {
      return String(input);
    }
  }, [input]);

  return html`
    <div style=${{
      margin: '4px 0',
      borderLeft: '3px solid #4a9eff',
      borderRadius: '2px',
    }}>
      <div
        onClick=${() => setExpanded(!expanded)}
        style=${{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: '12px',
        }}
      >
        <span style=${{ fontSize: '10px', transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', color: '#aaa' }}>
          \u25b6
        </span>
        <span style=${{
          display: 'inline-block',
          padding: '2px 8px',
          background: '#1a3a5c',
          color: '#6bafff',
          borderRadius: '10px',
          fontSize: '11px',
          fontFamily: 'var(--font-mono, monospace)',
          fontWeight: '600',
        }}>
          ${toolName || 'tool'}
        </span>
        ${toolId && html`<span style=${{ fontSize: '10px', color: '#555', fontFamily: 'var(--font-mono, monospace)' }}>${toolId.slice(0, 8)}</span>`}
        ${timestamp && html`<span style=${{ marginLeft: 'auto', fontSize: '10px', color: '#666' }}>${formatTime(timestamp)}</span>`}
      </div>
      ${expanded && inputStr && html`
        <div style=${{
          padding: '6px 12px',
          color: '#aaa',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: '11px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.3',
          maxHeight: '400px',
          overflowY: 'auto',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: '0 0 2px 2px',
        }}>
          ${inputStr}
        </div>
      `}
    </div>
  `;
}

function ToolResultBlock({ content, toolName, timestamp }) {
  const [expanded, setExpanded] = useState(false);
  const isTruncated = typeof content === 'string' && content.endsWith('\u2026');

  return html`
    <div style=${{
      margin: '4px 0',
      borderLeft: '3px solid #4a7a4a',
      borderRadius: '2px',
    }}>
      <div
        onClick=${() => setExpanded(!expanded)}
        style=${{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
          cursor: 'pointer',
          userSelect: 'none',
          color: '#8ab88a',
          fontSize: '12px',
        }}
      >
        <span style=${{ fontSize: '10px', transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          \u25b6
        </span>
        <span style=${{ fontFamily: 'var(--font-mono, monospace)' }}>
          result${toolName ? ': ' + toolName : ''}
        </span>
        ${isTruncated && html`<span style=${{
          fontSize: '10px',
          color: '#c9a84c',
          fontStyle: 'italic',
        }}>(truncated)</span>`}
        ${timestamp && html`<span style=${{ marginLeft: 'auto', fontSize: '10px', color: '#666' }}>${formatTime(timestamp)}</span>`}
      </div>
      ${expanded && html`
        <div style=${{
          padding: '6px 12px',
          color: '#a0c4a0',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: '11px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.3',
          maxHeight: '400px',
          overflowY: 'auto',
          background: 'rgba(0,0,0,0.2)',
          borderRadius: '0 0 2px 2px',
        }}>
          ${content || '(empty)'}
        </div>
      `}
    </div>
  `;
}

// --- Helpers ---

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) {
    return '';
  }
}

// --- Main component ---

export default function ConversationView({ agentName }) {
  const events = useStore(s => s.agentConversations[agentName]);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events, autoScroll]);

  // Detect if user scrolled away from bottom to pause auto-scroll
  function handleScroll() {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }

  if (!events || events.length === 0) {
    return html`
      <div style=${{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: '#666',
        fontSize: '13px',
        fontStyle: 'italic',
      }}>
        No conversation data yet
      </div>
    `;
  }

  return html`
    <div
      ref=${scrollRef}
      onScroll=${handleScroll}
      style=${{
        overflowY: 'auto',
        height: '100%',
        padding: '8px',
        background: '#1a1a2e',
        fontFamily: 'var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif)',
      }}
    >
      ${events.map((evt, i) => {
        const key = `${evt.type}-${evt.timestamp || ''}-${i}`;
        if (evt.type === 'thinking') {
          return html`<${ThinkingBlock}
            key=${key}
            content=${evt.content}
            timestamp=${evt.timestamp}
          />`;
        }
        if (evt.type === 'text') {
          return html`<${TextBlock}
            key=${key}
            content=${evt.content}
            timestamp=${evt.timestamp}
          />`;
        }
        if (evt.type === 'tool_call') {
          return html`<${ToolCallBlock}
            key=${key}
            toolName=${evt.toolName}
            input=${evt.input}
            toolId=${evt.toolId}
            timestamp=${evt.timestamp}
          />`;
        }
        if (evt.type === 'tool_result') {
          return html`<${ToolResultBlock}
            key=${key}
            content=${evt.content}
            toolName=${evt.toolName}
            timestamp=${evt.timestamp}
          />`;
        }
        // Unknown event type — render minimal fallback
        return html`
          <div key=${key} style=${{
            margin: '4px 0',
            padding: '4px 8px',
            color: '#888',
            fontSize: '11px',
            fontFamily: 'var(--font-mono, monospace)',
            borderLeft: '3px solid #444',
          }}>
            [${evt.type}] ${evt.content || ''}
          </div>
        `;
      })}
      <div ref=${bottomRef} />
    </div>
  `;
}
