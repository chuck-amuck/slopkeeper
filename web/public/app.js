import { renderActivity } from './activity.js';
import { renderChat } from './chat.js';
import { renderDeals } from './deals.js';
import { renderGames } from './games.js';
import { renderHealth } from './health.js';
import { api, askEarly, attempt, devicePref, el, formProblem, icon, newPage, notice, openDialog, pageSignal, player, recall, remember, request, RequestError, session, SESSION_KEY, sessionLasts, state, toast } from './lib.js';
import { musicPlayer, noMusicPlayer } from './miniplayer.js';
import { renderMusic } from './music.js';
import { renderNights } from './nights.js';
import { renderPick } from './pick.js';
import { closePopOut, popOutButton, popOutFollows, popOutGoesTo } from './popout.js';
import { stopDock } from './playing.js';
import { noSoundsDock, soundsDock } from './soundsdock.js';
import { volumeDock } from './volumes.js';
import { stopWatchingUpdates, watchUpdates } from './updates.js';
import { playInPicker } from './voice.js';
import { profilePicker } from './profiles.js';
import { renderSettings } from './settings.js';
import { renderSoundboard, VIEW_KEY } from './soundboard.js';
import { SHOWN_PREFIX } from './soundgrid.js';
import { renderStats } from './stats.js';
import { startSpeed, stopSpeed } from './speed.js';
import { tabInAddress, viewTabs } from './viewtabs.js';

const app = document.getElementById('app');
// Games has the library, game nights and picking one as views, as Stats has its own
const GAMES_VIEW = 'gamesView';
const GAME_VIEWS = [
  ['library', 'Library', renderGames],
  ['nights', 'Game nights', renderNights],
  ['pick', 'Pick a game', renderPick],
];
const renderGamesTab = (main) => viewTabs(main, { tab: 'games', label: 'Games view', views: GAME_VIEWS, key: GAMES_VIEW });
// id, label, page, icon, and the shorter label a phone's bottom bar uses
const TABS = [
  ['board', 'Soundboard', renderSoundboard, 'speaker', 'Sounds'],
  ['music', 'Music', renderMusic, 'note'],
  ['games', 'Games', renderGamesTab, 'star'],
  ['deals', 'Deals', renderDeals, 'tag'],
  ['stats', 'Stats', renderStats, 'chart'],
  ['chat', 'Chat', renderChat, 'bubble'],
  ['activity', 'Activity', renderActivity, 'clock'],
  ['settings', 'Settings', renderSettings, 'sliders'],
  // How the bot itself is doing, for whoever runs it, so last
  ['health', 'Health', renderHealth, 'pulse'],
];
// What a phone's bottom bar has room for, in the same order as the tabs on a wider screen. The rest are under More
const BAR = ['board', 'music', 'games', 'stats'];
// The pages that play in voice, which have Play in in the header. The rest have it in the Sounds panel, or in the
// header too while the Sounds button's turned off in this browser
const PLAYS = ['board', 'music'];
/** A tab's name on a phone's bottom bar: the shorter one, where it has one */
const shortName = (id) => {
  const [, label, , , short] = TABS.find(([t]) => t === id);
  return short ?? label;
};
// Sounds was its own tab, and is now the Soundboard's Manage view
if (recall('tab') === 'library') {
  remember('tab', 'board');
  remember(VIEW_KEY, 'manage');
}
// Game nights and Pick a game were tabs of their own, and are now Games' views. Health was a view in Stats
if (['nights', 'pick'].includes(recall('tab'))) {
  remember(GAMES_VIEW, recall('tab'));
  remember('tab', 'games');
}
if (recall('statsView') === 'health') {
  remember('statsView', 'overview');
  if (recall('tab') === 'stats') remember('tab', 'health');
}
/** Where an address from before those moves is now, as a bookmark, a shared link or Back may still have one */
function movedHash() {
  const hash = location.hash.slice(1);
  const moved = /^(nights|pick)(?=$|[/?])/.test(hash) ? `games/${hash}` : /^stats\/health(?=$|[/?])/.test(hash) ? hash.slice('stats/'.length) : null;
  if (moved) history.replaceState(history.state, '', `#${moved}`);
}
const isTab = (id) => TABS.some(([t]) => t === id);
// The address names the tab, so Back, a bookmark or a shared link opens it. Without one, the tab used last. After the
// tab, a tab may name what it has open, like a view and its range: #stats/overview?range=week
const fromHash = tabInAddress;
movedHash();
let tab = isTab(fromHash()) ? fromHash() : isTab(recall('tab')) ? recall('tab') : 'board';
history.replaceState(null, '', fromHash() === tab ? location.hash : `#${tab}`);

