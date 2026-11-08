import { renderActivity } from './activity.js';
import { renderBoard } from './board.js';
import { renderGames } from './games.js';
import { api, attempt, el, openDialog, player, recall, remember, request, RequestError, session, state, toast } from './lib.js';
import { renderLibrary } from './library.js';
import { renderMusic } from './music.js';
import { renderNights } from './nights.js';
import { renderPick } from './pick.js';
import { renderSettings } from './settings.js';
import { renderStats } from './stats.js';

const app = document.getElementById('app');
const TABS = [
  ['board', 'Soundboard', renderBoard],
  ['music', 'Music', renderMusic],
  ['library', 'Library', renderLibrary],
  ['nights', 'Game nights', renderNights],
  ['games', 'Games', renderGames],
  ['pick', 'Pick a game', renderPick],
  ['stats', 'Stats', renderStats],
  ['activity', 'Activity', renderActivity],
  ['settings', 'Settings', renderSettings],
];
let tab = TABS.some(([id]) => id === recall('tab')) ? recall('tab') : 'board';

function showLogin() {
  player.stop();
  const password = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password', ariaLabel: 'Password' });
  const error = el('div', { className: 'bad-text', hidden: true });
  const submit = el('button', { className: 'primary', type: 'submit' }, 'Log in');
  const form = el(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          await request('/auth/login', { method: 'POST', json: { password: password.value } });
          await start();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
          password.select();
        }
      },
    },
    el('h1', {}, el('img', { src: '/icon.svg', alt: '' }), 'Slopkeeper'),
    password,
    error,
    submit,
  );
  app.replaceChildren(el('div', { className: 'login' }, form));
  password.focus();
}

session.onExpired = showLogin;

async function start() {
  const { guilds } = await request('/api/guilds');
  state.guilds = guilds;
  const saved = recall('guild');
  state.guildId = guilds.find((g) => g.id === saved)?.id ?? guilds[0]?.id ?? null;
  await loadMe();
  renderFrame();
}

async function loadMe() {
  state.me = state.guildId ? (await request(api('/me'))).me : null;
}

/** Lets someone signed in through Pangolin say which Discord member they are, so their changes show under that name */
function meDialog(main) {
  const who = el('select', { ariaLabel: 'Discord member' }, el('option', { value: '' }, 'Not linked'));
  const problem = el('div', { className: 'bad-text plan-problem', hidden: true });
  const submit = el('button', { className: 'primary', type: 'submit', disabled: true }, 'Save');
  const node = openDialog(
    main,
    el('h2', {}, `Signed in as ${state.me.name}`),
    el('p', {}, 'Which Discord member are you? Your changes show under that name in Activity, and anything that asks for a person starts on you.'),
    el(
      'form',
      {
        className: 'plan',
        onsubmit: (e) => {
          e.preventDefault();
          submit.disabled = true;
          problem.hidden = true;
          void attempt(async () => {
            try {
              const { me } = await request(api('/me'), who.value ? { method: 'PUT', json: { userId: who.value } } : { method: 'DELETE' });
              state.me = me;
              node.close();
              toast(me.userId ? `You’re ${who.selectedOptions[0].textContent} here now.` : 'Not linked to anyone now.');
              renderFrame();
            } catch (err) {
              if (!(err instanceof RequestError)) throw err;
              problem.textContent = err.message;
              problem.hidden = false;
            } finally {
              submit.disabled = false;
            }
          });
        },
      },
      who,
      problem,
      el('div', { className: 'actions' }, el('button', { type: 'button', onclick: () => node.close() }, 'Cancel'), submit),
    ),
  );
  void attempt(async () => {
    const { members } = await request(api('/pick/options'));
    who.append(...members.map((m) => el('option', { value: m.id, selected: m.id === state.me.userId }, m.name)));
    submit.disabled = false;
  });
}

function renderFrame() {
  const main = el('main');
  const guild = state.guilds.find((g) => g.id === state.guildId);
  const icon = guild?.icon ? el('img', { src: guild.icon, alt: '' }) : null;

  app.replaceChildren(
    el(
      'header',
      {},
      el('div', { className: 'brand' }, el('img', { src: '/icon.svg', alt: '' }), el('span', {}, 'Slopkeeper')),
      state.guilds.length > 0 &&
        el(
          'div',
          { className: 'guild' },
          icon,
          el(
            'select',
            {
              ariaLabel: 'Server',
              onchange: (e) =>
                attempt(async () => {
                  state.guildId = e.target.value;
                  remember('guild', state.guildId);
                  await loadMe();
                  renderFrame();
                }),
            },
            state.guilds.map((g) => el('option', { value: g.id, selected: g.id === state.guildId }, g.name)),
          ),
        ),
      el(
        'nav',
        {},
        TABS.map(([id, label]) =>
          el(
            'button',
            {
              ...(tab === id && { 'aria-current': 'page' }),
              onclick: () => {
                tab = id;
                remember('tab', id);
                renderFrame();
              },
            },
            label,
          ),
        ),
      ),
      el('div', { className: 'spacer' }),
      state.me && el('button', { className: 'quiet', title: 'Which Discord member you are', onclick: () => meDialog(main) }, state.me.name),
      el(
        'button',
        {
          className: 'quiet',
          onclick: () =>
            attempt(async () => {
              await request('/auth/logout', { method: 'POST' });
              showLogin();
            }),
        },
        'Log out',
      ),
    ),
    main,
  );

  player.stop();
  if (!guild) main.append(el('div', { className: 'empty' }, 'The bot isn’t in any servers yet.'));
  else TABS.find(([id]) => id === tab)[2](main);
}

// A 401 on the first request is how the page learns nobody is logged in
start().catch((err) => {
  if (!(err instanceof RequestError) || err.message !== 'Log in again.') {
    app.replaceChildren(el('div', { className: 'empty' }, err.message));
  }
});
