import { drawWave } from './clip.js';
import { api, el, formProblem, openDialog, recall, remember, request } from './lib.js';

// Adding a sound from part of a YouTube video or Short, a TikTok, an Instagram Reel or a SoundCloud track. The bot has the
// music container download it, and this shows it with its waveform so the part can be picked

const SHORTEST = 0.1;
const STEP = 0.01;
const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

const rounded = (s) => Math.round(s / STEP) * STEP;
// As clip.js draws them
const BAR = 2;
const GAP = 1;

/** The bot's peaks, fewer, for the canvas's columns: the loudest of those in each */
function columnsOf(peaks, columns) {
  const out = [];
  for (let c = 0; c < columns; c++) {
    const from = Math.floor((c * peaks.length) / columns);
    const to = Math.max(from + 1, Math.floor(((c + 1) * peaks.length) / columns));
    out.push(Math.max(...peaks.slice(from, to)));
  }
  return out;
}

/** 12.50 s, or 3:04.25 for a time in a long video */
export const clock = (s) => (s < 60 ? `${s.toFixed(2)} s` : `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`);

/** A sound name from a video's title: "Big Fun (Official)" → big-fun-official */
export const nameFromTitle = (title) =>
  title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '') || 'sound';

/** Has the bot download a link. Resolves with what it is: its id, title, length and whether there's a picture */
export const downloadLink = (url) => request(api('/sound-links'), { method: 'POST', json: { url } });

/**
 * Picks part of a download and saves it as a sound. `sound` is a sound from a link being picked again: it starts at the part
 * picked before and replaces that sound. Resolves with the bot's answer once it's saved, or null if it's dismissed
 */
