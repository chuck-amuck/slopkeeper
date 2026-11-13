import { announce, api, attempt, confirmButton, el, icon, keepFocus, needsVoice, NOBODY_IN_VOICE, notice, request, RequestError, session, state, toast, undoToast, volumeControl } from './lib.js';
import { follow, followWhenIdle, older } from './updates.js';
import { voiceBar } from './voice.js';

// A playlist adds this many songs, the first or at random
const FROM_A_LIST = 100;
const PLAYLISTS_SHOWN = 20;
const LINK = /^(https?:\/\/|spotify:)/i;
/** A Spotify album or playlist, which can be added shuffled */
const LIST_LINK = /^(https?:\/\/open\.spotify\.com\/(intl-[a-z]+\/)?(album|playlist)\/|spotify:(album|playlist):)/i;
// What an uploaded file can be. The bot checks again, and how long it is
const FILE_TYPES = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac'];
const MOST_FILE_MB = 60;

const SOURCES = { youtube: 'YouTube', soundcloud: 'SoundCloud', file: 'an upload' };
/** What follows the artist while a song plays: paused, being found, or where it's from and where it's playing */
const whereFrom = (data) =>
  data.phase === 'paused' ? ['Paused'] : data.phase === 'starting' ? ['Finding it…'] : [SOURCES[data.via] && `from ${SOURCES[data.via]}`, data.channelName && `in ${data.channelName}`].filter(Boolean);
// How far the arrow keys move along a song
const SEEK_STEP_MS = 10_000;
// How long after the last arrow key it jumps
const KEYS_SETTLE_MS = 400;
const time = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

export function cover(src, size) {
  return src ? el('img', { className: 'cover', src, alt: '', width: size, height: size, loading: 'lazy' }) : el('div', { className: 'cover none', style: `width:${size}px;height:${size}px` });
}

/** Shows a song's cover in `holder`, leaving it be while it's the same one, so it doesn't flash as the music changes */
export function paintCover(holder, src, size) {
  const shown = src ?? '';
  if (holder.firstChild && holder.dataset.cover === shown) return;
  holder.dataset.cover = shown;
  holder.replaceChildren(cover(src, size));
}

// The music's rules, for the Music tab and the music player alike

/** Pauses, or plays on where it paused, in the channel picked in Play in */
export function playOrPause(data, channel) {
  if (data.phase === 'playing') return request(api('/music/pause'), { method: 'POST' });
  return request(api('/music/play'), { method: 'POST', json: { channelId: channel.id } });
}

/** Why Play can't be pressed now, or '' if it can. `channel` is Play in's. Pause always can */
export function cantPlay(data, channel) {
  if (data.phase === 'playing') return '';
  if (data.problem) return data.problem;
  if (!channel) return NOBODY_IN_VOICE;
  if (!data.queue.length) return 'The queue is empty';
  return '';
}

/** Where the song playing has got to, in milliseconds, from what the bot said at `fetchedAt` */
export const positionOf = (data, fetchedAt) => Math.min(data.queue[0].durationMs, data.positionMs + (data.phase === 'playing' ? Date.now() - fetchedAt : 0));

/** Whether an answer is older than the music already shown, as a control's answer can be once an update's come in */
export const stale = (fresh, shown) => older(fresh.version, shown?.version);

/**
 * A progress bar that jumps within what's playing: click or drag it, and it jumps once let go, or use the arrow keys.
 * `o.duration()` and `o.position()` are in milliseconds, `o.can()` says whether it can jump now, and `o.jump(ms)` asks the bot to
 */
