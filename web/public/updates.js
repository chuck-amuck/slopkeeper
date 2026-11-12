import { el, request, state } from './lib.js';

/**
 * Keeps the page up with what's playing, the music, who's in voice, game nights, the activity log, the sounds and the
 * volumes, through one request at a time per tab. Each
 * waits at the bot until something the page shows changes, then brings only what did. A hidden tab stops asking until
 * it's shown again
 */

// After a failed request, how long before asking again
const RETRY_MS = 5000;
// The least time between requests that bring nothing new, should something answer without waiting for a change
const UNCHANGED_MS = 1000;
// A follower whose node never made it onto the page is let go after this long
const UNSEEN_MS = 5000;

/** Who follows each part: { node, listener, since, seen } */
const followers = { playing: new Set(), music: new Set(), voice: new Set(), nights: new Set(), activity: new Set(), sounds: new Set(), volumes: new Set() };
/** The last of each part the bot sent for the server watched: { data, at } */
let latest = new Map();
/** The request loop for one server */
let run = null;

/**
 * Calls `listener(data, at)` with `part` (playing, music, voice, nights, activity, sounds or volumes) for the server picked, now if it's known and each
 * time it changes, until `node` leaves the page. `at` is the performance.now() when the bot sent it
 */
export function follow(part, node, listener) {
  const entry = { node, listener, since: performance.now(), seen: node.isConnected };
  followers[part].add(entry);
  const watching = run;
  if (latest.has(part) && watching?.guildId === state.guildId) {
    // Once whatever's following has finished setting up
    queueMicrotask(() => {
      const known = latest.get(part);
      if (known && run === watching && followers[part].has(entry)) listener(known.data, known.at);
    });
  }
  // Asked for from the next request, which starts straight away
  else if (watching && !watching.asking.has(part)) watching.wake();
}

/**
 * Whether version `a` of a part is from before version `b`. Each run of the bot starts its own, and within a run they
 * only go up, so versions from different runs aren't compared
 */
export function older(a, b) {
  if (!a || !b) return false;
  const [runA, countsA] = a.split('.');
  const [runB, countsB] = b.split('.');
  const total = (counts) => counts.split('-').reduce((sum, n) => sum + Number(n), 0);
  return runA === runB && total(countsA) < total(countsB);
}

// Where a press that hasn't been let go of started: a slider being dragged, say
let pressing = null;
addEventListener('pointerdown', (e) => (pressing = e.target), true);
for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => (pressing = null), true);

// Fields that take typing, as opposed to a switch, slider or menu that's done with once used
const TYPING = 'textarea, input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit], [type=reset], [type=file], [type=color])';

/**
 * Like follow, for a part of the page someone may be in the middle of using: a change that comes while they're typing
 * or pressing in one of `areas()`, have a delete or cancel waiting for its second press there, or `alsoBusy()` says so,
 * waits until they're done. Only the newest change is kept meanwhile
 */
export function followWhenIdle(part, node, areas, listener, alsoBusy = () => false) {
  let held = null;
  let check = 0;
  const busy = () =>
    alsoBusy() ||
    areas().some((area) => {
      const at = document.activeElement;
      return (area.contains(at) && at.matches(TYPING)) || (pressing && area.contains(pressing)) || !!area.querySelector('.confirm.danger');
    });
  const apply = () => {
    if (!node.isConnected) return clearInterval(check);
    if (!held || busy()) return;
    clearInterval(check);
    const data = held;
    held = null;
    listener(data);
  };
  follow(part, node, (data) => {
    held = data;
    clearInterval(check);
    // Checked now and then rather than on each way of finishing, as a second press that never comes just times out
    if (busy()) check = setInterval(apply, 1000);
    else apply();
  });
}

/** Lets go of followers whose node has left the page, and of what nobody follows, so following it again starts fresh */
function prune() {
  const now = performance.now();
  for (const [part, entries] of Object.entries(followers)) {
    for (const entry of entries) {
      entry.seen ||= entry.node.isConnected;
      if (!entry.node.isConnected && (entry.seen || now - entry.since > UNSEEN_MS)) entries.delete(entry);
    }
    if (!entries.size) latest.delete(part);
  }
}

function publish(part, data, at) {
  latest.set(part, { data, at });
  for (const entry of followers[part]) if (entry.node.isConnected) entry.listener(data, at);
}

/** Waits `ms`, or until `me` is woken by something new to follow */
const rest = (me, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    me.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

/** Waits until the tab is shown or hidden, or something new is followed */
const pause = (me) =>
  new Promise((resolve) => {
    const done = new AbortController();
    me.wake = () => {
      done.abort();
      resolve();
    };
    document.addEventListener('visibilitychange', me.wake, { signal: done.signal });
  });

/** Starts keeping up with the server picked, unless that's already happening */
export function watchUpdates() {
  if (run?.alive && run.guildId === state.guildId) return;
  stopWatchingUpdates();
  latest = new Map();
  const me = { guildId: state.guildId, alive: true, asking: new Set(), wake: () => {} };
  run = me;
  // Once the page drawing now has said what it follows, so the first request asks for all of it
  queueMicrotask(() => void loop(me));
}

async function loop(me) {
  let failures = 0;
  while (me.alive) {
    prune();
    const parts = Object.keys(followers).filter((part) => followers[part].size);
    if (!parts.length || document.hidden) {
      me.asking = new Set();
      await pause(me);
      continue;
    }
    me.asking = new Set(parts);
    const asking = new AbortController();
    me.wake = () => asking.abort();
    // A version for each part it has, and an empty one for each it hasn't, which the bot answers at once
    const query = new URLSearchParams(parts.map((part) => [part, latest.get(part)?.data.version ?? '']));
    const asked = performance.now();
    try {
      const answer = await request(`/api/guilds/${me.guildId}/updates?${query}`, { signal: asking.signal });
      // Cut short to ask again for something new, or stopped
      if (!me.alive) return;
      if (asking.signal.aborted) continue;
      const at = performance.now();
      for (const part of parts) if (answer[part]) publish(part, answer[part], at);
      failures = 0;
      lostTouch(false);
      if (!parts.some((part) => answer[part])) await rest(me, UNCHANGED_MS - (performance.now() - asked));
    } catch (err) {
      if (!me.alive) return;
      if (asking.signal.aborted) continue;
      // Logged out: the login page takes over, and there's nothing to watch
      if (err.status === 401) return stopWatchingUpdates();
      // Twice in a row is the bot gone, or one too old to answer, rather than a blip: say so, and stop showing what was playing
      if (++failures === 2) {
        lostTouch(true);
        if (followers.playing.size) publish('playing', { version: '', playing: [] }, performance.now());
      }
      // Sooner for something newly followed, such as another tab opened meanwhile
      await rest(me, RETRY_MS);
    }
  }
}

export function stopWatchingUpdates() {
  if (run) {
    run.alive = false;
    run.wake();
  }
  run = null;
  lostTouch(false);
}

const banner = el('div', { className: 'lost-touch', role: 'status', hidden: true }, 'Lost touch with the bot. Trying again…');

/** A strip across the top while the bot isn't answering, so a failed tap isn't the first sign */
function lostTouch(on) {
  if (on && !banner.isConnected) document.body.prepend(banner);
  banner.hidden = !on;
}
