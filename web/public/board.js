import { api, attempt, el, emojiNode, fetchAudio, icon, keepFocus, notice, player, recall, remember, request, soundPath, state, toast, undoToast, volumeControl } from './lib.js';
import { elapsed, onPlaying } from './playing.js';
import { voiceBar } from './voice.js';

const byUse = (a, b) => b.plays - a.plays || a.name.localeCompare(b.name);

// Voices in this order, and any the bot adds later after them
const VOICE_GROUPS = ['Characters', 'Accents', 'Effects'];
const PREVIEW_TEXT = 'Hello, this is how I sound.';

/** The voices as a picker's options, in their groups when the bot says what they are */
function voiceOptions(voices, chosen) {
  const option = (v) => el('option', { value: v.id, selected: v.id === chosen }, v.name);
  if (!voices.some((v) => v.group)) return voices.map(option);
  const groups = [...new Set([...VOICE_GROUPS, ...voices.map((v) => v.group ?? 'Other')])];
  return groups
    .map((group) => [group, voices.filter((v) => (v.group ?? 'Other') === group)])
    .filter(([, list]) => list.length)
    .map(([group, list]) => el('optgroup', { label: group }, list.map(option)));
}

/**
 * Has the bot read out what's typed: one row for the line and Say, then the voice, a preview only you hear, and the
 * saved lines. Stays hidden if there's no voice to read it
 */
