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
 * Stop, shown only while something's playing: it stops every sound and line of speech, but never the music, and the
 * toast after offers to pause that too. paint(playing) shows it for what's playing now
 */
export function stopButton() {
  const label = el('span', { className: 'stop-label' }, 'Stop sounds');
  const button = el(
    'button',
    {
      className: 'stop-all with-icon',
      hidden: true,
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
  return {
    button,
    paint(playing) {
      button.hidden = !playing.length;
      label.textContent = playing.length === 1 ? `Stop ${playing[0].kind === 'speech' ? 'speech' : playing[0].name}` : `Stop all ${playing.length}`;
    },
  };
}

/**
 * The corner of every page: the Volume button, and while anything's playing, the Stop button beside it with what's
 * playing above. Tapping a name stops just that one; Stop stops them all, but never the music. `volume` is the Volume
 * button and the panel it opens, which goes above the rest, and `sounds` the same for the Sounds panel, if the page
 * has one. One of the two panels is open at a time
 */
export function stopDock(volume, sounds = null) {
  const list = el('ul', { className: 'now-sounds', ariaLabel: 'Playing now', hidden: true });
  const stop = stopButton();
  const node = el('div', { className: 'stop-dock' }, list, volume.panel, sounds?.panel, el('div', { className: 'dock-row' }, stop.button, sounds?.button, volume.button));
  if (sounds) {
    volume.onOpen = sounds.close;
    sounds.onOpen = volume.close;
  }
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
    stop.paint(playing);
    if (playing.length < 2) expanded = false;
    // One sound on its own is named on Stop already. Speech and a loop show, for what's said and that it loops
    list.hidden = !playing.length || (playing.length === 1 && playing[0].kind !== 'speech' && !playing[0].loop);
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
  // Toasts sit above the corner, wherever its top is now: above what's playing and a panel when one's open. Measured
  // once it's on the page and whenever any of them changes size. The page's end keeps clear of all but the Sounds
  // panel, which is tall, and on a wide screen made to be used beside the page
  const sizes = new ResizeObserver(() => {
    // A dock left behind by a redraw lets go, rather than being watched for the rest of the visit
    if (!node.isConnected) {
      narrow.removeEventListener('change', onNarrow);
      return sizes.disconnect();
    }
    const height = (part) => (part?.offsetHeight ? part.offsetHeight + 8 : 0);
    const page = height(list) + height(volume.panel);
    document.documentElement.style.setProperty('--dock-extra', `${page + height(sounds?.panel)}px`);
    document.documentElement.style.setProperty('--dock-page', `${page}px`);
  });
  sizes.observe(list);
  sizes.observe(volume.panel);
  if (sounds) sizes.observe(sounds.panel);
  return node;
}
