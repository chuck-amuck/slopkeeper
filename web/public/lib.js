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

export function toast(text, bad = false) {
  const node = el('div', { className: bad ? 'toast bad' : 'toast' }, text);
  toasts.append(node);
  setTimeout(() => node.remove(), bad ? 8000 : 4000);
}

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
      onInput?.(percent);
    },
    onchange: () => onSave(percent),
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
export function openDialog(parent, ...children) {
  const node = el('dialog', { onclose: () => node.remove() }, ...children);
  parent.append(node);
  node.showModal();
  return node;
}

/** Asks which channel to post something in, starting on the announce channel */
export function postDialog(parent, title, text, post) {
  const channel = el('select', { required: true, ariaLabel: 'Channel' });
  const problem = el('div', { className: 'bad-text plan-problem', hidden: true });
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
  const button = el(
    'button',
    {
      ...props,
      className: plain,
      onclick: () => {
        if (!armed) {
          armed = true;
          button.className = `${plain} danger`;
          timer = setTimeout(() => {
            armed = false;
            button.className = plain;
          }, 3000);
          return;
        }
        clearTimeout(timer);
        button.disabled = true;
        void attempt(action).finally(() => {
          button.disabled = false;
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
