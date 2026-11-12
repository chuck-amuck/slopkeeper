import { ago, api, attempt, el, formProblem, notice, openDialog, request, RequestError, state, toast, undoToast } from './lib.js';
import { achievementsView } from './achievements.js';
import { duration } from './stats.js';

const SHOWN = 100;
const BY_HAND = 'people';

const DECK_PLAYABLE = 2;
const DECK_VERIFIED = 3;
const DECK_NAMES = { [DECK_PLAYABLE]: 'Playable on Deck', [DECK_VERIFIED]: 'Verified on Deck' };

const SORTS = [
  ['played', 'Most played', (a, b) => b.playedMs - a.playedMs || b.steamMinutes - a.steamMinutes],
  ['hot', 'Hot right now', (a, b) => b.recentMinutes - a.recentMinutes || b.playedMs - a.playedMs],
  ['oldest', 'Longest since played', (a, b) => (a.last ?? 0) - (b.last ?? 0)],
  ['name', 'Name', (a, b) => a.name.localeCompare(b.name)],
];

const steamTime = (minutes) => duration(minutes * 60_000);

function facts(game) {
  const parts = [game.playedMs ? `${duration(game.playedMs)} here` : 'Not played here yet'];
  if (game.steamMinutes) parts.push(`${steamTime(game.steamMinutes)} on Steam`);
  if (game.recentMinutes) parts.push(`${steamTime(game.recentMinutes)} in the last two weeks`);
  if (game.last) parts.push(`last played ${ago(game.last)}`);
  return parts.join(' · ');
}

function kinds(game) {
  return [game.coop && 'Co-op', game.pvp && 'PvP', DECK_NAMES[game.deck], game.borrowed.length > 0 && `Family sharing: ${game.borrowed.join(', ')}`].filter(Boolean).join(' · ');
}

const playerRow = (p) =>
  el('tr', {}, el('td', {}, p.name), el('td', {}, p.playedMs ? duration(p.playedMs) : '—'), el('td', {}, p.steamMinutes === null ? '—' : steamTime(p.steamMinutes)), el('td', {}, p.recentMinutes ? steamTime(p.recentMinutes) : '—'), el('td', {}, p.last ? ago(p.last) : '—'));

/** Up to this many games go on a vote, as in the bot */
const VOTE_OPTIONS = 10;

/** `games` is what the filters leave, or null when nothing is filtered and the bot can choose from everything */
function voteDialog(main, options, voice, games) {
  const channel = el('select', { ariaLabel: 'Post it in' }, options.channels.map((c) => el('option', { value: c.id, selected: c.id === options.announceChannel }, `#${c.name}`)));
  const minutes = el('input', { type: 'number', min: 1, max: 10, step: 1, required: true, value: 1, ariaLabel: 'Minutes' });
  const problem = formProblem();
  const submit = el('button', { className: 'primary', type: 'submit' }, 'Start vote');
  const node = openDialog(main, {
    title: 'Start a vote',
    body: [
      el('p', {}, games ? `Everyone in ${voice.name} votes in Discord, on ${games.length > VOTE_OPTIONS ? `${VOTE_OPTIONS} of ` : ''}the ${games.length} games shown.` : `Everyone in ${voice.name} votes in Discord, on the games they all own.`),
      el('label', { className: 'form-row' }, el('span', {}, 'Post it in'), channel),
      el('label', { className: 'form-row' }, el('span', {}, 'Minutes'), minutes),
      problem,
    ],
    actions: [submit],
    close: 'Cancel',
    onsubmit: (e) => {
      e.preventDefault();
      submit.disabled = true;
      problem.hidden = true;
      void attempt(async () => {
        try {
          await request(api('/votes'), { method: 'POST', json: { voiceChannelId: voice.id, channelId: channel.value, minutes: Number(minutes.value), games: games ?? undefined } });
          toast(`Vote posted in ${channel.selectedOptions[0].textContent}.`);
          node.close();
        } catch (err) {
          if (!(err instanceof RequestError)) throw err;
          problem.textContent = err.message;
          problem.hidden = false;
        } finally {
          submit.disabled = false;
        }
      });
    },
  });
}

