import { api, el, icon, pickedVoice, request, soundPath, state } from './lib.js';
import { follow } from './updates.js';
import { volumeSliders } from './volumes.js';

/**
 * The voice channel that sounds, speech and music play in. It's picked once, with Play in in the header of every page,
 * and every page that plays something follows that one choice
 */

/** Who's in which voice channel on the server shown, as the bot last said: { guildId, channels }, or null */
let heard = null;
/** What's told when the channels or the choice change: { node, fn, since, seen }, let go once node leaves the page */
const watchers = new Set();
/** Servers where someone has picked the channel by hand since the page loaded, which a page's own guess doesn't undo */
const byHand = new Set();
// A watcher whose node never made it onto the page is let go after this long, as updates.js does
const UNSEEN_MS = 5000;

const channelsNow = () => (heard?.guildId === state.guildId ? heard.channels : null);

/** The channel picked, while there's someone in it */
function chosenNow() {
  const id = pickedVoice.get();
  return channelsNow()?.some((c) => c.id === id) ? id : null;
}

function tell() {
  const now = performance.now();
  for (const watcher of watchers) {
    watcher.seen ||= watcher.node.isConnected;
    if (watcher.node.isConnected) watcher.fn();
    else if (watcher.seen || now - watcher.since > UNSEEN_MS) watchers.delete(watcher);
  }
}

/** Runs `fn` whenever the channels or the choice change, until `node` leaves the page; at once if they're known */
function watch(node, fn) {
  watchers.add({ node, fn, since: performance.now(), seen: node.isConnected });
  if (channelsNow()) queueMicrotask(() => node.isConnected && fn());
}

/**
 * Who's in voice, from the bot. When the channel picked empties, the first one with people in it takes over and stays
 * picked, so the choice doesn't jump back if someone wanders into the old one
 */
function hear(data) {
  const guildId = state.guildId;
  if (heard?.guildId === guildId && JSON.stringify(heard.channels) === JSON.stringify(data.channels)) return;
  heard = { guildId, channels: data.channels };
  if (!chosenNow() && data.channels.length) pickedVoice.set(data.channels[0].id);
  tell();
}

/** Makes `id` the channel, if there's someone in it */
function choose(id, hand) {
  if (!channelsNow()?.some((c) => c.id === id)) return;
  if (hand) byHand.add(state.guildId);
  if (id === pickedVoice.get()) return;
  pickedVoice.set(id);
  tell();
}

/** Play in, for the header: the channel everything plays in, with who's in each */
export function playInPicker() {
  // What the options were drawn from, as rebuilding them would close the list if it's open
  let drawn = '';
  const select = el('select', {
    ariaLabel: 'Play in',
    title: 'The voice channel sounds, speech and music play in',
    disabled: true,
    onchange: (e) => choose(e.target.value, true),
  });
  select.append(el('option', {}, 'Loading voice channels…'));
  const node = el('div', { className: 'play-in' }, icon('speaker'), select);
  const paint = () => {
    const channels = channelsNow();
    const chosen = chosenNow();
    const now = JSON.stringify([channels, chosen]);
    if (!channels || now === drawn) return;
    drawn = now;
    select.disabled = !channels.length;
    select.replaceChildren(
      ...(channels.length
        ? channels.map((c) => el('option', { value: c.id, selected: c.id === chosen }, `${c.name} · ${c.people.join(', ')}`))
        : [el('option', {}, 'Nobody’s in voice')]),
    );
  };
  follow('voice', node, hear);
  watch(node, paint);
  return node;
}

/**
 * For a page that plays in voice: the channel picked in the header, kept up as it or who's in voice changes, which
 * runs onChange. `node` holds the server's volumes for sounds and speech, unless `sliders` is false (then it's an
 * empty, hidden box that only marks the page as still shown). Every volume is also behind the Volume button
 */
export function voiceBar(onChange, { sliders = true } = {}) {
  // Each slider shown once the bot says what it's at, so neither can be dragged from a made-up value
  const node = sliders ? el('div', { className: 'voice-box' }, volumeSliders(['sounds', 'speech'])) : el('div', { className: 'voice-box', hidden: true });
  follow('voice', node, hear);
  watch(node, onChange);
  const chosen = () => chosenNow();

  return {
    node,
    /** Null until the channels have loaded, then the one picked, or undefined when nobody's in voice */
    channel: () => {
      const channels = channelsNow();
      return channels === null ? null : channels.find((c) => c.id === chosen());
    },
    loaded: () => channelsNow() !== null,
    /** Makes `id` the channel, here and in the header, unless someone's picked one by hand on this server since load */
    prefer: (id) => byHand.has(state.guildId) || choose(id, false),
    play: (name) => request(soundPath(name, '/play'), { method: 'POST', json: { channelId: chosen() } }),
    say: (text, voice) => request(api('/say'), { method: 'POST', json: { channelId: chosen(), text, voice } }),
    playDiscord: (id) => request(api(`/discord-sounds/${id}/play`), { method: 'POST', json: { channelId: chosen() } }),
  };
}
