import { api, attempt, el, forget, icon, pageSignal, recall, remember, request, state, toast, undoToast } from './lib.js';
import { foldHead, searchKeys, soundGrid } from './soundgrid.js';
import { previewButton, showPicked, voiceOptions } from './speech.js';
import { voiceBar } from './voice.js';

// Whether Speech is folded away, on this device
const SPEECH_FOLDED = 'speechFolded';

/**
 * Has the bot read out what's typed: one row for the line, the voice with a preview only you hear, and Say, then the
 * saved lines. Folds away to its heading, remembered on this device, and stays hidden if there's no voice to read it
 */
function sayBox(voice) {
  const guildId = state.guildId;
  const voiceKey = `voice:${guildId}`;
  const text = el('input', { ariaLabel: 'What to say', placeholder: 'Say something', autocomplete: 'off', enterKeyHint: 'send' });
  const picker = el('select', { ariaLabel: 'Voice', className: 'say-voice', onchange: () => remember(voiceKey, picker.value) });
  const send = el('button', { className: 'primary say-send' }, 'Say');
  let saying = false;
  const preview = previewButton(picker, text);
  // Back from the pop-out, where the voice may have been changed meanwhile
  addEventListener('focus', () => showPicked(picker, recall(voiceKey)), { signal: pageSignal() });
  const chips = el('div', { className: 'phrase-list' });
  const saveLine = el('button', { type: 'button', className: 'icon save-line', ariaLabel: 'Save this line', title: 'Save this line, to say it again with one tap', hidden: true, onclick: () => saveTyped() }, icon('plus'));
  const editLines = el('button', { type: 'button', className: 'quiet', ariaPressed: 'false', hidden: true, onclick: () => setEditing(!editing) }, 'Edit');
  // On a phone the saved lines scroll sideways, so the sounds stay near the top; All unfolds them
  const scroller = el('div', { className: 'phrase-scroll' }, chips, editLines);
  const allLines = el('button', { type: 'button', className: 'quiet all-lines', ariaExpanded: 'false', hidden: true, onclick: () => setUnfolded(!unfolded) }, 'All');
  const row = el('div', { className: 'phrases' }, scroller, allLines);
  let phrases = [];
  let editing = false;
  let unfolded = false;

  const paint = () => {
    const channel = voice.channel();
    const title = channel ? `Say in ${channel.name}` : 'Nobody’s in voice';
    send.disabled = !channel || saying;
    send.title = title;
    for (const button of chips.querySelectorAll('.phrase-say')) {
      button.disabled = !channel;
      button.title = channel ? `${button.textContent}\n${title}` : title;
    }
  };
  const setEditing = (on) => {
    editing = on;
    editLines.textContent = on ? 'Done' : 'Edit';
    editLines.ariaPressed = String(on);
    row.classList.toggle('editing', on);
    allLines.hidden = on || !phrases.length;
  };
  const setUnfolded = (on) => {
    unfolded = on;
    allLines.textContent = on ? 'Fewer' : 'All';
    allLines.ariaExpanded = String(on);
    row.classList.toggle('unfolded', on);
    // Unfolded, it ends the lines rather than holding a column beside them
    if (on) scroller.append(allLines);
    else row.append(allLines);
    allLines.focus();
  };
  /** Says a saved line, ignoring taps while it's on its way so a double tap doesn't hit the wait between lines */
  const sayPhrase = (button, phrase) => {
    if (button.ariaBusy) return;
    button.ariaBusy = 'true';
    void attempt(() => voice.say(phrase.text, picker.value)).finally(() => (button.ariaBusy = null));
  };
  const paintPhrases = () => {
    chips.replaceChildren(
      ...phrases.map((phrase) => {
        const say = el('button', { className: 'phrase-say', onclick: () => sayPhrase(say, phrase) }, phrase.text);
        return el(
          'span',
          { className: 'phrase' },
          say,
          el(
            'button',
            {
              className: 'phrase-remove',
              ariaLabel: `Remove “${phrase.text}”`,
              title: 'Remove',
              onclick: () =>
                void attempt(async () => {
                  remembered((await request(api(`/phrases/${phrase.id}`), { method: 'DELETE' })).phrases);
                  undoToast(`Removed “${phrase.text}”.`, async () => remembered((await request(api('/phrases'), { method: 'POST', json: { text: phrase.text } })).phrases));
                }),
            },
            icon('x'),
          ),
        );
      }),
    );
    allLines.hidden = editing || !phrases.length;
    editLines.hidden = !phrases.length;
    row.hidden = !phrases.length;
    if (!phrases.length) setEditing(false);
    paint();
  };
  const remembered = (saved) => {
    phrases = saved;
    paintPhrases();
  };
  const saveTyped = () => {
    const line = text.value.trim();
    if (!line) return;
    void attempt(async () => {
      remembered((await request(api('/phrases'), { method: 'POST', json: { text: line } })).phrases);
      text.value = '';
      saveLine.hidden = true;
      toast('Saved the line. Tap it to say it.');
    });
  };
  text.addEventListener('input', () => (saveLine.hidden = !text.value.trim()));

  const form = el(
    'form',
    {
      className: 'say-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const line = text.value.trim();
        if (send.disabled || !line) return;
        // The box clears straight away, as the bot only answers once the line starts, which can take a while
        saying = true;
        send.textContent = 'Saying…';
        text.value = '';
        saveLine.hidden = true;
        paint();
        const sent = await attempt(async () => {
          await voice.say(line, picker.value);
          return true;
        });
        // Back in the box to try again, unless something new was typed meanwhile
        if (!sent && !text.value) {
          text.value = line;
          saveLine.hidden = false;
        }
        saying = false;
        send.textContent = 'Say';
        paint();
      },
    },
    el('div', { className: 'say-text' }, text, saveLine),
    // The voice is a choice for the line being sent, so it sits with Say
    el('div', { className: 'say-voices' }, picker, preview),
    send,
  );
  const body = el('div', { className: 'say-body' }, form, row);
  const head = foldHead('Speech', recall(SPEECH_FOLDED) !== '1', body, (open) => (open ? forget(SPEECH_FOLDED) : remember(SPEECH_FOLDED, '1')));
  const node = el('div', { className: 'say-box', hidden: true }, head, body);
  void attempt(async () => {
    const { on, voices, voice: serverDefault, longest, phrases: saved } = await request(api('/say'));
    if (guildId !== state.guildId) return;
    text.maxLength = longest;
    // The voice last used on this device, while the bot still offers it
    const mine = recall(voiceKey);
    picker.replaceChildren(...voiceOptions(voices, voices.some((v) => v.id === mine) ? mine : serverDefault));
    node.hidden = !on;
    remembered(saved);
  });
  return { node, paint };
}

