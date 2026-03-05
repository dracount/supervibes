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
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/pause`, { method: 'POST' });
  return res.json();
}

export async function resumeAgent(name) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/resume`, { method: 'POST' });
  return res.json();
}

export async function injectPrompt(name, prompt) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return res.json();
}

export async function killAgent(name, restart = false) {
  const res = await fetch(`/api/agent/${encodeURIComponent(name)}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restart }),
  });
  return res.json();
}

export async function approveGate(name, response = '') {
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
