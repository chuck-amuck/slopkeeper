import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { db } from '../src/db.ts';
import { lookups } from '../src/features/gamefacts.ts';
import { games } from '../src/features/games.ts';
import { checkSales, onSale, pauses, sales, saleReasons, watched, type Sale } from '../src/features/sales.ts';
import { setSetting } from '../src/settings.ts';

const STEAM_ID = (user: string) => `steam-${user}`;
const DAY = 86_400_000;
pauses.steamMs = 0;
pauses.cheapSharkMs = 0;
lookups.gapMs = 0;
mock.method(console, 'error', () => {});
mock.method(console, 'log', () => {});

interface Price {
  discount: number;
  final?: number;
}

/** Steam and CheapShark, answering from what a test puts here */
const world = {
  prices: new Map<number, Price | null>(),
  storeNames: new Map<string, number>(),
  appNames: new Map<number, string>(),
  wishlists: new Map<string, number[] | 'down'>(),
  lowest: new Map<number, string>(),
  pricesDown: false,
  cheapSharkDown: false,
  batches: [] as number[][],
  userAgents: [] as (string | null)[],
};

const json = (body: unknown) => new Response(JSON.stringify(body));

mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
  const url = new URL(input);
  if (url.pathname === '/api/appdetails') {
    if (world.pricesDown) return new Response('', { status: 503 });
    const appids = url.searchParams.get('appids')!.split(',').map(Number);
    world.batches.push(appids);
    return json(
      Object.fromEntries(
        appids.map((appid) => {
          const price = world.prices.get(appid);
          const final = price?.final ?? 1000;
          const data = price
            ? { price_overview: { discount_percent: price.discount, initial_formatted: price.discount ? '$20.00' : '', final_formatted: `$${(final / 100).toFixed(2)}`, final } }
            : [];
          return [appid, { success: true, data }];
        }),
      ),
    );
  }
  if (url.pathname === '/api/storesearch/') {
    const term = url.searchParams.get('term')!;
    const id = world.storeNames.get(term);
    return json({ items: id ? [{ id, name: term }] : [] });
  }
  if (url.hostname === 'steamspy.com') return json({ positive: 10, negative: 1, tags: [] });
  if (url.pathname.includes('GetWishlist')) {
    const items = world.wishlists.get(url.searchParams.get('steamid')!);
    if (items === 'down') return new Response('', { status: 500 });
    return json({ response: items ? { items: items.map((appid) => ({ appid })) } : {} });
  }
  if (url.pathname.includes('GetItems')) {
    const ids = JSON.parse(url.searchParams.get('input_json')!).ids as { appid: number }[];
    return json({ response: { store_items: ids.map(({ appid }) => ({ appid, success: 1, name: world.appNames.get(appid) })) } });
  }
  if (url.hostname === 'www.cheapshark.com') {
    world.userAgents.push(new Headers(init?.headers).get('user-agent'));
    if (world.cheapSharkDown) return new Response('', { status: 500 });
    const steam = url.searchParams.get('steamAppID');
    if (steam) return json(world.lowest.has(Number(steam)) ? [{ gameID: steam }] : []);
    return json({ cheapestPriceEver: { price: world.lowest.get(Number(url.searchParams.get('id'))) } });
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

function fresh() {
  world.prices.clear();
  world.storeNames.clear();
  world.appNames.clear();
  world.wishlists.clear();
  world.lowest.clear();
  world.pricesDown = false;
  world.cheapSharkDown = false;
  world.batches.length = 0;
  world.userAgents.length = 0;
  // Steam links belong to people, not servers, so one test's would leak into the next
  db.exec('DELETE FROM steam_links; DELETE FROM steam_owned; DELETE FROM steam_wishlist;');
}

let nextServer = 0;

/** A server with these members, whose sale posts land in the list it returns */
function server(members: string[]) {
  const id = `server-${++nextServer}`;
  fresh();
  setSetting(id, 'announceChannel', `channel-${id}`);
  const guild = { id, name: id, members: { cache: new Map(members.map((m) => [m, { id: m }])) } };
  const posts: { content?: string; embeds: { toJSON(): { title: string; description: string } }[]; allowedMentions: { users: string[] } }[] = [];
  const client = fakeClient([guild], async (_, message) => {
    posts.push(message as never);
  });
  return { id, guild: guild as never, client, posts, text: () => posts.at(-1)?.embeds[0].toJSON().description ?? '', pinged: () => posts.at(-1)?.allowedMentions.users ?? [] };
}

const addGame = (guildId: string, name: string, appid: number | null) =>
  Number(db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, ?, 'x')`).run(guildId, name, appid).lastInsertRowid);
const markOwned = (gameId: number, user: string) => db.prepare('INSERT INTO game_owners (game_id, user_id) VALUES (?, ?)').run(gameId, user);
const want = (gameId: number, user: string) => db.prepare('INSERT INTO game_wants (game_id, user_id) VALUES (?, ?)').run(gameId, user);
function linkSteam(user: string, owned: number[] = [], isPrivate = 0) {
  const steamId = STEAM_ID(user);
  db.prepare('INSERT OR REPLACE INTO steam_links (user_id, steam_id, private, refreshed_at) VALUES (?, ?, ?, ?)').run(user, steamId, isPrivate, Date.now());
  for (const appid of owned) db.prepare('INSERT OR IGNORE INTO steam_owned (steam_id, appid, playtime) VALUES (?, ?, 0)').run(steamId, appid);
}
function played(guildId: string, user: string, game: string, appid: number, daysAgo = 1, hours = 2) {
  world.storeNames.set(game, appid);
  const end = Date.now() - daysAgo * DAY;
  db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at, channel_id) VALUES (?, ?, ?, ?, ?, 'voice')`).run(guildId, user, game, end - hours * 3_600_000, end);
}

