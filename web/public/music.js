import { api, attempt, confirmButton, el, RequestError, request, session, state, toast } from './lib.js';

const REFRESH_MS = 3000;
// A playlist adds this many songs, the first or at random
const FROM_A_LIST = 100;
const PLAYLISTS_SHOWN = 20;
const LINK = /^(https?:\/\/|spotify:)/i;
// What a file played once can be. The bot checks again, and how long it is
const FILE_TYPES = ['.mp3', '.ogg', '.wav', '.m4a', '.opus', '.webm', '.flac'];
const MOST_FILE_MB = 50;

const SOURCES = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };
/** What follows the artist while a song plays: paused, being found, or where it's from and where it's playing */
const whereFrom = (data) =>
  data.phase === 'paused' ? ['Paused'] : data.phase === 'starting' ? ['Finding it…'] : [SOURCES[data.via] && `from ${SOURCES[data.via]}`, data.channelName && `in ${data.channelName}`].filter(Boolean);
// How far the arrow keys move along a song
const SEEK_STEP_MS = 10_000;
// How long after the last arrow key it jumps
const KEYS_SETTLE_MS = 400;
const time = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

function cover(src, size) {
  return src ? el('img', { className: 'cover', src, alt: '', width: size, height: size, loading: 'lazy' }) : el('div', { className: 'cover none', style: `width:${size}px;height:${size}px` });
}

