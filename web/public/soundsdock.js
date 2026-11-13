import { api, attempt, devicePref, el, icon, notice, recall, request, state } from './lib.js';
import { soundGrid } from './soundgrid.js';
import { voiceBar } from './voice.js';

/** Whether the Sounds panel is open. It stays open from page to page until it's closed */
let open = false;

/** For the Soundboard, which has every sound already, so it has no Sounds button. The panel starts closed after it */
export function noSoundsDock() {
  open = false;
  return null;
}

/**
 * The Sounds button in the corner of every page but the Soundboard, and the panel it opens above itself: a line to
 * say, a search, and the server's sounds in their groups, folded as on the Soundboard, to play in the channel picked
 * in the header. On a wide screen the panel stays open while you use the page, until the button, ✕ or Escape closes
 * it; on a phone a press anywhere else closes it too. `openBoard` goes to the Soundboard
 */
export function soundsDock(openBoard) {
  const panel = el('section', { className: 'sounds-float', id: 'sounds-float', hidden: true, ariaLabel: 'Sounds' });
  const button = el(
    'button',
    {
      type: 'button',
      className: 'volume-fab sounds-fab with-icon',
      ariaLabel: 'Sounds',
      title: 'Play a sound or say something, from any page',
      ariaExpanded: 'false',
      'aria-controls': panel.id,
      onclick: () => toggle(panel.hidden, true),
    },
    icon('pads'),
    el('span', { className: 'volume-fab-word' }, 'Sounds'),
  );
  const dock = { button, panel, close: () => toggle(false), onOpen: () => {} };
  let search = null;
  const narrow = matchMedia('(max-width: 640px)');

  /** What's in the panel, made the first time it opens */
  function build() {
    const guildId = state.guildId;
    const voiceKey = `voice:${guildId}`;
    const voice = voiceBar(paint, { sliders: false });
    const grid = soundGrid({
      voice,
      empty: () => ['No sounds yet. ', el('button', { type: 'button', className: 'link', onclick: goToBoard }, 'Add some on the Soundboard'), '.'],
    });
    grid.node.classList.add('compact');
    search = el('input', {
      type: 'search',
      className: 'board-search',
      placeholder: 'Search sounds',
      ariaLabel: 'Search sounds',
      autocomplete: 'off',
      title: 'Enter plays the first match',
      oninput: () => grid.search(search.value),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (search.value.trim()) grid.playFirst();
        } else if (e.key === 'Escape' && search.value) {
          // Clears the search first, and closes the panel on the next press
          e.preventDefault();
          search.value = '';
          grid.search('');
        }
      },
    });
    const nobody = notice('empty', 'Nobody’s in voice. Join a voice channel in Discord and these light up.', { compact: true });
    nobody.hidden = true;

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
      nobody.hidden = !voice.loaded() || !!channel;
      send.disabled = !channel || saying;
      const name = chosenVoice()?.name;
      text.placeholder = name ? `Say as ${name}` : 'Say something';
      send.title = channel ? `Say in ${channel.name}${name ? ` as ${name}` : ''}. The voice is the one picked on the Soundboard` : 'Nobody’s in voice';
      grid.paint();
    }

    void attempt(async () => {
      const { on, voices: offered, voice: fallback, longest } = await request(api('/say'));
      if (guildId !== state.guildId || !panel.isConnected) return;
      voices = offered;
      serverVoice = fallback;
      text.maxLength = longest;
      say.hidden = !on;
      paint();
    });

    const close = el('button', { type: 'button', className: 'icon quiet', ariaLabel: 'Close Sounds', title: 'Close', onclick: () => toggle(false, true) }, icon('x'));
    panel.append(
      el('div', { className: 'sounds-head' }, el('h2', {}, 'Sounds'), el('button', { type: 'button', className: 'link', onclick: goToBoard }, 'Soundboard'), close),
      voice.node,
      say,
      search,
      nobody,
      el('div', { className: 'sounds-scroll' }, grid.node),
    );
    // Opening it again shows the voice picked on the Soundboard since
    return paint;
  }

  let repaint = null;
  function goToBoard() {
    toggle(false);
    openBoard();
  }

  // While it's open: Escape from anywhere closes it, and on a phone so does a press outside the corner
  let listening = null;
  /** `byHand` is a press of the button or ✕, after which focus goes where it's useful */
  function toggle(on, byHand = false) {
    if (on && !devicePref.on('soundsButton')) on = false;
    const was = !panel.hidden;
    panel.hidden = !on;
    button.ariaExpanded = String(on);
    open = on;
    listening?.abort();
    listening = null;
    if (!on) {
      if (was && byHand) button.focus();
      return;
    }
    dock.onOpen();
    if (!repaint) repaint = build();
    else repaint();
    // With a mouse, straight to the search; on a touch screen the keyboard would cover the panel
    if (byHand && matchMedia('(pointer: fine)').matches) search.focus();
    listening = new AbortController();
    const { signal } = listening;
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!button.isConnected) return listening?.abort();
        const corner = button.closest('.stop-dock') ?? button;
        if (narrow.matches && !corner.contains(e.target)) toggle(false);
      },
      { signal, capture: true },
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (!button.isConnected) return listening?.abort();
        // An open dialog or sheet has it first, and the search clears itself first
        if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
        const within = panel.contains(document.activeElement) || document.activeElement === button;
        toggle(false);
        if (within) button.focus();
      },
      { signal },
    );
  }

  // Settings turns the button on and off for this device
  const paintPref = () => {
    button.hidden = !devicePref.on('soundsButton');
    if (button.hidden && !panel.hidden) toggle(false);
  };
  const onPref = (e) => (button.isConnected ? e.detail === 'soundsButton' && paintPref() : removeEventListener('device-pref', onPref));
  addEventListener('device-pref', onPref);
  paintPref();
  // Open on this page too, if it was on the last
  if (open && !button.hidden) queueMicrotask(() => button.isConnected && toggle(true));
  return dock;
}