test('a library game on sale is posted once, naming the price and who needs it', async () => {
  const s = server(['a', 'b']);
  const id = addGame(s.id, 'Valheim', 10);
  markOwned(id, 'a');
  markOwned(addGame(s.id, 'Other', null), 'b');
  world.prices.set(10, { discount: 40, final: 1200 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].embeds[0].toJSON().title, '💸 1 game on sale');
  assert.match(s.text(), /\[\*\*Valheim\*\*\]\(https:\/\/store\.steampowered\.com\/app\/10\): 40% off, \$12\.00, was \$20\.00\./);
  assert.match(s.text(), /Needs it: <@b>/);
  assert.equal(s.posts[0].content, '<@b>');
  assert.deepEqual(s.pinged(), ['b']);
  await checkSales(s.client);
  assert.equal(s.posts.length, 1, 'the same sale isn’t posted twice');
});

test('a game played here is watched without anyone adding it', async () => {
  const s = server(['a', 'b']);
  linkSteam('b');
  played(s.id, 'a', 'Deep Rock Galactic', 11, 3, 14);
  world.prices.set(11, { discount: 50 });
  await checkSales(s.client);
  assert.match(s.text(), /Deep Rock Galactic/);
  assert.match(s.text(), /Played 14h/);
  assert.deepEqual(s.pinged(), ['b'], 'who played it has it, so only the other person hears');
});

