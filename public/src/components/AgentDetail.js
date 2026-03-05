import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore } from '../state/store.js';
import { pauseAgent, resumeAgent, injectPrompt, killAgent, getAgentTail } from '../state/api.js';
import ConversationView from './ConversationView.js';

function stateColor(state) {
  const map = {
    active: 'var(--state-active)', in_progress: 'var(--state-active)',
    thinking: 'var(--state-thinking)', tool_use: 'var(--state-tool-use)',
    waiting: 'var(--state-waiting)', completed: 'var(--state-completed)',
    failed: 'var(--state-failed)', retrying: 'var(--state-retrying)',
    timed_out: 'var(--state-failed)', idle: 'var(--state-idle)',
    completed_with_errors: 'var(--state-retrying)',
  };
  return map[state] || map.idle;
}

function fmtElapsed(startedAt) {
  if (!startedAt) return '';
  const s = Math.round((Date.now() - startedAt) / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

export function AgentDetail() {
  const selectedAgent = useStore(s => s.selectedAgent);
  const taskPlan = useStore(s => s.taskPlan);
  const taskStatus = useStore(s => s.taskStatus);
  const agentStates = useStore(s => s.agentStates);
  const contextWarnings = useStore(s => s.contextWarnings);
  const running = useStore(s => s.running);
  const logEntries = useStore(s => s.logEntries);
  const postChecks = useStore(s => s.postChecks);
  const guardrailResults = useStore(s => s.guardrailResults);
  const agentConversations = useStore(s => s.agentConversations);

  const [showInject, setShowInject] = useState(false);
  const [injectText, setInjectText] = useState('');
  const [tailLines, setTailLines] = useState([]);
  const tailRef = useRef(null);
  const [activeTab, setActiveTab] = useState('conversation');
  const [expandPostChecks, setExpandPostChecks] = useState(false);
  const [expandGuardrails, setExpandGuardrails] = useState(false);

  // Fetch tail periodically when agent selected and running
  useEffect(() => {
    if (!selectedAgent || !running) { setTailLines([]); return; }
    let cancelled = false;
    async function poll() {
      try {
        const data = await getAgentTail(selectedAgent, 30);
        if (!cancelled && data.lines) setTailLines(data.lines);
      } catch (_) {}
    }
    poll();
    const iv = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [selectedAgent, running]);

  // Auto-scroll tail
  useEffect(() => {
    if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
  }, [tailLines]);

  if (!selectedAgent) {
    return html`<div class="agent-detail">
      <div class="agent-detail-empty">Click a node to inspect</div>
    </div>`;
  }

  const task = taskPlan?.tasks?.find(t => t.name === selectedAgent) || {};
  const status = taskStatus[selectedAgent] || {};
  const agent = agentStates[selectedAgent] || {};
  const agentState = agent.state || status.status || 'idle';
  const tokens = agent.tokens || {};

  // Per-agent guardrail results
  const agentGuardrails = guardrailResults && guardrailResults[selectedAgent];

  // Prompts sent to this agent
  const prompts = logEntries
    .filter(e => e.type === 'prompt' && e.agent === selectedAgent)
    .map(e => e.detail);

  async function handleInject() {
    if (!injectText.trim()) return;
    await injectPrompt(selectedAgent, injectText.trim());
    setInjectText('');
    setShowInject(false);
  }

  const tabStyle = (tabName) => ({
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: activeTab === tabName ? '600' : '400',
    color: activeTab === tabName ? '#e0e0e0' : '#777',
    borderBottom: activeTab === tabName ? '2px solid #4fc3f7' : '2px solid transparent',
    userSelect: 'none',
    transition: 'color 0.15s, border-color 0.15s',
    whiteSpace: 'nowrap',
  });

  return html`
    <div class="agent-detail" style="display:flex;flex-direction:column;height:100%;">
      <!-- Always visible: header -->
      <div class="agent-header">
        <div class="agent-header-name">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${stateColor(agentState)}"></span>
          ${selectedAgent}
        </div>
        ${task.role && html`<div class="agent-header-role">${task.role}</div>`}
        <div class="agent-header-status">
          <span class="agent-state-badge" style="background:${stateColor(agentState)};color:#000;">
            ${(agentState || 'idle').replace(/_/g, ' ')}
          </span>
          ${status.startedAt && html`<span>${fmtElapsed(status.startedAt)} elapsed</span>`}
          ${status.attempts > 0 && html`<span>Attempt ${status.attempts}/${status.maxAttempts}</span>`}
        </div>
      </div>

      <!-- Always visible: task description -->
      ${task.description && html`
        <div class="agent-section" style="flex-shrink:0;padding:8px 12px;border-bottom:1px solid #333;">
          <div class="agent-section-title">Task</div>
          <div class="agent-section-body">${task.description}</div>
        </div>
      `}

        ${agentGuardrails && html`
          <div class="agent-section">
            <div class="agent-section-title">Guardrail Results</div>
            <div class="agent-section-body">
              ${(agentGuardrails.files || []).map(f => html`
                <div class="agent-output-check ${f.pass ? 'pass' : 'fail'}"
                  style="color:${f.pass ? 'var(--state-completed)' : 'var(--state-failed)'}">
                  ${f.pass ? '\u2713' : '\u2717'} ${f.file}
                </div>
              `)}
              ${(agentGuardrails.exports || []).map(e => html`
                <div class="agent-output-check ${e.found ? 'pass' : 'fail'}"
                  style="color:${e.found ? 'var(--state-completed)' : 'var(--state-failed)'}">
                  ${e.found ? '\u2713' : '\u2717'} export: ${e.export}
                </div>
              `)}
              ${(agentGuardrails.patterns || []).map(p => html`
                <div class="agent-output-check ${p.matched ? 'pass' : 'fail'}"
                  style="color:${p.matched ? 'var(--state-completed)' : 'var(--state-failed)'}">
                  ${p.matched ? '\u2713' : '\u2717'} pattern: ${p.pattern}
                </div>
              `)}
            </div>
          </div>
        `}

      <!-- Always visible: action buttons -->
      ${running && html`
        <div class="agent-actions" style="flex-shrink:0;padding:6px 12px;border-bottom:1px solid #333;">
          <button class="btn" onClick=${() => pauseAgent(selectedAgent)}>Pause</button>
          <button class="btn" onClick=${() => resumeAgent(selectedAgent)}>Resume</button>
          <button class="btn" onClick=${() => setShowInject(!showInject)}>Inject</button>
          <button class="btn btn-danger" onClick=${() => killAgent(selectedAgent, true)}>Restart</button>
        </div>
      `}

      ${showInject && html`
        <div class="inject-bar" style="flex-shrink:0;">
          <input placeholder="Inject prompt..." value=${injectText}
            onInput=${e => setInjectText(e.target.value)}
            onKeyDown=${e => e.key === 'Enter' && handleInject()}
            autofocus />
          <button class="btn" style="flex:none;padding:6px 12px;background:var(--state-thinking);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:10px;"
            onClick=${handleInject}>Send</button>
        </div>
      `}

      <!-- Error/failure banner (shown when task failed or timed_out) -->
      ${(status.status === 'failed' || status.status === 'timed_out') && html`
        <div style=${{
          flexShrink: 0,
          background: 'rgba(244, 67, 54, 0.15)',
          borderLeft: '3px solid #f44336',
          padding: '10px 12px',
          borderBottom: '1px solid #333',
        }}>
          <!-- Failure reason banner -->
          <div style=${{
            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px',
          }}>
            <span style=${{
              background: status.status === 'timed_out' ? '#ff9800' : '#f44336',
              color: '#fff', fontSize: '10px', fontWeight: 700,
              padding: '2px 8px', borderRadius: '3px', textTransform: 'uppercase',
            }}>${status.status === 'timed_out' ? 'Timed Out' : 'Failed'}</span>
            <span style=${{ color: '#ef9a9a', fontSize: '13px' }}>
              ${status.error || 'No error message available'}
            </span>
          </div>

          <!-- Post-check results (collapsible) -->
          ${postChecks && postChecks.length > 0 && html`
            <div style=${{ marginTop: '6px' }}>
              <div style=${{
                cursor: 'pointer', userSelect: 'none', fontSize: '12px',
                color: '#aaa', display: 'flex', alignItems: 'center', gap: '4px',
              }} onClick=${() => setExpandPostChecks(!expandPostChecks)}>
                <span style=${{ fontSize: '10px', display: 'inline-block', transform: expandPostChecks ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>${'\u25B6'}</span>
                Post-Check Results (${postChecks.length})
              </div>
              ${expandPostChecks && html`
                <div style=${{ marginTop: '4px', paddingLeft: '14px' }}>
                  ${postChecks.map(check => html`
                    <div style=${{ fontSize: '12px', marginBottom: '3px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style=${{
                        display: 'inline-block', fontSize: '10px', fontWeight: 700,
                        padding: '1px 6px', borderRadius: '3px',
                        background: check.passed || check.pass ? 'rgba(76, 175, 80, 0.2)' : 'rgba(244, 67, 54, 0.2)',
                        color: check.passed || check.pass ? '#81c784' : '#ef9a9a',
                      }}>${check.passed || check.pass ? 'PASS' : 'FAIL'}</span>
                      <span style=${{ color: '#ccc' }}>${check.name || check.description || check.label || JSON.stringify(check)}</span>
                    </div>
                  `)}
                </div>
              `}
            </div>
          `}

          <!-- Guardrail violations (collapsible) -->
          ${guardrailResults && guardrailResults.length > 0 && html`
            <div style=${{ marginTop: '6px' }}>
              <div style=${{
                cursor: 'pointer', userSelect: 'none', fontSize: '12px',
                color: '#aaa', display: 'flex', alignItems: 'center', gap: '4px',
              }} onClick=${() => setExpandGuardrails(!expandGuardrails)}>
                <span style=${{ fontSize: '10px', display: 'inline-block', transform: expandGuardrails ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>${'\u25B6'}</span>
                Guardrail Violations (${guardrailResults.length})
              </div>
              ${expandGuardrails && html`
                <div style=${{ marginTop: '4px', paddingLeft: '14px' }}>
                  ${guardrailResults.map(v => html`
                    <div style=${{ fontSize: '12px', marginBottom: '3px', color: '#ef9a9a' }}>
                      ${v.rule || v.message || v.description || JSON.stringify(v)}
                    </div>
                  `)}
                </div>
              `}
            </div>
          `}

          <!-- Last events before failure -->
          ${agentConversations && agentConversations[selectedAgent] && agentConversations[selectedAgent].length > 0 && html`
            <div style=${{ marginTop: '8px' }}>
              <div style=${{ fontSize: '12px', color: '#aaa', marginBottom: '4px' }}>Last events before failure:</div>
              <div style=${{ paddingLeft: '4px' }}>
                ${agentConversations[selectedAgent].slice(-5).map(ev => html`
                  <div style=${{ fontSize: '11px', marginBottom: '2px', display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                    <span style=${{
                      flexShrink: 0, fontSize: '10px', fontWeight: 600,
                      padding: '1px 4px', borderRadius: '2px',
                      background: 'rgba(255,255,255,0.08)', color: '#888',
                      fontFamily: 'var(--font-mono)',
                    }}>${ev.type || '?'}</span>
                    <span style=${{ color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                      ${(ev.content || ev.message || ev.text || JSON.stringify(ev)).substring(0, 120)}
                    </span>
                  </div>
                `)}
              </div>
            </div>
          `}
        </div>
      `}

      <!-- Tab bar -->
      <div style=${{
        display: 'flex',
        flexDirection: 'row',
        borderBottom: '1px solid #333',
        flexShrink: 0,
        background: '#1e1e2e',
      }}>
        <div style=${tabStyle('conversation')} onClick=${() => setActiveTab('conversation')}>Conversation</div>
        <div style=${tabStyle('files')} onClick=${() => setActiveTab('files')}>Files</div>
        <div style=${tabStyle('telemetry')} onClick=${() => setActiveTab('telemetry')}>Telemetry</div>
      </div>

      <!-- Tab content -->
      <div style=${{ flex: 1, overflowY: 'auto', minHeight: 0 }}>

        ${activeTab === 'conversation' && html`
          <div style=${{ height: '100%' }}>
            <${ConversationView} agentName=${selectedAgent} />
            ${tailLines.length > 0 && html`
              <div class="agent-tail" ref=${tailRef}>
                ${tailLines.join('\n')}
              </div>
            `}
          </div>
        `}

        ${activeTab === 'files' && html`
          <div class="agent-sections" style="padding:8px 0;">
            ${task.ownedFiles && task.ownedFiles.length > 0 ? html`
              <div class="agent-section">
                <div class="agent-section-title">Owned Files</div>
                <div class="agent-file-list">
                  ${task.ownedFiles.map(f => html`<div>${f}</div>`)}
                </div>
              </div>
            ` : html`
              <div style=${{ padding: '16px', color: '#666', fontSize: '13px', fontStyle: 'italic' }}>
                No owned files defined
              </div>
            `}

            ${task.expectedOutput ? html`
              <div class="agent-section">
                <div class="agent-section-title">Expected Output</div>
                <div class="agent-section-body">
                  ${(task.expectedOutput.files || []).map(f => html`
                    <div class="agent-output-check pending">\u25cb ${f}</div>
                  `)}
                  ${(task.expectedOutput.exports || []).map(e => html`
                    <div class="agent-output-check pending">\u25cb export: ${e}</div>
                  `)}
                </div>
              </div>
            ` : html`
              <div style=${{ padding: '16px', color: '#666', fontSize: '13px', fontStyle: 'italic' }}>
                No expected outputs defined
              </div>
            `}
          </div>
        `}

        ${activeTab === 'telemetry' && html`
          <div class="agent-sections" style="padding:8px 0;">
            <div class="agent-section">
              <div class="agent-section-title">Token Usage</div>
              <div class="agent-section-body" style="font-family:var(--font-mono);">
                <div>In: ${(tokens.input || 0).toLocaleString()} | Out: ${(tokens.output || 0).toLocaleString()}</div>
                <div>Cache R: ${(tokens.cacheRead || 0).toLocaleString()} | W: ${(tokens.cacheCreation || 0).toLocaleString()}</div>
              </div>
            </div>

            <div class="agent-section">
              <div class="agent-section-title">Context Usage</div>
              <div class="agent-section-body" style="font-family:var(--font-mono);">
                <div>Input tokens: ${(tokens.input || 0).toLocaleString()}</div>
                <div>Cache read: ${(tokens.cacheRead || 0).toLocaleString()}</div>
                ${(() => {
                  const ctxIn = tokens.input || 0;
                  const ctxCache = tokens.cacheRead || 0;
                  const ctxPct = Math.min(100, Math.round(((ctxIn + ctxCache) / 200000) * 100));
                  const ctxColor = ctxPct > 75 ? '#f44336' : ctxPct >= 50 ? '#ff9800' : '#4caf50';
                  const hasWarning = !!(contextWarnings && contextWarnings[selectedAgent]);
                  return html`
                    <div style=${{ marginTop: '8px' }}>
                      <div style=${{
                        width: '100%',
                        height: '8px',
                        background: '#333',
                        borderRadius: '4px',
                        overflow: 'hidden',
                      }}>
                        <div style=${{
                          width: ctxPct + '%',
                          height: '100%',
                          background: ctxColor,
                          borderRadius: '4px',
                          transition: 'width 0.3s ease',
                          animation: hasWarning ? 'ctxPulseDetail 1s ease-in-out infinite' : 'none',
                        }}></div>
                      </div>
                      <div style=${{ color: '#999', fontSize: '11px', marginTop: '4px' }}>
                        ~${ctxPct}% context (est.)
                      </div>
                      ${hasWarning && html`
                        <div style=${{
                          color: '#f44336',
                          fontSize: '11px',
                          marginTop: '4px',
                          fontWeight: '600',
                        }}>
                          Context window pressure detected
                        </div>
                      `}
                    </div>
                  `;
                })()}
              </div>
            </div>

            <div class="agent-section">
              ${(status.maxAttempts || 0) > 1 ? html`
                <div class="agent-section-title" style="display:flex;align-items:center;gap:8px;">
                  Retry History
                  ${status.retryLogic && html`
                    <span style=${{
                      display: 'inline-block',
                      padding: '1px 6px',
                      fontSize: '9px',
                      fontWeight: 600,
                      borderRadius: '8px',
                      background: status.retryLogic === 'EXPONENTIAL_BACKOFF' ? 'rgba(255,152,0,0.15)' : 'rgba(79,195,247,0.15)',
                      color: status.retryLogic === 'EXPONENTIAL_BACKOFF' ? '#ff9800' : '#4fc3f7',
                      letterSpacing: '0.3px',
                    }}>${status.retryLogic === 'EXPONENTIAL_BACKOFF' ? 'EXPONENTIAL' : status.retryLogic}</span>
                  `}
                </div>
                <div class="agent-section-body">
                  <!-- Attempt dots timeline -->
                  <div style=${{
                    display: 'inline-flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '8px',
                  }}>
                    ${Array.from({ length: status.maxAttempts }, (_, i) => {
                      const attemptNum = i + 1;
                      const current = status.attempts || 0;
                      const isFilled = attemptNum <= current;
                      const isLast = attemptNum === current;
                      let color = '#555';
                      if (isFilled) {
                        if (isLast) {
                          const s = status.status;
                          if (s === 'completed') color = '#4caf50';
                          else if (s === 'failed') color = '#f44336';
                          else if (s === 'timed_out') color = '#ff9800';
                          else if (s === 'in_progress' || s === 'retrying') color = '#4fc3f7';
                          else color = '#f44336';
                        } else {
                          color = '#f44336';
                        }
                      }
                      return html`<span style=${{
                        display: 'inline-block',
                        width: '12px',
                        height: '12px',
                        borderRadius: '50%',
                        background: isFilled ? color : 'transparent',
                        border: isFilled ? ('2px solid ' + color) : '2px solid #555',
                        boxSizing: 'border-box',
                        transition: 'background 0.2s, border-color 0.2s',
                      }} title=${'Attempt ' + attemptNum + (isFilled ? (isLast ? ' (current)' : ' (failed)') : ' (pending)')} />`;
                    })}
                  </div>

                  <!-- Details -->
                  <div style=${{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: '#aaa' }}>
                    <div>Attempt ${status.attempts || 0} of ${status.maxAttempts}</div>
                    ${status.retryLogic === 'EXPONENTIAL_BACKOFF'
                      ? html`<div style=${{ marginTop: '2px' }}>Retry delay: ${status.retryDelaySeconds || 30}s (exponential)</div>`
                      : html`<div style=${{ marginTop: '2px' }}>Retry delay: ${status.retryDelaySeconds || 30}s</div>`
                    }
                    ${status.error && html`
                      <div style=${{ marginTop: '4px', color: '#f44336', fontSize: '11px', wordBreak: 'break-word' }}>
                        ${status.error.length > 100 ? status.error.slice(0, 100) + '...' : status.error}
                      </div>
                    `}
                    ${status.startedAt && status.completedAt && html`
                      <div style=${{ marginTop: '4px', color: '#888' }}>
                        Duration: ${((status.completedAt - status.startedAt) / 1000).toFixed(1)}s
                      </div>
                    `}
                  </div>
                </div>
              ` : html`
                <div class="agent-section-title">Retry History</div>
                <div class="agent-section-body" style=${{ color: '#555', fontSize: '12px', fontStyle: 'italic' }}>
                  No retry policy configured
                </div>
              `}
            </div>

            ${prompts.length > 0 && html`
              <div class="agent-section">
                <div class="agent-section-title">Prompts Sent (${prompts.length})</div>
                <div class="agent-section-body">
                  ${prompts.map((p, i) => html`
                    <div style="margin-bottom:4px;">
                      <span style="color:var(--state-waiting);font-size:10px;">#${i + 1}</span>
                      <pre>${p}</pre>
                    </div>
                  `)}
                </div>
              </div>
            `}

            ${status.error && html`
              <div class="agent-section">
                <div class="agent-section-title" style="color:var(--state-failed);">Error</div>
                <div class="agent-section-body" style="color:var(--state-failed);font-style:italic;">
                  ${status.error}
                </div>
              </div>
            `}
          </div>
        `}
      </div>
    </div>
  `;
}
