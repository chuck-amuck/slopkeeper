import { discordAtFirst, discordBox, freeName, takenQuestion } from './linkclip.js';
import { api, attempt, el, fetchAudio, formProblem, icon, openDialog, player, request, toast } from './lib.js';
import { NO_EFFECT } from './speech.js';
import { lastSaid, onSaid, saidChanged } from './voice.js';

// Keeping a line of speech as a sound, in the voice and effect it was said in: the last line said from this tab, from
// under the Say box, or a line a Chat answer would say, from the Chat tab

/** As long as the bot keeps a line it's made (KEEP_SPOKEN_MS in say.ts), so keeping one doesn't make it again */
const KEPT_MS = 30 * 60_000;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const LONGEST_NAME = 32;

/** A sound name from a line's first words: "I'm Chuck Schumer and I approve this message" → im-chuck-schumer-and-i-approve */
export function nameFromLine(text) {
  const words = text
    .replace(/['’]/g, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let name = '';
  for (const word of words) {
    const longer = name ? `${name}-${word}` : word;
    if (longer.length > LONGEST_NAME) break;
    name = longer;
  }
  return name || words[0]?.slice(0, LONGEST_NAME) || 'line';
}

/**
 * A small button under a Say box, there once a line's been said from this tab: Add “…” to the soundboard. It goes once
 * the line is added, or once the bot no longer keeps it. `shown` says whether the Say box it's under is showing
 */
export function keepLineButton(shown = () => true) {
  const quote = el('span', { className: 'keep-line-quote' });
  const button = el(
    'button',
    { type: 'button', className: 'quiet keep-line', hidden: true, onclick: () => void attempt(keep) },
    icon('plus'),
    el('span', {}, 'Add “'),
    quote,
    el('span', {}, '” to the soundboard'),
  );
  let timer = 0;

  function paint() {
    const line = lastSaid();
    const left = line && !line.kept ? line.at + KEPT_MS - Date.now() : 0;
    clearTimeout(timer);
    button.hidden = left <= 0 || !shown();
    if (button.hidden) return;
    quote.textContent = line.text;
    button.title = 'Keep the last line said as a sound, in its voice and effect';
    timer = setTimeout(() => button.isConnected && paint(), left);
  }

  async function keep() {
    const line = lastSaid();
    if (!line || button.ariaBusy) return;
    button.ariaBusy = 'true';
    try {
      // In the window it's in, which can be the pop-out
      const saved = await keepLineDialog(button.ownerDocument.body, line);
      if (!saved) return;
      line.kept = saved.name;
      saidChanged();
    } finally {
      button.ariaBusy = null;
    }
  }

  onSaid(button, paint);
  // A line said on another page of this tab, a moment ago
  queueMicrotask(paint);
  return { node: button, paint };
}

/**
 * Names `line` ({ text, voice, effect }, as POST /say takes them) and keeps it as a sound. Resolves with the bot's answer
 * once it's saved, or null if it wasn't
 */
export async function keepLineDialog(parent, line) {
  const [library, offered] = await Promise.all([request(api('/sounds')), request(api('/say'))]);
  const names = new Set(library.sounds.map((s) => s.name));
  const isSound = (name) => names.has(name);
  const voiceName = offered.voices.find((v) => v.id === line.voice)?.name ?? 'the server’s voice';
  const effectId = line.effect || offered.effect;
  const effectName = effectId === NO_EFFECT ? null : (offered.effects.find((e) => e.id === effectId)?.name ?? null);
  const heard = `keep:${line.voice}:${line.effect}:${line.text}`;

  return new Promise((resolve) => {
    let outcome = null;
    let toDiscord = discordAtFirst();
    const problem = formProblem();
    // Why it can't be saved yet, other than a taken name, which has its own question
    const why = el('p', { className: 'bad-text', hidden: true });
    const taken = takenQuestion(show);
    const name = el('input', {
      value: freeName(nameFromLine(line.text), isSound),
      maxLength: LONGEST_NAME,
      ariaLabel: 'Sound name',
      autocomplete: 'off',
      required: true,
      oninput: () => {
        taken.choice = null;
        show();
      },
    });
    const discordNote = el('p', { className: 'hint' }, `A line over ${library.clipSeconds} s stays on the bot’s soundboard only, as that’s the most Discord’s soundboard takes.`);
    const discord = discordBox(toDiscord, (on) => {
      toDiscord = on;
      show();
    });
    const hear = el('button', { type: 'button', className: 'with-icon', title: 'Hear it here, just for you', onclick: () => void attempt(listen) }, icon('headphones'), el('span', {}, 'Hear it'));
    const save = el('button', { className: 'primary', type: 'submit' }, 'Save');

    function show() {
      const text = name.value.trim().toLowerCase();
      const isTaken = NAME_PATTERN.test(text) && isSound(text);
      taken.show(text, isTaken);
      const problemNow = !text
        ? 'Give it a name.'
        : !NAME_PATTERN.test(text)
          ? 'Names use lowercase letters, numbers, - and _.'
          : isTaken && !taken.choice
            ? 'Choose what to do about the name that’s taken.'
            : null;
      save.disabled = Boolean(problemNow);
      why.hidden = !problemNow || problemNow.startsWith('Choose');
      why.textContent = problemNow ?? '';
      discordNote.hidden = !toDiscord;
    }

    async function listen() {
      if (player.name === heard) return player.stop();
      if (hear.ariaBusy) return;
      hear.ariaBusy = 'true';
      try {
        // All of it, as it was said
        const url = await fetchAudio(api('/say/preview'), { text: line.text, voice: line.voice ?? '', effect: line.effect ?? '' });
        if (node.open) await player.toggle(url, heard);
        else URL.revokeObjectURL(url);
      } finally {
        hear.ariaBusy = null;
      }
    }

    const node = openDialog(parent, {
      title: 'Add to the soundboard',
      className: 'keep-line-dialog',
      body: [
        el('blockquote', { className: 'keep-line-said' }, line.text),
        el('p', { className: 'hint' }, `In ${voiceName}${effectName ? `, ${effectName}` : ''}`),
        problem,
        el('label', { className: 'start link-name' }, 'Name', name),
        why,
        taken.node,
        discord,
        discordNote,
      ],
      start: [hear],
      actions: [save],
      close: 'Cancel',
      noValidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (save.disabled) return;
        const wanted = name.value.trim().toLowerCase();
        problem.hidden = true;
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          outcome = await request(api('/say/sound'), {
            method: 'POST',
            json: { text: line.text, voice: line.voice, effect: line.effect, name: wanted, discord: toDiscord, replace: taken.choice === 'replace', keep: taken.choice === 'keep' },
          });
          node.close();
        } catch (err) {
          // Taken since the dialog opened: asked about like any other
          if (err.message?.startsWith('There’s already a sound')) names.add(wanted);
          problem.textContent = err.message ?? 'Something went wrong. Check the browser console.';
          problem.hidden = false;
          save.textContent = 'Save';
          show();
        }
      },
    });
    node.addEventListener('close', () => {
      if (player.name === heard) player.stop();
      if (outcome) {
        const done = outcome.replaced ? `Replaced ${outcome.name}. The old one is in Recently deleted.` : `Added ${outcome.name} to the soundboard.`;
        toast(outcome.discordProblem ? `${done}\nBot soundboard only: ${outcome.discordProblem}.` : done);
      }
      resolve(outcome);
    });
    show();
  });
}