function sayBox(voice) {
  const guildId = state.guildId;
  const voiceKey = `voice:${guildId}`;
  const text = el('input', { ariaLabel: 'What to say', placeholder: 'Say something', autocomplete: 'off', enterKeyHint: 'send' });
  const picker = el('select', { ariaLabel: 'Voice', className: 'say-voice', onchange: () => remember(voiceKey, picker.value) });
  const send = el('button', { className: 'primary say-send' }, 'Say');
  let saying = false;
  const preview = el(
    'button',
    {
      type: 'button',
      className: 'icon say-preview',
      ariaLabel: 'Preview this voice, just for you',
      title: 'Hear it here first, just for you',
      onclick: () =>
        void attempt(async () => {
          // Still fetching the last one
          if (preview.ariaBusy) return;
          const line = text.value.trim() || PREVIEW_TEXT;
          const name = `preview:${picker.value}:${line}`;
          // Pressed again while it plays: stop it
          if (player.name === name) return player.stop();
          preview.ariaBusy = 'true';
          try {
            const url = await fetchAudio(api(`/say/preview?voice=${encodeURIComponent(picker.value)}&text=${encodeURIComponent(line)}`));
            await player.toggle(url, name);
          } finally {
            preview.ariaBusy = null;
          }
        }),
    },
    icon('headphones'),
  );
  const chips = el('div', { className: 'phrase-list' });
  const saveLine = el('button', { type: 'button', className: 'icon save-line', ariaLabel: 'Save this line', title: 'Save this line, to say it again with one tap', hidden: true, onclick: () => saveTyped() }, icon('plus'));
  const editLines = el('button', { type: 'button', className: 'quiet', ariaPressed: 'false', hidden: true, onclick: () => setEditing(!editing) }, 'Edit');
  // On a phone the row scrolls sideways, so the sounds stay near the top; All unfolds it
  const scroller = el('div', { className: 'phrase-scroll' }, picker, preview, chips, editLines);
  const allLines = el('button', { type: 'button', className: 'quiet all-lines', ariaExpanded: 'false', hidden: true, onclick: () => setUnfolded(!unfolded) }, 'All');
  const row = el('div', { className: 'phrases' }, scroller, allLines);
  let phrases = [];
  let editing = false;
  let unfolded = false;

  const paint = () => {
    const channel = voice.channel();
    const title = channel ? `Say in ${channel.name}` : 'Nobody’s in voice';
    send.disabled = !channel || saying;
    send.title = title;
    for (const button of chips.querySelectorAll('.phrase-say')) {
      button.disabled = !channel;
      button.title = channel ? `${button.textContent}\n${title}` : title;
    }
  };
  const setEditing = (on) => {
    editing = on;
    editLines.textContent = on ? 'Done' : 'Edit';
    editLines.ariaPressed = String(on);
    row.classList.toggle('editing', on);
    allLines.hidden = on || !phrases.length;
  };
  const setUnfolded = (on) => {
    unfolded = on;
    allLines.textContent = on ? 'Fewer' : 'All';
    allLines.ariaExpanded = String(on);
    row.classList.toggle('unfolded', on);
    // Unfolded, it ends the lines rather than holding a column beside them
    if (on) scroller.append(allLines);
    else row.append(allLines);
    allLines.focus();
  };
  /** Says a saved line, ignoring taps while it's on its way so a double tap doesn't hit the wait between lines */
  const sayPhrase = (button, phrase) => {
    if (button.ariaBusy) return;
    button.ariaBusy = 'true';
    void attempt(() => voice.say(phrase.text, picker.value)).finally(() => (button.ariaBusy = null));
  };
  const paintPhrases = () => {
    chips.replaceChildren(
      ...phrases.map((phrase) => {
        const say = el('button', { className: 'phrase-say', onclick: () => sayPhrase(say, phrase) }, phrase.text);
        return el(
          'span',
          { className: 'phrase' },
          say,
          el(
            'button',
            {
              className: 'phrase-remove',
              ariaLabel: `Remove “${phrase.text}”`,
              title: 'Remove',
              onclick: () =>
                void attempt(async () => {
                  remembered((await request(api(`/phrases/${phrase.id}`), { method: 'DELETE' })).phrases);
                  undoToast(`Removed “${phrase.text}”.`, async () => remembered((await request(api('/phrases'), { method: 'POST', json: { text: phrase.text } })).phrases));
                }),
            },
            icon('x'),
          ),
        );
      }),
    );
    allLines.hidden = editing || !phrases.length;
    editLines.hidden = !phrases.length;
    if (!phrases.length) setEditing(false);
    paint();
  };
  const remembered = (saved) => {
    phrases = saved;
    paintPhrases();
  };
  const saveTyped = () => {
    const line = text.value.trim();
    if (!line) return;
    void attempt(async () => {
      remembered((await request(api('/phrases'), { method: 'POST', json: { text: line } })).phrases);
      text.value = '';
      saveLine.hidden = true;
      toast('Saved the line. Tap it to say it.');
    });
  };
  text.addEventListener('input', () => (saveLine.hidden = !text.value.trim()));

  const form = el(
    'form',
    {
      className: 'toolbar say',
      onsubmit: async (e) => {
        e.preventDefault();
        const line = text.value.trim();
        if (send.disabled || !line) return;
        // The box clears straight away, as the bot only answers once the line starts, which can take a while
        saying = true;
        send.textContent = 'Saying…';
        text.value = '';
        saveLine.hidden = true;
        paint();
        const sent = await attempt(async () => {
          await voice.say(line, picker.value);
          return true;
        });
        // Back in the box to try again, unless something new was typed meanwhile
        if (!sent && !text.value) {
          text.value = line;
          saveLine.hidden = false;
        }
        saying = false;
        send.textContent = 'Say';
        paint();
      },
    },
    text,
    saveLine,
    send,
  );
  // Apart from the sounds' volume, so a quiet voice can be turned up without the soundboard
  const volume = volumeControl({
    min: 25,
    max: 200,
    label: 'Speech volume',
    onSave: (value) =>
      void attempt(async () => {
        await request(api('/settings/ttsVolume'), { method: 'PUT', json: { value } });
        toast(`Speech plays at ${value}% for everyone now.`);
      }),
  });
  const node = el('div', { className: 'say-box', hidden: true }, form, row);
  void attempt(async () => {
    const { on, voices, voice: serverDefault, volume: loudness, longest, phrases: saved } = await request(api('/say'));
    if (guildId !== state.guildId) return;
    volume.set(loudness);
    text.maxLength = longest;
    // The voice last used on this device, while the bot still offers it
    const mine = recall(voiceKey);
    picker.replaceChildren(...voiceOptions(voices, voices.some((v) => v.id === mine) ? mine : serverDefault));
    node.hidden = !on;
    if (on) voice.addVolume('Speech', volume.node);
    remembered(saved);
  });
  return { node, paint };
}

/** Big buttons for playing sounds during a game: favourites first, then whatever gets played most */
/** `openManage` switches to the Soundboard tab's Manage view, where sounds are added */
export function renderBoard(main, openManage, head = main) {
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
  const say = sayBox(voice);
  // Tooltips don't show on a phone, so the reason the tiles are grey is said where it's seen
  const nobody = notice('empty', 'Nobody’s in voice. Join a voice channel in Discord and these light up.', { compact: true });
  nobody.hidden = true;
  // Beside Play | Manage when there's a slot for it, a row higher up
  head.append(search);
  main.append(voice.node, say.node, nobody, board);
  board.append(notice('loading', 'Loading sounds…'));

  function paint() {
    const channel = voice.channel();
    say.paint();
    nobody.hidden = !voice.loaded() || !!channel;
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
      el('span', { className: 'tile-emoji', ariaHidden: 'true' }, sound.emoji ? emojiNode(sound.emoji, '') : icon('speaker')),
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
      icon('star'),
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
