import { renderActivity } from './activity.js';
import { renderGames } from './games.js';
import { api, attempt, el, formProblem, icon, notice, openDialog, player, recall, remember, request, RequestError, session, state, toast } from './lib.js';
import { renderMusic } from './music.js';
import { renderNights } from './nights.js';
import { renderPick } from './pick.js';
import { stopDock } from './playing.js';
import { stopWatchingUpdates, watchUpdates } from './updates.js';
import { renderSettings } from './settings.js';
import { renderSoundboard, VIEW_KEY } from './soundboard.js';
import { renderStats } from './stats.js';

const app = document.getElementById('app');
// id, label, page, icon, and the shorter label a phone's bottom bar uses
const TABS = [
  ['board', 'Soundboard', renderSoundboard, 'speaker', 'Sounds'],
  ['music', 'Music', renderMusic, 'note'],
  ['nights', 'Game nights', renderNights, 'calendar', 'Nights'],
  ['games', 'Games', renderGames, 'star'],
  ['pick', 'Pick a game', renderPick, 'dice', 'Pick'],
  ['stats', 'Stats', renderStats, 'chart'],
  ['activity', 'Activity', renderActivity, 'clock'],
  ['settings', 'Settings', renderSettings, 'sliders'],
];
// What a phone's bottom bar has room for: what's used during a call. The rest are under More
const BAR = ['board', 'music', 'nights', 'pick'];
// Sounds was its own tab, and is now the Soundboard's Manage view
if (recall('tab') === 'library') {
  remember('tab', 'board');
  remember(VIEW_KEY, 'manage');
}
const isTab = (id) => TABS.some(([t]) => t === id);
// The address names the tab, so Back, a bookmark or a shared link opens it. Without one, the tab used last
const fromHash = () => location.hash.slice(1);
let tab = isTab(fromHash()) ? fromHash() : isTab(recall('tab')) ? recall('tab') : 'board';
history.replaceState(null, '', `#${tab}`);

addEventListener('popstate', () => {
  const id = fromHash();
  if (!isTab(id)) return history.replaceState(null, '', `#${tab}`);
  if (id === tab) return;
  tab = id;
  remember('tab', id);
  // Over the login or a retry screen it's just remembered, and shown once the tabs are
  if (!app.querySelector('.bottom-nav')) return;
  focusTitle = true;
  renderFrame();
});

function showLogin() {
  // Requests made side by side can each find the session expired, and a second form would wipe what's being typed
  if (app.querySelector(':scope > .login')) return;
  document.title = 'Log in · Slopkeeper';
  player.stop();
  stopWatchingUpdates();
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
  const saved = recall('guild');
  // Asked for alongside the server list rather than after it, as it's almost always the server picked last time
  const savedMe = saved ? request(`/api/guilds/${saved}/me`).catch(() => null) : null;
  const { guilds } = await request('/api/guilds');
  state.guilds = guilds;
  state.guildId = guilds.find((g) => g.id === saved)?.id ?? guilds[0]?.id ?? null;
  const early = state.guildId === saved ? await savedMe : null;
  if (early) state.me = early.me;
  else await loadMe();
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
  const node = openDialog(main, {
    title: `Signed in as ${state.me.name}`,
    body: [
      el('p', {}, 'Which Discord member are you? Your changes show under that name in Activity, and anything that asks for a person starts on you.'),
      who,
      problem,
    ],
    actions: [submit],
    close: 'Cancel',
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
  });
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
  // Keyboard focus scrolls clear of the part of the header that stays on screen, and Settings' find bar sticks under it
  const visible = header.offsetHeight - (ownRow ? nav.offsetTop : 0);
  document.documentElement.style.scrollPaddingTop = `${visible + 8}px`;
  document.documentElement.style.setProperty('--header-visible', `${visible}px`);
  const current = nav.querySelector('[aria-current]');
  if (current) nav.scrollLeft = current.offsetLeft - nav.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
}
addEventListener('resize', fitNav);

/** Set when a tab is picked, so its heading takes focus once it's drawn, as the button pressed is gone */
let focusTitle = false;

function openTab(id) {
  if (id !== tab) history.pushState(null, '', `#${id}`);
  tab = id;
  remember('tab', id);
  focusTitle = true;
  renderFrame();
}

const logOut = () =>
  attempt(async () => {
    await request('/auth/logout', { method: 'POST' });
    showLogin();
  });

/** On a phone: the tabs that aren't on the bottom bar, then who you are and Log out, in a sheet from the bottom */
function moreSheet(main) {
  const item = (iconName, label, onclick, current = false) =>
    el('button', { type: 'button', className: 'sheet-item with-icon', ...(current && { 'aria-current': 'page' }), onclick }, icon(iconName), el('span', {}, label));
  const node = openDialog(main, {
    title: 'More',
    className: 'sheet',
    body: [
      el(
        'div',
        { className: 'sheet-list' },
        TABS.filter(([id]) => !BAR.includes(id)).map(([id, label, , iconName]) =>
          item(iconName, label, () => {
            node.close();
            openTab(id);
          }, id === tab),
        ),
      ),
      el(
        'div',
        { className: 'sheet-list' },
        state.me &&
          item('user', state.me.userId ? `Signed in as ${state.me.name}` : `${state.me.name}: say which member you are`, () => {
            node.close();
            meDialog(main);
          }),
        item('logout', 'Log out', () => {
          node.close();
          void logOut();
        }),
      ),
    ],
  });
}