function seekBar(o) {
  const elapsed = el('span', { className: 'now-time' }, '0:00');
  const total = el('span', { className: 'now-time' }, '0:00');
  const bar = el('div', { className: 'now-bar' });
  // Where it's being dragged or keyed to, shown until the bot has jumped there
  let seekingTo = null;
  let keyTimer;
  const clamp = (ms) => Math.max(0, Math.min(ms, o.duration()));
  const pointedAt = (e) => {
    const box = track.getBoundingClientRect();
    return Math.round(clamp(((e.clientX - box.left) / box.width) * o.duration()));
  };
  async function jump(ms) {
    seekingTo = clamp(ms);
    paint();
    try {
      await o.jump(seekingTo);
    } finally {
      seekingTo = null;
      paint();
    }
  }
  const track = el(
    'div',
    {
      className: 'now-track',
      role: 'slider',
      tabIndex: 0,
      'aria-label': o.label,
      onpointerdown: (e) => {
        if (!o.can()) return;
        track.setPointerCapture(e.pointerId);
        seekingTo = pointedAt(e);
        paint();
      },
      onpointermove: (e) => {
        if (seekingTo === null) return;
        seekingTo = pointedAt(e);
        paint();
      },
      onpointerup: () => seekingTo !== null && void jump(seekingTo),
      onpointercancel: () => {
        seekingTo = null;
        paint();
      },
      onkeydown: (e) => {
        const step = { ArrowLeft: -SEEK_STEP_MS, ArrowDown: -SEEK_STEP_MS, ArrowRight: SEEK_STEP_MS, ArrowUp: SEEK_STEP_MS }[e.key];
        if (!step || !o.can()) return;
        e.preventDefault();
        // Presses in a row add up, and it jumps once they stop
        seekingTo = clamp((seekingTo ?? o.position()) + step);
        paint();
        clearTimeout(keyTimer);
        keyTimer = setTimeout(() => void jump(seekingTo), KEYS_SETTLE_MS);
      },
    },
    el('div', { className: 'now-rail' }, bar),
  );
  function paint() {
    const duration = o.duration();
    const at = seekingTo ?? Math.min(duration, o.position());
    elapsed.textContent = time(at);
    total.textContent = time(duration);
    bar.style.width = `${(100 * at) / Math.max(1, duration)}%`;
    track.classList.toggle('can-seek', o.can());
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.round(duration / 1000)));
    track.setAttribute('aria-valuenow', String(Math.round(at / 1000)));
    track.setAttribute('aria-valuetext', `${time(at)} of ${time(duration)}`);
  }
  return { node: el('div', { className: 'now-progress' }, elapsed, track, total), paint };
}

