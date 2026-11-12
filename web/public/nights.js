import { api, attempt, confirmButton, el, formProblem, notice, openDialog, recall, remember, request, RequestError, state, toast } from './lib.js';

const READ_DELAY_MS = 250;
const WHEN_HINT = 'Try fri 8pm, tomorrow 20:30 or nov 3 7pm.';

function when(ms, timeZone) {
  return new Date(ms).toLocaleString(undefined, { timeZone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** Who's in, maybe and out, as a grid of answer and names */
const answers = (night) =>
  el(
    'dl',
    { className: 'rsvps' },
    ...[
      ['In', night.in],
      ['Maybe', night.maybe],
      ['Can’t', night.out],
    ].flatMap(([label, names]) => [el('dt', {}, `${label} (${names.length})`), el('dd', {}, names.join(', ') || '—')]),
  );

/** Who still needs to add who on Steam before a night. Friends lists come from Steam, so this fills in after the page */
function friendsNote(night) {
  const note = el('div', { hidden: true });
  const person = (p) => el('a', { href: p.url, target: '_blank', rel: 'noreferrer' }, p.name);
  void request(api(`/game-nights/${night.id}/friends`))
    .then(({ strangers, unknown, unlinked }) => {
      const pairs = (list, text) => list.map(([a, b]) => el('p', { className: 'hint' }, person(a), ' and ', person(b), text));
      note.replaceChildren(...pairs(strangers, ' aren’t friends on Steam yet.'), ...pairs(unknown, ': can’t tell, as both friends lists are private.'), ...(unlinked.length ? [el('p', { className: 'hint' }, `Not linked to Steam: ${unlinked.join(', ')}.`)] : []));
      note.hidden = !note.children.length;
    })
    .catch(() => {});
  return note;
}

const row = (label, control, note) => el('label', { className: 'form-row' }, el('span', {}, label), control, note);

function pickOne(options, chosen, props = {}) {
  return el('select', { required: true, ...props }, options.map(([value, label]) => el('option', { value, selected: value === chosen }, label)));
}

/**
 * Plans a night by the same rules as /gamenight plan, asking who's hosting, starting on whoever's signed in. Given a
 * night, changes that one instead, as its card's Edit button does
 */
function planDialog(main, data, onPlanned, night = null) {
  const whenNote = el('span', { className: 'form-note' }, WHEN_HINT);
  let timer;
  let asked = 0;

  function readWhen() {
    clearTimeout(timer);
    const text = when_.value.trim();
    const ask = ++asked;
    if (!text) return (whenNote.textContent = WHEN_HINT);
    timer = setTimeout(async () => {
      const { time } = await request(api(`/game-nights/when?text=${encodeURIComponent(text)}`)).catch(() => ({ time: null }));
      // Typing has moved on if this isn't the latest
      if (ask !== asked) return;
      whenNote.textContent = !time ? `Not sure when that is. ${WHEN_HINT}` : time.passed ? `${time.label} has already passed.` : time.label;
      whenNote.className = !time || time.passed ? 'form-note bad-text' : 'form-note';
    }, READ_DELAY_MS);
  }

  const game = el('input', { required: true, maxLength: 90, list: 'night-games', autocomplete: 'off', value: night?.game ?? '' });
  const when_ = el('input', { required: true, maxLength: 100, autocomplete: 'off', placeholder: 'fri 8pm', oninput: readWhen, value: night?.when ?? '' });
  const channel = pickOne(
    data.channels.map((c) => [c.id, `#${c.name}`]),
    data.defaultChannel,
  );
  const voiceChannel = pickOne([['', 'None'], ...data.voiceChannels.map((c) => [c.id, c.name])], night?.voiceChannelId ?? '', { required: false });
  const host = pickOne(
    data.members.map((m) => [m.id, m.name]),
    state.me?.userId ?? recall('nightHost'),
  );
  const repeat = pickOne([['', 'Just this once'], ['7', 'Every week'], ['14', 'Every 2 weeks']], '', { required: false });
  const details = el('textarea', { maxLength: 1000, rows: 2, value: night?.details ?? '' });
  const submit = el('button', { className: 'primary', type: 'submit' }, night ? 'Save' : 'Plan it');
  // In the dialog, since it would cover a toast
  const problem = formProblem();

  const node = openDialog(main, {
    title: night ? `Edit ${night.game} night` : 'Plan a game night',
    body: [
      el(
        'p',
        {},
        night
          ? 'Changes the card and the Discord event. If the time or voice channel moves, everyone who’s in or maybe is told.'
          : 'Posts the card and a Discord event, and pings anyone following the game, just like /gamenight plan.',
      ),
      el('datalist', { id: 'night-games' }, data.games.map((name) => el('option', { value: name }))),
      row('Game', game),
      row('When', when_, whenNote),
      !night && row('Host', host),
      !night && row('Post in', channel),
      row('Voice channel', voiceChannel),
      !night && row('Repeats', repeat),
      row('Details', details),
      problem,
    ].filter(Boolean),
    actions: [submit],
    close: 'Cancel',
    onsubmit: (e) => {
      e.preventDefault();
      void attempt(async () => {
        submit.disabled = true;
        problem.hidden = true;
        try {
          if (night) {
            const { changed, eventNote } = await request(api(`/game-nights/${night.id}`), {
              method: 'PATCH',
              json: { game: game.value, when: when_.value, voiceChannelId: voiceChannel.value || null, details: details.value.trim() || null },
            });
            toast(changed.length ? `Changed the ${changed.join(', ')}.` : 'Nothing changed.');
            if (eventNote) toast(eventNote, true);
            node.close();
            return await onPlanned();
          }
          const { eventNote } = await request(api('/game-nights'), {
            method: 'POST',
            json: {
              game: game.value,
              when: when_.value,
              channelId: channel.value,
              voiceChannelId: voiceChannel.value || null,
              hostId: host.value,
              details: details.value.trim() || null,
              repeat: repeat.value ? Number(repeat.value) : null,
            },
          });
          remember('nightHost', host.value);
          toast(`${game.value.trim()} night is on.`);
          if (eventNote) toast(eventNote, true);
          node.close();
          await onPlanned();
        } catch (err) {
          if (!(err instanceof RequestError)) throw err;
          problem.textContent = err.message;
          problem.hidden = false;
        } finally {
          submit.disabled = false;
        }
      });
    },
  });
  if (night) readWhen();
  game.focus();
}

export function renderNights(main) {
  const guildId = state.guildId;
  let latest = null;
  const box = el('div', { className: 'stack' }, notice('loading', 'Loading game nights…'));
  const plan = el('button', { className: 'primary', disabled: true, onclick: () => planDialog(main, latest, load) }, 'Plan a game night');
  main.append(el('div', { className: 'toolbar end' }, plan), box);

  async function load() {
    const data = await request(api('/game-nights'));
    if (guildId !== state.guildId || !main.isConnected) return;
    latest = data;
    plan.disabled = !data.channels.length || !data.members.length;
    if (!data.nights.length && !data.series.length) {
      return box.replaceChildren(notice('empty', 'No game nights planned.'));
    }

    const night = (n) =>
      el(
        'section',
        { className: 'card night' },
        el('h2', {}, `${n.game} night`),
        el(
          'div',
          { className: 'night-body' },
          el('div', { className: 'night-when' }, when(n.startsAt, data.timeZone)),
          el('div', { className: 'hint' }, [n.voiceChannel, `Hosted by ${n.host}`, n.repeats].filter(Boolean).join(' · ')),
          n.details && el('p', {}, n.details),
          answers(n),
          n.in.length > 1 && friendsNote(n),
          el(
            'div',
            { className: 'night-actions' },
            el('button', { onclick: () => planDialog(main, data, load, n) }, 'Edit'),
            confirmButton({ ariaLabel: `Cancel ${n.game} night` }, 'Cancel night', 'Cancel it?', async () => {
              await request(api(`/game-nights/${n.id}/cancel`), { method: 'POST' });
              toast(n.in.length ? `${n.game} night is off, and everyone who’s in has been told.` : `${n.game} night is off.`);
              await load();
            }),
          ),
        ),
      );

    const series = (s) =>
      el(
        'div',
        { className: 'field' },
        el('div', {}, el('div', { className: 'series-name' }, `${s.game} night`), el('p', { className: 'hint' }, `${s.repeats}. Next: ${when(s.nextAt, data.timeZone)}. Hosted by ${s.host}.`)),
        el(
          'div',
          { className: 'control' },
          confirmButton({ ariaLabel: `Stop repeating ${s.game} night` }, 'Stop repeating', 'Stop it?', async () => {
            await request(api(`/game-night-series/${s.id}`), { method: 'DELETE' });
            toast(`${s.game} night won’t repeat any more.`);
            await load();
          }),
        ),
      );

    box.replaceChildren(
      ...data.nights.map(night),
      ...(data.series.length
        ? [el('section', { className: 'card' }, el('h2', {}, 'Repeating'), el('p', { className: 'card-note' }, 'Stopping one leaves nights already posted. Cancel those above.'), data.series.map(series))]
        : []),
    );
  }

  void attempt(async () => {
    try {
      await load();
    } catch (err) {
      box.replaceChildren(notice('error', err.message));
      throw err;
    }
  });
}
