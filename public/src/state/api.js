import { sendCommand } from './connection.js';

export async function startBuild({ goal, terminalCount, model, iterations, structured }) {
  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, terminalCount, model, iterations, structured }),
  });
  return res.json();
}

export async function stopBuild() {
  await fetch('/api/stop', { method: 'POST' });
}

export async function emergencyStop() {
  await fetch('/api/estop', { method: 'POST' });
}

export async function pauseAgent(name) {
  if (sendCommand('pause', name)) return { ok: true };
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/pause`, { method: 'POST' });
  return res.json();
}

export async function resumeAgent(name) {
  if (sendCommand('resume', name)) return { ok: true };
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/resume`, { method: 'POST' });
  return res.json();
}

export async function injectPrompt(name, prompt) {
  if (sendCommand('inject', name, { prompt })) return { ok: true };
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return res.json();
}

export async function killAgent(name, restart = false) {
  if (sendCommand('kill', name, { restart })) return { ok: true };
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restart }),
  });
  return res.json();
}

export async function approveGate(name, response = '') {
  if (sendCommand('approve', name, { response })) return { ok: true };
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response }),
  });
  return res.json();
}

export async function getAgentTail(name, lines = 50) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/tail?lines=${lines}`);
  return res.json();
}

// --- History API ---

export async function getHistoryList(limit = 20) {
  const res = await fetch(`/api/history?limit=${limit}`);
  if (!res.ok) throw new Error(`History list failed: ${res.status}`);
  return res.json();
}

export async function getHistoryRun(id) {
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`History run failed: ${res.status}`);
  return res.json();
}

export async function deleteHistoryRun(id) {
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`History delete failed: ${res.status}`);
  return res.json();
}

// --- Analytics API ---

export async function getAnalytics() {
  const res = await fetch('/api/analytics');
  if (!res.ok) throw new Error(`Analytics failed: ${res.status}`);
  return res.json();
}