addEventListener('popstate', () => {
  movedHash();
  const id = fromHash();
  if (!isTab(id)) return history.replaceState(null, '', `#${tab}`);
  // The same tab with something else open in it, like another Stats range: drawn again from the address, unless the
  // page follows its own address, as Settings' sections do
  if (id === tab) {
    const main = app.querySelector(':scope > main');
    if (main?.followHash) return main.followHash();
    if (location.hash.slice(1) !== id && app.querySelector('.bottom-nav')) renderFrame();
    return;
  }
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
  stopSpeed();
  player.stop();
  noMusicPlayer();
  closePopOut();
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

// The servers, the one picked and who you are there, as the page was last drawn on this device, to draw it from at once
const LAST_START = 'lastStart';
const startNow = () => JSON.stringify({ guildId: state.guildId, guilds: state.guilds, me: state.me });

/** What the page was last drawn with, if it was for `guildId` */
function lastStart(guildId) {
  try {
    const kept = JSON.parse(recall(LAST_START) ?? 'null');
    return kept?.guildId === guildId && Array.isArray(kept.guilds) && kept.guilds.some((g) => g.id === guildId) ? kept : null;
  } catch {
    return null;
  }
}

/** Draws the page. `fromKept` draws it at once from what it was last time, while the session lasts, then catches up */
async function start(fromKept = true) {
  const saved = recall('guild');
  // Asked for alongside the server list rather than after it, as it's almost always the server picked last time
  const savedMe = saved ? request(`/api/guilds/${saved}/me`).catch(() => null) : null;
  // Likewise what the Soundboard shows first, as it's the page people open most
  if (saved && tab === 'board') {
    askEarly(`/api/guilds/${saved}/sounds`);
    if (recall(VIEW_KEY) !== 'manage') askEarly(`/api/guilds/${saved}/say`);
    // And what it keeps up with: who's in voice for Play in, what's playing, the volumes and the sounds
    watchUpdates(saved, ['playing', 'music', 'voice', 'sounds', 'volumes']);
  }
  // Drawn straight away as it was last time, then again below only if the bot says otherwise
  // Not on a retry while the bot's unreachable, which would flash the page between tries
  const kept = fromKept && saved && sessionLasts() && lastStart(saved);
  let drawn = null;
  if (kept) {
    state.guilds = kept.guilds;
    state.guildId = kept.guildId;
    state.me = kept.me ?? null;
    renderFrame();
    startSpeed();
    drawn = startNow();
  }
  const { guilds } = await request('/api/guilds');
  // Another server picked meanwhile has drawn its own page
  if (drawn && state.guildId !== saved) {
    state.guilds = guilds;
    return;
  }
  state.guilds = guilds;
  state.guildId = guilds.find((g) => g.id === saved)?.id ?? guilds[0]?.id ?? null;
  // So the next visit can ask for its server's parts alongside the list
  if (state.guildId) remember('guild', state.guildId);
  const early = state.guildId === saved ? await savedMe : null;
  if (early) state.me = early.me;
  else await loadMe();
  if (drawn === startNow()) return;
  renderFrame();
  startSpeed();
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
 * Where the header doesn't fit on one row, as on a tablet or a small laptop, the tabs get a row of their own under
 * the server, and Play in where it's shown. The header sticks with only that row showing, and the row scrolls to the tab that's open,
 * which may be past the edge of the screen. A phone has its tabs along the bottom instead
 */
function fitNav() {
  const header = app.querySelector('header');
  const nav = header?.querySelector('nav');
  if (!nav) return;
  // Tried on one row first: anything that wraps starts below the first thing in it, the profile or the server
  header.classList.remove('tabs-below');
  const shown = [...header.children].filter((n) => n.offsetParent);
  const first = shown[0];
  // Nothing to measure while the header isn't shown
  if (!first) return;
  const ownRow = shown.some((n) => n.offsetTop >= first.offsetTop + first.offsetHeight);
  header.classList.toggle('tabs-below', ownRow);
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

// The pop-out window's way back to the Soundboard, when there are no sounds to show
popOutGoesTo(() => openTab('board'));

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
    // The sounds kept to draw the Soundboard quickly aren't left on a shared computer
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith(SHOWN_PREFIX) || key === LAST_START || key === SESSION_KEY) localStorage.removeItem(key);
    } catch {}
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
  // The last page's listeners go before this one's parts add theirs
  newPage();
  if (state.guildId) remember(LAST_START, startNow());
  const main = el('main');
  const guild = state.guilds.find((g) => g.id === state.guildId);
  const guildIcon = guild?.icon ? el('img', { src: guild.icon, alt: '' }) : null;
  // Where sounds, speech and music play, beside the server, on the pages that play them and wherever the Sounds panel
  // can't be opened to pick it
  const playIn = guild ? playInPicker() : null;
  const paintPlayIn = () => playIn && (playIn.hidden = !PLAYS.includes(tab) && devicePref.on('soundsButton'));
  paintPlayIn();
  addEventListener('device-pref', (e) => e.detail === 'soundsButton' && (paintPlayIn(), fitNav()), { signal: pageSignal() });
  // Outside main, as a page may redraw all of main. Only screen readers see it
  const title = el('h1', { className: 'visually-hidden', tabIndex: -1, id: 'page-title' }, TABS.find(([id]) => id === tab)[1]);

  // Until a music player on the new page says it's showing
  noMusicPlayer();
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
      // Who the bot is here, as its face, first in the header and left of the server, as it's for every page
      guild && profilePicker(),
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
      playIn,
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
    // The song playing, along the bottom of every page but Music, which has it at the top
    // (replaceChildren, unlike el(), would print a false as text)
    ...(guild && tab !== 'music' ? [musicPlayer(() => openTab('music'), { extra: popOutButton('icon') })] : []),
    // A phone's tabs, in reach of a thumb. Hidden by style.css on anything wider
    el(
      'nav',
      { className: 'bottom-nav', ariaLabel: 'Pages' },
      BAR.map((id) => {
        const [, , , iconName] = TABS.find(([t]) => t === id);
        return el('button', { type: 'button', ...(tab === id && { 'aria-current': 'page' }), onclick: () => openTab(id) }, icon(iconName), el('span', {}, shortName(id)));
      }),
      // More, or the page open from under it, by its shorter name where it has one
      el('button', { type: 'button', ...(!BAR.includes(tab) && { 'aria-current': 'page' }), ariaHasPopup: 'dialog', onclick: () => moreSheet(main) }, icon('more'), el('span', {}, BAR.includes(tab) ? 'More' : shortName(tab))),
    ),
    // In the corner of every page, so they're always in reach. The Soundboard has every sound already
    ...(guild ? [stopDock(volumeDock(), tab === 'board' ? noSoundsDock() : soundsDock(() => openTab('board'), popOutButton(), { playIn: !PLAYS.includes(tab) }))] : []),
  );
  // The pop-out window, if it's open, shows the server picked here, and closes if there isn't one
  if (guild) popOutFollows();
  else closePopOut();
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
  // Including what the page started following before it knew the bot was down
  stopWatchingUpdates();
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
    start(false).catch((again) => (isLoggedOut(again) ? null : showUnreachable(again, byHand ? tries : tries + 1)));
  };
  const retryButton = el('button', { className: 'primary', onclick: () => retry(true) }, 'Retry now');
  paintCountdown();
  noMusicPlayer();
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
