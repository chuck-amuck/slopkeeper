import { api, attempt, el, fetchAudio, icon, notice, pageSignal, player, recall, remember, request, RequestError, settingLink, soundPath, state, toast } from './lib.js';
import { keepLineDialog } from './speechsound.js';
import { matching, withPicked } from './mentions.js';

// Chat tried here: the bot's real answer, as if asked in a channel, with nothing done in Discord. What it would have
// said in voice, and the sounds and lines it would have played, play in this browser

const SPEAK_KEY = 'try-chat:speak';
const CHANNEL_KEY = 'try-chat:channel';
/** The profile being tried in a server, here or from Settings' Try, for as long as the browser tab is open */
const profileKey = (guildId) => `try-chat:profile:${guildId}`;
export function tryProfile(guildId, id) {
  try {
    if (id) sessionStorage.setItem(profileKey(guildId), id);
    else sessionStorage.removeItem(profileKey(guildId));
  } catch {}
}
function triedProfile(guildId) {
  try {
    return sessionStorage.getItem(profileKey(guildId));
  } catch {
    return null;
  }
}
// As many lines as the bot sees before a message, so a long conversation sends no more than it would read
const MOST_SENT = 20;
// A preview asked for too soon after another waits this long, once
const PREVIEW_WAIT_MS = 2_100;

/** The conversation so far in this tab, kept until it's cleared or the tab is closed */
const saved = (guildId) => `try-chat:${guildId}`;
function loadLines(guildId) {
  try {
    const lines = JSON.parse(sessionStorage.getItem(saved(guildId)) ?? '[]');
    return Array.isArray(lines) ? lines : [];
  } catch {
    return [];
  }
}
function saveLines(guildId, lines) {
  try {
    sessionStorage.setItem(saved(guildId), JSON.stringify(lines.slice(-MOST_SENT * 2)));
  } catch {}
}

/** An answer's text with Discord's markup shown as it would be: names for mentions, links, small print, bold */
function rich(text, setup) {
  const nameOf = (id) => setup.members.find((m) => m.id === id)?.name ?? 'someone';
  const channelOf = (id) => setup.channels.find((c) => c.id === id)?.name ?? 'a channel';
  const INLINE = /<@!?(\w+)>|<#(\d+)>|<\/([\w -]+):\d+>|<a?:(\w+):\d+>|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+)|\*\*([^*]+)\*\*/g;
  const inline = (line) => {
    const parts = [];
    let at = 0;
    for (const m of line.matchAll(INLINE)) {
      if (m.index > at) parts.push(line.slice(at, m.index));
      const [, user, channel, command, emoji, linkText, linkUrl, bare, bold] = m;
      if (user) parts.push(el('span', { className: 'mention' }, `@${nameOf(user)}`));
      else if (channel) parts.push(el('span', { className: 'mention' }, `#${channelOf(channel)}`));
      else if (command) parts.push(el('span', { className: 'mention' }, `/${command}`));
      else if (emoji) parts.push(`:${emoji}:`);
      else if (linkUrl) parts.push(el('a', { href: linkUrl, target: '_blank', rel: 'noopener noreferrer' }, linkText));
      else if (bare) parts.push(el('a', { href: bare, target: '_blank', rel: 'noopener noreferrer' }, bare));
      else if (bold) parts.push(el('strong', {}, bold));
      at = m.index + m[0].length;
    }
    if (at < line.length) parts.push(line.slice(at));
    return parts;
  };
  return text.split('\n').map((line) => (line.startsWith('-# ') ? el('p', { className: 'small-print' }, inline(line.slice(3))) : el('p', {}, inline(line))));
}

const cents = (dollars) => (dollars < 0.001 ? 'under a tenth of a cent' : dollars < 0.01 ? `${(dollars * 100).toFixed(1)}¢` : `$${dollars.toFixed(2)}`);

/** Plays `url` through the page's player, and waits until it's done or stopped */
async function playThrough(url, name, loudness = 1) {
  await player.toggle(url, name, loudness);
  const audio = player.name === name ? player.audio : null;
  if (!audio || audio.ended) return;
  await new Promise((done) => {
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('pause', done, { once: true });
  });
}

/** A line in a voice, as the bot would say it, as a URL to play: asked again once if previews were asked for too fast */
async function speechUrl(line) {
  const ask = () => fetchAudio(api('/chat-try/speech'), { text: line.text, voice: line.voice, effect: line.effect });
  try {
    return await ask();
  } catch (err) {
    if (!(err instanceof RequestError) || err.status !== 429) throw err;
    await new Promise((wait) => setTimeout(wait, PREVIEW_WAIT_MS));
    return ask();
  }
}

