import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState } from '../state/store.js';
import { startBuild, stopBuild, emergencyStop } from '../state/api.js';

const MODEL_PRICING = {
  sonnet: { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreation: 3.75 },
  opus:   { input: 15.0, output: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },
  haiku:  { input: 0.80, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
};

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export function CommandBar() {
  const running = useStore(s => s.running);
  const phase = useStore(s => s.phase);
  const model = useStore(s => s.model);
  const agentStates = useStore(s => s.agentStates);
  const taskPlan = useStore(s => s.taskPlan);
  const taskStatus = useStore(s => s.taskStatus);
  const workflowStartedAt = useStore(s => s.workflowStartedAt);

  const [goal, setGoal] = useState('');
  const [termCount, setTermCount] = useState('auto');
  const [selModel, setSelModel] = useState('sonnet');
  const [iters, setIters] = useState(0);
  const [structured, setStructured] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  // Elapsed timer
  useEffect(() => {
    if (!workflowStartedAt) { setElapsed(0); return; }
    const iv = setInterval(() => {
      setElapsed(Math.round((Date.now() - workflowStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [workflowStartedAt]);

  // Compute totals
  let totalIn = 0, totalOut = 0, totalCR = 0, totalCW = 0;
  for (const a of Object.values(agentStates)) {
    const t = a.tokens || {};
    totalIn += t.input || 0;
    totalOut += t.output || 0;
    totalCR += t.cacheRead || 0;
    totalCW += t.cacheCreation || 0;
  }
  const pricing = MODEL_PRICING[selModel] || MODEL_PRICING.sonnet;
  const cost = (totalIn * pricing.input + totalOut * pricing.output +
    totalCR * pricing.cacheRead + totalCW * pricing.cacheCreation) / 1000000;
  const burnRate = elapsed > 0 ? cost / elapsed : 0;

  // Task progress
  const tasks = taskPlan ? taskPlan.tasks || [] : [];
  const completedTasks = Object.values(taskStatus).filter(t =>
    t.status === 'completed' || t.status === 'completed_with_errors'
  ).length;
  const totalTasks = tasks.length;
  const progressPct = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

  async function handleStart() {
    if (!goal.trim()) return;
    await startBuild({ goal: goal.trim(), terminalCount: termCount, model: selModel, iterations: iters, structured });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !running) handleStart();
  }

  return html`
    <div class="command-bar">
      <span class="brand">HiveMind</span>
      <input class="goal-input"
        placeholder="Enter your goal..."
        value=${goal}
        onInput=${e => setGoal(e.target.value)}
        onKeyDown=${handleKeyDown}
        disabled=${running}
      />
      <select value=${selModel} onChange=${e => setSelModel(e.target.value)} disabled=${running}>
        <option value="sonnet">Sonnet</option>
        <option value="opus">Opus</option>
        <option value="haiku">Haiku</option>
      </select>
      <select value=${termCount} onChange=${e => setTermCount(e.target.value)} disabled=${running}>
        <option value="auto">Auto</option>
        ${[1,2,3,4,5,6].map(n => html`<option value=${String(n)}>${n}T</option>`)}
      </select>
      <select value=${String(iters)} onChange=${e => setIters(parseInt(e.target.value))} disabled=${running}>
        ${[0,1,2,3,4,5].map(n => html`<option value=${String(n)}>${n} iter</option>`)}
      </select>
      <label class="toggle-label">
        <input type="checkbox" checked=${structured} onChange=${e => setStructured(e.target.checked)} disabled=${running} />
        Structured
      </label>
      ${!running && html`<button class="btn btn-start" onClick=${handleStart}>START</button>`}
      ${running && html`<button class="btn btn-stop" onClick=${stopBuild}>STOP</button>`}
      ${running && html`<button class="btn btn-estop" onClick=${emergencyStop}>E-STOP</button>`}
    </div>
    ${running && html`
      <div class="telemetry-bar">
        <div class="telem-item">
          <span class="telem-label">Phase:</span>
          <span class="telem-value">${phase}</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Time:</span>
          <span class="telem-value telem-time">${fmtTime(elapsed)}</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Cost:</span>
          <span class="telem-value telem-cost">$${cost.toFixed(2)}</span>
          <span class="telem-label">($${burnRate.toFixed(3)}/s)</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Tokens:</span>
          <span class="telem-value telem-tokens">${formatTokens(totalIn + totalOut)}</span>
        </div>
        <div class="telem-item">
          <span class="telem-label">Tasks:</span>
          <span class="telem-value">${completedTasks}/${totalTasks}</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${progressPct}%"></div>
        </div>
      </div>
    `}
  `;
}
