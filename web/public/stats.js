import { achievementsView } from './achievements.js';
import { ago, api, attempt, el, formProblem, icon, notice, openDialog, recall, remember, request, state, toast } from './lib.js';

const PERIODS = [
  ['week', 'Past week'],
  ['month', 'Past month'],
  ['year', 'Past year'],
  ['all', 'All time'],
];

export function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours >= 100 || minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

function stepLabel(ms, step, timeZone) {
  if (step === 'month') return new Date(ms).toLocaleDateString(undefined, { timeZone, month: 'short', year: 'numeric' });
  const day = new Date(ms).toLocaleDateString(undefined, { timeZone, month: 'short', day: 'numeric' });
  return step === 'week' ? `Week of ${day}` : day;
}

const tile = (label, value) => el('div', { className: 'stat' }, el('div', { className: 'stat-value' }, value), el('div', { className: 'stat-label' }, label));

/** One colour, so there's no legend: the card's title says what's plotted */
function columnChart({ step, buckets }, timeZone) {
  const peak = Math.max(...buckets.map((b) => b.ms));
  const tip = el('div', { className: 'tip', hidden: true });
  const plot = el(
    'div',
    { className: 'columns', onpointerleave: () => (tip.hidden = true) },
    buckets.map((b) =>
      el(
        'div',
        {
          className: 'column',
          onpointerenter: (e) => {
            const box = plot.getBoundingClientRect();
            const slot = e.currentTarget.getBoundingClientRect();
            tip.textContent = `${stepLabel(b.start, step, timeZone)}: ${duration(b.ms)}`;
            tip.hidden = false;
            tip.style.left = `${Math.min(Math.max(0, slot.left - box.left - tip.offsetWidth / 2), box.width - tip.offsetWidth)}px`;
          },
        },
        b.ms > 0 && el('div', { className: 'column-bar', style: `height: ${Math.max(1, (b.ms / peak) * 100)}%` }),
      ),
    ),
  );
  return el(
    'div',
    { className: 'chart' },
    el('div', { className: 'axis-top' }, duration(peak)),
    el('div', { className: 'plot' }, tip, plot),
    el('div', { className: 'axis-x' }, el('span', {}, stepLabel(buckets[0].start, step, timeZone)), el('span', {}, stepLabel(buckets.at(-1).start, step, timeZone))),
    el(
      'details',
      {},
      el('summary', {}, 'Show as a table'),
      el(
        'table',
        {},
        el('tbody', {}, buckets.map((b) => el('tr', {}, el('td', {}, stepLabel(b.start, step, timeZone)), el('td', {}, duration(b.ms))))),
      ),
    ),
  );
}

/** Ranked rows; each is a button when it can filter the page */
function ranked(rows, onPick) {
  const top = Math.max(...rows.map((r) => r.ms));
  return el(
    'div',
    { className: 'ranked' },
    rows.map((r) =>
      el(
        onPick ? 'button' : 'div',
        { className: 'rank', ...(onPick && { onclick: () => onPick(r), title: `Show just ${r.label}` }) },
        el('span', { className: 'rank-name' }, r.label),
        el('span', { className: 'rank-track' }, el('span', { className: 'rank-bar', style: `width: ${Math.max(1, (r.ms / top) * 100)}%` })),
        el('span', { className: 'rank-value' }, duration(r.ms)),
        r.note && el('span', { className: 'rank-note' }, r.note),
      ),
    ),
  );
}

const card = (title, ...children) => el('section', { className: 'card' }, el('h2', {}, title), el('div', { className: 'card-body' }, ...children));
const titled = (title, action, ...children) => el('section', { className: 'card' }, el('div', { className: 'card-head' }, el('h2', {}, title), action), el('div', { className: 'card-body' }, ...children));
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lastPlayed = (ms) => `last played ${ago(ms)}`;

const VIEWS = [
  ['overview', 'Overview', overview],
  ['compare', 'Compare', compare],
  ['recap', 'Monthly recap', recap],
];

