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

export class RequestError extends Error {}

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
  if (!res.ok) throw new RequestError(data.error ?? `Request failed (${res.status}).`);
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

export const state = { guilds: [], guildId: null };
export const api = (path) => `/api/guilds/${state.guildId}${path}`;
export const soundPath = (name, part = '') => api(`/sounds/${encodeURIComponent(name)}${part}`);

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

/** A button that asks once more before acting, and goes back to normal if it isn't pressed again */
export function confirmButton(props, label, armedLabel, action) {
  let armed = false;
  let timer;
  const button = el(
    'button',
    {
      ...props,
      onclick: () => {
        if (!armed) {
          armed = true;
          button.textContent = armedLabel;
          button.className = 'danger';
          timer = setTimeout(() => {
            armed = false;
            button.textContent = label;
            button.className = props.className ?? '';
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
    label,
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