function renderFrame() {
  const main = el('main');
  const guild = state.guilds.find((g) => g.id === state.guildId);
  const guildIcon = guild?.icon ? el('img', { src: guild.icon, alt: '' }) : null;
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
      state.guilds.length === 1 && el('div', { className: 'guild' }, guildIcon, el('span', { className: 'guild-name' }, guild.name)),
      state.guilds.length > 1 &&
        el(
          'div',
          { className: 'guild' },
          guildIcon,
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
        { ariaLabel: 'Pages' },
        TABS.map(([id, label]) => el('button', { ...(tab === id && { 'aria-current': 'page' }), onclick: () => openTab(id) }, label)),
      ),
      el('div', { className: 'spacer' }),
      state.me && el('button', { className: 'quiet me', title: 'Which Discord member you are', onclick: () => meDialog(main) }, state.me.name),
      el('button', { className: 'quiet log-out', onclick: logOut }, 'Log out'),
    ),
    title,
    main,
    // A phone's tabs, in reach of a thumb. Hidden by style.css on anything wider
    el(
      'nav',
      { className: 'bottom-nav', ariaLabel: 'Pages' },
      BAR.map((id) => {
        const [, label, , iconName, short] = TABS.find(([t]) => t === id);
        return el('button', { type: 'button', ...(tab === id && { 'aria-current': 'page' }), onclick: () => openTab(id) }, icon(iconName), el('span', {}, short ?? label));
      }),
      el('button', { type: 'button', ...(!BAR.includes(tab) && { 'aria-current': 'page' }), ariaHasPopup: 'dialog', onclick: () => moreSheet(main) }, icon('more'), el('span', {}, BAR.includes(tab) ? 'More' : TABS.find(([t]) => t === tab)[1])),
    ),
    // In the corner of every page, so it's always in reach
    guild && stopDock(),
  );
  if (guild) watchUpdates();
  else stopWatchingUpdates();

  document.title = `${TABS.find(([id]) => id === tab)[1]} · Slopkeeper`;
  fitNav();
  if (focusTitle) title.focus();
  focusTitle = false;
  player.stop();
  if (!guild) main.append(notice('empty', 'The bot isn’t in any servers yet.'));
  else TABS.find(([id]) => id === tab)[2](main);
}

/**
 * Keeps trying when the bot can't be reached on load, as it's usually restarting, waiting longer each time. Retry now
 * skips the wait
 */
function showUnreachable(err, tries = 0) {
  // Anything else won't go away by waiting, and a bug in the page isn't the bot being down
  if (!(err instanceof RequestError) || (err.status && err.status < 500)) {
    if (!(err instanceof RequestError)) console.error(err);
    app.replaceChildren(notice('error', err instanceof RequestError ? err.message : 'Something broke on this page. Reload to try again.'));
    return;
  }
  const waitS = Math.min(30, 2 ** tries * 2);
  let left = waitS;
  const countdown = el('span', {});
  const paintCountdown = () => (countdown.textContent = `Trying again in ${left} s.`);
  let timer;
  const retry = (byHand) => {
    clearInterval(timer);
    retryButton.disabled = true;
    countdown.textContent = 'Trying now…';
    // Pressing Retry now doesn't make the next wait longer
    start().catch((again) => (isLoggedOut(again) ? null : showUnreachable(again, byHand ? tries : tries + 1)));
  };
  const retryButton = el('button', { className: 'primary', onclick: () => retry(true) }, 'Retry now');
  paintCountdown();
  timer = setInterval(() => {
    if (!retryButton.isConnected) return clearInterval(timer);
    left -= 1;
    if (left <= 0) retry(false);
    else paintCountdown();
  }, 1000);
  app.replaceChildren(
    el('header', {}, el('div', { className: 'brand' }, el('img', { src: '/icon.svg', alt: '' }), el('span', {}, 'Slopkeeper'))),
    el(
      'main',
      {},
      el(
        'section',
        { className: 'card unreachable', role: 'alert' },
        el('h2', {}, 'Can’t reach the bot'),
        el('div', { className: 'card-body' }, el('p', {}, err.message, ' ', countdown), el('div', { className: 'toolbar' }, retryButton)),
      ),
    ),
  );
}

// A 401 on the first request is how the page learns nobody is logged in
const isLoggedOut = (err) => err instanceof RequestError && err.status === 401;
start().catch((err) => {
  if (!isLoggedOut(err)) showUnreachable(err);
});
