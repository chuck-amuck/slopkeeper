import { api, attempt, el, request, state, toast } from './lib.js';

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
      } catch {
        if (!run.alive) return;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  })();
}

export function stopWatchingPlaying() {
  if (watching) watching.alive = false;
  watching = null;
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
      className: 'stop-all',
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
    el('span', { ariaHidden: 'true' }, '■ '),
    label,
  );
  const node = el('div', { className: 'stop-dock' }, list, button);

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

  onPlaying(node, (playing) => {
    label.textContent = !playing.length ? 'Stop sounds' : playing.length === 1 ? `Stop ${playing[0].kind === 'speech' ? 'speech' : playing[0].name}` : `Stop all ${playing.length}`;
    const shown = playing.slice(-MOST_SHOWN);
    const hiddenCount = playing.length - shown.length;
    // Oldest at the top, so the newest sits next to the button
    list.replaceChildren(
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
            el('span', { className: 'now-x', ariaHidden: 'true' }, '×'),
          ),
        ),
      ),
    );
    list.hidden = !playing.length;
  });
  // Toasts sit above the dock, wherever its top is now. Measured once it's on the page and whenever it changes size
  new ResizeObserver(() => {
    if (node.isConnected) document.documentElement.style.setProperty('--dock-extra', `${list.offsetHeight ? list.offsetHeight + 8 : 0}px`);
  }).observe(list);
  return node;
}
