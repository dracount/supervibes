/**
 * Compute graph layout from a task plan.
 * Returns { nodes: [{name, x, y, w, h, phase}], edges: [{from, to, points}] }
 *
 * Algorithm: phase-based column layout
 * - X: phase index * column width
 * - Y: index within phase * row height, centered vertically
 */

const NODE_W = 180;
const NODE_H = 90;
const COL_GAP = 60;
const ROW_GAP = 24;

export function computeLayout(plan, containerW, containerH) {
  if (!plan || !plan.tasks || plan.tasks.length === 0) {
    return { nodes: [], edges: [], phases: [] };
  }

  const tasks = plan.tasks;
  const phases = computePhases(tasks);

  // Compute node positions
  const nodes = [];
  const nodeMap = {}; // name -> node

  const totalCols = phases.length;
  const totalW = totalCols * (NODE_W + COL_GAP) - COL_GAP;
  const offsetX = Math.max(40, (containerW - totalW) / 2);

  for (let pi = 0; pi < phases.length; pi++) {
    const phase = phases[pi];
    const totalRows = phase.length;
    const totalH = totalRows * (NODE_H + ROW_GAP) - ROW_GAP;
    const offsetY = Math.max(20, (containerH - totalH) / 2);

    for (let ri = 0; ri < phase.length; ri++) {
      const taskName = phase[ri];
      const task = tasks.find(t => t.name === taskName);
      const x = offsetX + pi * (NODE_W + COL_GAP);
      const y = offsetY + ri * (NODE_H + ROW_GAP);

      const node = { name: taskName, x, y, w: NODE_W, h: NODE_H, phase: pi, task };
      nodes.push(node);
      nodeMap[taskName] = node;
    }
  }

  // Compute edges
  const edges = [];
  for (const task of tasks) {
    if (!task.dependencies) continue;
    for (const dep of task.dependencies) {
      const from = nodeMap[dep];
      const to = nodeMap[task.name];
      if (from && to) {
        edges.push({
          from: dep,
          to: task.name,
          x1: from.x + from.w,
          y1: from.y + from.h / 2,
          x2: to.x,
          y2: to.y + to.h / 2,
        });
      }
    }
  }

  return { nodes, edges, phases };
}

function computePhases(tasks) {
  const phases = [];
  const done = new Set();
  let remaining = [...tasks];

  while (remaining.length > 0) {
    const phase = remaining.filter(t =>
      (t.dependencies || []).every(d => done.has(d))
    );
    if (phase.length === 0) {
      phases.push(remaining.map(t => t.name));
      break;
    }
    phases.push(phase.map(t => t.name));
    for (const t of phase) done.add(t.name);
    remaining = remaining.filter(t => !done.has(t.name));
  }

  return phases;
}

export { NODE_W, NODE_H };
