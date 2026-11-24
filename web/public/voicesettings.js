import { api, attempt, confirmButton, el, fetchAudio, formProblem, isNarrow, notice, openDialog, player, repaintOnWidth, request, RequestError, toast, tryShowing, wordOrIcon } from './lib.js';
import { effectOptions, NO_EFFECT } from './speech.js';

// Settings' Voices card: the voices added here for every server on the bot, with export and import

const GROUPS = ['Characters', 'Accents'];
const CURVES = [
  ['character', 'Character (most community voices)'],
  ['default', 'Like the default voices'],
  ['middle', 'Middle'],
  ['low', 'Low quality models'],
];
/** Piper's noise_scale and noise_w_scale: how much the sound and timing vary */
const STEADINESS = [
  ['own', 'The model’s own', null],
  ['steadier', 'Steadier', [0.667, 0.333]],
  ['steadiest', 'Steadiest', [0.333, 0.333]],
];
const PREVIEW_TEXT = 'Hello, this is how I sound.';
// How often the card asks again while a voice downloads
const POLL_MS = 2000;

const row = (label, control, note) => el('label', { className: 'form-row' }, el('span', {}, label), control, note && el('span', { className: 'form-note' }, note));
const select = (options, chosen, props = {}) => el('select', props, options.map(([value, label]) => el('option', { value, selected: value === chosen }, label)));

/** What a voice's download is doing, in words */
function stateText(v) {
  switch (v.state) {
    case 'ready':
      return 'Ready';
    case 'downloading':
      return v.percent ? `Downloading, ${v.percent}%` : 'Downloading';
    case 'waiting':
      return 'Waiting to download';
    case 'failed':
      return `Couldn’t download: ${v.error ?? 'no reason given'}`;
    default:
      return 'Waiting for the voice container';
  }
}

// A voice the container hasn't said anything about isn't asked about again and again: the bot does that
const settled = (v) => v.state !== 'waiting' && v.state !== 'downloading' && !v.tuning;

const curveName = (curve) => CURVES.find(([id]) => id === curve)?.[1] ?? curve;
const dB = (volume) => `${volume > 0 ? '+' : ''}${volume} dB`;
/** Off by more than this, no curve fits it closely (the rule for the built-in voices is about 5%) */
const LOOSE_FIT = 0.05;

/** Plays a voice saying a line with the settings given, just for whoever pressed it. Pressing again stops it */
function preview(voice, settings, line, button) {
  const text = line.trim() || PREVIEW_TEXT;
  return player.preview(button, `voice-preview:${voice.id}:${JSON.stringify(settings)}:${text}`, () => fetchAudio(api(`/voices/${encodeURIComponent(voice.id)}/preview`), { text, ...settings }));
}

