const toasts = document.getElementById('toasts');

/** Everything shown goes through text nodes, so a sound or channel name can't become markup */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    // An input's list property is read-only; only its attribute can be set
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// One set of line icons, drawn on a 24-unit grid in the text colour, so they look the same on every device
const ICONS = {
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<g fill="currentColor" stroke="none"><rect x="6.5" y="5.5" width="4" height="13" rx="1"/><rect x="13.5" y="5.5" width="4" height="13" rx="1"/></g>',
  next: '<path d="M6 5.5v13l9.5-6.5z" fill="currentColor"/><path d="M18.5 5.5v13"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3.5" y="14" width="4" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4" height="6.5" rx="1.5"/>',
  volume: '<path d="M4 9.5h3l5-4v13l-5-4H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5"/>',
  pads: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  speaker: '<path d="M3.5 9.5h3l5-4v13l-5-4h-3z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5"/><path d="M17.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  scissors: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8.2 8.3 19 17M8.2 15.7 19 7"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  up: '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>',
  down: '<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>',
  top: '<path d="M5 4.5h14M12 20V9M7 13.5l5-5 5 5"/>',
  shuffle: '<path d="M16 4h4v4M4 20 20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.8L12 16.8l-5.3 2.8 1.1-5.8-4.3-4.1 5.9-.8z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>',
  more: '<g fill="currentColor" stroke="none"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></g>',
  chevron: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v4h14v-4"/>',
  note: '<path d="M9 18V5.5l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><g fill="currentColor" stroke="none"><circle cx="8.5" cy="8.5" r="1.5"/><circle cx="15.5" cy="8.5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="8.5" cy="15.5" r="1.5"/><circle cx="15.5" cy="15.5" r="1.5"/></g>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10.5h16M8.5 3.5v4M15.5 3.5v4"/>',
  chart: '<path d="M4 20h16M7 16.5v-5M12 16.5V6.5M17 16.5v-8"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  logout: '<path d="M13.5 4.5h-7v15h7"/><path d="M10.5 12H20M16.5 8.5 20 12l-3.5 3.5"/>',
  enter: '<path d="M10.5 4.5h7v15h-7"/><path d="M4 12h10M10.5 8.5 14 12l-3.5 3.5"/>',
  pencil: '<path d="M15 5.5l3.5 3.5L9 18.5H5.5V15z"/><path d="M13 7.5l3.5 3.5"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0"/><g fill="currentColor" stroke="none"><circle cx="9" cy="10" r="1.2"/><circle cx="15" cy="10" r="1.2"/></g>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2-4.9"/><path d="M19.5 4.5v4h-4"/>',
};

const drawn = new Map();

/** One of the icons above, hidden from screen readers: the button or text around it says what it is */
export function icon(name) {
  if (!(name in ICONS)) throw new Error(`There’s no icon called ${name}`);
  let svg = drawn.get(name);
  // Each is drawn once, and copied after that, as lists of hundreds of rows redraw often
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', class: `ico ico-${name}`, 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
    svg.innerHTML = ICONS[name];
    drawn.set(name, svg);
  }
  return svg.cloneNode(true);
}

/**
 * A short note in the corner. `action` ({ label, run }) adds a button, such as Undo; a toast with one stays longer,
 * and stays while the pointer or focus is on it, so there's time to reach it. One that `stays` waits to be closed
 */
export function toast(text, bad = false, action = null, stays = false) {
  // An error is read out at once, rather than after whatever is being read
  const node = el('div', { className: `toast${bad ? ' bad' : ''}${action || stays ? ' with-action' : ''}`, role: bad ? 'alert' : undefined }, el('span', {}, text));
  let timer;
  const close = () => node.remove();
  const wait = () => {
    clearTimeout(timer);
    if (!stays) timer = setTimeout(close, bad || action ? 8000 : 4000);
  };
  if (action) {
    node.append(
      el('button', {
        type: 'button',
        className: 'toast-action',
        onclick: () => {
          close();
          void attempt(action.run);
        },
      }, action.label),
    );
    const hold = () => clearTimeout(timer);
    node.addEventListener('pointerenter', hold);
    node.addEventListener('pointerleave', wait);
    node.addEventListener('focusin', hold);
    node.addEventListener('focusout', wait);
  }
  if (stays) node.append(el('button', { type: 'button', className: 'toast-close icon', ariaLabel: 'Dismiss', title: 'Dismiss', onclick: close }, icon('x')));
  // A dialog it was in may have gone without closing, when the page was redrawn under it
  if (!toasts.isConnected) document.body.append(toasts);
  toasts.append(node);
  wait();
}

