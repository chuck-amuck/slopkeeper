import { el, icon, openDialog } from './lib.js';

/**
 * The time range a Stats view covers, with presets, a calendar for any dates, a toggle to compare with the stretch
 * before, and Back after zooming into a chart. A range is one of:
 *   { preset: id }                         a preset up to now
 *   { fromDate, toDate }                   whole days picked on the calendar (YYYY-MM-DD, both included)
 *   { from, to }                           milliseconds, from dragging across a chart
 * It's kept in the page's address after the view's name, so a link or a reload opens the same range
 */

const DAY_MS = 86_400_000;

/** The range in an address's query, or null if it doesn't name one this view offers */
export function rangeFromQuery(params, presets) {
  const preset = params.get('range');
  if (preset && presets.some(([id]) => id === preset)) return { preset };
  const [fromDate, toDate] = [params.get('fromDate'), params.get('toDate')];
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(toDate ?? '')) return { fromDate, toDate };
  const [from, to] = [Number(params.get('from')), Number(params.get('to'))];
  if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && from < to) return { from, to };
  return null;
}

/** The range as query parameters, for the address and for asking the bot */
export function rangeQuery(range) {
  if (range.preset) return { range: range.preset };
  if (range.fromDate) return { fromDate: range.fromDate, toDate: range.toDate };
  return { from: String(range.from), to: String(range.to) };
}

/** YYYY-MM-DD in a time zone */
export function dayIn(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** What a picked range says on its chip */
function rangeText(range, timeZone) {
  if (range.fromDate) {
    const day = (text) => new Date(`${text}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return range.fromDate === range.toDate ? day(range.fromDate) : `${day(range.fromDate)} – ${day(range.toDate)}`;
  }
  const short = range.to - range.from <= 2 * DAY_MS;
  const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(short && { hour: 'numeric', minute: '2-digit' }), timeZone });
  return format.formatRange(range.from, range.to);
}

let cally = null;

/**
 * `presets`: [[id, label]]. `value`: the range shown. `onChange(range)` is called with a new one. `earliestMs`: how far
 * back the calendar goes (Health keeps 30 days), or null for no limit. `compare`: whether the stretch before is shown,
 * with `onCompare(on)`, or undefined for a view without it. `timeZone` is the server's, which days are counted in.
 * Returns { node, zoom(range) }, where zoom picks a range from a chart and offers Back to the one before
 */
export function rangeBar({ presets, value, onChange, earliestMs = null, compare, onCompare, timeZone }) {
  let current = value;
  /** Ranges zoomed out of, newest last */
  const back = [];
  const node = el('div', { className: 'range-bar' });

  function set(range, remember = false) {
    if (remember) back.push(current);
    else back.length = 0;
    current = range;
    paint();
    onChange(range);
  }

  function pickDates() {
    void (cally ??= import('./vendor-cally.js')).then(() => {
      const today = dayIn(Date.now(), timeZone);
      const earliest = earliestMs === null ? null : dayIn(Date.now() - earliestMs, timeZone);
      const start = current.fromDate ? `${current.fromDate}/${current.toDate}` : '';
      let picked = start;
      const calendar = el(
        'calendar-range',
        { className: 'range-calendar', value: start, max: today, ...(earliest && { min: earliest }), onchange: (e) => (picked = e.target.value) },
        el('span', { slot: 'previous', ariaLabel: 'Earlier month' }, icon('left')),
        el('span', { slot: 'next', ariaLabel: 'Later month' }, icon('right')),
        el('div', { className: 'range-months' }, el('calendar-month')),
      );
      if (current.fromDate) calendar.setAttribute('focused-date', current.toDate);
      const problem = el('p', { className: 'bad-text', role: 'alert', hidden: true });
      const dialog = openDialog(document.body, {
        title: 'Pick dates',
        className: 'range-dialog',
        body: [el('p', { className: 'hint' }, earliest ? 'Tap the first day, then the last. Health keeps the last 30 days.' : 'Tap the first day, then the last.'), calendar, problem],
        actions: [el('button', { type: 'submit', className: 'primary' }, 'Show')],
        close: 'Cancel',
        onsubmit: (e) => {
          e.preventDefault();
          const [fromDate, toDate] = picked.split('/');
          if (!fromDate || !toDate) {
            problem.textContent = 'Pick a first and a last day.';
            problem.hidden = false;
            return;
          }
          dialog.close();
          set({ fromDate, toDate });
        },
      });
    });
  }

  function paint() {
    const custom = !current.preset;
    const parts = [
      el(
        'div',
        { className: 'views range-presets', role: 'group', ariaLabel: 'Time range' },
        presets.map(([id, label]) => el('button', { type: 'button', ariaPressed: String(current.preset === id), onclick: () => set({ preset: id }) }, label)),
        el('button', { type: 'button', ariaPressed: String(custom), ariaHaspopup: 'dialog', onclick: pickDates }, custom ? rangeText(current, timeZone) : 'Pick dates…'),
      ),
      back.length > 0 &&
        el(
          'button',
          {
            type: 'button',
            className: 'with-icon',
            title: 'Back to the range before zooming in',
            onclick: () => {
              current = back.pop();
              paint();
              onChange(current);
            },
          },
          icon('up'),
          'Back',
        ),
      compare !== undefined &&
        el(
          'button',
          {
            type: 'button',
            className: 'range-compare',
            ariaPressed: String(compare),
            title: 'Show the stretch of the same length just before, faint and dashed',
            onclick: () => {
              compare = !compare;
              paint();
              onCompare(compare);
            },
          },
          'Compare with before',
        ),
    ];
    node.replaceChildren(...parts.filter(Boolean));
  }

  paint();
  return {
    node,
    /** A stretch dragged across on a chart */
    zoom: (from, to) => set({ from, to }, true),
    /** Changes the time zone dates are shown in, once the bot has said it */
    timeZone: (zone) => {
      if (zone === timeZone) return;
      timeZone = zone;
      paint();
    },
  };
}
