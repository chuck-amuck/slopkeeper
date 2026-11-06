import { renderActivity } from './activity.js';
import { renderBoard } from './board.js';
import { renderGames } from './games.js';
import { attempt, el, player, recall, remember, request, RequestError, session, state } from './lib.js';
import { renderLibrary } from './library.js';
import { renderNights } from './nights.js';
import { renderPick } from './pick.js';
import { renderSettings } from './settings.js';
import { renderStats } from './stats.js';

const app = document.getElementById('app');
const TABS = [
  ['board', 'Soundboard', renderBoard],
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
  renderFrame();
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
              onchange: (e) => {
                state.guildId = e.target.value;
                remember('guild', state.guildId);
                renderFrame();
              },
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
