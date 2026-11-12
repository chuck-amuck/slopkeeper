import { announce, api, attempt, confirmButton, el, emojiNode, fetchAudio, forget, icon, keepFocus, notice, player, recall, remember, request, soundPath, state, toast, undoToast } from './lib.js';
import { elapsed, onPlaying } from './playing.js';
import { followWhenIdle, older } from './updates.js';
import { voiceBar } from './voice.js';

const byUse = (a, b) => b.plays - a.plays || a.name.localeCompare(b.name);
// What the sounds in no group are called, and the group the star puts sounds in
const EVERYTHING_ELSE = 'Everything else';
const FAVOURITES = 'favourites';
// Whether Speech is folded away, on this device
const SPEECH_FOLDED = 'speechFolded';
// Which groups are folded away, on this device, for each server: `g<id>`, or `rest` for Everything else
const foldedKey = (guildId) => `foldedGroups:${guildId}`;

/**
 * A section's heading, which folds `body` away and back where it is. `count` shows while it's folded, so nothing looks
 * missing. onFold(open) hears each change
 */
function foldHead(name, open, body, onFold, count = null) {
  const number = count === null ? null : el('span', { className: 'fold-count', hidden: open }, String(count));
  const button = el('button', { type: 'button', className: 'fold-toggle', ariaExpanded: String(open), onclick: () => fold(button.ariaExpanded !== 'true') }, icon('chevron'), el('span', {}, name), number);
  const fold = (on) => {
    button.ariaExpanded = String(on);
    body.hidden = !on;
    if (number) number.hidden = on;
    onFold(on);
  };
  body.hidden = !open;
  return el('h2', { className: 'fold-head' }, button);
}

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
 * Has the bot read out what's typed: one row for the line, the voice with a preview only you hear, and Say, then the
 * saved lines. Folds away to its heading, remembered on this device, and stays hidden if there's no voice to read it
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
  // On a phone the saved lines scroll sideways, so the sounds stay near the top; All unfolds them
  const scroller = el('div', { className: 'phrase-scroll' }, chips, editLines);
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
    row.hidden = !phrases.length;
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
      className: 'say-form',
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
    el('div', { className: 'say-text' }, text, saveLine),
    // The voice is a choice for the line being sent, so it sits with Say
    el('div', { className: 'say-voices' }, picker, preview),
    send,
  );
  const body = el('div', { className: 'say-body' }, form, row);
  const head = foldHead('Speech', recall(SPEECH_FOLDED) !== '1', body, (open) => (open ? forget(SPEECH_FOLDED) : remember(SPEECH_FOLDED, '1')));
  const node = el('div', { className: 'say-box', hidden: true }, head, body);
  void attempt(async () => {
    const { on, voices, voice: serverDefault, longest, phrases: saved } = await request(api('/say'));
    if (guildId !== state.guildId) return;
    text.maxLength = longest;
    // The voice last used on this device, while the bot still offers it
    const mine = recall(voiceKey);
    picker.replaceChildren(...voiceOptions(voices, voices.some((v) => v.id === mine) ? mine : serverDefault));
    node.hidden = !on;
    remembered(saved);
  });
  return { node, paint };
}

/**
 * Big buttons for playing sounds during a game: the server's groups in their order, then whatever gets played most. Arrange sorts
 * them into groups. `openManage` switches to the Soundboard tab's Manage view, where sounds are added; `arrange` opens in Arrange
 */