/** Says something to screen readers only, such as a change that's only shown by colour */
export function announce(text) {
  let region = document.getElementById('announcer');
  if (!region) {
    region = el('div', { id: 'announcer', className: 'visually-hidden', role: 'status' });
    document.body.append(region);
  }
  // Emptied first, so saying the same thing twice is still heard
  region.textContent = '';
  setTimeout(() => (region.textContent = text), 50);
}

/**
 * What a list or page says in place of its contents: 'loading', 'empty', 'error' (read out at once) or 'more' (a
 * list cut short). One look for each, so an error never passes for an empty list
 */
export function notice(kind, text, ...rest) {
  // Options come last, and anything between is more of the message, such as a link
  const options = rest.length && !(rest.at(-1) instanceof Node) && typeof rest.at(-1) === 'object' ? rest.pop() : {};
  const { compact = false, tag = 'div' } = options;
  return el(tag, { className: `notice ${kind}${compact ? ' compact' : ''}`, role: kind === 'error' ? 'alert' : undefined }, text, ...rest);
}

/** The line in a form that says why it didn't go through. Read out when it's shown */
export const formProblem = () => el('div', { className: 'bad-text plan-problem', role: 'alert', hidden: true });

/**
 * Rebuilds part of the page without losing the keyboard's place: if focus was on a button or field in `container`,
 * it goes to the one with the same name afterwards
 */
export function keepFocus(container, rebuild) {
  const focused = document.activeElement;
  const inside = container.contains(focused) && focused !== container;
  const key = inside ? nameOf(focused) : null;
  // Where it was, for when the same one isn't there any more: the next one along is the most useful place
  const at = inside ? focusables(container).indexOf(focused) : -1;
  rebuild();
  if (!inside || container.contains(document.activeElement)) return;
  const same = [...container.querySelectorAll(focused.tagName)].find((node) => nameOf(node) === key);
  const after = focusables(container);
  (same ?? after[Math.min(at, after.length - 1)])?.focus();
}

const focusables = (container) => [...container.querySelectorAll('button, input, select, textarea, a[href], summary')].filter((node) => !node.disabled && !node.hidden);

const nameOf = (node) => `${node.tagName}|${node.getAttribute('aria-label') ?? node.title ?? ''}|${node.textContent.trim().slice(0, 80)}`;

/** A toast with Undo, for something that's quick to do by accident */
export const undoToast = (text, undo) => toast(text, false, { label: 'Undo', run: undo });

export function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function forget(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

export function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** What's turned on or off in Settings for this device alone, each on until it's turned off: musicPlayer, soundsButton */
export const devicePref = {
  on: (name) => recall(`device:${name}`) !== 'off',
  set(name, on) {
    if (on) forget(`device:${name}`);
    else remember(`device:${name}`, 'off');
    dispatchEvent(new CustomEvent('device-pref', { detail: name }));
  },
};

export class RequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Set by the app: what to do when the session has run out */
export const session = { onExpired: () => {} };

/** The version of the page's files this tab loaded. The web UI says its own with every answer, so a redeploy shows */
const pageVersion = document.querySelector('meta[name="slopkeeper-version"]')?.content ?? null;
let newVersionShown = false;

function checkVersion(res) {
  const version = res.headers.get('x-slopkeeper-version');
  if (!pageVersion || !version || version === pageVersion || newVersionShown) return;
  newVersionShown = true;
  toast('There’s a new version of this page.', false, { label: 'Reload', run: () => location.reload() }, true);
}

export async function request(url, { json, body, method = 'GET', signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(method !== 'GET' && { 'x-slopkeeper': '1' }), ...(json !== undefined && { 'content-type': 'application/json' }) },
      body: json !== undefined ? JSON.stringify(json) : body,
      signal,
    });
  } catch {
    throw new RequestError('Couldn’t reach the web UI. Check your connection.');
  }
  checkVersion(res);
  if (res.status === 401 && url.startsWith('/api/')) {
    session.onExpired();
    throw new RequestError('Log in again.', 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RequestError(data.error ?? `Request failed (${res.status}).`, res.status);
  return data;
}

/** Fetches audio to play in this browser only, such as a voice preview: a URL for it, or the bot's reason why not */
export async function fetchAudio(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new RequestError('Couldn’t reach the web UI. Check your connection.');
  }
  checkVersion(res);
  if (res.status === 401) {
    session.onExpired();
    throw new RequestError('Log in again.', 401);
  }
  if (!res.ok) throw new RequestError((await res.json().catch(() => ({}))).error ?? `Couldn’t get that (${res.status}).`, res.status);
  return URL.createObjectURL(await res.blob());
}

