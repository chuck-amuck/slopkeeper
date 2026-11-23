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

/** Said under a chart where there's a mouse to drag across it with: a finger scrolls the page instead */
export const dragNote = (what = 'the chart') => (matchMedia('(any-pointer: fine)').matches ? ` Drag across ${what} to look closer.` : '');

/**
 * Time labels on the axis, as fine as the span shown, but never hours on a chart whose points are a day or more apart
 * (`gap`), as a few days' records would otherwise show midnight after midnight
 */
function tickFormat(span, timeZone, gap) {
  const hours = span <= 2 * 86_400_000 && gap < 43_200_000;
  const options = hours ? { hour: 'numeric', minute: '2-digit' } : span <= 120 * 86_400_000 ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' };
  const format = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
  return (ms) => format.format(ms);
}

/**
 * `series`: [{ id, label, color (a CSS colour or token), values: [number | null] }], one value per point from
 * `start`, `step` ms apart, or at each of `times` for steps of different lengths, like months, with `until` where the
 * last one ends. `previous`: the same lines over the stretch before, by id, drawn faint and dashed to compare.
 * `format(value)` writes a value, and `tick(value)`, if given, a value on the scale, where a rounded one would repeat. `limit` ({ value, label }) draws a dashed line where it stops being fine.
 * `bands`: a share 0–1 per point to shade, like time away from Discord, named by `bandLabel`. `onPick(from, to)`
 * is called with the stretch someone drags across. `stacked`: columns stacked on each other, with the total first in
 * the tooltip, for parts of a whole like each game's share of the time. `whole`: counts, so the axis has no fractions
 */
export function timeChart({
  key,
  title,
  start,
  step,
  times = null,
  until = null,
  timeLabel,
  timeZone,
  series,
  format,
  tick = null,
  limit = null,
  bands = null,
  bandLabel = '',
  floor = 0,
  previous = null,
  onPick = null,
  stacked = false,
  whole = false,
  height = HEIGHT,
}) {
  sweep();
  const off = hidden.get(key) ?? hidden.set(key, new Set()).get(key);
  const points = series[0]?.values.length ?? 0;
  const at = (i) => (times ? times[i] : start + i * step);
  start = at(0);
  const end = at(Math.max(0, points - 1));
  /** Where the last point's stretch ends */
  const last = times ? (until ?? end) : end + step;
  const shown = () => series.filter((s) => !off.has(s.id));
  // How far apart the points are, the shortest step where they differ, as months do. A day's steps can be 23 or 25 hours
  // A single point with nothing to say how long it is counts as a day, which labels no hours
  const gap = times ? (points > 1 ? Math.min(...times.slice(1).map((t, i) => t - times[i])) : until !== null ? until - end : 86_400_000) : step;
  const days = gap >= 43_200_000;

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
    const rows = (stacked ? shown().toReversed() : shown()).map((s) =>
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
    // The total counts parts hidden in the legend too, so it agrees with the tiles and the table
    const total = stacked && el('div', { className: 'line-tip-row' }, el('strong', {}, format(series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))), el('span', {}, 'in all'));
    return el('div', { className: 'echart-tip' }, el('div', { className: 'line-tip-time' }, timeLabel(at(i))), total, ...rows, band);
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
        // Columns stand on their point, so the axis runs half a step either side
        min: stacked ? start - (last - start) / points / 2 : start,
        max: stacked ? last - (last - start) / points / 2 : end,
        axisLine: { lineStyle: { color: line } },
        axisTick: { show: false },
        splitLine: { show: false },
        // Days apart, the ticks are whole days, so no two say the same date
        minInterval: days ? 86_400_000 : undefined,
        axisLabel: { color: ink, hideOverlap: true, formatter: tickFormat(end - start, timeZone, gap) },
      },
      yAxis: {
        type: 'value',
        min: floor,
        // Room for where it stops being fine, so the dashed line is always on the chart
        max: limit ? ({ max }) => Math.max(max, limit.value) * 1.08 : undefined,
        splitNumber: 3,
        minInterval: whole ? 1 : undefined,
        // The top is only room for the dashed line where there's one, so it isn't labelled with an odd number
        axisLabel: { color: ink, showMaxLabel: !limit, formatter: (v) => (v === 0 ? '0' : (tick ?? format)(v)) },
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
        axisPointer: stacked ? { type: 'shadow', shadowStyle: { color: colour('var(--line)'), opacity: 0.5 } } : { type: 'line', lineStyle: { color: ink, width: 1 } },
        formatter: (params) => tipFor(params[0]?.dataIndex ?? 0),
      },
      series: [
        ...lines.map((s, n) =>
          stacked
            ? {
                id: s.id,
                type: 'bar',
                stack: 'all',
                data: s.values.map((v, i) => [at(i), v]),
                barMaxWidth: 28,
                barCategoryGap: '30%',
                // A sliver of the page between parts, so neighbouring colours don't run together
                itemStyle: { color: colour(s.color), borderColor: colour('var(--surface)'), borderWidth: 1 },
                emphasis: { disabled: true },
              }
            : {
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
              },
        ),
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
      if (!wide || e.type !== 'pointerup' || !Number.isFinite(a) || !Number.isFinite(b)) return;
      if (!stacked) return onPick(Math.max(start, Math.round(a)), Math.min(last, Math.round(b)));
      // Columns stand in the middle of their step, so a drag picks the whole steps of the columns it crossed
      const nearest = (t) => Array.from({ length: points }, (_, i) => i).reduce((best, i) => (Math.abs(at(i) - t) < Math.abs(at(best) - t) ? i : best), 0);
      const [first, final] = [nearest(a), nearest(b)];
      onPick(at(first), final + 1 < points ? at(final + 1) : last);
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

/** Weekday names from Monday, and hour names, in the reader's own language */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }));
const WEEKDAYS_LONG = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' }));
const HOURS = Array.from({ length: 24 }, (_, h) => new Date(Date.UTC(2026, 0, 5, h)).toLocaleTimeString(undefined, { hour: 'numeric', timeZone: 'UTC' }));

