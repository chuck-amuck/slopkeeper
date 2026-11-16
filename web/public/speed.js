/**
 * How fast the web UI is as people see it: taps answered, the page opening and the page reacting, timed in this
 * browser and sent to the bot about once a minute while the tab is seen. Nothing in it says who sent it; the web UI
 * adds whether it came through Pangolin
 */

const FIRST_REPORT_MS = 20_000;
const REPORT_MS = 60_000;
/** The most of each kind a report holds; a busy minute is far under it */
const MOST = 500;
/** Taps the browser leaves untimed were quicker than this, which is as fine as its Event Timing goes */
const TIMED_FROM_MS = 16;
/** A tap's timing arrives after the page next paints, so a report leaves the last second's taps for the next one */
const SETTLE_MS = 1000;

const device = matchMedia('(pointer: coarse)').matches ? 'phone' : 'computer';
const round = (seconds) => Math.round(seconds * 1e4) / 1e4;

/** Whether the web UI is open past the login, which is all that's timed */
let started = false;
let timers = false;
let requests = [];

/**
 * A request to the bot through the web UI that's been answered: all it took, and the part before its answer started
 * arriving that wasn't the bot (from the web UI's Server-Timing header), which is the network's
 */
export function noteRequest(kind, seconds, network) {
  if (!started || requests.length >= MOST) return;
  requests.push([kind, round(seconds), network === null ? null : round(Math.max(0, network))]);
}

/** The bot's part of an answer, from the web UI's Server-Timing header, in seconds */
export function botTime(res) {
  const ms = Number(/(?:^|,)\s*bot;dur=([\d.]+)/.exec(res.headers.get('server-timing') ?? '')?.[1]);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

// How long the page took to open counts only if it opened on the web UI itself, in sight: not on the login form, and not
// hidden before it had loaded
let pageCounts = document.visibilityState === 'visible';
let pageSent = false;
let shownAt = null;
addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && document.readyState !== 'complete' && (pageCounts = false));

// The largest content shown, which Chrome, Edge and Firefox report. It stops changing once someone taps or scrolls
try {
  new PerformanceObserver((list) => {
    const last = list.getEntries().at(-1);
    if (last) shownAt = last.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
} catch {
  // Safari: the load event stands in
}

function pageTimes() {
  if (pageSent || !pageCounts) return null;
  const nav = performance.getEntriesByType('navigation')[0];
  if (!nav) return null;
  const shown = shownAt ?? (nav.loadEventEnd > 0 ? nav.loadEventEnd : null);
  if (shown === null) return null;
  pageSent = true;
  return { firstByte: round(nav.responseStart / 1000), shown: round(shown / 1000) };
}

/** When each tap or key press happened, and how long the slow ones took to show, by interaction: { at, ms } */
let interactions = [];
const slowOnes = new Map();
const timesTaps = typeof PerformanceEventTiming !== 'undefined' && 'interactionId' in PerformanceEventTiming.prototype && PerformanceObserver.supportedEntryTypes?.includes('event');
if (timesTaps) {
  new PerformanceObserver((list) => {
    if (!started) return;
    for (const entry of list.getEntries()) {
      if (!entry.interactionId) continue;
      const known = slowOnes.get(entry.interactionId);
      slowOnes.set(entry.interactionId, { at: Math.min(known?.at ?? Infinity, entry.startTime), ms: Math.max(known?.ms ?? 0, entry.duration) });
    }
  }).observe({ type: 'event', durationThreshold: TIMED_FROM_MS });
  // One for each tap or key press, as each makes one interaction
  addEventListener('pointerdown', (e) => started && interactions.push(e.timeStamp), { capture: true, passive: true });
  addEventListener('keydown', (e) => started && !e.repeat && interactions.push(e.timeStamp), { capture: true, passive: true });
}

/** Taps up to `upTo` (a performance.now() time): those the browser timed, and how many were too quick for it to */
function tapsUpTo(upTo) {
  const responses = [];
  for (const [id, { at, ms }] of slowOnes) {
    if (at >= upTo) continue;
    slowOnes.delete(id);
    if (responses.length < MOST) responses.push(round(ms / 1000));
  }
  const counted = interactions.filter((at) => at < upTo).length;
  interactions = interactions.filter((at) => at >= upTo);
  return { responses, quickResponses: Math.min(MOST, Math.max(0, counted - responses.length)) };
}

/** Sends what's been timed. As the tab is hidden, it may be closing, so everything goes without waiting for the last tap */
function report(closing = false) {
  if (!started) return;
  const { responses, quickResponses } = tapsUpTo(closing ? Infinity : performance.now() - SETTLE_MS);
  const page = pageTimes();
  if (!requests.length && !responses.length && !quickResponses && !page) return;
  const body = JSON.stringify({ device, requests, page, responses, quickResponses });
  requests = [];
  // Sent even as the tab closes; a report that doesn't arrive is just missed
  fetch('/api/perf', { method: 'POST', keepalive: true, headers: { 'x-slopkeeper': '1', 'content-type': 'application/json' }, body }).catch(() => {});
}

/** Starts timing and reporting, once the web UI has opened past the login */
export function startSpeed() {
  started = true;
  if (timers) return;
  timers = true;
  setTimeout(() => {
    if (!document.hidden) report();
    setInterval(() => !document.hidden && report(), REPORT_MS);
  }, FIRST_REPORT_MS);
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && report(true));
}

/** The login form is showing: typing a password isn't using the web UI, and the page's opening wasn't the web UI's */
export function stopSpeed() {
  started = false;
  pageCounts = false;
  requests = [];
  interactions = [];
  slowOnes.clear();
}
