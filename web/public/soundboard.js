import { renderBoard } from './board.js';
import { renderLibrary } from './library.js';
import { el, keepFocus, player, recall, remember } from './lib.js';

const VIEWS = [
  ['play', 'Play', renderBoard],
  ['manage', 'Manage', renderLibrary],
];

/** Which view the Soundboard tab opens on, remembered on this device */
export const VIEW_KEY = 'soundboardView';

/**
 * The Soundboard tab: playing sounds and saying things, or managing the sounds themselves. One tab, as they're the
 * same sounds, and a phone's tab row has little room
 */
export function renderSoundboard(main) {
  const views = el('div', { className: 'views', role: 'group', ariaLabel: 'Soundboard view' });
  let body = null;

  function show(id) {
    remember(VIEW_KEY, id);
    player.stop();
    keepFocus(views, () =>
      views.replaceChildren(...VIEWS.map(([view, label]) => el('button', { type: 'button', ...(view === id && { 'aria-current': 'page' }), onclick: () => view !== id && show(view) }, label))),
    );
    // A new box each time, so the view left behind sees it's gone and stops updating
    const next = el('div', { className: 'view' });
    if (body) body.replaceWith(next);
    else main.append(next);
    body = next;
    VIEWS.find(([view]) => view === id)[2](next, () => show('manage'));
  }

  main.append(views);
  show(recall(VIEW_KEY) === 'manage' ? 'manage' : 'play');
}
