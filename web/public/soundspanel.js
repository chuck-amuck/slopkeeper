import { api, attempt, el, recall, request, state } from './lib.js';
import { soundGrid } from './soundgrid.js';
import { voiceBar } from './voice.js';

/**
 * What the Sounds panel and the pop-out window hold: a line to say, in the voice last picked on this device's
 * Soundboard or else the server's, a search where Enter plays the first match, and the server's sounds in their
 * groups, folded as on the Soundboard, to play in the channel picked in Play in. `openBoard` goes to the Soundboard,
 * where sounds are added, and `slash` says / goes to the search there. `parts` go in the panel in order, and paint()
 * shows a voice picked on the Soundboard since
 */
export function soundsBody(openBoard, { slash = false } = {}) {
  const guildId = state.guildId;
  const voiceKey = `voice:${guildId}`;
  const voice = voiceBar(paint, { sliders: false });
  const grid = soundGrid({
    voice,
    slash,
    empty: () => ['No sounds yet. ', el('button', { type: 'button', className: 'link', onclick: openBoard }, 'Add some on the Soundboard'), '.'],
  });
  grid.node.classList.add('compact');
  const { searchBox: search, nobody } = grid;

  // One line to say, in the voice last picked on this device's Soundboard, or else the server's
  let voices = [];
  let serverVoice = null;
  let saying = false;
  const text = el('input', { ariaLabel: 'What to say', placeholder: 'Say something', autocomplete: 'off', enterKeyHint: 'send' });
  const send = el('button', { className: 'primary say-send' }, 'Say');
  const chosenVoice = () => {
    const mine = recall(voiceKey);
    return voices.find((v) => v.id === mine) ?? voices.find((v) => v.id === serverVoice) ?? null;
  };
  const say = el(
    'form',
    {
      className: 'sounds-say',
      hidden: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const line = text.value.trim();
        if (send.disabled || !line) return;
        // Cleared straight away, as the bot only answers once the line starts
        saying = true;
        send.textContent = 'Saying…';
        text.value = '';
        paint();
        const sent = await attempt(async () => {
          await voice.say(line, chosenVoice()?.id);
          return true;
        });
        if (!sent && !text.value) text.value = line;
        saying = false;
        send.textContent = 'Say';
        paint();
      },
    },
    text,
    send,
  );

  function paint() {
    const channel = voice.channel();
    send.disabled = !channel || saying;
    const name = chosenVoice()?.name;
    text.placeholder = name ? `Say as ${name}` : 'Say something';
    send.title = channel ? `Say in ${channel.name}${name ? ` as ${name}` : ''}. The voice is the one picked on the Soundboard` : 'Nobody’s in voice';
    grid.paint();
  }

  void attempt(async () => {
    const { on, voices: offered, voice: fallback, longest } = await request(api('/say'));
    if (guildId !== state.guildId || !search.isConnected) return;
    voices = offered;
    serverVoice = fallback;
    text.maxLength = longest;
    say.hidden = !on;
    paint();
  });

  return { parts: [voice.node, say, search, nobody, el('div', { className: 'sounds-scroll' }, grid.node)], search, paint };
}
