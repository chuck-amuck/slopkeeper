import { api, attempt, confirmButton, el, request, state, toast } from './lib.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FIELDS = {
  announceChannel: { kind: 'channel', none: 'Not set', hint: 'Where hop-on pings, recaps, leaderboards and sale alerts are posted. Nothing is posted until this is set.' },
  timezone: { kind: 'timezone', hint: 'Used for scheduled posts, leaderboards and game nights.' },
  hopOnRole: { kind: 'role', none: 'None', hint: 'Pinged when people hop in voice. People opt in with /notify.' },
  hopOnMinPeople: { kind: 'number', unit: 'people', hint: 'People in a voice channel before pinging.' },
  hopOnCooldownMin: { kind: 'number', unit: 'min', hint: 'Time between pings.' },
  recapMinMinutes: { kind: 'number', unit: 'min', hint: 'Shorter sessions don’t get a recap or count in stats.' },
  sessionGraceMin: { kind: 'number', unit: 'min', hint: 'How long a channel stays empty before its session ends.' },
  weeklyPostDay: { kind: 'day' },
  weeklyPostHour: { kind: 'hour', hint: 'In the server’s time zone. The monthly recap posts at this hour too.' },
  monthlyRecap: { kind: 'boolean', hint: 'Posts a recap of the month on the 1st.' },
  steamCountry: { kind: 'country', hint: 'Two-letter country code for sale prices, like us or gb.' },
  saleMinDiscount: { kind: 'number', unit: '% off', hint: 'Smaller sales aren’t posted, but still show in /sales.' },
  saleSteamWishlists: { kind: 'boolean', hint: 'Watches games on members’ Steam wishlists, if their profile allows it.' },
  saleChannel: { kind: 'channel', none: 'Same as announce channel', hint: 'Post sales here instead.' },
  freeGames: { kind: 'boolean', hint: 'Posts free-to-keep games on Steam, Epic and GOG.' },
  freeGamesChannel: { kind: 'channel', none: 'Same as announce channel', hint: 'Post free games here instead.' },
  freeGamesMinRating: { kind: 'number', unit: '% positive', hint: 'From at least 50 Steam reviews. 0 turns this off.' },
  freeGamesTaste: { kind: 'boolean', hint: 'Compares Steam tags with the games this server plays most.' },
  freeGamesMultiplayer: { kind: 'boolean', hint: 'Skips games with no multiplayer or co-op.' },
  freeGamesUnlisted: { kind: 'boolean', hint: 'Shows games with no Steam page, which can’t be rated or compared.' },
  gameNightReminderMin: { kind: 'number', unit: 'min before', hint: 'Pings the people who are in. 0 turns reminders off.' },
  evenVolume: { kind: 'boolean', hint: 'Levels sounds so they play about as loud as each other. Your files aren’t changed, so this can be turned off at any time.' },
  joinSounds: { kind: 'boolean', hint: 'Lets people pick a sound that plays when they join voice, with /sound join.' },
  joinSoundCooldownMin: { kind: 'number', unit: 'min', hint: 'Shortest time between one person’s join sounds.' },
  soundManagerRole: { kind: 'role', none: 'Everyone', hint: 'Who can change sounds in Discord, along with people with Manage Server. Anyone can still play them. This page isn’t limited by it: it only asks for the password.' },
};

const GROUPS = [
  ['Posting', ['announceChannel', 'timezone']],
  ['Hop-on pings', ['hopOnRole', 'hopOnMinPeople', 'hopOnCooldownMin']],
  ['Voice sessions', ['recapMinMinutes', 'sessionGraceMin']],
  ['Leaderboard and recap', ['weeklyPostDay', 'weeklyPostHour', 'monthlyRecap']],
  ['Games', ['steamCountry', 'gameNightReminderMin']],
  ['Sale alerts', ['saleMinDiscount', 'saleSteamWishlists', 'saleChannel']],
  ['Free games', ['freeGames', 'freeGamesChannel', 'freeGamesMinRating', 'freeGamesTaste', 'freeGamesMultiplayer', 'freeGamesUnlisted']],
  ['Soundboard', ['evenVolume', 'joinSounds', 'joinSoundCooldownMin', 'soundManagerRole']],
];

