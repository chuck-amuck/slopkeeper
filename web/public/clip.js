import { el, openDialog, request, soundPath } from './lib.js';

const HEIGHT = 96;
const BAR = 2;
const GAP = 1;

const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Loudest level in each column of the waveform */
function peaksOf(buffer, columns) {
  const samples = buffer.getChannelData(0);
  const size = Math.max(1, Math.floor(samples.length / columns));
  const peaks = [];
  for (let c = 0; c < columns; c++) {
    let peak = 0;
    const end = Math.min(samples.length, (c + 1) * size);
    // Every sample would be slow for a long sound, and this many still finds the loud parts
    for (let i = c * size; i < end; i += Math.ceil(size / 200)) peak = Math.max(peak, Math.abs(samples[i]));
    peaks.push(peak);
  }
  const loudest = Math.max(...peaks, 0.01);
  return peaks.map((p) => p / loudest);
}

/** Loads a sound into the page. Returns its audio and a waveform that fits the canvas, which has to be showing */
export async function loadWave(context, sound, canvas) {
  const data = await (await fetch(soundPath(sound.name, '/audio'))).arrayBuffer();
  const buffer = await context.decodeAudioData(data);
  canvas.hidden = false;
  return { buffer, peaks: peaksOf(buffer, Math.floor(canvas.clientWidth / (BAR + GAP))) };
}

/** Draws a waveform with the part between two times picked out */
export function drawWave(canvas, peaks, seconds, start, end) {
  const width = canvas.clientWidth;
  const ratio = devicePixelRatio;
  canvas.width = width * ratio;
  canvas.height = HEIGHT * ratio;
  const pen = canvas.getContext('2d');
  pen.scale(ratio, ratio);
  const from = (start / seconds) * width;
  const to = (end / seconds) * width;
  pen.fillStyle = color('--accent');
  pen.globalAlpha = 0.14;
  pen.fillRect(from, 0, to - from, HEIGHT);
  pen.globalAlpha = 1;
  peaks.forEach((peak, c) => {
    const x = c * (BAR + GAP);
    const height = Math.max(2, peak * (HEIGHT - 8));
    pen.fillStyle = color(x >= from && x <= to ? '--accent' : '--wave');
    pen.fillRect(x, (HEIGHT - height) / 2, BAR, height);
  });
  pen.fillStyle = color('--accent');
  pen.fillRect(from, 0, 2, HEIGHT);
  pen.fillRect(to - 2, 0, 2, HEIGHT);
}

/** Long sounds need a part chosen for Discord, as with `/sound discord-add start:`. Resolves once it's added or dismissed */
export function pickClip(main, sound, clipSeconds, replacing) {
  return new Promise((resolve, reject) => {
    const seconds = sound.seconds ?? 0;
    const latest = Math.max(0, Math.floor((seconds - clipSeconds) * 10) / 10);
    const context = new AudioContext();
    let start = 0;
    let buffer = null;
    let peaks = null;
    let source = null;
    let dragging = false;

    const canvas = el('canvas', { className: 'wave', tabIndex: 0, role: 'slider', ariaLabel: 'Clip position', hidden: true });
    const status = el('p', {}, 'Loading the waveform…');
    const startInput = el('input', {
      type: 'number',
      min: 0,
      max: latest,
      step: 0.1,
      value: 0,
      required: true,
      ariaLabel: 'Start second',
      oninput: () => {
        if (Number.isFinite(startInput.valueAsNumber)) move(startInput.valueAsNumber);
      },
    });
    const preview = el('button', { type: 'button', disabled: true, onclick: () => (source ? stop() : play()) }, 'Preview');

    function stop() {
      source?.stop();
    }

    function play() {
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      node.addEventListener('ended', () => {
        if (source === node) source = null;
        preview.textContent = source ? 'Stop' : 'Preview';
      });
      node.start(0, start, clipSeconds);
      source = node;
      preview.textContent = 'Stop';
    }

    function draw() {
      if (peaks) drawWave(canvas, peaks, seconds, start, start + clipSeconds);
    }

    function move(to, fromInput = true) {
      start = Math.min(latest, Math.max(0, Math.round(to * 10) / 10));
      if (!fromInput) startInput.value = start;
      canvas.setAttribute('aria-valuenow', start);
      canvas.setAttribute('aria-valuetext', `${start} to ${(start + clipSeconds).toFixed(1)} seconds`);
      stop();
      draw();
    }

    const centerOn = (e) => {
      const { left, width } = canvas.getBoundingClientRect();
      move(((e.clientX - left) / width) * seconds - clipSeconds / 2, false);
    };

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      centerOn(e);
    });
    canvas.addEventListener('pointermove', (e) => dragging && centerOn(e));
    canvas.addEventListener('pointerup', () => (dragging = false));
    canvas.addEventListener('keydown', (e) => {
      const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
      if (!step) return;
      e.preventDefault();
      move(start + step, false);
    });

    const node = openDialog(
      main,
      el('h2', {}, `Add part of ${sound.name}`),
      el('p', {}, `Discord allows ${clipSeconds} s. Drag across the waveform to choose which part.`),
      canvas,
      status,
      el(
        'form',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await request(soundPath(sound.name, '/discord'), { method: 'PUT', json: { start: startInput.valueAsNumber, replacing } });
              resolve(true);
              node.close();
            } catch (err) {
              node.close();
              reject(err);
            }
          },
        },
        el('label', { className: 'start' }, 'Start at', startInput, 'seconds'),
        el(
          'div',
          { className: 'actions' },
          preview,
          el('button', { type: 'button', onclick: () => node.close() }, 'Cancel'),
          el('button', { className: 'primary', type: 'submit' }, 'Add to Discord'),
        ),
      ),
    );
    node.addEventListener('close', () => {
      stop();
      void context.close();
      resolve();
    });

    void (async () => {
      try {
        ({ buffer, peaks } = await loadWave(context, sound, canvas));
        status.hidden = true;
        preview.disabled = false;
        move(0, false);
      } catch {
        // The browser can't read every format the bot can, and a start second still works
        status.textContent = 'This browser can’t draw this sound, but you can still type a start second.';
      }
    })();
  });
}
