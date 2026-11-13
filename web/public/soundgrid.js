import { api, attempt, el, emojiNode, forget, icon, keepFocus, notice, recall, remember, request, soundPath, state, toast } from './lib.js';
import { elapsed, onPlaying } from './playing.js';
import { followWhenIdle, older } from './updates.js';

export const byUse = (a, b) => b.plays - a.plays || a.name.localeCompare(b.name);
// What the sounds in no group are called, and the group the star puts sounds in
export const EVERYTHING_ELSE = 'Everything else';
const FAVOURITES = 'favourites';
// Which groups are folded away, on this device, for each server: `g<id>`, or `rest` for Everything else
const foldedKey = (guildId) => `foldedGroups:${guildId}`;

/**
 * A section's heading, which folds `body` away and back where it is. `count` shows while it's folded, so nothing looks
 * missing. onFold(open) hears each change
 */
export function foldHead(name, open, body, onFold, count = null) {
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

/**
 * The server's sounds as buttons that play them in the channel picked: its groups in their order, then whatever gets
 * played most, each group folding away as it does wherever they're shown on this device. They keep up with changes
 * made anywhere, light up while they play, and are grey while nobody's in voice. `voice` is a voiceBar, `empty()` what
 * to show when there are no sounds, and `stars` puts a star on each to add it to Favourites
 */
export function soundGrid({ voice, empty, stars = false }) {
  const guildId = state.guildId;
  let sounds = null;
  let groups = [];
  let filter = '';
  const tiles = [];
  /** Each tile shown, by sound name, to mark the ones playing */
  const shownTiles = new Map();
  let nowPlaying = [];
  const node = el('div', { className: 'board' }, notice('loading', 'Loading sounds…'));

  /** Greys the tiles while nobody's in voice, and says where each plays */
  function paint() {
    const channel = voice.channel();
    for (const tile of tiles) {
      tile.disabled = !channel;
      tile.title = channel ? `Play in ${channel.name}` : 'Nobody’s in voice';
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
    if (!fresh?.groups || guildId !== state.guildId || !node.isConnected) return false;
    useGroups(fresh.groups);
    render();
    return true;
  }

  function starOf(sound, group) {
    // A sound is in one group at most, so starring one in another group moves it out of there
    const other = sound.favourite ? null : group;
    return el(
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
  }

  function tile(sound, group = null) {
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
    return el('div', { className: 'tile-box' }, button, progress, stars && starOf(sound, group));
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
  onPlaying(node, (playing) => {
    nowPlaying = playing;
    markPlaying();
  });

  // Groups folded away on this device. A search shows them all, and they fold again after
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
    if (!sounds.length) return node.replaceChildren(notice('empty', ...empty()));
    const shown = sounds.filter((s) => s.name.includes(filter));
    if (!shown.length) return node.replaceChildren(notice('empty', `Nothing matches “${filter}”.`));
    const byName = new Map(shown.map((s) => [s.name, s]));
    const grouped = new Set(groups.flatMap((g) => g.sounds));
    const sections = groups.map((group) => ({ group, list: group.sounds.map((n) => byName.get(n)).filter(Boolean) })).filter((x) => x.list.length);
    // In the order they were loaded in, most played first then, and new ones after
    const rest = shown.filter((s) => !grouped.has(s.name));
    const grid = (list, group) => el('div', { className: 'tiles' }, list.map((s) => tile(s, group)));
    keepFocus(node, () =>
      node.replaceChildren(
        ...sections.flatMap(({ group, list }) => {
          const box = grid(list, group);
          return [headOf(group, list, box), box];
        }),
        ...(rest.length
          ? (() => {
              const box = grid(rest, null);
              // Without groups, there's no heading to fold it with
              return [...(sections.length ? [headOf(null, rest, box)] : []), box];
            })()
          : []),
      ),
    );
    markPlaying();
    paint();
  }

  // What's shown comes from the first load and from changes made anywhere: other tabs, Discord and the bot itself.
  // Whichever arrives first is used, and nothing older than what's shown
  let version = '';
  function useData(fresh) {
    if (guildId !== state.guildId || !node.isConnected || older(fresh.version, version)) return false;
    version = fresh.version;
    if (sounds) useSounds(fresh.sounds);
    else sounds = fresh.sounds.sort(byUse);
    useGroups(fresh.groups ?? []);
    return true;
  }
  // A change waits while a tile is held down, so nothing moves under the finger
  followWhenIdle('sounds', node, () => [node], (fresh) => useData(fresh) && render());

  void attempt(async () => {
    try {
      const fresh = await request(api('/sounds'));
      if (guildId !== state.guildId || !node.isConnected) return;
      useData(fresh);
      render();
    } catch (err) {
      node.replaceChildren(notice('error', err.message));
      throw err;
    }
  });

  return {
    node,
    paint,
    /** Shows only the sounds whose names hold `text` */
    search(text) {
      filter = text.trim().toLowerCase();
      if (sounds) render();
    },
    /** Plays the first sound shown, if it can */
    playFirst: () => tiles.find((tile) => !tile.disabled)?.click(),
  };
}
