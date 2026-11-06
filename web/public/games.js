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
  const hide = el('input', { type: 'checkbox', onchange: (e) => setHidden(e.target.checked) });
  const hideNote = el('p', { className: 'hint' });

  function setHidden(on) {
    return attempt(() =>
      guarded(async () => {
        await request(api(`/hidden-games/${find().appid}`), { method: on ? 'PUT' : 'DELETE' });
        await reload();
      }).finally(paint),
    );
  }

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
    hide.disabled = game.appid === null;
    hide.checked = data().hidden.some((h) => h.appid === game.appid);
    hideNote.textContent = game.appid === null ? 'Needs a Steam link, which is how a hidden game is told apart.' : 'Keeps it out of /whatdoweplay, and out of sale alerts unless someone asked for it.';
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
    el('label', { className: 'game-mark' }, hide, 'Never suggest this'),
    hideNote,
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

const PRIVACY_HELP = 'To fix a private library, in Steam go to Profile → Edit Profile → Privacy Settings, set Game details to Public, then refresh here.';

/** Who's who on Steam. Links apply in every server someone shares with the bot, as Steam accounts do */
function accountsDialog(main, onChanged) {
  let data = null;
  let editing = null;
  const problem = el('div', { className: 'bad-text plan-problem', hidden: true });
  const done = el('div', { className: 'form-note', hidden: true });
  const search = el('input', { type: 'search', placeholder: 'Search people', ariaLabel: 'Search people', oninput: () => paint() });
  const list = el('div', { className: 'merge-list' }, el('p', {}, 'Loading members…'));
  const help = el('p', { className: 'hint', hidden: true }, PRIVACY_HELP);

  const say = (node, text) => {
    node.textContent = text ?? '';
    node.hidden = !text;
  };

  async function refresh() {
    data = await request(api('/steam-links'));
    paint();
    await onChanged();
  }

  const guarded = (action, message) =>
    attempt(async () => {
      say(problem, null);
      say(done, null);
      try {
        await action();
        say(done, message());
      } catch (err) {
        if (!(err instanceof RequestError)) throw err;
        say(problem, err.message);
      }
    });

  function linkForm(member) {
    const profile = el('input', { required: true, maxLength: 200, autocomplete: 'off', placeholder: 'Profile link, custom URL name or SteamID64', ariaLabel: `Steam profile for ${member.name}` });
    const save = el('button', { className: 'primary', type: 'submit' }, 'Save');
    const form = el(
      'form',
      {
        className: 'steam-form',
        onsubmit: (e) => {
          e.preventDefault();
          let games;
          save.disabled = true;
          void guarded(
            async () => {
              ({ games } = await request(api(`/steam-links/${member.id}`), { method: 'PUT', json: { profile: profile.value } }));
              editing = null;
              await refresh();
            },
            () => (games === null ? `Linked ${member.name}, but their game details are private.` : `Linked ${member.name}, with ${games} games.`),
          ).finally(() => {
            save.disabled = false;
          });
        },
      },
      profile,
      save,
      el(
        'button',
        {
          type: 'button',
          onclick: () => {
            editing = null;
            paint();
          },
        },
        'Cancel',
      ),
    );
    setTimeout(() => profile.focus());
    return form;
  }

  function accountRow(member) {
    const { steam } = member;
    const edit = (label) =>
      el(
        'button',
        {
          ariaLabel: `${label} ${member.name}`,
          disabled: !data.configured,
          onclick: () => {
            editing = member.id;
            say(problem, null);
            paint();
          },
        },
        label,
      );
    return el(
      'div',
      { className: 'steam-account' },
      el('span', { className: 'rank-name' }, member.name),
      steam
        ? el('a', { className: 'steam-status', href: steam.url, target: '_blank', rel: 'noreferrer' }, steam.private ? 'Game details private' : `${steam.games} game${steam.games === 1 ? '' : 's'}`)
        : el('span', { className: 'steam-status' }, 'Not linked'),
      el(
        'span',
        { className: 'steam-actions' },
        edit(steam ? 'Change' : 'Link'),
        steam &&
          confirmButton({ ariaLabel: `Unlink ${member.name}`, disabled: !data.configured }, 'Unlink', 'Sure?', () =>
            guarded(
              async () => {
                await request(api(`/steam-links/${member.id}`), { method: 'DELETE' });
                await refresh();
              },
              () => `Unlinked ${member.name}.`,
            ),
          ),
      ),
      editing === member.id && linkForm(member),
    );
  }

  function paint() {
    if (!data) return;
    const query = search.value.trim().toLowerCase();
    const shown = data.members.filter((m) => m.name.toLowerCase().includes(query));
    list.replaceChildren(...shown.map(accountRow));
    if (!shown.length) list.append(el('p', {}, 'Nobody matches that.'));
    help.hidden = !data.members.some((m) => m.steam?.private);
    refreshAll.disabled = !data.configured;
    if (!data.configured) say(problem, 'Steam isn’t set up on the bot: it needs a STEAM_API_KEY.');
  }

  const refreshAll = el(
    'button',
    {
      type: 'button',
      disabled: true,
      onclick: () => {
        refreshAll.disabled = true;
        say(done, 'Refreshing libraries…');
        void guarded(
          async () => {
            await request(api('/steam-refresh'), { method: 'POST' });
            await refresh();
          },
          () => 'Libraries refreshed.',
        ).finally(() => {
          refreshAll.disabled = false;
        });
      },
    },
    'Refresh libraries',
  );

  const node = openDialog(
    main,
    el('h2', {}, 'Steam accounts'),
    el('p', {}, 'Who’s who on Steam, for working out who owns what. A link applies in every server someone shares with the bot.'),
    search,
    list,
    help,
    done,
    problem,
    el('div', { className: 'actions' }, refreshAll, el('button', { type: 'button', onclick: () => node.close() }, 'Close')),
  );
  void attempt(async () => {
    try {
      data = await request(api('/steam-links'));
      paint();
    } catch (err) {
      list.replaceChildren(el('p', {}, err.message));
      throw err;
    }
  });
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
  const accounts = el('button', { onclick: () => accountsDialog(main, load) }, 'Steam accounts');
  main.append(el('div', { className: 'toolbar' }, search, picker, accounts, add), box);

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

  function library() {
    if (!data.games.length) return el('div', { className: 'empty' }, 'The library is empty. Add a game to start it off.');
    const shown = data.games.filter((g) => g.name.toLowerCase().includes(query) && (filter === 'all' || (filter === 'wanted' ? g.wanted.length > 0 : g.sale)));
    if (!shown.length) return el('div', { className: 'empty' }, 'No games match that.');
    return el('section', { className: 'card' }, shown.map(gameRow));
  }

  function hiddenRow(game) {
    const again = el(
      'button',
      {
        ariaLabel: `Suggest ${game.name} again`,
        onclick: () => {
          again.disabled = true;
          void attempt(async () => {
            await request(api(`/hidden-games/${game.appid}`), { method: 'DELETE' });
            toast(`${game.name} can be suggested again.`);
            await load();
          }).finally(() => {
            again.disabled = false;
          });
        },
      },
      'Suggest again',
    );
    return el('div', { className: 'field' }, el('div', { className: 'series-name' }, game.name), el('div', { className: 'control' }, again));
  }

  function paint() {
    if (!data) return;
    box.replaceChildren(
      library(),
      ...(data.hidden.length
        ? [el('section', { className: 'card' }, el('h2', {}, 'Hidden from suggestions'), el('p', { className: 'card-note' }, 'Hidden with Never suggest this, so /whatdoweplay leaves them out.'), data.hidden.map(hiddenRow))]
        : []),
    );
  }

  async function load() {
    const [fresh, { games: hidden }] = await Promise.all([request(api('/games')), request(api('/hidden-games'))]);
    if (guildId !== state.guildId || !main.isConnected) return;
    data = { ...fresh, hidden };
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
