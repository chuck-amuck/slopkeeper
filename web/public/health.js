import { dragNote, timeChart } from './charts.js';
import { api, attempt, el, icon, notice, recall, remember, request, state } from './lib.js';
import { rangeBar, rangeFromQuery, rangeQuery } from './rangebar.js';
import { followWhenIdle } from './updates.js';
import { addressWriter } from './viewtabs.js';

/**
 * Health, a tab of its own: how the bot, its containers and the machine they run on have been doing over the last hour, day,
 * week or month, or any stretch of the last 30 days, what held them back, and the slowest things people waited on in
 * this server. It fetches again as each minute is kept
 */

const RANGES = [
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
];
/** How far back the bot keeps its numbers */
const KEPT_MS = 30 * 86_400_000;
/** The week and month only change a point every 15 minutes, as that's how they're kept */
const COARSE_MS = 15 * 60_000;

const CONTAINERS = { bot: 'Bot', web: 'Web UI', voice: 'Voice', music: 'Music', loop: 'Looping room' };
const STATUS = {
  fine: ['Fine', 'check'],
  slow: ['Slow', 'alert'],
  bad: ['Bad', 'x'],
  quiet: ['Nothing yet', null],
  // Something measured, but too little to say whether it's fine
  few: ['Too few to judge', null],
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
const listed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
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
  const { discord, commands, sounds, speech, music, stutter, bot, web, browser } = r;
  // From a bot older than this page, until both are redeployed
  // Taps at home: 0.2 s, away from home: 1.6 s
  const both = (label, a, b, aLabel, bLabel) => {
    const parts = [a !== null && `${aLabel}: ${seconds(a)}`, b !== null && `${bLabel}: ${seconds(b)}`].filter(Boolean);
    return parts.length ? `${label} ${parts.join(', ')}` : null;
  };
  // A line the bot measured too few of to judge, which its status leaves out
  const tooFew = (count) => (browser?.fewest && count < browser.fewest ? ', too few to judge' : '');
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
    browser &&
      tile(
      'Web UI as people see it',
      browser.status,
      browser.taps.count ? seconds(browser.taps.p95) : browser.status === 'quiet' ? 'None' : '–',
      browser.taps.count > 0 && `Taps answered: 95% of ${plural(browser.taps.count, 'tap')}, typically ${seconds(browser.taps.p50)}${tooFew(browser.taps.count)}`,
      both('Taps', browser.home.taps, browser.away.taps, 'at home', 'away from home'),
      both('Taps', browser.phone, browser.computer, 'on phones', 'on computers'),
      browser.networkShare !== null && `${percent(browser.networkShare)} of their wait was the network, not the bot`,
      browser.shown.count > 0 && `Opens within ${seconds(browser.shown.p95)} for 95%${tooFew(browser.shown.count)}`,
      browser.responses.count > 0 && `Reacts to taps within ${seconds(browser.responses.p95)} for 95%${tooFew(browser.responses.count)}`,
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
          c.stallWorst &&
            el(
              'span',
              { className: 'health-note' },
              `Waited for resources ${percent(Math.max(c.stallWorst.cpu ?? 0, c.stallWorst.memory ?? 0, c.stallWorst.io ?? 0))} of the time at worst`,
            ),
          c.throttledWorst > 0 && el('span', { className: 'health-note' }, `Held back by its CPU limit ${percent(c.throttledWorst)} of the time at worst`),
          c.oomKills > 0 && el('span', { className: 'health-note bad-text' }, `${plural(c.oomKills, 'process')} killed for going over its memory limit`),
          el('span', { className: 'health-note' }, c.upNow === false ? 'Not answering' : c.downMinutes > 0 ? `Down ${minutes(c.downMinutes)}` : 'Always up'),
        );
      }),
    ),
  );
}

/**
 * The stretch before's values for each line, laid over this range's points by time, or null without it. `pick(r)`
 * gives { id: values } from a report
 */
