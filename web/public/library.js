import { pickClip } from './clip.js';
import { emojiPicker } from './emojipicker.js';
import { byUse, EVERYTHING_ELSE } from './soundgrid.js';
import { announce, api, attempt, confirmButton, el, emojiNode, icon, keepFocus, notice, openDialog, player, postDialog, recall, remember, request, RequestError, soundPath, state, toast, undoToast, volumeControl } from './lib.js';
import { pickTrim } from './trim.js';
import { followWhenIdle, older } from './updates.js';
import { voiceBar } from './voice.js';

const MAX_BYTES = 5 * 1024 * 1024;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const AUDIO_FILE = /\.(mp3|ogg|wav|m4a|opus|webm|flac)$/i;
const MAX_NOTES = 4;
const DAY = 86_400_000;

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

/**
 * Manage: adding sounds, Discord's own soundboard, and sorting the sounds into groups, which Play and Discord's panel
 * follow
 */
export function renderLibrary(main) {
  const guildId = state.guildId;
  let data = null;
  // The version of the sounds shown, so an answer that's been overtaken isn't shown over a newer one
  let shown = '';
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
  // The channel is Play in, in the header, and the volumes are behind the Volume button
  const voice = voiceBar(
    () => {
      players.forEach((button, name) => paintPlay(name, button));
      boardPlayers.forEach((button, name) => paintPlay(name, button));
    },
    { sliders: false },
  );
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
  // Rarely needed mid-call, so it's here rather than on Play
  const postPanel = el(
    'button',
    {
      onclick: () =>
        postDialog(main, 'Post a panel', 'Puts the soundboard buttons in a Discord channel. The panel keeps itself up to date as sounds change.', async (channelId, channel) => {
          await request(api('/sound-panels'), { method: 'POST', json: { channelId } });
          toast(`Panel posted in ${channel}.`);
        }),
    },
    'Post panel',
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
    // A phone has nothing to drop
    matchMedia('(pointer: coarse)').matches ? 'Tap to choose audio files' : 'Drop audio files or a folder here, or click to choose',
  );
  const queueBox = el('div', { className: 'queue', hidden: true });
  const listHint = el('p', { className: 'hint list-hint', hidden: true });
  const list = el('div', { className: 'list' });
  const makeGroup = el('button', { type: 'button', className: 'with-icon', onclick: () => newGroup() }, icon('plus'), el('span', {}, 'New group'));
  const bin = el('div', { className: 'stack bin' });

  main.append(
    voice.node,
    el('div', { className: 'toolbar' }, search, makeGroup, sync, postPanel),
    board,
    dropzone,
    picker,
    queueBox,
    listHint,
    list,
    bin,
  );
  list.append(notice('loading', 'Loading sounds…'));

  function report({ added, tooLong, failed, waiting, blocker }) {
    const lines = [added.length ? `Added to Discord: ${added.join(', ')}` : 'Nothing new to add to Discord.'];
    if (blocker) lines.push(`Stopped because ${blocker}. Still bot-only: ${waiting.join(', ')}`);
    if (tooLong.length) lines.push(`Too long for Discord: ${tooLong.join(', ')}`);
    if (failed.length) lines.push(`Failed: ${failed.join(', ')}`);
    toast(lines.join('\n'), failed.length > 0 || !!blocker);
  }

  async function load() {
    const [fresh, deleted] = await Promise.all([request(api('/sounds')), request(api('/deleted-sounds'))]);
    // Still on this server, if the request took a while, and not overtaken by a live update
    if (guildId !== state.guildId || !main.isConnected || older(fresh.version, shown)) return;
    shown = fresh.version;
    data = fresh;
    renderSlots();
    renderBoard();
    renderList();
    renderQueue();
    renderBin(deleted);
  }

  // Changes from other tabs, from Discord and from the bot itself. One that comes while you're renaming, sliding a
  // volume, moving a sound or about to delete something waits until you're done, so nothing is pulled out from under you
  followWhenIdle('sounds', main, () => [list, boardBody, bin], ({ bin: deleted, ...fresh }) => {
    if (guildId !== state.guildId || older(fresh.version, shown)) return;
    shown = fresh.version;
    data = fresh;
    renderSlots();
    renderBoard();
    renderList();
    renderBin(deleted);
  }, () => !!moving);

  function renderBin({ days, sounds }) {
    bin.replaceChildren(
      ...(sounds.length
        ? [el('section', { className: 'card' }, el('h2', {}, 'Recently deleted'), el('p', { className: 'card-note' }, `Kept for ${days} days. A restored sound isn’t on Discord’s soundboard until it’s added again.`), sounds.map(deletedRow))]
        : []),
    );
  }

  function deletedRow(sound) {
    const left = Math.ceil((sound.expiresAt - Date.now()) / DAY);
    return el(
      'div',
      { className: 'field' },
      el(
        'div',
        {},
        el('div', { className: 'series-name' }, sound.emoji && emojiNode(sound.emoji, 'emoji'), sound.emoji && ' ', sound.name),
        el('p', { className: 'hint' }, left > 1 ? `Erased in ${left} days` : 'Erased within a day'),
      ),
      el(
        'div',
        { className: 'control' },
        el(
          'button',
          {
            ariaLabel: `Restore ${sound.name}`,
            onclick: () =>
              attempt(async () => {
                const { name } = await request(api(`/deleted-sounds/${sound.id}/restore`), { method: 'POST' });
                toast(name === sound.name ? `${name} is back.` : `${sound.name} is back, as ${name}.`);
                await load();
              }),
          },
          'Restore',
        ),
        confirmButton({ ariaLabel: `Delete ${sound.name} forever` }, 'Delete forever', 'Sure?', async () => {
          await request(api(`/deleted-sounds/${sound.id}`), { method: 'DELETE' });
          toast(`${sound.name} is gone for good.`);
          await load();
        }),
      ),
    );
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
      const node = openDialog(main, { title: heading, body: [el('p', {}, text), input, list], close: 'Cancel' });
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
    const play = el('button', { className: 'icon', onclick: () => attempt(() => voice.playDiscord(sound.id)) }, icon('play'));
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
              const { name } = await request(api(`/discord-sounds/${sound.id}`), { method: 'DELETE' });
              const undo = async () => {
                await request(soundPath(name, '/discord'), { method: 'PUT', json: {} });
                toast(`Put ${name} back on Discord.`);
                await load();
              };
              undoToast(saved ? `Took ${sound.name} off Discord.` : `Took ${sound.name} off Discord and saved it to the library.`, undo);
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
    keepFocus(boardBody, () => boardBody.replaceChildren(
      ...(sounds.length ? [el('div', { className: 'list' }, sounds.map(discordRow))] : [data.slots ? notice('empty', 'Nothing on Discord’s soundboard yet.') : notice('error', 'Discord’s soundboard couldn’t be read.')]),
      ...(sounds.some((s) => !s.removable)
        ? [el('p', { className: 'hint' }, 'Some of these were added by other people. To swap them or take them off, give the bot’s role the Manage Expressions permission.')]
        : []),
      ...(unsaved.length ? [el('div', { className: 'toolbar end' }, el('button', { onclick: (e) => ((e.target.disabled = true), saveAll(unsaved)) }, 'Save all to library'))] : []),
    ));
  }

  /** The sounds in their groups, in the order Play and Discord's panel show them */
  function renderList() {
    if (!data) return;
    // A redraw mid-move puts the sound back; the change it waited for has come
    settle(false);
    previews.clear();
    players.clear();
    listHint.hidden = !data.sounds.length || !!filter;
    if (!data.sounds.length) return list.replaceChildren(notice('empty', 'No sounds yet. Drop some files above.'));
    const byName = new Map(data.sounds.map((s) => [s.name, s]));
    const grouped = new Set(groups().flatMap((g) => g.sounds));
    const sections = [
      ...groups().map((group, index) => ({ group, index, sounds: group.sounds.map((n) => byName.get(n)).filter(Boolean) })),
      { group: null, index: -1, sounds: data.sounds.filter((s) => !grouped.has(s.name)).sort(byUse) },
    ];
    placed = new Map(sections.map(({ group, sounds }) => [keyOf(group), sounds.map((s) => s.name)]));
    const shown = filter ? sections.map((x) => ({ ...x, sounds: x.sounds.filter((s) => s.name.includes(filter)) })).filter((x) => x.sounds.length) : sections;
    if (!shown.length) return list.replaceChildren(notice('empty', `Nothing matches “${filter}”.`));
    // With no groups, there's nothing to move sounds between, and Everything else needs no heading
    const grouping = groups().length > 0;
    listHint.textContent = !grouping
      ? 'New group sorts sounds into sections on Play and on Discord’s panel.'
      : matchMedia('(pointer: coarse)').matches
        ? 'Play and Discord’s panel show the sounds in this order. Tap a sound’s handle to move it to another group, or drag it.'
        : 'Play and Discord’s panel show the sounds in this order. Drag a sound by its handle to move it.';
    keepFocus(list, () =>
      list.replaceChildren(
        ...shown.flatMap(({ group, index, sounds }) => [
          ...(grouping ? [sectionHead(group, index, sounds.length)] : []),
          ...(sounds.length ? sounds.map((s) => soundRow(s, group, grouping)) : [emptyRow(group)]),
        ]),
      ),
    );
  }

  // ---------- groups ----------
  // Play and Discord's panel show the sounds in these groups, in this order, then the rest, most played first
  const groups = () => data?.groups ?? [];
  const keyOf = (group) => (group ? String(group.id) : 'rest');
  /** The sounds in each group as listed, by keyOf, for working out where a moved sound lands */
  let placed = new Map();

  /** Runs a change to the groups, then shows them as the bot has them. Resolves to whether it worked */
  async function changeGroups(action) {
    const fresh = await attempt(action);
    if (!fresh?.groups || guildId !== state.guildId || !main.isConnected) return false;
    data.groups = fresh.groups;
    renderList();
    return true;
  }

  /** Puts a sound in a group, before `before` or at its end, or with no group among the rest */
  const place = (name, group, before = null) =>
    changeGroups(() => request(soundPath(name), { method: 'PATCH', json: { place: { group: group?.id ?? null, before: group ? before : null } } }));

  function newGroup() {
    const name = el('input', { ariaLabel: 'Group name', placeholder: 'Reactions', maxLength: 40, required: true, autocomplete: 'off' });
    const node = openDialog(main, {
      title: 'New group',
      body: [el('p', {}, 'Groups sort the sounds into sections on Play and on Discord’s panel.'), name],
      actions: [el('button', { type: 'submit', className: 'primary' }, 'Make group')],
      close: 'Cancel',
      onsubmit: (e) => {
        e.preventDefault();
        const text = name.value.trim();
        if (!text) return;
        void changeGroups(() => request(api('/sound-groups'), { method: 'POST', json: { name: text } })).then((ok) => {
          if (!ok) return;
          node.close();
          toast(`Made ${text}. Move sounds into it with their handles.`);
        });
      },
    });
    name.focus();
  }

  const deleteGroup = (group, index) =>
    changeGroups(() => request(api(`/sound-groups/${group.id}`), { method: 'DELETE' })).then(
      (ok) =>
        ok &&
        undoToast(`Deleted ${group.name}. Its sounds are in ${EVERYTHING_ELSE}.`, () =>
          changeGroups(() => request(api('/sound-groups'), { method: 'POST', json: { name: group.name, sounds: group.sounds, at: index } })),
        ),
    );

  /** A group's heading in the list: its name to change, moving it up or down, and deleting it */
  function sectionHead(group, index, count) {
    const sounds = el('span', { className: 'meta' }, count === 1 ? '1 sound' : `${count} sounds`);
    if (!group) return el('div', { className: 'list-head', 'data-group': 'rest' }, el('h3', {}, EVERYTHING_ELSE), el('span', { className: 'meta' }, 'Most played first'));
    const title = el('h3', {});
    const showName = () => title.replaceChildren(el('button', { type: 'button', className: 'group-name', title: 'Rename', ariaLabel: `${group.name}, rename`, onclick: rename }, group.name));
    function rename() {
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const to = input.value.trim();
        if (save && to && to !== group.name && (await changeGroups(() => request(api(`/sound-groups/${group.id}`), { method: 'PATCH', json: { name: to } })))) return;
        const typing = document.activeElement === input;
        showName();
        if (typing) title.querySelector('button').focus();
      };
      const input = el('input', {
        value: group.name,
        maxLength: 40,
        ariaLabel: `New name for ${group.name}`,
        onkeydown: (e) => {
          if (e.key === 'Enter') void finish(true);
          if (e.key === 'Escape') void finish(false);
        },
        onblur: () => void finish(true),
      });
      title.replaceChildren(input);
      input.select();
    }
    showName();
    const moveTo = (to) => void changeGroups(() => request(api(`/sound-groups/${group.id}`), { method: 'PATCH', json: { to } }));
    const last = groups().length - 1;
    return el(
      'div',
      { className: 'list-head', 'data-group': keyOf(group) },
      title,
      sounds,
      el(
        'span',
        { className: 'list-head-actions' },
        el('button', { type: 'button', className: 'quiet icon', ariaLabel: `Move ${group.name} up`, title: 'Move the group up', disabled: index === 0, onclick: () => moveTo(index - 1) }, icon('up')),
        el('button', { type: 'button', className: 'quiet icon', ariaLabel: `Move ${group.name} down`, title: 'Move the group down', disabled: index === last, onclick: () => moveTo(index + 1) }, icon('down')),
        confirmButton({ type: 'button', className: 'quiet icon', title: `Delete the group. Its sounds go to ${EVERYTHING_ELSE}`, ariaLabel: `Delete ${group.name}` }, icon('trash'), 'Delete?', () => deleteGroup(group, index)),
      ),
    );
  }

  const emptyRow = (group) =>
    el('p', { className: 'list-empty', 'data-group': keyOf(group) }, group ? 'Empty. Move sounds here with their handles.' : 'Every sound is in a group.');

  /** Picks a group for a sound from a list, for a tap or a click on its handle */
  function moveSheet(sound, group) {
    const item = (to, label) => {
      const here = (to?.id ?? null) === (group?.id ?? null);
      return el(
        'button',
        {
          type: 'button',
          className: 'sheet-item with-icon',
          disabled: here,
          ariaCurrent: here ? 'true' : undefined,
          onclick: () => {
            node.close();
            void place(sound.name, to).then((ok) => ok && toast(`Moved ${sound.name} to ${label}.`));
          },
        },
        el('span', { className: 'sheet-mark' }, here ? icon('check') : null),
        el('span', {}, label),
      );
    };
    const node = openDialog(main, {
      title: `Move ${sound.name}`,
      className: 'sheet',
      body: [el('div', { className: 'sheet-list' }, ...groups().map((g) => item(g, g.name)), item(null, EVERYTHING_ELSE))],
      close: 'Cancel',
    });
  }

  // ---------- moving a sound by its handle ----------
  // Dragged with a mouse or a finger, or picked up with Space and moved with the arrow keys. The row dims and a line
  // shows where it lands; nothing changes until it's put down
  /** The sound being moved, where it came from, and where it would land: null for where it already is */
  let moving = null;
  let marked = [];
  let ghost = null;
  let scrollFrame = 0;
  let lastPoint = null;
  /** A drag ends in a click on the handle, which isn't a tap */
  let afterDrag = false;

  const rowOf = (name) => [...list.querySelectorAll('.sound')].find((row) => row.dataset.sound === name);

  function lift(sound, group, row) {
    moving = { name: sound.name, from: keyOf(group), row, target: null };
    row.classList.add('lifted');
    list.classList.add('moving');
  }

  /** Whether landing there leaves the sound where it is */
  function samePlace(spot) {
    const key = keyOf(spot.group);
    if (key !== moving.from) return false;
    if (!spot.group) return true;
    const names = placed.get(key);
    return spot.before === moving.name || spot.before === (names[names.indexOf(moving.name) + 1] ?? null);
  }

  /** Every place the sound could go, top to bottom, for the arrow keys */
  function spots() {
    const all = [];
    for (const group of groups()) {
      for (const name of placed.get(keyOf(group)).filter((n) => n !== moving.name)) all.push({ group, before: name });
      all.push({ group, before: null });
    }
    all.push({ group: null, before: null });
    return all;
  }

  const describe = (spot) => (samePlace(spot) ? 'Where it was' : !spot.group ? EVERYTHING_ELSE : spot.before ? `${spot.group.name}, before ${spot.before}` : `End of ${spot.group.name}`);

  /** Marks where the sound would land */
  function aim(spot) {
    for (const [node, name] of marked) node.classList.remove(name);
    marked = [];
    moving.target = spot && !samePlace(spot) ? spot : null;
    const to = moving.target;
    if (!to) return;
    const mark = (node, name) => node && (node.classList.add(name), marked.push([node, name]));
    const key = keyOf(to.group);
    if (!to.group) return mark(list.querySelector('.list-head[data-group="rest"]') ?? list.querySelector('.list-empty[data-group="rest"]'), 'drop-into');
    if (to.before) return mark(rowOf(to.before), 'drop-before');
    const last = placed.get(key).filter((n) => n !== moving.name).at(-1);
    if (last) mark(rowOf(last), 'drop-after');
    else mark(list.querySelector(`.list-empty[data-group="${key}"]`), 'drop-into');
  }

  /** Where a dragged sound would land, from what's under the pointer */
  function aimAt(x, y) {
    const at = document.elementFromPoint(x, y)?.closest('.sound, .list-head, .list-empty');
    if (!at || !list.contains(at)) return;
    const key = at.dataset.group;
    const group = key === 'rest' ? null : groups().find((g) => keyOf(g) === key);
    if (group === undefined) return;
    if (!group) return aim({ group: null, before: null });
    const names = placed.get(key).filter((n) => n !== moving.name);
    // A group's heading is its top
    if (at.classList.contains('list-head')) return aim({ group, before: names[0] ?? null });
    if (!at.classList.contains('sound')) return aim({ group, before: null });
    const name = at.dataset.sound;
    if (name === moving.name) return aim(null);
    const box = at.getBoundingClientRect();
    aim({ group, before: y < box.top + box.height / 2 ? name : (names[names.indexOf(name) + 1] ?? null) });
  }

  /** Puts the sound down where it's aimed, or back where it was */
  function settle(save) {
    if (!moving) return;
    const { name, target, row, done } = moving;
    done?.();
    aim(null);
    moving = null;
    row.classList.remove('lifted');
    list.classList.remove('moving');
    ghost?.remove();
    ghost = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    if (!save || !target) return announce(`${name} stays where it was.`);
    void place(name, target.group, target.before).then((ok) => ok && announce(`Moved ${name} to ${target.group?.name ?? EVERYTHING_ELSE}.`));
  }

  /** Scrolls the page while a dragged sound is held near the top or bottom of what's in view */
  function edgeScroll() {
    scrollFrame = 0;
    if (!moving || !lastPoint) return;
    const [x, y] = lastPoint;
    const top = (document.querySelector('header')?.getBoundingClientRect().bottom ?? 0) + 60;
    // Above a phone's tabs and the music player, whichever of them is showing
    const floor = [...document.querySelectorAll('.bottom-nav, .mini-player')].map((n) => n.getBoundingClientRect()).filter((b) => b.height).reduce((top, b) => Math.min(top, b.top), innerHeight);
    const bottom = floor - 60;
    const step = y < top ? -Math.min(24, Math.ceil((top - y) / 4)) : y > bottom ? Math.min(24, Math.ceil((y - bottom) / 4)) : 0;
    if (!step) return;
    scrollBy(0, step);
    aimAt(x, y);
    scrollFrame = requestAnimationFrame(edgeScroll);
  }

  function dragFrom(e, sound, group, row, grip) {
    if (filter || e.button !== 0 || moving) return;
    const [startX, startY] = [e.clientX, e.clientY];
    let started = false;
    grip.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      if (!started) {
        // A tap that wobbles is still a tap
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        started = true;
        lift(sound, group, row);
        ghost = el('div', { className: 'drag-ghost', ariaHidden: 'true' }, sound.emoji ? emojiNode(sound.emoji, '') : icon('speaker'), el('span', {}, sound.name));
        document.body.append(ghost);
      }
      // The list was redrawn under it, which put the sound back
      if (moving?.name !== sound.name) return;
      lastPoint = [ev.clientX, ev.clientY];
      ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY - 18}px)`;
      aimAt(ev.clientX, ev.clientY);
      if (!scrollFrame) scrollFrame = requestAnimationFrame(edgeScroll);
    };
    const finish = (ev) => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', finish);
      grip.removeEventListener('pointercancel', finish);
      if (!started) return;
      afterDrag = true;
      setTimeout(() => (afterDrag = false));
      settle(ev.type === 'pointerup');
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  }

  function keyMove(e, sound, group, row, grip) {
    // While searching, Enter and Space open the list of groups instead, as a click does
    if (filter) return;
    const held = moving?.name === sound.name;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (held) return settle(true);
      if (moving) return;
      lift(sound, group, row);
      moving.spots = spots();
      moving.at = moving.spots.findIndex(samePlace);
      // Tabbing or clicking away leaves it where it was
      const away = () => settle(false);
      grip.addEventListener('blur', away);
      moving.done = () => grip.removeEventListener('blur', away);
      return announce(`Picked up ${sound.name}. The up and down arrows move it, Space puts it down, Escape leaves it.`);
    }
    if (!held) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      moving.at = Math.max(0, Math.min(moving.spots.length - 1, moving.at + (e.key === 'ArrowUp' ? -1 : 1)));
      const spot = moving.spots[moving.at];
      aim(spot);
      marked[0]?.[0].scrollIntoView({ block: 'nearest' });
      announce(describe(spot));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      settle(false);
    }
  }

  /** The handle at the start of a row: drag it, pick it up with the keyboard, or tap it for a list of groups */
  const handle = (sound, group, row) => {
    const grip = el(
      'button',
      {
        type: 'button',
        className: 'quiet icon grip',
        ariaLabel: `Move ${sound.name}`,
        title: 'Drag to move it, or click for a list of groups',
        onpointerdown: (e) => dragFrom(e, sound, group, row, grip),
        onkeydown: (e) => keyMove(e, sound, group, row, grip),
        // Space clicks as it comes up, after keyMove has already used the press
        onkeyup: (e) => e.key === ' ' && !filter && e.preventDefault(),
        // A tap, a click or a screen reader's press, but not the click that ends a drag
        onclick: () => afterDrag || moveSheet(sound, group),
      },
      icon('grip'),
    );
    return grip;
  };


  // Only these change when a preview starts or stops, since redrawing the list would lose a rename being typed
  function paintPreview(name, button, key = name) {
    const action = player.name === key ? 'Stop' : 'Preview';
    button.title = action;
    button.ariaLabel = `${action} ${name}`;
    // A list of hundreds repaints on every change, so only the buttons whose state changed
    if (button.dataset.action === action) return;
    button.dataset.action = action;
    button.replaceChildren(icon(action === 'Stop' ? 'stop' : 'headphones'));
  }

  function paintPlay(name, button) {
    const channel = voice.channel();
    button.disabled = !channel;
    button.title = channel ? `Play in ${channel.name}` : 'Nobody’s in voice';
    button.ariaLabel = `Play ${name} in voice`;
  }

  function soundRow(sound, group = null, grouping = false) {
    const nameBox = el('div', { className: 'name' });
    const showName = () =>
      nameBox.replaceChildren(
        // Says what pressing it does, after the name people see
        el('button', { title: 'Rename', ariaLabel: `${sound.name}, rename`, onclick: rename }, sound.name),
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
          // Busy rather than disabled, so focus stays on it while the list is redrawn
          if (toggle.ariaBusy === 'true') return;
          toggle.ariaBusy = 'true';
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
    async function deleteSound() {
      const { discordProblem, binId } = await request(soundPath(sound.name), { method: 'DELETE' });
      if (player.name === sound.name) player.stop();
      if (discordProblem) toast(`Deleted ${sound.name}, but it’s still on Discord: ${discordProblem}`, true);
      else {
        undoToast(`Deleted ${sound.name}.`, async () => {
          const { name } = await request(api(`/deleted-sounds/${binId}/restore`), { method: 'POST' });
          toast(sound.onDiscord ? `Restored ${name}. Turn on its Discord switch to put it back on Discord.` : `Restored ${name}.`);
          await load();
        });
      }
      await load();
    }
    const remove = confirmButton({ className: 'quiet icon sound-extra', title: 'Delete', ariaLabel: `Delete ${sound.name}` }, icon('x'), 'Delete?', deleteSound);

    // On a phone, the rarer actions are in a list with their names, rather than a row of icons nobody can hover over
    function moreSheet() {
      const item = (iconName, label, run) =>
        el('button', { type: 'button', className: 'sheet-item with-icon', onclick: () => (node.close(), run()) }, icon(iconName), el('span', {}, label));
      const node = openDialog(main, {
        title: sound.name,
        className: 'sheet',
        body: [
          el(
            'div',
            { className: 'sheet-list' },
            item('volume', `Volume (${sound.percent}%)`, () => pickVolume(sound)),
            item('scissors', sound.trimmed ? 'Trim or restore' : 'Trim', () => attempt(() => trim(sound))),
            item('pencil', 'Rename', rename),
            grouping && item('grip', 'Move to group', () => moveSheet(sound, group)),
          ),
          el(
            'div',
            { className: 'sheet-list' },
            confirmButton({ type: 'button', className: 'sheet-item with-icon' }, [icon('trash'), el('span', {}, 'Delete')], 'Tap again to delete', async () => {
              node.close();
              await deleteSound();
            }),
          ),
        ],
      });
    }

    const preview = el('button', { className: 'quiet icon', onclick: () => player.toggle(soundPath(sound.name, '/audio'), sound.name, sound.loudness) });
    previews.set(sound.name, preview);
    paintPreview(sound.name, preview);
    // Not disabled while a request is out, so spamming a sound works as it does on a panel
    const play = el('button', { className: 'icon', onclick: () => attempt(() => voice.play(sound.name)) }, icon('play'));
    players.set(sound.name, play);
    paintPlay(sound.name, play);

    const row = el('div', { className: grouping ? 'sound with-grip' : 'sound', 'data-sound': sound.name, 'data-group': keyOf(group) });
    row.append(
      ...[
        grouping && handle(sound, group, row),
        play,
        preview,
        el(
          'button',
          { className: 'quiet icon emoji', title: 'Set emoji', ariaLabel: `Emoji for ${sound.name}`, onclick: () => pickEmoji(sound) },
          sound.emoji ? emojiNode(sound.emoji, 'emoji') : el('span', { className: 'none' }, icon('plus')),
        ),
        nameBox,
        el('button', { className: 'quiet icon sound-extra', title: 'Volume', ariaLabel: `Volume for ${sound.name}`, onclick: () => pickVolume(sound) }, icon('volume')),
        el('button', { className: 'quiet icon sound-extra', title: 'Trim', ariaLabel: `Trim ${sound.name}`, onclick: () => attempt(() => trim(sound)) }, icon('scissors')),
        el('label', { className: 'toggle' }, toggle, el('span', {}, 'On Discord')),
        remove,
        el('button', { type: 'button', className: 'quiet icon sound-more', ariaLabel: `More for ${sound.name}`, ariaHasPopup: 'dialog', onclick: moreSheet }, icon('more')),
      ].filter(Boolean),
    );
    return row;
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
    const loudness = () => (sound.loudness * control.value()) / sound.percent;
    const note = el('p', {}, levelNote(sound));
    const control = volumeControl({
      min: 25,
      max: 200,
      label: `Volume for ${sound.name}`,
      onInput: () => player.setLoudness(sound.name, loudness()),
      onSave: save,
    });
    const show = (percent) => {
      control.set(percent);
      player.setLoudness(sound.name, loudness());
    };
    show(sound.percent);
    openDialog(main, {
      title: `Volume for ${sound.name}`,
      body: [note, el('div', { className: 'volume' }, control.node)],
      start: [
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
      ],
      close: 'Done',
      closePrimary: true,
    });
  }

  function pickEmoji(sound) {
    const set = (emoji) =>
      attempt(async () => {
        await request(soundPath(sound.name), { method: 'PATCH', json: { emoji } });
        node.close();
        await load();
      });
    const picker = emojiPicker(data.emojis, set);
    const node = openDialog(main, {
      title: `Emoji for ${sound.name}`,
      body: picker.nodes,
      start: [sound.emoji && el('button', { type: 'button', onclick: () => set(null) }, 'Clear')],
      close: 'Cancel',
      onsubmit: (e) => {
        e.preventDefault();
        const emoji = picker.chosen();
        if (emoji) void set(emoji);
      },
    });
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

  const isSound = (name) => Boolean(data?.sounds.some((s) => s.name === name));
  /** A file whose name is taken waits until someone says whether it replaces that sound or goes in beside it */
  const undecided = (item) => !problemWith(item) && !item.choice && isSound(item.name);

  /** What a row says under its name: why it can't go, the choice its name needs, or what it will do */
  function queueNote(item, problem) {
    if (item.status?.bad) return el('span', { className: 'note bad-text', role: 'alert' }, item.status.text);
    if (problem) return el('span', { className: 'note bad-text' }, problem);
    const choose = (text, ...buttons) => el('span', { className: 'note choice' }, el('span', {}, text), ...buttons);
    const button = (label, choice, className = '') =>
      el('button', { type: 'button', className, disabled: item.busy, onclick: () => {
        item.choice = choice;
        renderQueue();
      } }, label);
    if (!isSound(item.name)) return null;
    if (item.choice === 'replace') return choose(`Replaces ${item.name}. The old one goes to Recently deleted.`, button('Keep both instead', 'keep'));
    if (item.choice === 'keep') return choose(`Keeps both. The new one gets a number on the end of its name.`, button('Replace instead', 'replace'));
    return choose(`There’s already a sound called ${item.name}.`, button('Replace it', 'replace', 'danger'), button('Keep both', 'keep'));
  }

  function renderQueue() {
    queueBox.hidden = !queue.length;
    if (!queue.length) return queueBox.replaceChildren();
    const rows = queue.map((item) => {
      const problem = problemWith(item);
      const note = queueNote(item, problem);
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
            item.choice = null;
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
          icon('x'),
        ),
        note,
      );
    });
    const ready = queue.filter((item) => !problemWith(item) && !item.busy);
    const waiting = ready.filter(undecided).length;
    const uploading = queue.filter((item) => item.busy).length;
    keepFocus(queueBox, () => queueBox.replaceChildren(
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
        waiting > 0 && el('span', { className: 'hint' }, waiting === 1 ? 'Choose what to do about the name that’s taken.' : `Choose what to do about the ${waiting} names that are taken.`),
        el(
          'button',
          { className: 'primary', disabled: !ready.length || waiting > 0, onclick: uploadAll },
          uploading ? `Uploading, ${uploading} to go…` : ready.length > 1 ? `Upload ${ready.length} sounds` : 'Upload',
        ),
      ),
    ));
  }

  /** One message for the whole batch, however many sounds it was */
  function reportUploads({ added, replaced, renamed, notes }) {
    const count = (n, word) => (n ? `${word} ${n} sound${n === 1 ? '' : 's'}` : null);
    const done = [count(added, 'Added'), count(replaced, 'replaced')].filter(Boolean).join(', ');
    const shown = notes.slice(0, MAX_NOTES).map((note) => `Bot soundboard only: ${note}`);
    if (notes.length > MAX_NOTES) shown.push(`And ${notes.length - MAX_NOTES} more are bot-only.`);
    const binned = replaced ? [`The old ${replaced === 1 ? 'one is' : 'ones are'} in Recently deleted.`] : [];
    const named = renamed.length ? [`Added as ${renamed.join(', ')}.`] : [];
    if (done || shown.length) toast([`${done}.`, ...named, ...binned, ...shown].join('\n'));
  }

  async function uploadAll() {
    const items = queue.filter((item) => !problemWith(item) && !undecided(item));
    for (const item of items) item.busy = true;
    const uploaded = { added: 0, replaced: 0, renamed: [], notes: [] };
    renderQueue();
    for (const item of items) {
      try {
        const query = `?file=${encodeURIComponent(item.file.name)}${toDiscord ? '' : '&discord=0'}${item.choice ? `&${item.choice}=1` : ''}`;
        const { name, replaced, discordProblem } = await request(soundPath(item.name) + query, { method: 'PUT', body: item.file });
        queue = queue.filter((other) => other !== item);
        uploaded[replaced ? 'replaced' : 'added'] += 1;
        if (name !== item.name) uploaded.renamed.push(name);
        if (discordProblem) uploaded.notes.push(`${item.name}, ${discordProblem}.`);
      } catch (err) {
        item.busy = false;
        item.status = { bad: true, text: err.message };
        // Someone else added a sound by that name meanwhile, so it needs the same question
        if (err instanceof RequestError && err.status === 409 && data) {
          data.sounds.push({ name: item.name });
          item.status = null;
          item.choice = null;
        }
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
      list.replaceChildren(notice('error', err.message));
      throw err;
    }
  });
}

