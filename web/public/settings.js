import { ago, api, attempt, confirmButton, devicePref, el, formProblem, icon, notice, openDialog, postDialog, request, RequestError, state, toast, undoToast } from './lib.js';
import { voicesCard } from './voicesettings.js';
import { profilesCard } from './profiles.js';

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
  salePostHour: { kind: 'hour', hint: 'In the server’s time zone. Prices are checked through the day, and everything new is posted together once a day at this hour, with bundles in a post of their own.' },
  saleSteamWishlists: { kind: 'boolean', hint: 'Watches games on members’ Steam wishlists, if their profile allows it.' },
  saleOtherStores: { kind: 'boolean', hint: 'Also posts when an official store like Humble, Fanatical or Green Man Gaming sells a Steam key for less than Steam, by at least the discount above. Copies for GOG, Epic and other launchers are left out. Prices come from IsThereAnyDeal, and need its API key on the bot. With a gg.deals key too, the cheapest key reseller is shown beside a sale, but never posts one by itself.' },
  bundleAlerts: { kind: 'boolean', hint: 'Posts a Humble, Fanatical or Green Man Gaming bundle once, when it has a game this server plays, wants or has on a Steam wishlist, pinging whoever wants it. Needs an IsThereAnyDeal API key on the bot.' },
  bundlesLikeWePlay: { kind: 'boolean', hint: 'Also posts a bundle with a game that shares at least 4 Steam tags with one this server plays a lot, and is multiplayer when most of what it plays is, without pinging anyone.' },
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
  ttsEffect: { kind: 'effect', hint: 'Said through when nobody picks one: messages read out, greetings and announcements too. Each effect is matched to each voice’s loudness.' },
  ttsSpeed: { kind: 'number', unit: '%', hint: 'How fast it talks. 100 is the voice’s natural speed, and lower is slower.' },
  ttsPauseMs: { kind: 'number', unit: 'ms', hint: 'The pause between sentences. 200 is a fifth of a second, and 0 runs them together.' },
  ttsVolume: { kind: 'number', unit: '%', hint: 'How loud it talks. 100 is about as loud as a sound with even volume on. The Speech slider on the Soundboard tab and the Volume button change this too.' },
  ttsChannel: { kind: 'channel', none: 'Off', hint: 'The bot reads out what people type here, in the voice channel they’re in, or else where the bot is or where most people are.' },
  ttsChannelWho: { kind: 'choice', options: [['everyone', 'Everyone'], ['voice', 'Only people in voice']], hint: 'Only people in voice leaves out anyone who’s only typing.' },
  soundVolume: { kind: 'number', unit: '%', hint: 'How loud every sound plays, including join sounds and the looping sound. Speech has its own volume. The Sounds slider on the Soundboard tab and the Volume button change this too.' },
  musicVolume: { kind: 'number', unit: '%', hint: 'How loud music plays. It drops to under a third while the bot is talking. The slider on the Music tab and the Volume button change this too.' },
  evenMusic: { kind: 'boolean', hint: 'Plays each song about as loud as the others, so a quiet old recording and a loud new one don’t need the volume changed between them. The files aren’t changed, and it takes effect from the next song.' },
  musicAutoplay: { kind: 'boolean', hint: 'Keeps three songs waiting at the end of the queue, from YouTube, like the last song in it that someone added, so the music carries on in that style. Songs people add play first, and Autoplay’s change to follow the last of them. Turning it off takes out the ones it added. The switch on the Music tab and the /music card change this too.' },
  musicSearch: {
    kind: 'choice',
    options: [
      ['spotify', 'Spotify'],
      ['youtube-music', 'YouTube Music'],
    ],
    hint: 'Where /music play, the Music tab and chat look for songs by name. Either way the song plays from YouTube. A service the bot isn’t set up for is passed over.',
  },
  musicSearchFallback: { kind: 'boolean', hint: 'Asks the other service when this one fails, is making the bot wait, or finds nothing.' },
  musicDjRole: { kind: 'role', none: 'Everyone', hint: 'Who can add, skip, pause, shuffle and stop music with /music, along with people with Manage Server. Anyone can see the queue. This page isn’t limited by it.' },
  loopRoom: { kind: 'voice', none: 'Off', hint: 'While anyone’s in this channel, the bot plays the looping sound and speech there nonstop. Join sounds don’t play there.' },
  loopSound: { kind: 'sound', none: 'Not set', hint: 'A sound from the library.' },
  loopVolume: { kind: 'number', unit: '%', hint: 'The looping sound’s, on top of its own level. It never stops, so it starts at half.' },
  loopTextVolume: { kind: 'number', unit: '%', hint: 'The looping speech’s, apart from the sound’s. It starts at half too.' },
  loopSoundDelayMs: { kind: 'number', unit: 'ms', hint: 'How long the looping sound waits after the intro ends, or after the loop starts with no intro. 1000 is a second.' },
  loopTextDelayMs: { kind: 'number', unit: 'ms', hint: 'How long the looping speech waits after the intro ends, or after the loop starts with no intro. 1000 is a second.' },
  loopText: { hint: 'Words said over and over in the room, on top of the sound, up to 500 characters. Leave it empty for none.' },
  loopVoice: { kind: 'speaker', none: 'Same as the default voice', hint: 'Who says the looping speech.' },
  loopEffect: { kind: 'effect', none: 'Same as the default effect', hint: 'What the looping speech is said through.' },
  loopTextEvery: { kind: 'number', unit: 'seconds', hint: 'Starts the speech again this often, layered over the last if it’s still talking. 0 says it again straight away.' },
  loopIntro: { kind: 'sound', none: 'Off', hint: 'Played once, at its own level, before the loop starts. Someone else coming in stops the loop and starts again from the intro.' },
  loopIntroDelayMs: { kind: 'number', unit: 'ms', hint: 'How long after someone comes in the intro plays. 250 is a quarter of a second.' },
  loopEvery: { kind: 'number', unit: 'seconds', hint: 'Starts a fresh copy this often, layered on top of the ones still playing, like 0.5 or 1. Up to 8 play at once. 0 loops it without a gap.' },
  ttsGreet: { hint: 'Says who joined voice, for people with no join sound. Uses the join sound cooldown and delay.' },
  ttsGreeting: { hint: 'What it says, with {name} for the person.' },
  ttsNightReminders: { hint: 'Says the reminder in the night’s voice channel too, if people are in it.' },
  ttsHopOn: { hint: 'Says the hop-on ping in voice too, in the channel it was about.' },
  ttsRole: { kind: 'role', none: 'Everyone', hint: 'Who can use /say and have their messages read out, along with people with Manage Server. This page isn’t limited by it.' },
  ttsMaxChars: { kind: 'number', unit: 'characters', hint: 'Up to 6000. 1000 is about a minute and a quarter of speech, and 4000 a whole paragraph of about 5 minutes.' },
  ttsCooldownSec: { kind: 'number', unit: 'seconds', hint: 'Shortest time between one person’s lines. The page counts as one person.' },
  chat: { kind: 'boolean', hint: 'Answers anyone who @mentions the bot or replies to it, in character, and does what they ask: music, sounds and speech, as they could themselves. Their message and the channel’s last 20 messages go to Anthropic to answer it.' },
  chatProfile: { kind: 'profile', hint: 'Who the bot is: its personality, how it talks and its voice. Made and changed in Profiles, below.' },
  chatWebSearch: { kind: 'boolean', hint: 'Searches the web when someone asks for a game’s strategy, builds, guides or news, through Anthropic, and links the sources. A search costs a cent, plus the pages it reads.' },
  chatActions: { kind: 'boolean', hint: 'Lets it plan, change and answer game nights, start votes on what to play, set reminders and make sounds from links when someone asks, with the same permissions as the commands. Off, it points people to the game night and vote commands, and doesn’t set reminders.' },
  chatRoasts: { kind: 'boolean', hint: 'When someone is rude to it, or asks it to roast someone, it looks up their games and hits back with an insult about something different each time: a game they’ve put hours into, what they’ve played lately, one they never played, or their backlog. How harsh is set in its profile. Never about looks, family, race, religion, gender, sexuality or health. Off, it shrugs rudeness off in character.' },
  chatPostLines: { kind: 'boolean', hint: 'Adds a line in its personality above the bot’s automatic posts (hop-on pings, recaps, leaderboards, sales, bundles, free games and patch notes), written by the chat model from what the post says. Each costs a small fraction of a cent, and the post goes out without one if the model is slow or down.' },
  chatModel: { kind: 'choice', options: [['haiku', 'Claude Haiku 5.5 (cheapest and quickest)'], ['sonnet', 'Claude Sonnet 5.5 (better answers, about 20 times the cost)'], ['opus', 'Claude Opus 5.5 (smartest, about 40 times the cost)']], hint: 'Which model answers.' },
  chatVoice: {
    kind: 'choice',
    options: [
      ['off', 'No, text only'],
      ['also', 'Text and voice'],
      ['only', 'Voice only'],
    ],
    hint: 'Says each answer in its profile’s voice when the person asking is in a voice channel. Voice only posts it instead when it can’t be said: they aren’t in voice, it’s too long, or the bot is busy in another channel.',
  },
  chatDailyLimit: { kind: 'number', unit: 'answers', hint: 'The most answers a day, in the server’s time zone, so the cost can’t run away. Each person waits 10 seconds between answers too.' },
};
// Folded until opened, with what they're set to on the fold: long, and rarely changed once set up
const FOLDED = new Set(['Looping sound room', 'Free games']);
// How long "Saved" shows beside a field
const SAVED_MS = 2000;

