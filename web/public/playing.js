import { api, attempt, el, icon, request, state, toast } from './lib.js';
import { follow } from './updates.js';

// Speech shows as its first few words
const SPEECH_SHOWN = 40;
// Past this many, the rest show as a count
const MOST_SHOWN = 4;

/** When the bot last said what's playing */
let saidAt = 0;

const short = (text) => (text.length > SPEECH_SHOWN ? `${text.slice(0, SPEECH_SHOWN - 1).trimEnd()}…` : text);
const nameOf = (p) => (p.kind === 'speech' ? `“${short(p.name)}”` : p.name);

/** How far into a sound or line it is now, in milliseconds */
export const elapsed = (p) => p.elapsedMs + (performance.now() - saidAt);

/** Calls `listener` with what's playing now and each time it changes, until `node` leaves the page */
export function onPlaying(node, listener) {
  follow('playing', node, (data, at) => {
    saidAt = at;
    listener(data.playing);
  });
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
      // Straight away, rather than when the update comes, unless someone switched servers meanwhile
      if (guildId === state.guildId) paintList(playing);
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
