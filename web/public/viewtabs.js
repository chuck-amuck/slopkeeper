import { announce, el, recall, remember } from './lib.js';

/** The tab the page's address names: stats, in #stats/overview?range=week */
export const tabInAddress = () => location.hash.slice(1).split(/[/?]/)[0];

/**
 * For a page drawn in `box`: write(params) puts its query in the address after `path`, like health or stats/overview,
 * so a reload or a link opens it the same, until someone's moved on to another view or tab
 */
export function addressWriter(box, path) {
  const tab = path.split('/')[0];
  return (query) => {
    if (!box.isConnected || tabInAddress() !== tab) return;
    const text = query.toString();
    history.replaceState(history.state, '', `#${path}${text ? `?${text}` : ''}`);
  };
}

/** The view and its query in the page's address: #stats/overview?range=week */
function fromAddress() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  return { view: path.split('/')[1], params: new URLSearchParams(query) };
}

/**
 * A tab whose page has views, like Stats and Games: tabs along a line, which look unlike the buttons in a view, in one
 * row that scrolls on a phone. The address names the view and anything it has open, #<tab>/<view>?<query>, so Back,
 * a bookmark or a link opens it; without one, the view used last on this device. Picking a view is a step Back undoes.
 * `views` are [id, label, render(box, { params, write })], where write(params) changes the query, as a range does
 */
export function viewTabs(main, { tab, label, views, key }) {
  const known = (id) => views.some(([view]) => view === id);
  const buttons = views.map(([id, name]) => el('button', { type: 'button', onclick: () => pick(id) }, name));
  const tabs = el('div', { className: 'views view-tabs', role: 'group', ariaLabel: label }, buttons);
  const body = el('div', { className: 'stack' });
  let shown = null;

  function show(id, params = new URLSearchParams()) {
    shown = id;
    remember(key, id);
    views.forEach(([view], i) => (view === id ? buttons[i].setAttribute('aria-current', 'page') : buttons[i].removeAttribute('aria-current')));
    tabs.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // A box of its own, so a view that's been left stops keeping itself up to date
    const box = el('div', { className: 'stack' });
    body.replaceChildren(box);
    const write = addressWriter(box, `${tab}/${id}`);
    write(params);
    const [, , render] = views.find(([view]) => view === id);
    render(box, { params, write });
  }

  function pick(id) {
    if (id === shown) return;
    history.pushState(null, '', `#${tab}/${id}`);
    show(id);
  }

  /** Shows the view the address names, or the one used last */
  function follow() {
    const asked = fromAddress();
    if (known(asked.view)) return show(asked.view, asked.params);
    show(known(recall(key)) ? recall(key) : views[0][0]);
  }

  main.append(tabs, body);
  // Back and Forward between views, and links to one, without drawing the whole page again. As the focus stays put,
  // a screen reader hears which view it is
  main.followHash = () => {
    follow();
    announce(views.find(([view]) => view === shown)[1]);
  };
  follow();
}