function beforeOf(r, pick) {
  const p = r.previous;
  if (!p) return null;
  const theirs = pick(p);
  const span = r.step * r.points;
  return Object.fromEntries(
    Object.entries(theirs).map(([id, values]) => [
      id,
      Array.from({ length: r.points }, (_, i) => {
        const j = Math.round((r.start + i * r.step - span - p.start) / p.step);
        return j >= 0 && j < values.length ? values[j] : null;
      }),
    ]),
  );
}

function charts(r, common) {
  const before = (pick) => beforeOf(r, pick);
  const small = (key, title, part, limit) => smallChart({ ...common, previous: before((x) => ({ [key]: x[part].series })) }, key, title, [{ id: key, label: title, color: 'var(--series-1)', values: r[part].series }], limit);
  const containers = (key, title, field, format) =>
    timeChart({
      ...common,
      key,
      title,
      format,
      series: r.containers.map((c) => ({ id: c.name, label: CONTAINERS[c.name] ?? c.name, color: seriesColor(c.name), values: c[field] })),
      previous: before((x) => Object.fromEntries(x.containers.map((c) => [c.name, c[field]]))),
    });
  return [
    card(
      'Response times, 95th percentile',
      el(
        'div',
        { className: 'health-grid' },
        small('commands', 'Commands answered', 'commands', r.limits.commandAnswer),
        small('sounds', 'Sounds start', 'sounds', r.limits.soundStart),
        small('speech', 'Speech made', 'speech', r.limits.speechMake),
        small('music', 'Music starts', 'music', r.limits.musicStart),
      ),
    ),
    r.browser && browserCard(r, common),
    card('Memory', containers('memory', 'Memory by container', 'memory', bytes)),
    card('CPU', containers('cpu', 'CPU by container, 100% being one core', 'cpu', cpu)),
    r.containers.some((c) => c.stall?.some((v) => v !== null)) &&
      card(
        'Waiting for resources',
        containers('stall', 'Share of the time each container waited for CPU, memory or the disk', 'stall', percent),
        el('p', { className: 'hint' }, 'Time something in the container wanted CPU, memory or the disk and had to wait for it, at whichever was worst. Near nothing is normal.'),
      ),
    card(
      'Discord',
      timeChart({
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
      timeChart({
        ...common,
        key: 'lag',
        title: 'Bot lag',
        format: seconds,
        series: [{ id: 'lag', label: 'Lag', color: 'var(--series-1)', values: r.bot.delay }],
        previous: before((x) => ({ lag: x.bot.delay })),
        limit: { value: r.limits.loopDelay[0], label: `slow from ${seconds(r.limits.loopDelay[0])}` },
      }),
      el('p', { className: 'hint' }, 'How late the bot ran what it meant to do, at its worst. Above a few tenths of a second, sounds and buttons feel slow.'),
      r.bot.gc &&
        r.bot.gc.pauses > 0 &&
        el('p', { className: 'hint' }, `Collecting unused memory paused it ${plural(r.bot.gc.pauses, 'time')}, 95% within ${seconds(r.bot.gc.p95)}, ${percent(r.bot.gc.worst)} of the time at worst.`),
    ),
  ];
}

/** A small chart of 95th percentiles under its own heading, with where it stops being fine */
const smallChart = (common, key, title, series, limit) =>
  el('div', { className: 'health-small' }, el('h3', {}, title), timeChart({ ...common, key, title, series, format: seconds, height: 130, limit: { value: limit[0], label: `slow from ${seconds(limit[0])}` } }));

/** Taps answered and the page opening, at home and away, as people's browsers timed them */
function browserCard(r, common) {
  const { browser, limits } = r;
  const lines = (part) => [
    { id: 'home', label: 'At home', color: 'var(--series-1)', values: browser.home[part] },
    { id: 'away', label: 'Away', color: 'var(--series-2)', values: browser.away[part] },
  ];
  common = { ...common, previous: null };
  return card(
    'Web UI as people see it, 95th percentile',
    el(
      'div',
      { className: 'health-grid' },
      smallChart(common, 'taps', 'Taps answered', lines('tapSeries'), limits.browserTap),
      smallChart(common, 'shown', 'Page opens', lines('shownSeries'), limits.pageShown),
    ),
    el('p', { className: 'hint' }, 'Timed in each person’s browser, from a tap to the bot’s answer arriving, and from opening the page to it being shown. Away is through the internet. It never says whose browser it was.'),
  );
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

const PARTS = { commands: 'commands', sounds: 'sounds', speech: 'speech', music: 'music', stutter: 'audio', bot: 'the bot', web: 'the web UI', browser: 'the web UI in browsers' };

/** One cause of things being held back, in words */
function causeText(c) {
  const who = CONTAINERS[c.container] ?? c.container;
  switch (c.cause) {
    case 'vm-cpu':
      return c.by === 'busy'
        ? `The machine was short of CPU: ${percent(c.value)} of it busy at the worst point.`
        : `Things on the machine waited for CPU ${percent(c.value)} of the time at the worst point.`;
    case 'host-cpu':
      return `The host gave ${percent(c.value)} of the machine’s CPU time to other machines at the worst point.`;
    case 'vm-memory':
      return c.by === 'used'
        ? `The machine was short of memory: ${percent(c.value)} in use at the worst point.`
        : c.by === 'swapping'
          ? `The machine was swapping ${Math.round(c.value).toLocaleString()} pages a second, which slows everything on it.`
          : `Things on the machine waited for memory ${percent(c.value)} of the time at the worst point.`;
    case 'vm-disk':
      return `Things on the machine waited for the disk ${percent(c.value)} of the time at the worst point. Other apps on the same machine reading or writing a lot can do this.`;
    case 'disk-space':
      return `The disk holding the bot’s data is ${percent(c.value)} full.`;
    case 'cpu-limit':
      return `${who} was held back by its CPU limit ${percent(c.value)} of the time at the worst point.`;
    case 'memory-limit':
      return `${who} used ${percent(c.value)} of its memory limit.`;
    case 'out-of-memory':
      return `${who} had ${plural(c.value, 'process')} killed for going over its memory limit.`;
    case 'garbage':
      return `The bot spent ${percent(c.value)} of the time collecting unused memory, which pauses everything it does.`;
    case 'code':
      return `Nothing was short of resources, yet ${listed(c.parts.map((p) => PARTS[p] ?? p))} ${c.parts.length === 1 ? 'was' : 'were'} slow. That’s the bot’s own work or what it waited on, like YouTube or Discord: Slowest recently, below, shows which step took the time.`;
    default:
      return c.cause;
  }
}

/** What held things back in the range, if anything */
function verdictCard(r) {
  const v = r.verdict;
  if (!v) return null;
  const body =
    v.status === 'quiet'
      ? [el('p', {}, 'Nothing measured in this range yet.')]
      : v.causes.length
        ? [el('ul', { className: 'health-causes' }, v.causes.map((c) => el('li', { className: c.status }, statusPill(c.status), el('span', {}, causeText(c)))))]
        : [el('p', {}, 'Nothing held it back: the machine had room to spare, no container reached its limits, and nothing people waited on was slow.')];
  return el(
    'section',
    { className: `card health-verdict ${v.status}` },
    el('div', { className: 'card-head' }, el('h2', {}, 'What held it back?'), statusPill(v.status)),
    el('div', { className: 'card-body' }, ...body),
  );
}

/** The machine the containers run on: its CPU, memory, disk and how much things waited on it */
function machineCard(r, common) {
  const m = r.machine;
  if (!m || !m.heard) return null;
  const before = (pick) => beforeOf(r, (x) => (x.machine ? pick(x.machine) : {}));
  const limitOf = (limit, label) => ({ value: limit[0], label });
  const facts = [
    m.cpus && plural(m.cpus, 'CPU core'),
    m.memory.total && `${bytes(m.memory.total)} of memory${m.memory.usedNow !== null ? `, ${bytes(m.memory.usedNow)} in use now` : ''}`,
    m.memory.swapNow !== null && `${bytes(m.memory.swapNow)} swapped out`,
    m.disk.total && `Disk ${percent(m.disk.used)} full, ${bytes(m.disk.free)} free`,
  ].filter(Boolean);
  return card(
    'The machine it runs on',
    el('p', { className: 'health-note' }, facts.join(' · ')),
    el(
      'div',
      { className: 'health-grid' },
      el(
        'div',
        { className: 'health-small' },
        el('h3', {}, 'CPU'),
        timeChart({
          ...common,
          key: 'vm-cpu',
          title: 'The machine’s CPU',
          format: percent,
          height: 130,
          series: [
            { id: 'busy', label: 'Busy', color: 'var(--series-1)', values: m.cpu.busy },
            { id: 'iowait', label: 'Waiting on the disk', color: 'var(--series-2)', values: m.cpu.iowait },
            { id: 'steal', label: 'Taken by the host', color: 'var(--series-3)', values: m.cpu.steal },
          ],
          previous: before((x) => ({ busy: x.cpu.busy })),
          limit: limitOf(r.limits.vmCpu, `short from ${percent(r.limits.vmCpu[0])} busy`),
        }),
      ),
      el(
        'div',
        { className: 'health-small' },
        el('h3', {}, 'Memory in use'),
        timeChart({
          ...common,
          key: 'vm-memory',
          title: 'The machine’s memory in use',
          format: bytes,
          height: 130,
          series: [{ id: 'used', label: 'In use', color: 'var(--series-1)', values: m.memory.used }],
          previous: before((x) => ({ used: x.memory.used })),
          limit: m.memory.total ? limitOf([r.limits.vmMemory[0] * m.memory.total], `short from ${bytes(r.limits.vmMemory[0] * m.memory.total)}`) : null,
        }),
      ),
      el(
        'div',
        { className: 'health-small' },
        el('h3', {}, 'Waiting for resources'),
        timeChart({
          ...common,
          key: 'vm-stall',
          title: 'Share of the time things on the machine waited',
          format: percent,
          height: 130,
          series: [
            { id: 'io', label: 'Disk', color: 'var(--series-2)', values: m.stall.io },
            { id: 'cpu', label: 'CPU', color: 'var(--series-1)', values: m.stall.cpu },
            { id: 'memory', label: 'Memory', color: 'var(--series-4)', values: m.stall.memory },
          ],
          previous: before((x) => ({ io: x.stall.io })),
          limit: limitOf(r.limits.stallIo, `the disk is slow from ${percent(r.limits.stallIo[0])}`),
        }),
      ),
      el(
        'div',
        { className: 'health-small' },
        el('h3', {}, 'Swapping'),
        timeChart({
          ...common,
          key: 'vm-swap',
          title: 'Pages the machine swapped a second',
          format: (n) => `${Math.round(n).toLocaleString()}/s`,
          height: 130,
          series: [{ id: 'swapping', label: 'Pages a second', color: 'var(--series-1)', values: m.memory.swapping }],
          limit: limitOf(r.limits.swapping, `slow from ${r.limits.swapping[0]} a second`),
        }),
      ),
    ),
    el(
      'p',
      { className: 'hint' },
      'The whole machine, every app on it included. Waiting is time something wanted CPU, memory or the disk and had to wait: a little is normal, a lot means the machine is short of it. Swapping is memory moved to disk and back, which makes everything slow.',
    ),
  );
}

/** How often each preset fetches again: the week and month only change a point every 15 minutes, as that's how they're kept */
const refreshEvery = (range) => (range.preset === '7d' || range.preset === '30d' ? COARSE_MS : 0);

/** The shortest stretch the bot shows */
const SHORTEST_MS = 10 * 60_000;

/** The stretch of the same length just before a report's range */
function previousQuery(r) {
  const span = r.step * r.points;
  return new URLSearchParams({ from: String(r.start - span), to: String(r.start) });
}

/** The Health tab, with its range in the page's address: #health?range=7d */
export function renderHealth(main) {
  const box = el('div', { className: 'stack' });
  main.append(box);
  health(box, { params: new URLSearchParams(location.hash.split('?')[1] ?? ''), write: addressWriter(box, 'health') });
}

/**
 * `address`: the query in the page's address, and `write(params)` to change it, so a reload or a link
 * opens the same range
 */
function health(main, address) {
  const guildId = state.guildId;
  let range = rangeFromQuery(address.params, RANGES) ?? (RANGES.some(([id]) => id === recall('healthRange')) ? { preset: recall('healthRange') } : { preset: '24h' });
  let compare = address.params.get('compare') === '1' || (!address.params.has('range') && recall('healthCompare') === '1');
  let latest = 0;
  let shownAt = 0;
  let version = null;
  let timeZone;
  const content = el('div', { className: 'stack' }, notice('loading', 'Loading health…'));
  // The stretch before only changes as the range moves on, so it's asked for once per stretch
  let earlier = { query: null, report: null };
  const writeAddress = () => address.write(new URLSearchParams({ ...rangeQuery(range), ...(compare && { compare: '1' }) }));
  const bar = rangeBar({
    presets: RANGES,
    value: range,
    earliestMs: KEPT_MS,
    compare,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onChange: (picked) => {
      range = picked;
      if (picked.preset) remember('healthRange', picked.preset);
      writeAddress();
      void show();
    },
    onCompare: (on) => {
      compare = on;
      remember('healthCompare', on ? '1' : '0');
      writeAddress();
      void show();
    },
  });
  main.append(el('div', { className: 'toolbar range-toolbar' }, bar.node), content);
  writeAddress();

  function render(r) {
    const common = { start: r.start, step: r.step, timeLabel: timeLabeller(r.step, r.timeZone), timeZone: r.timeZone, onPick: zoom };
    content.replaceChildren(
      ...[
        compare && !r.previous && el('p', { className: 'hint' }, 'Health keeps the last 30 days, so there’s nothing before this to compare with.'),
        verdictCard(r),
        // What the verdict and all under it are about
        el('p', { className: 'hint stats-note' }, 'All but the slow list cover the whole bot, which every server it’s in shares. Fine, slow and bad are judged over the range picked.'),
        tiles(r),
        containersCard(r),
        machineCard(r, common),
        // An older bot sends no browser or machine part, which would print as false
        ...charts(r, common),
        dragNote('a chart') && el('p', { className: 'hint' }, dragNote('a chart').trim()),
        slowCard(r),
      ].filter(Boolean),
    );
  }

  /** A stretch dragged across a chart, made at least the 10 minutes the bot shows, around its middle */
  function zoom(from, to) {
    const middle = (from + to) / 2;
    const span = Math.max(to - from, SHORTEST_MS);
    const end = Math.min(Date.now(), middle + span / 2);
    void bar.zoom(Math.round(end - span), Math.round(end));
  }

  async function show() {
    const ticket = ++latest;
    content.classList.add('refreshing');
    await attempt(async () => {
      try {
        const r = await request(api(`/health?${new URLSearchParams(rangeQuery(range))}`));
        if (compare) {
          const query = String(previousQuery(r));
          if (earlier.query !== query) {
            const report = await request(api(`/health?${query}`)).catch(() => null);
            // Mostly older than Health keeps, it'd be a sliver at the start of the charts
            earlier = { query, report: report && report.step * report.points >= (r.step * r.points) / 2 ? report : null };
          }
          r.previous = earlier.report;
        }
        if (ticket !== latest || guildId !== state.guildId || !main.isConnected) return;
        version = r.version;
        shownAt = Date.now();
        if (r.timeZone !== timeZone) bar.timeZone((timeZone = r.timeZone));
        render(r);
      } catch (err) {
        if (ticket === latest) content.replaceChildren(notice('error', err.message));
        throw err;
      } finally {
        if (ticket === latest) content.classList.remove('refreshing');
      }
    });
  }

  // Each minute kept: a preset up to now shows it, the week and month only once a point of theirs could have changed.
  // Picked dates and zooms stay as they are. Not while someone's reading a chart, which a redraw would take from them
  const reading = () => !!content.querySelector('.echart-box:hover, .echart-box:focus-visible, .echart-box:focus-within');
  followWhenIdle(
    'health',
    main,
    () => [content],
    (data) => {
      if (!version || data.version === version || !range.preset) return;
      if (Date.now() - shownAt < refreshEvery(range)) return;
      void show();
    },
    reading,
  );
  void show();
}