/**
 * A week as a grid of weekdays (Monday first, top to bottom) by hours, each shaded by its value in one colour: pale
 * for little, strong for a lot. `grid`: 7 rows of 24 values, null for an hour the period didn't include.
 * `describe(value, weekday, hour)` says what a cell means, for its tooltip and the table
 */
export function weekChart({ title, grid, describe, format, height = 220 }) {
  sweep();
  const values = grid.flat().filter((v) => v !== null);
  const most = Math.max(0, ...values);
  const plot = el('div', { className: 'echart', style: `height: ${height}px` });
  const box = el('div', { className: 'echart-box', tabIndex: 0, role: 'img', ariaLabel: `${title}. Use the arrow keys to read each hour` }, plot, !most && el('div', { className: 'chart-empty' }, 'Nobody on in this range'));
  let chart = null;
  let focus = null;

  function option() {
    const ink = colour('var(--muted)');
    return {
      animation: false,
      aria: { enabled: false },
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: ink },
      grid: { left: 4, right: 4, top: 4, bottom: 4, containLabel: true },
      xAxis: { type: 'category', data: HOURS, splitArea: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: ink, interval: (i) => i % (plot.clientWidth < 520 ? 6 : 3) === 0 } },
      yAxis: { type: 'category', data: WEEKDAYS, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: ink } },
      visualMap: { show: false, min: 0, max: most || 1, inRange: { color: [colour('var(--raised)'), colour('var(--series-1)')] } },
      tooltip: {
        confine: true,
        className: 'chart-tooltip',
        backgroundColor: colour('var(--text)'),
        borderWidth: 0,
        padding: [6, 10],
        textStyle: { color: colour('var(--bg)'), fontSize: 12 },
        extraCssText: 'box-shadow: none; border-radius: 6px;',
        transitionDuration: 0,
        formatter: ({ value: [hour, day, v] }) => el('div', { className: 'echart-tip' }, describe(v, day, hour)),
      },
      series: [
        {
          type: 'heatmap',
          data: grid.flatMap((row, day) => row.map((v, hour) => [hour, day, v ?? '-'])),
          // The page's own colour between cells, so each hour stands apart
          itemStyle: { borderColor: colour('var(--surface)'), borderWidth: 2, borderRadius: 3 },
          emphasis: { itemStyle: { borderColor: colour('var(--text)'), borderWidth: 1 } },
        },
      ],
    };
  }

  const entry = {
    node: box,
    chart: null,
    observer: null,
    shown: false,
    draw() {
      chart?.setOption(option(), { notMerge: true });
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

  // The arrow keys move across the hours and up and down the days
  box.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (e.key === 'Escape') {
      focus = null;
      return chart?.dispatchAction({ type: 'hideTip' });
    }
    if (!(e.key in moves)) return;
    e.preventDefault();
    const [day, hour] = focus ?? [0, -1];
    const [dd, dh] = moves[e.key];
    focus = [Math.max(0, Math.min(6, day + dd)), Math.max(0, Math.min(23, hour + dh))];
    chart?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: focus[0] * 24 + focus[1] });
  });
  box.addEventListener('blur', () => {
    focus = null;
    chart?.dispatchAction({ type: 'hideTip' });
  });

  // Pale to strong, with what each end means
  const scale = el(
    'div',
    { className: 'week-scale', ariaHidden: 'true' },
    el('span', {}, format(0)),
    el('span', { className: 'week-ramp' }),
    el('span', {}, format(most)),
  );

  // Hours down the side and days across, which fits a phone better than the chart's way round
  const table = el('details', {}, el('summary', {}, 'Show as a table'));
  table.addEventListener('toggle', () => {
    if (!table.open || table.querySelector('table')) return;
    table.append(
      el(
        'div',
        { className: 'table-scroll' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Hour'), WEEKDAYS.map((d) => el('th', {}, d)))),
          el('tbody', {}, HOURS.map((h, hour) => el('tr', {}, el('td', {}, h), grid.map((row) => el('td', {}, row[hour] === null ? '–' : format(row[hour])))))),
        ),
      ),
    );
  });
  return el('div', { className: 'chart week-chart' }, box, scale, table);
}