export function renderStats(main) {
  const body = el('div', { className: 'stack' });
  const tabs = el('div', { className: 'views' });
  const open = (id) => {
    remember('statsView', id);
    const [, , render] = VIEWS.find(([view]) => view === id);
    tabs.replaceChildren(...VIEWS.map(([view, label]) => el('button', { ...(view === id && { 'aria-current': 'page' }), onclick: () => open(view) }, label)));
    const view = el('div', { className: 'stack' });
    body.replaceChildren(view);
    render(view);
  };
  main.append(tabs, body);
  open(VIEWS.some(([view]) => view === recall('statsView')) ? recall('statsView') : 'overview');
}

function compare(main) {
  const guildId = state.guildId;
  const pick = (label) => el('select', { ariaLabel: label, onchange: () => show() });
  const first = pick('First person');
  const second = pick('Second person');
  const content = el('div', { className: 'stack' });
  main.append(el('div', { className: 'toolbar' }, first, el('span', {}, 'and'), second), content);

  function achievementsCard(data) {
    const area = el('div');
    const pick = (e) => area.replaceChildren(...(e.target.value ? [achievementsView(e.target.value, data.people.map((p) => p.id))] : []));
    return card('Achievements', el('select', { ariaLabel: 'Game for achievements', onchange: pick }, el('option', { value: '' }, 'Pick a game'), data.steamGames.map((g) => el('option', { value: g.appid }, g.name))), area);
  }

  function render(data) {
    const [a, b] = data.people;
    content.replaceChildren(
      el(
        'div',
        { className: 'stats' },
        tile('Played together', duration(data.togetherMs)),
        tile('Voice sessions together', String(data.voice.sessions)),
        tile(`${a.name}’s game time`, duration(a.ms)),
        tile(`${b.name}’s game time`, duration(b.ms)),
      ),
      ...(data.games.length ? [card('Played together most', ranked(data.games.map((g) => ({ label: g.name, ms: g.ms }))))] : []),
      card(
        `Both own (${data.shared.length})`,
        data.shared.length ? el('p', { className: 'shared-games' }, data.shared.join(', ')) : el('p', { className: 'hint' }, 'Nothing yet. Link Steam or mark games on the Games page.'),
      ),
      ...(data.steamGames.length ? [achievementsCard(data)] : []),
      el('p', { className: 'hint' }, `Played together means the same game in the same voice channel. They spent up to ${duration(data.voice.ms)} in voice together: only each person’s total is kept, so that’s the most it could be.`),
    );
  }

  function show() {
    if (first.value === second.value) return content.replaceChildren(notice('empty', 'Pick two different people.'));
    const query = new URLSearchParams({ a: first.value, b: second.value });
    return attempt(async () => {
      const data = await request(api(`/compare?${query}`));
      if (guildId === state.guildId && main.isConnected && query.get('a') === first.value && query.get('b') === second.value) render(data);
    });
  }

  void attempt(async () => {
    const { members } = await request(api('/pick/options'));
    if (guildId !== state.guildId || !main.isConnected) return;
    if (members.length < 2) return content.replaceChildren(notice('empty', 'It takes two people to compare.'));
    // Whoever's signed in goes first, so the comparison starts with them
    const mine = members.findIndex((m) => m.id === state.me?.userId);
    const starts = mine < 0 ? [0, 1] : [mine, mine === 0 ? 1 : 0];
    for (const [idx, picker] of [first, second].entries()) picker.replaceChildren(...members.map((m, n) => el('option', { value: m.id, selected: n === starts[idx] }, m.name)));
    await show();
  });
}

