import { attempt, el, emojiNode, postDialog, request, soundPath, state, api, toast } from './lib.js';
import { voiceBar } from './voice.js';

const byUse = (a, b) => b.plays - a.plays || a.name.localeCompare(b.name);

/** Has the bot read out what's typed. Stays hidden if there's no voice to read it */
function sayBox(voice) {
  const guildId = state.guildId;
  const text = el('input', { ariaLabel: 'What to say', placeholder: 'Say something', autocomplete: 'off' });
  const picker = el('select', { ariaLabel: 'Voice' });
  const send = el('button', {}, 'Say');
  const paint = () => {
    send.disabled = !voice.channel() || send.classList.contains('busy');
    send.title = voice.channel() ? `Say in ${voice.channel().name}` : 'Nobody’s in voice';
  };
  const node = el(
    'form',
    {
      className: 'toolbar say',
      hidden: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (send.disabled || !text.value.trim()) return;
        send.classList.add('busy');
        paint();
        const sent = await attempt(async () => {
          await voice.say(text.value, picker.value);
          return true;
        });
        if (sent) text.value = '';
        send.classList.remove('busy');
        paint();
      },
    },
    text,
    picker,
    send,
  );
  void attempt(async () => {
    const { on, voices, voice: chosen, longest } = await request(api('/say'));
    if (guildId !== state.guildId) return;
    text.maxLength = longest;
    picker.replaceChildren(...voices.map((v) => el('option', { value: v.id, selected: v.id === chosen }, v.name)));
    node.hidden = !on;
  });
  return { node, paint };
}

/** Big buttons for playing sounds during a game: favourites first, then whatever gets played most */
export function renderBoard(main) {
  const guildId = state.guildId;
  let sounds = null;
  let filter = '';
  const tiles = [];

  const voice = voiceBar(main, paint);
  const search = el('input', {
    type: 'search',
    placeholder: 'Search sounds',
    ariaLabel: 'Search sounds',
    oninput: (e) => {
      filter = e.target.value.trim().toLowerCase();
      render();
    },
  });
  const board = el('div', { className: 'board' });
  const postPanel = () =>
    postDialog(main, 'Post a panel', 'Puts the soundboard buttons in a Discord channel. The panel keeps itself up to date as sounds change.', async (channelId, channel) => {
      await request(api('/sound-panels'), { method: 'POST', json: { channelId } });
      toast(`Panel posted in ${channel}.`);
    });
  const say = sayBox(voice);
  main.append(voice.node, say.node, el('div', { className: 'toolbar' }, search, el('button', { onclick: postPanel }, 'Post panel')), board);
  board.append(el('div', { className: 'empty' }, 'Loading sounds…'));

  function paint() {
    const channel = voice.channel();
    say.paint();
    for (const tile of tiles) {
      tile.disabled = !channel;
      tile.title = channel ? `Play in ${channel.name}` : 'Nobody’s in voice';
    }
  }

  function tile(sound) {
    const button = el(
      'button',
      {
        className: 'tile',
        onclick: () => {
          // Restarts the flash on every press, so spamming still shows
          button.classList.remove('hit');
          void button.offsetWidth;
          button.classList.add('hit');
          void attempt(() => voice.play(sound.name));
        },
      },
      el('span', { className: 'tile-emoji' }, sound.emoji ? emojiNode(sound.emoji, '') : '🔊'),
      el('span', { className: 'tile-name' }, sound.name),
    );
    tiles.push(button);
    const star = el(
      'button',
      {
        className: 'star',
        ariaLabel: `${sound.favourite ? 'Remove' : 'Add'} ${sound.name} ${sound.favourite ? 'from' : 'to'} favourites`,
        title: sound.favourite ? 'Remove from favourites' : 'Add to favourites',
        ariaPressed: String(sound.favourite),
        onclick: () =>
          attempt(async () => {
            await request(soundPath(sound.name), { method: 'PATCH', json: { favourite: !sound.favourite } });
            sound.favourite = !sound.favourite;
            render();
          }),
      },
      sound.favourite ? '★' : '☆',
    );
    return el('div', { className: 'tile-box' }, button, star);
  }

  function render() {
    tiles.length = 0;
    if (!sounds.length) return board.replaceChildren(el('div', { className: 'empty' }, 'No sounds yet. Add some in Library.'));
    const shown = sounds.filter((s) => s.name.includes(filter));
    if (!shown.length) return board.replaceChildren(el('div', { className: 'empty' }, `Nothing matches “${filter}”.`));
    const starred = shown.filter((s) => s.favourite);
    const others = shown.filter((s) => !s.favourite);
    board.replaceChildren(
      ...(starred.length ? [el('h2', {}, 'Favourites'), el('div', { className: 'tiles' }, starred.map(tile))] : []),
      ...(others.length ? [...(starred.length ? [el('h2', {}, 'Everything else')] : []), el('div', { className: 'tiles' }, others.map(tile))] : []),
    );
    paint();
  }

  void attempt(async () => {
    try {
      const fresh = await request(api('/sounds'));
      if (guildId !== state.guildId || !main.isConnected) return;
      sounds = fresh.sounds.sort(byUse);
      render();
    } catch (err) {
      board.replaceChildren(el('div', { className: 'empty' }, err.message));
      throw err;
    }
  });
}
