import { devicePref, el, icon, secondWindow } from './lib.js';
import { soundsBody } from './soundspanel.js';

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
export function soundsDock(openBoard, extra = null) {
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
    const body = soundsBody(goToBoard);
    search = body.search;
    const close = el('button', { type: 'button', className: 'icon quiet', ariaLabel: 'Close Sounds', title: 'Close', onclick: () => toggle(false, true) }, icon('x'));
    panel.append(el('div', { className: 'sounds-head' }, el('h2', {}, 'Sounds'), el('button', { type: 'button', className: 'link', onclick: goToBoard }, 'Soundboard'), extra, close), ...body.parts);
    // Opening it again shows the voice picked on the Soundboard since
    return body.paint;
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
    // Turned off in Settings, or the pop-out window has it
    if (on && button.hidden) on = false;
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

  // Settings turns the button on and off for this device, and it makes way for the pop-out window while that's open
  const paintPref = () => {
    button.hidden = !devicePref.on('soundsButton') || !!secondWindow();
    if (button.hidden && !panel.hidden) toggle(false);
  };
  const onPref = (e) => (button.isConnected ? e.detail === 'soundsButton' && paintPref() : removeEventListener('device-pref', onPref));
  addEventListener('device-pref', onPref);
  const onWindow = () => (button.isConnected ? paintPref() : removeEventListener('second-window', onWindow));
  addEventListener('second-window', onWindow);
  paintPref();
  // Open on this page too, if it was on the last
  if (open && !button.hidden) queueMicrotask(() => button.isConnected && toggle(true));
  return dock;
}
