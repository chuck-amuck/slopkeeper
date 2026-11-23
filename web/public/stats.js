import { achievementsView } from './achievements.js';
import { calendarChart, dragNote, HOURS, timeChart, weekChart, WEEKDAYS_LONG } from './charts.js';
import { ago, api, attempt, duration, el, formProblem, icon, notice, openDialog, recall, remember, request, state, toast, undoToast } from './lib.js';
import { rangeBar, rangeFromQuery, rangeQuery } from './rangebar.js';
import { viewTabs } from './viewtabs.js';

/** Ranges up to now, from midnight in the server's time zone where it's whole days */
const PERIODS = [
  ['today', 'Today'],
  ['week', '7 days'],
  ['month', '30 days'],
  ['quarter', '90 days'],
  ['thisYear', 'This year'],
  ['all', 'All time'],
];

/** What a step of a chart says: an hour, a day, a week or a month */
function stepLabel(ms, step, timeZone) {
  if (step === 'month') return new Date(ms).toLocaleDateString(undefined, { timeZone, month: 'short', year: 'numeric' });
  if (step === 'hour') return new Date(ms).toLocaleString(undefined, { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const day = new Date(ms).toLocaleDateString(undefined, { timeZone, ...(step === 'day' && { weekday: 'short' }), month: 'short', day: 'numeric' });
  return step === 'week' ? `Week of ${day}` : day;
}

const tile = (label, value) => el('div', { className: 'stat' }, el('div', { className: 'stat-value' }, value), el('div', { className: 'stat-label' }, label));

/**
 * How a number moved from the stretch before: "▲ 3h 10m", "▼ 2", "New" or "Same", written by `write`. Null without a
 * stretch before, or with nothing in either
 */
function change(now, before, write) {
  if (before === null || before === undefined || now === null || now === undefined) return null;
  if (!before && !now) return null;
  if (!before) return { text: 'New', title: 'None in the stretch before' };
  const diff = now - before;
  if (Math.abs(diff) < 1 || (write === duration && Math.abs(diff) < 60_000)) return { text: 'Same', title: 'The same as the stretch before' };
  const share = Math.round((diff / before) * 100);
  return { text: `${diff > 0 ? '▲' : '▼'} ${write(Math.abs(diff))}`, title: `${diff > 0 ? '+' : ''}${share}% on the stretch before` };
}

/** A small line of how a number went over the range, under its tile. Nothing when there's no shape to show */
function sparkline(values) {
  if (!values || values.length < 2 || !values.some((v) => v > 0)) return null;
  const most = Math.max(...values);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(23 - (v / most) * 21).toFixed(2)}`).join(' '));
  svg.append(line);
  return svg;
}

/** A headline number with how it moved from the stretch before, and its shape over the range */
const trendTile = (label, value, moved, shape) =>
  el(
    'div',
    { className: 'stat' },
    el('div', { className: 'stat-value' }, value),
    el('div', { className: 'stat-label' }, label),
    moved && el('div', { className: 'stat-change', title: moved.title }, moved.text),
    sparkline(shape),
  );

/** "▲ 2h" for a ranked row's note, or nothing */
const movedNote = (now, before) => change(now, before, duration)?.text ?? null;

/**
 * Each game in the activity chart keeps its colour as the range changes, as long as it's in the top five, so a game
 * doesn't swap colours with another when one drops out
 */
const gameColours = new Map();
function coloursFor(guildId, names) {
  const kept = gameColours.get(guildId) ?? gameColours.set(guildId, new Map()).get(guildId);
  const taken = new Set();
  const out = new Map();
  for (const name of names) {
    const slot = kept.get(name);
    if (!slot || taken.has(slot)) continue;
    out.set(name, slot);
    taken.add(slot);
  }
  for (const name of names) {
    if (out.has(name)) continue;
    let slot = 1;
    while (taken.has(slot)) slot++;
    out.set(name, slot);
    taken.add(slot);
    kept.set(name, slot);
  }
  return out;
}

/** The people, written for a tooltip: "1.4 people on average", or for one person the share of the time */
const peopleText = (value, one) => (one ? `on ${Math.round(value * 100)}% of the time` : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${value === 1 ? 'person' : 'people'} on average`);

/** Ranked rows; each is a button when it can filter the page. A row's bar goes by `ms`, written as `text` if it has one */
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
        el('span', { className: 'rank-value' }, r.text ?? duration(r.ms)),
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
  ['sounds', 'Sounds & music', soundsAndMusic, 'Sounds'],
  ['recap', 'Monthly recap', recap, 'Recap'],
];

