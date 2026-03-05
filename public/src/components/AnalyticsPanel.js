import { h } from '../lib/preact.module.js';
import { useState, useEffect, useRef } from '../lib/preact-hooks.module.js';
import { html } from '../lib/html.js';
import { useStore, setState } from '../state/store.js';
import { getAnalytics } from '../state/api.js';

function formatDuration(ms) {
  if (ms == null || ms === 0) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

function drawBarChart(canvas, data, labelKey, valueKey, color) {
  if (!canvas || !data || data.length === 0) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const maxVal = Math.max(...data.map(d => d[valueKey]), 0.01);
  const barWidth = Math.max(8, Math.floor((w - 40) / data.length) - 4);
  const chartH = h - 30;

  ctx.font = '10px monospace';
  ctx.textAlign = 'center';

  for (let i = 0; i < data.length; i++) {
    const val = data[i][valueKey];
    const barH = (val / maxVal) * (chartH - 10);
    const x = 30 + i * (barWidth + 4);
    const y = chartH - barH;

    ctx.fillStyle = color;
    ctx.fillRect(x, y, barWidth, barH);

    // Value label
    ctx.fillStyle = '#aaa';
    if (val > 0) {
      const label = valueKey === 'cost' ? '$' + val.toFixed(2) : String(val);
      ctx.fillText(label, x + barWidth / 2, y - 4);
    }

    // Date label
    ctx.fillStyle = '#666';
    const dateLabel = String(data[i][labelKey] || '').slice(5); // MM-DD
    ctx.fillText(dateLabel, x + barWidth / 2, h - 4);
  }
}

export function AnalyticsPanel() {
  const showAnalytics = useStore(s => s.showAnalytics);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const costChartRef = useRef(null);
  const runsChartRef = useRef(null);

  useEffect(() => {
    if (!showAnalytics) return;
    setLoading(true);
    setError(null);
    getAnalytics()
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [showAnalytics]);

  // Draw charts when data loads
  useEffect(() => {
    if (!data || !data.costPerRun) return;
    const reversed = [...data.costPerRun].reverse().slice(-14);
    requestAnimationFrame(() => {
      drawBarChart(costChartRef.current, reversed, 'date', 'cost', '#4fc3f7');
      drawBarChart(runsChartRef.current, reversed, 'date', 'runs', '#81c784');
    });
  }, [data]);

  if (!showAnalytics) return null;

  function close() {
    setState({ showAnalytics: false });
  }

  const overlayStyle = {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    background: '#1a1a2e', zIndex: 100,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
  };

  const headerStyle = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', borderBottom: '1px solid #333', flexShrink: 0,
  };

  const contentStyle = {
    flex: 1, overflowY: 'auto', display: 'flex', justifyContent: 'center', padding: '16px',
  };

  const innerStyle = { width: '100%', maxWidth: '900px' };

  const closeBtnStyle = {
    background: 'none', border: '1px solid #555', color: '#ccc',
    padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
  };

  const cardStyle = {
    background: 'rgba(255,255,255,0.04)', borderRadius: '6px', padding: '12px 16px',
  };

  const labelStyle = {
    fontSize: '11px', color: '#888', marginBottom: '4px',
    textTransform: 'uppercase', letterSpacing: '0.5px',
  };

  const valueStyle = { fontSize: '20px', color: '#e0e0e0', fontWeight: 600 };

  return html`
    <div style=${overlayStyle}>
      <div style=${headerStyle}>
        <span style=${{ color: '#e0e0e0', fontSize: '15px', fontWeight: 600 }}>Analytics</span>
        <button style=${closeBtnStyle} onClick=${close}>Close</button>
      </div>

      <div style=${contentStyle}>
        <div style=${innerStyle}>
          ${error && html`<div style=${{ color: '#ef9a9a', marginBottom: '12px' }}>${error}</div>`}
          ${loading && html`<div style=${{ color: '#888', marginBottom: '12px' }}>Loading...</div>`}

          ${data && html`
            <!-- Summary cards -->
            <div style=${{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: '12px', marginBottom: '24px',
            }}>
              <div style=${cardStyle}>
                <div style=${labelStyle}>Total Runs</div>
                <div style=${valueStyle}>${data.totalRuns}</div>
              </div>
              <div style=${cardStyle}>
                <div style=${labelStyle}>Success Rate</div>
                <div style=${valueStyle}>${(data.successRate * 100).toFixed(1)}%</div>
              </div>
              <div style=${cardStyle}>
                <div style=${labelStyle}>Avg Duration</div>
                <div style=${valueStyle}>${formatDuration(data.avgDuration)}</div>
              </div>
              <div style=${cardStyle}>
                <div style=${labelStyle}>Total Cost</div>
                <div style=${valueStyle}>$${(data.totalCost || 0).toFixed(2)}</div>
              </div>
              <div style=${cardStyle}>
                <div style=${labelStyle}>Avg Tasks/Run</div>
                <div style=${valueStyle}>${(data.avgTasksPerRun || 0).toFixed(1)}</div>
              </div>
              <div style=${cardStyle}>
                <div style=${labelStyle}>Retry Rate</div>
                <div style=${valueStyle}>${((data.retryRate || 0) * 100).toFixed(1)}%</div>
              </div>
            </div>

            <!-- Model usage -->
            ${data.modelUsage && Object.keys(data.modelUsage).length > 0 && html`
              <div style=${{ marginBottom: '24px' }}>
                <div style=${{ fontSize: '13px', fontWeight: 600, color: '#e0e0e0', marginBottom: '8px' }}>
                  Model Usage
                </div>
                <div style=${{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                  ${Object.entries(data.modelUsage).map(([model, count]) => html`
                    <div style=${{
                      background: 'rgba(255,255,255,0.06)', borderRadius: '4px',
                      padding: '6px 14px', fontSize: '13px',
                    }}>
                      <span style=${{ color: '#aaa' }}>${model}:</span>
                      <span style=${{ color: '#e0e0e0', fontWeight: 600, marginLeft: '6px' }}>${count}</span>
                    </div>
                  `)}
                </div>
              </div>
            `}

            <!-- Cost trend chart -->
            ${data.costPerRun && data.costPerRun.length > 0 && html`
              <div style=${{ marginBottom: '24px' }}>
                <div style=${{ fontSize: '13px', fontWeight: 600, color: '#e0e0e0', marginBottom: '8px' }}>
                  Cost per Day (last 14 days)
                </div>
                <canvas ref=${costChartRef}
                  style=${{ width: '100%', height: '160px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px' }}
                />
              </div>
            `}

            <!-- Runs per day chart -->
            ${data.costPerRun && data.costPerRun.length > 0 && html`
              <div style=${{ marginBottom: '24px' }}>
                <div style=${{ fontSize: '13px', fontWeight: 600, color: '#e0e0e0', marginBottom: '8px' }}>
                  Runs per Day (last 14 days)
                </div>
                <canvas ref=${runsChartRef}
                  style=${{ width: '100%', height: '160px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px' }}
                />
              </div>
            `}
          `}
        </div>
      </div>
    </div>
  `;
}
