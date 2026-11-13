import { announce, api, attempt, el, icon, notice, request, state } from './lib.js';
import { addToQueue, cover, LINK, LIST_LINK, time } from './music.js';

/**
 * A small box for adding a song from the music player, on any page and in the pop-out: a Spotify search or a pasted
 * link, each with Play next and Add to end, and Shuffle for an album or playlist link. Play next with nothing queued
 * plays it at once, in `channel()`, the channel picked in Play in. Uploads and the account's own playlists stay on the
 * Music tab. `added` hears the bot's answer
 */
export function addSongBox({ channel, added }) {
  const guildId = state.guildId;
  const query = el('input', {
    type: 'search',
    ariaLabel: 'Search Spotify, or paste a link',
    placeholder: 'Search or paste a link',
    enterKeyHint: 'search',
    autocomplete: 'off',
    maxLength: 300,
    oninput: paintButtons,
  });
  const searchButton = el('button', { type: 'submit' }, 'Search');
  // A pasted link is added rather than searched for, so it gets the same choice as a search result
  const linkNext = el('button', { type: 'button', hidden: true, onclick: () => void add({ query: query.value.trim() }, true, true) }, 'Play next');
  const linkEnd = el('button', { type: 'submit', className: 'primary', hidden: true }, 'Add to end');
  const linkShuffle = el('button', { type: 'button', hidden: true, title: 'Adds songs from it at random, to the end', onclick: () => void add({ query: query.value.trim(), shuffle: true }, false, true) }, 'Shuffle');
  const results = el('div', { className: 'music-results mini-add-results', hidden: true });

  // Each search counts, so an answer to an older one, or to one since cleared, is left out
  let searches = 0;
  function paintButtons() {
    const text = query.value.trim();
    const link = LINK.test(text);
    searchButton.hidden = link;
    linkNext.hidden = linkEnd.hidden = !link;
    linkShuffle.hidden = !LIST_LINK.test(text);
    if (!text || link) {
      searches++;
      results.hidden = true;
    }
  }

  const form = el(
    'form',
    {
      className: 'toolbar mini-add-form',
      onsubmit: (e) => {
        e.preventDefault();
        const text = query.value.trim();
        if (!text) return;
        // Enter adds a link to the end, as Add to end does
        if (LINK.test(text)) return void add({ query: text }, false, true);
        const mine = ++searches;
        searchButton.disabled = true;
        void attempt(async () => {
          const { tracks } = await request(api(`/music/search?q=${encodeURIComponent(text)}`));
          if (mine === searches && guildId === state.guildId && node.isConnected) show(tracks, text);
        }).finally(() => (searchButton.disabled = false));
      },
    },
    el('div', { className: 'search-field' }, query),
    searchButton,
    linkNext,
    linkEnd,
    linkShuffle,
  );

  // One at a time, so a double press doesn't add a song twice
  let adding = false;
  async function add(body, next, clear = false) {
    if (adding) return;
    adding = true;
    node.classList.add('busy');
    try {
      const fresh = await addToQueue(body, next, channel());
      if (!fresh) return;
      if (clear) {
        query.value = '';
        paintButtons();
      }
      added(fresh);
    } finally {
      adding = false;
      node.classList.remove('busy');
    }
  }

  function show(tracks, text) {
    results.hidden = false;
    results.replaceChildren(
      ...(tracks.length
        ? tracks.map((t) =>
            el(
              'div',
              { className: 'song' },
              cover(t.cover, 36),
              el('div', { className: 'song-text' }, el('div', { className: 'song-title' }, t.title), el('div', { className: 'song-sub' }, `${t.artist} · ${time(t.durationMs)}`)),
              // Named with the song, as a list of buttons all called Play next says nothing to a screen reader
              el(
                'div',
                { className: 'song-actions' },
                el('button', { type: 'button', className: 'icon', ariaLabel: `Play next: ${t.title}`, title: 'Play next', onclick: () => void add({ track: t }, true) }, icon('top')),
                el('button', { type: 'button', className: 'icon', ariaLabel: `Add to end: ${t.title}`, title: 'Add to end', onclick: () => void add({ track: t }, false) }, icon('plus')),
              ),
            ),
          )
        : [notice('empty', `Nothing on Spotify matches “${text}”.`, { compact: true })]),
    );
    announce(tracks.length ? `${tracks.length} song${tracks.length === 1 ? '' : 's'} found.` : `Nothing on Spotify matches ${text}.`);
  }

  const node = el('div', { className: 'mini-add', role: 'group', ariaLabel: 'Add a song', hidden: true }, form, results);
  return {
    node,
    get open() {
      return !node.hidden;
    },
    show(on) {
      node.hidden = !on;
      if (on) query.focus();
    },
  };
}
