import { api, attempt, el, icon, request, state, toast } from './lib.js';

// After a failed request, how long before asking again
const RETRY_MS = 5000;
// The least time between requests that bring no change, should something answer without waiting for one
const UNCHANGED_MS = 1000;
// Speech shows as its first few words
const SPEECH_SHOWN = 40;
// Past this many, the rest show as a count
const MOST_SHOWN = 4;

/** What's playing in the server picked, as the bot last said, and when it said it */
let latest = { guildId: null, playing: [], at: 0 };
const listeners = new Set();
/** The request loop for one server, stopped by setting alive to false */
let watching = null;

const short = (text) => (text.length > SPEECH_SHOWN ? `${text.slice(0, SPEECH_SHOWN - 1).trimEnd()}…` : text);
const nameOf = (p) => (p.kind === 'speech' ? `“${short(p.name)}”` : p.name);

/** How far into a sound or line it is now, in milliseconds */
export const elapsed = (p) => p.elapsedMs + (performance.now() - latest.at);

/** Calls `listener` with what's playing now and each time it changes, until `node` leaves the page */
export function onPlaying(node, listener) {
  const entry = { node, listener };
  listeners.add(entry);
  if (latest.guildId === state.guildId) listener(latest.playing);
}

function publish(guildId, playing) {
  latest = { guildId, playing, at: performance.now() };
  for (const entry of listeners) {
    if (!entry.node.isConnected) listeners.delete(entry);
    else entry.listener(playing);
  }
}

/**
 * Keeps up with what's playing in the server picked. Each request waits at the bot until something starts or ends, so a
 * short sound shows while it plays. A hidden tab stops asking until it's shown again
 */
