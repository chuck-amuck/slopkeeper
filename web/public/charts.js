import { el } from './lib.js';

/**
 * Charts over time, drawn by Apache ECharts (vendor-echarts.js, loaded the first time a chart is shown). Pointing at
 * one, or using the arrow keys once it has focus, shows every line's value at that time; dragging across one with a
 * mouse picks that stretch to look at closer. A gap in the numbers is a gap in the line. Colours come from the page's
 * own tokens, so a chart follows the light or dark theme, and each chart can be read as a table instead
 */

const HEIGHT = 160;
/** A drag shorter than this is a click, not a stretch picked */
const LEAST_DRAG_PX = 8;

let library = null;
const load = () => (library ??= import('./vendor-echarts.js'));

/** Every chart drawn, so a change of theme redraws them and those taken off the page are let go */
const live = new Set();

/** Lets go of charts that were on the page and aren't any more. One still being built isn't on it yet */
function sweep() {
  for (const entry of live) {
    if (!entry.shown || entry.node.isConnected) continue;
    entry.chart?.dispose();
    entry.observer.disconnect();
    live.delete(entry);
  }
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  sweep();
  for (const entry of live) entry.draw();
});

/** A colour as the page has it now: a token like var(--series-1) read off the page, as ECharts can't read CSS */
function colour(value) {
  const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return token ? getComputedStyle(document.documentElement).getPropertyValue(token).trim() : value;
}

/** Lines hidden by their legend button, by chart and line, so they stay hidden as the numbers come again */
const hidden = new Map();

/** Time labels on the axis, as fine as the span shown */
function tickFormat(span, timeZone) {
  const options = span <= 2 * 86_400_000 ? { hour: 'numeric', minute: '2-digit' } : span <= 120 * 86_400_000 ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' };
  const format = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
  return (ms) => format.format(ms);
}

/**
 * `series`: [{ id, label, color (a CSS colour or token), values: [number | null] }], one value per point from
 * `start`, `step` ms apart. `previous`: the same lines over the stretch before, by id, drawn faint and dashed to
 * compare. `format(value)` writes a value. `limit` ({ value, label }) draws a dashed line where it stops being fine.
 * `bands`: a share 0–1 per point to shade, like time away from Discord, named by `bandLabel`. `onPick(from, to)`
 * is called with the stretch someone drags across
 */
