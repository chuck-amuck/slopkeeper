import { api, attempt, el, notice, request, state } from './lib.js';
import { follow } from './updates.js';

const EMPTY = 'Nothing yet. Changes to sounds, settings and game nights show up here from now on.';

// What a change is about, from the bot's wording, tried in this order: a game night's ping is about the night, and
// setting someone's join sound is about sounds, not settings. Entries are stored as text, so older ones sort the same way
const RULES = [
  ['nights', /\bnight\b/i],
  ['sounds', /^(Set|Cleared) (the emoji on|the volume of|their join sound)|’s join sound/i],
  ['settings', /^Set |^Put .* back to the default/i],
  // Turning someone's game pings on or off
  ['pings', /\bpings?\b|^Turned /i],
  ['music', /\bmusic\b|^(Played the file|Skipped) /i],
  ['games', /game (library|vote)|\b(owning|wanting)\b|suggest|\bSteam\b|^Merged |^Separated |^Changed the details of |^Hid /i],
  ['sounds', /\bsounds?\b|soundboard|\bline\b|emoji|panel|^Renamed |^Said /i],
];
const AREAS = [
  ['nights', 'Game nights'],
  ['games', 'Games'],
  ['sounds', 'Sounds'],
  ['music', 'Music'],
  ['pings', 'Pings'],
  ['settings', 'Settings'],
  ['other', 'Everything else'],
];
const areaOf = (action) => RULES.find(([, pattern]) => pattern.test(action))?.[0] ?? 'other';

// In this browser's time zone, as the rest of the page and Discord itself show times
const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayKey = (ms) => new Date(ms).toDateString();

function dayHeading(ms) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(ms) === today.toDateString()) return 'Today';
  if (dayKey(ms) === yesterday.toDateString()) return 'Yesterday';
  const sameYear = new Date(ms).getFullYear() === today.getFullYear();
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(!sameYear && { year: 'numeric' }) });
}

export function renderActivity(main) {
  const guildId = state.guildId;
  const list = el('div', { className: 'activity' }, notice('loading', 'Loading activity…'));
  const older = el('button', { hidden: true, onclick: () => attempt(load) }, 'Show older');
  const area = el(
    'select',
    { ariaLabel: 'Show changes to', onchange: () => paint() },
    el('option', { value: '' }, 'Everything'),
    AREAS.map(([id, label]) => el('option', { value: id }, label)),
  );
  main.append(
    el('p', { className: 'page-note' }, 'Changes show who made them: in Discord, or here when signed in. Changes from the home network address show as Web UI. Times are in your time zone.'),
    el('div', { className: 'toolbar' }, el('span', { className: 'voice-label' }, 'Show'), area),
    list,
    older,
  );
  const entries = [];
  let last;
  let loaded = false;
  // The newest page heard while the first was loading, put on top of it once it has
  let early = null;

  // New entries from anywhere go on top, keeping the older ones loaded. After more than a page of them at once, the
  // list starts again from the newest, rather than leave a gap
  follow('activity', main, (data) => {
    if (guildId !== state.guildId) return;
    if (!loaded) return void (early = data);
    addNewest(data);
  });

  function addNewest(data) {
    const newest = entries[0]?.id ?? 0;
    const fresh = data.entries.filter((e) => e.id > newest);
    if (!fresh.length) return;
    if (fresh.length === data.entries.length && data.more) {
      entries.splice(0, entries.length, ...data.entries);
      last = data.entries.at(-1)?.id;
      older.hidden = false;
    } else entries.unshift(...fresh);
    paint();
  }

  function paint() {
    const shown = entries.filter((e) => !area.value || areaOf(e.action) === area.value);
    if (!shown.length) {
      list.replaceChildren(notice('empty', entries.length ? `Nothing about ${area.selectedOptions[0].textContent.toLowerCase()} in what’s loaded${older.hidden ? '' : '. Show older looks further back'}.` : EMPTY));
      return;
    }
    const days = [];
    for (const entry of shown) {
      if (days.at(-1)?.key !== dayKey(entry.at)) days.push({ key: dayKey(entry.at), at: entry.at, rows: [] });
      days.at(-1).rows.push(entry);
    }
    list.replaceChildren(
      ...days.map((day) =>
        el(
          'section',
          { className: 'activity-day' },
          el('h2', {}, dayHeading(day.at)),
          el(
            'div',
            { className: 'list' },
            day.rows.map((entry) =>
              el('div', { className: 'event' }, el('time', { dateTime: new Date(entry.at).toISOString() }, time(entry.at)), el('span', { className: 'event-who' }, entry.who), el('span', { className: 'event-what' }, entry.action)),
            ),
          ),
        ),
      ),
    );
  }

  async function load() {
    older.disabled = true;
    try {
      const data = await request(api(`/activity${last ? `?before=${last}` : ''}`));
      if (guildId !== state.guildId || !main.isConnected) return;
      entries.push(...data.entries);
      last = data.entries.at(-1)?.id;
      older.hidden = !data.more;
      paint();
      if (!loaded && early) addNewest(early);
      loaded = true;
      early = null;
    } finally {
      older.disabled = false;
    }
  }

  void attempt(async () => {
    try {
      await load();
    } catch (err) {
      list.replaceChildren(notice('error', err.message));
      throw err;
    }
  });
}