/** Runs an action from a button or field, showing any failure */
export async function attempt(action) {
  try {
    return await action();
  } catch (err) {
    if (!(err instanceof RequestError)) console.error(err);
    toast(err instanceof RequestError ? err.message : 'Something went wrong. Check the browser console.', true);
  }
}

/** A length of time, as 45m, 2h 5m or 120h */
export function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours >= 100 || minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** A rough age, as Discord shows it */
export function ago(ms) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return days < 730 ? `${Math.round(days / 30)} months ago` : `${Math.round(days / 365)} years ago`;
}

// me: who Pangolin signed in, with the Discord member they said they are in this server. Null from the home network
export const state = { guilds: [], guildId: null, me: null };

/** The voice channel someone picked on the Soundboard or Music tab, per server, kept across tabs so a sound doesn't go somewhere else */
const pickedVoices = new Map();
export const pickedVoice = {
  get: () => pickedVoices.get(state.guildId) ?? null,
  set: (id) => pickedVoices.set(state.guildId, id),
};
export const api = (path) => `/api/guilds/${state.guildId}${path}`;
export const soundPath = (name, part = '') => api(`/sounds/${encodeURIComponent(name)}${part}`);

// Volume sliders read like VLC's: 0 to 100% fills the first three quarters of the bar evenly, and past 100% is a boost
// zone, the last quarter, marked off so it's clear when something's turned up beyond its normal level
const SLIDER_STEPS = 1000;
/** Where 100% sits along the bar, as a fraction */
const FULL_AT = 0.75;
/** How far the arrow keys and Page Up or Down move a volume slider, in percent */
const KEY_STEP = 5;
const PAGE_STEP = 20;

/**
 * A volume slider with the percentage beside it, which can be typed over. onInput runs while it's being moved, and
 * onSave once a value is settled on. set() shows a value without saving it. Every slider starts at 0 so 100% is in
 * the same place on each; one with a higher `min` stops there
 */
