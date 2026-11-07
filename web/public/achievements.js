import { api, el, request } from './lib.js';

function progress({ total, people, skipped, goals }) {
  if (!total) return [el('p', { className: 'hint' }, 'This game has no Steam achievements.')];
  return [
    el('p', { className: 'hint' }, `${total} achievements`),
    ...people.toSorted((a, b) => b.done - a.done).map((p) => el('div', { className: 'achiever' }, el('span', {}, p.name), el('span', {}, `${p.done} of ${total}`))),
    skipped.length > 0 && el('p', { className: 'hint' }, `Can’t see ${skipped.join(', ')}. They need Steam linked, public game details and the game.`),
    goals.length > 0 && el('h3', {}, people.length > 1 ? 'Goals: nobody here has these' : 'Next goals'),
    ...goals.map((g) => el('p', { className: 'goal' }, el('strong', {}, g.name), g.percent === null ? null : ` · ${g.percent}% of players`, g.description && el('span', { className: 'hint' }, g.description))),
  ].filter(Boolean);
}

/** How a group is doing with a game's Steam achievements. It fills in once Steam has answered */
export function achievementsView(appid, users) {
  const box = el('div', { className: 'achievements' }, el('p', { className: 'hint' }, 'Asking Steam…'));
  const query = new URLSearchParams({ appid, users: users.join(',') });
  void request(api(`/achievements?${query}`))
    .then((data) => box.replaceChildren(...progress(data)))
    .catch((err) => box.replaceChildren(el('p', { className: 'hint' }, err.message)));
  return box;
}