/** What a group could play, with what each of them has put into it */
export function renderPick(main) {
  const guildId = state.guildId;
  let options = null;
  let data = null;
  let picked = null;
  let sort = 'played';
  let query = '';
  let kind = '';
  let deck = 0;
  let latest = 0;
  const ticked = new Set();
  const opened = new Set();
  const playing = new Map();

  const who = el('select', { ariaLabel: 'Who’s playing', onchange: () => changed() });
  const pickButton = el('button', { className: 'primary', disabled: true, onclick: () => pickOne() }, 'Pick for us');
  const voteButton = el('button', { disabled: true, onclick: () => voteDialog(main, options, voice(), filtered() ? shownReady().map((g) => g.name) : null) }, 'Start a vote');
  const people = el('div', { className: 'pick-people', hidden: true });
  const voteNote = el('p', { className: 'hint', hidden: true }, 'A vote needs a voice channel, as only the people in it can vote.');
  const content = el('div', { className: 'stack' }, notice('loading', 'Loading…'));
  const search = el('input', {
    type: 'search',
    placeholder: 'Search these games',
    ariaLabel: 'Search these games',
    oninput: (e) => {
      query = e.target.value.trim().toLowerCase();
      paintLists();
    },
  });
  const sorter = el(
    'select',
    {
      ariaLabel: 'Sort',
      onchange: (e) => {
        sort = e.target.value;
        paintLists();
      },
    },
    SORTS.map(([id, label]) => el('option', { value: id }, label)),
  );
  const kindFilter = el(
    'select',
    {
      ariaLabel: 'Kind of game',
      onchange: (e) => {
        kind = e.target.value;
        paintLists();
      },
    },
    el('option', { value: '' }, 'Any kind'),
    el('option', { value: 'coop' }, 'Co-op'),
    el('option', { value: 'pvp' }, 'PvP'),
  );
  const deckFilter = el(
    'select',
    {
      ariaLabel: 'Steam Deck',
      onchange: (e) => {
        deck = Number(e.target.value);
        paintLists();
      },
    },
    el('option', { value: 0 }, 'Any device'),
    el('option', { value: DECK_PLAYABLE }, 'Playable on Deck'),
    el('option', { value: DECK_VERIFIED }, 'Verified on Deck'),
  );
  const lists = el('div', { className: 'stack' });
  const result = el('div');
  const joinable = el('div');
  main.append(joinable, el('div', { className: 'toolbar' }, who), people, voteNote, content);

  /** Off the main list, as it asks Steam about everyone linked and a pick shouldn't wait for that */
  function showLobbies() {
    void request(api('/lobbies'))
      .then(({ lobbies }) => {
        if (!lobbies.length || !main.isConnected) return;
        const line = (l) => el('div', { className: 'joinable' }, el('span', {}, `${l.name} · ${l.game}`), el('a', { href: l.join }, 'Join'));
        joinable.replaceChildren(el('section', { className: 'card' }, el('h2', {}, 'Joinable now'), lobbies.map(line)));
      })
      .catch(() => {});
  }

  const byHand = () => who.value === BY_HAND;
  const voice = () => options.voice.find((c) => c.id === who.value);
  const shown = (g) => g.name.toLowerCase().includes(query) && (!kind || g[kind]) && g.deck >= deck;
  const shownReady = () => data.ready.filter(shown);
  const filtered = () => Boolean(query || kind || deck);

  /** How many are playing it worldwide. The bot keeps this for a while, so opening a game again costs nothing */
  function playingNow(game) {
    const note = el('p', { className: 'hint' });
    if (!game.appid) return null;
    if (!playing.has(game.appid)) playing.set(game.appid, request(api(`/steam-apps/${game.appid}`)).catch(() => ({ players: null, patch: null })));
    void playing.get(game.appid).then(({ players, patch }) => {
      const now = players !== null && `${players.toLocaleString()} playing on Steam now`;
      const latest = patch && el('a', { href: patch.url, target: '_blank', rel: 'noreferrer' }, patch.title);
      note.replaceChildren(...[now, now && latest && ' · ', latest && `Latest patch ${ago(patch.date)}: `, latest].filter(Boolean));
    });
    return note;
  }

  function pickOne() {
    const from = shownReady();
    const others = from.filter((g) => g.name !== picked?.name);
    const choices = others.length ? others : from;
    picked = choices[Math.floor(Math.random() * choices.length)] ?? null;
    paintResult();
  }

  function paintResult() {
    result.replaceChildren(...(picked ? [el('section', { className: 'card pick-result' }, el('h2', {}, `🎲 ${picked.name}`), el('p', {}, facts(picked)), playingNow(picked))] : []));
  }

  const hide = (game) =>
    attempt(async () => {
      await request(api(`/hidden-games/${game.appid}`), { method: 'PUT', json: { name: game.name } });
      undoToast(`${game.name} won’t be suggested again.`, async () => {
        await request(api(`/hidden-games/${game.appid}`), { method: 'DELETE' });
        toast(`${game.name} can be suggested again.`);
        await show();
      });
      if (picked?.name === game.name) picked = null;
      await show();
    });

  function gameRow(game) {
    const count = el('div');
    const goals = el('div');
    const showGoals = el('button', { onclick: () => goals.replaceChildren(achievementsView(game.appid, game.players.map((p) => p.id))) }, 'Achievements');
    const showCount = () => count.replaceChildren(...[playingNow(game)].filter(Boolean));
    if (opened.has(game.name)) showCount();
    return el(
      'details',
      {
        className: 'pick-game',
        open: opened.has(game.name),
        ontoggle: (e) => {
          if (e.target.open) {
            opened.add(game.name);
            showCount();
          } else opened.delete(game.name);
        },
      },
      el(
        'summary',
        {},
        el('span', { className: 'pick-name' }, game.name),
        el('span', { className: 'pick-facts' }, facts(game)),
        kinds(game) && el('span', { className: 'pick-facts' }, kinds(game)),
        game.missing.length > 0 && el('span', { className: 'pick-facts' }, `${game.missing.join(', ')} needs it`),
      ),
      el(
        'div',
        { className: 'pick-detail' },
        count,
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Person'), el('th', {}, 'Played here'), el('th', {}, 'On Steam'), el('th', {}, 'Last 2 weeks'), el('th', {}, 'Last played'))),
          el('tbody', {}, game.players.map(playerRow)),
        ),
        (game.url || game.appid) &&
          el(
            'div',
            { className: 'pick-actions' },
            game.url && el('a', { href: game.url, target: '_blank', rel: 'noreferrer' }, 'Store page'),
            game.appid && showGoals,
            game.appid && el('button', { ariaLabel: `Never suggest ${game.name}`, onclick: () => hide(game) }, 'Never suggest this'),
          ),
        goals,
      ),
    );
  }

  function listCard(title, games, ...head) {
    const compare = SORTS.find(([id]) => id === sort)[2];
    const sorted = games.toSorted(compare);
    return el(
      'section',
      { className: 'card' },
      el('div', { className: 'card-head' }, el('h2', {}, `${title} (${sorted.length})`), ...head),
      sorted.slice(0, SHOWN).map(gameRow),
      sorted.length > SHOWN && notice('more', `Showing ${SHOWN} of ${sorted.length}. Search to find the rest.`, { compact: true }),
    );
  }

  function paintLists() {
    const ready = shownReady();
    const almost = data.almost.filter(shown);
    lists.replaceChildren(
      ready.length || filtered() ? listCard('Everyone can play these', ready) : notice('empty', 'No game fits everyone here.'),
      ...(almost.length ? [listCard('One purchase away', almost)] : []),
    );
    pickButton.disabled = !ready.length;
    voteButton.disabled = byHand() || ready.length < 2;
    voteButton.title = !byHand() && ready.length < 2 ? 'A vote needs at least two games to choose from.' : '';
  }

  function render() {
    content.replaceChildren(
      ...data.notes.map((note) => el('p', { className: 'hint' }, note)),
      // The filters come first, as the pick and the vote both go by them
      ...(data.counted ? [el('div', { className: 'toolbar' }, search, kindFilter, deckFilter, sorter), el('div', { className: 'toolbar' }, pickButton, voteButton), result, lists] : []),
    );
    paintResult();
    if (data.counted) paintLists();
  }

  function clear(text, kind = 'empty') {
    data = null;
    picked = null;
    pickButton.disabled = true;
    voteButton.disabled = true;
    content.replaceChildren(notice(kind, text));
  }

  async function show() {
    const ticket = ++latest;
    const search = byHand() ? new URLSearchParams({ users: [...ticked].join(',') }) : new URLSearchParams({ channel: who.value });
    try {
      const fresh = await request(api(`/pick?${search}`));
      if (ticket !== latest || guildId !== state.guildId || !main.isConnected) return;
      data = fresh;
      render();
    } catch (err) {
      if (ticket === latest) clear(err.message, 'error');
      throw err;
    }
  }

  function changed() {
    people.hidden = !byHand();
    voteNote.hidden = !byHand();
    picked = null;
    if (byHand() && !ticked.size) return clear('Tick who’s playing.');
    clear('Checking what everyone owns…', 'loading');
    return attempt(show);
  }

  showLobbies();
  void attempt(async () => {
    try {
      options = await request(api('/pick/options'));
    } catch (err) {
      clear(err.message, 'error');
      throw err;
    }
    if (guildId !== state.guildId || !main.isConnected) return;
    who.replaceChildren(...options.voice.map((c) => el('option', { value: c.id }, `${c.name} · ${c.people.join(', ')}`)), el('option', { value: BY_HAND }, 'Choose people'));
    people.replaceChildren(
      ...options.members.map((m) =>
        el(
          'label',
          { className: 'game-mark' },
          el('input', {
            type: 'checkbox',
            onchange: (e) => {
              if (e.target.checked) ticked.add(m.id);
              else ticked.delete(m.id);
              void changed();
            },
          }),
          m.name,
        ),
      ),
    );
    await changed();
  });
}
