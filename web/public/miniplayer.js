import { api, attempt, devicePref, el, forget, icon, needsVoice, NOBODY_IN_VOICE, pageSignal, recall, remember, request, secondWindow, state, toast } from './lib.js';
import { cantPlay, paintCover, playOrPause, positionOf, stale } from './music.js';
import { follow } from './updates.js';
import { voiceBar } from './voice.js';

// For each server, when the music the player was hidden for with ✕ started, as the bot says: it's hidden until that stops
const hiddenKey = (guildId) => `musicPlayerHidden:${guildId}`;

/** Whether the page has the music player along its bottom, which what else floats there keeps clear of */
const holdRoom = (on) => document.documentElement.classList.toggle('with-player', on);

/** For a page without the music player, such as Music itself, which has the full controls */
export const noMusicPlayer = () => holdRoom(false);

/**
 * The song playing, at the bottom of every page but Music: its cover, title and artist, which open Music, then Pause
 * or Play and Skip, with a line along the bottom for how far into the song it is. Play plays on in the channel picked
 * in Play in, as the Music tab does. It shows while music plays or is paused, unless it's turned off in Settings on
 * this device, hidden with ✕ until the music stops, or in the pop-out window while that's open. `extra` goes beside
 * ✕. `inWindow` is the pop-out's: there it shows whenever music plays, without ✕, and the song opens nothing
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
  const playButton = el('button', { type: 'button', className: 'icon mini-play', onclick: pressPlay });
  const skipButton = el('button', { type: 'button', className: 'icon mini-skip', ariaLabel: 'Skip', title: 'Skip to the next song', onclick: () => void act(() => request(api('/music/skip'), { method: 'POST' })) }, icon('next'));
  const close = el('button', { type: 'button', className: 'icon quiet mini-close', ariaLabel: 'Hide the music player', title: 'Hide until the music stops', onclick: hide }, icon('x'));
  // Play in's channel, which Play plays on in, and who's in voice, which says whether it can
  const voice = voiceBar(() => paint(), { sliders: false });
  const node = el(
    'section',
    { className: 'mini-player', ariaLabel: 'Music player', hidden: true },
    voice.node,
    el('span', { className: 'mini-progress', ariaHidden: 'true' }, line),
    song,
    el('div', { className: 'mini-controls' }, playButton, skipButton),
    el('div', { className: 'mini-extra' }, extra, !inWindow && close),
  );

  function hide() {
    remember(hiddenKey(guildId), String(data.since));
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

  async function act(action) {
    playButton.disabled = skipButton.disabled = true;
    try {
      const fresh = await attempt(action);
      if (fresh?.queue) show(fresh, 0);
    } finally {
      paint();
    }
  }

  function pressPlay() {
    const channel = voice.channel();
    if (!cantPlay(data, channel)) void act(() => playOrPause(data, channel));
  }

  function paint() {
    // Until the bot's said, the page keeps the room it had, so the corner's buttons don't jump about
    if (!data) return;
    const playing = data.phase !== 'stopped' ? data.queue[0] : null;
    // A hide lasts until the music stops, so music started since shows, even if no player saw it stop
    const hiddenFor = recall(hiddenKey(guildId));
    if (hiddenFor && hiddenFor !== String(data.since)) forget(hiddenKey(guildId));
    const hidden = !!playing && hiddenFor === String(data.since);
    const shown = !!playing && (inWindow || (devicePref.on('musicPlayer') && !hidden && !secondWindow()));
    node.hidden = !shown;
    if (node.isConnected && !inWindow) holdRoom(shown);
    if (!shown) return;
    const paused = data.phase === 'paused';
    const starting = data.phase === 'starting';
    paintCover(art, playing.cover, 40);
    title.textContent = playing.title;
    sub.textContent = [playing.artist, starting ? 'Finding it…' : paused ? 'Paused' : data.channelName && `in ${data.channelName}`].filter(Boolean).join(' · ');
    if (!inWindow) song.ariaLabel = `${playing.title} by ${playing.artist}. Open Music`;
    const cant = cantPlay(data, voice.channel());
    if (playButton.dataset.icon !== (paused ? 'play' : 'pause')) {
      playButton.dataset.icon = paused ? 'play' : 'pause';
      playButton.replaceChildren(icon(paused ? 'play' : 'pause'));
    }
    playButton.ariaLabel = paused ? 'Play' : 'Pause';
    playButton.title = !paused ? 'Pause, keeping the queue' : cant || 'Play on from where it paused, in the channel picked in Play in';
    playButton.disabled = starting || (!!cant && cant !== NOBODY_IN_VOICE);
    needsVoice(playButton, cant !== NOBODY_IN_VOICE);
    skipButton.disabled = false;
    paintLine(playing, paused || starting);
  }

  /** The line runs on its own, from where the song is now, and holds still while it's paused or being found */
  function paintLine(playing, still) {
    const at = positionOf(data, fetchedAt);
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
    if (guildId !== state.guildId || !node.isConnected || stale(fresh, data)) return;
    data = fresh;
    fetchedAt = Date.now() - age;
    paint();
  }

  follow('music', node, (fresh, at) => show(fresh, performance.now() - at));
  if (inWindow) return node;
  // Settings turns it on and off for this device, and it makes way for the pop-out window while that's open
  addEventListener('device-pref', (e) => e.detail === 'musicPlayer' && paint(), { signal: pageSignal() });
  addEventListener('second-window', paint, { signal: pageSignal() });
  return node;
}
