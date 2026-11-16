import { el } from './lib.js';

/**
 * A line chart over time, drawn to the pixel as its box resizes. Pointing at it, or using the arrow keys once it has
 * focus, shows every line's value at that time. A gap in the numbers is a gap in the line, never a drop to nothing.
 * Each chart can be read as a table instead
 */

const SVG = 'http://www.w3.org/2000/svg';
const HEIGHT = 140;
/** Room at the top for the highest value's label not to touch the line */
const HEADROOM = 1.08;

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** Lines hidden by their legend chip, by chart and line, so they stay hidden as the numbers come again */
const hidden = new Map();

/**
 * `series`: [{ id, label, color (a CSS colour), values: [number | null] }], one value per point from `start`, `step`
 * ms apart. `format(value)` writes a value. `limit` ({ value, label }) draws a dashed line where it stops being fine.
 * `bands`: a share 0–1 per point to shade, like time away from Discord, with `bandLabel` naming it
 */
export function lineChart({ key, title, start, step, timeLabel, series, format, limit = null, bands = null, bandLabel = '', floor = 0 }) {
  const off = hidden.get(key) ?? hidden.set(key, new Set()).get(key);
  const points = series[0]?.values.length ?? 0;
  const shown = () => series.filter((s) => !off.has(s.id));
  const plot = el('div', { className: 'line-plot', tabIndex: 0, role: 'img', ariaLabel: `${title}. Use the arrow keys to read each time` });
  const cross = el('div', { className: 'line-cross', hidden: true });
  const tip = el('div', { className: 'tip line-tip', hidden: true });
  const topLabel = el('div', { className: 'axis-top' });
  const box = el('div', { className: 'plot' }, topLabel, plot, cross, tip);
  let at = null;
  let width = 0;
  let top = 1;

  const x = (i) => (points <= 1 ? width / 2 : (i / (points - 1)) * width);
  const y = (v) => HEIGHT - ((v - floor) / (top - floor)) * HEIGHT;

  function draw() {
    width = plot.clientWidth;
    if (!width) return;
    const lines = shown();
    const highest = Math.max(floor, ...lines.flatMap((s) => s.values.filter((v) => v !== null)), limit?.value ?? floor);
    top = highest > floor ? highest * HEADROOM : floor + 1;
    topLabel.textContent = highest > floor ? format(highest) : '';
    const chart = svg('svg', { width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, 'aria-hidden': 'true' });
    chart.append(svg('line', { class: 'line-grid', x1: 0, x2: width, y1: HEIGHT / 2, y2: HEIGHT / 2 }));
    if (bands) {
      const slot = width / Math.max(1, points - 1);
      bands.forEach((share, i) => {
        if (!share) return;
        chart.append(svg('rect', { class: 'line-band', x: Math.max(0, x(i) - slot / 2), width: slot, y: 0, height: HEIGHT, opacity: Math.min(1, 0.25 + share) }));
      });
    }
    if (limit) {
      const ly = y(limit.value);
      chart.append(svg('line', { class: 'line-limit', x1: 0, x2: width, y1: ly, y2: ly }));
    }
    for (const s of lines) {
      let d = '';
      s.values.forEach((v, i) => {
        if (v === null) return;
        const joined = i > 0 && s.values[i - 1] !== null;
        d += `${joined ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        // A point with nothing either side would be no line at all
        const alone = !joined && (i === points - 1 || s.values[i + 1] === null);
        if (alone) chart.append(svg('circle', { cx: x(i), cy: y(v), r: 2.5, fill: s.color }));
      });
      if (d) chart.append(svg('path', { d, class: 'line-path', stroke: s.color }));
    }
    plot.replaceChildren(chart);
    if (at !== null) point(at);
  }

  /** Shows the line under point `i` and what each line was there */
  function point(i) {
    at = Math.max(0, Math.min(points - 1, i));
    cross.hidden = false;
    cross.style.left = `${x(at)}px`;
    const rows = shown().map((s) =>
      el(
        'div',
        { className: 'line-tip-row' },
        el('span', { className: 'line-key', style: `background: ${s.color}` }),
        el('strong', {}, s.values[at] === null ? '–' : format(s.values[at])),
        series.length > 1 && el('span', {}, s.label),
      ),
    );
    const band = bands?.[at] ? el('div', { className: 'line-tip-row' }, el('span', { className: 'line-key band' }), el('span', {}, `${bandLabel} ${Math.round(bands[at] * 100)}% of the time`)) : null;
    tip.replaceChildren(el('div', { className: 'line-tip-time' }, timeLabel(start + at * step)), ...rows, ...(band ? [band] : []));
    tip.hidden = false;
    const left = x(at) - tip.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(0, left), width - tip.offsetWidth)}px`;
  }

  function away() {
    at = null;
    cross.hidden = tip.hidden = true;
  }

  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    point(Math.round(((e.clientX - r.left) / r.width) * (points - 1)));
  });
  plot.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && away());
  plot.addEventListener('blur', away);
  plot.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 };
    if (e.key in moves) point((at ?? points - 1) + moves[e.key]);
    else if (e.key === 'Home') point(0);
    else if (e.key === 'End') point(points - 1);
    else if (e.key === 'Escape') away();
    else return;
    e.preventDefault();
  });
  new ResizeObserver(() => plot.clientWidth !== width && draw()).observe(plot);

  const legend =
    series.length > 1 &&
    el(
      'div',
      { className: 'line-legend' },
      series.map((s) =>
        el(
          'button',
          {
            type: 'button',
            ariaPressed: String(!off.has(s.id)),
            title: `Show or hide ${s.label}`,
            onclick: (e) => {
              if (off.has(s.id)) off.delete(s.id);
              // One line always stays
              else if (shown().length > 1) off.add(s.id);
              e.currentTarget.ariaPressed = String(!off.has(s.id));
              draw();
            },
          },
          el('span', { className: 'line-key', style: `background: ${s.color}` }),
          s.label,
        ),
      ),
    );

  // Built when it's opened, as a month of points is a lot of rows nobody may look at
  const table = el('details', {}, el('summary', {}, 'Show as a table'));
  table.addEventListener('toggle', () => {
    if (!table.open || table.querySelector('table')) return;
    const rows = [];
    for (let i = points - 1; i >= 0; i--) {
      if (series.every((s) => s.values[i] === null)) continue;
      rows.push(el('tr', {}, el('td', {}, timeLabel(start + i * step)), series.map((s) => el('td', {}, s.values[i] === null ? '–' : format(s.values[i])))));
    }
    table.append(
      rows.length
        ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'), series.map((s) => el('th', {}, s.label)))), el('tbody', {}, rows))
        : el('p', {}, 'Nothing measured yet.'),
    );
  });

  return el(
    'div',
    { className: 'chart line-chart' },
    legend,
    box,
    el('div', { className: 'axis-x' }, el('span', {}, timeLabel(start)), el('span', {}, limit ? `Dashed: ${limit.label}` : ''), el('span', {}, timeLabel(start + (points - 1) * step))),
    table,
  );
}