export function pickPart(main, got, { longest, clipSeconds, isSound, sound = null }) {
  return new Promise((resolve) => {
    const seconds = got.seconds;
    let start = sound?.link ? Math.min(sound.link.start, seconds - SHORTEST) : 0;
    let end = sound?.link ? Math.min(sound.link.end, seconds) : Math.min(seconds, clipSeconds);
    let toDiscord = sound ? sound.onDiscord : recall('uploadToDiscord') !== 'no';
    // What to do about a name that's taken: replace or keep
    let choice = sound ? 'replace' : null;
    let peaks = null;
    let dragging = null;
    let stopAt = null;
    let outcome = null;
    let source = null;

    // A video plays in place. A track's player is there for finding a time
    const media = el(got.video ? 'video' : 'audio', { className: 'link-media', controls: true, playsInline: true, preload: 'auto' });
    const canvas = el('canvas', { className: 'wave', hidden: true });
    const status = el('p', {}, 'Loading…');
    const problem = formProblem();
    const length = el('output', {});
    const box = (label, change) =>
      el('input', { type: 'number', min: 0, max: seconds, step: STEP, ariaLabel: label, required: true, oninput: (e) => Number.isFinite(e.target.valueAsNumber) && change(e.target.valueAsNumber, true) });
    const startInput = box('Start in seconds', moveStart);
    const endInput = box('End in seconds', moveEnd);
    const here = (label, move) => el('button', { type: 'button', className: 'quiet', title: `${label} where the player is`, onclick: () => move(media.currentTime) }, label);
    const preview = el('button', { type: 'button', disabled: true, onclick: () => (stopAt !== null ? stop() : play()) }, 'Preview');
    const save = el('button', { className: 'primary', type: 'submit' }, sound ? 'Replace' : 'Save');
    const name = el('input', {
      value: sound?.name ?? nameFromTitle(got.title),
      maxLength: 32,
      ariaLabel: 'Sound name',
      required: true,
      oninput: () => {
        choice = null;
        show(false);
      },
    });
    const choiceBox = el('div', { className: 'note choice' });
    // Why it can't be saved yet, other than a taken name, which has its own question
    const why = el('p', { className: 'bad-text', hidden: true });
    const discordNote = el('p', { className: 'hint' });
    const discord = el(
      'label',
      { className: 'check' },
      el('input', {
        type: 'checkbox',
        checked: toDiscord,
        onchange: (e) => {
          toDiscord = e.target.checked;
          remember('uploadToDiscord', toDiscord ? 'yes' : 'no');
          show(false);
        },
      }),
      'Also add to Discord’s soundboard',
    );

    function stop() {
      stopAt = null;
      media.pause();
      preview.textContent = 'Preview';
    }

    function play() {
      media.currentTime = start;
      stopAt = end;
      preview.textContent = 'Stop';
      void media.play().catch(stop);
      const watch = () => {
        if (stopAt === null) return;
        if (media.currentTime >= stopAt || media.paused || media.ended) return stop();
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    }

    /** Whether the name is taken, and if so, what's been chosen */
    function showChoice(typed) {
      const text = name.value.trim().toLowerCase();
      if (sound || !NAME_PATTERN.test(text) || !isSound(text)) return choiceBox.replaceChildren();
      const button = (label, to, className = '') =>
        el('button', { type: 'button', className, onclick: () => {
          choice = to;
          show(typed);
        } }, label);
      if (choice === 'replace') return choiceBox.replaceChildren(el('span', {}, `Replaces ${text}. The old one goes to Recently deleted.`), button('Keep both instead', 'keep'));
      if (choice === 'keep') return choiceBox.replaceChildren(el('span', {}, 'Keeps both. The new one gets a number on the end of its name.'), button('Replace instead', 'replace'));
      choiceBox.replaceChildren(el('span', {}, `There’s already a sound called ${text}.`), button('Replace it', 'replace', 'danger'), button('Keep both', 'keep'));
    }

    function partProblem() {
      const text = name.value.trim().toLowerCase();
      if (end - start > longest + STEP) return `Keep at most ${longest / 60} minutes.`;
      if (!NAME_PATTERN.test(text)) return 'Names use lowercase letters, numbers, - and _.';
      if (!sound && isSound(text) && !choice) return 'Choose what to do about the name that’s taken.';
      return null;
    }

    function show(typed) {
      if (!typed) {
        startInput.value = rounded(start).toFixed(2);
        endInput.value = rounded(end).toFixed(2);
      }
      length.textContent = `Keeps ${clock(end - start)} of ${clock(seconds)}`;
      const problemNow = partProblem();
      save.disabled = Boolean(problemNow) || end - start < SHORTEST;
      why.hidden = !problemNow || problemNow.startsWith('Choose');
      why.textContent = problemNow ?? '';
      showChoice(typed);
      discordNote.hidden = !toDiscord || end - start <= clipSeconds;
      discordNote.textContent = `Discord’s soundboard takes ${clipSeconds} s at most, so a longer part stays on the bot’s soundboard. You can add a ${clipSeconds} s piece of it to Discord afterwards.`;
      if (stopAt !== null) stop();
      if (peaks) drawWave(canvas, peaks, seconds, start, end);
    }

    /** The picture follows the end being moved, so you can see where it is */
    const seek = (to) => {
      if (stopAt === null && media.readyState > 0) media.currentTime = to;
    };

    function moveStart(to, typed = false) {
      start = Math.max(0, Math.min(end - SHORTEST, to));
      seek(start);
      show(typed);
    }

    function moveEnd(to, typed = false) {
      end = Math.min(seconds, Math.max(start + SHORTEST, to));
      seek(end);
      show(typed);
    }

    const timeAt = (e) => {
      const { left, width } = canvas.getBoundingClientRect();
      return ((e.clientX - left) / width) * seconds;
    };
    canvas.addEventListener('pointerdown', (e) => {
      const at = timeAt(e);
      dragging = Math.abs(at - start) <= Math.abs(at - end) ? moveStart : moveEnd;
      canvas.setPointerCapture(e.pointerId);
      dragging(at);
    });
    canvas.addEventListener('pointermove', (e) => dragging?.(timeAt(e)));
    canvas.addEventListener('pointerup', () => (dragging = null));

    const node = openDialog(main, {
      title: sound ? `Pick again for ${sound.name}` : 'Add a sound from a link',
      className: 'link-dialog',
      body: [
        el('p', { className: 'link-source' }, el('a', { href: got.url, target: '_blank', rel: 'noopener noreferrer' }, got.title), got.artist && ` · ${got.artist}`),
        media,
        canvas,
        status,
        problem,
        el(
          'div',
          { className: 'trim-times' },
          el('label', { className: 'start' }, 'Start', startInput),
          here('Start here', moveStart),
          el('label', { className: 'start' }, 'End', endInput),
          here('End here', moveEnd),
          length,
        ),
        why,
        !sound && el('label', { className: 'start link-name' }, 'Name', name),
        choiceBox,
        !sound && discord,
        discordNote,
      ],
      start: [preview],
      actions: [save],
      close: 'Cancel',
      noValidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (save.disabled) return;
        problem.hidden = true;
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          outcome = await request(api(`/sound-links/${encodeURIComponent(got.id)}`), {
            method: 'PUT',
            json: { name: name.value.trim().toLowerCase(), start, end, discord: toDiscord, replace: choice === 'replace', keep: choice === 'keep' },
          });
          node.close();
        } catch (err) {
          problem.textContent = err.message;
          problem.hidden = false;
          save.textContent = sound ? 'Replace' : 'Save';
          show(false);
        }
      },
    });
    node.addEventListener('close', () => {
      stop();
      media.removeAttribute('src');
      media.load();
      if (source) URL.revokeObjectURL(source);
      resolve(outcome);
    });

    show(false);
    void (async () => {
      // The waveform is worked out while the video comes, which for a long one takes a while
      const waveAsked = request(api(`/sound-links/${encodeURIComponent(got.id)}/wave`)).catch(() => ({ peaks: null }));
      try {
        const res = await fetch(api(`/sound-links/${encodeURIComponent(got.id)}/media`));
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'The download couldn’t be loaded.');
        const blob = await res.blob();
        if (!node.open) return;
        source = URL.createObjectURL(blob);
        media.src = source;
        media.addEventListener('loadedmetadata', () => seek(start), { once: true });
        preview.disabled = false;
        const wave = await waveAsked;
        if (!node.open) return;
        if (wave.peaks?.length) {
          canvas.hidden = false;
          peaks = columnsOf(wave.peaks, Math.floor(canvas.clientWidth / (BAR + GAP)));
          status.textContent = 'Drag either end of the waveform, or play to a moment and press Start here or End here.';
          show(false);
        } else {
          status.textContent = 'The waveform couldn’t be drawn. Play to a moment and press Start here or End here, or type the times.';
        }
      } catch (err) {
        status.textContent = err.message;
      }
    })();
  });
}
