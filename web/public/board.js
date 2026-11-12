import { api, attempt, el, emojiNode, keepFocus, notice, postDialog, request, soundPath, state, toast, undoToast } from './lib.js';
import { elapsed, onPlaying } from './playing.js';
import { voiceBar } from './voice.js';

const byUse = (a, b) => b.plays - a.plays || a.name.localeCompare(b.name);

/** Has the bot read out what's typed. Stays hidden if there's no voice to read it */
function sayBox(voice) {
  const guildId = state.guildId;
  const text = el('input', { ariaLabel: 'What to say', placeholder: 'Say something', autocomplete: 'off' });
  const picker = el('select', { ariaLabel: 'Voice' });
  const send = el('button', {}, 'Say');
  const row = el('div', { className: 'phrases' });
  let phrases = [];
  const paint = () => {
    const title = voice.channel() ? `Say in ${voice.channel().name}` : 'Nobody’s in voice';
    send.disabled = !voice.channel() || send.classList.contains('busy');
    send.title = title;
    for (const button of row.querySelectorAll('.phrase-say')) {
      button.disabled = !voice.channel();
      button.title = voice.channel() ? `${button.textContent}\n${title}` : title;
    }
  };
  const remember = (saved) => {
    phrases = saved;
    row.replaceChildren(
      ...phrases.map((phrase) =>
        el(
          'span',
          { className: 'phrase' },
          el('button', { className: 'phrase-say', onclick: () => void attempt(() => voice.say(phrase.text, picker.value)) }, phrase.text),
          el(
            'button',
            {
              className: 'phrase-remove',
              ariaLabel: `Remove “${phrase.text}”`,
              title: 'Remove',
              onclick: () =>
                void attempt(async () => {
                  remember((await request(api(`/phrases/${phrase.id}`), { method: 'DELETE' })).phrases);
                  undoToast(`Removed “${phrase.text}”.`, async () => remember((await request(api('/phrases'), { method: 'POST', json: { text: phrase.text } })).phrases));
                }),
            },
            '×',
          ),
        ),
      ),
    );
    paint();
  };
  const save = el(
    'button',
    {
      type: 'button',
      onclick: () => {
        if (!text.value.trim()) return;
        void attempt(async () => {
          remember((await request(api('/phrases'), { method: 'POST', json: { text: text.value } })).phrases);
          text.value = '';
          toast('Saved.');
        });
      },
    },
    'Save',
  );
  const form = el(
    'form',
    {
      className: 'toolbar say',
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
    save,
  );
  const node = el('div', { className: 'say-box', hidden: true }, form, row);
  void attempt(async () => {
    const { on, voices, voice: chosen, longest, phrases: saved } = await request(api('/say'));
    if (guildId !== state.guildId) return;
    text.maxLength = longest;
    picker.replaceChildren(...voices.map((v) => el('option', { value: v.id, selected: v.id === chosen }, v.name)));
    node.hidden = !on;
    remember(saved);
  });
  return { node, paint };
}

/** Big buttons for playing sounds during a game: favourites first, then whatever gets played most */
/** `openManage` switches to the Soundboard tab's Manage view, where sounds are added */
export function renderBoard(main, openManage) {
  const guildId = state.guildId;
  let sounds = null;
  let filter = '';
  const tiles = [];
  /** Each tile shown, by sound name, to mark the ones playing */
  const shownTiles = new Map();
  let nowPlaying = [];

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
  board.append(notice('loading', 'Loading sounds…'));

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
    const progress = el('span', { className: 'tile-progress', hidden: true });
    shownTiles.set(sound.name, { button, progress, sound });
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
    return el('div', { className: 'tile-box' }, button, progress, star);
  }

  /** Marks the tiles of the sounds playing, with how far through they are */
  function markPlaying() {
    const playing = new Map(nowPlaying.filter((p) => p.kind === 'sound').map((p) => [p.name, p]));
    for (const [name, { button, progress, sound }] of shownTiles) {
      const p = playing.get(name);
      button.classList.toggle('playing', !!p);
      progress.hidden = !p;
      if (!p) {
        delete progress.dataset.id;
        continue;
      }
      // Only a new play, or one that's just been heard, starts the bar again
      const key = `${p.id}:${p.started}`;
      if (progress.dataset.id === key) continue;
      progress.dataset.id = key;
      progress.classList.remove('running', 'waiting');
      if (p.loop || !sound.seconds) continue;
      // Empty until the sound is heard, so the bar keeps pace with it
      if (!p.started) {
        progress.classList.add('waiting');
        continue;
      }
      progress.style.setProperty('--play-ms', `${sound.seconds * 1000}ms`);
      progress.style.setProperty('--play-delay', `${-Math.round(elapsed(p))}ms`);
      void progress.offsetWidth;
      progress.classList.add('running');
    }
  }
  onPlaying(board, (playing) => {
    nowPlaying = playing;
    markPlaying();
  });

  function render() {
    tiles.length = 0;
    shownTiles.clear();
    if (!sounds.length) return board.replaceChildren(notice('empty', 'No sounds yet. ', el('button', { className: 'link', onclick: openManage }, 'Add some in Manage'), '.'));
    const shown = sounds.filter((s) => s.name.includes(filter));
    if (!shown.length) return board.replaceChildren(notice('empty', `Nothing matches “${filter}”.`));
    const starred = shown.filter((s) => s.favourite);
    const others = shown.filter((s) => !s.favourite);
    keepFocus(board, () => board.replaceChildren(
      ...(starred.length ? [el('h2', {}, 'Favourites'), el('div', { className: 'tiles' }, starred.map(tile))] : []),
      ...(others.length ? [...(starred.length ? [el('h2', {}, 'Everything else')] : []), el('div', { className: 'tiles' }, others.map(tile))] : []),
    ));
    markPlaying();
    paint();
  }

  void attempt(async () => {
    try {
      const fresh = await request(api('/sounds'));
      if (guildId !== state.guildId || !main.isConnected) return;
      sounds = fresh.sounds.sort(byUse);
      render();
    } catch (err) {
      board.replaceChildren(notice('error', err.message));
      throw err;
    }
  });
}
