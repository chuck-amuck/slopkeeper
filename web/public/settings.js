import { api, attempt, confirmButton, el, openDialog, postDialog, request, RequestError, state, toast } from './lib.js';

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
  patchNotes: { kind: 'choice', options: [['off', 'Off'], ['each', 'Post each one'], ['digest', 'Weekly digest']], hint: 'For games played here in the last 30 days. Only finds posts the developer tagged as patch notes. The digest goes out with the weekly leaderboard.' },
  patchNotesChannel: { kind: 'channel', none: 'Same as announce channel', hint: 'Post patch notes here instead.' },
  steamStatus: { kind: 'boolean', hint: 'Uses what linked members in voice are playing on Steam if Discord doesn’t show it, for game time and pings.' },
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
  joinSoundDelayMs: { kind: 'number', unit: 'ms', hint: 'How long the bot waits after connecting before it plays a join sound, so it clears Discord’s joining noises. 500 is half a second.' },
  soundManagerRole: { kind: 'role', none: 'Everyone', hint: 'Who can change sounds in Discord, along with people with Manage Server. Anyone can still play them. This page isn’t limited by it: it only asks for the password.' },
  tts: { kind: 'boolean', hint: 'Lets people have the bot read out what they type, with /say or on the Soundboard tab.' },
  ttsVoice: { kind: 'choice', options: [['1', 'Voice 1'], ['2', 'Voice 2'], ['5', 'Voice 5'], ['9', 'Voice 9']], hint: 'Used when nobody picks one.' },
  ttsSpeed: { kind: 'number', unit: '%', hint: 'How fast it talks. 100 is the voice’s natural speed, and lower is slower.' },
  ttsVolume: { kind: 'number', unit: '%', hint: 'How loud it talks. 100 is about as loud as a sound with even volume on.' },
  ttsChannel: { kind: 'channel', none: 'Off', hint: 'The bot reads out what people type here, in the voice channel they’re in, or else where the bot is or where most people are.' },
  ttsChannelWho: { kind: 'choice', options: [['everyone', 'Everyone'], ['voice', 'Only people in voice']], hint: 'Only people in voice leaves out anyone who’s only typing.' },
  soundVolume: { kind: 'number', unit: '%', hint: 'How loud every sound plays, including join sounds and the looping sound. Speech has its own volume. The slider on the Soundboard tab changes this too.' },
  loopRoom: { kind: 'voice', none: 'Off', hint: 'While anyone’s in this channel, the bot plays the looping sound there nonstop.' },
  loopSound: { kind: 'sound', none: 'Not set', hint: 'A sound from the library.' },
  loopVolume: { kind: 'number', unit: '%', hint: 'On top of the sound’s own level. It never stops, so it starts at half.' },
  ttsGreet: { hint: 'Says who joined voice, for people with no join sound. Uses the join sound cooldown and delay.' },
  ttsGreeting: { hint: 'What it says, with {name} for the person.' },
  ttsNightReminders: { hint: 'Says the reminder in the night’s voice channel too, if people are in it.' },
  ttsHopOn: { hint: 'Says the hop-on ping in voice too, in the channel it was about.' },
  ttsRole: { kind: 'role', none: 'Everyone', hint: 'Who can use /say and have their messages read out, along with people with Manage Server. This page isn’t limited by it.' },
  ttsMaxChars: { kind: 'number', unit: 'characters', hint: '200 is about 15 seconds of speech.' },
  ttsCooldownSec: { kind: 'number', unit: 'seconds', hint: 'Shortest time between one person’s lines. The page counts as one person.' },
};

const GROUPS = [
  ['Posting', ['announceChannel', 'timezone']],
  ['Hop-on pings', ['hopOnRole', 'hopOnMinPeople', 'hopOnCooldownMin']],
  ['Voice sessions', ['recapMinMinutes', 'sessionGraceMin']],
  ['Leaderboard and recap', ['weeklyPostDay', 'weeklyPostHour', 'monthlyRecap']],
  ['Games', ['steamCountry', 'steamStatus', 'gameNightReminderMin']],
  ['Sale alerts', ['saleMinDiscount', 'saleSteamWishlists', 'saleChannel']],
  ['Patch notes', ['patchNotes', 'patchNotesChannel']],
  ['Free games', ['freeGames', 'freeGamesChannel', 'freeGamesMinRating', 'freeGamesTaste', 'freeGamesMultiplayer', 'freeGamesUnlisted']],
  ['Soundboard', ['soundVolume', 'evenVolume', 'joinSounds', 'joinSoundDelayMs', 'joinSoundCooldownMin', 'soundManagerRole']],
  ['Looping sound room', ['loopRoom', 'loopSound', 'loopVolume']],
  ['Text to speech', ['tts', 'ttsVoice', 'ttsSpeed', 'ttsVolume', 'ttsChannel', 'ttsChannelWho', 'ttsGreet', 'ttsGreeting', 'ttsNightReminders', 'ttsHopOn', 'ttsRole', 'ttsMaxChars', 'ttsCooldownSec']],
];

