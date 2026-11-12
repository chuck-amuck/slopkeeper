import { api, attempt, el, icon, pickedVoice, poll, request, soundPath, state, toast, volumeControl } from './lib.js';

const REFRESH_MS = 5000;
let panels = 0;

/**
 * The "Play in" picker, with a Volume button beside it that opens the server's volumes for sounds and speech. They're
 * folded away as they change it for everyone, and are rarely touched mid-call. Stop is in the corner of every page.
 * onChange runs whenever the chosen channel changes
 */
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
    label: 'Sound volume',
    // It's the server's setting, not this page's, so saying so is worth a toast
    onSave: (value) =>
      void attempt(async () => {
        await request(api('/settings/soundVolume'), { method: 'PUT', json: { value } });
        toast(`Sounds play at ${value}% for everyone now.`);
      }),
  });
  let volumeLoaded = false;

  const panel = el(
    'div',
    { className: 'volume-panel', id: `volume-panel-${++panels}`, hidden: true },
    el('p', { className: 'hint' }, 'These change how loud the bot is for everyone in the server, not just for you.'),
  );
  const addVolume = (label, control) => {
    const row = el('div', { className: 'voice-volume' }, el('span', { className: 'voice-label' }, label), control);
    panel.append(row);
    return row;
  };
  // Shown once it's loaded, so it can't be dragged from a made-up value
  const soundsRow = addVolume('Sounds', volume.node);
  soundsRow.hidden = true;
  const volumeButton = el(
    'button',
    {
      type: 'button',
      className: 'with-icon volume-toggle',
      ariaExpanded: 'false',
      'aria-controls': panel.id,
      title: 'How loud sounds and speech play, for everyone',
      onclick: () => {
        panel.hidden = !panel.hidden;
        volumeButton.ariaExpanded = String(!panel.hidden);
      },
    },
    icon('volume'),
    el('span', { className: 'volume-word' }, 'Volume'),
    icon('chevron'),
  );

  async function load() {
    const data = await request(api('/voice'));
    const fresh = data.channels;
    if (guildId !== state.guildId || !main.isConnected) return;
    // Only the first time, so it never jumps while being dragged
    if (!volumeLoaded) {
      volume.set(data.soundVolume);
      volumeLoaded = true;
      soundsRow.hidden = false;
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
    node: el('div', { className: 'voice-box' }, el('div', { className: 'toolbar voice' }, el('span', { className: 'voice-label' }, 'Play in'), picker, volumeButton), panel),
    addVolume,
    /** Null until the channels have loaded, then the one picked, or undefined when nobody's in voice */
    channel: () => (channels === null ? null : channels.find((c) => c.id === chosen)),
    loaded: () => channels !== null,
    play: (name) => request(soundPath(name, '/play'), { method: 'POST', json: { channelId: chosen } }),
    say: (text, voice) => request(api('/say'), { method: 'POST', json: { channelId: chosen, text, voice } }),
    playDiscord: (id) => request(api(`/discord-sounds/${id}/play`), { method: 'POST', json: { channelId: chosen } }),
  };
}