export function volumeControl({ min, max, label, onInput, onSave }) {
  // A slider that can't go past 100% is all normal zone
  const fullAt = max > 100 ? FULL_AT : 1;
  const full = Math.round(SLIDER_STEPS * fullAt);
  const clamp = (value) => Math.min(max, Math.max(min, value));
  const toPercent = (position) =>
    clamp(position <= full ? Math.round((position / full) * 100) : 100 + Math.round(((position - full) / (SLIDER_STEPS - full)) * (max - 100)));
  const toPosition = (value) => (value <= 100 ? Math.round((value / 100) * full) : full + Math.round(((value - 100) / (max - 100)) * (SLIDER_STEPS - full)));
  let percent = min;

  const slider = el('input', {
    type: 'range',
    // Without a boost zone, there's no 100% to mark
    className: max > 100 ? '' : 'capped',
    min: 0,
    max: SLIDER_STEPS,
    step: 1,
    ariaLabel: label,
    oninput: () => {
      percent = toPercent(Number(slider.value));
      // Below the lowest it goes, the knob stays at the lowest
      if (Number(slider.value) < toPosition(min)) slider.value = toPosition(min);
      show();
      onInput?.(percent);
    },
    onchange: () => onSave(percent),
    // A slider position is a sliver of a percent, so the keys move in whole steps of the percentage instead
    onkeydown: (e) => {
      const step = { ArrowUp: KEY_STEP, ArrowRight: KEY_STEP, ArrowDown: -KEY_STEP, ArrowLeft: -KEY_STEP, PageUp: PAGE_STEP, PageDown: -PAGE_STEP }[e.key];
      if (!step) return;
      e.preventDefault();
      // To the next multiple of the step, so 42% goes to 45% or 40%
      const next = clamp(step > 0 ? Math.floor(percent / step) * step + step : Math.ceil(percent / -step) * -step + step);
      if (next === percent) return;
      set(next);
      onInput?.(percent);
      onSave(percent);
    },
  });
  slider.style.setProperty('--full', String(fullAt));
  const box = el('input', {
    type: 'number',
    min,
    max,
    step: 1,
    ariaLabel: `${label}, in percent`,
    // Enter or leaving the box saves it
    onchange: () => {
      if (!Number.isFinite(box.valueAsNumber)) return set(percent);
      set(clamp(Math.round(box.valueAsNumber)));
      onInput?.(percent);
      onSave(percent);
    },
  });

  /** The fill up to the knob, orange past 100% */
  function show() {
    box.value = percent;
    slider.ariaValueText = `${percent}%`;
    slider.style.setProperty('--at', String(Number(slider.value) / SLIDER_STEPS));
    slider.classList.toggle('boosted', percent > 100);
  }

  function set(value) {
    percent = value;
    slider.value = toPosition(value);
    show();
  }

  set(min);
  return {
    node: el('span', { className: 'volume-control' }, slider, el('span', { className: 'volume-box' }, box, '%')),
    set,
    value: () => percent,
  };
}

const CUSTOM_EMOJI = /^<(a?):\w+:(\d+)>$/;

export function emojiNode(code, label) {
  const custom = CUSTOM_EMOJI.exec(code);
  if (!custom) return document.createTextNode(code);
  return el('img', { src: `https://cdn.discordapp.com/emojis/${custom[2]}.${custom[1] ? 'gif' : 'webp'}?size=56`, alt: label });
}

/** Opens a dialog, which removes itself when closed */
let dialogs = 0;

/**
 * Opens a modal dialog, laid out the same way everywhere: its title, a body that scrolls when it's long, and a footer
 * that stays put. The footer has `start` on the left (such as Preview or Remove), then `actions` (such as Save), then
 * the button that closes it (`close`: Cancel, Close or Done, filled if `closePrimary`), always last on the right. With
 * `onsubmit`, the body and footer are one form, so Enter in a field submits it. The class `sheet` rises from the
 * bottom of a phone's screen, for a short list of choices.
 *
 * Toasts show inside it while it's open, as the page behind is hidden from screen readers. On closing, focus goes back
 * to what opened it, or to its replacement if the page was redrawn meanwhile
 */
export function openDialog(parent, { title, body = [], start = [], actions = [], close = 'Close', closePrimary = false, onsubmit, noValidate, className }) {
  const opener = document.activeElement;
  const openerKey = opener && opener !== document.body ? nameOf(opener) : null;
  const heading = el('h2', { id: `dialog-title-${++dialogs}` }, title);
  const main = el('div', { className: 'dialog-body' }, ...body);
  const foot = el(
    'div',
    { className: 'dialog-foot' },
    el('div', { className: 'dialog-start' }, ...start),
    ...actions,
    el('button', { type: 'button', className: closePrimary ? 'primary' : undefined, onclick: () => node.close() }, close),
  );
  const node = el(
    'dialog',
    {
      className,
      onclose: () => {
        node.remove();
        const under = [...document.querySelectorAll('dialog[open]')].at(-1);
        (under ?? document.body).append(toasts);
        if (opener?.isConnected || !openerKey) return;
        const stand = [...document.querySelectorAll(opener.tagName)].find((n) => nameOf(n) === openerKey);
        stand?.focus();
      },
    },
    heading,
    onsubmit ? el('form', { className: 'dialog-form', onsubmit, noValidate }, main, foot) : [main, foot],
  );
  node.setAttribute('aria-labelledby', heading.id);
  parent.append(node);
  node.showModal();
  node.append(toasts);
  return node;
}