export function watchPlaying() {
  if (watching?.alive && watching.guildId === state.guildId) return;
  stopWatchingPlaying();
  const run = { guildId: state.guildId, alive: true };
  watching = run;
  publish(run.guildId, []);
  void (async () => {
    const path = api('/playing');
    let version = null;
    let failures = 0;
    while (run.alive) {
      if (document.hidden) {
        await new Promise((resolve) => document.addEventListener('visibilitychange', resolve, { once: true }));
        continue;
      }
      try {
        const asked = performance.now();
        const data = await request(version === null ? path : `${path}?after=${encodeURIComponent(version)}`);
        if (!run.alive) return;
        const unchanged = data.version === version;
        version = data.version;
        publish(run.guildId, data.playing);
        if (unchanged) await new Promise((resolve) => setTimeout(resolve, Math.max(0, UNCHANGED_MS - (performance.now() - asked))));
        failures = 0;
        lostTouch(false);
      } catch (err) {
        if (!run.alive) return;
        // Logged out: the login page takes over, and there's nothing to watch
        if (err.status === 401) return stopWatchingPlaying();
        // Twice in a row unanswered is the bot gone rather than a blip: say so, and stop showing what was playing
        if ((!err.status || err.status >= 500) && ++failures === 2) {
          lostTouch(true);
          publish(run.guildId, []);
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  })();
}

export function stopWatchingPlaying() {
  if (watching) watching.alive = false;
  watching = null;
  lostTouch(false);
}

const banner = el('div', { className: 'lost-touch', role: 'status', hidden: true }, 'Lost touch with the bot. Trying again…');

/** A strip across the top while the bot isn't answering, so a failed tap isn't the first sign */
function lostTouch(on) {
  if (on && !banner.isConnected) document.body.prepend(banner);
  banner.hidden = !on;
}

/**
 * The Stop sounds button, in the corner of every page, with what's playing above it. Tapping a name stops just that
 * one; the button stops them all, but never the music
 */
export function stopDock() {
  const list = el('ul', { className: 'now-sounds', ariaLabel: 'Playing now', hidden: true });
  const label = el('span', { className: 'stop-label' }, 'Stop sounds');
  const button = el(
    'button',
    {
      className: 'stop-all with-icon',
      title: 'Stops every sound and line of speech. The music carries on',
      onclick: () =>
        attempt(async () => {
          const { musicPlaying } = await request(api('/stop'), { method: 'POST' });
          // The music has its own controls, but it's often what someone wanted quiet too
          const pause = {
            label: 'Pause music',
            run: async () => {
              await request(api('/music/pause'), { method: 'POST' });
              toast('Music paused.');
            },
          };
          toast('Stopped sounds and speech.', false, musicPlaying ? pause : null);
        }),
    },
    icon('stop'),
    label,
  );
  const node = el('div', { className: 'stop-dock' }, list, button);
  // On a phone, two or more show as one chip until it's tapped, so they don't cover the sounds
  const narrow = matchMedia('(max-width: 640px)');
  let expanded = false;
  let shownPlaying = [];

  async function stopOne(p) {
    const guildId = state.guildId;
    try {
      const { playing } = await request(api(`/playing/${p.id}/stop`), { method: 'POST' });
      // Unless someone switched servers meanwhile
      if (guildId === state.guildId) publish(guildId, playing);
    } catch (err) {
      // Already over is what was wanted
      if (err.status !== 404) toast(err.message, true);
    }
  }

  const paintList = (playing) => {
    shownPlaying = playing;
    label.textContent = !playing.length ? 'Stop sounds' : playing.length === 1 ? `Stop ${playing[0].kind === 'speech' ? 'speech' : playing[0].name}` : `Stop all ${playing.length}`;
    if (playing.length < 2) expanded = false;
    list.hidden = !playing.length;
    if (narrow.matches && playing.length > 1 && !expanded) {
      list.replaceChildren(
        el(
          'li',
          {},
          el(
            'button',
            { type: 'button', className: 'now-sound now-count', ariaExpanded: 'false', onclick: () => ((expanded = true), paintList(shownPlaying), list.querySelector('.now-count')?.focus()) },
            el('span', { className: 'now-name' }, `${playing.length} playing`),
            el('span', { className: 'now-x' }, icon('chevron')),
          ),
        ),
      );
      return;
    }
    const shown = playing.slice(-MOST_SHOWN);
    const hiddenCount = playing.length - shown.length;
    const fold =
      narrow.matches && expanded
        ? [
            el(
              'li',
              {},
              el('button', { type: 'button', className: 'now-sound now-count', ariaExpanded: 'true', onclick: () => ((expanded = false), paintList(shownPlaying), list.querySelector('.now-count')?.focus()) }, el('span', { className: 'now-name' }, 'Fold up'), el('span', { className: 'now-x up' }, icon('chevron'))),
            ),
          ]
        : [];
    // Oldest at the top, so the newest sits next to the button
    list.replaceChildren(
      ...fold,
      ...(hiddenCount ? [el('li', { className: 'now-more' }, `+${hiddenCount} more`)] : []),
      ...shown.map((p) =>
        el(
          'li',
          {},
          el(
            'button',
            {
              type: 'button',
              className: `now-sound${p.kind === 'speech' ? ' speech' : ''}`,
              ariaLabel: `Stop ${p.kind === 'speech' ? `speech ${nameOf(p)}` : p.name}${p.loop ? ', looping' : ''}`,
              title: 'Stop just this one',
              onclick: () => void stopOne(p),
            },
            el('span', { className: 'now-name' }, nameOf(p)),
            p.loop && el('span', { className: 'now-loop' }, 'looping'),
            el('span', { className: 'now-x' }, icon('x')),
          ),
        ),
      ),
    );
  };
  onPlaying(node, paintList);
  const onNarrow = () => (node.isConnected ? paintList(shownPlaying) : narrow.removeEventListener('change', onNarrow));
  narrow.addEventListener('change', onNarrow);
  // Toasts sit above the dock, wherever its top is now. Measured once it's on the page and whenever it changes size
  const sizes = new ResizeObserver(() => {
    // A dock left behind by a redraw lets go, rather than being watched for the rest of the visit
    if (!node.isConnected) {
      narrow.removeEventListener('change', onNarrow);
      return sizes.disconnect();
    }
    document.documentElement.style.setProperty('--dock-extra', `${list.offsetHeight ? list.offsetHeight + 8 : 0}px`);
  });
  sizes.observe(list);
  return node;
}
