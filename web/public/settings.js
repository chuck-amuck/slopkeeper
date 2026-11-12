import { api, attempt, confirmButton, el, formProblem, notice, openDialog, postDialog, request, RequestError, state, toast, undoToast } from './lib.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FIELDS = {
  announceChannel: { kind: 'channel', none: 'Not set', hint: 'Where hop-on pings, recaps, leaderboards and sale alerts are posted. Nothing is posted until this is set.' },
  timezone: { kind: 'timezone', hint: 'Used for scheduled posts, leaderboards and game nights.' },
  hopOnRole: { kind: 'role', none: 'None', hint: 'Pinged when people hop in voice. People opt in with /notify.' },
  hopOnMinPeople: { kind: 'number', unit: 'people', hint: 'People in a voice channel before pinging.' },
  hopOnCooldownMin: { kind: 'number', unit: 'min', hint: 'Time between pings.' },
  sessionRecap: { kind: 'boolean', hint: 'Posts who was there and what was played when a voice session ends. Sessions count in stats either way.' },
  recapMinMinutes: { kind: 'number', unit: 'min', hint: 'Shorter sessions don’t get a recap or count in stats.' },
  sessionGraceMin: { kind: 'number', unit: 'min', hint: 'How long a channel stays empty before its session ends.' },
  weeklyLeaderboard: { kind: 'boolean', hint: 'Posts the past week’s voice leaderboard on the day and hour below.' },
  weeklyPostDay: { kind: 'day' },
  weeklyPostHour: { kind: 'hour', hint: 'In the server’s time zone. The monthly recap posts at this hour too.' },
  monthlyRecap: { kind: 'boolean', hint: 'Posts a recap of the month on the 1st.' },
  steamCountry: { kind: 'country', hint: 'Two-letter country code for sale prices, like us or gb.' },
  saleMinDiscount: { kind: 'number', unit: '% off', hint: 'Smaller sales aren’t posted, but still show in /sales.' },
  saleSteamWishlists: { kind: 'boolean', hint: 'Watches games on members’ Steam wishlists, if their profile allows it.' },
  saleChannel: { kind: 'channel', none: 'Same as announce channel', hint: 'Post sales here instead.' },
  patchNotes: { kind: 'choice', options: [['off', 'Off'], ['each', 'Post each one'], ['digest', 'Weekly digest']], hint: 'For games played here in the last 30 days. Only finds posts the developer tagged as patch notes. The digest goes out on the weekly leaderboard’s day and hour.' },
  patchNotesChannel: { kind: 'channel', none: 'Same as announce channel', hint: 'Post patch notes here instead.' },
  steamStatus: { kind: 'boolean', hint: 'Uses what linked members in voice are playing on Steam if Discord doesn’t show it, for game time and pings.' },
  freeGames: { kind: 'boolean', hint: 'Posts free-to-keep games on Steam, Epic and GOG.' },
  freeGamesChannel: { kind: 'channel', none: 'Same as announce channel', hint: 'Post free games here instead.' },
  freeGamesMinRating: { kind: 'number', unit: '% positive (0 = off)', hint: 'From at least 50 Steam reviews.' },
  freeGamesTaste: { kind: 'boolean', hint: 'Compares Steam tags with the games this server plays most.' },
  freeGamesMultiplayer: { kind: 'boolean', hint: 'Skips games with no multiplayer or co-op.' },
  freeGamesUnlisted: { kind: 'boolean', hint: 'Shows games with no Steam page, which can’t be rated or compared.' },
  gameNightReminderMin: { kind: 'number', unit: 'min before (0 = off)', hint: 'Pings the people who are in.' },
  evenVolume: { kind: 'boolean', hint: 'Levels sounds so they play about as loud as each other. Your files aren’t changed, so this can be turned off at any time.' },
  joinSounds: { kind: 'boolean', hint: 'Lets people pick a sound that plays when they join voice, with /sound join.' },
  joinSoundCooldownMin: { kind: 'number', unit: 'min', hint: 'Shortest time between one person’s join sounds.' },
  joinSoundDelayMs: { kind: 'number', unit: 'ms', hint: 'How long the bot waits after connecting before it plays a join sound, so it clears Discord’s joining noises. 500 is half a second.' },
  soundManagerRole: { kind: 'role', none: 'Everyone', hint: 'Who can change sounds in Discord, along with people with Manage Server. Anyone can still play them. This page isn’t limited by it: it only asks for the password.' },
  tts: { kind: 'boolean', hint: 'Lets people have the bot read out what they type, with /say or on the Soundboard tab.' },
  ttsVoice: { kind: 'speaker', hint: 'Used when nobody picks one.' },
  ttsSpeed: { kind: 'number', unit: '%', hint: 'How fast it talks. 100 is the voice’s natural speed, and lower is slower.' },
  ttsVolume: { kind: 'number', unit: '%', hint: 'How loud it talks. 100 is about as loud as a sound with even volume on. The Speech slider on the Soundboard tab changes this too.' },
  ttsChannel: { kind: 'channel', none: 'Off', hint: 'The bot reads out what people type here, in the voice channel they’re in, or else where the bot is or where most people are.' },
  ttsChannelWho: { kind: 'choice', options: [['everyone', 'Everyone'], ['voice', 'Only people in voice']], hint: 'Only people in voice leaves out anyone who’s only typing.' },
  soundVolume: { kind: 'number', unit: '%', hint: 'How loud every sound plays, including join sounds and the looping sound. Speech has its own volume. The slider on the Soundboard tab changes this too.' },
  musicVolume: { kind: 'number', unit: '%', hint: 'How loud music plays. It drops to under a third while the bot is talking. The slider on the Music tab changes this too.' },
  musicAutoplay: { kind: 'boolean', hint: 'When the song playing is the last in the queue, adds two similar songs from YouTube, and two more each time they run out. Songs people add play first. Turning it off takes out the ones it added. The switch on the Music tab and the /music card change this too.' },
  musicDjRole: { kind: 'role', none: 'Everyone', hint: 'Who can add, skip, pause, shuffle and stop music with /music, along with people with Manage Server. Anyone can see the queue. This page isn’t limited by it.' },
  loopRoom: { kind: 'voice', none: 'Off', hint: 'While anyone’s in this channel, the bot plays the looping sound and speech there nonstop. Join sounds don’t play there.' },
  loopSound: { kind: 'sound', none: 'Not set', hint: 'A sound from the library.' },
  loopVolume: { kind: 'number', unit: '%', hint: 'The looping sound’s, on top of its own level. It never stops, so it starts at half.' },
  loopTextVolume: { kind: 'number', unit: '%', hint: 'The looping speech’s, apart from the sound’s. It starts at half too.' },
  loopSoundDelayMs: { kind: 'number', unit: 'ms', hint: 'How long the looping sound waits after the intro ends, or after the loop starts with no intro. 1000 is a second.' },
  loopTextDelayMs: { kind: 'number', unit: 'ms', hint: 'How long the looping speech waits after the intro ends, or after the loop starts with no intro. 1000 is a second.' },
  loopText: { hint: 'Words said over and over in the room, on top of the sound, up to 500 characters. Leave it empty for none.' },
  loopVoice: { kind: 'speaker', none: 'Same as the default voice', hint: 'Who says the looping speech.' },
  loopTextEvery: { kind: 'number', unit: 'seconds', hint: 'Starts the speech again this often, layered over the last if it’s still talking. 0 says it again straight away.' },
  loopIntro: { kind: 'sound', none: 'Off', hint: 'Played once, at its own level, before the loop starts. Someone else coming in stops the loop and starts again from the intro.' },
  loopIntroDelayMs: { kind: 'number', unit: 'ms', hint: 'How long after someone comes in the intro plays. 250 is a quarter of a second.' },
  loopEvery: { kind: 'number', unit: 'seconds', hint: 'Starts a fresh copy this often, layered on top of the ones still playing, like 0.5 or 1. Up to 8 play at once. 0 loops it without a gap.' },
  ttsGreet: { hint: 'Says who joined voice, for people with no join sound. Uses the join sound cooldown and delay.' },
  ttsGreeting: { hint: 'What it says, with {name} for the person.' },
  ttsNightReminders: { hint: 'Says the reminder in the night’s voice channel too, if people are in it.' },
  ttsHopOn: { hint: 'Says the hop-on ping in voice too, in the channel it was about.' },
  ttsRole: { kind: 'role', none: 'Everyone', hint: 'Who can use /say and have their messages read out, along with people with Manage Server. This page isn’t limited by it.' },
  ttsMaxChars: { kind: 'number', unit: 'characters', hint: '200 is about 15 seconds of speech.' },
  ttsCooldownSec: { kind: 'number', unit: 'seconds', hint: 'Shortest time between one person’s lines. The page counts as one person.' },
};
// Folded until opened, with what they're set to on the fold: long, and rarely changed once set up
const FOLDED = new Set(['Looping sound room', 'Free games']);
// How long "Saved" shows beside a field
const SAVED_MS = 2000;
// A number field's arrows change it a step at a time, so it saves once they stop
const NUMBER_SAVE_MS = 600;

