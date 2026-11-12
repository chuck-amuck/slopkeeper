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

/**
 * A short note in the corner. `action` ({ label, run }) adds a button, such as Undo; a toast with one stays longer,
 * and stays while the pointer or focus is on it, so there's time to reach it
 */
export function toast(text, bad = false, action = null) {
  // An error is read out at once, rather than after whatever is being read
  const node = el('div', { className: `toast${bad ? ' bad' : ''}${action ? ' with-action' : ''}`, role: bad ? 'alert' : undefined }, el('span', {}, text));
  let timer;
  const close = () => node.remove();
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(close, bad || action ? 8000 : 4000);
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

export function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export class RequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Set by the app: what to do when the session has run out */
export const session = { onExpired: () => {} };

export async function request(url, { json, body, method = 'GET' } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(method !== 'GET' && { 'x-slopkeeper': '1' }), ...(json !== undefined && { 'content-type': 'application/json' }) },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch {
    throw new RequestError('Couldn’t reach the web UI. Check your connection.');
  }
  if (res.status === 401 && url.startsWith('/api/')) {
    session.onExpired();
    throw new RequestError('Log in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RequestError(data.error ?? `Request failed (${res.status}).`, res.status);
  return data;
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

/** Runs `load` every `ms` while `main` is on the page. A hidden tab skips it, and catches up as soon as it's shown again */
export function poll(main, ms, load) {
  const run = () => {
    if (!main.isConnected) return stop();
    if (!document.hidden) void load().catch(() => {});
  };
  const timer = setInterval(run, ms);
  const stop = () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', run);
  };
  document.addEventListener('visibilitychange', run);
}

/** The voice channel someone picked on the Soundboard or Music tab, per server, kept across tabs so a sound doesn't go somewhere else */
const pickedVoices = new Map();
export const pickedVoice = {
  get: () => pickedVoices.get(state.guildId) ?? null,
  set: (id) => pickedVoices.set(state.guildId, id),
};
export const api = (path) => `/api/guilds/${state.guildId}${path}`;
export const soundPath = (name, part = '') => api(`/sounds/${encodeURIComponent(name)}${part}`);

// Volume sliders follow a loudness curve rather than the percentage itself, which piles most of the change into the
// bottom quarter: the percentage goes with the square of how far along the slider is, so 100% of 200 sits at 71%
const SLIDER_STEPS = 1000;
/** How far the arrow keys and Page Up or Down move a volume slider, in percent */
const KEY_STEP = 5;
const PAGE_STEP = 20;
let volumeControls = 0;

/**
 * A volume slider with a box for typing the exact percentage. onInput runs while it's being moved, and onSave once a
 * value is settled on. set() shows a value without saving it
 */
export function volumeControl({ min, max, label, onInput, onSave }) {
  const toPercent = (position) => Math.min(max, Math.max(min, Math.round(max * (position / SLIDER_STEPS) ** 2)));
  const toPosition = (percent) => Math.round(SLIDER_STEPS * Math.sqrt(percent / max));
  const marks = `volume-marks-${++volumeControls}`;
  let percent = min;

  const slider = el('input', {
    type: 'range',
    min: toPosition(min),
    max: SLIDER_STEPS,
    step: 1,
    list: marks,
    ariaLabel: label,
    oninput: () => {
      percent = toPercent(Number(slider.value));
      box.value = percent;
      slider.ariaValueText = `${percent}%`;
      onInput?.(percent);
    },
    onchange: () => onSave(percent),
    // A slider position is a sliver of a percent, so the keys move in whole steps of the percentage instead
    onkeydown: (e) => {
      const step = { ArrowUp: KEY_STEP, ArrowRight: KEY_STEP, ArrowDown: -KEY_STEP, ArrowLeft: -KEY_STEP, PageUp: PAGE_STEP, PageDown: -PAGE_STEP }[e.key];
      if (!step) return;
      e.preventDefault();
      // To the next multiple of the step, so 42% goes to 45% or 40%
      const next = Math.min(max, Math.max(min, step > 0 ? Math.floor(percent / step) * step + step : Math.ceil(percent / -step) * -step + step));
      if (next === percent) return;
      set(next);
      onInput?.(percent);
      onSave(percent);
    },
  });
  const box = el('input', {
    type: 'number',
    min,
    max,
    step: 1,
    ariaLabel: `${label}, in percent`,
    // Enter or leaving the box saves it
    onchange: () => {
      if (!Number.isFinite(box.valueAsNumber)) return set(percent);
      set(Math.min(max, Math.max(min, Math.round(box.valueAsNumber))));
      onInput?.(percent);
      onSave(percent);
    },
  });

  function set(value) {
    percent = value;
    slider.value = toPosition(value);
    slider.ariaValueText = `${value}%`;
    box.value = value;
  }

  return {
    node: el(
      'span',
      { className: 'volume-control' },
      slider,
      el('datalist', { id: marks }, el('option', { value: toPosition(100) })),
      el('span', { className: 'volume-box' }, box, '%'),
    ),
    set,
    value: () => percent,
  };
}

export const CUSTOM_EMOJI = /^<(a?):\w+:(\d+)>$/;

export function emojiNode(code, label) {
  const custom = CUSTOM_EMOJI.exec(code);
  if (!custom) return document.createTextNode(code);
  return el('img', { src: `https://cdn.discordapp.com/emojis/${custom[2]}.${custom[1] ? 'gif' : 'webp'}?size=56`, alt: label });
}

/** Opens a dialog, which removes itself when closed */
let dialogs = 0;

/**
 * Opens a modal dialog, named by its first heading. Toasts show inside it while it's open, as the page behind is
 * hidden from screen readers. On closing, focus goes back to what opened it, or to its replacement if the page was
 * redrawn meanwhile
 */
export function openDialog(parent, ...children) {
  const opener = document.activeElement;
  const openerKey = opener && opener !== document.body ? nameOf(opener) : null;
  const node = el(
    'dialog',
    {
      onclose: () => {
        node.remove();
        const under = [...document.querySelectorAll('dialog[open]')].at(-1);
        (under ?? document.body).append(toasts);
        if (opener?.isConnected || !openerKey) return;
        const stand = [...document.querySelectorAll(opener.tagName)].find((n) => nameOf(n) === openerKey);
        stand?.focus();
      },
    },
    ...children,
  );
  const heading = node.querySelector('h2');
  if (heading) {
    heading.id ||= `dialog-title-${++dialogs}`;
    node.setAttribute('aria-labelledby', heading.id);
  }
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
  const node = openDialog(
    parent,
    el('h2', {}, title),
    el('p', {}, text),
    el(
      'form',
      {
        className: 'plan',
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
      },
      channel,
      problem,
      el('div', { className: 'actions' }, el('button', { type: 'button', onclick: () => node.close() }, 'Cancel'), submit),
    ),
  );
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
  const name = props.ariaLabel ?? label;
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