export function renderChat(main) {
  const guildId = state.guildId;
  const body = el('div', { className: 'try-chat-page' }, notice('loading', 'Loading…'));
  main.append(body);
  void (async () => {
    let setup;
    try {
      setup = await request(api('/chat-try'));
    } catch (err) {
      body.replaceChildren(notice('error', err instanceof RequestError ? err.message : 'Couldn’t load chat.'));
      return;
    }
    if (state.guildId !== guildId || !body.isConnected) return;
    body.replaceChildren();
    draw(body, setup, guildId);
  })();
}

function draw(body, setup, guildId) {
  if (!setup.ready) return body.append(notice('empty', setup.note));
  if (!setup.members.length || !setup.channels.length) return body.append(notice('empty', 'The bot can’t see any members or text channels here yet.'));
  const lines = loadLines(guildId);
  // A new answer, or leaving the page, stops what's playing from the last
  let playing = 0;
  pageSignal().addEventListener('abort', () => {
    playing++;
    player.stop();
  });

  const asWho = el(
    'select',
    { ariaLabel: 'Ask as' },
    setup.members.map((m) => el('option', { value: m.id }, m.name)),
  );
  asWho.value = setup.members.some((m) => m.id === setup.me) ? setup.me : setup.members[0].id;
  const inChannel = el(
    'select',
    { ariaLabel: 'In channel', onchange: () => remember(CHANNEL_KEY, inChannel.value) },
    setup.channels.map((c) => el('option', { value: c.id }, `#${c.name}`)),
  );
  const kept = recall(CHANNEL_KEY);
  if (setup.channels.some((c) => c.id === kept)) inChannel.value = kept;
  // Answers as the server's profile, or another to try before picking it
  const profiles = setup.profiles ?? [];
  const inUse = profiles.find((p) => p.active);
  const asProfile = el(
    'select',
    { ariaLabel: 'Profile', onchange: () => (tryProfile(guildId, asProfile.value === inUse?.id ? null : asProfile.value), showProfile()) },
    profiles.map((p) => el('option', { value: p.id }, p.name)),
  );
  const keptProfile = triedProfile(guildId);
  if (inUse) asProfile.value = profiles.some((p) => p.id === keptProfile) ? keptProfile : inUse.id;
  const profileNote = el('p', { className: 'page-note', id: 'try-profile-note' });
  const tried = () => profiles.find((p) => p.id === asProfile.value);
  function showProfile() {
    const other = tried() && inUse && tried().id !== inUse.id;
    profileNote.hidden = !other;
    profileNote.textContent = other ? `Trying as ${tried().name}, answering as ${tried().botName}. This server uses ${inUse.name}.` : '';
  }
  showProfile();
  const speak = el('input', { type: 'checkbox', checked: recall(SPEAK_KEY) !== 'off', onchange: () => remember(SPEAK_KEY, speak.checked ? 'on' : 'off') });
  // In the conversation's corner, as it empties that and nothing else: who's asking, where and the profile stay
  const startOver = el(
    'button',
    {
      type: 'button',
      className: 'quiet with-icon',
      onclick: () => {
        playing++;
        player.stop();
        lines.length = 0;
        saveLines(guildId, lines);
        paint();
        text.focus();
      },
    },
    icon('refresh'),
    el('span', {}, 'Start over'),
  );
  const log = el('div', { className: 'try-chat', role: 'log', ariaLive: 'polite', ariaLabel: 'Conversation' });
  const chatHead = el('div', { className: 'try-chat-head' }, startOver);
  // Kept up to date by each answer, as Answer in voice may change while the page is open
  const inDiscordNote = el('span', {}, setup.inDiscord);
  // The @ list, as in Discord: who's been picked, by the name put in for them, and who it shows for what's typed
  const picked = new Map();
  const picker = el('div', { className: 'mention-picker', role: 'listbox', id: 'try-mentions', ariaLabel: 'Members' });
  picker.hidden = true;
  let choices = [];
  let chosen = 0;
  // Where the @ and what's typed after it are in the box
  let typing = null;
  const text = el('textarea', {
    rows: 2,
    maxLength: 2000,
    ariaLabel: 'Ask the bot',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-controls': 'try-mentions',
    'aria-expanded': 'false',
    placeholder: 'Ask something, like “roast @Sam” or “what should we play?”',
    onkeydown: (e) => {
      if (!picker.hidden && !e.isComposing) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          chosen = (chosen + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
          return mark();
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
          e.preventDefault();
          return pick(chosen);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          return closePicker();
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    },
    oninput: () => lookForAt(),
    // The caret moved
    onclick: () => lookForAt(),
    onkeyup: (e) => ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && lookForAt(),
    onblur: () => closePicker(),
  });
  const send = el('button', { className: 'primary', type: 'submit' }, 'Ask');
  const form = el('form', { className: 'try-ask', onsubmit: (e) => (e.preventDefault(), void ask()) }, picker, text, send);

  /** Opens the @ list on who could be meant by what's typed after an @ just before the caret, or closes it */
  function lookForAt() {
    const caret = text.selectionStart;
    const at = caret === text.selectionEnd && /(?:^|[^\p{L}\p{N}_])@([^@\n]{0,32})$/u.exec(text.value.slice(0, caret));
    const query = at ? at[1] : null;
    // Not straight after an @ with a space, nor after one just picked
    if (query === null || query.startsWith(' ') || (query.endsWith(' ') && picked.has(query.trimEnd()))) return closePicker();
    choices = matching(setup.members, query);
    if (!choices.length) return closePicker();
    typing = { start: caret - query.length - 1, end: caret };
    chosen = 0;
    picker.replaceChildren(
      ...choices.map((m, i) =>
        el(
          'div',
          {
            className: 'mention-choice',
            role: 'option',
            id: `try-mention-${i}`,
            // Keeps the box focused, so the list stays open to be clicked
            onmousedown: (e) => e.preventDefault(),
            onclick: () => pick(i),
            onmousemove: () => chosen !== i && ((chosen = i), mark()),
          },
          m.avatar ? el('img', { className: 'mention-avatar', src: m.avatar, alt: '', width: 24, height: 24 }) : el('span', { className: 'mention-avatar', ariaHidden: 'true' }, [...m.name][0]?.toUpperCase() ?? '?'),
          el('span', { className: 'mention-name' }, m.name),
          m.username && m.username.toLowerCase() !== m.name.toLowerCase() ? el('span', { className: 'mention-user' }, m.username) : '',
        ),
      ),
    );
    picker.hidden = false;
    text.setAttribute('aria-expanded', 'true');
    mark();
  }

  function mark() {
    for (const [i, node] of [...picker.children].entries()) node.setAttribute('aria-selected', String(i === chosen));
    text.setAttribute('aria-activedescendant', `try-mention-${chosen}`);
    picker.children[chosen]?.scrollIntoView({ block: 'nearest' });
  }

  function closePicker() {
    if (picker.hidden) return;
    picker.hidden = true;
    choices = [];
    typing = null;
    text.setAttribute('aria-expanded', 'false');
    text.removeAttribute('aria-activedescendant');
  }

  /** Puts in the one picked, by their name here, or their username when someone else has the same name */
  function pick(i) {
    const m = choices[i];
    if (!m || !typing) return;
    const shared = setup.members.some((o) => o.id !== m.id && o.name.toLowerCase() === m.name.toLowerCase());
    const name = shared && m.username ? m.username : m.name;
    text.setRangeText(`@${name} `, typing.start, typing.end, 'end');
    picked.set(name, m.id);
    closePicker();
    text.focus();
  }

  body.append(
    setup.chatOn ? '' : notice('empty', 'Chat is off in ', settingLink('chat', 'this server’s settings'), ', so the bot doesn’t answer in Discord. It still answers here, to try it first.', { compact: true }),
    el(
      'div',
      { className: 'toolbar try-options' },
      el('label', {}, el('span', { className: 'voice-label' }, 'Ask as'), asWho),
      el('label', {}, el('span', { className: 'voice-label' }, 'In'), inChannel),
      profiles.length > 1 ? el('label', {}, el('span', { className: 'voice-label' }, 'Profile'), asProfile) : '',
      setup.speech ? el('label', { className: 'check' }, speak, 'Say answers aloud') : '',
    ),
    // Once, for every answer: what trying it does, and what the same answer does in Discord
    el('p', { className: 'page-note' }, 'Answers here do nothing in Discord, but each costs about what one there does. ', inDiscordNote),
    profileNote,
    el('div', { className: 'try-chat-box' }, chatHead, log),
    form,
  );
  paint();

  function paint() {
    chatHead.hidden = !lines.length;
    log.replaceChildren(...(lines.length ? lines.map(bubble) : [el('p', { className: 'empty-text' }, 'Nothing asked yet.')]));
    log.scrollTop = log.scrollHeight;
  }

  function bubble(line) {
    const asker = setup.members.find((m) => m.id === line.as)?.name ?? 'someone';
    if (line.from === 'you') return el('div', { className: 'try-line you' }, el('div', { className: 'try-who' }, asker), el('div', { className: 'try-text' }, rich(line.text, setup)));
    if (line.pending) return el('div', { className: 'try-line bot', ariaBusy: 'true' }, el('div', { className: 'try-who' }, tried()?.botName ?? setup.botName), el('div', { className: 'try-text muted' }, 'Thinking…'));
    const r = line.result;
    const details = [];
    if (r.pings.length) details.push(el('li', {}, 'Would ping ', r.pings.map((p, i) => [i ? ', ' : '', el('span', { className: 'mention' }, `@${p.name}`)])));
    for (const w of r.would) details.push(el('li', {}, `Would ${w.charAt(0).toLowerCase()}${w.slice(1)}`));
    if (r.looked.length) details.push(el('li', { className: 'muted' }, `Looked up: ${r.looked.join('; ')}`));
    if (r.quiet) details.push(el('li', { className: 'muted' }, r.quiet));
    details.push(el('li', { className: 'muted' }, `${r.model} · ${r.seconds} s · ${cents(r.cost)}`));
    const sounds = [...r.heard, ...(r.aloud ? [r.aloud] : [])];
    const again = sounds.length
      ? el('button', { type: 'button', className: 'quiet', onclick: () => void hear(sounds) }, icon('headphones'), r.aloud ? 'Hear it' : 'Hear what it played')
      : '';
    // What it said, or the last of the lines it said, kept as a sound in its voice and effect
    const spoken = sounds.findLast((s) => s.kind === 'speech');
    const keep = spoken
      ? el('button', { type: 'button', className: 'quiet', title: 'Keep what it said as a sound, in its voice and effect', onclick: (e) => void keepSpoken(e.currentTarget, spoken) }, icon('plus'), 'Add to soundboard')
      : '';
    return el(
      'div',
      { className: 'try-line bot' },
      // As the profile it answered as was called
      el('div', { className: 'try-who' }, r.botName ?? setup.botName),
      el('div', { className: 'try-text' }, r.answer ? rich(r.answer, setup) : el('span', { className: 'muted' }, 'It didn’t answer.')),
      el('ul', { className: 'try-details' }, details),
      again || keep ? el('div', { className: 'try-actions' }, again, keep) : '',
    );
  }

  async function keepSpoken(button, spoken) {
    if (button.ariaBusy) return;
    button.ariaBusy = 'true';
    try {
      await attempt(() => keepLineDialog(button.ownerDocument.body, spoken));
    } finally {
      button.ariaBusy = null;
    }
  }

  /** Plays what it would have played or said, in order, until something newer starts */
  async function hear(sounds) {
    const turn = ++playing;
    player.stop();
    try {
      for (const [i, s] of sounds.entries()) {
        if (turn !== playing) return;
        const url = s.kind === 'sound' ? soundPath(s.name, '/audio') : await speechUrl(s);
        if (turn !== playing) return;
        await playThrough(url, `try:${turn}:${i}`, s.kind === 'sound' ? s.loudness : 1);
      }
    } catch (err) {
      toast(err instanceof RequestError ? err.message : 'Couldn’t play that here.', true);
    }
  }

  async function ask() {
    const typed = text.value.trim();
    if (!typed || send.disabled) return;
    closePicker();
    // Sent with the people picked as their mentions, and those picks kept to put back if it fails
    const picks = new Map(picked);
    picked.clear();
    const asked = withPicked(typed, picks);
    playing++;
    player.stop();
    const history = lines
      .filter((l) => !l.pending && (l.from === 'you' || l.result.answer))
      .slice(-MOST_SENT)
      .map((l) => ({ from: l.from, text: l.from === 'you' ? l.text : l.result.answer, at: l.at, ...(l.as && { as: l.as }) }));
    const mine = { from: 'you', text: asked, at: Date.now(), as: asWho.value };
    const waiting = { from: 'bot', pending: true, at: Date.now() };
    lines.push(mine, waiting);
    text.value = '';
    send.disabled = true;
    paint();
    try {
      const result = await request(api('/chat-try'), { method: 'POST', wait: 'chat', json: { text: asked, as: asWho.value, channelId: inChannel.value, history, ...(asProfile.value && { profile: asProfile.value }) } });
      // Cleared while it was coming: the answer goes with what it answered
      if (!lines.includes(waiting)) return;
      if (result.inDiscord) inDiscordNote.textContent = result.inDiscord;
      lines.splice(lines.indexOf(waiting), 1, { from: 'bot', at: Date.now(), result });
      saveLines(guildId, lines);
      if (!body.isConnected) return;
      paint();
      const sounds = [...result.heard, ...(result.aloud && speak.checked ? [result.aloud] : [])];
      if (sounds.length) void hear(sounds);
    } catch (err) {
      // What was asked goes back in the box, to ask again
      if (lines.includes(mine)) lines.splice(lines.indexOf(mine), 2);
      if (!text.value) {
        text.value = typed;
        for (const [name, id] of picks) picked.set(name, id);
      }
      if (body.isConnected) paint();
      toast(err instanceof RequestError ? err.message : 'Couldn’t ask the bot.', true);
    } finally {
      send.disabled = false;
      if (body.isConnected) text.focus();
    }
  }
}
