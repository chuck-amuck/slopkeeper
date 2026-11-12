import { renderActivity } from './activity.js';
import { renderGames } from './games.js';
import { api, attempt, el, formProblem, notice, openDialog, player, recall, remember, request, RequestError, session, state, toast } from './lib.js';
import { renderMusic } from './music.js';
import { renderNights } from './nights.js';
import { renderPick } from './pick.js';
import { stopDock, stopWatchingPlaying, watchPlaying } from './playing.js';
import { renderSettings } from './settings.js';
import { renderSoundboard, VIEW_KEY } from './soundboard.js';
import { renderStats } from './stats.js';

const app = document.getElementById('app');
const TABS = [
  ['board', 'Soundboard', renderSoundboard],
  ['music', 'Music', renderMusic],
  ['nights', 'Game nights', renderNights],
  ['games', 'Games', renderGames],
  ['pick', 'Pick a game', renderPick],
  ['stats', 'Stats', renderStats],
  ['activity', 'Activity', renderActivity],
  ['settings', 'Settings', renderSettings],
];
// Sounds was its own tab, and is now the Soundboard's Manage view
if (recall('tab') === 'library') {
  remember('tab', 'board');
  remember(VIEW_KEY, 'manage');
}
let tab = TABS.some(([id]) => id === recall('tab')) ? recall('tab') : 'board';

function showLogin() {
  player.stop();
  stopWatchingPlaying();
  const password = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password', ariaLabel: 'Password', 'aria-describedby': 'login-error' });
  const error = el('div', { className: 'bad-text', id: 'login-error', role: 'alert', hidden: true });
  const submit = el('button', { className: 'primary', type: 'submit' }, 'Log in');
  const form = el(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        password.ariaInvalid = null;
        try {
          await request('/auth/login', { method: 'POST', json: { password: password.value } });
          await start();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          password.ariaInvalid = 'true';
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
  const problem = formProblem();
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

/**
 * On a phone or tablet the tabs sit on a row of their own under the server picker. The header sticks with only that
 * row showing, and the row scrolls to the tab that's open, which may be past the edge of the screen
 */
function fitNav() {
  const header = app.querySelector('header');
  const nav = header?.querySelector('nav');
  if (!nav) return;
  // The same width as style.css gives the tabs their own row
  const ownRow = matchMedia('(max-width: 1120px)').matches;
  header.style.top = ownRow ? `${-nav.offsetTop}px` : '';
  // Keyboard focus scrolls clear of the part of the header that stays on screen
  document.documentElement.style.scrollPaddingTop = `${header.offsetHeight - (ownRow ? nav.offsetTop : 0) + 8}px`;
  const current = nav.querySelector('[aria-current]');
  if (current) nav.scrollLeft = current.offsetLeft - nav.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
}
addEventListener('resize', fitNav);

/** Set when a tab is picked, so its heading takes focus once it's drawn, as the button pressed is gone */
let focusTitle = false;

function renderFrame() {
  const main = el('main');
  const guild = state.guilds.find((g) => g.id === state.guildId);
  const icon = guild?.icon ? el('img', { src: guild.icon, alt: '' }) : null;
  // Outside main, as a page may redraw all of main. Only screen readers see it
  const title = el('h1', { className: 'visually-hidden', tabIndex: -1, id: 'page-title' }, TABS.find(([id]) => id === tab)[1]);

  app.replaceChildren(
    el(
      'a',
      {
        className: 'skip-link',
        href: '#page-title',
        onclick: (e) => {
          e.preventDefault();
          title.focus();
        },
      },
      'Skip to content',
    ),
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
                focusTitle = true;
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
    title,
    main,
    // In the corner of every page, so it's always in reach
    guild && stopDock(),
  );
  if (guild) watchPlaying();
  else stopWatchingPlaying();

  fitNav();
  if (focusTitle) title.focus();
  focusTitle = false;
  player.stop();
  if (!guild) main.append(notice('empty', 'The bot isn’t in any servers yet.'));
  else TABS.find(([id]) => id === tab)[2](main);
}

// A 401 on the first request is how the page learns nobody is logged in
start().catch((err) => {
  if (!(err instanceof RequestError) || err.message !== 'Log in again.') {
    app.replaceChildren(notice('error', err.message));
  }
});
