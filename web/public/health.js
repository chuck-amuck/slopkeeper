import { api, attempt, el, icon, notice, recall, remember, request, state } from './lib.js';
import { lineChart } from './linechart.js';
import { followWhenIdle } from './updates.js';

/**
 * Stats → Health: how the bot and its containers have been doing over the last hour, day, week or month, and the
 * slowest things people waited on in this server. It fetches again as each minute is kept
 */

const RANGES = [
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];
/** The week and month only change a point every 15 minutes, as that's how they're kept */
const COARSE_MS = 15 * 60_000;

const CONTAINERS = { bot: 'Bot', web: 'Web UI', voice: 'Voice', music: 'Music', loop: 'Looping room' };
const STATUS = {
  fine: ['Fine', 'check'],
  slow: ['Slow', 'alert'],
  bad: ['Bad', 'x'],
  quiet: ['Nothing yet', null],
};

export function seconds(s) {
  if (s === null || s === undefined) return '–';
  if (s < 1) return `${Math.max(1, Math.round(s * 1000))} ms`;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}
export function bytes(n) {
  if (n === null || n === undefined) return '–';
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}
/** CPU as docker stats shows it: 100% is one core */
const cpu = (cores) => (cores === null ? '–' : `${Math.round(cores * 100)}%`);
export function percent(share) {
  if (share === null || share === undefined) return '–';
  const p = share * 100;
  if (p > 0 && p < 0.1) return 'under 0.1%';
  return p > 0 && p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const minutes = (m) => (m < 1 ? `${Math.round(m * 60)} s` : m < 120 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

/** Times as fine as the range's points */
function timeLabeller(step, timeZone) {
  const options =
    step < 15 * 60_000
      ? { hour: 'numeric', minute: '2-digit' }
      : step < 3_600_000
        ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: 'numeric', ...(step < 6 * 3_600_000 && { minute: '2-digit' }) };
  const format = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
  return (ms) => format.format(ms);
}

function statusPill(status) {
  const [label, name] = STATUS[status] ?? STATUS.quiet;
  return el('span', { className: `health-status ${status}` }, name && icon(name), label);
}

function tile(title, status, value, ...notes) {
  return el(
    'div',
    { className: `health-tile ${status}` },
    el('div', { className: 'health-tile-head' }, el('span', { className: 'stat-label' }, title), statusPill(status)),
    el('div', { className: 'stat-value' }, value),
    notes.filter(Boolean).map((note) => el('div', { className: 'health-note' }, note)),
  );
}

function tiles(r) {
  const { discord, commands, sounds, speech, music, stutter, bot, web } = r;
  return el(
    'div',
    { className: 'health-tiles' },
    tile(
      'Discord',
      discord.status,
      discord.connectedNow === null ? '–' : discord.connectedNow ? 'Connected' : 'Disconnected',
      discord.pingNow !== null && `Ping ${seconds(discord.pingNow)}`,
      discord.downMinutes > 0 ? `Away ${minutes(discord.downMinutes)} in all` : 'Never away',
      discord.reconnects > 0 && `${plural(discord.reconnects, 'reconnect')}, mostly Discord asking`,
    ),
    tile(
      'Commands and buttons',
      commands.status,
      commands.total ? `${percent(commands.inTime)} in time` : 'None',
      commands.total > 0 && `${plural(commands.total, 'answer')}, 95% within ${seconds(commands.p95)}`,
      commands.failed > 0 && `${commands.failed} failed`,
      commands.expired > 0 && `${commands.expired} too late for Discord`,
    ),
    tile('Sounds start', sounds.status, sounds.count ? seconds(sounds.p95) : 'None', sounds.count > 0 && `95% of ${plural(sounds.count, 'sound')}, typically ${seconds(sounds.p50)}`),
    tile(
      'Speech made',
      speech.status,
      speech.count ? seconds(speech.p95) : speech.lines ? '–' : 'None',
      speech.count > 0 && `95% of lines up to 300 characters, typically ${seconds(speech.p50)}`,
      speech.lines > 0 && `${plural(speech.lines, 'line')} said`,
      speech.failures > 0 && `${speech.failures} failed`,
      speech.modelLoads > 0 && `${plural(speech.modelLoads, 'voice')} loaded, 95% within ${seconds(speech.modelLoadP95)}`,
    ),
    tile(
      'Music starts',
      music.status,
      music.count ? seconds(music.p95) : 'None',
      music.count > 0 && `95% of ${plural(music.count, 'song')}, typically ${seconds(music.p50)}`,
      music.kept + music.downloaded > 0 && `${music.kept} already saved, ${music.downloaded} downloaded`,
    ),
    tile('Stutter', stutter.status, stutter.frames ? percent(stutter.share) : 'None', stutter.frames > 0 && 'of the audio mixed late, which people hear as a stutter'),
    tile(
      'Bot',
      bot.status,
      bot.worstDelay === null ? '–' : seconds(bot.worstDelay),
      'Its worst lag at any point',
      bot.busy !== null && `Busy ${percent(bot.busy)} of the time`,
      bot.heapNow !== null && `${bytes(bot.heapNow)} of JavaScript memory`,
    ),
    tile(
      'Web UI',
      web.status,
      web.requests ? `${percent(1 - web.errors / web.requests)} OK` : 'None',
      web.requests > 0 && `${plural(web.requests, 'request')}${web.errors ? `, ${web.errors} failed` : ''}`,
      web.apiP95 !== null && `Bot answers 95% within ${seconds(web.apiP95)}`,
      web.unreachable > 0 && `Couldn’t reach the bot ${plural(web.unreachable, 'time')}`,
    ),
  );
}

const card = (title, ...children) => el('section', { className: 'card' }, el('h2', {}, title), el('div', { className: 'card-body' }, ...children));
const seriesColor = (name) => `var(--series-${Object.keys(CONTAINERS).indexOf(name) + 1 || 6})`;

function containersCard(r) {
  if (!r.containers.length) return card('Containers', notice('empty', 'No container has reported yet.'));
  return card(
    'Containers',
    el(
      'div',
      { className: 'health-containers' },
      r.containers.map((c) => {
        const share = c.memoryLimit && c.memoryNow !== null ? Math.min(1, c.memoryNow / c.memoryLimit) : null;
        return el(
          'div',
          { className: 'health-container' },
          el('div', { className: 'health-container-name' }, el('span', { className: 'line-key', style: `background: ${seriesColor(c.name)}` }), CONTAINERS[c.name] ?? c.name, statusPill(c.upNow === false ? 'bad' : c.status)),
          el(
            'div',
            { className: 'health-memory' },
            el('span', { className: 'rank-track' }, share !== null && el('span', { className: `rank-bar ${share >= r.limits.memory[1] ? 'bad' : share >= r.limits.memory[0] ? 'slow' : ''}`, style: `width: ${Math.max(1, share * 100)}%` })),
            el('span', { className: 'health-note' }, `${bytes(c.memoryNow)}${c.memoryLimit ? ` of ${bytes(c.memoryLimit)}` : ''}, peak ${bytes(c.memoryPeak)}`),
          ),
          el('span', { className: 'health-note' }, `CPU ${cpu(c.cpuAverage)}, peak ${cpu(c.cpuPeak)}`),
          el('span', { className: 'health-note' }, c.upNow === false ? 'Not answering' : c.downMinutes > 0 ? `Down ${minutes(c.downMinutes)}` : 'Always up'),
        );
      }),
    ),
  );
}

function charts(r, timeLabel) {
  const common = { start: r.start, step: r.step, timeLabel };
  const slowFrom = (limit) => ({ value: limit[0], label: `slow from ${seconds(limit[0])}` });
  const small = (key, title, timing, limit) =>
    el('div', { className: 'health-small' }, el('h3', {}, title), lineChart({ ...common, key, title, series: [{ id: key, label: title, color: 'var(--series-1)', values: timing.series }], format: seconds, limit: slowFrom(limit) }));
  const containers = (key, title, field, format) =>
    lineChart({ ...common, key, title, format, series: r.containers.map((c) => ({ id: c.name, label: CONTAINERS[c.name] ?? c.name, color: seriesColor(c.name), values: c[field] })) });
  return [
    card(
      'Response times, 95th percentile',
      el(
        'div',
        { className: 'health-grid' },
        small('commands', 'Commands answered', r.commands, r.limits.commandAnswer),
        small('sounds', 'Sounds start', r.sounds, r.limits.soundStart),
        small('speech', 'Speech made', r.speech, r.limits.speechMake),
        small('music', 'Music starts', r.music, r.limits.musicStart),
      ),
    ),
    card('Memory', containers('memory', 'Memory by container', 'memory', bytes)),
    card('CPU', containers('cpu', 'CPU by container, 100% being one core', 'cpu', cpu)),
    card(
      'Discord',
      lineChart({
        ...common,
        key: 'discord',
        title: 'Discord ping',
        format: seconds,
        series: [{ id: 'ping', label: 'Ping', color: 'var(--series-1)', values: r.discord.ping }],
        bands: r.discord.connected.map((c) => (c === null ? 0 : 1 - c)),
        bandLabel: 'Away from Discord',
      }),
      el('p', { className: 'hint' }, 'The line is the time Discord takes to answer the bot. Red shading is time away from Discord.'),
    ),
    card(
      'Bot lag',
      lineChart({ ...common, key: 'lag', title: 'Bot lag', format: seconds, series: [{ id: 'lag', label: 'Lag', color: 'var(--series-1)', values: r.bot.delay }], limit: { value: r.limits.loopDelay[0], label: `slow from ${seconds(r.limits.loopDelay[0])}` } }),
      el('p', { className: 'hint' }, 'How late the bot ran what it meant to do, at its worst. Above a few tenths of a second, sounds and buttons feel slow.'),
    ),
  ];
}

const STEP_NAMES = { waiting: 'waiting behind others' };
function detailText(what, detail) {
  const parts = [];
  if (detail.sound) parts.push(`“${detail.sound}”`);
  if (detail.voice) parts.push(detail.voice);
  if (detail.characters) parts.push(plural(detail.characters, 'character'));
  if (detail.waitingAhead) parts.push(`${detail.waitingAhead} ahead of it`);
  if (detail.source) parts.push(`from ${detail.source}`);
  // Speech is kept a while after it's made, and music once it's downloaded
  if (detail.kept === true) parts.push(what === 'Speech' ? 'made a moment before' : 'already saved');
  if (detail.kept === false && what === 'Music') parts.push('downloaded');
  if (detail.sharedWithAnother) parts.push('made for another line too');
  return parts.join(' · ');
}

/** Each step, then the parts of it, which are noted before the step they're part of closes, with how deep each is */
function inOrder(steps) {
  const parts = (step) => steps.filter(([, , of]) => of === step);
  const placed = new Set();
  const listed = [];
  const place = (step, depth) => {
    if (placed.has(step) || depth > 5) return;
    placed.add(step);
    listed.push({ step, depth });
    for (const part of parts(step[0])) place(part, depth + 1);
  };
  for (const step of steps) if (!step[2]) place(step, 0);
  // A part whose step never closed
  for (const step of steps) place(step, 0);
  return listed;
}

function slowCard(r) {
  let order = recall('healthSlowOrder') === 'newest' ? 'newest' : 'slowest';
  const list = el('div', { className: 'health-slow' });
  const longest = Math.max(1e-3, ...r.slow.map((s) => s.seconds));
  const when = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: r.timeZone });
  const paint = () => {
    const rows = [...r.slow].sort((a, b) => (order === 'newest' ? b.at - a.at : b.own - a.own)).slice(0, 20);
    list.replaceChildren(
      ...(rows.length
        ? rows.map((s) => {
            const waited = s.seconds - s.own;
            const steps = el(
              'ul',
              { className: 'health-steps', hidden: true },
              inOrder(s.steps).map(({ step: [name, took], depth }) =>
                el('li', { className: depth ? 'part' : '', style: `padding-left: ${depth * 16}px` }, el('span', {}, STEP_NAMES[name] ?? name), el('span', {}, seconds(took))),
              ),
            );
            const detail = detailText(s.what, s.detail);
            const open = s.steps.length > 0;
            return el(
              'div',
              { className: 'health-slow-item' },
              el(
                open ? 'button' : 'div',
                {
                  className: 'health-slow-row',
                  ...(open && {
                    type: 'button',
                    ariaExpanded: 'false',
                    onclick: (e) => {
                      steps.hidden = !steps.hidden;
                      e.currentTarget.ariaExpanded = String(!steps.hidden);
                    },
                  }),
                },
                el('span', { className: 'health-slow-what' }, el('strong', {}, s.what), el('span', { className: 'health-note' }, [when.format(s.at), detail].filter(Boolean).join(' · '))),
                el(
                  'span',
                  { className: 'health-slow-bar', title: waited > 0.05 ? `Waited ${seconds(waited)}, then took ${seconds(s.own)}` : `Took ${seconds(s.own)}` },
                  waited > 0.05 && el('span', { className: 'waited', style: `width: ${(waited / longest) * 100}%` }),
                  el('span', { className: 'own', style: `width: ${Math.max(0.5, (s.own / longest) * 100)}%` }),
                ),
                el('span', { className: 'health-slow-time' }, el('strong', {}, seconds(s.own)), waited > 0.05 && el('span', { className: 'health-note' }, `+ ${seconds(waited)} waiting`)),
              ),
              steps,
            );
          })
        : [el('p', { className: 'hint' }, 'Nothing slow in this range.')]),
    );
  };
  const toggle = el(
    'div',
    { className: 'views small' },
    [
      ['slowest', 'Slowest'],
      ['newest', 'Newest'],
    ].map(([id, label]) =>
      el(
        'button',
        {
          type: 'button',
          ariaPressed: String(order === id),
          onclick: (e) => {
            order = id;
            remember('healthSlowOrder', id);
            for (const b of e.currentTarget.parentNode.children) b.ariaPressed = String(b === e.currentTarget);
            paint();
          },
        },
        label,
      ),
    ),
  );
  paint();
  return el(
    'section',
    { className: 'card' },
    el('div', { className: 'card-head' }, el('h2', {}, 'Slowest recently'), toggle),
    el(
      'div',
      { className: 'card-body' },
      list,
      el('p', { className: 'hint' }, 'In this server. Time a line spent waiting behind other lines is shown in grey and doesn’t count. Tap one for its steps.'),
    ),
  );
}