export function timeChart({ key, title, start, step, timeLabel, timeZone, series, format, limit = null, bands = null, bandLabel = '', floor = 0, previous = null, onPick = null, height = HEIGHT }) {
  sweep();
  const off = hidden.get(key) ?? hidden.set(key, new Set()).get(key);
  const points = series[0]?.values.length ?? 0;
  const end = start + Math.max(0, points - 1) * step;
  const at = (i) => start + i * step;
  const shown = () => series.filter((s) => !off.has(s.id));

  const plot = el('div', { className: 'echart', style: `height: ${height}px` });
  const pick = el('div', { className: 'chart-pick', hidden: true });
  const empty = series.every((s) => s.values.every((v) => v === null || v === undefined));
  const box = el(
    'div',
    { className: 'echart-box', tabIndex: 0, role: 'img', ariaLabel: `${title}. ${empty ? 'Nothing in this range' : `Use the arrow keys to read each time${onPick ? ', or drag across it to look closer' : ''}`}` },
    plot,
    pick,
    empty && el('div', { className: 'chart-empty' }, 'Nothing in this range'),
  );
  let chart = null;
  let focusAt = null;

  /** What the tooltip shows for point `i`: built as elements, as the page's security policy doesn't allow inline styles */
  function tipFor(i) {
    const rows = shown().map((s) =>
      el(
        'div',
        { className: 'line-tip-row' },
        el('span', { className: 'line-key', style: `background: ${colour(s.color)}` }),
        el('strong', {}, s.values[i] === null || s.values[i] === undefined ? '–' : format(s.values[i])),
        series.length > 1 && el('span', {}, s.label),
        previous?.[s.id] && el('span', { className: 'line-tip-before' }, `before ${previous[s.id][i] === null || previous[s.id][i] === undefined ? '–' : format(previous[s.id][i])}`),
      ),
    );
    const band = bands?.[i] ? el('div', { className: 'line-tip-row' }, el('span', { className: 'line-key band' }), el('span', {}, `${bandLabel} ${Math.round(bands[i] * 100)}% of the time`)) : null;
    return el('div', { className: 'echart-tip' }, el('div', { className: 'line-tip-time' }, timeLabel(at(i))), ...rows, band);
  }

  function option() {
    const ink = colour('var(--muted)');
    const line = colour('var(--line)');
    const lines = shown();
    const data = (values) =>
      values.map((v, i) => {
        // A point with nothing either side would be no line at all, so it gets a dot
        const alone = v !== null && (i === 0 || values[i - 1] === null) && (i === values.length - 1 || values[i + 1] === null);
        return { value: [at(i), v], symbol: alone ? 'circle' : 'none' };
      });
    const marks = [];
    if (bands)
      bands.forEach((share, i) => {
        if (share) marks.push([{ xAxis: at(i) - step / 2, itemStyle: { color: colour('var(--bad)'), opacity: Math.min(0.5, 0.12 + share * 0.4) } }, { xAxis: at(i) + step / 2 }]);
      });
    return {
      animation: false,
      aria: { enabled: false },
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: ink },
      grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
      xAxis: {
        type: 'time',
        min: start,
        max: end,
        axisLine: { lineStyle: { color: line } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: ink, hideOverlap: true, formatter: tickFormat(end - start, timeZone) },
      },
      yAxis: {
        type: 'value',
        min: floor,
        // Room for where it stops being fine, so the dashed line is always on the chart
        max: limit ? ({ max }) => Math.max(max, limit.value) * 1.08 : undefined,
        splitNumber: 3,
        // The top is only room for the dashed line where there's one, so it isn't labelled with an odd number
        axisLabel: { color: ink, showMaxLabel: !limit, formatter: (v) => (v === 0 ? '0' : format(v)) },
        splitLine: { lineStyle: { color: line, type: 'dashed' } },
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        className: 'chart-tooltip',
        // ECharts sets these on the element itself, over any stylesheet
        backgroundColor: colour('var(--text)'),
        borderWidth: 0,
        padding: [6, 10],
        textStyle: { color: colour('var(--bg)'), fontSize: 12 },
        extraCssText: 'box-shadow: none; border-radius: 6px;',
        transitionDuration: 0,
        axisPointer: { type: 'line', lineStyle: { color: ink, width: 1 } },
        formatter: (params) => tipFor(params[0]?.dataIndex ?? 0),
      },
      series: [
        ...lines.map((s, n) => ({
          id: s.id,
          type: 'line',
          data: data(s.values),
          showSymbol: true,
          symbolSize: 5,
          connectNulls: false,
          lineStyle: { width: 2, color: colour(s.color) },
          itemStyle: { color: colour(s.color) },
          emphasis: { disabled: true },
          ...(n === 0 && {
            markLine: limit && {
              silent: true,
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: ink, type: [4, 4], width: 1 },
              data: [{ yAxis: limit.value }],
            },
            markArea: marks.length ? { silent: true, data: marks } : undefined,
          }),
        })),
        ...(previous
          ? lines
              .filter((s) => previous[s.id])
              .map((s) => ({
                id: `${s.id}-before`,
                type: 'line',
                data: data(previous[s.id]),
                showSymbol: false,
                connectNulls: false,
                lineStyle: { width: 1.5, type: [3, 3], color: colour(s.color), opacity: 0.55 },
                itemStyle: { color: colour(s.color) },
                emphasis: { disabled: true },
                tooltip: { show: false },
              }))
          : []),
      ],
    };
  }

  const entry = {
    node: box,
    chart: null,
    observer: null,
    shown: false,
    draw() {
      if (!chart) return;
      chart.setOption(option(), { notMerge: true });
    },
  };
  entry.observer = new ResizeObserver(() => {
    if (!box.isConnected || !plot.clientWidth) return;
    entry.shown = true;
    if (chart) return chart.resize();
    void load().then(({ init }) => {
      if (chart || !box.isConnected) return;
      chart = entry.chart = init(plot, null, { renderer: 'svg' });
      entry.draw();
    });
  });
  entry.observer.observe(plot);
  live.add(entry);

  // The arrow keys move along the points, as pointing would
  box.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 };
    let i;
    if (e.key in moves) i = (focusAt ?? points - 1) + moves[e.key];
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = points - 1;
    else if (e.key === 'Escape') {
      focusAt = null;
      chart?.dispatchAction({ type: 'hideTip' });
      return;
    } else return;
    e.preventDefault();
    focusAt = Math.max(0, Math.min(points - 1, i));
    chart?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: focusAt });
  });
  box.addEventListener('blur', () => {
    focusAt = null;
    chart?.dispatchAction({ type: 'hideTip' });
  });

  // Dragging across with a mouse or pen picks a stretch; a finger scrolls the page as ever, and has the range buttons
  if (onPick) {
    let from = null;
    const xIn = (e) => e.clientX - plot.getBoundingClientRect().left;
    box.addEventListener('pointerdown', (e) => {
      if (!chart || e.pointerType === 'touch' || e.button !== 0) return;
      const x = xIn(e);
      if (!chart.containPixel('grid', [x, e.clientY - plot.getBoundingClientRect().top])) return;
      from = x;
      box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', (e) => {
      if (from === null) return;
      const x = Math.max(0, Math.min(plot.clientWidth, xIn(e)));
      pick.hidden = Math.abs(x - from) < LEAST_DRAG_PX;
      pick.style.left = `${Math.min(from, x)}px`;
      pick.style.width = `${Math.abs(x - from)}px`;
      if (!pick.hidden) chart.dispatchAction({ type: 'hideTip' });
    });
    const finish = (e) => {
      if (from === null) return;
      const x = Math.max(0, Math.min(plot.clientWidth, xIn(e)));
      const wide = Math.abs(x - from) >= LEAST_DRAG_PX;
      const [a, b] = [from, x].sort((p, q) => p - q).map((px) => chart.convertFromPixel({ xAxisIndex: 0 }, px));
      from = null;
      pick.hidden = true;
      if (wide && e.type === 'pointerup' && Number.isFinite(a) && Number.isFinite(b)) onPick(Math.max(start, Math.round(a)), Math.min(end + step, Math.round(b)));
    };
    box.addEventListener('pointerup', finish);
    box.addEventListener('pointercancel', finish);
  }

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
              entry.draw();
            },
          },
          el('span', { className: 'line-key', style: `background: ${colour(s.color)}` }),
          s.label,
        ),
      ),
    );

  // Built when it's opened, as a month of points is a lot of rows nobody may look at
  const table = el('details', {}, el('summary', {}, 'Show as a table'));
  table.addEventListener('toggle', () => {
    if (!table.open || table.querySelector('table, p')) return;
    const rows = [];
    for (let i = points - 1; i >= 0; i--) {
      if (series.every((s) => s.values[i] === null)) continue;
      rows.push(el('tr', {}, el('td', {}, timeLabel(at(i))), series.map((s) => el('td', {}, s.values[i] === null ? '–' : format(s.values[i])))));
    }
    table.append(
      rows.length
        ? el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Time'), series.map((s) => el('th', {}, s.label)))), el('tbody', {}, rows))
        : el('p', {}, 'Nothing measured yet.'),
    );
  });

  const notes = [limit && `Dashed: ${limit.label}`, previous && 'Faint: the stretch before'].filter(Boolean).join(' · ');
  return el('div', { className: 'chart line-chart' }, legend, box, notes && el('div', { className: 'axis-x' }, el('span', {}, notes)), table);
}
