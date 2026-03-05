import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore } from '../state/store.js';
import { pauseAgent, resumeAgent, injectPrompt, killAgent, getAgentTail } from '../state/api.js';

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
  const running = useStore(s => s.running);
  const logEntries = useStore(s => s.logEntries);

  const [showInject, setShowInject] = useState(false);
  const [injectText, setInjectText] = useState('');
  const [tailLines, setTailLines] = useState([]);
  const tailRef = useRef(null);

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

  return html`
    <div class="agent-detail">
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

      <div class="agent-sections">
        ${task.description && html`
          <div class="agent-section">
            <div class="agent-section-title">Task</div>
            <div class="agent-section-body">${task.description}</div>
          </div>
        `}

        ${task.ownedFiles && task.ownedFiles.length > 0 && html`
          <div class="agent-section">
            <div class="agent-section-title">Owned Files</div>
            <div class="agent-file-list">
              ${task.ownedFiles.map(f => html`<div>${f}</div>`)}
            </div>
          </div>
        `}

        ${task.expectedOutput && html`
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
        `}

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

        <div class="agent-section">
          <div class="agent-section-title">Telemetry</div>
          <div class="agent-section-body" style="font-family:var(--font-mono);">
            <div>In: ${(tokens.input || 0).toLocaleString()} | Out: ${(tokens.output || 0).toLocaleString()}</div>
            <div>Cache R: ${(tokens.cacheRead || 0).toLocaleString()} | W: ${(tokens.cacheCreation || 0).toLocaleString()}</div>
          </div>
        </div>

        ${status.error && html`
          <div class="agent-section">
            <div class="agent-section-title" style="color:var(--state-failed);">Error</div>
            <div class="agent-section-body" style="color:var(--state-failed);font-style:italic;">
              ${status.error}
            </div>
          </div>
        `}
      </div>

      ${tailLines.length > 0 && html`
        <div class="agent-tail" ref=${tailRef}>
          ${tailLines.join('\n')}
        </div>
      `}

      ${showInject && html`
        <div class="inject-bar">
          <input placeholder="Inject prompt..." value=${injectText}
            onInput=${e => setInjectText(e.target.value)}
            onKeyDown=${e => e.key === 'Enter' && handleInject()}
            autofocus />
          <button class="btn" style="flex:none;padding:6px 12px;background:var(--state-thinking);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:10px;"
            onClick=${handleInject}>Send</button>
        </div>
      `}

      ${running && html`
        <div class="agent-actions">
          <button class="btn" onClick=${() => pauseAgent(selectedAgent)}>Pause</button>
          <button class="btn" onClick=${() => resumeAgent(selectedAgent)}>Resume</button>
          <button class="btn" onClick=${() => setShowInject(!showInject)}>Inject</button>
          <button class="btn btn-danger" onClick=${() => killAgent(selectedAgent, true)}>Restart</button>
        </div>
      `}
    </div>
  `;
}