/**
 * Days on a calendar, weeks across and weekdays down (Monday first), each shaded by its value: pale for little,
 * strong for a lot. `days`: [{ day: 'YYYY-MM-DD', start, end, value }] in order. `describe(day)` says what one means,
 * for its tooltip and the table, and `onPick(day)` is called when one is clicked or chosen with Enter
 */
export function calendarChart({ title, days, describe, format, onPick }) {
  sweep();
  const most = Math.max(0, ...days.map((d) => d.value));
  const weeks = Math.ceil((days.length + ((new Date(`${days[0].day}T12:00:00Z`).getUTCDay() + 6) % 7)) / 7);
  const plot = el('div', { className: 'echart' });
  const box = el(
    'div',
    { className: 'echart-box', tabIndex: 0, role: 'img', ariaLabel: `${title}. Use the arrow keys to read each day${onPick ? ', and Enter to look at it' : ''}` },
    plot,
    !most && el('div', { className: 'chart-empty' }, 'Nobody on in this range'),
  );
  let chart = null;
  let focus = null;
  // Square cells as wide as the box allows, from small enough for a year on a phone to big enough to tap
  const cellFor = (width) => Math.max(3, Math.min(36, Math.floor((width - 44) / weeks)));
  const sizeTo = (width) => (plot.style.height = `${cellFor(width) * 7 + 26}px`);

  function option() {
    const ink = colour('var(--muted)');
    const cell = cellFor(plot.clientWidth);
    return {
      animation: false,
      aria: { enabled: false },
      textStyle: { fontFamily: getComputedStyle(document.body).fontFamily, color: ink },
      calendar: {
        range: [days[0].day, days.at(-1).day],
        orient: 'horizontal',
        cellSize: [cell, cell],
        left: 34,
        top: 20,
        splitLine: { show: false },
        itemStyle: { color: colour('var(--surface)'), borderColor: colour('var(--surface)'), borderWidth: cell > 10 ? 2 : 1 },
        // Its names go Sunday first, whichever day the weeks start on
        dayLabel: { firstDay: 1, color: ink, fontSize: 11, nameMap: [WEEKDAYS[6], ...WEEKDAYS.slice(0, 6)].map((d) => d.slice(0, 1)), margin: 6 },
        monthLabel: { color: ink, fontSize: 11, margin: 4, nameMap: Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2026, m, 15)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })) },
        yearLabel: { show: false },
      },
      visualMap: { show: false, min: 0, max: most || 1, inRange: { color: [colour('var(--raised)'), colour('var(--series-1)')] } },
      tooltip: {
        confine: true,
        className: 'chart-tooltip',
        backgroundColor: colour('var(--text)'),
        borderWidth: 0,
        padding: [6, 10],
        textStyle: { color: colour('var(--bg)'), fontSize: 12 },
        extraCssText: 'box-shadow: none; border-radius: 6px;',
        transitionDuration: 0,
        formatter: ({ dataIndex }) => el('div', { className: 'echart-tip' }, describe(days[dataIndex])),
      },
      series: [
        {
          type: 'heatmap',
          coordinateSystem: 'calendar',
          data: days.map((d) => [d.day, d.value]),
          itemStyle: { borderColor: colour('var(--surface)'), borderWidth: cell > 10 ? 2 : 1, borderRadius: cell > 10 ? 3 : 1 },
          emphasis: { itemStyle: { borderColor: colour('var(--text)'), borderWidth: 1 } },
          cursor: onPick ? 'pointer' : 'default',
        },
      ],
    };
  }

  const entry = {
    node: box,
    chart: null,
    observer: null,
    shown: false,
    draw() {
      chart?.setOption(option(), { notMerge: true });
    },
  };
  entry.observer = new ResizeObserver(() => {
    if (!box.isConnected || !plot.clientWidth) return;
    entry.shown = true;
    const was = plot.style.height;
    sizeTo(plot.clientWidth);
    if (chart) {
      chart.resize();
      // The cells grow with the box, which needs the whole layout again
      if (plot.style.height !== was) entry.draw();
      else chart.setOption(option());
      return;
    }
    void load().then(({ init }) => {
      if (chart || !box.isConnected) return;
      chart = entry.chart = init(plot, null, { renderer: 'svg' });
      if (onPick) chart.on('click', ({ dataIndex }) => days[dataIndex] && onPick(days[dataIndex]));
      entry.draw();
    });
  });
  entry.observer.observe(box);
  live.add(entry);

  // Left and right a day, up and down a week
  box.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key === 'Escape') {
      focus = null;
      return chart?.dispatchAction({ type: 'hideTip' });
    }
    if (e.key === 'Enter' && focus !== null && onPick) return onPick(days[focus]);
    if (!(e.key in moves)) return;
    e.preventDefault();
    focus = Math.max(0, Math.min(days.length - 1, (focus ?? days.length) + moves[e.key]));
    chart?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: focus });
  });
  box.addEventListener('blur', () => {
    focus = null;
    chart?.dispatchAction({ type: 'hideTip' });
  });

  const scale = el('div', { className: 'week-scale', ariaHidden: 'true' }, el('span', {}, format(0)), el('span', { className: 'week-ramp' }), el('span', {}, format(most)));
  const table = el('details', {}, el('summary', {}, 'Show as a table'));
  table.addEventListener('toggle', () => {
    if (!table.open || table.querySelector('table')) return;
    table.append(el('div', { className: 'table-scroll' }, el('table', {}, el('tbody', {}, days.map((d) => el('tr', {}, el('td', {}, describe(d))))))));
  });
  return el('div', { className: 'chart calendar-chart' }, box, scale, table);
}

export { WEEKDAYS_LONG, HOURS };