/** Asks which channel to post something in, starting on the announce channel */
export function postDialog(parent, title, text, post) {
  const channel = el('select', { required: true, ariaLabel: 'Channel' });
  const problem = formProblem();
  const submit = el('button', { className: 'primary', type: 'submit', disabled: true }, 'Post');
  const node = openDialog(parent, {
    title,
    body: [el('p', {}, text), channel, problem],
    actions: [submit],
    close: 'Cancel',
    onsubmit: (e) => {
      e.preventDefault();
      submit.disabled = true;
      problem.hidden = true;
      void attempt(async () => {
        try {
          await post(channel.value, channel.selectedOptions[0].textContent);
          node.close();
        } catch (err) {
          if (!(err instanceof RequestError)) throw err;
          problem.textContent = err.message;
          problem.hidden = false;
        } finally {
          submit.disabled = false;
        }
      });
    },
  });
  void attempt(async () => {
    const { channels, announceChannel } = await request(api('/pick/options'));
    channel.replaceChildren(...channels.map((c) => el('option', { value: c.id, selected: c.id === announceChannel }, `#${c.name}`)));
    submit.disabled = !channels.length;
  });
}

/**
 * A button that asks once more before acting, and goes back to normal if it isn't pressed again. Both labels are in
 * it, one hidden, so it's the same size either way and doesn't push the rest of the row about
 */
export function confirmButton(props, label, armedLabel, action) {
  let armed = false;
  let timer;
  const plain = `${props.className ?? ''} confirm`.trim();
  // An icon has no words of its own, so one needs an ariaLabel
  const name = props.ariaLabel ?? (typeof label === 'string' ? label : props.title);
  const disarm = () => {
    armed = false;
    button.className = plain;
    button.ariaLabel = props.ariaLabel ?? null;
  };
  // Not while it has focus, so someone reading it with a screen reader or keyboard isn't rushed
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.activeElement !== button) disarm();
    }, 3000);
  };
  const button = el(
    'button',
    {
      ...props,
      className: plain,
      onblur: () => {
        if (armed) later();
      },
      onclick: () => {
        if (button.ariaDisabled === 'true') return;
        if (!armed) {
          armed = true;
          button.className = `${plain} danger`;
          // Only the colour and the hidden label change, so say it too
          button.ariaLabel = `${name}. ${armedLabel} Press again to confirm.`;
          announce(`${armedLabel} Press again to confirm.`);
          later();
          return;
        }
        clearTimeout(timer);
        disarm();
        // Not disabled, which would throw focus off it and lose the keyboard's place
        button.ariaDisabled = 'true';
        void attempt(action).finally(() => {
          button.ariaDisabled = null;
        });
      },
    },
    el('span', {}, label),
    el('span', {}, armedLabel),
  );
  return button;
}

/** Plays one sound at a time, for preview in the browser. Goes through a gain node, as an audio element can't play louder than the file */
export const player = {
  audio: null,
  context: null,
  gain: null,
  name: null,
  onChange: () => {},
  stop() {
    this.audio?.pause();
    // Audio fetched for a preview is held until it's let go
    if (this.audio?.src.startsWith('blob:')) URL.revokeObjectURL(this.audio.src);
    this.gain?.disconnect();
    this.audio = null;
    this.gain = null;
    this.name = null;
    this.onChange();
  },
  /** Changes how loud a sound is if it's the one playing */
  setLoudness(name, loudness) {
    if (this.name === name) this.gain.gain.value = loudness;
  },
  async toggle(url, name, loudness = 1) {
    const again = this.name === name;
    this.stop();
    if (again) return;
    this.context ??= new AudioContext();
    void this.context.resume();
    this.audio = new Audio(url);
    this.gain = this.context.createGain();
    this.gain.gain.value = loudness;
    this.context.createMediaElementSource(this.audio).connect(this.gain).connect(this.context.destination);
    this.name = name;
    this.audio.addEventListener('ended', () => this.stop());
    this.onChange();
    await this.audio.play().catch(() => {
      this.stop();
      toast(`The browser can’t play ${name}.`, true);
    });
  },
};
