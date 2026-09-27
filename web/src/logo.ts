/**
 * The Archipel logo: three islands linked by the graph of the board's memory.
 * The islands are the boards (1 board = 1 island), the links are what Archipel
 * draws between the things a board talks about.
 *
 * `mode`:
 *   - `static`: still;
 *   - `hover`: the islands bob while the logo (or a `.ap-hover` parent) is hovered;
 *   - `loop`: they bob continuously — the loading indicator of the whole UI.
 * Motion is off under `prefers-reduced-motion` (style.css). Same drawing as files:
 * `web/public/favicon.svg` (still) and `web/public/logo-animated.svg` (animated).
 */
export type LogoMode = 'static' | 'hover' | 'loop';

const SVG = 'http://www.w3.org/2000/svg';

/** Islands: centre and radius (viewBox 64). */
export const ISLES = [
  { cx: 19, cy: 25, r: 7 },
  { cx: 44, cy: 21, r: 5.5 },
  { cx: 35, cy: 43, r: 8.5 },
] as const;

const LINKS = [
  [0, 1],
  [1, 2],
  [2, 0],
] as const;

function node(doc: Document, tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = doc.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

let ids = 0;

export function logo(
  doc: Document,
  { size = 32, mode = 'static', title }: { size?: number; mode?: LogoMode; title?: string } = {},
): SVGElement {
  const id = `ap-logo-${++ids}`;
  const svg = node(doc, 'svg', {
    viewBox: '0 0 64 64',
    width: size,
    height: size,
    class: `ap-logo ap-logo--${mode}`,
  });
  if (title) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title);
  } else svg.setAttribute('aria-hidden', 'true');
  const grad = node(doc, 'linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 });
  grad.append(
    node(doc, 'stop', { offset: 0, 'stop-color': '#2f6fed' }),
    node(doc, 'stop', { offset: 1, 'stop-color': '#0e9384' }),
  );
  const defs = node(doc, 'defs', {});
  defs.append(grad);
  const links = node(doc, 'g', {
    stroke: '#fff',
    'stroke-opacity': 0.55,
    'stroke-width': 2,
    'stroke-linecap': 'round',
  });
  for (const [a, b] of LINKS)
    links.append(
      node(doc, 'line', { x1: ISLES[a].cx, y1: ISLES[a].cy, x2: ISLES[b].cx, y2: ISLES[b].cy }),
    );
  const isles = ISLES.map((s, i) => {
    const g = node(doc, 'g', { class: `ap-isle ap-isle-${i}` });
    g.append(
      node(doc, 'circle', { cx: s.cx, cy: s.cy, r: s.r, fill: '#fff' }),
      node(doc, 'path', {
        d: `M${s.cx - s.r + 1.5} ${s.cy + s.r * 0.35} q${s.r - 1.5} ${s.r * 0.35} ${2 * s.r - 3} 0`,
        fill: 'none',
        stroke: '#0e9384',
        'stroke-opacity': 0.5,
        'stroke-width': 1.6,
      }),
    );
    return g;
  });
  svg.append(
    defs,
    node(doc, 'rect', { width: 64, height: 64, rx: 16, fill: `url(#${id})` }),
    links,
    ...isles,
  );
  return svg;
}