/** Music in voice, found on Spotify and played from YouTube: what's playing, search, and the queue everyone shares */
export function renderMusic(main) {
  const guildId = state.guildId;
  let data = null;
  let fetchedAt = 0;
  let channels = null;
  let chosen = null;
  let dragging = null;
  let shownQueue = '';

  const problem = el('div', { className: 'music-problem', hidden: true });

  // ---------- now playing ----------
  const nowCover = el('div', { className: 'now-cover' });
  const nowTitle = el('div', { className: 'now-title' });
  const nowArtist = el('div', { className: 'now-artist' });
  const nowNote = el('div', { className: 'now-note', hidden: true });
  const elapsed = el('span', { className: 'now-time' }, '0:00');
  const total = el('span', { className: 'now-time' }, '0:00');
  const bar = el('div', { className: 'now-bar' });
  // Dragging shows where it'll jump to, and jumps once let go
  let seekingTo = null;
  let keyTimer;
  const track = el(
    'div',
    {
      className: 'now-track',
      role: 'slider',
      tabIndex: 0,
      'aria-label': 'Song position',
      onpointerdown: (e) => {
        if (!canSeek()) return;
        track.setPointerCapture(e.pointerId);
        seekingTo = pointedAt(e);
        paintProgress();
      },
      onpointermove: (e) => {
        if (seekingTo === null) return;
        seekingTo = pointedAt(e);
        paintProgress();
      },
      onpointerup: () => seekingTo !== null && void seek(seekingTo),
      onpointercancel: () => {
        seekingTo = null;
        paintProgress();
      },
      onkeydown: (e) => {
        const step = { ArrowLeft: -SEEK_STEP_MS, ArrowDown: -SEEK_STEP_MS, ArrowRight: SEEK_STEP_MS, ArrowUp: SEEK_STEP_MS }[e.key];
        if (!step || !canSeek()) return;
        e.preventDefault();
        // Presses in a row add up, and it jumps once they stop
        seekingTo = Math.max(0, Math.min((seekingTo ?? positionNow()) + step, data.queue[0].durationMs));
        paintProgress();
        clearTimeout(keyTimer);
        keyTimer = setTimeout(() => void seek(seekingTo), KEYS_SETTLE_MS);
      },
    },
    el('div', { className: 'now-rail' }, bar),
  );
  const progress = el('div', { className: 'now-progress' }, elapsed, track, total);
  const canSeek = () => data?.phase === 'playing' || data?.phase === 'paused';
  const pointedAt = (e) => {
    const box = track.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * data.queue[0].durationMs);
  };
  async function seek(ms) {
    seekingTo = Math.max(0, Math.min(ms, data.queue[0].durationMs));
    paintProgress();
    try {
      const fresh = await attempt(() => request(api('/music/seek'), { method: 'POST', json: { positionMs: seekingTo } }));
      if (fresh?.queue) show(fresh);
    } finally {
      seekingTo = null;
      paintProgress();
    }
  }

  const picker = el('select', { ariaLabel: 'Voice channel', onchange: (e) => (chosen = e.target.value) });
  const playButton = el('button', { className: 'primary', onclick: () => void act(playOrPause) }, 'Play');
  const skipButton = el('button', { onclick: () => void act(() => request(api('/music/skip'), { method: 'POST' })) }, 'Skip');
  const stopButton = confirmButton({}, 'Stop', 'Clear the queue?', async () => show(await request(api('/music/stop'), { method: 'POST' })));
  const volume = el('input', {
    type: 'range',
    min: 0,
    max: 200,
    step: 5,
    ariaLabel: 'Music volume',
    hidden: true,
    oninput: () => (volume.title = `Music at ${volume.value}%`),
    onchange: () => void attempt(() => request(api('/settings/musicVolume'), { method: 'PUT', json: { value: Number(volume.value) } })),
  });
  const account = el('div', { className: 'card-note music-account', hidden: true });

  const now = el(
    'section',
    { className: 'card music now' },
    el('div', { className: 'now-main' }, nowCover, el('div', { className: 'now-text' }, nowTitle, nowArtist, nowNote), progress),
    el(
      'div',
      { className: 'toolbar now-controls' },
      el('span', { className: 'voice-label' }, 'Play in'),
      picker,
      playButton,
      skipButton,
      stopButton,
      el('label', { className: 'voice-volume' }, el('span', { className: 'voice-label' }, 'Volume'), volume),
    ),
    account,
  );

  async function playOrPause() {
    if (data?.phase === 'playing') return request(api('/music/pause'), { method: 'POST' });
    if (!chosen) return null;
    return request(api('/music/play'), { method: 'POST', json: { channelId: chosen } });
  }

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
  const query = el('input', { type: 'search', ariaLabel: 'Search Spotify', placeholder: 'Search Spotify, or paste a Spotify, YouTube or SoundCloud link', autocomplete: 'off', maxLength: 300, oninput: () => mode === 'playlists' && showPlaylists() });
  let mode = 'songs';
  // Loaded the first time they're shown, then filtered as you type
  let playlists = null;
  const modes = el('div', { className: 'views' });
  const MODES = [
    ['songs', 'Songs', 'Search Spotify, or paste a Spotify, YouTube or SoundCloud link'],
    ['playlists', 'My playlists', 'Find one of your playlists, or paste a link to it'],
  ];
  function setMode(id) {
    mode = id;
    const [, label, hint] = MODES.find(([m]) => m === id);
    modes.replaceChildren(...MODES.map(([m, text]) => el('button', { type: 'button', ...(m === id && { 'aria-current': 'page' }), onclick: () => setMode(m) }, text)));
    query.placeholder = hint;
    query.ariaLabel = label === 'Songs' ? 'Search Spotify' : 'Find a playlist';
    query.value = '';
    searchButton.hidden = id === 'playlists';
    results.hidden = true;
    if (id === 'playlists') void loadPlaylists();
  }
  const searchButton = el('button', { type: 'submit' }, 'Search');
  const results = el('div', { className: 'music-results', hidden: true });
  const searchForm = el(
    'form',
    {
      className: 'toolbar',
      onsubmit: (e) => {
        e.preventDefault();
        const text = query.value.trim();
        if (!text) return;
        if (LINK.test(text)) return void addFrom({ query: text }, false, true);
        if (mode === 'playlists') return;
        searchButton.disabled = true;
        void attempt(async () => {
          const { tracks } = await request(api(`/music/search?q=${encodeURIComponent(text)}`));
          if (guildId !== state.guildId) return;
          showResults(tracks, text);
        }).finally(() => (searchButton.disabled = false));
      },
    },
    query,
    searchButton,
  );
  const searchNote = el('p', { className: 'card-note', hidden: true }, 'Search needs a Spotify app’s Client ID and Secret (SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET).');

  async function addFrom(body, next, clear = false) {
    const fresh = await attempt(() => request(api('/music/queue'), { method: 'POST', json: { ...body, next } }));
    if (!fresh) return;
    toast(fresh.message ?? `Added ${body.track?.title ?? 'it'}${next ? ' to play next' : ''}.`);
    if (clear) query.value = '';
    show(fresh);
  }

  async function loadPlaylists() {
    if (!playlists) {
      results.hidden = false;
      results.replaceChildren(el('div', { className: 'empty-note' }, 'Loading your playlists…'));
      const fresh = await attempt(() => request(api('/music/playlists')));
      if (guildId !== state.guildId || mode !== 'playlists') return;
      if (!fresh) return void (results.hidden = true);
      if (fresh.problem) return results.replaceChildren(el('div', { className: 'empty-note' }, fresh.problem));
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
          el('div', { className: 'song-actions' }, add('Play next', true, false), add('Add', false, false), long && add('Shuffle', false, true)),
        );
      }),
      ...(matching.length > PLAYLISTS_SHOWN ? [el('div', { className: 'empty-note' }, `…and ${matching.length - PLAYLISTS_SHOWN} more. Type to narrow them down.`)] : []),
      ...(matching.length ? [] : [el('div', { className: 'empty-note' }, playlists.length ? `None of your playlists are called “${query.value.trim()}”.` : 'This Spotify account has no playlists of its own.')]),
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
              el('div', { className: 'song-actions' }, el('button', { onclick: () => void addFrom({ track: t }, true) }, 'Play next'), el('button', { onclick: () => void addFrom({ track: t }, false) }, 'Add')),
            ),
          )
        : [el('div', { className: 'empty-note' }, `Nothing on Spotify matches “${text}”.`)]),
    );
  }

  const searchCard = el('section', { className: 'card music' }, el('h2', {}, 'Add music'), el('div', { className: 'card-body music-search' }, searchNote, modes, searchForm, results));
  setMode('songs');

  // ---------- a file, played once ----------
  let uploading = false;
  const filePicker = el('input', {
    type: 'file',
    accept: `${FILE_TYPES.join(',')},audio/*`,
    hidden: true,
    onchange: () => {
      const [file] = filePicker.files;
      filePicker.value = '';
      if (file) void attempt(() => playFile(file));
    },
  });
  const choose = () => !uploading && filePicker.click();
  const fileZone = el(
    'div',
    {
      className: 'dropzone',
      tabIndex: 0,
      role: 'button',
      onclick: choose,
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose();
        }
      },
      ondragover: (e) => {
        e.preventDefault();
        fileZone.classList.add('over');
      },
      ondragleave: () => fileZone.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        fileZone.classList.remove('over');
        const [file] = e.dataTransfer.files;
        if (file && !uploading) void attempt(() => playFile(file));
      },
    },
  );
  const fileName = el('div', { className: 'song-title' });
  const fileTime = el('div', { className: 'song-sub' });
  const fileStop = el('button', { onclick: () => void act(() => request(api('/music/file/stop'), { method: 'POST' })) }, 'Stop');
  const fileNow = el('div', { className: 'song file-now', hidden: true }, el('div', { className: 'song-text' }, fileName, fileTime), el('div', { className: 'song-actions' }, fileStop));
  const fileCard = el('section', { className: 'card music' }, el('h2', {}, 'Play a file'), el('div', { className: 'card-body music-file' }, fileZone, filePicker, fileNow));

  function paintFileZone(text) {
    fileZone.textContent = text ?? `Drop an audio file here, or click to choose. It plays once in the channel above and isn’t kept. Up to ${MOST_FILE_MB} MB.`;
    fileZone.classList.toggle('busy', uploading);
  }
  paintFileZone();

  /** Sends a file to play, showing how far the upload has got. fetch can't tell, so this is XMLHttpRequest */
  function upload(file, channelId) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', api(`/music/file?name=${encodeURIComponent(file.name)}&channelId=${encodeURIComponent(channelId)}`));
      xhr.setRequestHeader('x-slopkeeper', '1');
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && paintFileZone(`Sending ${file.name}: ${Math.round((100 * e.loaded) / e.total)}%`);
      xhr.upload.onload = () => paintFileZone(`Starting ${file.name}…`);
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 401) {
          session.onExpired();
          return reject(new RequestError('Log in again.'));
        }
        if (xhr.status >= 400) return reject(new RequestError(body.error ?? `Couldn’t play it (${xhr.status}).`));
        resolve(body);
      };
      xhr.onerror = () => reject(new RequestError('Couldn’t reach the web UI. Check your connection.'));
      xhr.send(file);
    });
  }

  async function playFile(file) {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!file.name.includes('.') || !FILE_TYPES.includes(ext)) throw new RequestError(`That isn’t a file the bot can play. Use one of: ${FILE_TYPES.join(', ')}`);
    if (file.size > MOST_FILE_MB * 1024 * 1024) throw new RequestError(`That file is over ${MOST_FILE_MB} MB.`);
    if (!chosen) throw new RequestError('Nobody’s in voice, so there’s nowhere to play it.');
    uploading = true;
    paintFileZone(`Sending ${file.name}…`);
    try {
      show(await upload(file, chosen));
      toast(`Playing ${data.file?.name ?? file.name}.`);
    } finally {
      uploading = false;
      paintFileZone();
    }
  }

  function paintFile() {
    const file = data?.file;
    fileNow.hidden = !file;
    if (!file) return;
    fileName.textContent = `Playing ${file.name}`;
    const at = Math.min(file.durationMs, file.positionMs + Date.now() - fetchedAt);
    fileTime.textContent = `${time(at)} of ${time(file.durationMs)}`;
  }

  // ---------- queue ----------
  const list = el('ol', { className: 'music-queue' });
  const queueCount = el('span', { className: 'voice-label' });
  const clearButton = confirmButton({}, 'Clear', 'Clear the queue?', async () => show(await request(api('/music/queue'), { method: 'DELETE' })));
  const queueCard = el('section', { className: 'card music' }, el('div', { className: 'card-head' }, el('h2', {}, 'Up next'), el('div', { className: 'toolbar' }, queueCount, clearButton)), list);

  /** The first song stays put while it's playing or paused, so the list starts after it */
  const held = () => (data && data.phase !== 'stopped' ? 1 : 0);

  const move = (row, to) => void act(() => request(api(`/music/queue/${row.id}/move`), { method: 'POST', json: { to } }));

  function queueRow(row, index) {
    const first = held();
    const last = data.queue.length - 1;
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
          if (!dragging || dragging === row) return;
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
      el('span', { className: 'grip', ariaHidden: 'true', title: 'Drag to move' }, '⋮⋮'),
      el('span', { className: 'song-number' }, String(index - first + 1)),
      cover(row.cover, 40),
      el('div', { className: 'song-text' }, el('div', { className: 'song-title' }, row.title), el('div', { className: 'song-sub' }, `${row.artist} · added by ${row.addedBy}`)),
      el('span', { className: 'song-time' }, time(row.durationMs)),
      el(
        'div',
        { className: 'song-actions' },
        el('button', { className: 'icon', ariaLabel: `Move ${row.title} up`, title: 'Move up', disabled: index <= first, onclick: () => move(row, index - 1) }, '↑'),
        el('button', { className: 'icon', ariaLabel: `Move ${row.title} down`, title: 'Move down', disabled: index >= last, onclick: () => move(row, index + 1) }, '↓'),
        el('button', { className: 'icon', ariaLabel: `Remove ${row.title}`, title: 'Remove', onclick: () => void act(() => request(api(`/music/queue/${row.id}`), { method: 'DELETE' })) }, '×'),
      ),
    );
    return item;
  }

  function paintQueue() {
    const rows = data.queue.slice(held());
    // Rebuilding mid-drag would drop what's being dragged
    const key = JSON.stringify([held(), data.queue.map((r) => r.id)]);
    if (dragging || key === shownQueue) return;
    shownQueue = key;
    queueCount.textContent = rows.length ? `${rows.length} song${rows.length === 1 ? '' : 's'}` : '';
    clearButton.hidden = !rows.length;
    list.replaceChildren(...(rows.length ? rows.map((row, n) => queueRow(row, n + held())) : [el('li', { className: 'empty-note' }, 'Nothing queued. Search for a song above.')]));
  }

  // ---------- painting ----------
  function paintControls() {
    const playing = data?.phase === 'playing';
    playButton.textContent = playing ? 'Pause' : data?.phase === 'paused' ? 'Resume' : 'Play';
    playButton.disabled = !data || (!playing && (!!data.problem || !data.queue.length || !chosen));
    playButton.title = !data ? '' : playing ? 'Pause, keeping the queue' : !chosen ? 'Nobody’s in voice' : !data.queue.length ? 'The queue is empty' : '';
    skipButton.disabled = !data || data.phase === 'stopped';
    stopButton.disabled = !data || (data.phase === 'stopped' && !data.queue.length);
  }

  function positionNow() {
    const song = data.queue[0];
    return Math.min(song.durationMs, data.positionMs + (data.phase === 'playing' ? Date.now() - fetchedAt : 0));
  }

  function paintProgress() {
    if (!data) return;
    paintFile();
    const song = data.phase !== 'stopped' ? data.queue[0] : null;
    progress.hidden = !song;
    if (!song) return;
    const at = seekingTo ?? positionNow();
    elapsed.textContent = time(at);
    total.textContent = time(song.durationMs);
    bar.style.width = `${(100 * at) / Math.max(1, song.durationMs)}%`;
    track.classList.toggle('can-seek', canSeek());
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(Math.round(song.durationMs / 1000)));
    track.setAttribute('aria-valuenow', String(Math.round(at / 1000)));
    track.setAttribute('aria-valuetext', `${time(at)} of ${time(song.durationMs)}`);
  }

  function show(fresh) {
    if (guildId !== state.guildId || !main.isConnected) return;
    data = fresh;
    fetchedAt = Date.now();
    problem.textContent = data.problem ?? '';
    problem.hidden = !data.problem;
    searchNote.hidden = data.searchReady;
    // Playlists only show with the Spotify account signed in
    modes.hidden = !data.playlistsReady;
    if (!data.playlistsReady && mode === 'playlists') setMode('songs');
    query.disabled = searchButton.disabled = !data.searchReady;
    if (volume.hidden) {
      volume.value = data.volume;
      volume.title = `Music at ${data.volume}%`;
      volume.hidden = false;
    }
    account.textContent = data.account ? `Songs YouTube doesn’t have play through Spotify, as ${data.account}. While one does, that account’s music stops everywhere else.` : '';
    account.hidden = !data.account;

    const song = data.phase !== 'stopped' ? data.queue[0] : null;
    nowCover.replaceChildren(cover(song?.cover, 96));
    nowTitle.textContent = song ? song.title : data.queue.length ? 'Not playing' : 'Nothing queued';
    nowArtist.textContent = song
      ? [song.artist, ...whereFrom(data)].join(' · ')
      : data.queue.length
        ? 'Pick a channel and press Play.'
        : 'Search for a song to start.';
    nowNote.textContent = data.note ?? '';
    nowNote.hidden = !data.note;
    if (data.channelId && data.phase !== 'stopped' && channels?.some((c) => c.id === data.channelId)) {
      chosen = data.channelId;
      picker.value = chosen;
    }
    paintProgress();
    paintControls();
    paintQueue();
  }

  async function loadChannels() {
    const fresh = (await request(api('/voice'))).channels;
    if (guildId !== state.guildId || !main.isConnected) return;
    if (JSON.stringify(fresh) === JSON.stringify(channels)) return;
    channels = fresh;
    if (!channels.some((c) => c.id === chosen)) chosen = [data?.channelId, data?.defaultChannelId].find((id) => channels.some((c) => c.id === id)) ?? channels[0]?.id ?? null;
    picker.disabled = !channels.length;
    picker.replaceChildren(
      ...(channels.length ? channels.map((c) => el('option', { value: c.id, selected: c.id === chosen }, `${c.name} · ${c.people.join(', ')}`)) : [el('option', {}, 'Nobody’s in voice')]),
    );
    paintControls();
  }

  const refresh = async () => show(await request(api('/music')));

  main.append(problem, now, searchCard, fileCard, queueCard);
  list.append(el('li', { className: 'empty-note' }, 'Loading the queue…'));
  void attempt(async () => {
    await refresh();
    await loadChannels();
  });
  const timer = setInterval(() => {
    if (!main.isConnected) return clearInterval(timer);
    void refresh().catch(() => {});
    void loadChannels().catch(() => {});
  }, REFRESH_MS);
  const ticker = setInterval(() => (main.isConnected ? paintProgress() : clearInterval(ticker)), 500);
}