export function renderBoard(main, openManage, head = main, arrange = false) {
  const guildId = state.guildId;
  let sounds = null;
  let groups = [];
  let filter = '';
  let arranging = false;
  /** The sound picked up in Arrange, to put where the next tap says */
  let picked = null;
  const tiles = [];
  /** Each tile shown, by sound name, to mark the ones playing */
  const shownTiles = new Map();
  let nowPlaying = [];

  const voice = voiceBar(paint);
  const search = el('input', {
    type: 'search',
    className: 'board-search',
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
  const arrangeLabel = el('span', { className: 'arrange-label' }, 'Arrange');
  const arrangeButton = el('button', { type: 'button', className: 'with-icon arrange-toggle', title: 'Sort sounds into groups and put them in order', onclick: () => setArranging(!arranging) }, icon('grip'), arrangeLabel);
  const newGroup = el('input', { ariaLabel: 'New group’s name', placeholder: 'New group', maxLength: 40, autocomplete: 'off' });
  const arrangeBar = el(
    'div',
    { className: 'arrange-bar' },
    el('p', { className: 'hint' }, 'Tap a sound, then tap where it goes: a sound to go in front of, or the end of a group. With a mouse, drag them. Sounds in no group come last, most played first. Discord’s panel follows this order.'),
    el(
      'form',
      {
        className: 'toolbar',
        onsubmit: (e) => {
          e.preventDefault();
          const name = newGroup.value.trim();
          if (!name) return;
          void changeGroups(() => request(api('/sound-groups'), { method: 'POST', json: { name } })).then((ok) => {
            if (!ok) return;
            newGroup.value = '';
            toast(`Made ${name}. Move sounds into it.`);
          });
        },
      },
      newGroup,
      el('button', { type: 'submit' }, 'Add group'),
    ),
  );
  // Beside Play | Manage when there's a slot for it, a row higher up. The search is just above the sounds it searches
  head.append(arrangeButton);
  main.append(voice.node, say.node, search, nobody, board);
  board.append(notice('loading', 'Loading sounds…'));

  function paint() {
    const channel = voice.channel();
    say.paint();
    nobody.hidden = arranging || !voice.loaded() || !!channel;
    for (const tile of tiles) {
      // Arranging works with nobody in voice
      tile.disabled = !arranging && !channel;
      tile.title = arranging ? '' : channel ? `Play in ${channel.name}` : 'Nobody’s in voice';
    }
  }

  // ---------- arranging ----------
  function setArranging(on) {
    arranging = on;
    picked = null;
    // The words change, so it's not a pressed/unpressed toggle to a screen reader
    arrangeLabel.textContent = on ? 'Done' : 'Arrange';
    arrangeButton.replaceChildren(icon(on ? 'check' : 'grip'), arrangeLabel);
    arrangeButton.classList.toggle('primary', on);
    board.classList.toggle('arranging', on);
    render();
    if (on) announce('Arranging. Pick a sound, then where it goes.');
  }

  /** Marks the sound picked up, and shows the places at the end of each group it can go */
  function markPicked() {
    board.classList.toggle('moving', !!picked);
    for (const [name, { button }] of shownTiles) {
      button.classList.toggle('picked', name === picked);
      if (arranging) button.ariaPressed = String(name === picked);
    }
  }

  /**
   * The sounds as they are now, in the order they're shown: new ones go at the end, deleted ones go, and the rest stay
   * where they are, so the board doesn't reshuffle under someone tapping it
   */
  function useSounds(fresh) {
    const now = new Map(fresh.map((s) => [s.name, s]));
    const kept = sounds.filter((s) => now.has(s.name)).map((s) => now.get(s.name));
    const known = new Set(kept.map((s) => s.name));
    sounds = [...kept, ...fresh.filter((s) => !known.has(s.name)).sort(byUse)];
  }

  /** The star shows whether a sound is in Favourites */
  function useGroups(fresh) {
    groups = fresh;
    const starred = new Set(groups.find((g) => g.name.toLowerCase() === FAVOURITES)?.sounds ?? []);
    for (const s of sounds) s.favourite = starred.has(s.name);
  }

  /** Runs a change to the groups, then shows them as the bot has them. Resolves to whether it worked */
  async function changeGroups(action) {
    const fresh = await attempt(action);
    if (!fresh?.groups || guildId !== state.guildId || !main.isConnected) return false;
    useGroups(fresh.groups);
    render();
    return true;
  }

  /** Puts the picked sound before `before` in `group`, or at its end, or with no group among the rest */
  function putPicked(group, before = null) {
    const name = picked;
    picked = null;
    markPicked();
    if (!name || name === before) return;
    void changeGroups(() => request(soundPath(name), { method: 'PATCH', json: { place: { group: group?.id ?? null, before: group ? before : null } } })).then(
      (ok) => ok && announce(`Moved ${name} ${group ? `to ${group.name}` : `to ${EVERYTHING_ELSE}`}.`),
    );
  }

  /** A tile pressed while arranging: picks it up, puts it down again, or puts the one picked up in front of it */
  function arrangeTap(sound, group) {
    if (!picked) {
      picked = sound.name;
      markPicked();
      return announce(`Picked ${sound.name}. Now pick where it goes.`);
    }
    if (picked === sound.name) {
      picked = null;
      return markPicked();
    }
    putPicked(group, sound.name);
  }

  /** Where a dragged sound can land: on a tile, in front of it, or the end of a group */
  const dropOn = (node, group, before) => ({
    ondragover: (e) => {
      if (!arranging || !picked || picked === before) return;
      e.preventDefault();
      node.classList.add('drop-before');
    },
    ondragleave: () => node.classList.remove('drop-before'),
    ondrop: (e) => {
      e.preventDefault();
      node.classList.remove('drop-before');
      putPicked(group, before);
    },
  });

  /** The place at the end of a group, shown while a sound is picked up */
  function endOf(group) {
    const slot = el('button', { type: 'button', className: 'tile drop-slot', onclick: () => putPicked(group) }, group ? `End of ${group.name}` : EVERYTHING_ELSE);
    Object.assign(slot, dropOn(slot, group, null));
    return slot;
  }

  /** A group's heading while arranging: its name to change, moving it, and deleting it */
  function groupHead(group, index) {
    const name = el('input', {
      className: 'group-name',
      value: group.name,
      maxLength: 40,
      ariaLabel: `Group name: ${group.name}`,
      onchange: () => {
        const to = name.value.trim();
        if (!to || to === group.name) return void (name.value = group.name);
        void changeGroups(() => request(api(`/sound-groups/${group.id}`), { method: 'PATCH', json: { name: to } })).then((ok) => ok || (name.value = group.name));
      },
    });
    const moveTo = (to) => void changeGroups(() => request(api(`/sound-groups/${group.id}`), { method: 'PATCH', json: { to } }));
    return el(
      'div',
      { className: 'group-head' },
      name,
      el('button', { type: 'button', className: 'icon', ariaLabel: `Move ${group.name} up`, title: 'Move up', disabled: index === 0, onclick: () => moveTo(index - 1) }, icon('up')),
      el('button', { type: 'button', className: 'icon', ariaLabel: `Move ${group.name} down`, title: 'Move down', disabled: index === groups.length - 1, onclick: () => moveTo(index + 1) }, icon('down')),
      confirmButton({ type: 'button', className: 'quiet', title: `Its sounds go back to ${EVERYTHING_ELSE}` }, 'Delete', `Delete ${group.name}?`, () =>
        changeGroups(() => request(api(`/sound-groups/${group.id}`), { method: 'DELETE' })).then(
          (ok) =>
            ok &&
            undoToast(`Deleted ${group.name}. Its sounds are in ${EVERYTHING_ELSE}.`, () =>
              changeGroups(() => request(api('/sound-groups'), { method: 'POST', json: { name: group.name, sounds: group.sounds, at: index } })),
            ),
        ),
      ),
    );
  }

  function tile(sound, group = null) {
    const button = el(
      'button',
      {
        className: 'tile',
        draggable: arranging,
        onclick: () => {
          if (arranging) return arrangeTap(sound, group);
          // Restarts the flash on every press, so spamming still shows
          button.classList.remove('hit');
          void button.offsetWidth;
          button.classList.add('hit');
          void attempt(() => voice.play(sound.name));
        },
        ondragstart: (e) => {
          dragging = true;
          picked = sound.name;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', sound.name);
          markPicked();
        },
        ondragend: () => {
          dragging = false;
          picked = null;
          markPicked();
        },
      },
      el('span', { className: 'tile-emoji', ariaHidden: 'true' }, sound.emoji ? emojiNode(sound.emoji, '') : icon('speaker')),
      el('span', { className: 'tile-name' }, sound.name),
    );
    if (arranging) Object.assign(button, dropOn(button, group, sound.name));
    tiles.push(button);
    const progress = el('span', { className: 'tile-progress', hidden: true });
    shownTiles.set(sound.name, { button, progress, sound });
    // A sound is in one group at most, so starring one in another group moves it out of there
    const other = sound.favourite ? null : group;
    const star = el(
      'button',
      {
        className: 'star',
        ariaLabel: sound.favourite ? `Remove ${sound.name} from favourites` : other ? `Move ${sound.name} from ${other.name} to favourites` : `Add ${sound.name} to favourites`,
        title: sound.favourite ? 'Remove from favourites' : other ? `Move from ${other.name} to favourites` : 'Add to favourites',
        ariaPressed: String(sound.favourite),
        onclick: () =>
          void changeGroups(() => request(soundPath(sound.name), { method: 'PATCH', json: { favourite: !sound.favourite } })).then((ok) => {
            if (ok && other) toast(`Moved ${sound.name} from ${other.name} to Favourites.`);
          }),
      },
      icon('star'),
    );
    return el('div', { className: 'tile-box' }, button, progress, ...(arranging ? [] : [star]));
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

  // Groups folded away on this device. A search or Arrange shows them all, and they fold again after
  let folded = new Set();
  try {
    folded = new Set(JSON.parse(recall(foldedKey(guildId)) ?? '[]'));
  } catch {}
  const foldId = (group) => (group ? `g${group.id}` : 'rest');
  /** A group's heading, which folds its sounds away, unless a search has every group open */
  const headOf = (group, list, grid) => {
    const name = group?.name ?? EVERYTHING_ELSE;
    if (filter) return el('h2', {}, name);
    const id = foldId(group);
    const onFold = (open) => {
      if (open) folded.delete(id);
      else folded.add(id);
      // Groups deleted since are forgotten
      const ids = new Set(['rest', ...groups.map(foldId)]);
      folded = new Set([...folded].filter((x) => ids.has(x)));
      if (folded.size) remember(foldedKey(guildId), JSON.stringify([...folded]));
      else forget(foldedKey(guildId));
    };
    return foldHead(name, !folded.has(id), grid, onFold, list.length);
  };

  function render() {
    tiles.length = 0;
    shownTiles.clear();
    if (!sounds.length) return board.replaceChildren(notice('empty', 'No sounds yet. ', el('button', { className: 'link', onclick: openManage }, 'Add some in Manage'), '.'));
    const shown = sounds.filter((s) => s.name.includes(filter));
    if (!shown.length && !arranging) return board.replaceChildren(notice('empty', `Nothing matches “${filter}”.`));
    const byName = new Map(shown.map((s) => [s.name, s]));
    const grouped = new Set(groups.flatMap((g) => g.sounds));
    // Arranging shows every group, empty or not, to move sounds into
    const sections = groups.map((group, index) => ({ group, index, list: group.sounds.map((n) => byName.get(n)).filter(Boolean) })).filter((x) => arranging || x.list.length);
    // In the order they were loaded in, most played first then, and new ones after
    const rest = shown.filter((s) => !grouped.has(s.name));
    const grid = (list, group) => el('div', { className: 'tiles' }, list.map((s) => tile(s, group)), arranging ? endOf(group) : []);
    keepFocus(board, () =>
      board.replaceChildren(
        ...(arranging ? [arrangeBar] : []),
        ...sections.flatMap(({ group, index, list }) => {
          const box = grid(list, group);
          return [
            arranging ? groupHead(group, index) : headOf(group, list, box),
            ...(arranging && !list.length ? [el('p', { className: 'hint' }, filter ? `None of its sounds match “${filter}”.` : 'Empty. Pick a sound and put it here.')] : []),
            box,
          ];
        }),
        ...(rest.length || arranging
          ? (() => {
              const box = grid(rest, null);
              // Without groups, there's no heading to fold it with
              return [...(sections.length ? [arranging ? el('h2', {}, EVERYTHING_ELSE) : headOf(null, rest, box)] : []), box];
            })()
          : []),
      ),
    );
    markPicked();
    markPlaying();
    paint();
  }

  // What's shown comes from the first load and from changes made anywhere: other tabs, Discord and the bot itself.
  // Whichever arrives first is used, and nothing older than what's shown
  let dragging = false;
  let shown = '';
  function useData(fresh) {
    if (guildId !== state.guildId || !main.isConnected || older(fresh.version, shown)) return false;
    shown = fresh.version;
    if (sounds) useSounds(fresh.sounds);
    else sounds = fresh.sounds.sort(byUse);
    useGroups(fresh.groups ?? []);
    if (picked && !sounds.some((s) => s.name === picked)) picked = null;
    return true;
  }
  // A change that comes while a group's name is being typed, a Delete waits for its second press or a sound is being
  // dragged waits until that's done
  followWhenIdle('sounds', main, () => [board], (fresh) => useData(fresh) && render(), () => dragging);

  void attempt(async () => {
    try {
      const fresh = await request(api('/sounds'));
      if (guildId !== state.guildId || !main.isConnected) return;
      useData(fresh);
      if (arrange) setArranging(true);
      else render();
    } catch (err) {
      board.replaceChildren(notice('error', err.message));
      throw err;
    }
  });
}
