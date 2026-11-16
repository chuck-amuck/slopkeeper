import { ago, api, attempt, el, notice, recall, remember, request, state } from './lib.js';
import { follow } from './updates.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FILTER_KEY = 'dealsFilter';

const link = (href, text, extra = {}) => el('a', { href, target: '_blank', rel: 'noreferrer', ...extra }, text);

/** How long ago, to the hour while it's recent */
function since(ms) {
  const hours = Math.floor((Date.now() - ms) / HOUR);
  if (hours < 1) return 'under an hour ago';
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  return ago(ms);
}

/** When a bundle ends, in words */
function ends(expiry) {
  if (!expiry) return null;
  const left = Date.parse(expiry) - Date.now();
  if (left < DAY) return 'Ends today';
  const days = Math.round(left / DAY);
  return days === 1 ? 'Ends tomorrow' : `Ends in ${days} days`;
}

/** One game on sale: the deal, how it compares with the lowest ever, any key reseller, and who it's for */
function saleRow(g) {
  const deal = g.store
    ? el('span', { className: 'free-reason' }, `${g.store.price} as a Steam key from `, link(g.store.url, g.store.shop), `, ${g.store.off}% under Steam’s `, el('s', {}, g.was), g.discount ? ` (Steam: ${g.discount}% off, ${g.price})` : '')
    : el('span', { className: 'free-reason' }, el('strong', {}, `${g.discount}% off`), ` ${g.price} `, el('s', {}, g.was));
  const extras = [
    g.lowest && el('span', { className: g.lowest.yet ? 'deal-low best' : 'deal-low' }, g.lowest.text),
    g.keyshop && link(g.keyshop.url, `Key resellers from ${g.keyshop.price}`, { className: 'hint', title: 'The cheapest key reseller, on gg.deals. Check it’s a Steam key that works in your region before buying' }),
  ].filter(Boolean);
  return el(
    'div',
    { className: 'free-game' },
    link(g.url, g.name),
    deal,
    extras.length > 0 && el('span', { className: 'deal-extras' }, ...extras.flatMap((node, i) => (i ? [' · ', node] : [node]))),
    g.why && el('span', { className: 'sale-why' }, g.why),
  );
}

/** One bundle, with the games in it for this server */
function bundleRow(b, games) {
  const facts = [b.site, b.from === null ? 'pay what you want' : `from ${b.from}`, ends(b.expiry)].filter(Boolean).join(' · ');
  return el(
    'div',
    { className: 'free-game deal-bundle' },
    link(b.url, b.title),
    el('span', { className: 'free-reason' }, facts),
    el(
      'ul',
      { className: 'deal-games' },
      games.map((g) => el('li', {}, link(g.url, g.title), ` ${g.where}`, g.why && el('span', { className: 'sale-why' }, g.why))),
    ),
  );
}

