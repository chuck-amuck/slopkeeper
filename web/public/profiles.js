import { tryProfile } from './chat.js';
import { api, attempt, confirmButton, el, fetchAudio, formProblem, notice, openDialog, player, request, RequestError, state, toast } from './lib.js';
import { effectOptions } from './speech.js';

// Settings' Profiles card: who the bot is, how it talks and the voice it says its own lines in. Every server on the bot
// shares them, and each picks one with the Profile setting above

const row = (label, control, note) => el('label', { className: 'form-row' }, el('span', {}, label), control, note && el('span', { className: 'form-note' }, note));
const select = (options, chosen, props = {}) => el('select', props, options.map(([value, label]) => el('option', { value, selected: value === chosen }, label)));
const SERVER_DEFAULT = '';

/** A profile in a few words: what it's called, how it talks and what it sounds like */
export function summary(p, traits, voices, effects) {
  const parts = [p.nickname && `called ${p.nickname}`, ...traits.map((t) => t.options.find(([id]) => id === p[t.key])?.[2])].filter(Boolean);
  const voice = p.voice ? `${voices.find((v) => v.id === p.voice)?.name ?? 'a voice that isn’t available'} voice` : 'the server’s voice';
  const effect = p.effect === 'none' ? 'no effect' : p.effect ? `${effects.find((e) => e.id === p.effect)?.name ?? p.effect} effect` : '';
  const said = [voice, effect].filter(Boolean).join(', ');
  const text = [...parts, said].join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The card. `data` is the Settings page's, for the voices and effects; `onChange` redraws the page's fields after a
 * change here. The card has a `reload` for when the Profile setting is changed above it
 */
export function profilesCard(main, data, onChange) {
  const body = el('div', {}, notice('loading', 'Loading profiles…', { compact: true }));
  const voices = data.voices ?? [];
  const effects = data.effects ?? [];
  let list = null;

  async function load(fresh) {
    list = fresh ?? (await request(api('/chat-profiles')));
    paint();
  }

  /** Saves, then redraws this card and the fields above it. A nickname the bot couldn't take is said */
  const after = async (fresh) => {
    await load(fresh);
    await onChange?.();
    if (fresh?.warning) toast(fresh.warning, true);
  };

  function profileRow(p) {
    const name = el('div', { className: 'series-name' }, p.name, p.active && el('span', { className: 'profile-tag' }, 'Using'));
    const buttons = [
      !p.active &&
        el(
          'button',
          {
            type: 'button',
            onclick: () =>
              void attempt(async () => {
                const { warning } = await request(api('/settings/chatProfile'), { method: 'PUT', json: { value: p.id } });
                // The Chat tab answers as the server's profile again
                tryProfile(state.guildId, null);
                toast(warning ? `The bot is ${p.name} now. ${warning}` : `The bot is ${p.name} now.`, Boolean(warning));
                await after();
              }),
          },
          'Use',
        ),
      // In the Chat tab, before it's picked
      data.chat?.ok !== false &&
        el(
          'button',
          {
            type: 'button',
            onclick: () => {
              tryProfile(state.guildId, p.id);
              location.hash = 'chat';
            },
          },
          'Try',
        ),
      el('button', { type: 'button', onclick: () => editDialog(p) }, 'Edit'),
      el(
        'button',
        {
          type: 'button',
          disabled: list.profiles.length >= list.most,
          onclick: () =>
            void attempt(async () => {
              const fresh = await request(api('/chat-profiles'), { method: 'POST', json: { copyOf: p.id } });
              await after(fresh);
              const copy = fresh.profiles.find((c) => c.id === fresh.id);
              toast(`Made ${copy.name}.`);
              editDialog(copy);
            }),
        },
        'Copy',
      ),
      p.builtIn
        ? p.changed &&
          confirmButton({ ariaLabel: `Reset ${p.name}` }, 'Reset', 'Reset it?', async () => {
            await after(await request(api(`/chat-profiles/${encodeURIComponent(p.id)}`), { method: 'DELETE' }));
            toast(`${p.name} is back to how it started.`);
          })
        : confirmButton({ ariaLabel: `Delete ${p.name}` }, 'Delete', 'Delete it?', async () => {
            const fresh = await request(api(`/chat-profiles/${encodeURIComponent(p.id)}`), { method: 'DELETE' });
            await after(fresh);
            toast(fresh.servers ? `Deleted ${p.name}. ${fresh.servers === 1 ? 'The server that used it is' : `${fresh.servers} servers that used it are`} on ${fresh.profiles.find((b) => b.builtIn)?.name ?? 'the built-in one'} now.` : `Deleted ${p.name}.`);
          }),
    ];
    return el(
      'div',
      { className: 'field profile-row' },
      el('div', {}, name, el('p', { className: 'hint' }, summary(p, list.traits, voices, effects))),
      el('div', { className: 'control' }, ...buttons.filter(Boolean)),
    );
  }

  const addButton = el('button', { type: 'button', onclick: () => editDialog(null) }, 'New profile');

  function paint() {
    body.replaceChildren(...list.profiles.map(profileRow));
    addButton.disabled = list.profiles.length >= list.most;
  }

  /** Hears the voice and effect picked, as the bot's own lines would sound */
  async function hear(voice, effect, name, button) {
    if (button.ariaBusy) return;
    const text = `Hi, I’m ${name.trim() || 'the bot'}, and this is how I sound.`;
    const key = `profile-preview:${voice}:${effect}:${text}`;
    if (player.name === key) return player.stop();
    button.ariaBusy = 'true';
    try {
      const through = effect === SERVER_DEFAULT ? '' : `&effect=${encodeURIComponent(effect)}`;
      await player.toggle(await fetchAudio(api(`/say/preview?voice=${encodeURIComponent(voice)}${through}&text=${encodeURIComponent(text)}`)), key);
    } finally {
      button.ariaBusy = null;
    }
  }

  /** Changes a profile, or makes one when `p` is null */
  function editDialog(p) {
    const fields = {
      name: el('input', { required: true, maxLength: list.longest.name, value: p?.name ?? '', autocomplete: 'off', id: 'profile-name' }),
      nickname: el('input', { maxLength: list.longest.nickname, value: p?.nickname ?? '', autocomplete: 'off', id: 'profile-nickname', placeholder: 'Its own name' }),
      personality: el('textarea', { required: true, rows: 6, maxLength: list.longest.personality, value: p?.personality ?? '', id: 'profile-personality' }),
      ...Object.fromEntries(list.traits.map((t) => [t.key, select(t.options.map(([id, label]) => [id, label]), p?.[t.key] ?? t.options[0][0], { id: `profile-${t.key}` })])),
      despises: el('input', { maxLength: list.longest.despises, value: p ? p.despises : (list.profiles.find((b) => b.builtIn)?.despises ?? ''), autocomplete: 'off', id: 'profile-despises' }),
      // One that isn't on offer any more stays shown as picked, rather than looking like another was
      voice: select(
        [
          [SERVER_DEFAULT, 'The server’s default voice'],
          ...(p?.voice && !voices.some((v) => v.id === p.voice) ? [[p.voice, `${p.voice} (not available)`]] : []),
          ...voices.map((v) => [v.id, v.name]),
        ],
        p?.voice ?? SERVER_DEFAULT,
        { id: 'profile-voice' },
      ),
      effect: el('select', { id: 'profile-effect' }, el('option', { value: SERVER_DEFAULT, selected: !p?.effect }, 'The server’s default effect'), effectOptions(effects, p?.effect ?? null)),
    };
    const count = el('span', { className: 'form-note' });
    const counted = () => (count.textContent = `${fields.personality.value.length} of ${list.longest.personality} characters. Who it is, in a few sentences: 300 to 900 characters works best.`);
    fields.personality.oninput = counted;
    counted();
    const problem = formProblem();
    const listen = el('button', { type: 'button', hidden: !data.speech }, 'Hear it');
    listen.onclick = () =>
      void attempt(async () => {
        problem.hidden = true;
        try {
          await hear(fields.voice.value, fields.effect.value, fields.name.value, listen);
        } catch (err) {
          if (!(err instanceof RequestError)) throw err;
          problem.textContent = err.message;
          problem.hidden = false;
        }
      });
    const save = el('button', { type: 'submit', className: 'primary' }, p ? 'Save' : 'Add');
    const speech = data.speech
      ? [
          row('Voice', fields.voice, 'For its answers in voice, announcements and greetings. /say and messages read out keep the server’s default voice.'),
          row('Effect', fields.effect),
        ]
      : [];
    const node = openDialog(main, {
      title: p ? `Edit ${p.name}` : 'New profile',
      className: 'profile-dialog',
      body: [
        row('Name', fields.name),
        row('Nickname', fields.nickname, 'What the bot is called in servers using this profile. Empty keeps its own name.'),
        el('label', { className: 'form-row' }, el('span', {}, 'Personality'), fields.personality, count),
        ...list.traits.map((t) => row(t.label, fields[t.key], t.key === 'roasts' ? 'When Roast rude people is on.' : null)),
        row('Can’t stand', fields.despises, 'Who it tears into on sight, for what they stand for, never for who they are. Empty for nobody.'),
        ...speech,
        problem,
      ],
      start: [listen],
      actions: [save],
      close: 'Cancel',
      onsubmit: (e) => {
        e.preventDefault();
        save.disabled = true;
        void attempt(async () => {
          problem.hidden = true;
          const json = {
            name: fields.name.value,
            nickname: fields.nickname.value,
            personality: fields.personality.value,
            ...Object.fromEntries(list.traits.map((t) => [t.key, fields[t.key].value])),
            despises: fields.despises.value,
            ...(data.speech && { voice: fields.voice.value || null, effect: fields.effect.value || null }),
          };
          try {
            const fresh = await request(api(p ? `/chat-profiles/${encodeURIComponent(p.id)}` : '/chat-profiles'), { method: p ? 'PUT' : 'POST', json });
            toast(p ? `Saved ${json.name.trim()}.` : `Added ${json.name.trim()}. Pick it with Use, or in Profile above.`);
            node.close();
            await after(fresh);
          } catch (err) {
            if (!(err instanceof RequestError)) throw err;
            problem.textContent = err.message;
            problem.hidden = false;
          } finally {
            save.disabled = false;
          }
        });
      },
    });
  }

  const card = el(
    'section',
    { className: 'card', id: 'settings-profiles' },
    el('h2', {}, 'Profiles'),
    el(
      'p',
      { className: 'card-note' },
      'Who the bot is: its personality, how it talks, what it’s called and the voice it says its own lines in. Every server on the bot shares these, and each uses the one picked in Profile. Try asks it as one in the Chat tab first.',
    ),
    body,
    el('div', { className: 'field' }, el('div', {}, el('div', { className: 'series-name' }, 'Add a profile'), el('p', { className: 'hint' }, 'Starts with the usual traits, for a personality of your own.')), el('div', { className: 'control' }, addButton)),
  );
  card.reload = () => attempt(() => load());
  void attempt(async () => {
    try {
      await load();
    } catch (err) {
      body.replaceChildren(notice('error', err.message, { compact: true }));
    }
  });
  return card;
}