/** Music in voice, found on Spotify and played from YouTube: what's playing, search, and the queue everyone shares */
export function renderMusic(main) {
  const guildId = state.guildId;
  let data = null;
  let fetchedAt = 0;
  let dragging = null;
  let shownQueue = '';

  const problem = el('div', { className: 'music-problem', hidden: true });

  // ---------- now playing ----------
  const nowCover = el('div', { className: 'now-cover' });
  const nowTitle = el('div', { className: 'now-title' });
  const nowArtist = el('div', { className: 'now-artist' });
  const nowNote = el('div', { className: 'now-note', hidden: true });
  const songBar = seekBar({
    label: 'Song position',
    duration: () => data.queue[0].durationMs,
    position: () => positionNow(),
    can: () => data?.phase === 'playing' || data?.phase === 'paused',
    jump: async (ms) => {
      const fresh = await attempt(() => request(api('/music/seek'), { method: 'POST', json: { positionMs: ms } }));
      if (fresh?.queue) show(fresh);
    },
  });
  const progress = songBar.node;

  // The channel is Play in, in the header. The music's volume is the only one here
  const voice = voiceBar(() => {
    followMusic();
    paintControls();
  }, { sliders: false });
  const playButton = el('button', { className: 'primary', onclick: () => void act(() => (cantPlay(data, voice.channel()) ? null : playOrPause(data, voice.channel()))) }, 'Play');
  const skipButton = el('button', { onclick: () => void act(() => request(api('/music/skip'), { method: 'POST' })) }, 'Skip');
  const stopButton = confirmButton({ title: 'Stops the music and empties the queue' }, 'Stop and clear', 'Clear the queue?', async () => show(await request(api('/music/stop'), { method: 'POST' })));
  const volume = volumeControl({
    min: 0,
    max: 200,
    label: 'Music volume',
    onSave: (value) =>
      void attempt(async () => {
        await request(api('/settings/musicVolume'), { method: 'PUT', json: { value } });
        toast(`Music plays at ${value}% for everyone now.`);
      }),
  });
  const volumeLabel = el(
    'span',
    { className: 'voice-volume', title: 'How loud music plays for everyone in the server. It’s the Music volume in Settings.' },
    // Named as the Soundboard's Sounds and Speech and the Volume button's sliders are, now that it's on its own
    el('span', { className: 'voice-label' }, 'Music'),
    volume.node,
  );

  const now = el(
    'section',
    { className: 'card music now' },
    el('div', { className: 'now-main' }, nowCover, el('div', { className: 'now-text' }, nowTitle, nowArtist, nowNote), progress),
    el('div', { className: 'toolbar now-controls' }, playButton, skipButton, stopButton),
  );
  // How loud, at the top as on the Soundboard
  const voiceRow = el('div', { className: 'toolbar voice music-voice', hidden: true }, volumeLabel);
  // Kept up with a change from the Volume button or anywhere else, apart from while it's being dragged or typed in
  followWhenIdle('volumes', volumeLabel, () => [volumeLabel], (levels) => levels.music !== null && volume.set(levels.music));

  /** Runs a control, then shows what it changed */
  async function act(action) {
    for (const b of [playButton, skipButton]) b.disabled = true;
    try {
      const fresh = await attempt(action);
      if (fresh?.queue) show(fresh);
    } finally {
      paintControls();
    }
  }

  // ---------- search ----------
  const searchHelp = el('p', { className: 'hint search-help', id: 'music-search-help' });
  const query = el('input', { type: 'search', ariaLabel: 'Search Spotify', placeholder: 'Search or paste a link', 'aria-describedby': 'music-search-help', enterKeyHint: 'search', autocomplete: 'off', maxLength: 300, oninput: () => {
    paintLinkButtons();
    if (mode === 'playlists') showPlaylists();
  } });
  let mode = 'songs';
  // Loaded the first time they're shown, then filtered as you type
  let playlists = null;
  const modes = el('div', { className: 'views' });
  const MODES = [
    ['songs', 'Songs', 'Search or paste a link', `Searches Spotify. A Spotify, YouTube or SoundCloud link works too, or upload an audio file (up to ${MOST_FILE_MB} MB and 20 minutes).`],
    ['playlists', 'My playlists', 'Find a playlist or paste a link', 'Your saved playlists, or a link to any public one.'],
  ];
  function setMode(id) {
    mode = id;
    const [, label, hint, help] = MODES.find(([m]) => m === id);
    // A placeholder is cut short on a phone, so the whole of it is said below the box
    searchHelp.textContent = help;
    modes.replaceChildren(...MODES.map(([m, text]) => el('button', { type: 'button', ...(m === id && { 'aria-current': 'page' }), onclick: () => setMode(m) }, text)));
    query.placeholder = hint;
    query.ariaLabel = label === 'Songs' ? 'Search Spotify' : 'Find a playlist';
    query.value = '';
    paintLinkButtons();
    results.hidden = true;
    if (id === 'playlists') void loadPlaylists();
  }
  // ---------- a file uploaded, to add like a song ----------
  /** The upload under way, and the file uploaded, waiting for Play next or Add to end */
  let sending = null;
  let uploaded = null;
  const filePicker = el('input', {
    type: 'file',
    accept: `${FILE_TYPES.join(',')},audio/*`,
    hidden: true,
    onchange: () => {
      const [file] = filePicker.files;
      filePicker.value = '';
      if (file) void attempt(() => uploadFile(file));
    },
  });
  const uploadButton = el(
    'button',
    { type: 'button', className: 'with-icon music-upload', ariaLabel: 'Upload a file', title: `Upload an audio file to add, up to ${MOST_FILE_MB} MB and 20 minutes`, onclick: () => filePicker.click() },
    icon('upload'),
    el('span', { className: 'upload-word' }, 'Upload'),
  );
  const chipText = el('span', { className: 'upload-text' });
  const chipX = el('button', { type: 'button', className: 'icon quiet', onclick: () => dropUpload() }, icon('x'));
  const fileChip = el('div', { className: 'upload-chip', hidden: true, role: 'status' }, icon('note'), chipText, chipX);

  function paintChip(text, cancel) {
    chipText.textContent = text;
    chipX.ariaLabel = chipX.title = cancel;
  }

  /** Sends a file to the bot, saying how far it's got. fetch can't tell, so this is XMLHttpRequest */
  function send(xhr, file) {
    return new Promise((resolve, reject) => {
      xhr.open('POST', api(`/music/file?name=${encodeURIComponent(file.name)}`));
      xhr.setRequestHeader('x-slopkeeper', '1');
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && paintChip(`${file.name} · Uploading ${Math.round((100 * e.loaded) / e.total)}%`, 'Cancel the upload');
      xhr.upload.onload = () => {
        // The bot has it now, so × lets it finish and throws it away after
        xhr.sentAll = true;
        paintChip(`${file.name} · Checking it…`, 'Cancel the upload');
      };
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 401) {
          session.onExpired();
          return reject(new RequestError('Log in again.', 401));
        }
        if (xhr.status >= 400) return reject(new RequestError(body.error ?? `Couldn’t upload it (${xhr.status}).`));
        resolve(body.file);
      };
      xhr.onerror = () => reject(new RequestError('Couldn’t reach the web UI. Check your connection.'));
      // Cancelled with ×, which needs saying to nobody
      xhr.onabort = () => resolve(null);
      xhr.send(file);
    });
  }

  /** Uploads a file, then offers Play next and Add to end for it, as for a link. One at a time */
  async function uploadFile(file) {
    if (sending) throw new RequestError('One file is still uploading.');
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!file.name.includes('.') || !FILE_TYPES.includes(ext)) throw new RequestError(`That isn’t a file the bot can play. Use one of: ${FILE_TYPES.join(', ')}`);
    if (file.size > MOST_FILE_MB * 1024 * 1024) throw new RequestError(`That file is over ${MOST_FILE_MB} MB.`);
    // A file uploaded and not added yet makes way for this one
    if (uploaded) dropUpload();
    if (mode !== 'songs') setMode('songs');
    paintChip(`${file.name} · Uploading…`, 'Cancel the upload');
    const xhr = new XMLHttpRequest();
    sending = xhr;
    paintLinkButtons();
    let done = null;
    try {
      done = await send(xhr, file);
    } finally {
      if (sending === xhr) sending = null;
      // Cancelled once the bot had it, or left for another server or page: the bot would keep it an hour otherwise
      if (done && (xhr.dropped || guildId !== state.guildId || !main.isConnected)) {
        void request(`/api/guilds/${guildId}/music/file/${encodeURIComponent(done.id)}`, { method: 'DELETE' }).catch(() => {});
        done = null;
      }
      if (guildId === state.guildId && main.isConnected) {
        uploaded = done;
        if (done) paintChip(`${done.title}${done.artist === 'Uploaded file' ? '' : ` · ${done.artist}`} · ${time(done.durationMs)}`, `Remove ${done.title}`);
        paintLinkButtons();
        // On to adding it, unless you've gone on to something else meanwhile
        if (done && (!document.activeElement || document.activeElement === document.body || searchForm.contains(document.activeElement))) linkEnd.focus();
        if (done) announce(`${done.title} uploaded. Play next, or Add to end.`);
      }
    }
  }

  /** Cancels the upload under way, or throws away the file uploaded */
  function dropUpload() {
    if (sending?.sentAll) sending.dropped = true;
    else if (sending) sending.abort();
    else if (uploaded) {
      const { id } = uploaded;
      // Kept a while by the bot otherwise; gone already is fine
      void request(api(`/music/file/${encodeURIComponent(id)}`), { method: 'DELETE' }).catch(() => {});
    }
    sending = null;
    uploaded = null;
    paintLinkButtons();
    query.focus();
  }

  async function addUpload(next) {
    const { id } = uploaded;
    for (const b of [linkNext, linkEnd]) b.disabled = true;
    try {
      const fresh = await attempt(async () => {
        try {
          return await request(api('/music/queue'), { method: 'POST', json: { file: id, next, ...playingIn(next) } });
        } catch (err) {
          // Gone after an hour waiting: the box comes back for another go
          if (err.status === 404 && uploaded?.id === id) {
            uploaded = null;
            paintLinkButtons();
          }
          throw err;
        }
      });
      if (!fresh) return;
      toast(fresh.message);
      if (uploaded?.id === id) uploaded = null;
      show(fresh);
      paintLinkButtons();
      query.focus();
    } finally {
      for (const b of [linkNext, linkEnd]) b.disabled = false;
    }
  }

  const searchButton = el('button', { type: 'submit' }, 'Search');
  // A pasted link, or a file uploaded, is added rather than searched for, so it gets the same choice as a search result
  const fromLink = (next, shuffle = false) => {
    if (uploaded) return void addUpload(next);
    void addFrom({ query: query.value.trim(), shuffle }, next, true).then(paintLinkButtons);
  };
  const linkNext = el('button', { type: 'button', hidden: true, onclick: () => fromLink(true) }, 'Play next');
  const linkEnd = el('button', { type: 'submit', className: 'primary', hidden: true }, 'Add to end');
  const linkShuffle = el('button', { type: 'button', hidden: true, title: 'Adds songs from it at random, to the end', onclick: () => fromLink(false, true) }, 'Shuffle');
  function paintLinkButtons() {
    const text = query.value.trim();
    // A file takes the box's place while it uploads, and until it's added or thrown away
    const file = !!(sending || uploaded);
    const link = LINK.test(text) && !file;
    searchField.hidden = file;
    fileChip.hidden = !file;
    // Inside the box, and gone once anything's typed, as the placeholder is
    uploadButton.hidden = mode !== 'songs' || query.value !== '';
    searchField.classList.toggle('with-upload', !uploadButton.hidden);
    searchButton.hidden = file || link || mode === 'playlists';
    linkNext.hidden = linkEnd.hidden = !(link || uploaded);
    linkShuffle.hidden = file || !LIST_LINK.test(text);
  }
  const results = el('div', { className: 'music-results', hidden: true });
  const searchField = el('div', { className: 'search-field' }, query, uploadButton);
  const searchForm = el(
    'form',
    {
      className: 'toolbar',
      onsubmit: (e) => {
        e.preventDefault();
        // Enter adds a link or a file to the end, as Add to end does
        if (uploaded) return fromLink(false);
        if (sending) return;
        const text = query.value.trim();
        if (!text) return;
        if (LINK.test(text)) return fromLink(false);
        if (mode === 'playlists') return;
        searchButton.disabled = true;
        void attempt(async () => {
          const { tracks } = await request(api(`/music/search?q=${encodeURIComponent(text)}`));
          if (guildId !== state.guildId) return;
          showResults(tracks, text);
        }).finally(() => (searchButton.disabled = false));
      },
    },
    searchField,
    fileChip,
    filePicker,
    searchButton,
    linkNext,
    linkEnd,
    linkShuffle,
  );
  const searchNote = el('p', { className: 'card-note', hidden: true }, 'Search needs a Spotify app’s Client ID and Secret (SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET).');

  /** Play next on an empty queue starts it straight away, in Play in's channel */
  const playingIn = (next) => (next && voice.channel() ? { channelId: voice.channel().id } : {});

  async function addFrom(body, next, clear = false) {
    const fresh = await attempt(() => request(api('/music/queue'), { method: 'POST', json: { ...body, next, ...playingIn(next) } }));
    if (!fresh) return;
    toast(fresh.message ?? `Added ${body.track?.title ?? 'it'}${next ? ' to play next' : ''}.`);
    if (clear) query.value = '';
    show(fresh);
  }

  async function loadPlaylists() {
    if (!playlists) {
      results.hidden = false;
      results.replaceChildren(notice('loading', 'Loading your playlists…', { compact: true }));
      const fresh = await attempt(() => request(api('/music/playlists')));
      if (guildId !== state.guildId || mode !== 'playlists') return;
      if (!fresh) return void (results.hidden = true);
      if (fresh.problem) return results.replaceChildren(notice('error', fresh.problem, { compact: true }));
      playlists = fresh.playlists;
    }
    showPlaylists();
  }

  function showPlaylists() {
    if (!playlists) return;
    const typed = query.value.trim().toLowerCase();
    if (LINK.test(typed)) return void (results.hidden = true);
    const matching = playlists.filter((p) => p.name.toLowerCase().includes(typed));
    results.hidden = false;
    results.replaceChildren(
      ...matching.slice(0, PLAYLISTS_SHOWN).map((p) => {
        const buttons = [];
        const add = (label, next, shuffle) => {
          const button = el(
            'button',
            {
              onclick: async () => {
                // A playlist takes a moment to read, and twice would add it twice
                for (const b of buttons) b.disabled = true;
                await addFrom({ query: `spotify:playlist:${p.id}`, shuffle }, next);
                for (const b of buttons) b.disabled = false;
              },
              ariaLabel: `${label}: ${p.name}`,
            },
            label,
          );
          buttons.push(button);
          return button;
        };
        const long = p.songs > FROM_A_LIST;
        return el(
          'div',
          { className: 'song' },
          cover(p.cover, 40),
          el(
            'div',
            { className: 'song-text' },
            el('div', { className: 'song-title' }, p.name),
            el('div', { className: 'song-sub' }, long ? `${p.songs} songs · adds the first ${FROM_A_LIST}, or ${FROM_A_LIST} at random` : `${p.songs} song${p.songs === 1 ? '' : 's'}`),
          ),
          el('div', { className: 'song-actions' }, add('Play next', true, false), add('Add to end', false, false), long && add('Shuffle', false, true)),
        );
      }),
      ...(matching.length > PLAYLISTS_SHOWN ? [notice('more', `…and ${matching.length - PLAYLISTS_SHOWN} more. Type to narrow them down.`, { compact: true })] : []),
      ...(matching.length ? [] : [notice('empty', playlists.length ? `None of your playlists are called “${query.value.trim()}”.` : 'This Spotify account has no playlists of its own.', { compact: true })]),
    );
  }

  function showResults(tracks, text) {
    results.hidden = false;
    results.replaceChildren(
      ...(tracks.length
        ? tracks.map((t) =>
            el(
              'div',
              { className: 'song' },
              cover(t.cover, 40),
              el('div', { className: 'song-text' }, el('div', { className: 'song-title' }, t.title), el('div', { className: 'song-sub' }, `${t.artist} · ${t.album}`)),
              el('span', { className: 'song-time' }, time(t.durationMs)),
              // Named with the song, as a list of buttons all called Play next says nothing to a screen reader
              el(
                'div',
                { className: 'song-actions' },
                el('button', { ariaLabel: `Play next: ${t.title}`, onclick: () => void addFrom({ track: t }, true) }, 'Play next'),
                el('button', { ariaLabel: `Add to end: ${t.title}`, onclick: () => void addFrom({ track: t }, false) }, 'Add to end'),
              ),
            ),
          )
        : [notice('empty', `Nothing on Spotify matches “${text}”.`, { compact: true })]),
    );
    announce(tracks.length ? `${tracks.length} song${tracks.length === 1 ? '' : 's'} found.` : `Nothing on Spotify matches ${text}.`);
  }

  // A file dropped anywhere on the card uploads, as Upload does. Only files light it up, not text or links dragged over
  const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const searchCard = el(
    'section',
    {
      className: 'card music add-music',
      ondragover: (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        searchCard.classList.add('drop-over');
      },
      ondragleave: (e) => {
        if (!searchCard.contains(e.relatedTarget)) searchCard.classList.remove('drop-over');
      },
      ondrop: (e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        searchCard.classList.remove('drop-over');
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        if (files.length > 1) toast(`Only one file at a time, so that’s ${files[0].name}.`);
        void attempt(() => uploadFile(files[0]));
      },
    },
    el('h2', {}, 'Add music'),
    el('div', { className: 'card-body music-search' }, searchNote, modes, searchForm, searchHelp, results),
  );
  setMode('songs');

  // ---------- queue ----------
  const list = el('ol', { className: 'music-queue' });
  // Beside the heading, leaving the toolbar room for its switch and buttons on a phone
  const queueCount = el('span', { className: 'voice-label head-count' });
  const clearButton = confirmButton({}, 'Clear', 'Clear the queue?', async () => show(await request(api('/music/queue'), { method: 'DELETE' })));
  const shuffleButton = el('button', { className: 'with-icon', title: 'Put the songs waiting in a random order', onclick: () => void act(() => request(api('/music/queue/shuffle'), { method: 'POST' })) }, icon('shuffle'), 'Shuffle');
  // Autoplay is a setting for the whole server, saved as soon as it's switched. Updates wait until every switch is saved, and a
  // failed save only switches it back if it was the latest
  let savingAutoplay = 0;
  let autoplaySwitches = 0;
  const autoplayBox = el('input', {
    type: 'checkbox',
    onchange: (e) => {
      const on = e.target.checked;
      const mine = ++autoplaySwitches;
      savingAutoplay++;
      void attempt(async () => {
        await request(api('/settings/musicAutoplay'), { method: 'PUT', json: { value: on } });
        toast(on ? 'Autoplay is on: when the queue runs out, similar songs keep playing.' : 'Autoplay is off: the music stops when the queue runs out.');
        return true;
      })
        .then((saved) => {
          if (!saved && mine === autoplaySwitches) autoplayBox.checked = !on;
        })
        .finally(() => savingAutoplay--);
    },
  });
  // The words are a text node rather than a span, which a phone would hide
  const autoplaySwitch = el('label', { className: 'toggle autoplay', title: 'Keeps a few songs like the last one people queued waiting at the end, from YouTube. Songs people add always play first.' }, autoplayBox, 'Autoplay');
  const queueCard = el('section', { className: 'card music' }, el('div', { className: 'card-head' }, el('h2', {}, 'Up next', queueCount), el('div', { className: 'toolbar' }, autoplaySwitch, shuffleButton, clearButton)), list);

  /** The first song stays put while it's playing or paused, so the list starts after it */
  const held = () => (data && data.phase !== 'stopped' ? 1 : 0);

  const move = (row, to) => void act(() => request(api(`/music/queue/${row.id}/move`), { method: 'POST', json: { to } }));

  /** Takes a song out, with Undo putting it back where it was */
  const remove = (row, index) =>
    act(async () => {
      const fresh = await request(api(`/music/queue/${row.id}`), { method: 'DELETE' });
      undoToast(`Removed ${row.title}.`, async () => {
        const { uri, title, artist, album, cover, durationMs } = row;
        // A YouTube or SoundCloud song is added again from its link, and an upload from the file kept for this
        const json = uri.startsWith('spotify:') ? { track: { uri, title, artist, album, cover, durationMs } } : uri.startsWith('file:') ? { file: uri.slice(5) } : { query: uri };
        const added = await request(api('/music/queue'), { method: 'POST', json });
        // It goes on the end, so it's the newest row with that song
        const back = added.queue.findLast((r) => r.uri === uri);
        show(back && index < added.queue.length - 1 ? await request(api(`/music/queue/${back.id}/move`), { method: 'POST', json: { to: index } }) : added);
      });
      return fresh;
    });

  /** Keeps one of Autoplay's songs, as if it had been queued here */
  const keep = (row) =>
    void attempt(async () => {
      const fresh = await request(api(`/music/queue/${row.id}/keep`), { method: 'POST' });
      toast(fresh.message);
      show(fresh);
    });

  /** One of Autoplay's songs: it stays at the end, where it can be kept or taken out */
  function autoplayRow(row) {
    return el(
      'li',
      { className: 'song autoplay' },
      cover(row.cover, 40),
      el('div', { className: 'song-text' }, el('div', { className: 'song-title' }, row.title), el('div', { className: 'song-sub' }, row.artist)),
      el('span', { className: 'song-time' }, time(row.durationMs)),
      el(
        'div',
        { className: 'song-actions' },
        el('button', { className: 'icon', ariaLabel: `Add ${row.title} to the queue`, title: 'Add to the queue', onclick: () => keep(row) }, icon('plus')),
        // No Undo: put back, it would count as queued by a person. Autoplay finds another instead
        el('button', { className: 'icon', ariaLabel: `Remove ${row.title}`, title: 'Remove', onclick: () => void act(() => request(api(`/music/queue/${row.id}`), { method: 'DELETE' })) }, icon('x')),
      ),
    );
  }

  function queueRow(row, index) {
    const first = held();
    // People's songs stay ahead of Autoplay's
    const last = data.queue.findLastIndex((r) => !r.autoplay);
    const item = el(
      'li',
      {
        className: 'song',
        draggable: true,
        ondragstart: (e) => {
          dragging = row;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.title);
          item.classList.add('dragging');
        },
        ondragend: () => {
          dragging = null;
          item.classList.remove('dragging');
          for (const n of list.querySelectorAll('.drop-before, .drop-after')) n.classList.remove('drop-before', 'drop-after');
        },
        ondragover: (e) => {
          if (!dragging || dragging === row || dragging.autoplay) return;
          e.preventDefault();
          const after = e.offsetY > item.offsetHeight / 2;
          item.classList.toggle('drop-after', after);
          item.classList.toggle('drop-before', !after);
        },
        ondragleave: () => item.classList.remove('drop-before', 'drop-after'),
        ondrop: (e) => {
          e.preventDefault();
          if (!dragging || dragging === row) return;
          const from = data.queue.findIndex((r) => r.id === dragging.id);
          const at = index + (item.classList.contains('drop-after') ? 1 : 0);
          // Where it lands once it's out of its old place
          const to = from < at ? at - 1 : at;
          item.classList.remove('drop-before', 'drop-after');
          if (to !== from) move(dragging, to);
        },
      },
      el('span', { className: 'grip', ariaHidden: 'true', title: 'Drag to move' }, icon('grip')),
      el('span', { className: 'song-number' }, String(index - first + 1)),
      cover(row.cover, 40),
      el('div', { className: 'song-text' }, el('div', { className: 'song-title' }, row.title), el('div', { className: 'song-sub' }, `${row.artist} · added by ${row.addedBy}`)),
      el('span', { className: 'song-time' }, time(row.durationMs)),
      el(
        'div',
        { className: 'song-actions' },
        // Straight to the top, which on a phone beats pressing ↑ over and over
        el('button', { className: 'icon', ariaLabel: `Play ${row.title} next`, title: 'Play next', disabled: index <= first, onclick: () => move(row, first) }, icon('top')),
        el('button', { className: 'icon', ariaLabel: `Move ${row.title} up`, title: 'Move up', disabled: index <= first, onclick: () => move(row, index - 1) }, icon('up')),
        el('button', { className: 'icon', ariaLabel: `Move ${row.title} down`, title: 'Move down', disabled: index >= last, onclick: () => move(row, index + 1) }, icon('down')),
        el('button', { className: 'icon', ariaLabel: `Remove ${row.title}`, title: 'Remove', onclick: () => void remove(row, index) }, icon('x')),
      ),
    );
    return item;
  }

  function paintQueue() {
    const rows = data.queue.slice(held());
    const people = rows.filter((r) => !r.autoplay);
    const autoplay = rows.filter((r) => r.autoplay);
    // Rebuilding mid-drag would drop what's being dragged
    const key = JSON.stringify([held(), data.queue.map((r) => [r.id, r.autoplay]), data.autoplayLike]);
    if (dragging || key === shownQueue) return;
    shownQueue = key;
    queueCount.textContent = people.length ? `${people.length} song${people.length === 1 ? '' : 's'}` : '';
    clearButton.hidden = !rows.length;
    shuffleButton.hidden = people.length < 2;
    const at = (row) => data.queue.indexOf(row);
    keepFocus(list, () =>
      list.replaceChildren(
        ...(people.length ? people.map((row) => queueRow(row, at(row))) : [notice('empty', autoplay.length ? 'Nothing queued. Autoplay’s songs play next.' : 'Nothing queued. Search for a song above.', { compact: true, tag: 'li' })]),
        // Autoplay's songs follow, under a heading of their own, like Spotify's
        ...(autoplay.length
          ? [
              el('li', { className: 'autoplay-head' }, icon('infinity'), el('span', {}, data.autoplayLike ? ['Autoplay · songs like ', el('b', {}, data.autoplayLike)] : 'Autoplay')),
              ...autoplay.map((row) => autoplayRow(row)),
            ]
          : []),
      ),
    );
  }

  // ---------- painting ----------
  /**
   * Until someone picks a channel by hand, Play in goes to where the music is, so Resume carries on there, or with
   * nothing playing, to where the bot is
   */
  function followMusic() {
    if (data) voice.prefer((data.phase !== 'stopped' && data.channelId) || data.defaultChannelId);
  }

  function paintControls() {
    const playing = data?.phase === 'playing';
    const chosen = voice.channel();
    playButton.textContent = playing ? 'Pause' : data?.phase === 'paused' ? 'Resume' : 'Play';
    const cant = data ? cantPlay(data, chosen) : '';
    // Nobody in voice greys it, and a tap says so; anything else can't be pressed
    playButton.disabled = !data || (!!cant && cant !== NOBODY_IN_VOICE);
    needsVoice(playButton, cant !== NOBODY_IN_VOICE);
    playButton.title = !data ? '' : playing ? 'Pause, keeping the queue' : cant;
    skipButton.disabled = !data || data.phase === 'stopped';
    stopButton.disabled = !data || (data.phase === 'stopped' && !data.queue.length);
  }

  function positionNow() {
    return positionOf(data, fetchedAt);
  }

  function paintProgress() {
    if (!data) return;
    const song = data.phase !== 'stopped' ? data.queue[0] : null;
    progress.hidden = !song;
    if (!song) return;
    songBar.paint();
  }

  /** `age` is how long ago, in milliseconds, the bot said it, for where the song has got to */
  function show(fresh, age = 0) {
    if (guildId !== state.guildId || !main.isConnected || stale(fresh, data)) return;
    data = fresh;
    fetchedAt = Date.now() - age;
    problem.textContent = data.problem ?? '';
    problem.hidden = !data.problem;
    searchNote.hidden = data.searchReady;
    // Playlists only show with the Spotify account signed in
    modes.hidden = !data.playlistsReady;
    if (!data.playlistsReady && mode === 'playlists') setMode('songs');
    query.disabled = searchButton.disabled = !data.searchReady;
    if (voiceRow.hidden) {
      volume.set(data.volume);
      voiceRow.hidden = false;
    }
    if (!savingAutoplay) autoplayBox.checked = !!data.autoplay;

    const song = data.phase !== 'stopped' ? data.queue[0] : null;
    paintCover(nowCover, song?.cover, 96);
    nowTitle.textContent = song ? song.title : data.queue.length ? 'Not playing' : 'Nothing queued';
    nowArtist.textContent = song
      ? [song.artist, ...whereFrom(data)].join(' · ')
      : data.queue.length
        ? 'Pick a channel and press Play.'
        : 'Search for a song to start.';
    nowNote.textContent = data.note ?? '';
    nowNote.hidden = !data.note;
    followMusic();
    paintProgress();
    paintControls();
    paintQueue();
  }

  main.append(voice.node, problem, voiceRow, now, searchCard, queueCard);
  list.append(notice('loading', 'Loading the queue…', { compact: true, tag: 'li' }));
  // From the bot the moment it changes. Who's in voice comes through voiceBar
  follow('music', main, (fresh, at) => show(fresh, performance.now() - at));
  const ticker = setInterval(() => (main.isConnected ? paintProgress() : clearInterval(ticker)), 500);
}
