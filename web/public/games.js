import { api, attempt, confirmButton, el, openDialog, request, RequestError, state, toast } from './lib.js';

const FILTERS = [
  ['all', 'All games'],
  ['wanted', 'Wanted'],
  ['sale', 'On sale'],
];

const names = (people) => people.map((p) => p.name).join(', ');
const row = (label, control, note) => el('label', { className: 'form-row' }, el('span', {}, label), control, note);
const fact = (label, people) => people.length > 0 && el('div', { className: 'rsvp' }, el('span', { className: 'rsvp-label' }, label), names(people));

const SHOWN_OWNERS = 3;
const SHOWN_GAMES = 100;

function ownerNote(owners) {
  const more = owners.length - SHOWN_OWNERS;
  return owners.slice(0, SHOWN_OWNERS).join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/** Picks from what members own on Steam, or adds what's typed. The box does both, so a game that isn't listed is one Enter away */
function addDialog(main, onAdded) {
  let owned = null;
  const name = el('input', { required: true, maxLength: 200, autocomplete: 'off', placeholder: 'Search, or type a name or Steam link', ariaLabel: 'Search, or type a name or Steam link', oninput: () => paint() });
  const submit = el('button', { className: 'primary', type: 'submit' }, 'Add it');
  const problem = el('div', { className: 'bad-text plan-problem', hidden: true });
  const added = el('div', { className: 'form-note', hidden: true });
  const list = el('div', { className: 'merge-list' }, el('p', {}, 'Loading members’ games…'));

  const say = (node, text) => {
    node.textContent = text ?? '';
    node.hidden = !text;
  };

  const pick = (game, button) =>
    attempt(async () => {
      button.disabled = true;
      say(problem, null);
      try {
        const { name: title } = await request(api('/games'), { method: 'POST', json: { appid: game.appid } });
        // Stays open, as a few games are often added in one go
        owned = owned.filter((g) => g !== game);
        say(added, `${title} is in the library.`);
        paint();
        await onAdded();
      } catch (err) {
        if (!(err instanceof RequestError)) throw err;
        say(problem, err.message);
        button.disabled = false;
      }
    });

  const gameRow = (game) => {
    const add = el('button', { type: 'button', ariaLabel: `Add ${game.name}`, onclick: () => pick(game, add) }, 'Add');
    return el('div', { className: 'owned-game' }, el('span', { className: 'rank-name' }, game.name), add, el('span', { className: 'rank-note' }, ownerNote(game.owners)));
  };

  function paint() {
    if (!owned) return;
    const query = name.value.trim().toLowerCase();
    const shown = owned.filter((g) => g.name.toLowerCase().includes(query));
    list.replaceChildren(...shown.slice(0, SHOWN_GAMES).map(gameRow));
    if (!owned.length) list.append(el('p', {}, 'No games to pick from. Linked Steam libraries show up here.'));
    else if (!shown.length) list.append(el('p', {}, 'Nobody here owns a game called that on Steam. You can still add it.'));
    else if (shown.length > SHOWN_GAMES) list.append(el('p', {}, `Showing ${SHOWN_GAMES} of ${shown.length}. Search to find the rest.`));
  }

  const node = openDialog(
    main,
    el('h2', {}, 'Add a game'),
    el('p', {}, 'Pick from what members own on Steam, or add anything else by name or store link. Private Steam libraries aren’t listed.'),
    el(
      'form',
      {
        className: 'plan',
        onsubmit: (e) => {
          e.preventDefault();
          void attempt(async () => {
            submit.disabled = true;
            say(problem, null);
            try {
              const { name: title, added: isNew } = await request(api('/games'), { method: 'POST', json: { name: name.value } });
              toast(isNew ? `${title} is in the library.` : `${title} was already in the library.`);
              node.close();
              await onAdded();
            } catch (err) {
              if (!(err instanceof RequestError)) throw err;
              say(problem, err.message);
            } finally {
              submit.disabled = false;
            }
          });
        },
      },
      name,
      list,
      added,
      problem,
      el('div', { className: 'actions' }, el('button', { type: 'button', onclick: () => node.close() }, 'Close'), submit),
    ),
  );
  name.focus();
  void request(api('/games/owned')).then(
    ({ games }) => {
      owned = games;
      paint();
    },
    (err) => list.replaceChildren(el('p', {}, err.message)),
  );
}

/** The page doesn't know who's using it, so everyone's marks are here, and anyone can change them */
function manageDialog(main, gameId, data, reload) {
  const find = () => data().games.find((g) => g.id === gameId);
  const start = find();
  const problem = el('div', { className: 'bad-text plan-problem', hidden: true });
  const say = (text) => {
    problem.textContent = text ?? '';
    problem.hidden = !text;
  };
  const guarded = async (action) => {
    say(null);
    try {
      await action();
    } catch (err) {
      if (!(err instanceof RequestError)) throw err;
      say(err.message);
    }
  };

  const limit = el('input', { type: 'number', min: 1, max: 100, step: 1, placeholder: 'No limit', value: start.maxPlayers ?? '' });
  const steam = el('input', { maxLength: 200, autocomplete: 'off', placeholder: 'Store link or app ID', value: start.url ?? '' });
  const save = el('button', { type: 'submit' }, 'Save');
  const search = el('input', { type: 'search', placeholder: 'Search people', ariaLabel: 'Search people', oninput: () => paint() });
  const list = el('div', { className: 'merge-list' });

  function mark(member, field, on) {
    return attempt(() =>
      guarded(async () => {
        await request(api(`/games/${gameId}/members/${member.id}`), { method: 'PATCH', json: { [field]: on } });
        await reload();
      }).finally(paint),
    );
  }

  function memberRow(game, member) {
    const owner = game.owners.find((o) => o.id === member.id);
    const owns = !!owner;
    return el(
      'div',
      { className: 'game-member' },
      el('span', { className: 'rank-name' }, member.name),
      owner?.steam && el('span', { className: 'rank-note' }, 'On Steam'),
      el(
        'label',
        { className: 'game-mark' },
        el('input', { type: 'checkbox', checked: owns, disabled: !!owner?.steam, ariaLabel: `${member.name} owns ${game.name}`, onchange: (e) => mark(member, 'owns', e.target.checked) }),
        'Owns',
      ),
      el(
        'label',
        { className: 'game-mark' },
        el('input', {
          type: 'checkbox',
          checked: game.wanted.some((w) => w.id === member.id),
          disabled: owns || game.appid === null,
          ariaLabel: `${member.name} wants ${game.name}`,
          onchange: (e) => mark(member, 'wants', e.target.checked),
        }),
        'Wants',
      ),
    );
  }

  function paint() {
    const game = find();
    if (!game) return;
    const query = search.value.trim().toLowerCase();
    const shown = data().members.filter((m) => m.name.toLowerCase().includes(query));
    list.replaceChildren(...shown.map((m) => memberRow(game, m)));
    if (!shown.length) list.append(el('p', {}, 'Nobody matches that.'));
  }

  const node = openDialog(
    main,
    el('h2', {}, start.name),
    el(
      'form',
      {
        className: 'plan',
        onsubmit: (e) => {
          e.preventDefault();
          void attempt(() =>
            guarded(async () => {
              await request(api(`/games/${gameId}`), { method: 'PATCH', json: { maxPlayers: limit.value ? Number(limit.value) : null, steam: steam.value } });
              toast(`${start.name} saved.`);
              await reload();
              paint();
            }),
          );
        },
      },
      row('Player limit', limit),
      row('Steam link', steam),
      el('div', { className: 'actions' }, save),
    ),
    el('h3', {}, 'Who has it'),
    search,
    list,
    problem,
    el(
      'div',
      { className: 'actions' },
      confirmButton({ ariaLabel: `Remove ${start.name}` }, 'Remove game', 'Remove it?', async () => {
        await request(api(`/games/${gameId}`), { method: 'DELETE' });
        toast(`${start.name} is out of the library.`);
        node.close();
        await reload();
      }),
      el('button', { type: 'button', onclick: () => node.close() }, 'Close'),
    ),
  );
  paint();
}

export function renderGames(main) {
  const guildId = state.guildId;
  let data = null;
  let filter = 'all';
  let query = '';

  const box = el('div', { className: 'stack' }, el('div', { className: 'empty' }, 'Loading games…'));
  const search = el('input', {
    type: 'search',
    placeholder: 'Search games',
    ariaLabel: 'Search games',
    oninput: (e) => {
      query = e.target.value.trim().toLowerCase();
      paint();
    },
  });
  const picker = el(
    'select',
    {
      ariaLabel: 'Show',
      onchange: (e) => {
        filter = e.target.value;
        paint();
      },
    },
    FILTERS.map(([id, label]) => el('option', { value: id }, label)),
  );
  const add = el('button', { className: 'primary', onclick: () => addDialog(main, load) }, 'Add a game');
  main.append(el('div', { className: 'toolbar' }, search, picker, add), box);

  const gameRow = (g) =>
    el(
      'div',
      { className: 'game' },
      el(
        'div',
        { className: 'game-body' },
        el(
          'div',
          { className: 'game-title' },
          g.url ? el('a', { href: g.url, target: '_blank', rel: 'noreferrer' }, g.name) : el('span', {}, g.name),
          g.maxPlayers && el('span', { className: 'hint' }, `Up to ${g.maxPlayers}`),
          g.sale && el('span', { className: 'game-sale' }, `${g.sale.discount}% off · ${g.sale.price}`, el('s', {}, g.sale.was)),
        ),
        fact('Has it', g.owners),
        fact('Needs it', g.needs),
        fact('Wants it', g.wanted),
      ),
      el('button', { ariaLabel: `Manage ${g.name}`, onclick: () => manageDialog(main, g.id, () => data, load) }, 'Manage'),
    );

  function paint() {
    if (!data) return;
    if (!data.games.length) return box.replaceChildren(el('div', { className: 'empty' }, 'The library is empty. Add a game to start it off.'));
    const shown = data.games.filter((g) => g.name.toLowerCase().includes(query) && (filter === 'all' || (filter === 'wanted' ? g.wanted.length > 0 : g.sale)));
    if (!shown.length) return box.replaceChildren(el('div', { className: 'empty' }, 'No games match that.'));
    box.replaceChildren(el('section', { className: 'card' }, shown.map(gameRow)));
  }

  async function load() {
    const fresh = await request(api('/games'));
    if (guildId !== state.guildId || !main.isConnected) return;
    data = fresh;
    paint();
  }

  void attempt(async () => {
    try {
      await load();
    } catch (err) {
      box.replaceChildren(el('div', { className: 'empty' }, err.message));
      throw err;
    }
  });
}
