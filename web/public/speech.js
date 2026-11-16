import { api, attempt, el, fetchAudio, icon, player } from './lib.js';

/** The speech voices, as the Soundboard, the Sounds panel and the pop-out offer them */

// Voices in this order, and any the bot adds later after them
const VOICE_GROUPS = ['Characters', 'Accents', 'Effects'];
const PREVIEW_TEXT = 'Hello, this is how I sound.';

/**
 * What to say: a box one line high that grows as the text wraps, up to a few lines, and keeps the line breaks of a
 * pasted paragraph. Enter says it and Shift+Enter starts a new line. Setting its value from code calls `fit` itself
 */
export function sayField() {
  const text = el('textarea', { ariaLabel: 'What to say', placeholder: 'Say something', autocomplete: 'off', enterKeyHint: 'send', rows: 1, className: 'say-field' });
  const fit = () => {
    text.style.height = '';
    if (text.scrollHeight > text.clientHeight) text.style.height = `${text.scrollHeight + text.offsetHeight - text.clientHeight}px`;
  };
  const { set } = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(text, 'value', {
    get: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').get,
    set(value) {
      set.call(this, value);
      fit();
    },
  });
  text.addEventListener('input', fit);
  text.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    text.form?.requestSubmit();
  });
  return text;
}

/** The voices as a picker's options, in their groups when the bot says what they are */
export function voiceOptions(voices, chosen) {
  const option = (v) => el('option', { value: v.id, selected: v.id === chosen }, v.name);
  if (!voices.some((v) => v.group)) return voices.map(option);
  const groups = [...new Set([...VOICE_GROUPS, ...voices.map((v) => v.group ?? 'Other')])];
  return groups
    .map((group) => [group, voices.filter((v) => (v.group ?? 'Other') === group)])
    .filter(([, list]) => list.length)
    .map(([group, list]) => el('optgroup', { label: group }, list.map(option)));
}

/** Plays `picker`'s voice saying what's typed in `text`, or a hello, just for whoever pressed it. Again stops it */
export function previewButton(picker, text) {
  const preview = el(
    'button',
    {
      type: 'button',
      className: 'icon say-preview',
      ariaLabel: 'Preview this voice, just for you',
      title: 'Hear it here first, just for you',
      onclick: () =>
        void attempt(async () => {
          // Still fetching the last one
          if (preview.ariaBusy) return;
          const line = text.value.trim() || PREVIEW_TEXT;
          const name = `preview:${picker.value}:${line}`;
          // Pressed again while it plays: stop it
          if (player.name === name) return player.stop();
          preview.ariaBusy = 'true';
          try {
            const url = await fetchAudio(api(`/say/preview?voice=${encodeURIComponent(picker.value)}&text=${encodeURIComponent(line)}`));
            await player.toggle(url, name);
          } finally {
            preview.ariaBusy = null;
          }
        }),
    },
    icon('headphones'),
  );
  return preview;
}

/** Shows `picked`, the voice last picked on this device, if the picker has it: it may have been picked elsewhere since */
export function showPicked(picker, picked) {
  if (picked && picked !== picker.value && [...picker.options].some((o) => o.value === picked)) picker.value = picked;
}
