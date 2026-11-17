import { api, attempt, el, fetchAudio, icon, player, recall, remember } from './lib.js';

/** The speech voices, as the Soundboard, the Sounds panel and the pop-out offer them */

// Voices in this order, and any the bot adds later after them
const VOICE_GROUPS = ['Characters', 'Accents'];
/** What the bot takes for no effect */
export const NO_EFFECT = 'none';
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

/** The effects as a picker's options, no effect first */
export function effectOptions(effects, chosen) {
  return [{ id: NO_EFFECT, name: 'No effect' }, ...effects].map((e) => el('option', { value: e.id, selected: e.id === chosen }, e.name));
}

/**
 * The voice and effect pickers beside Say, which remember this device's picks for the server. The effects were voices
 * once, so a pick of one remembered from then becomes the voice it was made on and the effect
 */
export function speechPickers(guildId) {
  const voiceKey = `voice:${guildId}`;
  const effectKey = `effect:${guildId}`;
  const voice = el('select', { ariaLabel: 'Voice', className: 'say-voice', onchange: () => remember(voiceKey, voice.value) });
  const effect = el('select', { ariaLabel: 'Effect', className: 'say-effect', onchange: () => remember(effectKey, effect.value) });
  return {
    voice,
    effect,
    /** Fills them from GET /say: this device's picks while the bot still offers them, or the server's defaults */
    fill({ voices, voice: serverVoice, effects = [], effect: serverEffect = NO_EFFECT, oldVoices = {} }) {
      const old = oldVoices[recall(voiceKey)];
      if (old) {
        remember(voiceKey, old.voice);
        remember(effectKey, old.effect);
      }
      const mine = recall(voiceKey);
      const myEffect = recall(effectKey);
      voice.replaceChildren(...voiceOptions(voices, voices.some((v) => v.id === mine) ? mine : serverVoice));
      effect.replaceChildren(...effectOptions(effects, myEffect === NO_EFFECT || effects.some((e) => e.id === myEffect) ? myEffect : serverEffect));
    },
    /** Shows picks made since on another page or the pop-out */
    showPicks() {
      showPicked(voice, recall(voiceKey));
      showPicked(effect, recall(effectKey));
    },
  };
}

/** Plays `picker`'s voice, through `effect`'s effect if given, saying what's typed in `text`, or a hello, just for whoever pressed it. Again stops it */
export function previewButton(picker, text, effect) {
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
          const name = `preview:${picker.value}:${effect?.value ?? ''}:${line}`;
          // Pressed again while it plays: stop it
          if (player.name === name) return player.stop();
          preview.ariaBusy = 'true';
          try {
            const through = effect ? `&effect=${encodeURIComponent(effect.value)}` : '';
            const url = await fetchAudio(api(`/say/preview?voice=${encodeURIComponent(picker.value)}${through}&text=${encodeURIComponent(line)}`));
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
