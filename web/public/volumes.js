import { api, attempt, el, icon, request, toast, volumeControl } from './lib.js';
import { followWhenIdle } from './updates.js';

/** The volumes the bot plays at, as /volumes names them: the setting each saves to, what it's called and its range */
const VOLUMES = {
  sounds: { key: 'soundVolume', label: 'Sounds', name: 'Sound volume', min: 0, said: 'Sounds play' },
  speech: { key: 'ttsVolume', label: 'Speech', name: 'Speech volume', min: 10, said: 'Speech plays' },
  music: { key: 'musicVolume', label: 'Music', name: 'Music volume', min: 0, said: 'Music plays' },
};

/** How often a slider being dragged sends where it's at, at most */
const PREVIEW_MS = 150;

/**
 * Lets a volume (`sounds`, `speech` or `music`) be heard as its slider is dragged, without saving it: `move` sends where
 * it's at, one at a time and at most every PREVIEW_MS, ending on the latest, and `save` saves it once the ones on their
 * way are in, so the saved volume is the one that stays
 */
export function volumePreview(id) {
  const { key, said } = VOLUMES[id];
  let next = null;
  let sending = null;
  let sentAt = 0;
  let timer = null;
  const later = () => (timer ??= setTimeout(send, Math.max(0, sentAt + PREVIEW_MS - performance.now())));
  async function send() {
    timer = null;
    if (sending || next === null) return;
    const value = next;
    next = null;
    sentAt = performance.now();
    // Only a help: a preview that doesn't go through leaves the volume where it was, and letting go still saves it
    sending = request(api(`/volumes/${id}/preview`), { method: 'POST', json: { value } }).catch(() => {});
    await sending;
    sending = null;
    if (next !== null) later();
  }
  return {
    move(value) {
      next = value;
      if (!sending) later();
    },
    save: (value) =>
      void attempt(async () => {
        clearTimeout(timer);
        timer = null;
        next = null;
        await sending;
        await request(api(`/settings/${key}`), { method: 'PUT', json: { value } });
        // It's the server's setting, not this page's, so saying so is worth a toast
        toast(`${said} at ${value}% for everyone now.`);
      }),
  };
}

/**
 * Sliders for the volumes named, each shown once the bot says what it's at, and only while it's set up. They keep up
 * with whoever changes them, from anywhere, apart from one being dragged or typed in. What's playing follows a slider
 * as it's dragged
 */
export function volumeSliders(names) {
  const rows = names.map((id) => {
    const { label, name, min } = VOLUMES[id];
    const preview = volumePreview(id);
    const control = volumeControl({ min, max: 200, label: name, onInput: preview.move, onSave: preview.save });
    const row = el('div', { className: 'voice-volume', hidden: true, title: 'For everyone in the server' }, el('span', { className: 'voice-label' }, label), control.node);
    return { id, control, row };
  });
  const node = el(
    'div',
    { className: 'volume-sliders' },
    rows.map((r) => r.row),
  );
  followWhenIdle(
    'volumes',
    node,
    () => [node],
    (data) => {
      for (const { id, control, row } of rows) {
        row.hidden = data[id] === null || data[id] === undefined;
        if (!row.hidden) control.set(data[id]);
      }
    },
  );
  return node;
}

let docks = 0;

/**
 * The Volume button in the corner of every page, and the panel it opens above itself with the volumes of sounds,
 * speech and music. The looping room's are in Settings. The panel closes with the button, Escape, or a press anywhere
 * else
 */
export function volumeDock() {
  const panel = el(
    'section',
    { className: 'volume-float', id: `volume-float-${++docks}`, hidden: true, ariaLabel: 'Volume' },
    el('h2', {}, 'Volume'),
    el('p', { className: 'hint' }, 'For everyone in the server, not just you.'),
    volumeSliders(['sounds', 'speech', 'music']),
  );
  const button = el(
    'button',
    {
      type: 'button',
      className: 'volume-fab with-icon',
      ariaLabel: 'Volume',
      title: 'Volume: how loud the bot plays sounds, speech and music, for everyone',
      ariaExpanded: 'false',
      'aria-controls': panel.id,
      onclick: () => toggle(panel.hidden),
    },
    icon('volume'),
  );

  // onOpen hears it open, so the Sounds panel can close: one panel at a time
  const dock = { button, panel, close: () => toggle(false), onOpen: () => {} };

  // While it's open: a press outside the corner, or Escape from anywhere, closes it
  let listening = null;
  function toggle(open) {
    panel.hidden = !open;
    button.ariaExpanded = String(open);
    listening?.abort();
    listening = null;
    if (!open) return;
    dock.onOpen();
    listening = new AbortController();
    const { signal } = listening;
    const corner = button.parentElement?.closest('.stop-dock') ?? button;
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!button.isConnected) return listening?.abort();
        if (!corner.contains(e.target)) toggle(false);
      },
      { signal, capture: true },
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (!button.isConnected) return listening?.abort();
        // An open dialog or sheet has it first
        if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
        // Back to the button, unless focus was somewhere else on the page
        const within = panel.contains(document.activeElement) || document.activeElement === button;
        toggle(false);
        if (within) button.focus();
      },
      { signal },
    );
  }

  return dock;
}