/** Deals: what the server plays or wants that's on sale, bundles with games for it, and what's free right now */
export function renderDeals(main) {
  const guildId = state.guildId;
  const me = state.me?.userId ?? null;
  // Just mine needs to know who's looking, which the web UI only does when signed in through Pangolin
  let mine = !!me && recall(FILTER_KEY) === 'mine';
  let data = null;

  const salesBody = el('div', {}, notice('loading', 'Loading what’s on sale…', { compact: true }));
  const bundlesBody = el('div', {}, notice('loading', 'Loading bundles…', { compact: true }));
  const freeBody = el('div', {}, notice('loading', 'Checking what’s free…', { compact: true }));
  const salesTitle = el('h2', {}, 'On sale');
  const bundlesTitle = el('h2', {}, 'Bundles');
  const bundlesNote = el('p', { className: 'card-note', hidden: true });

  const filter = el('div', { className: 'views', role: 'group', ariaLabel: 'Show', hidden: !me });
  function paintFilter() {
    filter.replaceChildren(
      ...[
        [false, 'Everything'],
        [true, 'Just mine'],
      ].map(([just, label]) =>
        el(
          'button',
          {
            type: 'button',
            ...(just === mine && { 'aria-current': 'page' }),
            onclick: () => {
              if (just === mine) return;
              mine = just;
              remember(FILTER_KEY, just ? 'mine' : 'all');
              paintFilter();
              paint();
            },
          },
          label,
        ),
      ),
    );
  }
  paintFilter();

  main.append(
    el('div', { className: 'toolbar deals-toolbar' }, el('p', { className: 'hint' }, 'From the bot’s last price check. Prices are for this server’s Steam region.'), filter),
    el('div', { className: 'stack' }, el('section', { className: 'card' }, salesTitle, salesBody), el('section', { className: 'card' }, bundlesTitle, bundlesNote, bundlesBody), el('section', { className: 'card' }, el('h2', {}, 'Free right now'), freeBody)),
  );

  const forMe = (people) => !mine || people.includes(me);

  function paint() {
    if (!data) return;
    const sales = data.sales.filter((g) => forMe(g.people));
    salesTitle.textContent = sales.length ? `On sale (${sales.length})` : 'On sale';
    salesBody.replaceChildren(
      ...(sales.length
        ? sales.map(saleRow)
        : [notice('empty', mine ? 'Nothing you want or have on your Steam wishlist is on sale right now.' : 'Nothing this server plays or wants is on sale right now.', { compact: true })]),
    );

    bundlesNote.hidden = !data.bundlesAt;
    bundlesNote.textContent = data.bundlesAt ? `Humble Bundle, Fanatical and Green Man Gaming, looked through ${since(data.bundlesAt)}.` : '';
    if (data.bundles === null) {
      const why = {
        'no-key': 'Bundles need an IsThereAnyDeal key, which the bot doesn’t have.',
        off: 'Bundles are turned off in Settings → Sale alerts.',
      };
      bundlesBody.replaceChildren(notice('empty', why[data.bundlesOff] ?? 'Bundles haven’t been looked through yet. They are within a few minutes of the bot starting.', { compact: true }));
      bundlesTitle.textContent = 'Bundles';
      return;
    }
    const bundles = data.bundles.map((b) => [b, b.games.filter((g) => forMe(g.people))]).filter(([, games]) => games.length);
    bundlesTitle.textContent = bundles.length ? `Bundles (${bundles.length})` : 'Bundles';
    bundlesBody.replaceChildren(
      ...(bundles.length
        ? bundles.map(([b, games]) => bundleRow(b, games))
        : [notice('empty', mine ? 'No bundle has a game you want right now.' : 'No bundle running now has a game this server wants or plays something like.', { compact: true })]),
    );
  }

  // Only the newest answer is shown, should two cross
  let ticket = 0;
  async function load() {
    const mine = ++ticket;
    try {
      const fresh = await request(api('/deals'));
      if (mine !== ticket || guildId !== state.guildId || !main.isConnected) return;
      data = fresh;
      paint();
    } catch (err) {
      if (mine !== ticket || guildId !== state.guildId || !main.isConnected) return;
      salesBody.replaceChildren(notice('error', err.message, { compact: true }));
      bundlesBody.replaceChildren();
    }
  }

  async function loadFree() {
    try {
      const { games } = await request(api('/free-games'));
      if (guildId !== state.guildId || !main.isConnected) return;
      const shown = games.filter((g) => g.show);
      freeBody.replaceChildren(
        ...(shown.length
          ? shown.map((g) =>
              el(
                'div',
                { className: 'free-game' },
                g.url.startsWith('https://') ? link(g.url, g.title) : el('span', {}, g.title),
                el('span', { className: 'free-reason' }, [g.worth && `Worth ${g.worth}`, g.platforms].filter(Boolean).join(' · ')),
                g.reason && el('span', { className: 'sale-why' }, g.reason),
              ),
            )
          : [notice('empty', 'Nothing free right now that this server would want.', { compact: true })]),
      );
    } catch (err) {
      if (guildId !== state.guildId || !main.isConnected) return;
      freeBody.replaceChildren(notice('error', err.message, { compact: true }));
    }
  }

  // After each price check and each look through the bundles. The first answer is what the page opened with
  let version = null;
  follow('deals', main, (part) => {
    const seen = version;
    version = part.version;
    if (seen === null || seen === part.version) return;
    void load();
    void loadFree();
  });
  void attempt(load);
  void loadFree();
}