export const renderStats = (main) => viewTabs(main, { tab: 'stats', label: 'Stats view', views: VIEWS, key: 'statsView' });

function compare(main) {
  const guildId = state.guildId;
  const pick = (label) => el('select', { ariaLabel: label, onchange: () => show() });
  const first = pick('First person');
  const second = pick('Second person');
  const content = el('div', { className: 'stack' });
  const bar = el('div', { className: 'toolbar' }, first, el('span', {}, 'and'), second);
  main.append(bar, content);

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
      el('p', { className: 'hint stats-note' }, `Played together means the same game in the same voice channel. They spent up to ${duration(data.voice.ms)} in voice together: only each person’s total is kept, so that’s the most it could be.`),
      ...(data.games.length ? [card('Played together most', ranked(data.games.map((g) => ({ label: g.name, ms: g.ms }))))] : []),
      card(
        `Both own (${data.shared.length})`,
        data.shared.length ? el('p', { className: 'shared-games' }, data.shared.join(', ')) : el('p', { className: 'hint' }, 'Nothing yet. Link Steam or mark games on ', el('a', { href: '#games/library' }, 'Games → Library'), '.'),
      ),
      ...(data.steamGames.length ? [achievementsCard(data)] : []),
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
    // Only people Stats has something on: time in voice, or a game played there
    const { people } = await request(api('/compare/people'));
    if (guildId !== state.guildId || !main.isConnected) return;
    if (people.length < 2) {
      bar.hidden = true;
      return content.replaceChildren(notice('empty', 'Compare needs two people with stats. Time in voice and games played there count.'));
    }
    // Whoever's signed in goes first, so the comparison starts with them
    const mine = people.findIndex((m) => m.id === state.me?.userId);
    const starts = mine < 0 ? [0, 1] : [mine, mine === 0 ? 1 : 0];
    for (const [idx, picker] of [first, second].entries()) picker.replaceChildren(...people.map((m, n) => el('option', { value: m.id, selected: n === starts[idx] }, m.name)));
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

/**
 * A Stats view over a range picked in its toolbar, remembered as the period and kept in the address. `ask(dates)` gets
 * the numbers for the range, as the bot takes it, and `render(data)` shows them, only the newest answer if the range or
 * a filter changed quickly. `extra` goes in the toolbar beside the range. Returns { content, bar, show, range }:
 * `show()` asks again, and `range()` is the one picked
 */
function rangedView(main, address, { ask, render, extra = null }) {
  const guildId = state.guildId;
  let range = rangeFromQuery(address.params, PERIODS) ?? { preset: PERIODS.some(([id]) => id === recall('period')) ? recall('period') : 'month' };
  let latest = 0;
  let timeZone;
  const content = el('div', { className: 'stack' }, notice('loading', 'Loading stats…'));
  const bar = rangeBar({
    presets: PERIODS,
    value: range,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onChange: (picked) => {
      range = picked;
      if (picked.preset) remember('period', picked.preset);
      address.write(new URLSearchParams(rangeQuery(range)));
      void show();
    },
  });
  main.append(el('div', { className: 'toolbar range-toolbar' }, bar.node, extra), content);
  address.write(new URLSearchParams(rangeQuery(range)));

  async function show() {
    const ticket = ++latest;
    await attempt(async () => {
      // The bot calls a preset a period
      const { range: period, ...dates } = rangeQuery(range);
      try {
        const data = await ask(period ? { period } : dates);
        if (data.timeZone !== timeZone) bar.timeZone((timeZone = data.timeZone));
        if (ticket === latest && guildId === state.guildId && main.isConnected) render(data);
      } catch (err) {
        if (ticket === latest) content.replaceChildren(notice('error', err.message));
        throw err;
      }
    });
  }

  return { content, bar, show, range: () => range };
}

function overview(main, address) {
  const guildId = state.guildId;
  let user = null;
  let game = null;
  const chips = el('div', { className: 'chips' });
  const { content, bar, show, range } = rangedView(main, address, {
    ask: (dates) => request(api(`/stats?${new URLSearchParams({ ...dates, ...(user && { user: user.id }), ...(game && { game }) })}`)),
    render,
    extra: chips,
  });

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
      const search = el('input', {
        type: 'search',
        placeholder: 'Search games',
        ariaLabel: 'Search games',
        oninput: () => paint(),
        // It's in the form, but Enter there shouldn't merge
        onkeydown: (e) => {
          if (e.key === 'Enter') e.preventDefault();
        },
      });

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

      const node = openDialog(main, {
        title: 'Merge games',
        body: [
          el('p', {}, 'Tick the entries that are the same game. Past stats and ping roles follow, and you can separate them again.'),
          search,
          list,
          problem,
          el('label', { className: 'start' }, 'Keep the name', keep),
        ],
        actions: [merge],
        close: 'Cancel',
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
      });
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

  /** Leaves a game out of everything, with Undo counting it again */
  const notAGame = (name) =>
    attempt(async () => {
      await request(api('/game-names/not-a-game'), { method: 'POST', json: { name } });
      if (game === name) game = null;
      undoToast(`${name} isn’t counted as a game.`, () => aGame(name));
      await show();
    });

  const aGame = (name) =>
    attempt(async () => {
      await request(api('/game-names/a-game'), { method: 'POST', json: { name } });
      toast(`${name} counts as a game again.`);
      await show();
    });

  /** What's been marked as not a game, each with a way back */
  function showNotGames() {
    const list = el('div', { className: 'merge-list' }, el('p', {}, 'Loading…'));
    const paint = (names) =>
      list.replaceChildren(
        ...(names.length
          ? names.map((name) =>
              el(
                'div',
                { className: 'merge-row' },
                el('span', { className: 'rank-name' }, name),
                el('button', { type: 'button', onclick: () => void aGame(name).then(() => load()), ariaLabel: `Count ${name} as a game` }, 'It’s a game'),
              ),
            )
          : [el('p', {}, 'Nothing is marked as not a game.')]),
      );
    const load = () =>
      request(api('/game-names')).then(
        (data) => paint(data.notGames),
        (err) => list.replaceChildren(el('p', {}, err.message)),
      );
    openDialog(main, {
      title: 'Not games',
      body: [el('p', {}, 'Programs that showed as playing but aren’t games, like launchers. They’re left out of Stats, game nights, game roles and session recaps, and their time is kept in case one is a game after all.'), list],
    });
    void load();
  }

  const separate = (raw) =>
    attempt(async () => {
      await request(api('/game-names/separate'), { method: 'POST', json: { name: raw } });
      toast(`${raw} is its own game again.`);
      await show();
    });

  function chip(label, clear) {
    return el('button', { className: 'chip with-icon', title: `Stop filtering by ${label}`, onclick: clear }, label, icon('x'));
  }

  /** What the stretch before is called: "yesterday by now", "the 7 days before" */
  function beforeText(data) {
    const names = { today: 'yesterday by now', week: 'the 7 days before', month: 'the 30 days before', quarter: 'the 90 days before', thisYear: 'last year by this date' };
    const { preset } = range();
    if (preset && names[preset]) return names[preset];
    const days = Math.round((data.until - data.since) / 86_400_000);
    return days >= 2 ? `the ${days} days before` : 'the same length of time before';
  }

  function tiles(data) {
    const { totals } = data;
    const was = data.previous?.totals;
    const moved = (key, write) => change(totals[key], was?.[key], write);
    const day = (ms) => new Date(ms).toLocaleDateString(undefined, { timeZone: data.timeZone, month: 'long', day: 'numeric', year: 'numeric' });
    const note = data.previous
      ? `▲ and ▼ compare with ${beforeText(data)}.`
      : data.since && data.recordsFrom
        ? `Records start ${day(data.recordsFrom)}, so there’s no stretch as long as this one before it to compare with.`
        : null;
    return [
      el(
        'div',
        { className: 'stats' },
        trendTile('Game time', duration(totals.gameMs), moved('gameMs', duration), data.activity.buckets.map((b) => b.ms)),
        !game && trendTile('Games played', String(totals.games), moved('games', String)),
        !user && trendTile('People playing', String(totals.people), moved('people', String), data.series.people),
        !game && trendTile('Time in voice', duration(totals.voiceMs), moved('voiceMs', duration), data.series.voiceMs),
        game && !user && trendTile('Player time', duration(totals.playerMs), moved('playerMs', duration)),
        totals.sounds !== null && trendTile('Sounds played', String(totals.sounds), moved('sounds', String), data.series.sounds),
        (totals.nights > 0 || was?.nights > 0) && trendTile('Game nights', String(totals.nights), moved('nights', String)),
        data.place && tile('Sessions', String(data.place.sessions)),
        data.place && tile('Rank', `${data.place.rank} of ${data.place.of}`),
      ),
      note && el('p', { className: 'hint stats-note' }, note),
    ];
  }

  function activityCard(data) {
    const { activity } = data;
    if (!activity.buckets.length) return null;
    const colours = coloursFor(guildId, activity.games.map((g) => g.name));
    const series = activity.games.length
      ? [
          ...activity.games.map((g) => ({ id: `game:${g.name}`, label: g.name, color: `var(--series-${colours.get(g.name)})`, values: g.values })),
          ...(activity.other ? [{ id: 'other', label: 'Other games', color: 'var(--series-other)', values: activity.other }] : []),
        ]
      : [{ id: 'all', label: 'Game time', color: 'var(--series-1)', values: activity.buckets.map((b) => b.ms) }];
    return card(
      'Game time over time',
      timeChart({
        key: 'overview-activity',
        title: 'Game time over time',
        times: activity.buckets.map((b) => b.start),
        until: activity.until,
        timeLabel: (ms) => stepLabel(ms, activity.step, data.timeZone),
        timeZone: data.timeZone,
        series,
        format: duration,
        stacked: true,
        height: 200,
        onPick: (from, to) => bar.zoom(from, to),
      }),
      el('p', { className: 'hint' }, `Games played in a voice channel. A game’s time is how long anyone was playing it, so its players can add up to more. From Discord’s “Playing” status, so it only counts people who share it.${dragNote()}`),
    );
  }

  /** Each day's time in voice on a calendar, for a range of weeks or months. A day picked becomes the range */
  function calendarCard(data) {
    if (!data.calendar?.length) return null;
    const date = (d) => new Date(`${d.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const whose = user ? `${user.name}’s` : 'Everyone’s';
    return card(
      'Days in voice',
      calendarChart({
        title: `${whose} time in voice each day`,
        days: data.calendar.map((d) => ({ ...d, value: d.ms })),
        format: (ms) => (ms ? duration(ms) : '0'),
        describe: (d) => `${date(d)}: ${d.ms ? duration(d.ms) : 'nobody'} in voice`,
        onPick: (d) => bar.zoom(d.start, Math.min(d.end, Date.now())),
      }),
      el('p', { className: 'hint' }, `${whose} time in voice each day, added up, in the server’s time zone (${data.timeZone}). Tap a day to look at just that day.`),
    );
  }

  function whenCard(data) {
    if (!data.when) return null;
    const one = !!user;
    const who = game ? `people playing ${game}` : 'people in voice';
    const counted = data.voiceFrom ?? Infinity;
    const partial = !game && counted > (data.since || data.recordsFrom || 0);
    const day = (ms) => new Date(ms).toLocaleDateString(undefined, { timeZone: data.timeZone, month: 'long', day: 'numeric' });
    return card(
      'When people are on',
      weekChart({
        title: 'When people are on',
        grid: data.when,
        format: (v) => (one ? `${Math.round(v * 100)}%` : v.toLocaleString(undefined, { maximumFractionDigits: 1 })),
        describe: (v, weekday, hour) => `${WEEKDAYS_LONG[weekday]}s, ${HOURS[hour]}: ${v === '-' ? 'not in this range' : peopleText(v, one)}`,
      }),
      el(
        'p',
        { className: 'hint' },
        one
          ? `How much of each hour ${user.name} was on, in the server’s time zone (${data.timeZone}).`
          : `How many ${who} there were at once, on average, at each hour in the server’s time zone (${data.timeZone}).`,
        partial ? ` ${Number.isFinite(counted) ? `Before ${day(counted)}` : 'For now'} it counts only people playing a game Discord shows, as that’s all the bot noted.` : '',
      ),
    );
  }

  function trendingCard(data) {
    const t = data.trending;
    if (!t || (!t.up.length && !t.down.length)) return null;
    const row = (g) =>
      el(
        'button',
        { className: 'rank trend', onclick: () => pickGame({ label: g.name }), title: `Show just ${g.name}` },
        el('span', { className: 'rank-name' }, g.name),
        el('span', { className: 'rank-value' }, `${g.change > 0 ? '▲' : '▼'} ${duration(Math.abs(g.change))}`),
        el('span', { className: 'rank-note' }, g.previousMs ? `${duration(g.previousMs)} → ${g.ms ? duration(g.ms) : 'none'}` : `new, ${duration(g.ms)}`),
      );
    return card(
      'Trending',
      el(
        'div',
        { className: 'trend-cols' },
        t.up.length > 0 && el('div', { className: 'ranked' }, el('h3', {}, 'Played more'), t.up.map(row)),
        t.down.length > 0 && el('div', { className: 'ranked' }, el('h3', {}, 'Played less'), t.down.map(row)),
      ),
      el('p', { className: 'hint' }, `Against ${beforeText(data)}.`),
    );
  }

  function render(data) {
    chips.replaceChildren(
      ...(user ? [chip(user.name, () => ((user = null), void show()))] : []),
      ...(game ? [chip(game, () => ((game = null), void show()))] : []),
    );
    const { totals } = data;
    if (!totals.gameMs && !totals.voiceMs && !totals.sounds && !totals.nights) return content.replaceChildren(notice('empty', 'Nothing recorded for this period yet.'));
    const notes = (...parts) => parts.filter(Boolean).join(' · ');

    // A card with nothing to show is left out, rather than printed as "null"
    content.replaceChildren(
      ...[
      ...tiles(data),
      activityCard(data),
      calendarCard(data),
      whenCard(data),
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
      ...(game
        ? [
            card(
              'Not a game?',
              el('p', { className: 'hint' }, `If ${game} is a launcher or another program rather than a game, it can be left out of Stats, game nights, game roles and session recaps.`),
              el('button', { onclick: () => notAGame(game) }, 'Not a game'),
            ),
          ]
        : []),
      ...(!game && data.games.length
        ? [
            titled(
              'Top games',
              el('div', { className: 'card-actions' }, el('button', { onclick: mergeGames }, 'Merge games'), el('button', { onclick: showNotGames }, 'Not games')),
              ranked(
                data.games.map((g) => ({ label: g.name, ms: g.ms, note: notes(user ? lastPlayed(g.last) : count(g.people, 'player'), movedNote(g.ms, g.previousMs)) })),
                pickGame,
              ),
            ),
          ]
        : []),
      trendingCard(data),
      ...(!user && data.players.length
        ? [card(game ? 'Who played' : 'Most game time', ranked(data.players.map((p) => ({ id: p.id, label: p.name, ms: p.ms, note: notes(game ? lastPlayed(p.last) : count(p.games, 'game'), movedNote(p.ms, p.previousMs)) })), pickUser))]
        : []),
      ...(data.voice.length ? [card('Time in voice', ranked(data.voice.map((p) => ({ id: p.id, label: p.name, ms: p.ms, note: notes(count(p.nights, 'night'), movedNote(p.ms, p.previousMs)) })), user ? null : pickUser))] : []),
      ].filter(Boolean),
    );
  }

  void show();
}

const SOURCES = { file: 'uploaded files', youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp' };
const KINDS = [
  ['sounds', 'sounds'],
  ['music', 'songs'],
  ['speech', 'lines said aloud'],
];

/** Stats → Sounds & music: the soundboard, the music and speech over a range, with who and what most */
function soundsAndMusic(main, address) {
  const { content, bar, show } = rangedView(main, address, { ask: (dates) => request(api(`/stats/sounds?${new URLSearchParams(dates)}`)), render });

  const day = (ms, tz) => new Date(ms).toLocaleDateString(undefined, { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' });

  /** Which records start after the range does, so their numbers are partial, or haven't started at all */
  function startNote(data) {
    const late = KINDS.filter(([key]) => data.from[key] === null || data.from[key] > data.since);
    if (!late.length) return null;
    const started = new Map();
    const none = [];
    for (const [key, label] of late) {
      if (data.from[key] === null) none.push(label);
      else {
        const when = day(data.from[key], data.timeZone);
        started.set(when, [...(started.get(when) ?? []), label]);
      }
    }
    const list = (labels) => {
      const text = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];
      return text[0].toUpperCase() + text.slice(1);
    };
    const parts = [...started].map(([when, labels]) => `${list(labels)} are counted from ${when}, when the bot started noting them.`);
    if (none.length) parts.push(`${list(none)}: none yet. The bot notes them from now on.`);
    return el('p', { className: 'hint stats-note' }, parts.join(' '));
  }

  function render(data) {
    const { totals, previous: was, activity } = data;
    const plain = (n) => String(Math.round(n));
    const moved = (key, write) => change(totals[key], was?.[key], write);
    const note = was ? el('p', { className: 'hint stats-note' }, '▲ and ▼ compare with the stretch before, as long as this one.') : null;
    const tiles = el(
      'div',
      { className: 'stats' },
      trendTile('Sounds played', plain(totals.sounds), moved('sounds', plain), activity.sounds),
      trendTile('Songs played', plain(totals.songs), moved('songs', plain), activity.songs),
      trendTile('Music heard', duration(totals.listenedMs), moved('listenedMs', duration)),
      trendTile('Lines said', plain(totals.lines), moved('lines', plain), activity.lines),
    );
    if (!totals.sounds && !totals.songs && !totals.lines) return content.replaceChildren(tiles, startNote(data) ?? '', notice('empty', 'Nothing played or said in this range.'));

    const counted = (n, word) => ({ ms: n, text: count(n, word) });
    const chart = card(
      'Over time',
      timeChart({
        key: 'sounds-activity',
        title: 'Sounds, songs and lines over time',
        times: activity.times,
        until: activity.until,
        timeLabel: (ms) => stepLabel(ms, activity.step, data.timeZone),
        timeZone: data.timeZone,
        series: [
          { id: 'sounds', label: 'Sounds', color: 'var(--series-1)', values: activity.sounds },
          { id: 'songs', label: 'Songs', color: 'var(--series-2)', values: activity.songs },
          { id: 'lines', label: 'Lines said', color: 'var(--series-3)', values: activity.lines },
        ],
        format: plain,
        whole: true,
        height: 180,
        onPick: (from, to) => bar.zoom(from, to),
      }),
      dragNote() && el('p', { className: 'hint' }, dragNote().trim()),
    );
    // Where songs were found, when that was noted
    const sources = data.sources.filter((s) => s.source !== 'unknown').map((s) => `${s.songs} from ${SOURCES[s.source] ?? s.source}`).join(', ');
    const skipped = !totals.skipped ? 'None were skipped.' : totals.songs === 1 ? 'It was skipped.' : `${totals.skipped} of ${totals.songs} were skipped.`;
    const { say, message, announcement } = data.kinds;
    const ways = [say && `${say} said with /say or the web UI`, message && `${message} read out from the speech channel`, announcement && count(announcement, 'announcement')].filter(Boolean).join(', ');
    content.replaceChildren(
      ...[
        tiles,
        note,
        startNote(data),
        chart,
        data.sounds.length > 0 && card('Top sounds', ranked(data.sounds.map((s) => ({ label: s.name, ...counted(s.plays, 'play') })))),
        data.soundPeople.length > 0 && card('Who plays the most sounds', ranked(data.soundPeople.map((p) => ({ label: p.name, ...counted(p.plays, 'sound') })))),
        data.songs.length > 0 &&
          card(
            'Top songs',
            ranked(data.songs.map((s) => ({ label: s.artist ? `${s.title} · ${s.artist}` : s.title, ...counted(s.plays, 'play'), note: s.listenedMs ? `${duration(s.listenedMs)} heard` : null }))),
            el('p', { className: 'hint' }, `Each song heard from its start. ${skipped}${sources ? ` ${sources[0].toUpperCase()}${sources.slice(1)}.` : ''}`),
          ),
        data.artists.length > 0 && card('Top artists', ranked(data.artists.map((a) => ({ label: a.name, ...counted(a.plays, 'song') })))),
        data.djs.length > 0 && card('Who puts music on', ranked(data.djs.map((p) => ({ label: p.name, ...counted(p.songs, 'song') })))),
        data.voices.length > 0 &&
          card('Voices', ranked(data.voices.map((v) => ({ label: v.name, ...counted(v.lines, 'line') }))), ways && el('p', { className: 'hint' }, `${ways[0].toUpperCase()}${ways.slice(1)}. What was said isn’t kept.`)),
        data.effects?.length > 0 && card('Effects', ranked(data.effects.map((e) => ({ label: e.name, ...counted(e.lines, 'line') })))),
        data.speakers.length > 0 && card('Who says the most', ranked(data.speakers.map((p) => ({ label: p.name, ...counted(p.lines, 'line') })))),
        el('p', { className: 'hint' }, 'Only people still in the server are listed.'),
      ].filter(Boolean),
    );
  }

  void show();
}