/** A setting's value in words, as its control shows it: for "Reset to …" and a folded group's summary */
function describe(spec, value, data) {
  const named = (list, id) => list.find((item) => item.id === id)?.name;
  if (value === null || value === '' || value === undefined) return spec.none ?? 'empty';
  switch (spec.kind) {
    case 'boolean':
      return value ? 'on' : 'off';
    case 'number':
      return `${value}${spec.unit ? ` ${spec.unit.replace(/ \(0 = off\)$/, '')}` : ''}`;
    case 'channel':
      return `#${named(data.channels, value) ?? 'deleted channel'}`;
    case 'role':
      return `@${named(data.roles, value) ?? 'deleted role'}`;
    case 'voice':
      return named(data.voiceChannels, value) ?? 'deleted channel';
    case 'speaker':
      return named(data.voices, value) ?? value;
    case 'choice':
      return spec.options.find(([id]) => id === value)?.[1] ?? value;
    case 'day':
      return DAYS[value];
    case 'hour':
      return `${String(value).padStart(2, '0')}:00`;
    default:
      return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
  }
}

export function renderSettings(main) {
  const guildId = state.guildId;
  const loading = notice('loading', 'Loading settings…');
  main.append(loading);
  const fields = new Map();

  /** The folded groups, whose summary follows their first setting */
  const folds = [];

  async function refreshFields() {
    const fresh = await request(api('/settings'));
    if (guildId !== state.guildId || !main.isConnected) return;
    for (const [key, update] of fields) update(fresh.settings.find((s) => s.key === key), fresh);
    for (const fold of folds) fold.paint(fresh);
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
      case 'speaker':
        // The bot's list, so a voice added or removed there shows here without a change to this page
        return select([...(spec.none ? [['', spec.none]] : []), ...data.voices.map((v) => [v.id, v.name])]);
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
          step: setting.step ?? 1,
          required: true,
          // Saved even if the page has moved on by then, so a change is never dropped. Leaving the field saves at once
          onchange: (e) => {
            clearTimeout(e.target.saveTimer);
            const now = () => {
              clearTimeout(e.target.saveTimer);
              e.target.saveTimer = null;
              // Emptied on the way to typing a new number. Saving that as 0 would turn some settings off
              if (e.target.value.trim() === '') {
                e.target.value = e.target.dataset.saved ?? String(value);
                return;
              }
              e.target.dataset.saved = e.target.value;
              void save(Number(e.target.value));
            };
            if (document.activeElement !== e.target) return now();
            e.target.saveTimer = setTimeout(now, NUMBER_SAVE_MS);
            e.target.addEventListener('blur', () => e.target.saveTimer && now(), { once: true });
          },
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
    const message = el('div', { className: 'message', id: `setting-message-${setting.key}`, hidden: true });

    /** Shows a warning or a problem under the field. A problem marks the field and is read out */
    const say = (text, bad) => {
      message.hidden = !text;
      message.textContent = text ?? '';
      message.className = bad ? 'message bad' : 'message';
      message.role = bad ? 'alert' : null;
      const input = box.querySelector('input, select, textarea');
      if (!input) return;
      input.ariaInvalid = bad ? 'true' : null;
      if (text) input.setAttribute('aria-describedby', message.id);
      else input.removeAttribute('aria-describedby');
    };

    const refresh = async () => {
      await refreshFields();
      // Only a preview someone has opened is asked for again
      if (setting.key.startsWith('freeGames') && freeBody.childElementCount) void paintFreeGames();
      if (setting.key.startsWith('sale') && salesBody.childElementCount) void paintSales();
    };

    const save = (value) =>
      attempt(async () => {
        say(null);
        try {
          // An empty channel or role picker is the same as never having picked one
          const { warning } =
            value === '' ? await request(api(`/settings/${setting.key}`), { method: 'DELETE' }) : await request(api(`/settings/${setting.key}`), { method: 'PUT', json: { value } });
          say(warning);
          // Beside the field rather than in the corner, where it's easy to miss
          savedAt = Date.now();
          setTimeout(() => current && paintStatus(current), SAVED_MS + 50);
        } catch (err) {
          say(err.message, true);
          // The field may be scrolled out of sight by now
          toast(`${setting.label} wasn’t saved: ${err.message}`, true);
        }
        await refresh();
      });

    const reset = (previous) =>
      attempt(async () => {
        say(null);
        await request(api(`/settings/${setting.key}`), { method: 'DELETE' });
        undoToast(`${setting.label} is back to the default.`, () => save(previous));
        await refresh();
      });

    // What the control was last drawn from, so a refresh only redraws fields that changed
    let drawn;
    let savedAt = 0;
    let current = null;
    let latestData = data;
    /** Nothing for a default; "Changed" with a way back to the default otherwise; "Saved" just after a change */
    const paintStatus = (shown) => {
      if (Date.now() - savedAt < SAVED_MS) {
        status.replaceChildren(el('span', { className: 'saved' }, '✓ Saved'));
        return;
      }
      if (shown.source === 'set here') {
        const to = describe(spec, shown.default, latestData);
        status.replaceChildren(
          el('span', {}, 'Changed'),
          el('button', { className: 'link', ariaLabel: `Reset ${shown.label} to ${to}`, onclick: () => reset(shown.value) }, `Reset to ${to}`),
        );
      } else status.replaceChildren(...(shown.source === 'default' ? [] : [el('span', { title: `Set by ${shown.source} on the host` }, 'Host default')]));
    };
    const update = (next, fresh) => {
      current = next;
      latestData = fresh;
      const choices = { channel: fresh.channels, role: fresh.roles, voice: fresh.voiceChannels, sound: fresh.sounds, speaker: fresh.voices }[spec.kind];
      const from = JSON.stringify([current.value, current.limits, choices]);
      // A field someone is in keeps its control, so what they're typing or picking isn't thrown away
      if (from !== drawn && !(drawn && box.contains(document.activeElement))) {
        const nodes = [control(current, spec, fresh, save)];
        if (spec.unit) nodes.push(el('span', { className: 'unit' }, spec.unit));
        box.replaceChildren(...nodes);
        drawn = from;
      }
      paintStatus(current);
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
          : [notice('empty', 'Nothing is free to keep right now.', { compact: true })]),
      );
    } catch (err) {
      freeBody.replaceChildren(notice('error', err.message, { compact: true }));
    }
  }

  /** What would be posted right now, folded and only asked for once it's opened */
  function previewCard(title, body, waiting, paint) {
    let asked = false;
    return el(
      'details',
      {
        className: 'card fold preview',
        ontoggle: (e) => {
          if (!e.target.open || asked) return;
          asked = true;
          body.append(notice('loading', waiting, { compact: true }));
          void paint();
        },
      },
      el('summary', {}, el('h2', {}, title), el('span', { className: 'fold-value' }, 'Preview')),
      body,
    );
  }

  const freeGamesCard = () => previewCard('Free games right now', freeBody, 'Checking what’s free…', paintFreeGames);

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
          : [notice('empty', 'Nothing this server plays or wants is on sale right now.', { compact: true })]),
      );
    } catch (err) {
      salesBody.replaceChildren(notice('error', err.message, { compact: true }));
    }
  }

  const salesCard = () => previewCard('On sale now', salesBody, 'Checking what’s on sale…', paintSales);

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

  /** For anyone's pings, as Steam accounts are, starting on whoever's signed in */
  function pingsDialog() {
    const who = el('select', { ariaLabel: 'Person', onchange: () => show() });
    const list = el('div', { className: 'merge-list' });
    const problem = formProblem();
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

    openDialog(main, {
      title: 'Who gets pinged',
      body: [el('p', {}, 'Pick a person and tick what they get pinged for. They can change these themselves with /notify and /pings.'), who, list, problem],
    });
    void attempt(async () => {
      const { members } = await request(api('/pick/options'));
      who.replaceChildren(...members.map((m) => el('option', { value: m.id, selected: m.id === state.me?.userId }, m.name)));
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
      body.replaceChildren(...(data.pings.length ? data.pings.map(pingRow) : [notice('empty', 'No games have pings yet.', { compact: true })]));
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
    const who = el('select', { required: true, ariaLabel: 'Person' }, el('option', { value: '' }, 'Pick a person'), first.members.map((m) => el('option', { value: m.id, selected: m.id === state.me?.userId }, m.name)));
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
          : [notice('empty', 'Nobody has one yet. People can pick their own with /sound join, or you can set one here.', { compact: true })]),
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
      // The bot says how to group them, the same way /setup show does
      // (an older bot sends none, and its settings all go under Other until it's updated)
      const given = data.groups ?? [];
      const grouped = new Set(given.flatMap(([, keys]) => keys));
      const others = data.settings.filter((s) => !grouped.has(s.key)).map((s) => s.key);
      const groups = others.length ? [...given, ['Other', others]] : given;
      const slug = (title) => `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const cards = groups.flatMap(([title, keys]) => {
        const shown = keys.filter((key) => byKey.has(key));
        const parts = [
          title === 'Looping sound room' && data.loopBot && el('p', { className: `card-note${data.loopBot.ok ? '' : ' warning'}`, id: 'loop-bot-status' }, data.loopBot.note),
          shown.map((key) => field(byKey.get(key), data)),
        ];
        let card;
        if (FOLDED.has(title)) {
          // The fold says what the group's first setting is, such as the room's channel or Off
          const value = el('span', { className: 'fold-value' });
          const paintValue = () => {
            const first = byKey.get(shown[0]);
            value.textContent = first ? describe(FIELDS[first.key] ?? {}, first.value, data) : '';
          };
          paintValue();
          folds.push({ key: shown[0], paint: (fresh) => (byKey.set(shown[0], fresh.settings.find((x) => x.key === shown[0])), paintValue()) });
          card = el('details', { className: 'card fold', id: slug(title) }, el('summary', {}, el('h2', {}, title), value), ...parts);
        } else card = el('section', { className: 'card', id: slug(title) }, el('h2', {}, title), ...parts);
        // Built only for its own group: the previews share one body each
        const extra = { 'Hop-on pings': () => gamePingCard(gamePings), 'Sale alerts': salesCard, 'Free games': freeGamesCard }[title]?.();
        return extra ? [card, extra] : [card];
      });
      const joinCard = joinSoundCard(joinSounds);
      joinCard.id = 'settings-join-sounds';
      const nothing = notice('empty', '', { compact: true });
      nothing.hidden = true;

      /** Hides the settings whose name and hint don't have the words typed, and groups left with none */
      const filter = (text) => {
        const words = text.toLowerCase().split(/\s+/).filter(Boolean);
        let any = false;
        for (const card of main.querySelectorAll('.settings-cards > .card')) {
          const rows = [...card.querySelectorAll(':scope > .field, :scope > div > .field')];
          let shownRows = 0;
          for (const row of rows) {
            const match = words.every((word) => row.textContent.toLowerCase().includes(word));
            row.hidden = words.length > 0 && !match;
            if (match) shownRows++;
          }
          const titleMatch = words.every((word) => card.querySelector('h2')?.textContent.toLowerCase().includes(word));
          // A group whose title matches shows whole
          if (titleMatch) for (const row of rows) row.hidden = false;
          card.hidden = words.length > 0 && !titleMatch && !shownRows;
          // Opened to show what matched, and folded again once the search is cleared. A preview isn't a setting, and
          // opening one would start its slow check
          if (card.tagName === 'DETAILS' && !card.classList.contains('preview')) {
            if (words.length && !card.hidden && !card.open) {
              card.open = true;
              card.dataset.foundOpen = '1';
            } else if (!words.length && card.dataset.foundOpen) {
              card.open = false;
              delete card.dataset.foundOpen;
            }
          }
          any ||= !card.hidden;
        }
        nothing.hidden = any || !words.length;
        nothing.textContent = `No setting matches “${text.trim()}”.`;
      };
      const find = el('input', { type: 'search', placeholder: 'Find a setting', ariaLabel: 'Find a setting', enterKeyHint: 'search', oninput: (e) => filter(e.target.value) });
      const jump = el(
        'select',
        {
          ariaLabel: 'Jump to a group',
          onchange: () => {
            const target = document.getElementById(jump.value);
            jump.value = '';
            if (!target) return;
            if (target.tagName === 'DETAILS') target.open = true;
            target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
            target.querySelector('summary, h2')?.focus?.();
          },
        },
        el('option', { value: '' }, 'Jump to…'),
        groups.map(([title]) => el('option', { value: slug(title) }, title)),
        el('option', { value: 'settings-join-sounds' }, 'Join sounds'),
      );
      main.replaceChildren(
        el('datalist', { id: 'time-zones' }, data.timeZones.map((zone) => el('option', { value: zone }))),
        el('div', { className: 'toolbar settings-find' }, find, jump),
        nothing,
        el('div', { className: 'settings-cards stack' }, ...cards, joinCard),
      );
    } catch (err) {
      loading.replaceWith(notice('error', err.message));
      throw err;
    }
  });
}
