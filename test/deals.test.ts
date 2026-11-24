import { GUILD, base, guild, ok } from './apiFixture.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { config } from '../src/config.ts';
import { db } from '../src/db.ts';
import { pauses } from '../src/features/sales.ts';
import { dealBundles, refreshDealBundles } from '../src/features/deals.ts';
import { lookups } from '../src/features/gamefacts.ts';
import { setSetting } from '../src/settings.ts';

// Games › Deals: what's on sale, with the lowest price ever and who it's for, and bundles with games for the server

config.itadKey = 'itad-key';
lookups.gapMs = 0;
pauses.itadMs = 0;
mock.method(console, 'error', () => {});
const DAY = 86_400_000;

const world = { bundles: [] as unknown[], asked: 0 };
const real = fetch;
mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
  if (String(input).startsWith(base)) return real(input, init);
  const url = new URL(input);
  const json = (body: unknown) => new Response(JSON.stringify(body));
  if (url.pathname === '/api/storesearch/') {
    const term = url.searchParams.get('term')!;
    const id = { 'Wanted Game': 9101, Filler: 9102 }[term];
    return json({ items: id ? [{ id, name: term }] : [] });
  }
  if (url.hostname === 'steamspy.com') return json({ positive: 100, negative: 1, tags: {} });
  if (url.hostname === 'api.isthereanydeal.com' && url.pathname === '/bundles/v1') {
    world.asked++;
    return json(Number(url.searchParams.get('offset')) ? [] : world.bundles);
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

const bundlesNow = async () => {
  const data = await ok(`/guilds/${GUILD}/deals`);
  return [data.bundles, data.bundlesOff];
};

function bundle(id: number, title: string, tiers: [number | null, string[]][], expiry: string | null = new Date(Date.now() + 7 * DAY).toISOString()) {
  return {
    id,
    title,
    page: { id: 1, name: 'Humble Bundle' },
    url: `https://bundles.example/${id}`,
    expiry,
    tiers: tiers.map(([dollars, games]) => ({ price: dollars === null ? null : { amountInt: dollars * 100, currency: 'USD' }, games: games.map((t) => ({ title: t, type: 'game' })) })),
  };
}

test('what’s on sale says how it compares with the lowest price ever, and who it’s for', async (t) => {
  db.prepare(`INSERT INTO games (id, guild_id, name, steam_appid, added_by) VALUES (9001, ?, 'Discounted', 9001, 'x'), (9002, ?, 'Not Lowest', 9002, 'x')`).run(GUILD, GUILD);
  db.prepare(`INSERT INTO game_wants (game_id, user_id) VALUES (9001, 'u1'), (9002, 'u2')`).run();
  db.prepare(
    `INSERT INTO sale_prices (country, appid, discount, was, price, final, currency, lowest) VALUES ('us', 9001, 50, '$20.00', '$10.00', 1000, 'USD', 1000), ('us', 9002, 25, '$20.00', '$15.00', 1500, 'USD', 800)`,
  ).run();
  t.after(() => db.exec('DELETE FROM games WHERE id IN (9001, 9002); DELETE FROM game_wants; DELETE FROM sale_prices'));
  const { sales } = await ok(`/guilds/${GUILD}/deals`);
  assert.deepEqual(
    sales.map((g: { name: string; lowest: unknown; people: string[]; why: string }) => [g.name, g.lowest, g.people, g.why]),
    [
      ['Discounted', { yet: true, text: 'Lowest price yet' }, ['u1'], 'Wanted by Ana'],
      ['Not Lowest', { yet: false, text: 'Lowest ever $8.00' }, ['u2'], 'Wanted by Ben'],
    ],
  );
});

test('bundles with a game the server wants are kept with who wants it, and ones that end drop off', async (t) => {
  db.prepare(`INSERT INTO games (id, guild_id, name, steam_appid, added_by) VALUES (9101, ?, 'Wanted Game', 9101, 'x')`).run(GUILD);
  db.prepare(`INSERT INTO game_wants (game_id, user_id) VALUES (9101, 'u1')`).run();
  t.after(() => db.exec(`DELETE FROM games WHERE id = 9101; DELETE FROM game_wants; DELETE FROM kv WHERE key LIKE 'deal_bundles:%'`));
  setSetting(GUILD, 'bundlesLikeWePlay', false);
  // Not looked through yet
  assert.deepEqual(await bundlesNow(), [null, null]);
  const soon = new Date(Date.now() + 60_000).toISOString();
  world.bundles = [
    bundle(1, 'Big Bundle', [
      [5, ['Filler']],
      [12, ['Wanted Game']],
    ]),
    bundle(2, 'Nothing Here', [[5, ['Filler']]]),
    bundle(3, 'Ending Soon', [[null, ['Wanted Game']]], soon),
  ];
  const regions = new Map();
  await refreshDealBundles(guild as never, regions);
  const data = await ok(`/guilds/${GUILD}/deals`);
  assert.ok(Date.now() - data.bundlesAt < 5000);
  assert.deepEqual(
    data.bundles.map((b: { title: string; from: string | null; games: unknown[] }) => [b.title, b.from, b.games]),
    [
      ['Big Bundle', '$5.00', [{ title: 'Wanted Game', url: 'https://store.steampowered.com/app/9101', where: 'in the $12.00 tier', why: 'Wanted by Ana', people: ['u1'] }]],
      ['Ending Soon', null, [{ title: 'Wanted Game', url: 'https://store.steampowered.com/app/9101', where: 'for any price', why: 'Wanted by Ana', people: ['u1'] }]],
    ],
  );
  // Servers in the same region share one list in a run
  const asked = world.asked;
  await refreshDealBundles(guild as never, regions);
  assert.equal(world.asked, asked);
  // A server that turned bundles off isn't shown them, or asked about them
  setSetting(GUILD, 'bundleAlerts', false);
  t.after(() => setSetting(GUILD, 'bundleAlerts', true));
  assert.deepEqual(await bundlesNow(), [null, 'off']);
  await refreshDealBundles(guild as never);
  assert.equal(world.asked, asked);
  setSetting(GUILD, 'bundleAlerts', true);
  // A bundle that's ended since isn't shown
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
  assert.deepEqual(dealBundles(GUILD)?.bundles.map((b) => b.title), ['Big Bundle']);
  t.mock.timers.reset();
});

test('without an IsThereAnyDeal key there are no bundles to show', async (t) => {
  config.itadKey = '';
  t.after(() => (config.itadKey = 'itad-key'));
  assert.deepEqual(await bundlesNow(), [null, 'no-key']);
});
