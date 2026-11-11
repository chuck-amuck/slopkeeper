import { api, attempt, el, pickedVoice, poll, request, soundPath, state, toast, volumeControl } from './lib.js';

const REFRESH_MS = 5000;

/** The "Play in" picker and soundboard volume. Stop is in the corner of every page. onChange runs whenever the chosen channel changes */
export function voiceBar(main, onChange) {
  const guildId = state.guildId;
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

  const volume = volumeControl({
    min: 0,
    max: 200,
    label: 'Soundboard volume',
    // It's the server's setting, not this page's, so saying so is worth a toast
    onSave: (value) =>
      void attempt(async () => {
        await request(api('/settings/soundVolume'), { method: 'PUT', json: { value } });
        toast(`Sounds play at ${value}% for everyone now.`);
      }),
  });
  const volumeLabel = el(
    'span',
    { className: 'voice-volume', hidden: true, title: 'How loud sounds play for everyone in the server. It’s the Soundboard volume in Settings.' },
    el('span', { className: 'voice-label' }, 'Volume'),
    volume.node,
  );

  async function load() {
    const data = await request(api('/voice'));
    const fresh = data.channels;
    if (guildId !== state.guildId || !main.isConnected) return;
    // Only the first time, so it never jumps while being dragged
    if (volumeLabel.hidden) {
      volume.set(data.soundVolume);
      volumeLabel.hidden = false;
    }
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

  void attempt(load);
  // People come and go while the page is open
  poll(main, REFRESH_MS, load);

  return {
    node: el(
      'div',
      { className: 'toolbar voice' },
      el('span', { className: 'voice-label' }, 'Play in'),
      picker,
      volumeLabel,
    ),
    channel: () => channels?.find((c) => c.id === chosen),
    play: (name) => request(soundPath(name, '/play'), { method: 'POST', json: { channelId: chosen } }),
    say: (text, voice) => request(api('/say'), { method: 'POST', json: { channelId: chosen, text, voice } }),
    playDiscord: (id) => request(api(`/discord-sounds/${id}/play`), { method: 'POST', json: { channelId: chosen } }),
  };
}
