/**
 * Generate an SVG path string for a dependency edge.
 * Uses a cubic bezier curve from source right edge to target left edge.
 */
export function edgePath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1);
  const cpOffset = Math.max(40, dx * 0.4);
  return `M ${x1} ${y1} C ${x1 + cpOffset} ${y1}, ${x2 - cpOffset} ${y2}, ${x2} ${y2}`;
}
