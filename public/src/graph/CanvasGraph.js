import { h } from '../lib/preact.module.js';
import { useRef, useEffect, useCallback } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { computeLayout, NODE_W, NODE_H } from './layout.js';

// -- Color map (matches theme.css CSS variables resolved to hex) --
const STATE_COLORS = {
  active: '#00ff88', thinking: '#7c5cff', tool_use: '#ff9f1c',
  waiting: '#3a86ff', completed: '#06d6a0', failed: '#ef476f',
  timed_out: '#ff9800', retrying: '#ffd166', idle: '#404060',
  human: '#e040fb',
};

const BG_SURFACE = '#12121e';
const BG_VOID = '#0a0a12';
const BORDER_ACTIVE = 'rgba(255,255,255,0.12)';
const TEXT_PRIMARY = '#e8e8f0';
const TEXT_SECONDARY = '#8888a8';
const TEXT_MUTED = '#555570';
const FONT_MONO = '"JetBrains Mono","SF Mono","Fira Code",Menlo,Consolas,monospace';
const FONT_UI = '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';

// -- Spatial grid for hit-testing --
const GRID_CELL = 120;

function buildSpatialGrid(nodes) {
  const grid = {};
  for (const n of nodes) {
    const x0 = Math.floor(n.x / GRID_CELL);
    const y0 = Math.floor(n.y / GRID_CELL);
    const x1 = Math.floor((n.x + n.w) / GRID_CELL);
    const y1 = Math.floor((n.y + n.h) / GRID_CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = `${gx},${gy}`;
        if (!grid[key]) grid[key] = [];
        grid[key].push(n);
      }
    }
  }
  return grid;
}

function hitTest(grid, wx, wy) {
  const key = `${Math.floor(wx / GRID_CELL)},${Math.floor(wy / GRID_CELL)}`;
  const candidates = grid[key];
  if (!candidates) return null;
  for (const n of candidates) {
    if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
      return n;
    }
  }
  return null;
}

// -- Drawing helpers --

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawEdge(ctx, e, resolved) {
  const { x1, y1, x2, y2 } = e;
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(40, dx * 0.4);

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(x1 + cp, y1, x2 - cp, y2, x2, y2);

  if (resolved) {
    ctx.strokeStyle = 'rgba(6,214,160,0.5)';
    ctx.setLineDash([]);
  } else {
    ctx.strokeStyle = BORDER_ACTIVE;
    ctx.setLineDash([6, 4]);
  }
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead
  const t = 0.97;
  const ax = bezierPoint(x1, x1 + cp, x2 - cp, x2, t);
  const ay = bezierPoint(y1, y1, y2, y2, t);
  const bx = bezierPoint(x1, x1 + cp, x2 - cp, x2, t - 0.03);
  const by = bezierPoint(y1, y1, y2, y2, t - 0.03);
  const angle = Math.atan2(ay - by, ax - bx);
  const aLen = 8;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - aLen * Math.cos(angle - 0.4), y2 - aLen * Math.sin(angle - 0.4));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - aLen * Math.cos(angle + 0.4), y2 - aLen * Math.sin(angle + 0.4));
  ctx.strokeStyle = resolved ? 'rgba(6,214,160,0.5)' : BORDER_ACTIVE;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function truncateText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '...').width > maxW) {
    t = t.slice(0, -1);
  }
  return t + '...';
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function getNodeState(name, agentStates, taskStatus) {
  const agent = agentStates[name];
  const task = taskStatus[name];
  if (agent && agent.state && agent.state !== 'idle') return agent.state;
  if (task) {
    if (task.status === 'in_progress') return 'active';
    if (task.status === 'completed') return 'completed';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'retrying') return 'retrying';
    if (task.status === 'waiting') return 'waiting';
    if (task.status === 'timed_out') return 'timed_out';
    if (task.status === 'completed_with_errors') return 'completed';
  }
  return 'idle';
}

function isEdgeResolved(fromName, taskStatus) {
  const t = taskStatus[fromName];
  return t && (t.status === 'completed' || t.status === 'completed_with_errors');
}

