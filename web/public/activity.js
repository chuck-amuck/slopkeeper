import { api, attempt, el, request, state } from './lib.js';

const EMPTY = 'Nothing yet. Changes to sounds, settings and game nights show up here from now on.';

const when = (ms, timeZone) => new Date(ms).toLocaleString(undefined, { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function renderActivity(main) {
  const guildId = state.guildId;
  const list = el('div', { className: 'list' }, el('div', { className: 'empty' }, 'Loading activity…'));
  const older = el('button', { hidden: true, onclick: () => attempt(load) }, 'Show older');
  main.append(el('p', { className: 'page-note' }, 'Changes show who made them: in Discord, or here when signed in. Changes from the home network address show as Web UI.'), list, older);
  let last;

  async function load() {
    older.disabled = true;
    try {
      const data = await request(api(`/activity${last ? `?before=${last}` : ''}`));
      if (guildId !== state.guildId || !main.isConnected) return;
      const rows = data.entries.map((entry) =>
        el('div', { className: 'event' }, el('time', {}, when(entry.at, data.timeZone)), el('span', { className: 'event-who' }, entry.who), el('span', { className: 'event-what' }, entry.action)),
      );
      if (last) list.append(...rows);
      else list.replaceChildren(...(rows.length ? rows : [el('div', { className: 'empty' }, EMPTY)]));
      last = data.entries.at(-1)?.id;
      older.hidden = !data.more;
    } finally {
      older.disabled = false;
    }
  }

  void attempt(async () => {
    try {
      await load();
    } catch (err) {
      list.replaceChildren(el('div', { className: 'empty' }, err.message));
      throw err;
    }
  });
}
