import { api, attempt, el, request, soundPath, state } from './lib.js';

const REFRESH_MS = 5000;

/** The "Play in" picker and Stop button. onChange runs whenever the chosen channel changes */
export function voiceBar(main, onChange) {
  const guildId = state.guildId;
  // Null until it's first loaded, so an empty list still gets drawn
  let channels = null;
  let chosen = null;

  const picker = el('select', {
    ariaLabel: 'Voice channel',
    onchange: (e) => {
      chosen = e.target.value;
      onChange();
    },
  });

  async function load() {
    const fresh = (await request(api('/voice'))).channels;
    if (guildId !== state.guildId || !main.isConnected) return;
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
  const timer = setInterval(() => {
    if (main.isConnected) void load().catch(() => {});
    else clearInterval(timer);
  }, REFRESH_MS);

  return {
    node: el(
      'div',
      { className: 'toolbar voice' },
      el('span', { className: 'voice-label' }, 'Play in'),
      picker,
      el('button', { onclick: () => attempt(() => request(api('/stop'), { method: 'POST' })) }, 'Stop'),
    ),
    channel: () => channels?.find((c) => c.id === chosen),
    play: (name) => request(soundPath(name, '/play'), { method: 'POST', json: { channelId: chosen } }),
    playDiscord: (id) => request(api(`/discord-sounds/${id}/play`), { method: 'POST', json: { channelId: chosen } }),
  };
}