export function voicesCard(main) {
  const body = el('div', {}, notice('loading', 'Loading voices…', { compact: true }));
  const message = el('div', { className: 'message', hidden: true });
  let voices = [];
  let timer = null;
  let most = 50;
  let effects = [];

  const say = (text, bad = false) => {
    message.hidden = !text;
    message.textContent = text ?? '';
    message.className = bad ? 'message bad' : 'message';
  };

  async function load() {
    clearTimeout(timer);
    const data = await request(api('/voices'));
    voices = data.voices;
    most = data.most;
    effects = data.effects ?? [];
    // The page's other voice pickers hear of a voice that's ready from the bot
    paint();
    if (voices.some((v) => !settled(v))) timer = setTimeout(() => card.isConnected && void attempt(load), POLL_MS);
  }

  function voiceRow(v) {
    // On a phone each button is its icon, beside the voice rather than in a row under it
    const button = (word, iconName, props) => {
      const { props: shown, content } = wordOrIcon(word, iconName, v.name);
      return el('button', { type: 'button', ...shown, ...props }, content);
    };
    const hear = button('Preview', 'headphones', { disabled: v.state !== 'ready', onclick: () => void attempt(() => preview(v, {}, '', hear)) });
    const remove = wordOrIcon('Remove', 'trash', v.name);
    return el(
      'div',
      { className: `field voice-row${isNarrow() ? ' beside-field' : ''}` },
      el('div', {}, el('div', { className: 'series-name' }, v.name), el('p', { className: `hint${v.state === 'failed' ? ' bad-text' : ''}` }, `${v.group} · ${stateText(v)}${v.tuning ? ', measuring its speed and loudness' : ''}`)),
      el(
        'div',
        { className: 'control' },
        hear,
        button('Edit', 'pencil', { onclick: () => editDialog(v) }),
        confirmButton({ ariaLabel: `Remove ${v.name}`, ...remove.props }, remove.content, 'Remove it?', async () => {
          const { picks, profiles } = await request(api(`/voices/${encodeURIComponent(v.id)}`), { method: 'DELETE' });
          const after = [
            picks && `${picks === 1 ? 'A server that picked it is' : `${picks} servers that picked it are`} back on their default voice.`,
            profiles && `${profiles === 1 ? 'A profile that spoke in it speaks' : `${profiles} profiles that spoke in it speak`} in the server’s default voice now.`,
          ].filter(Boolean);
          toast([`Removed ${v.name}.`, ...after].join(' '));
          await load();
        }),
      ),
    );
  }

  function paint() {
    body.replaceChildren(...(voices.length ? voices.map(voiceRow) : [notice('empty', 'No voices added yet.', { compact: true })]));
    addButton.disabled = voices.length >= most;
  }

  // Adding: a link to the model and a name. The rest is set in Edit once it's downloaded
  const link = el('input', { type: 'url', required: true, placeholder: 'https://huggingface.co/…/voice.onnx', ariaLabel: 'Link to the model’s .onnx file', autocomplete: 'off', spellcheck: false });
  const name = el('input', { required: true, maxLength: 40, placeholder: 'Name', ariaLabel: 'Name', autocomplete: 'off' });
  const group = select(
    GROUPS.map((g) => [g, g]),
    'Characters',
    { ariaLabel: 'Group' },
  );
  const addButton = el('button', { type: 'submit' }, 'Add');
  const adder = el(
    'div',
    { className: 'field' },
    el(
      'div',
      {},
      el('div', { className: 'series-name' }, 'Add a voice'),
      el(
        'p',
        { className: 'hint' },
        'A link to a Piper model’s .onnx file, such as one on ',
        el('a', { href: 'https://huggingface.co/models?other=piper', target: '_blank', rel: 'noreferrer' }, 'Hugging Face'),
        '. Its settings file is found beside it.',
      ),
    ),
    el(
      'form',
      {
        className: 'control stacked',
        onsubmit: (e) => {
          e.preventDefault();
          addButton.disabled = true;
          void attempt(async () => {
            say(null);
            try {
              const { voice } = await request(api('/voices'), { method: 'POST', json: { model: link.value.trim(), name: name.value, group: group.value } });
              toast(`Added ${voice.name}. It shows in the voice lists once it’s downloaded.`);
              link.value = '';
              name.value = '';
              await load();
            } catch (err) {
              if (!(err instanceof RequestError)) throw err;
              say(err.message, true);
            }
          }).finally(() => {
            addButton.disabled = voices.length >= most;
          });
        },
      },
      link,
      name,
      group,
      addButton,
    ),
    message,
  );

  function editDialog(v) {
    const fields = {
      name: el('input', { required: true, maxLength: 40, value: v.name, autocomplete: 'off' }),
      group: select(
        GROUPS.map((g) => [g, g]),
        v.group,
      ),
      model: el('input', { type: 'url', required: true, value: v.model, autocomplete: 'off', spellcheck: false }),
      speaker: v.speakers.length ? select([['', 'The model’s first'], ...v.speakers.map((s) => [String(s.id), `${s.id}: ${s.name}`])], v.speaker === undefined ? '' : String(v.speaker)) : null,
      // As wide as the bot takes, so a voice imported with any value it allows can be saved
      volume: el('input', { type: 'number', min: -20, max: 20, step: 0.1, value: v.volume ?? 0, required: true }),
      pace: el('input', { type: 'number', min: 0.5, max: 2, step: 0.01, value: v.pace ?? 1, required: true }),
      noise: (() => {
        const known = STEADINESS.find(([, , pair]) => JSON.stringify(pair) === JSON.stringify(v.noise ?? null));
        const options = STEADINESS.map(([id, label]) => [id, label]);
        // A list from elsewhere can have its own numbers, kept as they are unless another is picked
        if (!known) options.push(['as-is', `As imported (${v.noise.join(', ')})`]);
        return select(options, known?.[0] ?? 'as-is');
      })(),
      curve: select(CURVES, v.curve ?? 'character'),
    };
    const line = el('input', { placeholder: PREVIEW_TEXT, maxLength: 300, ariaLabel: 'What the preview says', autocomplete: 'off' });
    const problem = formProblem();
    // Use measured puts the measured values in the form and saves the voice as auto, so a new measurement applies too
    let tune;
    const measuredNote = (() => {
      if (v.state !== 'ready') return null;
      if (v.tuning) return el('p', { className: 'form-note' }, 'Measuring its speed curve and loudness…');
      const again = el('button', { type: 'button' }, 'Measure again');
      again.onclick = () =>
        void attempt(async () => {
          await request(api(`/voices/${encodeURIComponent(v.id)}/measure`), { method: 'POST' });
          toast(`Measuring ${v.name} again.`);
          node.close();
          await load();
        });
      if (!v.measured) return el('div', { className: 'form-note measured' }, 'Not measured yet. ', again);
      const m = v.measured;
      const use = el('button', { type: 'button' }, 'Use measured');
      use.onclick = () => {
        fields.volume.value = String(m.volume);
        fields.curve.value = m.curve;
        tune = 'auto';
        use.disabled = true;
      };
      const loose = m.fit > LOOSE_FIT ? ` No curve fits it closely (${Math.round(m.fit * 100)}% off), so check how it sounds.` : '';
      const how = v.tune === 'auto' ? ' It uses these, until you change its loudness or curve.' : '';
      return el(
        'div',
        { className: 'form-note measured' },
        `Measured: ${curveName(m.curve)}, ${dB(m.volume)}.${loose}${how} `,
        v.tune === 'auto' ? null : use,
        again,
      );
    })();
    const settings = () => ({
      // Only once the model's speakers are known: before that, the speaker it has stays
      ...(fields.speaker && { speaker: fields.speaker.value !== '' ? Number(fields.speaker.value) : null }),
      volume: Number(fields.volume.value),
      pace: Number(fields.pace.value),
      noise: fields.noise.value === 'as-is' ? v.noise : (STEADINESS.find(([id]) => id === fields.noise.value)?.[2] ?? null),
      curve: fields.curve.value,
    });
    /**
     * The settings to save. Loudness and curve go only if they were changed here, so a measurement that finished while
     * the dialog was open isn't saved over, and Use measured holds only while they're still what was measured
     */
    const tuning = () => {
      const { volume, curve, ...rest } = settings();
      const m = v.measured;
      if (tune === 'auto' && m && volume === m.volume && curve === m.curve) return { ...rest, tune: 'auto' };
      return { ...rest, ...(volume !== (v.volume ?? 0) && { volume }), ...(curve !== (v.curve ?? 'character') && { curve }) };
    };
    const effect = el('select', { id: 'voice-effect' }, effectOptions(effects, NO_EFFECT));
    const hear = el('button', { type: 'button', disabled: v.state !== 'ready', title: v.state === 'ready' ? 'Hear it with these settings, just for you' : 'Once it’s downloaded' }, 'Preview');
    hear.onclick = () => void tryShowing({ problem }, () => preview(v, { ...settings(), effect: effect.value }, line.value, hear));
    const save = el('button', { type: 'submit', className: 'primary' }, 'Save');
    const node = openDialog(main, {
      title: `Edit ${v.name}`,
      body: [
        row('Name', fields.name),
        row('Group', fields.group),
        row('Link to the model', fields.model, 'A new link downloads it again.'),
        fields.speaker ? row('Speaker', fields.speaker) : v.state === 'ready' ? null : el('p', { className: 'form-note' }, 'If the model has several speakers, they can be picked once it’s downloaded.'),
        measuredNote,
        row('Loudness', fields.volume, 'In dB, to match the other voices, usually between -10 and 5.'),
        row('Pace', fields.pace, 'Above 1 is slower, for a voice that sounds rushed: 1.1 is 10% slower.'),
        row('Steadiness', fields.noise, 'Steadier evens out a voice that wobbles in long lines.'),
        row('Speed curve', fields.curve, 'How its speed follows the speed setting. Character suits most.'),
        row('Preview line', line),
        row('Preview effect', effect, 'Only for hearing it: effects are picked beside the voice when something’s said.'),
        problem,
      ],
      start: [hear],
      actions: [save],
      close: 'Cancel',
      onsubmit: (e) => {
        e.preventDefault();
        void tryShowing({ problem, button: save }, async () => {
          await request(api(`/voices/${encodeURIComponent(v.id)}`), {
            method: 'PUT',
            json: { name: fields.name.value, group: fields.group.value, model: fields.model.value.trim(), ...tuning() },
          });
          toast(`Saved ${fields.name.value.trim()}.`);
          node.close();
          await load();
        });
      },
    });
  }

  /** Shows what an import would do, and does it once it's confirmed */
  function importDialog(list, fileName) {
    const replace = el('input', { type: 'checkbox' });
    const summary = el('div', { className: 'import-summary' });
    const problem = formProblem();
    const go = el('button', { type: 'submit', className: 'primary', disabled: true }, 'Import');
    const part = (title, names, note) => names.length && el('div', {}, el('strong', {}, `${title} (${names.length})`), note && el('span', { className: 'form-note' }, ` ${note}`), el('ul', {}, names.map((n) => el('li', {}, n))));
    let plan = null;
    const check = () =>
      attempt(async () => {
        go.disabled = true;
        problem.hidden = true;
        try {
          plan = await request(api('/voices/import'), { method: 'POST', json: { voices: list, replace: replace.checked } });
        } catch (err) {
          if (!(err instanceof RequestError)) throw err;
          summary.replaceChildren();
          problem.textContent = err.message;
          problem.hidden = false;
          return;
        }
        const changes = plan.added.length + plan.changed.length + plan.removed.length;
        summary.replaceChildren(
          ...[
            part('Added', plan.added),
            part('Changed', plan.changed, 'A new link downloads it again.'),
            part('Removed', plan.removed, 'Servers that picked one go back to their default voice.'),
            part('Already the same', plan.unchanged),
            part(
              'Skipped',
              plan.skipped.map((s) => `${s.what}: ${s.why}`),
            ),
          ].filter(Boolean),
          changes ? '' : el('p', {}, 'There’s nothing to change.'),
        );
        go.disabled = !changes;
      });
    replace.onchange = check;
    const node = openDialog(main, {
      title: `Import ${fileName}`,
      body: [
        el('label', { className: 'merge-row' }, replace, el('span', { className: 'rank-name' }, 'Replace all: remove the added voices this file doesn’t have')),
        summary,
        problem,
      ],
      actions: [go],
      close: 'Cancel',
      onsubmit: (e) => {
        e.preventDefault();
        // Once it's in, there's nothing more to import from this file
        void tryShowing({ problem, button: go, keepDisabled: true }, async () => {
          const done = await request(api('/voices/import'), { method: 'POST', json: { voices: list, replace: replace.checked, dryRun: false } });
          toast(`Imported: ${[`${done.added.length} added`, `${done.changed.length} changed`, replace.checked && `${done.removed.length} removed`].filter(Boolean).join(', ')}.`);
          node.close();
          await load();
        });
      },
    });
    void check();
  }

  const picker = el('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: () => {
      const file = picker.files[0];
      picker.value = '';
      if (!file) return;
      void attempt(async () => {
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          toast(`${file.name} isn’t a JSON file.`, true);
          return;
        }
        // An export file, or a bare list such as CUSTOM_VOICES was
        importDialog(Array.isArray(parsed) ? parsed : parsed?.voices, file.name);
      });
    },
  });

  const card = el(
    'section',
    { className: 'card', id: 'settings-voices' },
    el('h2', {}, 'Voices'),
    el('p', { className: 'card-note' }, 'Voices added here are for every server on this bot. Each downloads once, and shows in the voice lists when it’s ready.'),
    body,
    adder,
    el(
      'div',
      { className: 'card-actions' },
      el(
        'button',
        {
          type: 'button',
          onclick: () => {
            const save = el('a', { href: api('/voices/export'), download: 'slopkeeper-voices.json' });
            document.body.append(save);
            save.click();
            save.remove();
          },
        },
        'Export',
      ),
      el('button', { type: 'button', onclick: () => picker.click() }, 'Import'),
      picker,
    ),
  );
  void attempt(async () => {
    try {
      await load();
    } catch (err) {
      body.replaceChildren(notice('error', err.message, { compact: true }));
      if (!(err instanceof RequestError)) throw err;
    }
  });
  repaintOnWidth(card, paint);
  return card;
}