export function health(main) {
  const guildId = state.guildId;
  let range = RANGES.some(([id]) => id === recall('healthRange')) ? recall('healthRange') : '24h';
  let latest = 0;
  let shownAt = 0;
  let version = null;
  const content = el('div', { className: 'stack' }, notice('loading', 'Loading health…'));
  const buttons = el(
    'div',
    { className: 'views', role: 'group', ariaLabel: 'Time range' },
    RANGES.map(([id, label]) =>
      el(
        'button',
        {
          type: 'button',
          ariaPressed: String(id === range),
          onclick: (e) => {
            range = id;
            remember('healthRange', id);
            for (const b of buttons.children) b.ariaPressed = String(b === e.currentTarget);
            void show();
          },
        },
        label,
      ),
    ),
  );
  main.append(el('div', { className: 'toolbar' }, buttons), content);

  function render(r) {
    const timeLabel = timeLabeller(r.step, r.timeZone);
    content.replaceChildren(
      tiles(r),
      containersCard(r),
      ...charts(r, timeLabel),
      slowCard(r),
      el('p', { className: 'hint' }, 'All but the slow list cover the whole bot, which every server it’s in shares. Fine, slow and bad are judged over the range picked.'),
    );
  }

  async function show() {
    const ticket = ++latest;
    content.classList.add('refreshing');
    await attempt(async () => {
      try {
        const r = await request(api(`/health?range=${range}`));
        if (ticket !== latest || guildId !== state.guildId || !main.isConnected) return;
        version = r.version;
        shownAt = Date.now();
        render(r);
      } catch (err) {
        if (ticket === latest) content.replaceChildren(notice('error', err.message));
        throw err;
      } finally {
        if (ticket === latest) content.classList.remove('refreshing');
      }
    });
  }

  // Each minute kept: the hour and day show it, the week and month only once a point of theirs could have changed. Not
  // while someone's reading a chart, which a redraw would take from them, but once they're done
  const reading = () => !!content.querySelector('.line-plot:hover, .line-plot:focus-visible');
  followWhenIdle(
    'health',
    main,
    () => [content],
    (data) => {
      if (!version || data.version === version) return;
      if ((range === '7d' || range === '30d') && Date.now() - shownAt < COARSE_MS) return;
      void show();
    },
    reading,
  );
  void show();
}
