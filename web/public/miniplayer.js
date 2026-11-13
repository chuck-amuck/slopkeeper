import { api, attempt, devicePref, el, forget, icon, pickedVoice, recall, remember, request, secondWindow, state, toast } from './lib.js';
import { cover } from './music.js';
import { follow } from './updates.js';

// Set while the music player is hidden with its ✕, for each server, until the music stops
const hiddenKey = (guildId) => `musicPlayerHidden:${guildId}`;

/** Whether the page has the music player along its bottom, which what else floats there keeps clear of */
const holdRoom = (on) => document.documentElement.classList.toggle('with-player', on);

/** For a page without the music player, such as Music itself, which has the full controls */
export const noMusicPlayer = () => holdRoom(false);

/**
 * The song playing, along the bottom of every page but Music: its cover, title and artist, which open Music, then
 * Pause or Play and Skip, with a line across the top for how far into the song it is. It shows while music plays or
 * is paused, unless it's turned off in Settings on this device, hidden with ✕ until the music stops, or in the pop-out
 * window while that's open. `extra` goes beside its buttons. `inWindow` is the pop-out's: there it shows whenever
 * music plays, without ✕, and the song opens nothing
 */
export function musicPlayer(openMusic, { inWindow = false, extra = null } = {}) {
  const guildId = state.guildId;
  let data = null;
  let fetchedAt = 0;

  const line = el('span', { className: 'mini-line' });
  const art = el('span', { className: 'mini-cover' });
  const title = el('span', { className: 'mini-title' });
  const sub = el('span', { className: 'mini-sub' });
  const text = el('span', { className: 'mini-text' }, title, sub);
  const song = inWindow ? el('div', { className: 'mini-song' }, art, text) : el('button', { type: 'button', className: 'mini-song', title: 'Open Music', onclick: openMusic }, art, text);
  const playButton = el('button', { type: 'button', className: 'icon mini-play', onclick: () => void act(playOrPause) });
  const skipButton = el('button', { type: 'button', className: 'icon mini-skip', ariaLabel: 'Skip', title: 'Skip to the next song', onclick: () => void act(() => request(api('/music/skip'), { method: 'POST' })) }, icon('next'));
  const close = el('button', { type: 'button', className: 'icon quiet mini-close', ariaLabel: 'Hide the music player', title: 'Hide until the music stops', onclick: hide }, icon('x'));
  const node = el(
    'section',
    { className: 'mini-player', ariaLabel: 'Music player', hidden: true },
    el('span', { className: 'mini-progress', ariaHidden: 'true' }, line),
    song,
    el('div', { className: 'mini-controls' }, playButton, skipButton, extra, !inWindow && close),
  );

  function hide() {
    remember(hiddenKey(guildId), '1');
    paint();
    // Focus was on ✕, which is gone now
    document.getElementById('page-title')?.focus();
    toast('Music player hidden until the music stops.', false, {
      label: 'Undo',
      // Tells whichever player is on the page by then, which may be another tab's
      run: () => {
        forget(hiddenKey(guildId));
        dispatchEvent(new CustomEvent('device-pref', { detail: 'musicPlayer' }));
      },
    });
  }

  /** Pauses, or plays on where it was paused: in the music's own channel, or Play in's if it's left that */
  function playOrPause() {
    if (data.phase === 'playing') return request(api('/music/pause'), { method: 'POST' });
    return request(api('/music/play'), { method: 'POST', json: { channelId: data.channelId ?? pickedVoice.get() } });
  }

  async function act(action) {
    playButton.disabled = skipButton.disabled = true;
    try {
      const fresh = await attempt(action);
      if (fresh?.queue) show(fresh, 0);
    } finally {
      paint();
    }
  }

  function paint() {
    const playing = data && data.phase !== 'stopped' ? data.queue[0] : null;
    // A hide lasts until the music stops, then the next song shows again
    if (data && !playing) forget(hiddenKey(guildId));
    const shown = !!playing && (inWindow || (devicePref.on('musicPlayer') && recall(hiddenKey(guildId)) !== '1' && !secondWindow()));
    node.hidden = !shown;
    if (node.isConnected && !inWindow) holdRoom(shown);
    if (!shown) return;
    const paused = data.phase === 'paused';
    const starting = data.phase === 'starting';
    art.replaceChildren(cover(playing.cover, 40));
    title.textContent = playing.title;
    sub.textContent = [playing.artist, starting ? 'Finding it…' : paused ? 'Paused' : data.channelName && `in ${data.channelName}`].filter(Boolean).join(' · ');
    if (!inWindow) song.ariaLabel = `${playing.title} by ${playing.artist}. Open Music`;
    playButton.replaceChildren(icon(paused ? 'play' : 'pause'));
    playButton.ariaLabel = paused ? 'Play' : 'Pause';
    playButton.title = paused ? 'Play on from where it paused' : 'Pause, keeping the queue';
    playButton.disabled = starting;
    skipButton.disabled = false;
    paintLine(playing, paused || starting);
  }

  /** The line runs on its own, from where the song is now, and holds still while it's paused or being found */
  function paintLine(playing, still) {
    const at = Math.min(playing.durationMs, data.positionMs + (data.phase === 'playing' ? Date.now() - fetchedAt : 0));
    const key = `${playing.id}:${data.phase}:${data.positionMs}`;
    if (line.dataset.key === key) return;
    line.dataset.key = key;
    line.classList.remove('running');
    line.style.setProperty('--song-ms', `${Math.max(1, playing.durationMs)}ms`);
    line.style.setProperty('--song-delay', `${-Math.round(at)}ms`);
    line.style.animationPlayState = still ? 'paused' : '';
    void line.offsetWidth;
    if (playing.durationMs) line.classList.add('running');
  }

  /** `age` is how long ago, in milliseconds, the bot said it, for where the song has got to */
  function show(fresh, age) {
    if (guildId !== state.guildId || !node.isConnected) return;
    data = fresh;
    fetchedAt = Date.now() - age;
    paint();
  }

  follow('music', node, (fresh, at) => show(fresh, performance.now() - at));
  if (inWindow) return node;
  // Settings turns it on and off for this device, and it makes way for the pop-out window while that's open
  const onPref = (e) => (node.isConnected ? e.detail === 'musicPlayer' && paint() : removeEventListener('device-pref', onPref));
  addEventListener('device-pref', onPref);
  const onWindow = () => (node.isConnected ? paint() : removeEventListener('second-window', onWindow));
  addEventListener('second-window', onWindow);
  return node;
}
