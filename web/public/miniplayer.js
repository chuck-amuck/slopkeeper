import { api, attempt, devicePref, el, forget, icon, keepFocus, needsVoice, NOBODY_IN_VOICE, pageSignal, recall, remember, request, secondWindow, state, toast } from './lib.js';
import { autoplayHead, cantPlay, cover, paintCover, playOrPause, positionOf, removeAutoplaySong, removeSong, stale } from './music.js';
import { addSongBox } from './musicadd.js';
import { foldHead } from './soundgrid.js';
import { follow } from './updates.js';
import { voiceBar } from './voice.js';
import { volumeSliders } from './volumes.js';

// The pop-out's Up next: how many songs it lists, and whether it's open, on this device
const UP_NEXT_SHOWN = 5;
const UP_NEXT_KEY = 'popoutUpNext';

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
 * this device, hidden with ✕ until the music stops, or in the pop-out window while that's open. + opens a box to add a
 * song. `extra` goes beside ✕. `inWindow` is the pop-out's: there it shows even with nothing playing, so + can start
 * the music, without ✕, the song opens nothing, and the music's volume and a small Up next that folds away follow it
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
  const adding = addSongBox({ channel: () => voice.channel(), added: (fresh) => show(fresh, 0) });
  const addButton = el('button', { type: 'button', className: 'icon quiet mini-add-button', ariaLabel: 'Add a song', title: 'Add a song to the queue', ariaExpanded: 'false', onclick: () => openAdding(!adding.open) }, icon('plus'));
  const node = el(
    'section',
    { className: 'mini-player', ariaLabel: 'Music player', hidden: true },
    voice.node,
    el('span', { className: 'mini-progress', ariaHidden: 'true' }, line),
    song,
    el('div', { className: 'mini-controls' }, playButton, skipButton),
    el('div', { className: 'mini-extra' }, addButton, extra, !inWindow && close),
    // On a page it opens above the card; in the pop-out, under it
    !inWindow && adding.node,
  );
  adding.node.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    openAdding(false);
    addButton.focus();
  });

  // On a page, a press anywhere else closes the box
  let listening = null;
  function openAdding(on) {
    if (adding.open === on) return;
    adding.show(on);
    addButton.ariaExpanded = String(on);
    listening?.abort();
    listening = null;
    if (!on || inWindow) return;
    listening = new AbortController();
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!node.isConnected) return listening?.abort();
        if (!node.contains(e.target) && !e.target.closest?.('#toasts')) openAdding(false);
      },
      { signal: listening.signal, capture: true },
    );
  }

  // ---------- the pop-out's extras ----------
  const upNextList = inWindow && el('ol', { className: 'mini-next-list' });
  const upNextBody = inWindow && el('div', { className: 'mini-next' }, upNextList);
  const upNextHead = inWindow && foldHead('Up next', recall(UP_NEXT_KEY) === 'open', upNextBody, (open) => (open ? remember(UP_NEXT_KEY, 'open') : forget(UP_NEXT_KEY)), 0);
  const upNext = inWindow && el('section', { className: 'mini-next-section', hidden: true }, upNextHead, upNextBody);
  let shownNext = '';

  /** The songs after the card's, people's then Autoplay's, each with ✕. Rebuilt only when the queue changes */
  function paintUpNext() {
    // The first song is on the card, playing or waiting to play
    const held = 1;
    const rows = data.queue.slice(held);
    upNext.hidden = !rows.length;
    upNextHead.querySelector('.fold-count').textContent = String(rows.length);
    const key = JSON.stringify([rows.map((r) => r.id), data.autoplayLike]);
    if (key === shownNext) return;
    shownNext = key;
    const listed = rows.slice(0, UP_NEXT_SHOWN);
    const firstAutoplay = listed.findIndex((r) => r.autoplay);
    keepFocus(upNextList, () =>
      upNextList.replaceChildren(
        ...listed.flatMap((row, n) => [
          ...(n === firstAutoplay ? [autoplayHead(data)] : []),
          nextRow(row, n + held),
        ]),
        ...(rows.length > listed.length ? [el('li', { className: 'mini-next-more' }, `and ${rows.length - listed.length} more on the Music tab`)] : []),
      ),
    );
  }

  function nextRow(row, index) {
    const takeOut = () =>
      void attempt(async () => {
        const fresh = row.autoplay ? await removeAutoplaySong(row) : await removeSong(row, index, (back) => show(back, 0));
        show(fresh, 0);
      });
    return el(
      'li',
      { className: `song${row.autoplay ? ' autoplay' : ''}` },
      cover(row.cover, 32),
      el('div', { className: 'song-text' }, el('div', { className: 'song-title' }, row.title), el('div', { className: 'song-sub' }, row.artist)),
      el('button', { type: 'button', className: 'icon quiet', ariaLabel: `Remove ${row.title}`, title: 'Remove', onclick: takeOut }, icon('x')),
    );
  }

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
    const shown = inWindow || (!!playing && devicePref.on('musicPlayer') && !hidden && !secondWindow());
    node.hidden = !shown;
    if (node.isConnected && !inWindow) holdRoom(shown);
    if (!shown) return openAdding(false);
    if (inWindow) paintUpNext();
    // In the pop-out with nothing playing: the first song waiting, to play, or else a nudge towards +
    const first = playing ?? data.queue[0];
    const paused = !playing || data.phase === 'paused';
    const starting = data.phase === 'starting';
    paintCover(art, first?.cover ?? null, 40);
    title.textContent = first?.title ?? 'Nothing playing';
    sub.textContent = !first
      ? 'Add a song with +'
      : [first.artist, !playing ? 'Not playing' : starting ? 'Finding it…' : paused ? 'Paused' : data.channelName && `in ${data.channelName}`].filter(Boolean).join(' · ');
    if (!inWindow) song.ariaLabel = `${playing.title} by ${playing.artist}. Open Music`;
    playButton.hidden = !first;
    skipButton.hidden = !playing;
    if (!playing) {
      line.classList.remove('running');
      line.dataset.key = '';
    }
    if (!first) return;
    const cant = cantPlay(data, voice.channel());
    if (playButton.dataset.icon !== (paused ? 'play' : 'pause')) {
      playButton.dataset.icon = paused ? 'play' : 'pause';
      playButton.replaceChildren(icon(paused ? 'play' : 'pause'));
    }
    playButton.ariaLabel = paused ? 'Play' : 'Pause';
    playButton.title = !paused ? 'Pause, keeping the queue' : cant || (playing ? 'Play on from where it paused, in the channel picked in Play in' : 'Play the queue in the channel picked in Play in');
    playButton.disabled = starting || (!!cant && cant !== NOBODY_IN_VOICE);
    needsVoice(playButton, cant !== NOBODY_IN_VOICE);
    skipButton.disabled = false;
    if (playing) paintLine(playing, paused || starting);
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
  if (inWindow) return el('div', { className: 'popout-music' }, node, adding.node, el('div', { className: 'mini-volume' }, volumeSliders(['music'])), upNext);
  // Settings turns it on and off for this device, and it makes way for the pop-out window while that's open
  addEventListener('device-pref', (e) => e.detail === 'musicPlayer' && paint(), { signal: pageSignal() });
  addEventListener('second-window', paint, { signal: pageSignal() });
  return node;
}
