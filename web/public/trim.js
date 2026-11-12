import { drawWave, loadWave } from './clip.js';
import { el, formProblem, openDialog, request, soundPath } from './lib.js';

const SHORTEST = 0.1;
/** The page rounds to this, so anything closer than twice it to the end of the sound still means the end */
const STEP = 0.01;

const rounded = (s) => Math.round(s / STEP) * STEP;

/** Resolves with 'trimmed' or 'restored' once the sound has changed, or null if it's dismissed */
export function pickTrim(main, sound) {
  return new Promise((resolve) => {
    const seconds = sound.seconds ?? 0;
    const context = new AudioContext();
    const gain = context.createGain();
    gain.gain.value = sound.loudness;
    gain.connect(context.destination);
    let start = 0;
    let end = seconds;
    let buffer = null;
    let peaks = null;
    let source = null;
    let dragging = null;
    let outcome = null;

    const canvas = el('canvas', { className: 'wave', hidden: true });
    const status = el('p', {}, sound.seconds === null ? 'The bot can’t read how long this sound is, so it can’t be trimmed.' : 'Loading the waveform…');
    const problem = formProblem();
    const length = el('output', {});
    const box = (label, change) => el('input', { type: 'number', min: 0, max: seconds, step: STEP, ariaLabel: label, required: true, oninput: (e) => Number.isFinite(e.target.valueAsNumber) && change(e.target.valueAsNumber, true) });
    const startInput = box(`Start of ${sound.name} in seconds`, moveStart);
    const endInput = box(`End of ${sound.name} in seconds`, moveEnd);
    const preview = el('button', { type: 'button', disabled: true, onclick: () => (source ? stop() : play()) }, 'Preview');
    const save = el('button', { className: 'primary', type: 'submit', disabled: true }, 'Save');

    function stop() {
      source?.stop();
    }

    function play() {
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(gain);
      node.addEventListener('ended', () => {
        if (source === node) source = null;
        preview.textContent = source ? 'Stop' : 'Preview';
      });
      node.start(0, start, end - start);
      source = node;
      preview.textContent = 'Stop';
    }

    function show(typed) {
      if (!typed) {
        startInput.value = rounded(start).toFixed(2);
        endInput.value = rounded(end).toFixed(2);
      }
      length.textContent = `Keeps ${(end - start).toFixed(2)} s of ${seconds.toFixed(2)} s`;
      save.disabled = !(start >= 2 * STEP || end <= seconds - 2 * STEP) || end - start < SHORTEST;
      stop();
      if (peaks) drawWave(canvas, peaks, seconds, start, end);
    }

    function moveStart(to, typed = false) {
      start = Math.max(0, Math.min(end - SHORTEST, to));
      show(typed);
    }

    function moveEnd(to, typed = false) {
      end = Math.min(seconds, Math.max(start + SHORTEST, to));
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

    const change = async (path, json, result) => {
      problem.hidden = true;
      save.disabled = true;
      try {
        await request(soundPath(sound.name, path), { method: 'POST', ...(json && { json }) });
        outcome = result;
        node.close();
      } catch (err) {
        problem.textContent = err.message;
        problem.hidden = false;
        show(false);
      }
    };

    const node = openDialog(main, {
      title: `Trim ${sound.name}`,
      body: [
        el('p', {}, 'Drag either end of the waveform to choose what to keep.'),
        sound.onDiscord && el('p', {}, 'The copy on Discord’s soundboard stays as it is. Untick and retick On Discord to send the new version.'),
        canvas,
        status,
        problem,
        el('div', { className: 'trim-times' }, el('label', { className: 'start' }, 'Start', startInput), el('label', { className: 'start' }, 'End', endInput), length),
      ],
      start: [preview, sound.trimmed && el('button', { type: 'button', onclick: () => change('/restore', null, 'restored') }, 'Restore original')],
      actions: [save],
      close: 'Cancel',
      noValidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        if (!save.disabled) void change('/trim', { start, end }, 'trimmed');
      },
    });
    node.addEventListener('close', () => {
      stop();
      void context.close();
      resolve(outcome);
    });

    show(false);
    if (sound.seconds === null) return;
    void (async () => {
      try {
        ({ buffer, peaks } = await loadWave(context, sound, canvas));
        status.hidden = true;
        preview.disabled = false;
        show(false);
      } catch {
        // The browser can't read every format the bot can, and typed times still work
        status.textContent = 'This browser can’t draw this sound, but you can still type a start and end.';
      }
    })();
  });
}
