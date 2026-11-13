import { el, icon, pageSignal, recall, remember, secondWindow, setSecondWindow, state, toast } from './lib.js';
import { musicPlayer } from './miniplayer.js';
import { onPlaying, stopButton } from './playing.js';
import { searchKeys } from './soundgrid.js';
import { soundsBody } from './soundspanel.js';
import { watchPresses } from './updates.js';
import { playInPicker } from './voice.js';

/**
 * The pop-out: a small window that stays on top of everything, even a game, with the music, Play in, a line to say
 * and the sounds. It's a Document Picture-in-Picture window, which desktop Chrome and Edge 116+ and Firefox 151+ open
 * over HTTPS, so the button that opens it shows only there. Its contents run here, in the tab, and it closes with it
 */

// The size it was last closed at on this device, which the next one opens at
const SIZE_KEY = 'popoutSize';
const FIRST_SIZE = { width: 380, height: 640 };

/** Goes to the Soundboard in the tab, which app.js says how to do */
let openBoard = () => {};
/** The server the window shows, and its search, which typing anywhere in the window goes to */
let shown = null;
/** Where the window's toasts go */
let toasts = null;
/** Set while the browser's asked for the window, so a second press doesn't ask again */
let opening = false;
// Smaller than this, it was closed along with the tab rather than sized by hand
const LEAST_KEPT = 200;

/** Whether this browser can open the window */
const canPopOut = () => 'documentPictureInPicture' in window && isSecureContext;

/** Tells the window how to go to the Soundboard in the tab, for when there are no sounds to show */
export function popOutGoesTo(fn) {
  openBoard = fn;
}

/** The button that opens the window, or null where it can't open */
export function popOutButton(className = 'icon quiet') {
  if (!canPopOut()) return null;
  const button = el(
    'button',
    { type: 'button', className: `${className} pop-out`, ariaLabel: 'Pop out', title: 'Pop out: the music and sounds in a small window that stays on top, even over a game', hidden: !!secondWindow(), onclick: () => void popOut() },
    icon('popout'),
  );
  // Gone while the window's open, as there's only one
  addEventListener('second-window', () => (button.hidden = !!secondWindow()), { signal: pageSignal() });
  return button;
}

/** Closes the window, as the tab has logged out or has no server to show */
export const closePopOut = () => secondWindow()?.close();

async function popOut() {
  if (secondWindow() || opening) return;
  opening = true;
  let size = FIRST_SIZE;
  try {
    size = { ...FIRST_SIZE, ...JSON.parse(recall(SIZE_KEY) ?? '{}') };
  } catch {}
  let win;
  try {
    win = await documentPictureInPicture.requestWindow(size);
  } catch (err) {
    toast(`The window didn’t open: ${err.message}`, true);
    return;
  } finally {
    opening = false;
  }
  const doc = win.document;
  doc.documentElement.lang = 'en';
  doc.title = 'Slopkeeper';
  // The page's own stylesheet, so it looks the same, light or dark
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) doc.head.append(el('link', { rel: 'stylesheet', href: link.href }));
  doc.body.className = 'popout';
  toasts = el('div', { id: 'toasts', role: 'status', ariaLive: 'polite' });
  watchPresses(win);
  setSecondWindow(win, toasts);
  render();

  // With a keyboard, / goes to the search, and so does just typing, unless it's into Say
  searchKeys(doc, () => shown?.search, () => true);
  // Back from the tab: the voice may have been changed on the Soundboard meanwhile
  win.addEventListener('focus', () => shown?.paint());
  win.addEventListener(
    'pagehide',
    () => {
      if (win.innerWidth >= LEAST_KEPT && win.innerHeight >= LEAST_KEPT) remember(SIZE_KEY, JSON.stringify({ width: win.innerWidth, height: win.innerHeight }));
      // Emptied, so what was in it stops following the bot: its parts would still count as on a page otherwise
      win.document.body.replaceChildren();
      shown = null;
      setSecondWindow(null);
    },
    { once: true },
  );
}

/** Fills the window for the server picked in the tab */
function render() {
  const win = secondWindow();
  if (!win) return;
  const body = soundsBody(
    () => {
      openBoard();
      // Over to the tab, where the Soundboard is
      window.focus();
    },
    // The music's volume is on its player, above
    { slash: true, volumes: ['sounds', 'speech'] },
  );
  const stop = stopButton();
  const foot = el('div', { className: 'popout-foot' }, stop.button);
  win.document.body.replaceChildren(musicPlayer(null, { inWindow: true }), el('div', { className: 'popout-main' }, playInPicker(), ...body.parts), foot, toasts);
  onPlaying(foot, stop.paint);
  shown = { guildId: state.guildId, search: body.search, paint: body.paint };
}

/** After the tab changes server: the window follows */
export function popOutFollows() {
  if (secondWindow() && shown?.guildId !== state.guildId) render();
}