// Wide enough for Speech in a column of its own beside the sounds, as style.css lays it out
const WIDE = '(min-width: 1100px)';

/**
 * Big buttons for playing sounds during a game: the server's groups in their order, then whatever gets played most.
 * Groups are made and sorted in Manage. `openManage` switches to the Soundboard tab's Manage view, where sounds are
 * added. On a wide screen the search goes in `head`, beside Play | Manage
 */
export function renderBoard(main, openManage, head = null) {
  const voice = voiceBar(paint);
  const grid = soundGrid({ voice, stars: true, slash: true, empty: () => ['No sounds yet. ', el('button', { className: 'link', onclick: openManage }, 'Add some in Manage'), '.'] });
  const { searchBox: search, nobody } = grid;
  const say = sayBox(voice);
  // Two columns on a wide screen: the volumes and Speech, which stay put, and the sounds. One above the other otherwise
  const area = el('div', { className: 'board-main' }, search, nobody, grid.node);
  main.classList.add('play-view');
  main.append(el('div', { className: 'board-side' }, voice.node, say.node), area);

  // The search is over the sounds: beside Play | Manage on a wide screen, and just above them otherwise. The tiles are
  // smaller there, so more fit
  const wide = matchMedia(WIDE);
  const placeSearch = () => {
    grid.node.classList.toggle('compact', wide.matches);
    if (wide.matches && head) head.prepend(search);
    else area.prepend(search);
  };
  placeSearch();
  // Play and Manage swap without the page being drawn again, so a board that's been swapped out lets go itself
  const onWide = () => (main.isConnected ? placeSearch() : wide.removeEventListener('change', onWide));
  wide.addEventListener('change', onWide, { signal: pageSignal() });

  // With a keyboard, / goes to the search, and on a wide screen so does just typing. Enter plays the first match
  searchKeys(document, () => search, () => wide.matches, pageSignal());

  function paint() {
    say.paint();
    grid.paint();
  }
}
