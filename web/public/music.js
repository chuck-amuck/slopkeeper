import { api, attempt, confirmButton, el, request, state, toast } from './lib.js';

const REFRESH_MS = 3000;
// A playlist adds this many songs, the first or at random
const FROM_A_LIST = 100;
const PLAYLISTS_SHOWN = 20;
const LINK = /^(https?:\/\/|spotify:)/i;

const time = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

function cover(src, size) {
  return src ? el('img', { className: 'cover', src, alt: '', width: size, height: size, loading: 'lazy' }) : el('div', { className: 'cover none', style: `width:${size}px;height:${size}px` });
}

/** Spotify in voice: what's playing, search, and the queue everyone shares */
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
  const progress = el('div', { className: 'now-progress' }, elapsed, el('div', { className: 'now-track' }, bar), total);

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
  const query = el('input', { type: 'search', ariaLabel: 'Search Spotify', placeholder: 'Search Spotify, or paste a song or album link', autocomplete: 'off', maxLength: 300, oninput: () => mode === 'playlists' && showPlaylists() });
  let mode = 'songs';
  // Loaded the first time they're shown, then filtered as you type
  let playlists = null;
  const modes = el('div', { className: 'views' });
  const MODES = [
    ['songs', 'Songs', 'Search Spotify, or paste a song or album link'],
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
    playButton.disabled = !data || (!playing && (!!data.problem || !data.queue.length || !chosen || data.elsewhere));
    playButton.title = !data ? '' : playing ? 'Pause, keeping the queue' : data.elsewhere ? 'Music is playing in another server' : !chosen ? 'Nobody’s in voice' : !data.queue.length ? 'The queue is empty' : '';
    skipButton.disabled = !data || data.phase === 'stopped';
    stopButton.disabled = !data || (data.phase === 'stopped' && !data.queue.length);
  }

  function paintProgress() {
    if (!data) return;
    const song = data.phase !== 'stopped' ? data.queue[0] : null;
    progress.hidden = !song;
    if (!song) return;
    const at = Math.min(song.durationMs, data.positionMs + (data.phase === 'playing' ? Date.now() - fetchedAt : 0));
    elapsed.textContent = time(at);
    total.textContent = time(song.durationMs);
    bar.style.width = `${(100 * at) / Math.max(1, song.durationMs)}%`;
  }

  function show(fresh) {
    if (guildId !== state.guildId || !main.isConnected) return;
    data = fresh;
    fetchedAt = Date.now();
    problem.textContent = data.problem ?? '';
    problem.hidden = !data.problem;
    searchNote.hidden = data.searchReady;
    query.disabled = searchButton.disabled = !data.searchReady;
    if (volume.hidden) {
      volume.value = data.volume;
      volume.title = `Music at ${data.volume}%`;
      volume.hidden = false;
    }
    account.textContent = data.account ? `Spotify account: ${data.account}. While the bot plays, this account’s music stops everywhere else.` : '';
    account.hidden = !data.account;

    const song = data.phase !== 'stopped' ? data.queue[0] : null;
    nowCover.replaceChildren(cover(song?.cover, 96));
    nowTitle.textContent = song ? song.title : data.queue.length ? 'Not playing' : 'Nothing queued';
    nowArtist.textContent = song
      ? `${song.artist}${data.phase === 'paused' ? ' · Paused' : data.channelName ? ` · in ${data.channelName}` : ''}`
      : data.elsewhere
        ? 'Music is playing in another server.'
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

  main.append(problem, now, searchCard, queueCard);
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