export function renderSettings(main) {
  const guildId = state.guildId;
  const loading = el('div', { className: 'empty' }, 'Loading settings…');
  main.append(loading);
  const fields = new Map();

  function control(setting, spec, data, save) {
    const value = setting.value;
    const change = (e) => save(e.target.value);
    const select = (options) =>
      el(
        'select',
        { id: `setting-${setting.key}`, onchange: change },
        options.map(([id, label]) => el('option', { value: id, selected: String(value ?? '') === String(id) }, label)),
      );
    switch (spec.kind) {
      case 'channel':
        return select([['', spec.none], ...data.channels.map((c) => [c.id, c.category ? `#${c.name} (${c.category})` : `#${c.name}`])]);
      case 'role':
        return select([['', spec.none], ...data.roles.map((r) => [r.id, `@${r.name}`])]);
      case 'day':
        return select(DAYS.map((day, idx) => [idx, day]));
      case 'hour':
        return select(Array.from({ length: 24 }, (_, hour) => [hour, `${String(hour).padStart(2, '0')}:00`]));
      case 'boolean':
        return el('label', { className: 'toggle' }, el('input', { id: `setting-${setting.key}`, type: 'checkbox', checked: value, onchange: (e) => save(e.target.checked) }));
      case 'number':
        return el('input', {
          id: `setting-${setting.key}`,
          type: 'number',
          value,
          min: setting.limits?.[0],
          max: setting.limits?.[1],
          step: 1,
          required: true,
          onchange: (e) => save(Number(e.target.value)),
        });
      case 'timezone':
        return el('input', { id: `setting-${setting.key}`, value, list: 'time-zones', autocomplete: 'off', spellcheck: false, onchange: change });
      case 'country':
        return el('input', { id: `setting-${setting.key}`, value, maxLength: 2, autocomplete: 'off', spellcheck: false, onchange: change });
      default:
        return typeof value === 'boolean'
          ? el('label', { className: 'toggle' }, el('input', { id: `setting-${setting.key}`, type: 'checkbox', checked: value, onchange: (e) => save(e.target.checked) }))
          : el('input', { id: `setting-${setting.key}`, value: value ?? '', onchange: (e) => save(typeof value === 'number' ? Number(e.target.value) : e.target.value) });
    }
  }

  function field(setting, data) {
    const spec = FIELDS[setting.key] ?? {};
    const box = el('div', { className: 'control' });
    const status = el('div', { className: 'status' });
    const message = el('div', { className: 'message', hidden: true });

    const say = (text, bad) => {
      message.hidden = !text;
      message.textContent = text ?? '';
      message.className = bad ? 'message bad' : 'message';
    };

    const refresh = async () => {
      const fresh = await request(api('/settings'));
      if (guildId !== state.guildId || !main.isConnected) return;
      for (const [key, update] of fields) update(fresh.settings.find((s) => s.key === key), fresh);
      if (setting.key.startsWith('freeGames')) void paintFreeGames();
      if (setting.key.startsWith('sale')) void paintSales();
    };

    const save = (value) =>
      attempt(async () => {
        say(null);
        try {
          // An empty channel or role picker is the same as never having picked one
          const { warning } =
            value === '' ? await request(api(`/settings/${setting.key}`), { method: 'DELETE' }) : await request(api(`/settings/${setting.key}`), { method: 'PUT', json: { value } });
          say(warning);
          toast(`${setting.label} saved.`);
        } catch (err) {
          say(err.message, true);
        }
        await refresh();
      });

    const reset = () =>
      attempt(async () => {
        say(null);
        await request(api(`/settings/${setting.key}`), { method: 'DELETE' });
        toast(`${setting.label} is back to the default.`);
        await refresh();
      });

    const update = (current, fresh) => {
      const nodes = [control(current, spec, fresh, save)];
      if (spec.unit) nodes.push(el('span', { className: 'unit' }, spec.unit));
      box.replaceChildren(...nodes);
      status.replaceChildren(el('span', {}, current.source === 'set here' ? 'Set for this server' : current.source === 'default' ? 'Default' : `From ${current.source}`));
      if (current.source === 'set here') status.append(el('button', { className: 'link', onclick: reset }, 'Reset'));
    };

    update(setting, data);
    fields.set(setting.key, update);
    return el(
      'div',
      { className: 'field' },
      el('div', {}, el('label', { htmlFor: `setting-${setting.key}` }, setting.label), spec.hint && el('p', { className: 'hint' }, spec.hint)),
      box,
      status,
      message,
    );
  }

  const freeBody = el('div');

  async function paintFreeGames() {
    try {
      const { games } = await request(api('/free-games'));
      if (guildId !== state.guildId || !main.isConnected) return;
      freeBody.replaceChildren(
        ...(games.length
          ? games.map((g) =>
              el(
                'div',
                { className: 'free-game' },
                g.url.startsWith('https://') ? el('a', { href: g.url, target: '_blank', rel: 'noreferrer' }, g.title) : el('span', {}, g.title),
                el('span', { className: g.show ? 'free-reason' : 'free-reason hidden-game' }, g.show ? `Posted${g.reason ? `: ${g.reason}` : ''}` : `Hidden: ${g.reason}`),
              ),
            )
          : [el('p', { className: 'card-note empty-note' }, 'Nothing is free to keep right now.')]),
      );
    } catch (err) {
      freeBody.replaceChildren(el('p', { className: 'card-note empty-note' }, err.message));
    }
  }

  function freeGamesCard() {
    freeBody.append(el('p', { className: 'card-note empty-note' }, 'Checking what’s free…'));
    void paintFreeGames();
    return el('section', { className: 'card' }, el('h2', {}, 'Free games right now'), freeBody);
  }

  const salesBody = el('div');

  async function paintSales() {
    try {
      const { games } = await request(api('/sales'));
      if (guildId !== state.guildId || !main.isConnected) return;
      salesBody.replaceChildren(
        ...(games.length
          ? games.map((g) =>
              el(
                'div',
                { className: 'free-game' },
                el('a', { href: g.url, target: '_blank', rel: 'noreferrer' }, g.name),
                el('span', { className: 'free-reason' }, `${g.discount}% off, ${g.price}, was ${g.was}`),
                g.why && el('span', { className: 'sale-why' }, g.why),
              ),
            )
          : [el('p', { className: 'card-note empty-note' }, 'Nothing this server plays or wants is on sale right now.')]),
      );
    } catch (err) {
      salesBody.replaceChildren(el('p', { className: 'card-note empty-note' }, err.message));
    }
  }

  function salesCard() {
    salesBody.append(el('p', { className: 'card-note empty-note' }, 'Checking what’s on sale…'));
    void paintSales();
    return el('section', { className: 'card' }, el('h2', {}, 'On sale now'), salesBody);
  }

  function joinSoundCard(rows) {
    const body = el('div');
    const card = el('section', { className: 'card' }, el('h2', {}, 'Join sounds'), body);
    const paint = (current) =>
      body.replaceChildren(
        ...(current.length
          ? current.map((row) =>
              el(
                'div',
                { className: 'field' },
                el('div', {}, el('div', { className: 'series-name' }, row.who), el('p', { className: 'hint' }, row.name)),
                el(
                  'div',
                  { className: 'control' },
                  confirmButton({ ariaLabel: `Remove ${row.who}’s join sound` }, 'Remove', 'Remove it?', async () => {
                    await request(api(`/join-sounds/${row.id}`), { method: 'DELETE' });
                    toast(`Removed ${row.who}’s join sound.`);
                    paint((await request(api('/join-sounds'))).joinSounds);
                  }),
                ),
              ),
            )
          : [el('p', { className: 'card-note empty-note' }, 'Nobody has one yet. People pick their own in Discord with /sound join.')]),
      );
    paint(rows);
    return card;
  }

  void attempt(async () => {
    try {
      const [data, { joinSounds }] = await Promise.all([request(api('/settings')), request(api('/join-sounds'))]);
      if (guildId !== state.guildId || !main.isConnected) return;
      const byKey = new Map(data.settings.map((s) => [s.key, s]));
      const grouped = new Set(GROUPS.flatMap(([, keys]) => keys));
      const others = data.settings.filter((s) => !grouped.has(s.key)).map((s) => s.key);
      const groups = others.length ? [...GROUPS, ['Other', others]] : GROUPS;
      main.replaceChildren(
        el('datalist', { id: 'time-zones' }, data.timeZones.map((zone) => el('option', { value: zone }))),
        ...groups.flatMap(([title, keys]) => {
          const card = el(
            'section',
            { className: 'card' },
            el('h2', {}, title),
            keys.filter((key) => byKey.has(key)).map((key) => field(byKey.get(key), data)),
          );
          if (title === 'Sale alerts') return [card, salesCard()];
          return title === 'Free games' ? [card, freeGamesCard()] : [card];
        }),
        joinSoundCard(joinSounds),
      );
    } catch (err) {
      loading.textContent = err.message;
      throw err;
    }
  });
}