test('a game last played over 180 days ago isn’t watched', async () => {
  const s = server(['a', 'b']);
  linkSteam('b');
  played(s.id, 'a', 'Old Favourite', 12, 181);
  world.prices.set(12, { discount: 50 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 0);
  assert.equal(world.batches.flat().includes(12), false);
});

test('someone who played a game long ago still isn’t told they need it', async () => {
  const s = server(['a', 'b', 'c']);
  linkSteam('c');
  linkSteam('b');
  played(s.id, 'a', 'Long Runner', 13, 2);
  played(s.id, 'b', 'Long Runner', 13, 400);
  world.prices.set(13, { discount: 50 });
  await checkSales(s.client);
  assert.deepEqual(s.pinged(), ['c']);
});

test('a played game that isn’t on Steam is skipped', async () => {
  const s = server(['a', 'b']);
  linkSteam('b');
  played(s.id, 'a', 'League of Legends', 14);
  world.storeNames.delete('League of Legends');
  await checkSales(s.client);
  assert.equal(s.posts.length, 0);
  assert.deepEqual(world.batches, []);
});

test('a game someone wanted pings them, and not the whole group', async () => {
  const s = server(['a', 'b', 'c']);
  linkSteam('b');
  linkSteam('c');
  want(addGame(s.id, 'Hades', 15), 'a');
  world.prices.set(15, { discount: 50 });
  await checkSales(s.client);
  assert.match(s.text(), /Wanted by <@a>/);
  assert.deepEqual(s.pinged(), ['a']);
});

test('someone who bought a game they wanted stops hearing about it', async () => {
  const s = server(['a', 'b']);
  linkSteam('a', [16]);
  want(addGame(s.id, 'Bought It', 16), 'a');
  world.prices.set(16, { discount: 50 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 0);
});

test('Steam wishlists are watched, and only ping the person who has one', async () => {
  const s = server(['a', 'b']);
  linkSteam('a');
  linkSteam('b');
  world.wishlists.set(STEAM_ID('a'), [17]);
  world.appNames.set(17, 'Wishlisted Game');
  world.prices.set(17, { discount: 50 });
  await checkSales(s.client);
  assert.match(s.text(), /Wishlisted Game/);
  assert.match(s.text(), /On <@a>’s Steam wishlist/);
  assert.deepEqual(s.pinged(), ['a']);
});

test('several wishlists are listed together', async () => {
  const s = server(['a', 'b']);
  linkSteam('a');
  linkSteam('b');
  world.wishlists.set(STEAM_ID('a'), [18]);
  world.wishlists.set(STEAM_ID('b'), [18]);
  world.prices.set(18, { discount: 50 });
  await checkSales(s.client);
  assert.match(s.text(), /On Steam wishlists: <@a>, <@b>/);
  assert.deepEqual(s.pinged().sort(), ['a', 'b']);
});

test('wishlists can be turned off for a server', async () => {
  const s = server(['a']);
  linkSteam('a');
  world.wishlists.set(STEAM_ID('a'), [19]);
  world.prices.set(19, { discount: 50 });
  setSetting(s.id, 'saleSteamWishlists', false);
  await checkSales(s.client);
  assert.equal(s.posts.length, 0);
});

test('a wishlist that can’t be read keeps its games, and an empty one loses them', async () => {
  const s = server(['a']);
  linkSteam('a');
  world.wishlists.set(STEAM_ID('a'), [20]);
  await checkSales(s.client);
  world.wishlists.set(STEAM_ID('a'), 'down');
  await checkSales(s.client);
  const held = () => db.prepare('SELECT appid FROM steam_wishlist WHERE steam_id = ?').all(STEAM_ID('a')).length;
  assert.equal(held(), 1);
  world.wishlists.delete(STEAM_ID('a'));
  await checkSales(s.client);
  assert.equal(held(), 0);
});

test('one game on several lists appears once, with every reason, and people aren’t named twice', async () => {
  const s = server(['a', 'b', 'c', 'd']);
  linkSteam('a');
  linkSteam('b');
  linkSteam('c');
  linkSteam('d');
  const id = addGame(s.id, 'Everywhere', 21);
  want(id, 'a');
  world.wishlists.set(STEAM_ID('a'), [21]);
  world.wishlists.set(STEAM_ID('b'), [21]);
  played(s.id, 'c', 'Everywhere', 21);
  world.prices.set(21, { discount: 50 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
  assert.equal(s.text().split('\n').length, 1);
  assert.match(s.text(), /Played 2h · Wanted by <@a> · On <@b>’s Steam wishlist · Needs it: <@d>/);
  assert.deepEqual(s.pinged().sort(), ['a', 'b', 'd']);
});

test('people with private libraries aren’t pinged unless they asked', async () => {
  const s = server(['a', 'b', 'c']);
  linkSteam('a');
  linkSteam('b', [], 1);
  linkSteam('c', [], 1);
  addGame(s.id, 'Unknown Owners', 22);
  world.prices.set(22, { discount: 50 });
  await checkSales(s.client);
  assert.deepEqual(s.pinged(), ['a']);

  const t = server(['a', 'b', 'c']);
  linkSteam('b', [], 1);
  want(addGame(t.id, 'Asked For', 23), 'b');
  world.prices.set(23, { discount: 50 });
  await checkSales(t.client);
  assert.deepEqual(t.pinged(), ['b']);
});

test('people who left aren’t pinged or counted', async () => {
  const s = server(['a', 'b']);
  linkSteam('a');
  linkSteam('b');
  linkSteam('gone');
  world.wishlists.set(STEAM_ID('gone'), [24]);
  world.prices.set(24, { discount: 50 });
  want(addGame(s.id, 'Left Behind', 25), 'gone');
  world.prices.set(25, { discount: 50 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 0);
});

test('a played or library game nobody needs isn’t posted, but with no group a library game still is', async () => {
  const s = server(['a']);
  linkSteam('a', [26]);
  addGame(s.id, 'All Owned', 26);
  world.prices.set(26, { discount: 50 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 0);

  const t = server([]);
  addGame(t.id, 'Nobody Linked', 27);
  world.prices.set(27, { discount: 50 });
  await checkSales(t.client);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].content, undefined);
});

test('“Never suggest this” stops played and wishlisted games, but not wanted ones', async () => {
  const s = server(['a', 'b']);
  linkSteam('a');
  linkSteam('b');
  const hide = (appid: number) => db.prepare(`INSERT INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES (?, ?, 'x', 'x')`).run(s.id, appid);
  played(s.id, 'a', 'Hidden Played', 28);
  world.wishlists.set(STEAM_ID('a'), [29]);
  want(addGame(s.id, 'Hidden Wanted', 30), 'a');
  for (const appid of [28, 29, 30]) {
    hide(appid);
    world.prices.set(appid, { discount: 50 });
  }
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
  assert.doesNotMatch(s.text(), /Hidden Played|App 29/);
  assert.match(s.text(), /Hidden Wanted/);
});

test('sales under the smallest discount aren’t posted, and each server sets its own', async () => {
  const s = server(['a']);
  addGame(s.id, 'Small', 31);
  world.prices.set(31, { discount: 24 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 0);
  world.prices.set(31, { discount: 25 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);

  const t = server(['a']);
  setSetting(t.id, 'saleMinDiscount', 60);
  addGame(t.id, 'Picky', 32);
  world.prices.set(32, { discount: 59 });
  await checkSales(t.client);
  assert.equal(t.posts.length, 0);
});

test('a running sale only posts again when it’s at least 10 points deeper', async () => {
  const s = server(['a']);
  addGame(s.id, 'Deeper', 33);
  world.prices.set(33, { discount: 50 });
  await checkSales(s.client);
  world.prices.set(33, { discount: 59 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
  world.prices.set(33, { discount: 60 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 2);
});

test('a sale that ends and comes back is news again', async () => {
  const s = server(['a']);
  addGame(s.id, 'Returning', 34);
  world.prices.set(34, { discount: 50 });
  await checkSales(s.client);
  world.prices.set(34, { discount: 0 });
  await checkSales(s.client);
  assert.equal(db.prepare('SELECT 1 FROM sale_alerts WHERE guild_id = ? AND appid = 34').get(s.id), undefined);
  world.prices.set(34, { discount: 50 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 2);
});

test('a smaller sale after a bigger one counts from where it is now', async () => {
  const s = server(['a']);
  addGame(s.id, 'Shrinking', 35);
  world.prices.set(35, { discount: 60 });
  await checkSales(s.client);
  world.prices.set(35, { discount: 30 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
  world.prices.set(35, { discount: 40 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 2);
});

test('a game that stops being sold counts as not on sale', async () => {
  const s = server(['a']);
  addGame(s.id, 'Delisted', 36);
  world.prices.set(36, { discount: 50 });
  await checkSales(s.client);
  world.prices.set(36, null);
  await checkSales(s.client);
  assert.equal(db.prepare('SELECT 1 FROM sale_alerts WHERE guild_id = ? AND appid = 36').get(s.id), undefined);
  assert.deepEqual(await onSale(s.guild), []);
});

test('a failed price check changes nothing', async () => {
  const s = server(['a']);
  addGame(s.id, 'Steady', 37);
  world.prices.set(37, { discount: 50 });
  await checkSales(s.client);
  world.pricesDown = true;
  await checkSales(s.client);
  assert.equal((await onSale(s.guild)).length, 1, 'the last good price stays listed');
  world.pricesDown = false;
  await checkSales(s.client);
  assert.equal(s.posts.length, 1, 'the sale isn’t mistaken for a new one');
});

test('a sale post that fails is tried again, and doesn’t hold up other servers', async () => {
  fresh();
  const members = { cache: new Map() };
  const guilds = ['fail-a', 'fail-b'].map((id) => ({ id, name: id.toUpperCase(), members }));
  for (const { id } of guilds) {
    setSetting(id, 'announceChannel', `channel-${id}`);
    addGame(id, 'Game', 38);
  }
  world.prices.set(38, { discount: 40 });

  const sent: string[] = [];
  let aWorks = false;
  const client = fakeClient(guilds, async (guildId) => {
    if (guildId === 'fail-a' && !aWorks) throw new Error('Missing Permissions');
    sent.push(guildId);
  });

  await checkSales(client);
  assert.deepEqual(sent, ['fail-b']);
  aWorks = true;
  await checkSales(client);
  assert.deepEqual(sent, ['fail-b', 'fail-a'], 'b isn’t told about the same sale twice');
});

test('servers share one price check', async () => {
  fresh();
  const members = { cache: new Map() };
  const guilds = ['share-a', 'share-b'].map((id) => ({ id, name: id, members }));
  for (const { id } of guilds) {
    setSetting(id, 'announceChannel', `channel-${id}`);
    addGame(id, 'Shared', 39);
  }
  world.prices.set(39, { discount: 40 });
  await checkSales(fakeClient(guilds, async () => {}));
  assert.equal(world.batches.filter((b) => b.includes(39)).length, 1);
});

test('prices are asked for 50 at a time', async () => {
  const s = server(['a']);
  for (let n = 0; n < 51; n++) addGame(s.id, `Batch ${n}`, 1000 + n);
  await checkSales(s.client);
  assert.deepEqual(world.batches.map((b) => b.length), [50, 1]);
});

test('one post holds a whole sale, with the most wanted first', async () => {
  const s = server(['a', 'b', 'c']);
  linkSteam('a');
  linkSteam('b');
  linkSteam('c');
  world.prices.set(40, { discount: 80 });
  addGame(s.id, 'Just Library', 40);
  played(s.id, 'a', 'Played Lots', 41, 1, 50);
  played(s.id, 'a', 'Played Less', 42, 1, 5);
  world.prices.set(41, { discount: 30 });
  world.prices.set(42, { discount: 30 });
  const wanted = addGame(s.id, 'Most Wanted', 43);
  want(wanted, 'b');
  want(wanted, 'c');
  world.prices.set(43, { discount: 26 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
  const order = s.text().split('\n').map((l) => l.match(/\*\*(.+?)\*\*/)![1]);
  assert.deepEqual(order, ['Most Wanted', 'Played Lots', 'Played Less', 'Just Library']);
  assert.equal(s.posts[0].embeds[0].toJSON().title, '💸 4 games on sale');
});

test('10 games fit in a post, and the 11th sends people to /sales, with everyone still pinged', async () => {
  const s = server(['a', ...Array.from({ length: 11 }, (_, n) => `who${n}`)]);
  const ten = async (count: number, base: number) => {
    for (let n = 0; n < count; n++) {
      want(addGame(s.id, `Game ${base + n}`, base + n), `who${n}`);
      world.prices.set(base + n, { discount: 50 });
    }
  };
  await ten(10, 2000);
  await checkSales(s.client);
  assert.equal(s.text().split('\n').length, 10);
  assert.doesNotMatch(s.text(), /more/);

  const t = server(['a', ...Array.from({ length: 11 }, (_, n) => `who${n}`)]);
  for (let n = 0; n < 11; n++) {
    want(addGame(t.id, `Game ${n}`, 2100 + n), `who${n}`);
    world.prices.set(2100 + n, { discount: 50 });
  }
  await checkSales(t.client);
  const lines = t.text().split('\n');
  assert.equal(lines.length, 11);
  assert.equal(lines[10], 'and 1 more: `/sales`');
  assert.equal(t.pinged().length, 11);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sale_alerts WHERE guild_id = ?').get(t.id)!.n, 11, 'the one left out isn’t posted again next time');
});

test('the biggest possible post stays inside Discord’s limits', async () => {
  const people = Array.from({ length: 120 }, (_, n) => `${100000000000000000n + BigInt(n)}`);
  const s = server(people);
  for (const id of people) linkSteam(id);
  for (let n = 0; n < 12; n++) {
    addGame(s.id, `${'[Long*name] '.repeat(9)}${n}`, 3000 + n);
    world.prices.set(3000 + n, { discount: 50 });
  }
  await checkSales(s.client);
  const post = s.posts[0];
  assert.ok(post.embeds[0].toJSON().description.length <= 4096);
  assert.ok(post.content!.length <= 2000);
  assert.ok(post.allowedMentions.users.length <= 100);
  assert.match(s.text(), /\+115 more/);
  assert.doesNotMatch(s.text(), /\[\*\*\[|\]\*\*\]/, 'brackets in a name can’t break the link');
});

test('the lowest ever price is shown, and matching it counts as the lowest yet', async () => {
  const s = server(['a']);
  addGame(s.id, 'Beaten', 50);
  addGame(s.id, 'Matched', 51);
  addGame(s.id, 'Not Yet', 52);
  world.prices.set(50, { discount: 50, final: 599 });
  world.prices.set(51, { discount: 50, final: 600 });
  world.prices.set(52, { discount: 50, final: 601 });
  for (const appid of [50, 51, 52]) world.lowest.set(appid, '6.00');
  await checkSales(s.client);
  const [beaten, matched, notYet] = s.text().split('\n');
  assert.match(beaten, /was \$20\.00\. Lowest price yet\./);
  assert.match(matched, /Lowest price yet\./);
  assert.match(notYet, /Lowest ever \$6\.00\./);
  assert.ok(world.userAgents.every((ua) => ua?.includes('slopkeeper')), 'CheapShark refuses requests that don’t say who they’re from');
});

test('a post goes out without the lowest price if CheapShark fails or doesn’t know the game', async () => {
  const s = server(['a']);
  addGame(s.id, 'Unknown', 53);
  world.prices.set(53, { discount: 50 });
  world.cheapSharkDown = true;
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
  assert.doesNotMatch(s.text(), /Lowest/);

  const t = server(['a']);
  addGame(t.id, 'Not Tracked', 54);
  world.prices.set(54, { discount: 50 });
  await checkSales(t.client);
  assert.equal(t.posts.length, 1);
  assert.doesNotMatch(t.text(), /Lowest/);
});

test('the lowest price only shows for the US region, where it’s in the same money', async () => {
  const s = server(['a']);
  setSetting(s.id, 'steamCountry', 'gb');
  addGame(s.id, 'Abroad', 55);
  world.prices.set(55, { discount: 50 });
  world.lowest.set(55, '1.00');
  await checkSales(s.client);
  assert.doesNotMatch(s.text(), /Lowest/);
  assert.deepEqual(world.userAgents, []);
});

test('only games in the post are looked up on CheapShark', async () => {
  const s = server(['a']);
  for (let n = 0; n < 12; n++) {
    addGame(s.id, `Many ${n}`, 4000 + n);
    world.prices.set(4000 + n, { discount: 50 });
  }
  await checkSales(s.client);
  assert.equal(world.userAgents.length, 10);
});

test('sales post to their own channel if a server picks one', async () => {
  const s = server(['a']);
  setSetting(s.id, 'saleChannel', `channel-${s.id}`);
  setSetting(s.id, 'announceChannel', '');
  addGame(s.id, 'Channelled', 56);
  world.prices.set(56, { discount: 50 });
  await checkSales(s.client);
  assert.equal(s.posts.length, 1);
});

test('nothing is checked for a server with nowhere to post', async () => {
  const s = server(['a']);
  setSetting(s.id, 'announceChannel', '');
  addGame(s.id, 'Silent', 57);
  await checkSales(s.client);
  assert.deepEqual(world.batches, []);
});

test('/sales lists what’s on sale from the last check, without asking Steam', async () => {
  const s = server(['a', 'b']);
  linkSteam('b');
  addGame(s.id, 'Small Sale', 58);
  addGame(s.id, 'Big Sale', 59);
  world.prices.set(58, { discount: 10 });
  world.prices.set(59, { discount: 75 });
  await checkSales(s.client);
  world.pricesDown = true;
  let reply: { embeds: { toJSON(): { description: string; title: string } }[]; allowedMentions: unknown } | undefined;
  await sales.commands![0].run({ inCachedGuild: () => true, guild: s.guild, deferReply: async () => {}, editReply: async (r: typeof reply) => (reply = r) } as never);
  const { description, title } = reply!.embeds[0].toJSON();
  assert.equal(title, '💸 2 games on sale');
  assert.match(description, /Small Sale/, 'it shows sales too small to post');
  assert.match(description, /Big Sale/);
  assert.deepEqual(reply!.allowedMentions, { parse: [] });
});

test('/sales says so when nothing is on sale', async () => {
  const s = server(['a']);
  let reply: unknown;
  await sales.commands![0].run({ inCachedGuild: () => true, guild: s.guild, deferReply: async () => {}, editReply: async (r: unknown) => (reply = r) } as never);
  assert.match(reply as string, /Nothing/);
});

test('a long /sales says how many didn’t fit', async () => {
  const s = server(['a']);
  for (let n = 0; n < 60; n++) {
    addGame(s.id, `${'Extremely long title '.repeat(3)}${n}`, 5000 + n);
    world.prices.set(5000 + n, { discount: 50 });
  }
  await checkSales(s.client);
  let reply: { embeds: { toJSON(): { description: string; footer?: { text: string } } }[] } | undefined;
  await sales.commands![0].run({ inCachedGuild: () => true, guild: s.guild, deferReply: async () => {}, editReply: async (r: typeof reply) => (reply = r) } as never);
  const { description, footer } = reply!.embeds[0].toJSON();
  assert.ok(description.length <= 4096);
  const shown = description.split('\n').length;
  assert.equal(footer?.text, `and ${60 - shown} more`);
});

test('a wishlisted game with no name yet shows its Steam name, or its number if Steam has none', async () => {
  const s = server(['a']);
  linkSteam('a');
  world.wishlists.set(STEAM_ID('a'), [60]);
  world.prices.set(60, { discount: 50 });
  await checkSales(s.client);
  assert.match(s.text(), /App 60/);
});

test('watched leaves out games nobody needs', async () => {
  const s = server(['a']);
  linkSteam('a', [61]);
  addGame(s.id, 'Have It', 61);
  assert.deepEqual(await watched(s.guild), []);
});

test('long lists of people are cut short', () => {
  const sale = { playedMs: 0, wanted: ['1', '2', '3', '4', '5', '6', '7'], wishlisted: [], others: [] } as unknown as Sale;
  assert.equal(saleReasons(sale, (id) => id), 'Wanted by 1, 2, 3, 4, 5 +2 more');
});

/** Runs /game want, and returns the reply */
async function runWant(s: ReturnType<typeof server>, user: string, name: string) {
  let reply: string | { content: string } | undefined;
  await games.commands![0].run({
    inCachedGuild: () => true,
    guildId: s.id,
    guild: s.guild,
    user: { id: user },
    options: { getSubcommand: () => 'want', getString: () => name },
    deferReply: async () => {},
    editReply: async (r: typeof reply) => (reply = r),
  } as never);
  return typeof reply === 'string' ? reply : reply!.content;
}
const wantsOf = (user: string) => db.prepare('SELECT g.name, g.steam_appid FROM game_wants w JOIN games g ON g.id = w.game_id WHERE w.user_id = ?').all(user).map((r) => ({ ...r }));

test('/game want marks a library game, and running it again takes it back', async () => {
  const s = server(['want1']);
  addGame(s.id, 'Library Game', 70);
  assert.match(await runWant(s, 'want1', 'Library Game'), /pinged when \*\*Library Game\*\*/);
  assert.deepEqual(wantsOf('want1'), [{ name: 'Library Game', steam_appid: 70 }]);
  assert.match(await runWant(s, 'want1', 'Library Game'), /no longer/);
  assert.deepEqual(wantsOf('want1'), []);
});

test('/game want finds a new game on Steam and adds it to the library', async () => {
  const s = server(['want2']);
  world.storeNames.set('Brand New', 71);
  await runWant(s, 'want2', 'Brand New');
  assert.deepEqual(wantsOf('want2'), [{ name: 'Brand New', steam_appid: 71 }]);
});

test('/game want takes a store link and uses Steam’s name', async () => {
  const s = server(['want3']);
  world.appNames.set(72, 'Linked Game');
  await runWant(s, 'want3', 'https://store.steampowered.com/app/72/Linked_Game/');
  assert.deepEqual(wantsOf('want3'), [{ name: 'Linked Game', steam_appid: 72 }]);
});

test('/game want with a link to a game already in the library uses that entry', async () => {
  const s = server(['want4']);
  addGame(s.id, 'My Name For It', 73);
  world.appNames.set(73, 'Steam Name For It');
  await runWant(s, 'want4', 'https://store.steampowered.com/app/73');
  assert.deepEqual(wantsOf('want4'), [{ name: 'My Name For It', steam_appid: 73 }]);
});

test('/game want gives a library game with no Steam ID its ID', async () => {
  const s = server(['want5']);
  addGame(s.id, 'No Id Yet', null);
  world.storeNames.set('No Id Yet', 74);
  await runWant(s, 'want5', 'No Id Yet');
  assert.deepEqual(wantsOf('want5'), [{ name: 'No Id Yet', steam_appid: 74 }]);
});

test('/game want asks for a link when Steam can’t find a game', async () => {
  const s = server(['want6']);
  assert.match(await runWant(s, 'want6', 'Made Up Game'), /Paste its store link/);
  assert.match(await runWant(s, 'want6', 'https://store.steampowered.com/app/999999'), /Paste its store link/);
  assert.deepEqual(wantsOf('want6'), []);
});

test('/game want treats a game called a number as a name', async () => {
  const s = server(['want7']);
  world.storeNames.set('1979', 75);
  await runWant(s, 'want7', '1979');
  assert.deepEqual(wantsOf('want7'), [{ name: '1979', steam_appid: 75 }]);
});

test('/game want says so if you already own it', async () => {
  const s = server(['want8']);
  linkSteam('want8', [76]);
  addGame(s.id, 'Already Mine', 76);
  assert.match(await runWant(s, 'want8', 'Already Mine'), /already own/);
  assert.deepEqual(wantsOf('want8'), []);
});

test('/game want reports Steam being down rather than a missing game', async () => {
  const s = server(['want9']);
  const fetcher = globalThis.fetch as unknown as ReturnType<typeof mock.fn>;
  fetcher.mock.mockImplementationOnce(async () => new Response('', { status: 503 }));
  assert.match(await runWant(s, 'want9', 'Anything'), /couldn’t be reached/);
});

test('removing a game forgets who wanted it', () => {
  const s = server(['gone1']);
  const id = addGame(s.id, 'Removed', 77);
  want(id, 'gone1');
  db.prepare('DELETE FROM games WHERE id = ?').run(id);
  assert.deepEqual(wantsOf('gone1'), []);
});

test('/game list shows who wants what', async () => {
  const s = server(['lister']);
  want(addGame(s.id, 'Listed', 78), 'lister');
  let reply: { embeds: { toJSON(): { description: string } }[] } | undefined;
  await games.commands![0].run({
    inCachedGuild: () => true,
    guildId: s.id,
    guild: s.guild,
    options: { getSubcommand: () => 'list' },
    reply: async (r: typeof reply) => (reply = r),
  } as never);
  assert.match(reply!.embeds[0].toJSON().description, /wanted: <@lister>/);
});
