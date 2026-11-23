import { api, attempt, el, forget, needsVoice, recall, remember, request, state } from './lib.js';
import { foldHead, soundGrid } from './soundgrid.js';
import { previewButton, sayField, speechPickers } from './speech.js';
import { keepLineButton } from './speechsound.js';
import { voiceBar } from './voice.js';
import { volumeSliders } from './volumes.js';

// Whether the volumes are open, on this device
const VOLUMES_KEY = 'soundsVolumesOpen';

/**
 * What the Sounds panel and the pop-out window hold: a line to say, with its voice and a preview only you hear (the
 * voice is this device's choice, as on the Soundboard, or else the server's), a search where Enter plays the first
 * match, and the server's sounds in their
 * groups, folded as on the Soundboard, to play in the channel picked in Play in. `openBoard` goes to the Soundboard,
 * where sounds are added, and `slash` says / goes to the search there. `parts` go in the panel in order, and paint()
 * shows a voice picked on the Soundboard since. `volumes`, if any, fold away above the line to say, closed until opened on
 * this device: the pop-out window's, as the Sounds panel has the Volume button beside it
 */
export function soundsBody(openBoard, { slash = false, volumes = [] } = {}) {
  const guildId = state.guildId;
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
  const text = sayField();
  const pickers = speechPickers(guildId);
  const { voice: picker, effect } = pickers;
  const send = el('button', { className: 'primary say-send' }, 'Say');
  // The last line said, to keep as a sound, while the line box shows
  const keep = keepLineButton(() => !say.hidden);
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
          await voice.say(line, picker.value, effect.value);
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
    picker,
    effect,
    previewButton(picker, text, effect),
  );

  function paint() {
    // Picked on the Soundboard since, or in the pop-out
    pickers.showPicks();
    const channel = voice.channel();
    send.disabled = saying;
    needsVoice(send, channel);
    send.title = channel ? `Say in ${channel.name}` : 'Nobody’s in voice';
    grid.paint();
  }

  void attempt(async () => {
    const offered = await request(api('/say'));
    const { on, longest } = offered;
    if (guildId !== state.guildId || !search.isConnected) return;
    // The voice and effect last picked on this device, while the bot still offers them
    pickers.fill(offered);
    text.maxLength = longest;
    say.hidden = !on;
    keep.paint();
    paint();
  });

  const levels = volumes.length ? el('div', { className: 'sounds-volumes' }, volumeSliders(volumes)) : null;
  const levelsHead = levels && foldHead('Volume', recall(VOLUMES_KEY) === 'open', levels, (open) => (open ? remember(VOLUMES_KEY, 'open') : forget(VOLUMES_KEY)));
  const volume = levels && el('section', { className: 'sounds-volume', title: 'For everyone in the server, not just you' }, levelsHead, levels);

  return { parts: [voice.node, ...(volume ? [volume] : []), say, keep.node, search, el('div', { className: 'sounds-scroll' }, grid.node)], search, paint };
}
