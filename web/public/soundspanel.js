import { api, attempt, el, needsVoice, recall, remember, request, state } from './lib.js';
import { soundGrid } from './soundgrid.js';
import { previewButton, showPicked, voiceOptions } from './speech.js';
import { voiceBar } from './voice.js';

/**
 * What the Sounds panel and the pop-out window hold: a line to say, with its voice and a preview only you hear (the
 * voice is this device's choice, as on the Soundboard, or else the server's), a search where Enter plays the first
 * match, and the server's sounds in their
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
  const { searchBox: search } = grid;

  // One line to say, in the voice picked here, which is the one the Soundboard has on this device too
  let saying = false;
  const text = el('input', { ariaLabel: 'What to say', placeholder: 'Say something', autocomplete: 'off', enterKeyHint: 'send' });
  const picker = el('select', { ariaLabel: 'Voice', className: 'say-voice', onchange: () => remember(voiceKey, picker.value) });
  const send = el('button', { className: 'primary say-send' }, 'Say');
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
          await voice.say(line, picker.value);
          return true;
        });
        if (!sent && !text.value) text.value = line;
        saying = false;
        send.textContent = 'Say';
        paint();
      },
    },
    text,
    picker,
    previewButton(picker, text),
    send,
  );

  function paint() {
    // Picked on the Soundboard since, or in the pop-out
    showPicked(picker, recall(voiceKey));
    const channel = voice.channel();
    send.disabled = saying;
    needsVoice(send, channel);
    send.title = channel ? `Say in ${channel.name}` : 'Nobody’s in voice';
    grid.paint();
  }

  void attempt(async () => {
    const { on, voices, voice: serverVoice, longest } = await request(api('/say'));
    if (guildId !== state.guildId || !search.isConnected) return;
    // The voice last picked on this device, while the bot still offers it
    const mine = recall(voiceKey);
    picker.replaceChildren(...voiceOptions(voices, voices.some((v) => v.id === mine) ? mine : serverVoice));
    text.maxLength = longest;
    say.hidden = !on;
    paint();
  });

  return { parts: [voice.node, say, search, el('div', { className: 'sounds-scroll' }, grid.node)], search, paint };
}