function drawNode(ctx, n, state, tokens, isSelected, isHovered, task, hasIntervention, contextWarning) {
  const color = STATE_COLORS[state] || STATE_COLORS.idle;

  // Node background
  roundRect(ctx, n.x, n.y, n.w, n.h, 8);
  ctx.fillStyle = BG_SURFACE;
  ctx.fill();

  // Border
  ctx.strokeStyle = isSelected ? '#ffffff' : color;
  ctx.lineWidth = isSelected ? 2.5 : 1;
  ctx.stroke();

  // Selected glow
  if (isSelected) {
    ctx.save();
    ctx.shadowColor = STATE_COLORS.active;
    ctx.shadowBlur = 12;
    roundRect(ctx, n.x, n.y, n.w, n.h, 8);
    ctx.strokeStyle = STATE_COLORS.active;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // Failed/human glow
  if (state === 'failed' || state === 'human') {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    roundRect(ctx, n.x, n.y, n.w, n.h, 8);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Hover highlight
  if (isHovered && !isSelected) {
    roundRect(ctx, n.x, n.y, n.w, n.h, 8);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // State dot
  ctx.beginPath();
  ctx.arc(n.x + 14, n.y + 16, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Intervention badge
  if (hasIntervention) {
    ctx.beginPath();
    ctx.arc(n.x + 7, n.y + 7, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = BG_SURFACE;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = 'bold 9px ' + FONT_MONO;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', n.x + 7, n.y + 7);
  }

  // Timeout badge
  if (state === 'timed_out') {
    ctx.font = 'bold 9px ' + FONT_MONO;
    ctx.fillStyle = '#ff9800';
    ctx.textAlign = 'end';
    ctx.textBaseline = 'middle';
    ctx.fillText('T/O', n.x + n.w - 10, n.y + 16);
  }

  // Retry badge
  if (state === 'retrying') {
    ctx.font = 'bold 9px ' + FONT_MONO;
    ctx.fillStyle = STATE_COLORS.retrying;
    ctx.textAlign = 'end';
    ctx.textBaseline = 'middle';
    ctx.fillText('RETRY', n.x + n.w - 10, n.y + 16);
  }

  // Name
  ctx.font = '600 13px ' + FONT_MONO;
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const nameText = truncateText(ctx, n.name, n.w - 34);
  ctx.fillText(nameText, n.x + 24, n.y + 20);

  // Role
  const role = (task && task.role ? task.role : '').substring(0, 25);
  if (role) {
    ctx.font = '10px ' + FONT_UI;
    ctx.fillStyle = TEXT_SECONDARY;
    ctx.fillText(role, n.x + 10, n.y + 38);
  }

  // Progress bar background
  const barX = n.x + 10;
  const barY = n.y + 48;
  const barW = n.w - 20;
  const barH = 4;
  roundRect(ctx, barX, barY, barW, barH, 2);
  ctx.fillStyle = BG_VOID;
  ctx.fill();

  // Progress bar fill
  const pct = state === 'completed' ? 1
    : (state === 'active' || state === 'thinking' || state === 'tool_use') ? 0.5
    : (state === 'failed' || state === 'timed_out') ? 1
    : 0;
  if (pct > 0) {
    roundRect(ctx, barX, barY, barW * pct, barH, 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Token telemetry
  const totalTok = (tokens.input || 0) + (tokens.output || 0);
  ctx.font = '10px ' + FONT_MONO;
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = 'left';
  ctx.fillText(formatTokens(totalTok) + ' tok', n.x + 10, n.y + 72);

  // Context usage bar
  const ctxIn = tokens.input || 0;
  const ctxCache = tokens.cacheRead || 0;
  if (ctxIn > 0 || ctxCache > 0) {
    const ctxPct = Math.min(1, (ctxIn + ctxCache) / 200000);
    const ctxColor = ctxPct > 0.75 ? '#f44336' : ctxPct >= 0.5 ? '#ff9800' : '#4caf50';

    // Background
    roundRect(ctx, n.x + 10, n.y + n.h - 8, n.w - 20, 4, 2);
    ctx.fillStyle = '#333';
    ctx.fill();

    // Fill
    if (ctxPct > 0) {
      roundRect(ctx, n.x + 10, n.y + n.h - 8, (n.w - 20) * ctxPct, 4, 2);
      ctx.fillStyle = ctxColor;
      ctx.fill();
    }
  }
}

// -- Minimap --

const MINIMAP_W = 150;
const MINIMAP_H = 100;
const MINIMAP_PAD = 10;

function drawMinimap(ctx, canvasW, canvasH, nodes, camera, graphBounds) {
  if (!graphBounds || nodes.length === 0) return;

  const mx = canvasW - MINIMAP_W - MINIMAP_PAD;
  const my = canvasH - MINIMAP_H - MINIMAP_PAD;

  // Background
  ctx.fillStyle = 'rgba(10,10,18,0.85)';
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.fillRect(mx, my, MINIMAP_W, MINIMAP_H);
  ctx.strokeRect(mx, my, MINIMAP_W, MINIMAP_H);

  const gb = graphBounds;
  const gw = gb.maxX - gb.minX;
  const gh = gb.maxY - gb.minY;
  if (gw === 0 || gh === 0) return;

  const scaleX = (MINIMAP_W - 8) / gw;
  const scaleY = (MINIMAP_H - 8) / gh;
  const scale = Math.min(scaleX, scaleY);

  const offX = mx + 4 + ((MINIMAP_W - 8) - gw * scale) / 2;
  const offY = my + 4 + ((MINIMAP_H - 8) - gh * scale) / 2;

  // Draw nodes as dots
  for (const n of nodes) {
    const dx = offX + (n.x + n.w / 2 - gb.minX) * scale;
    const dy = offY + (n.y + n.h / 2 - gb.minY) * scale;
    ctx.beginPath();
    ctx.arc(dx, dy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = STATE_COLORS.active;
    ctx.fill();
  }

  // Viewport rectangle
  const vpLeft = (-camera.x / camera.zoom);
  const vpTop = (-camera.y / camera.zoom);
  const vpRight = vpLeft + canvasW / camera.zoom;
  const vpBottom = vpTop + canvasH / camera.zoom;

  const vrx = offX + (vpLeft - gb.minX) * scale;
  const vry = offY + (vpTop - gb.minY) * scale;
  const vrw = (vpRight - vpLeft) * scale;
  const vrh = (vpBottom - vpTop) * scale;

  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    Math.max(mx, vrx), Math.max(my, vry),
    Math.min(MINIMAP_W, vrw), Math.min(MINIMAP_H, vrh)
  );
}

function getGraphBounds(nodes) {
  if (nodes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    if (n.y + n.h > maxY) maxY = n.y + n.h;
  }
  return { minX, minY, maxX, maxY };
}

function isMinimapHit(canvasW, canvasH, sx, sy) {
  const mx = canvasW - MINIMAP_W - MINIMAP_PAD;
  const my = canvasH - MINIMAP_H - MINIMAP_PAD;
  return sx >= mx && sx <= mx + MINIMAP_W && sy >= my && sy <= my + MINIMAP_H;
}

function minimapClickToCamera(canvasW, canvasH, sx, sy, graphBounds, camera) {
  const mx = canvasW - MINIMAP_W - MINIMAP_PAD;
  const my = canvasH - MINIMAP_H - MINIMAP_PAD;
  const gb = graphBounds;
  const gw = gb.maxX - gb.minX;
  const gh = gb.maxY - gb.minY;
  if (gw === 0 || gh === 0) return camera;

  const scaleX = (MINIMAP_W - 8) / gw;
  const scaleY = (MINIMAP_H - 8) / gh;
  const scale = Math.min(scaleX, scaleY);
  const offX = mx + 4 + ((MINIMAP_W - 8) - gw * scale) / 2;
  const offY = my + 4 + ((MINIMAP_H - 8) - gh * scale) / 2;

  const worldX = gb.minX + (sx - offX) / scale;
  const worldY = gb.minY + (sy - offY) / scale;

  return {
    x: -(worldX - canvasW / (2 * camera.zoom)) * camera.zoom,
    y: -(worldY - canvasH / (2 * camera.zoom)) * camera.zoom,
    zoom: camera.zoom,
  };
}

// -- Preact component --

export function CanvasGraph({ taskPlan, taskStatus, agentStates, contextWarnings,
  logEntries, selectedAgent, onSelectAgent }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({
    camera: { x: 0, y: 0, zoom: 1 },
    hoveredNode: null,
    dragging: false,
    dragStart: { x: 0, y: 0 },
    cameraStart: { x: 0, y: 0 },
    nodes: [],
    edges: [],
    phases: [],
    grid: {},
    graphBounds: null,
    animFrame: null,
    showMinimap: false,
    needsRender: true,
    canvasW: 0,
    canvasH: 0,
  });

  // Build intervention set
  const interventionAgents = useRef(new Set());
  useEffect(() => {
    const s = new Set();
    if (logEntries) {
      for (const entry of logEntries) {
        if (entry.type === 'intervention' && entry.agent) s.add(entry.agent);
      }
    }
    interventionAgents.current = s;
  }, [logEntries]);

  // Recompute layout when plan or canvas size changes
  const updateLayout = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !taskPlan || !taskPlan.tasks || taskPlan.tasks.length === 0) return;

    const cs = stateRef.current;
    const { nodes, edges, phases } = computeLayout(taskPlan, cs.canvasW || canvas.width, cs.canvasH || canvas.height);
    cs.nodes = nodes;
    cs.edges = edges;
    cs.phases = phases;
    cs.grid = buildSpatialGrid(nodes);
    cs.graphBounds = getGraphBounds(nodes);

    // Check if minimap should show
    if (cs.graphBounds) {
      const gw = cs.graphBounds.maxX - cs.graphBounds.minX;
      const gh = cs.graphBounds.maxY - cs.graphBounds.minY;
      cs.showMinimap = cs.camera.zoom < 0.8 || gw > (cs.canvasW || 800) || gh > (cs.canvasH || 500);
    }
    cs.needsRender = true;
  }, [taskPlan]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const cs = stateRef.current;

    function render() {
      cs.animFrame = requestAnimationFrame(render);
      if (!cs.needsRender) return;
      cs.needsRender = false;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        cs.canvasW = w;
        cs.canvasH = h;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Apply camera transform
      ctx.save();
      ctx.translate(cs.camera.x, cs.camera.y);
      ctx.scale(cs.camera.zoom, cs.camera.zoom);

      // Draw phase labels
      ctx.font = '10px ' + FONT_MONO;
      ctx.fillStyle = TEXT_MUTED;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (let pi = 0; pi < cs.phases.length; pi++) {
        const firstNode = cs.nodes.find(n => n.phase === pi);
        if (firstNode) {
          ctx.fillText('PHASE ' + (pi + 1), firstNode.x + NODE_W / 2, 12);
        }
      }

      // Draw edges
      for (const e of cs.edges) {
        const resolved = isEdgeResolved(e.from, taskStatus);
        drawEdge(ctx, e, resolved);
      }

      // Draw nodes
      for (const n of cs.nodes) {
        const state = getNodeState(n.name, agentStates, taskStatus);
        const tokens = (agentStates[n.name] && agentStates[n.name].tokens) || {};
        const isSelected = selectedAgent === n.name;
        const isHovered = cs.hoveredNode === n.name;
        const task = n.task || {};
        const hasIntervention = interventionAgents.current.has(n.name);
        const ctxWarning = contextWarnings ? contextWarnings[n.name] : null;
        drawNode(ctx, n, state, tokens, isSelected, isHovered, task, hasIntervention, ctxWarning);
      }

      ctx.restore();

      // Draw minimap (in screen space)
      if (cs.showMinimap && cs.graphBounds) {
        drawMinimap(ctx, w, h, cs.nodes, cs.camera, cs.graphBounds);
      }
    }

    cs.animFrame = requestAnimationFrame(render);
    return () => {
      if (cs.animFrame) cancelAnimationFrame(cs.animFrame);
    };
  }, []);

  // Mark dirty when data changes
  useEffect(() => {
    stateRef.current.needsRender = true;
  }, [taskStatus, agentStates, contextWarnings, selectedAgent, logEntries]);

  // Recompute layout when plan changes
  useEffect(() => {
    updateLayout();
  }, [taskPlan, updateLayout]);

  // ResizeObserver
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      stateRef.current.canvasW = canvas.clientWidth;
      stateRef.current.canvasH = canvas.clientHeight;
      updateLayout();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [updateLayout]);

  // Mouse handlers
  const screenToWorld = useCallback((sx, sy) => {
    const cs = stateRef.current;
    return {
      x: (sx - cs.camera.x) / cs.camera.zoom,
      y: (sy - cs.camera.y) / cs.camera.zoom,
    };
  }, []);

  const onMouseDown = useCallback((e) => {
    const cs = stateRef.current;
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Minimap click
    if (cs.showMinimap && cs.graphBounds && isMinimapHit(cs.canvasW, cs.canvasH, sx, sy)) {
      cs.camera = minimapClickToCamera(cs.canvasW, cs.canvasH, sx, sy, cs.graphBounds, cs.camera);
      cs.needsRender = true;
      return;
    }

    cs.dragging = true;
    cs.dragStart = { x: e.clientX, y: e.clientY };
    cs.cameraStart = { x: cs.camera.x, y: cs.camera.y };
  }, []);

  const onMouseMove = useCallback((e) => {
    const cs = stateRef.current;
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (cs.dragging) {
      cs.camera.x = cs.cameraStart.x + (e.clientX - cs.dragStart.x);
      cs.camera.y = cs.cameraStart.y + (e.clientY - cs.dragStart.y);
      // Update minimap visibility
      if (cs.graphBounds) {
        const gw = cs.graphBounds.maxX - cs.graphBounds.minX;
        const gh = cs.graphBounds.maxY - cs.graphBounds.minY;
        cs.showMinimap = cs.camera.zoom < 0.8 || gw > cs.canvasW || gh > cs.canvasH;
      }
      cs.needsRender = true;
      return;
    }

    // Hit test for hover
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    const hit = hitTest(cs.grid, wx, wy);
    const newHover = hit ? hit.name : null;
    if (newHover !== cs.hoveredNode) {
      cs.hoveredNode = newHover;
      canvasRef.current.style.cursor = newHover ? 'pointer' : 'grab';
      cs.needsRender = true;
    }
  }, [screenToWorld]);

  const onMouseUp = useCallback((e) => {
    const cs = stateRef.current;
    if (!cs.dragging) return;

    const dx = Math.abs(e.clientX - cs.dragStart.x);
    const dy = Math.abs(e.clientY - cs.dragStart.y);
    cs.dragging = false;

    // If barely moved, treat as click
    if (dx < 4 && dy < 4) {
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const hit = hitTest(cs.grid, wx, wy);
      if (hit) {
        onSelectAgent(selectedAgent === hit.name ? null : hit.name);
      }
    }
  }, [screenToWorld, onSelectAgent, selectedAgent]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const cs = stateRef.current;
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.min(3, Math.max(0.15, cs.camera.zoom * zoomFactor));

    // Zoom toward cursor
    cs.camera.x = sx - (sx - cs.camera.x) * (newZoom / cs.camera.zoom);
    cs.camera.y = sy - (sy - cs.camera.y) * (newZoom / cs.camera.zoom);
    cs.camera.zoom = newZoom;

    // Update minimap visibility
    if (cs.graphBounds) {
      const gw = cs.graphBounds.maxX - cs.graphBounds.minX;
      const gh = cs.graphBounds.maxY - cs.graphBounds.minY;
      cs.showMinimap = cs.camera.zoom < 0.8 || gw > cs.canvasW || gh > cs.canvasH;
    }
    cs.needsRender = true;
  }, []);

  const onMouseLeave = useCallback(() => {
    const cs = stateRef.current;
    cs.dragging = false;
    if (cs.hoveredNode) {
      cs.hoveredNode = null;
      cs.needsRender = true;
    }
  }, []);

  return html`<canvas ref=${canvasRef}
    class="canvas-graph"
    style="width:100%;height:100%;cursor:grab;"
    onMouseDown=${onMouseDown}
    onMouseMove=${onMouseMove}
    onMouseUp=${onMouseUp}
    onWheel=${onWheel}
    onMouseLeave=${onMouseLeave}
  />`;
}