export function renderSettings(main) {
  const guildId = state.guildId;
  const loading = el('div', { className: 'empty' }, 'Loading settings…');
  main.append(loading);
  const fields = new Map();

  async function refreshFields() {
    const fresh = await request(api('/settings'));
    if (guildId !== state.guildId || !main.isConnected) return;
    for (const [key, update] of fields) update(fresh.settings.find((s) => s.key === key), fresh);
  }

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
      case 'voice':
        return select([['', spec.none], ...data.voiceChannels.map((c) => [c.id, `🔊 ${c.name}`])]);
      case 'sound':
        return select([['', spec.none], ...data.sounds.map((name) => [name, name])]);
      case 'choice':
        return select(spec.options);
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
      await refreshFields();
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

  /** A row of its own under a list: what it does on the left, the form on the right, and any message below */
  function adder(title, hint, controls, submit) {
    const message = el('div', { className: 'message', hidden: true });
    const say = (text, bad) => {
      message.hidden = !text;
      message.textContent = text ?? '';
      message.className = bad ? 'message bad' : 'message';
    };
    const form = el(
      'form',
      {
        className: 'control stacked',
        onsubmit: (e) => {
          e.preventDefault();
          const button = form.querySelector('button');
          button.disabled = true;
          void attempt(async () => {
            say(null);
            try {
              say((await submit()).warning);
            } catch (err) {
              if (!(err instanceof RequestError)) throw err;
              say(err.message, true);
            }
          }).finally(() => {
            button.disabled = false;
          });
        },
      },
      controls,
    );
    return el('div', { className: 'field' }, el('div', {}, el('div', { className: 'series-name' }, title), el('p', { className: 'hint' }, hint)), form, message);
  }

  /** The page doesn't know who's using it, so this is for anyone, as Steam accounts are */
  function pingsDialog() {
    const who = el('select', { ariaLabel: 'Person', onchange: () => show() });
    const list = el('div', { className: 'merge-list' });
    const problem = el('div', { className: 'bad-text plan-problem', hidden: true });
    const say = (text) => {
      problem.textContent = text ?? '';
      problem.hidden = !text;
    };

    const toggle = (ping, box) =>
      attempt(async () => {
        say(null);
        box.disabled = true;
        try {
          await request(api(`/members/${who.value}/pings`), { method: 'PUT', json: { roleId: ping.id, on: box.checked } });
        } catch (err) {
          if (!(err instanceof RequestError)) throw err;
          box.checked = !box.checked;
          say(err.message);
        } finally {
          box.disabled = false;
        }
      });

    const pingRow = (ping) => {
      const box = el('input', { type: 'checkbox', checked: ping.on, onchange: () => toggle(ping, box) });
      return el('label', { className: 'merge-row' }, box, el('span', { className: 'rank-name' }, ping.label));
    };

    function show() {
      say(null);
      const person = who.value;
      return attempt(async () => {
        const { pings } = await request(api(`/members/${person}/pings`));
        if (person !== who.value) return;
        list.replaceChildren(...(pings.length ? pings.map(pingRow) : [el('p', {}, 'There are no pings to choose yet.')]));
      });
    }

    const node = openDialog(
      main,
      el('h2', {}, 'Who gets pinged'),
      el('p', {}, 'Pick a person and tick what they get pinged for. They can change these themselves with /notify and /pings.'),
      who,
      list,
      problem,
      el('div', { className: 'actions' }, el('button', { type: 'button', onclick: () => node.close() }, 'Close')),
    );
    void attempt(async () => {
      const { members } = await request(api('/pick/options'));
      who.replaceChildren(...members.map((m) => el('option', { value: m.id }, m.name)));
      if (members.length) await show();
    });
  }

  const postPingMenu = () =>
    postDialog(main, 'Post the Choose games button', 'Lets anyone pick their game pings from a Discord channel.', async (channelId, channel) => {
      await request(api('/game-pings/menu'), { method: 'POST', json: { channelId } });
      toast(`Button posted in ${channel}.`);
    });

  function gamePingCard(first) {
    const body = el('div');
    const games = el('datalist', { id: 'ping-games' });
    const game = el('input', { required: true, maxLength: 100, list: 'ping-games', autocomplete: 'off', placeholder: 'Game', ariaLabel: 'Game' });
    const role = el('select', { ariaLabel: 'Role' });

    const load = async () => paint(await request(api('/game-pings')));

    function pingRow(ping) {
      const who = `${ping.people} ${ping.people === 1 ? 'person' : 'people'}`;
      const label = ping.role === null ? 'Its role was deleted' : `@${ping.role} · ${who}${ping.made ? ' · Made by the bot' : ''}`;
      return el(
        'div',
        { className: 'field' },
        el('div', {}, el('div', { className: 'series-name' }, ping.game), el('p', { className: 'hint' }, label)),
        el(
          'div',
          { className: 'control' },
          confirmButton({ ariaLabel: `Remove pings for ${ping.game}` }, 'Remove', ping.made && ping.role !== null ? 'Delete the role?' : 'Remove it?', async () => {
            await request(api(`/game-pings/${ping.id}`), { method: 'DELETE' });
            toast(`Removed pings for ${ping.game}.`);
            await Promise.all([load(), refreshFields()]);
          }),
        ),
      );
    }

    function paint(data) {
      body.replaceChildren(...(data.pings.length ? data.pings.map(pingRow) : [el('p', { className: 'card-note empty-note' }, 'No games have pings yet.')]));
      games.replaceChildren(...data.games.map((name) => el('option', { value: name })));
      role.replaceChildren(el('option', { value: '' }, 'Make a new role'), ...data.roles.map((r) => el('option', { value: r.id }, `@${r.name}`)));
    }

    const add = adder('Add a game', 'Pick a game or type one, as Discord shows it when people play. Only roles the bot can hand out are listed.', [game, role, el('button', { type: 'submit' }, 'Add')], async () => {
      const name = game.value.trim();
      const result = await request(api('/game-pings'), { method: 'POST', json: { game: name, ...(role.value && { roleId: role.value }) } });
      toast(`Added pings for ${name}.`);
      game.value = '';
      await Promise.all([load(), refreshFields()]);
      return result;
    });

    paint(first);
    return el(
      'section',
      { className: 'card' },
      el('h2', {}, 'Game pings'),
      el('p', { className: 'card-note' }, 'People pick theirs with /pings. Anyone with this page’s password can add and remove these, which makes and deletes Discord roles.'),
      games,
      body,
      add,
      el('div', { className: 'card-actions' }, el('button', { onclick: pingsDialog }, 'Who gets pinged'), el('button', { onclick: postPingMenu }, 'Post Choose games button')),
    );
  }

  function joinSoundCard(first) {
    const body = el('div');
    const who = el('select', { required: true, ariaLabel: 'Person' }, el('option', { value: '' }, 'Pick a person'), first.members.map((m) => el('option', { value: m.id }, m.name)));
    const sound = el('select', { required: true, ariaLabel: 'Sound' }, el('option', { value: '' }, 'Pick a sound'), first.sounds.map((name) => el('option', { value: name }, name)));
    const load = async () => paint((await request(api('/join-sounds'))).joinSounds);
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
                    await load();
                  }),
                ),
              ),
            )
          : [el('p', { className: 'card-note empty-note' }, 'Nobody has one yet. People can pick their own with /sound join, or you can set one here.')]),
      );
    const set = adder('Set a join sound', 'This replaces any they have.', [who, sound, el('button', { type: 'submit' }, 'Set')], async () => {
      const person = who.selectedOptions[0].textContent;
      const result = await request(api(`/join-sounds/${who.value}`), { method: 'PUT', json: { name: sound.value } });
      toast(`${person}’s join sound is ${sound.value}.`);
      who.value = '';
      sound.value = '';
      await load();
      return result;
    });
    paint(first.joinSounds);
    return el('section', { className: 'card' }, el('h2', {}, 'Join sounds'), body, set);
  }

  void attempt(async () => {
    try {
      const [data, joinSounds, gamePings] = await Promise.all([request(api('/settings')), request(api('/join-sounds')), request(api('/game-pings'))]);
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
          if (title === 'Hop-on pings') return [card, gamePingCard(gamePings)];
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
