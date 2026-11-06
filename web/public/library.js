import { pickClip } from './clip.js';
import { emojiPicker } from './emojipicker.js';
import { api, attempt, confirmButton, el, emojiNode, openDialog, player, recall, remember, request, soundPath, state, toast } from './lib.js';
import { pickTrim } from './trim.js';
import { voiceBar } from './voice.js';

const MAX_BYTES = 5 * 1024 * 1024;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|opus|webm|flac)$/i;
const MAX_NOTES = 4;

const formatSeconds = (s) => (s === null ? 'unreadable' : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`);

function fileToName(file) {
  return file.name
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** The files in a dropped file or folder. A folder's readEntries gives a batch at a time, until one comes back empty */
async function filesIn(entry) {
  if (entry.isFile) return [await new Promise((resolve, reject) => entry.file(resolve, reject))];
  const reader = entry.createReader();
  const found = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return found.filter((file) => AUDIO_FILE.test(file.name));
    for (const child of batch) found.push(...(await filesIn(child)));
  }
}

export function renderLibrary(main) {
  const guildId = state.guildId;
  let data = null;
  let filter = '';
  let queue = [];
  let toDiscord = recall('uploadToDiscord') !== 'no';
  const previews = new Map();
  const players = new Map();
  const boardPreviews = new Map();
  const boardPlayers = new Map();
  player.onChange = () => {
    previews.forEach((button, name) => paintPreview(name, button));
    boardPreviews.forEach(({ name, button }, key) => paintPreview(name, button, key));
  };

  const search = el('input', {
    type: 'search',
    placeholder: 'Search sounds',
    ariaLabel: 'Search sounds',
    oninput: (e) => {
      filter = e.target.value.trim().toLowerCase();
      renderList();
    },
  });
  const voice = voiceBar(main, () => {
    players.forEach((button, name) => paintPlay(name, button));
    boardPlayers.forEach((button, name) => paintPlay(name, button));
  });
  const slots = el('div', { className: 'slots' });
  const boardBody = el('div', { className: 'board-body' });
  const board = el(
    'details',
    { className: 'discord-board', open: recall('discordBoard') === 'open', ontoggle: (e) => remember('discordBoard', e.target.open ? 'open' : 'closed') },
    el('summary', {}, el('span', {}, 'Discord’s soundboard'), slots),
    boardBody,
  );
  const sync = el(
    'button',
    {
      onclick: () =>
        attempt(async () => {
          sync.disabled = true;
          sync.textContent = 'Syncing…';
          try {
            report(await request(api('/discord-sync'), { method: 'POST' }));
            await load();
          } finally {
            sync.disabled = false;
            sync.textContent = 'Sync to Discord';
          }
        }),
    },
    'Sync to Discord',
  );
  const picker = el('input', {
    type: 'file',
    multiple: true,
    accept: '.mp3,.ogg,.wav,.m4a,.opus,.webm,.flac,audio/*',
    hidden: true,
    onchange: () => {
      addFiles([...picker.files]);
      picker.value = '';
    },
  });
  const dropzone = el(
    'div',
    {
      className: 'dropzone',
      tabIndex: 0,
      role: 'button',
      onclick: () => picker.click(),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          picker.click();
        }
      },
      ondragover: (e) => {
        e.preventDefault();
        dropzone.classList.add('over');
      },
      ondragleave: () => dropzone.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault();
        dropzone.classList.remove('over');
        // Has to be read now: the list empties once this handler returns
        const entries = [...e.dataTransfer.items].map((item) => item.webkitGetAsEntry());
        const files = [...e.dataTransfer.files];
        void attempt(async () => addFiles(entries.every(Boolean) ? (await Promise.all(entries.map(filesIn))).flat() : files));
      },
    },
    'Drop audio files or a folder here, or click to choose',
  );
  const queueBox = el('div', { className: 'queue', hidden: true });
  const list = el('div', { className: 'list' });

  main.append(
    voice.node,
    el('div', { className: 'toolbar' }, search, sync),
    board,
    dropzone,
    picker,
    queueBox,
    list,
  );
  list.append(el('div', { className: 'empty' }, 'Loading sounds…'));

  function report({ added, tooLong, failed, waiting, blocker }) {
    const lines = [added.length ? `Added to Discord: ${added.join(', ')}` : 'Nothing new to add to Discord.'];
    if (blocker) lines.push(`Stopped because ${blocker}. Still bot-only: ${waiting.join(', ')}`);
    if (tooLong.length) lines.push(`Too long for Discord: ${tooLong.join(', ')}`);
    if (failed.length) lines.push(`Failed: ${failed.join(', ')}`);
    toast(lines.join('\n'), failed.length > 0 || !!blocker);
  }

  async function load() {
    const fresh = await request(api('/sounds'));
    // Still on this server, if the request took a while
    if (guildId !== state.guildId || !main.isConnected) return;
    data = fresh;
    renderSlots();
    renderBoard();
    renderList();
    renderQueue();
  }

  function renderSlots() {
    if (!data.slots) return slots.replaceChildren('Discord slots unavailable');
    const { used, total } = data.slots;
    slots.replaceChildren(
      el('div', { className: 'meter' }, el('div', { style: `width: ${Math.min(100, (used / total) * 100)}%` })),
      `${used} of ${total} Discord slots`,
    );
  }

  const isFull = () => !!data.slots && data.slots.used >= data.slots.total;

  /** Puts a library sound in a Discord sound's slot, asking which part to use if it's long */
  async function swap(sound, outgoing) {
    if (sound.fitsDiscord) await request(soundPath(sound.name, '/discord'), { method: 'PUT', json: { replacing: outgoing.id } });
    else if (!(await pickClip(main, sound, data.clipSeconds, outgoing.id))) return;
    toast(`${sound.name} took ${outgoing.name}’s slot.`);
  }

  /** A list to pick one sound from, searchable as there can be a lot. Resolves with the one picked, or null */
  function pickSound(heading, text, sounds) {
    return new Promise((resolve) => {
      let picked = null;
      const list = el('div', { className: 'merge-list' });
      const paint = () => {
        const query = input.value.trim().toLowerCase();
        const shown = sounds.filter((s) => s.name.toLowerCase().includes(query));
        list.replaceChildren(
          ...shown.map((sound) =>
            el(
              'button',
              {
                className: 'swap-row',
                disabled: sound.removable === false,
                title: sound.removable === false ? 'The bot needs Manage Expressions to take this one off' : `Pick ${sound.name}`,
                onclick: () => {
                  picked = sound;
                  node.close();
                },
              },
              sound.emoji && el('span', { className: 'tile-emoji' }, emojiNode(sound.emoji, '')),
              el('span', { className: 'rank-name' }, sound.name),
              sound.seconds != null && el('span', { className: 'rank-note' }, formatSeconds(sound.seconds)),
            ),
          ),
        );
        if (!shown.length) list.append(el('p', {}, sounds.length ? 'No sounds match that.' : 'There’s nothing to pick from.'));
      };
      const input = el('input', { type: 'search', placeholder: 'Search sounds', ariaLabel: 'Search sounds', oninput: paint });
      const node = openDialog(main, el('h2', {}, heading), el('p', {}, text), input, list, el('div', { className: 'actions' }, el('button', { onclick: () => node.close() }, 'Cancel')));
      node.addEventListener('close', () => resolve(picked));
      paint();
    });
  }

  const pickOutgoing = (sound) => pickSound(`Swap in ${sound.name}`, 'Discord’s soundboard is full. Pick one to swap out. If it isn’t in the library, it’s saved there first.', data.discordSounds);

  const pickIncoming = (outgoing) =>
    pickSound(
      `Swap out ${outgoing.name}`,
      `Pick the library sound to take its slot.${outgoing.library ? '' : ' It’s saved to the library first.'}`,
      data.sounds.filter((s) => !s.onDiscord),
    );

  function discordRow(sound) {
    const saved = data.sounds.find((s) => s.name === sound.library);
    const key = `discord:${sound.id}`;
    const label = `${sound.name} on Discord`;
    const preview = el('button', {
      className: 'quiet icon',
      onclick: () => player.toggle(saved ? soundPath(saved.name, '/audio') : api(`/discord-sounds/${sound.id}/audio`), key, saved ? saved.loudness : sound.volume),
    });
    boardPreviews.set(key, { name: label, button: preview });
    paintPreview(label, preview, key);
    const play = el('button', { className: 'primary icon', onclick: () => attempt(() => voice.playDiscord(sound.id)) }, '▶');
    boardPlayers.set(label, play);
    paintPlay(label, play);
    const whyNot = sound.removable ? undefined : 'The bot needs Manage Expressions to change sounds it didn’t add';
    const change = (action) =>
      attempt(async () => {
        try {
          await action();
        } finally {
          await load();
        }
      });
    return el(
      'div',
      { className: 'discord-row' },
      play,
      preview,
      el('span', { className: 'tile-emoji' }, sound.emoji ? emojiNode(sound.emoji, '') : ''),
      el('div', { className: 'name' }, el('span', {}, sound.name), el('span', { className: 'meta' }, saved ? 'In library' : 'Not in library')),
      !saved &&
        el(
          'button',
          {
            ariaLabel: `Save ${sound.name} to library`,
            onclick: () =>
              change(async () => {
                const { name } = await request(api(`/discord-sounds/${sound.id}/save`), { method: 'POST' });
                toast(`Saved ${sound.name} to the library as ${name}.`);
              }),
          },
          'Save to library',
        ),
      el(
        'button',
        {
          ariaLabel: `Swap ${sound.name}`,
          disabled: !sound.removable,
          title: whyNot,
          onclick: () =>
            change(async () => {
              const incoming = await pickIncoming(sound);
              if (incoming) await swap(incoming, sound);
            }),
        },
        'Swap',
      ),
      el(
        'button',
        {
          ariaLabel: `Take ${sound.name} off Discord`,
          disabled: !sound.removable,
          title: whyNot,
          onclick: () =>
            change(async () => {
              await request(api(`/discord-sounds/${sound.id}`), { method: 'DELETE' });
              toast(saved ? `Took ${sound.name} off Discord.` : `Took ${sound.name} off Discord and saved it to the library.`);
            }),
        },
        'Take off',
      ),
    );
  }

  function saveAll(unsaved) {
    return attempt(async () => {
      const failed = [];
      for (const sound of unsaved) await request(api(`/discord-sounds/${sound.id}/save`), { method: 'POST' }).catch(() => failed.push(sound.name));
      await load();
      const done = unsaved.length - failed.length;
      toast([`Saved ${done === 1 ? '1 sound' : `${done} sounds`} to the library.`, failed.length && `Couldn’t save: ${failed.join(', ')}`].filter(Boolean).join('\n'), failed.length > 0);
    });
  }

  function renderBoard() {
    const sounds = data.discordSounds;
    const unsaved = sounds.filter((s) => !s.library);
    boardPreviews.clear();
    boardPlayers.clear();
    boardBody.replaceChildren(
      ...(sounds.length ? [el('div', { className: 'list' }, sounds.map(discordRow))] : [el('div', { className: 'empty' }, data.slots ? 'Nothing on Discord’s soundboard yet.' : 'Discord’s soundboard couldn’t be read.')]),
      ...(sounds.some((s) => !s.removable)
        ? [el('p', { className: 'hint' }, 'Some of these were added by other people. To swap them or take them off, give the bot’s role the Manage Expressions permission.')]
        : []),
      ...(unsaved.length ? [el('div', { className: 'toolbar end' }, el('button', { onclick: (e) => ((e.target.disabled = true), saveAll(unsaved)) }, 'Save all to library'))] : []),
    );
  }

  function renderList() {
    if (!data) return;
    const shown = data.sounds.filter((s) => s.name.includes(filter));
    previews.clear();
    players.clear();
    if (!data.sounds.length) return list.replaceChildren(el('div', { className: 'empty' }, 'No sounds yet. Drop some files above.'));
    if (!shown.length) return list.replaceChildren(el('div', { className: 'empty' }, `Nothing matches “${filter}”.`));
    list.replaceChildren(...shown.map(soundRow));
  }

  // Only these change when a preview starts or stops, since redrawing the list would lose a rename being typed
  function paintPreview(name, button, key = name) {
    const action = player.name === key ? 'Stop' : 'Preview';
    button.title = action;
    button.ariaLabel = `${action} ${name}`;
    button.textContent = action === 'Stop' ? '■' : '🎧';
  }

  function paintPlay(name, button) {
    const channel = voice.channel();
    button.disabled = !channel;
    button.title = channel ? `Play in ${channel.name}` : 'Nobody’s in voice';
    button.ariaLabel = `Play ${name} in voice`;
  }

  function soundRow(sound) {
    const nameBox = el('div', { className: 'name' });
    const showName = () =>
      nameBox.replaceChildren(
        el('button', { title: 'Rename', onclick: rename }, sound.name),
        el('span', { className: 'meta' }, [formatSeconds(sound.seconds), sound.percent !== 100 && `${sound.percent}%`, sound.trimmed && 'trimmed'].filter(Boolean).join(' · ')),
      );

    function rename() {
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const name = input.value.trim().toLowerCase();
        if (!save || !name || name === sound.name) return showName();
        await attempt(async () => {
          await request(soundPath(sound.name), { method: 'PATCH', json: { name } });
          toast(`Renamed to ${name}.`);
          await load();
        });
        showName();
      };
      const input = el('input', {
        value: sound.name,
        maxLength: 32,
        ariaLabel: `New name for ${sound.name}`,
        onkeydown: (e) => {
          if (e.key === 'Enter') void finish(true);
          if (e.key === 'Escape') void finish(false);
        },
        onblur: () => void finish(true),
      });
      nameBox.replaceChildren(input);
      input.select();
    }

    showName();
    const toggle = el('input', {
      type: 'checkbox',
      checked: sound.onDiscord,
      ariaLabel: `${sound.name} on Discord’s soundboard`,
      onchange: () =>
        attempt(async () => {
          toggle.disabled = true;
          try {
            if (!toggle.checked) await request(soundPath(sound.name, '/discord'), { method: 'DELETE' });
            else if (isFull()) {
              const outgoing = await pickOutgoing(sound);
              if (outgoing) await swap(sound, outgoing);
            } else if (sound.fitsDiscord) await request(soundPath(sound.name, '/discord'), { method: 'PUT', json: {} });
            else await pickClip(main, sound, data.clipSeconds);
          } finally {
            await load();
          }
        }),
    });
    const remove = confirmButton({ className: 'quiet icon', title: 'Delete', ariaLabel: `Delete ${sound.name}` }, '✕', 'Delete?', async () => {
      const { discordProblem } = await request(soundPath(sound.name), { method: 'DELETE' });
      if (player.name === sound.name) player.stop();
      toast(discordProblem ? `Deleted ${sound.name}, but it’s still on Discord: ${discordProblem}` : `Deleted ${sound.name}.`, !!discordProblem);
      await load();
    });

    const preview = el('button', { className: 'quiet icon', onclick: () => player.toggle(soundPath(sound.name, '/audio'), sound.name, sound.loudness) });
    previews.set(sound.name, preview);
    paintPreview(sound.name, preview);
    // Not disabled while a request is out, so spamming a sound works as it does on a panel
    const play = el('button', { className: 'primary icon', onclick: () => attempt(() => voice.play(sound.name)) }, '▶');
    players.set(sound.name, play);
    paintPlay(sound.name, play);

    return el(
      'div',
      { className: 'sound' },
      play,
      preview,
      el(
        'button',
        { className: 'quiet icon emoji', title: 'Set emoji', ariaLabel: `Emoji for ${sound.name}`, onclick: () => pickEmoji(sound) },
        sound.emoji ? emojiNode(sound.emoji, 'emoji') : el('span', { className: 'none' }, '＋'),
      ),
      nameBox,
      el('button', { className: 'quiet icon', title: 'Volume', ariaLabel: `Volume for ${sound.name}`, onclick: () => pickVolume(sound) }, '🔉'),
      el('button', { className: 'quiet icon', title: 'Trim', ariaLabel: `Trim ${sound.name}`, onclick: () => attempt(() => trim(sound)) }, '✂'),
      el('label', { className: 'toggle' }, toggle, el('span', {}, 'On Discord')),
      remove,
    );
  }

  function levelNote({ gainDb }) {
    if (!data.evenVolume) return 'Even volume is off in Settings, so only this slider applies.';
    if (gainDb === null) return 'Even volume hasn’t measured this one yet.';
    if (gainDb === 0) return 'Even volume left this one as it is.';
    return `Even volume turned this one ${gainDb > 0 ? 'up' : 'down'} by ${Math.abs(gainDb)} dB. This slider goes on top of that.`;
  }

  async function trim(sound) {
    const done = await pickTrim(main, sound);
    if (!done) return;
    toast(done === 'restored' ? `Restored ${sound.name}.` : `Trimmed ${sound.name}.`);
    await load();
  }

  function pickVolume(start) {
    let sound = start;
    const save = (percent) =>
      attempt(async () => {
        await request(soundPath(sound.name), { method: 'PATCH', json: { volume: percent } });
        await load();
        sound = data.sounds.find((s) => s.name === sound.name) ?? sound;
        note.textContent = levelNote(sound);
      });
    // From the slider, since saving takes a moment and preview shouldn't play the old level until it's done
    const loudness = () => (sound.loudness * Number(slider.value)) / sound.percent;
    const show = (percent) => {
      slider.value = percent;
      label.textContent = `${percent}%`;
      player.setLoudness(sound.name, loudness());
    };
    const note = el('p', {}, levelNote(sound));
    const label = el('output', { className: 'volume-value' });
    const slider = el('input', {
      type: 'range',
      min: 25,
      max: 200,
      step: 5,
      ariaLabel: `Volume for ${sound.name}`,
      oninput: (e) => show(Number(e.target.value)),
      onchange: (e) => save(Number(e.target.value)),
    });
    show(sound.percent);
    const node = openDialog(
      main,
      el('h2', {}, `Volume for ${sound.name}`),
      note,
      el('div', { className: 'volume' }, slider, label),
      el(
        'div',
        { className: 'actions' },
        el(
          'button',
          {
            onclick: () => {
              show(100);
              void save(100);
            },
          },
          'Reset',
        ),
        el('button', { onclick: () => player.toggle(soundPath(sound.name, '/audio'), sound.name, loudness()) }, 'Preview'),
        voice.channel() && el('button', { onclick: () => attempt(() => voice.play(sound.name)) }, 'Play in voice'),
        el('button', { className: 'primary', onclick: () => node.close() }, 'Done'),
      ),
    );
  }

  function pickEmoji(sound) {
    const set = (emoji) =>
      attempt(async () => {
        await request(soundPath(sound.name), { method: 'PATCH', json: { emoji } });
        node.close();
        await load();
      });
    const picker = emojiPicker(data.emojis, set);
    const node = openDialog(
      main,
      el('h2', {}, `Emoji for ${sound.name}`),
      el(
        'form',
        {
          onsubmit: (e) => {
            e.preventDefault();
            const emoji = picker.chosen();
            if (emoji) void set(emoji);
          },
        },
        ...picker.nodes,
        el(
          'div',
          { className: 'actions' },
          sound.emoji && el('button', { type: 'button', onclick: () => set(null) }, 'Clear'),
          el('button', { type: 'button', onclick: () => node.close() }, 'Cancel'),
        ),
      ),
    );
  }

  function addFiles(files) {
    for (const file of files) queue.push({ file, name: fileToName(file), status: null });
    renderQueue();
  }

  function problemWith(item) {
    if (item.file.size > MAX_BYTES) return 'Over 5 MB, so it can’t be added.';
    if (!NAME_PATTERN.test(item.name)) return 'Use lowercase letters, numbers, - and _.';
    if (queue.some((other) => other !== item && other.name === item.name)) return 'Two files have this name.';
    return null;
  }

  function renderQueue() {
    queueBox.hidden = !queue.length;
    if (!queue.length) return queueBox.replaceChildren();
    const rows = queue.map((item) => {
      const problem = problemWith(item);
      const replaces = !problem && data?.sounds.some((s) => s.name === item.name);
      const note = item.status?.bad ? item.status.text : problem ?? (replaces ? `Replaces the existing ${item.name}.` : null);
      return el(
        'div',
        { className: 'queue-row' },
        el('input', {
          value: item.name,
          maxLength: 32,
          ariaLabel: `Name for ${item.file.name}`,
          disabled: item.busy,
          onchange: (e) => {
            item.name = e.target.value.trim().toLowerCase();
            item.status = null;
            renderQueue();
          },
        }),
        el('span', { className: 'file', title: item.file.name }, item.file.name),
        el(
          'button',
          {
            className: 'quiet icon',
            title: 'Remove from list',
            ariaLabel: `Remove ${item.file.name} from list`,
            disabled: item.busy,
            onclick: () => {
              queue = queue.filter((other) => other !== item);
              renderQueue();
            },
          },
          '✕',
        ),
        note && el('span', { className: `note ${problem || item.status?.bad ? 'bad-text' : ''}` }, note),
      );
    });
    const ready = queue.filter((item) => !problemWith(item) && !item.busy);
    const uploading = queue.filter((item) => item.busy).length;
    queueBox.replaceChildren(
      ...rows,
      el(
        'div',
        { className: 'queue-actions' },
        el(
          'label',
          { className: 'check' },
          el('input', {
            type: 'checkbox',
            checked: toDiscord,
            disabled: uploading > 0,
            onchange: (e) => {
              toDiscord = e.target.checked;
              remember('uploadToDiscord', toDiscord ? 'yes' : 'no');
            },
          }),
          'Also add to Discord’s soundboard',
        ),
        el(
          'button',
          {
            disabled: uploading > 0,
            onclick: () => {
              queue = [];
              renderQueue();
            },
          },
          'Clear',
        ),
        el(
          'button',
          { className: 'primary', disabled: !ready.length, onclick: uploadAll },
          uploading ? `Uploading, ${uploading} to go…` : ready.length > 1 ? `Upload ${ready.length} sounds` : 'Upload',
        ),
      ),
    );
  }

  /** One message for the whole batch, however many sounds it was */
  function reportUploads({ added, replaced, notes }) {
    const count = (n, word) => (n ? `${word} ${n} sound${n === 1 ? '' : 's'}` : null);
    const done = [count(added, 'Added'), count(replaced, 'replaced')].filter(Boolean).join(', ');
    const shown = notes.slice(0, MAX_NOTES).map((note) => `Bot soundboard only: ${note}`);
    if (notes.length > MAX_NOTES) shown.push(`And ${notes.length - MAX_NOTES} more are bot-only.`);
    if (done || shown.length) toast([`${done}.`, ...shown].join('\n'));
  }

  async function uploadAll() {
    const items = queue.filter((item) => !problemWith(item));
    for (const item of items) item.busy = true;
    const uploaded = { added: 0, replaced: 0, notes: [] };
    renderQueue();
    for (const item of items) {
      try {
        const query = `?file=${encodeURIComponent(item.file.name)}${toDiscord ? '' : '&discord=0'}`;
        const { replaced, discordProblem } = await request(soundPath(item.name) + query, { method: 'PUT', body: item.file });
        queue = queue.filter((other) => other !== item);
        uploaded[replaced ? 'replaced' : 'added'] += 1;
        if (discordProblem) uploaded.notes.push(`${item.name}, ${discordProblem}.`);
      } catch (err) {
        item.busy = false;
        item.status = { bad: true, text: err.message };
      }
      renderQueue();
    }
    reportUploads(uploaded);
    await attempt(load);
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