/** The bot's text, with **bold** as bold */
const rich = (text) => text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? el('strong', {}, part) : part));
const plainText = (text) => text.replace(/\*\*/g, '');
const when = (p) => (p.at ? ` (${ago(p.at)})` : '');
const problemText = (p) => `${plainText(p.text)}${when(p)}`;
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
    case 'effect':
      return value === 'none' ? 'No effect' : (named(data.effects ?? [], value) ?? value);
    case 'profile':
      return named(data.profiles ?? [], value) ?? data.profiles?.[0]?.name ?? value;
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

/** What this browser shows, as opposed to the rest of the page, which is the server's. Each takes effect at once */
const DEVICE = [
  ['musicPlayer', 'Music player at the bottom', 'While music plays, the song with Pause and Skip along the bottom of every page but Music.'],
  ['soundsButton', 'Sounds button', 'Beside Volume on every page but the Soundboard: the sounds and a line to say, without leaving the page.'],
];

function deviceCard() {
  const row = ([name, label, hint]) => {
    const id = `device-${name}`;
    return el(
      'div',
      { className: 'field' },
      el('div', {}, el('label', { htmlFor: id }, label), el('p', { className: 'hint' }, hint)),
      el('div', { className: 'control' }, el('label', { className: 'toggle' }, el('input', { id, type: 'checkbox', checked: devicePref.on(name), onchange: (e) => devicePref.set(name, e.target.checked) }))),
    );
  };
  return el('section', { className: 'card', id: 'settings-on-this-device' }, el('h2', {}, 'On this device'), el('p', { className: 'card-note' }, 'Just for this browser. Everything else here is for the whole server.'), DEVICE.map(row));
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
    paintProblems(fresh.problems);
  }

  /** What stops the bot doing what the settings ask, each with a way to the setting that fixes it */
  const problemsBox = el('section', { className: 'card problems', id: 'settings-problems', hidden: true, ariaLabelledBy: 'settings-problems-title' });
  function paintProblems(problems = []) {
    problemsBox.hidden = !problems.length;
    problemsBox.replaceChildren(
      el('h2', { id: 'settings-problems-title' }, icon('alert'), problems.length === 1 ? ' 1 thing needs fixing' : ` ${problems.length} things need fixing`),
      el(
        'ul',
        {},
        problems.map((p) =>
          el(
            'li',
            {},
            el('span', {}, ...rich(p.text), when(p)),
            p.key && ' ',
            p.key && el('button', { type: 'button', className: 'link', onclick: () => goTo(p.key) }, 'Go to setting'),
          ),
        ),
      ),
    );
  }

  /** Opens a setting's group if it's folded, and puts the cursor in it */
  function goTo(key) {
    const input = document.getElementById(`setting-${key}`);
    if (!input) return;
    const fold = input.closest('details');
    if (fold) fold.open = true;
    input.closest('.field')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
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
      case 'channel': {
        const cant = (c) => (data.postChannels?.includes(setting.key) && c.canPost === false ? ', can’t post' : '');
        return select([['', spec.none], ...data.channels.map((c) => [c.id, c.category || cant(c) ? `#${c.name} (${[c.category, cant(c).slice(2)].filter(Boolean).join(', ')})` : `#${c.name}`])]);
      }
      case 'role':
        // Only the hop-on role is handed out, so only it has to be below the bot's
        return select([['', spec.none], ...data.roles.map((r) => [r.id, setting.key === 'hopOnRole' && r.canGive === false ? `@${r.name} (an admin hands it out)` : `@${r.name}`])]);
      case 'voice':
        return select([['', spec.none], ...data.voiceChannels.map((c) => [c.id, `🔊 ${c.name}`])]);
      case 'sound':
        return select([['', spec.none], ...data.sounds.map((name) => [name, name])]);
      case 'speaker': {
        // The bot's list, so a voice added or removed there shows here without a change to this page. One picked that isn't
        // on offer, gone or still downloading, stays shown, with why under it, rather than looking like another was picked
        const missing = value && !data.voices.some((v) => v.id === value) ? [[value, `${value} (not available)`]] : [];
        return select([...(spec.none ? [['', spec.none]] : []), ...missing, ...data.voices.map((v) => [v.id, v.name])]);
      }
      case 'effect':
        return select([...(spec.none ? [['', spec.none]] : []), ['none', 'No effect'], ...(data.effects ?? []).map((e) => [e.id, e.name])]);
      case 'profile':
        return select((data.profiles ?? []).map((p) => [p.id, p.name]));
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
      case 'longtext':
        return el('textarea', { id: `setting-${setting.key}`, value: value ?? '', rows: 4, maxLength: spec.maxLength, onchange: change });
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
      // The Profiles card says which one is in use
      if (setting.key === 'chatProfile') void document.getElementById('settings-profiles')?.reload?.();
    };

    const save = (value) =>
      attempt(async () => {
        say(null);
        fromSave = null;
        try {
          // An empty channel or role picker is the same as never having picked one
          const { warning } =
            value === '' ? await request(api(`/settings/${setting.key}`), { method: 'DELETE' }) : await request(api(`/settings/${setting.key}`), { method: 'PUT', json: { value } });
          say(warning);
          fromSave = warning ? { text: warning, bad: false } : null;
          // Beside the field rather than in the corner, where it's easy to miss
          savedAt = Date.now();
          setTimeout(() => current && paintStatus(current), SAVED_MS + 50);
        } catch (err) {
          say(err.message, true);
          fromSave = { text: err.message, bad: true };
          // The field may be scrolled out of sight by now
          toast(`${setting.label} wasn’t saved: ${err.message}`, true);
        }
        await refresh();
      });

    const reset = (previous) =>
      attempt(async () => {
        say(null);
        fromSave = null;
        await request(api(`/settings/${setting.key}`), { method: 'DELETE' });
        undoToast(`${setting.label} is back to the default.`, () => save(previous));
        await refresh();
      });

    // What the control was last drawn from, so a refresh only redraws fields that changed
    let drawn;
    /** What the last save said, which stays until the next one */
    let fromSave = null;
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
      // What the last save said, if anything, and otherwise what's wrong with it now
      if (fromSave) say(fromSave.text, fromSave.bad);
      else say((fresh.problems ?? []).filter((p) => p.key === next.key).map(problemText).join(' ') || null);
      const choices = { channel: fresh.channels, role: fresh.roles, voice: fresh.voiceChannels, sound: fresh.sounds, speaker: fresh.voices, effect: fresh.effects, profile: fresh.profiles }[spec.kind];
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
                el('span', { className: 'free-reason' }, g.deal, g.store && ' ', g.store && el('a', { href: g.store.url, target: '_blank', rel: 'noreferrer' }, 'See the stores')),
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

  /** What chat remembers about people, at their asking, each forgotten with a press */
  function chatNotesCard(first) {
    const body = el('div');
    const paint = (notes) =>
      body.replaceChildren(
        ...(notes.length
          ? notes.map((row) =>
              el(
                'div',
                { className: 'field' },
                el('div', {}, el('div', { className: 'series-name' }, row.name), el('p', { className: 'hint' }, row.note)),
                el(
                  'div',
                  { className: 'control' },
                  confirmButton({ ariaLabel: `Forget what it remembers about ${row.name}` }, 'Forget', 'Forget it?', async () => {
                    paint((await request(api(`/chat-notes/${row.userId}`), { method: 'DELETE' })).notes);
                    toast(`It no longer remembers anything about ${row.name}.`);
                  }),
                ),
              ),
            )
          : [notice('empty', 'Nothing yet. People can ask it to remember things about them, like what to call them.', { compact: true })]),
      );
    paint(first);
    return el(
      'section',
      { className: 'card', id: 'settings-chat-notes' },
      el('h2', {}, 'What chat remembers'),
      el('p', { className: 'card-note' }, 'What people asked it to remember about them. It goes to Anthropic with that person’s questions.'),
      body,
    );
  }

  /** Reminders people set in chat, soonest first, each cancelled with a press */
  function chatRemindersCard(first) {
    const body = el('div');
    const paint = (reminders) =>
      body.replaceChildren(
        ...(reminders.length
          ? reminders.map((row) =>
              el(
                'div',
                { className: 'field' },
                el(
                  'div',
                  {},
                  el('div', { className: 'series-name' }, `${row.when}, for ${row.people.join(', ')}`),
                  el('p', { className: 'hint' }, `${row.text} (set by ${row.by}${row.channel ? ` in #${row.channel}` : ''})`),
                ),
                el(
                  'div',
                  { className: 'control' },
                  confirmButton({ ariaLabel: `Cancel the reminder for ${row.people.join(', ')} on ${row.when}` }, 'Cancel', 'Cancel it?', async () => {
                    paint((await request(api(`/chat-reminders/${row.id}`), { method: 'DELETE' })).reminders);
                    toast('Reminder cancelled.');
                  }),
                ),
              ),
            )
          : [notice('empty', 'None waiting. People can ask it to remind them, or others, of something later.', { compact: true })]),
      );
    paint(first);
    return el(
      'section',
      { className: 'card', id: 'settings-chat-reminders' },
      el('h2', {}, 'Reminders'),
      el('p', { className: 'card-note' }, 'Set in chat, and posted in the channel they were asked in, pinging the people they’re for.'),
      body,
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
      paintProblems(data.problems);
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
          title === 'Chat' && data.chat && el('p', { className: `card-note${data.chat.ok ? '' : ' warning'}`, id: 'chat-status' }, data.chat.note),
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
        const extras = {
          'Hop-on pings': () => [gamePingCard(gamePings)],
          'Sale alerts': () => [salesCard()],
          'Free games': () => [freeGamesCard()],
          'Text to speech': () => (data.speech ? [voicesCard(main, refreshFields)] : []),
          // Reminders waiting are still posted with chat off, so they can still be cancelled
          Chat: () => [
            profilesCard(main, data, refreshFields),
            ...(data.chat?.ok && data.chat.notes ? [chatNotesCard(data.chat.notes)] : []),
            ...(data.chat?.ok || data.chat?.reminders?.length ? [chatRemindersCard(data.chat.reminders ?? [])] : []),
          ],
        }[title]?.();
        return [card, ...(extras ?? []).filter(Boolean)];
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
        el('option', { value: 'settings-on-this-device' }, 'On this device'),
        groups.flatMap(([title]) => [el('option', { value: slug(title) }, title), title === 'Text to speech' && data.speech && el('option', { value: 'settings-voices' }, 'Voices')].filter(Boolean)),
        el('option', { value: 'settings-join-sounds' }, 'Join sounds'),
      );
      main.replaceChildren(
        el('datalist', { id: 'time-zones' }, data.timeZones.map((zone) => el('option', { value: zone }))),
        el('div', { className: 'toolbar settings-find' }, find, jump),
        nothing,
        el('div', { className: 'settings-cards stack' }, problemsBox, deviceCard(), ...cards, joinCard),
      );
    } catch (err) {
      loading.replaceWith(notice('error', err.message));
      throw err;
    }
  });
}
