import { renderBoard } from './board.js';
import { renderLibrary } from './library.js';
import { announce, el, keepFocus, player, recall, remember } from './lib.js';
import { popOutButton } from './popout.js';
import { tabInAddress } from './viewtabs.js';
import { playInPicker } from './voice.js';

const VIEWS = [
  ['play', 'Play', renderBoard],
  ['manage', 'Manage', renderLibrary],
];

/** Which view the Soundboard tab opens on, remembered on this device */
export const VIEW_KEY = 'soundboardView';

/** The view the address names, as in #board/manage, if it's one */
export function inAddress() {
  const view = location.hash.slice(1).split('?')[0].split('/')[1];
  return VIEWS.some(([id]) => id === view) ? view : null;
}

/**
 * The Soundboard tab: playing sounds and saying things, or managing the sounds themselves. One tab, as they're the
 * same sounds, and a phone's tab row has little room. The address names the view, #board/play or #board/manage, so
 * Back, a bookmark or a link opens it; without one, the view used last on this device
 */
export function renderSoundboard(main) {
  const views = el('div', { className: 'views', role: 'group', ariaLabel: 'Soundboard view' });
  let body = null;
  let shown = null;

  /** Picking a view is a step Back undoes; Play's empty board opening Manage isn't */
  function pick(id, step = true) {
    if (id === shown) return;
    if (tabInAddress() === 'board') history[step ? 'pushState' : 'replaceState'](null, '', `#board/${id}`);
    show(id);
  }

  function show(id) {
    shown = id;
    remember(VIEW_KEY, id);
    player.stop();
    keepFocus(views, () =>
      views.replaceChildren(...VIEWS.map(([view, label]) => el('button', { type: 'button', ...(view === id && { 'aria-current': 'page' }), onclick: () => pick(view) }, label))),
    );
    // A new box each time, so the view left behind sees it's gone and stops updating
    const next = el('div', { className: 'view' });
    if (body) body.replaceWith(next);
    else main.append(next);
    body = next;
    slot.replaceChildren();
    // Both views spread out on a wide screen, with a column beside the sounds: Speech on Play, adding sounds on Manage.
    // The same width for both, so Play | Manage stays put
    main.classList.add('board-wide');
    // Play's empty board opens Manage, and each view's search goes beside the switch on a wide screen
    VIEWS.find(([view]) => view === id)[2](next, () => pick('manage', false), slot);
    slot.append(playIn);
    if (popOut) slot.append(popOut);
  }

  // Where both views play, after the view's search
  const playIn = playInPicker();
  // On a desktop browser that can, the music and sounds in a small window that stays on top
  const popOut = popOutButton();

  // Room beside the switch for the view's search on a wide screen, over the sounds
  const slot = el('div', { className: 'view-slot' });
  main.append(el('div', { className: 'view-head' }, views, slot));
  const first = inAddress() ?? (recall(VIEW_KEY) === 'manage' ? 'manage' : 'play');
  if (tabInAddress() === 'board') history.replaceState(history.state, '', `#board/${first}`);
  show(first);
  // Back and Forward between the views, and links to one, without drawing the whole page again
  main.followHash = () => {
    const view = inAddress() ?? 'play';
    if (view === shown) return;
    show(view);
    announce(VIEWS.find(([id]) => id === view)[1]);
  };
}