function recap(main) {
  const guildId = state.guildId;
  const content = el('div', { className: 'stack' }, notice('loading', 'Loading the recap…'));
  const month = el(
    'select',
    { ariaLabel: 'Month', onchange: () => show() },
    el('option', { value: 'last' }, 'Last month'),
    el('option', { value: 'this' }, 'This month so far'),
  );
  main.append(el('div', { className: 'toolbar' }, month), content);

  function show() {
    const asked = month.value;
    return attempt(async () => {
      const { recap: found } = await request(api(`/recap?month=${asked}`));
      if (guildId !== state.guildId || !main.isConnected || asked !== month.value) return;
      if (!found) return content.replaceChildren(notice('empty', 'Nothing to recap for that month yet.'));
      content.replaceChildren(
        el(
          'section',
          { className: 'card' },
          el('h2', {}, found.title),
          found.description && el('p', { className: 'card-note' }, found.description),
          found.fields.map((f) => el('div', { className: 'recap-field' }, el('div', { className: 'series-name' }, f.name), el('div', { className: 'recap-value' }, f.value))),
        ),
      );
    });
  }

  void show();
}

function overview(main) {
  const guildId = state.guildId;
  let period = recall('period') ?? 'month';
  let user = null;
  let game = null;
  let latest = 0;

  const chips = el('div', { className: 'chips' });
  const content = el('div', { className: 'stack' }, notice('loading', 'Loading stats…'));
  const picker = el(
    'select',
    {
      ariaLabel: 'Time range',
      onchange: (e) => {
        period = e.target.value;
        remember('period', period);
        void show();
      },
    },
    PERIODS.map(([id, label]) => el('option', { value: id, selected: id === period }, label)),
  );
  main.append(el('div', { className: 'toolbar' }, picker, chips), content);

  const pickUser = (r) => {
    user = { id: r.id, name: r.label };
    void show();
  };
  const pickGame = (r) => {
    game = r.label;
    void show();
  };

  /** Resolves with the name kept, or null if it's dismissed */
  function pickMerge() {
    return new Promise((resolve) => {
      let games = [];
      let kept = null;
      const ticked = new Set();
      const problem = formProblem();
      const list = el('div', { className: 'merge-list' }, el('p', {}, 'Loading games…'));
      const keep = el('select', { ariaLabel: 'Name to keep' });
      const merge = el('button', { className: 'primary', type: 'submit', disabled: true }, 'Merge');
      const search = el('input', { type: 'search', placeholder: 'Search games', ariaLabel: 'Search games', oninput: () => paint() });

      function paintKeep() {
        const was = keep.value;
        keep.replaceChildren(...[...ticked].map((name) => el('option', { value: name, selected: name === was }, name)));
        merge.disabled = ticked.size < 2;
      }

      function paint() {
        const query = search.value.trim().toLowerCase();
        const shown = games.filter((g) => ticked.has(g.name) || [g.name, ...g.spellings].some((n) => n.toLowerCase().includes(query)));
        list.replaceChildren(
          ...shown.map((g) =>
            el(
              'label',
              { className: 'merge-row' },
              el('input', {
                type: 'checkbox',
                checked: ticked.has(g.name),
                onchange: (e) => {
                  if (e.target.checked) ticked.add(g.name);
                  else ticked.delete(g.name);
                  paintKeep();
                },
              }),
              el('span', { className: 'rank-name' }, g.name),
              g.spellings.length > 0 && el('span', { className: 'rank-note' }, `also ${g.spellings.join(', ')}`),
              el('span', { className: 'rank-value' }, duration(g.ms)),
            ),
          ),
        );
        if (!shown.length) list.append(el('p', {}, 'No games match that.'));
      }

      const node = openDialog(
        main,
        el('h2', {}, 'Merge games'),
        el('p', {}, 'Tick the entries that are the same game. Past stats and ping roles follow, and you can separate them again.'),
        search,
        list,
        problem,
        el(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              problem.hidden = true;
              merge.disabled = true;
              try {
                await request(api('/game-names/merge'), { method: 'POST', json: { names: [...ticked], into: keep.value } });
                kept = keep.value;
                node.close();
              } catch (err) {
                problem.textContent = err.message;
                problem.hidden = false;
                merge.disabled = false;
              }
            },
          },
          el('label', { className: 'start' }, 'Keep the name', keep),
          el('div', { className: 'actions' }, el('button', { type: 'button', onclick: () => node.close() }, 'Cancel'), merge),
        ),
      );
      node.addEventListener('close', () => resolve(kept));
      void request(api('/game-names')).then(
        (data) => {
          ({ games } = data);
          paint();
        },
        (err) => {
          problem.textContent = err.message;
          problem.hidden = false;
        },
      );
    });
  }

  const mergeGames = () =>
    attempt(async () => {
      const kept = await pickMerge();
      if (!kept) return;
      toast(`Merged into ${kept}.`);
      await show();
    });

  const separate = (raw) =>
    attempt(async () => {
      await request(api('/game-names/separate'), { method: 'POST', json: { name: raw } });
      toast(`${raw} is its own game again.`);
      await show();
    });

  function chip(label, clear) {
    return el('button', { className: 'chip with-icon', title: `Stop filtering by ${label}`, onclick: clear }, label, icon('x'));
  }

  function render(data) {
    chips.replaceChildren(
      ...(user ? [chip(user.name, () => ((user = null), void show()))] : []),
      ...(game ? [chip(game, () => ((game = null), void show()))] : []),
    );
    const { totals, activity, timeZone } = data;
    if (!totals.gameMs && !totals.voiceMs) return content.replaceChildren(notice('empty', 'Nothing recorded for this period yet.'));

    content.replaceChildren(
      el(
        'div',
        { className: 'stats' },
        tile('Game time', duration(totals.gameMs)),
        !game && tile('Games played', String(totals.games)),
        !user && tile('People playing', String(totals.people)),
        !game && tile('Time in voice', duration(totals.voiceMs)),
        game && !user && tile('Player time', duration(totals.playerMs)),
        data.place && tile('Sessions', String(data.place.sessions)),
        data.place && tile('Rank', `${data.place.rank} of ${data.place.of}`),
      ),
      ...(activity.buckets.length ? [card('Game time over time', columnChart(activity, timeZone))] : []),
      ...(data.spellings.length
        ? [
            card(
              'Also shown as',
              el(
                'div',
                { className: 'spellings' },
                data.spellings.map((raw) => el('div', { className: 'spelling' }, el('span', {}, raw), el('button', { onclick: () => separate(raw), ariaLabel: `Separate ${raw}` }, 'Separate'))),
              ),
            ),
          ]
        : []),
      ...(!game && data.games.length
        ? [titled('Top games', el('button', { onclick: mergeGames }, 'Merge games'), ranked(data.games.map((g) => ({ label: g.name, ms: g.ms, note: user ? lastPlayed(g.last) : count(g.people, 'player') })), pickGame))]
        : []),
      ...(!user && data.players.length
        ? [card(game ? 'Who played' : 'Most game time', ranked(data.players.map((p) => ({ id: p.id, label: p.name, ms: p.ms, note: game ? lastPlayed(p.last) : count(p.games, 'game') })), pickUser))]
        : []),
      ...(data.voice.length ? [card('Time in voice', ranked(data.voice.map((p) => ({ id: p.id, label: p.name, ms: p.ms, note: count(p.nights, 'night') })), user ? null : pickUser))] : []),
      el('p', { className: 'hint' }, 'Games played in a voice channel. A game’s time is how long anyone was playing it, so its players can add up to more. From Discord’s “Playing” status, so it only counts people who share it.'),
    );
  }

  async function show() {
    const ticket = ++latest;
    await attempt(async () => {
      const query = new URLSearchParams({ period, ...(user && { user: user.id }), ...(game && { game }) });
      try {
        const data = await request(api(`/stats?${query}`));
        // Only the newest answer counts, if filters were clicked quickly
        if (ticket === latest && guildId === state.guildId && main.isConnected) render(data);
      } catch (err) {
        content.replaceChildren(notice('error', err.message));
        throw err;
      }
    });
  }

  void show();
}
