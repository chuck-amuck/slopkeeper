import { ago, api, attempt, el, openDialog, request, RequestError, state, toast } from './lib.js';
import { duration } from './stats.js';

const SHOWN = 100;
const BY_HAND = 'people';

const SORTS = [
  ['played', 'Most played', (a, b) => b.playedMs - a.playedMs || b.steamMinutes - a.steamMinutes],
  ['oldest', 'Longest since played', (a, b) => (a.last ?? 0) - (b.last ?? 0)],
  ['name', 'Name', (a, b) => a.name.localeCompare(b.name)],
];

const steamTime = (minutes) => duration(minutes * 60_000);

function facts(game) {
  const parts = [game.playedMs ? `${duration(game.playedMs)} here` : 'Not played here yet'];
  if (game.steamMinutes) parts.push(`${steamTime(game.steamMinutes)} on Steam`);
  if (game.last) parts.push(`last played ${ago(game.last)}`);
  return parts.join(' · ');
}

const playerRow = (p) =>
  el('tr', {}, el('td', {}, p.name), el('td', {}, p.playedMs ? duration(p.playedMs) : '—'), el('td', {}, p.steamMinutes === null ? '—' : steamTime(p.steamMinutes)), el('td', {}, p.last ? ago(p.last) : '—'));

function voteDialog(main, options, voice) {
  const channel = el('select', { ariaLabel: 'Post it in' }, options.channels.map((c) => el('option', { value: c.id, selected: c.id === options.announceChannel }, `#${c.name}`)));
  const minutes = el('input', { type: 'number', min: 1, max: 10, step: 1, required: true, value: 1, ariaLabel: 'Minutes' });
  const problem = el('div', { className: 'bad-text plan-problem', hidden: true });
  const submit = el('button', { className: 'primary', type: 'submit' }, 'Start vote');
  const node = openDialog(
    main,
    el('h2', {}, 'Start a vote'),
    el('p', {}, `Everyone in ${voice.name} votes in Discord, on the games they all own.`),
    el(
      'form',
      {
        className: 'plan',
        onsubmit: (e) => {
          e.preventDefault();
          submit.disabled = true;
          problem.hidden = true;
          void attempt(async () => {
            try {
              await request(api('/votes'), { method: 'POST', json: { voiceChannelId: voice.id, channelId: channel.value, minutes: Number(minutes.value) } });
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
      },
      el('label', { className: 'form-row' }, el('span', {}, 'Post it in'), channel),
      el('label', { className: 'form-row' }, el('span', {}, 'Minutes'), minutes),
      problem,
      el('div', { className: 'actions' }, el('button', { type: 'button', onclick: () => node.close() }, 'Cancel'), submit),
    ),
  );
}

/** What a group could play, with what each of them has put into it */
export function renderPick(main) {
  const guildId = state.guildId;
  let options = null;
  let data = null;
  let picked = null;
  let sort = 'played';
  let query = '';
  let latest = 0;
  const ticked = new Set();
  const opened = new Set();

  const who = el('select', { ariaLabel: 'Who’s playing', onchange: () => changed() });
  const pickButton = el('button', { className: 'primary', disabled: true, onclick: () => pickOne() }, 'Pick for us');
  const voteButton = el('button', { disabled: true, onclick: () => voteDialog(main, options, voice()) }, 'Start a vote');
  const people = el('div', { className: 'pick-people', hidden: true });
  const voteNote = el('p', { className: 'hint', hidden: true }, 'A vote needs a voice channel, as only the people in it can vote.');
  const content = el('div', { className: 'stack' }, el('div', { className: 'empty' }, 'Loading…'));
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
  const lists = el('div', { className: 'stack' });
  const result = el('div');
  main.append(el('div', { className: 'toolbar' }, who, pickButton, voteButton), people, voteNote, content);

  const byHand = () => who.value === BY_HAND;
  const voice = () => options.voice.find((c) => c.id === who.value);
  const shownReady = () => data.ready.filter((g) => g.name.toLowerCase().includes(query));

  function pickOne() {
    const from = shownReady();
    const others = from.filter((g) => g.name !== picked?.name);
    const choices = others.length ? others : from;
    picked = choices[Math.floor(Math.random() * choices.length)] ?? null;
    paintResult();
  }

  function paintResult() {
    result.replaceChildren(...(picked ? [el('section', { className: 'card pick-result' }, el('h2', {}, `🎲 ${picked.name}`), el('p', {}, facts(picked)))] : []));
  }

  const hide = (game) =>
    attempt(async () => {
      await request(api(`/hidden-games/${game.appid}`), { method: 'PUT', json: { name: game.name } });
      toast(`${game.name} won’t be suggested again.`);
      if (picked?.name === game.name) picked = null;
      await show();
    });

  function gameRow(game) {
    return el(
      'details',
      {
        className: 'pick-game',
        open: opened.has(game.name),
        ontoggle: (e) => {
          if (e.target.open) opened.add(game.name);
          else opened.delete(game.name);
        },
      },
      el(
        'summary',
        {},
        el('span', { className: 'pick-name' }, game.name),
        el('span', { className: 'pick-facts' }, facts(game)),
        game.missing.length > 0 && el('span', { className: 'pick-facts' }, `${game.missing.join(', ')} needs it`),
      ),
      el(
        'div',
        { className: 'pick-detail' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Person'), el('th', {}, 'Played here'), el('th', {}, 'On Steam'), el('th', {}, 'Last played'))),
          el('tbody', {}, game.players.map(playerRow)),
        ),
        (game.url || game.appid) &&
          el(
            'div',
            { className: 'pick-actions' },
            game.url && el('a', { href: game.url, target: '_blank', rel: 'noreferrer' }, 'Store page'),
            game.appid && el('button', { ariaLabel: `Never suggest ${game.name}`, onclick: () => hide(game) }, 'Never suggest this'),
          ),
      ),
    );
  }

  function listCard(title, games, ...head) {
    const compare = SORTS.find(([id]) => id === sort)[2];
    const shown = games.toSorted(compare);
    return el(
      'section',
      { className: 'card' },
      el('div', { className: 'card-head' }, el('h2', {}, `${title} (${shown.length})`), ...head),
      shown.slice(0, SHOWN).map(gameRow),
      shown.length > SHOWN && el('p', { className: 'card-note' }, `Showing ${SHOWN} of ${shown.length}. Search to find the rest.`),
    );
  }

  function paintLists() {
    const ready = shownReady();
    const almost = data.almost.filter((g) => g.name.toLowerCase().includes(query));
    lists.replaceChildren(
      ready.length || query ? listCard('Everyone owns these', ready) : el('div', { className: 'empty' }, 'No game fits everyone here.'),
      ...(almost.length ? [listCard('One purchase away', almost)] : []),
    );
    pickButton.disabled = !ready.length;
  }

  function render() {
    content.replaceChildren(
      ...data.notes.map((note) => el('p', { className: 'hint' }, note)),
      ...(data.counted ? [result, el('div', { className: 'toolbar' }, search, sorter), lists] : []),
    );
    paintResult();
    if (data.counted) paintLists();
    voteButton.disabled = byHand() || data.ready.length < 2;
  }

  function clear(text) {
    data = null;
    picked = null;
    pickButton.disabled = true;
    voteButton.disabled = true;
    content.replaceChildren(el('div', { className: 'empty' }, text));
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
      if (ticket === latest) clear(err.message);
      throw err;
    }
  }

  function changed() {
    people.hidden = !byHand();
    voteNote.hidden = !byHand();
    picked = null;
    if (byHand() && !ticked.size) return clear('Tick who’s playing.');
    clear('Checking what everyone owns…');
    return attempt(show);
  }

  void attempt(async () => {
    try {
      options = await request(api('/pick/options'));
    } catch (err) {
      clear(err.message);
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
