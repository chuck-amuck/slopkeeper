import { api, el, pickedVoice, request, soundPath } from './lib.js';
import { follow } from './updates.js';
import { volumeSliders } from './volumes.js';

/**
 * The "Play in" picker, with the server's volumes for sounds and speech under it. Every volume is also behind the
 * Volume button in the corner of every page, beside Stop. onChange runs whenever the chosen channel changes
 */
export function voiceBar(onChange) {
  // Null until it's first loaded, so an empty list still gets drawn
  let channels = null;
  let chosen = pickedVoice.get();

  const picker = el('select', {
    ariaLabel: 'Voice channel',
    onchange: (e) => {
      chosen = e.target.value;
      pickedVoice.set(chosen);
      onChange();
    },
  });

  /** Who's in which channel, from the bot as people come and go */
  function show(data) {
    const fresh = data.channels;
    // Rebuilding the picker would close it if it's open
    if (JSON.stringify(fresh) === JSON.stringify(channels)) return;
    channels = fresh;
    if (!channels.some((c) => c.id === chosen)) chosen = channels[0]?.id ?? null;
    picker.disabled = !channels.length;
    picker.replaceChildren(
      ...(channels.length
        ? channels.map((c) => el('option', { value: c.id, selected: c.id === chosen }, `${c.name} · ${c.people.join(', ')}`))
        : [el('option', {}, 'Nobody’s in voice')]),
    );
    onChange();
  }

  // Each shown once the bot says what it's at, so neither can be dragged from a made-up value
  const node = el('div', { className: 'voice-box' }, el('div', { className: 'toolbar voice' }, el('span', { className: 'voice-label' }, 'Play in'), picker), volumeSliders(['sounds', 'speech']));
  follow('voice', node, show);

  return {
    node,
    /** Null until the channels have loaded, then the one picked, or undefined when nobody's in voice */
    channel: () => (channels === null ? null : channels.find((c) => c.id === chosen)),
    loaded: () => channels !== null,
    play: (name) => request(soundPath(name, '/play'), { method: 'POST', json: { channelId: chosen } }),
    say: (text, voice) => request(api('/say'), { method: 'POST', json: { channelId: chosen, text, voice } }),
    playDiscord: (id) => request(api(`/discord-sounds/${id}/play`), { method: 'POST', json: { channelId: chosen } }),
  };
}
