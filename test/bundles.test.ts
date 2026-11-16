import { fakeClient } from './helpers.ts';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { config } from '../src/config.ts';
import { db, setKv } from '../src/db.ts';
import { postDailyBundles as checkBundles } from '../src/features/bundles.ts';
import { lookups } from '../src/features/gamefacts.ts';
import { pauses, postDay } from '../src/features/sales.ts';
import { setSetting } from '../src/settings.ts';

config.itadKey = 'itad-key';
lookups.gapMs = 0;
pauses.itadMs = 0;
mock.method(console, 'error', () => {});
const DAY = 86_400_000;
const LATER = new Date(Date.now() + 7 * DAY).toISOString();

/** Steam's games by name with their tags, and IsThereAnyDeal's bundles */
const world = {
  apps: new Map<string, { id: number; tags: string[] }>(),
  bundles: [] as unknown[],
  asked: [] as URLSearchParams[],
};

mock.method(globalThis, 'fetch', async (input: string | URL) => {
  const url = new URL(input);
  const json = (body: unknown) => new Response(JSON.stringify(body));
  if (url.pathname === '/api/storesearch/') {
    const term = url.searchParams.get('term')!;
    const app = world.apps.get(term);
    return json({ items: app ? [{ id: app.id, name: term }] : [] });
  }
  if (url.hostname === 'steamspy.com') {
    const appid = Number(url.searchParams.get('appid'));
    const tags = [...world.apps.values()].find((a) => a.id === appid)?.tags ?? [];
    return json({ positive: 100, negative: 1, tags: Object.fromEntries(tags.map((tag, n) => [tag, 1000 - n])) });
  }
  if (url.hostname === 'api.isthereanydeal.com' && url.pathname === '/bundles/v1') {
    world.asked.push(url.searchParams);
    const offset = Number(url.searchParams.get('offset'));
    return json(world.bundles.slice(offset, offset + Number(url.searchParams.get('limit'))));
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

const HUMBLE = { id: 1, name: 'Humble Bundle' };
function bundle(id: number, title: string, tiers: [number, string[]][], { page = HUMBLE, expiry = LATER as string | null } = {}) {
  return {
    id,
    title,
    page,
    url: `https://bundles.example/${id}`,
    expiry,
    tiers: tiers.map(([dollars, games]) => ({
      price: { amount: dollars, amountInt: dollars * 100, currency: 'USD' },
      games: games.map((title) => ({ title, type: title.endsWith('Soundtrack') ? 'dlc' : 'game' })),
    })),
  };
}

let nextServer = 0;
function server(members: string[]) {
  const id = `bundles-${++nextServer}`;
  world.bundles = [];
  world.asked = [];
  setSetting(id, 'announceChannel', `channel-${id}`);
  // Posting at midnight means any time of day is after it
  setSetting(id, 'salePostHour', 0);
  // Bundles wait for the day's sale post, which these tests don't make
  setKv(`sale_post:${id}`, todayFor(id));
  const guild = { id, name: id, members: { cache: new Map(members.map((m) => [m, { id: m }])) } };
  const posts: { content?: string; embeds: { toJSON(): { title: string; url: string; description: string; footer: { text: string } } }[]; allowedMentions: { users: string[] } }[] = [];
  const client = fakeClient([guild], async (_, message) => void posts.push(message as never));
  return { id, client, posts, last: () => posts.at(-1)!.embeds[0].toJSON(), nextDay: () => setKv(`bundle_post:${id}`, '') };
}

function todayFor(id: string) {
  return postDay(id)!;
}

function wanted(guildId: string, name: string, appid: number, user: string) {
  world.apps.set(name, { id: appid, tags: [] });
  const gameId = db.prepare(`INSERT INTO games (guild_id, name, steam_appid, added_by) VALUES (?, ?, ?, 'x')`).run(guildId, name, appid).lastInsertRowid;
  db.prepare('INSERT INTO game_wants (game_id, user_id) VALUES (?, ?)').run(gameId, user);
}

/** A server that plays these games, most played first */
function plays(guildId: string, games: [string, number, string[]][]) {
  games.forEach(([name, appid, tags], n) => {
    world.apps.set(name, { id: appid, tags });
    const end = Date.now() - DAY;
    db.prepare(`INSERT INTO game_plays (guild_id, user_id, game, started_at, ended_at, channel_id) VALUES (?, 'player', ?, ?, ?, 'voice')`).run(guildId, name, end - (10 - n) * 3_600_000, end);
  });
}

test('a bundle with a game someone wants is posted once, naming the tier and pinging them', async () => {
  const s = server(['a', 'b']);
  wanted(s.id, 'Wanted Game', 9101, 'a');
  world.apps.set('Filler', { id: 9102, tags: [] });
  world.bundles = [
    // Listed dearest first, which the post doesn't follow
    bundle(1, 'Big Bundle ', [
      [12, ['Wanted Game']],
      [5, ['Filler', 'Filler Soundtrack']],
    ]),
    bundle(2, 'Nothing Here', [[5, ['Filler']]]),
    bundle(3, 'On itch.io', [[5, ['Wanted Game']]], { page: { id: 67, name: 'Itch.io' } }),
    bundle(4, 'Already Over', [[5, ['Wanted Game']]], { expiry: new Date(Date.now() - DAY).toISOString() }),
    // The same bundle under Green Man Gaming's other name
    bundle(9, 'Big Bundle', [[12, ['Wanted Game']]], { page: { id: 47, name: 'GreenMan Gaming' } }),
  ];
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1);
  const post = s.last();
  assert.equal(post.title, '📦 Big Bundle');
  assert.equal(post.url, 'https://bundles.example/1');
  assert.match(post.description, /^\[\*\*Wanted Game\*\*\]\(https:\/\/store\.steampowered\.com\/app\/9101\) in the \$12\.00 tier: Wanted by <@a>\n\nEnds <t:\d+:R>$/);
  assert.equal(post.footer.text, 'Humble Bundle · from $5.00');
  assert.deepEqual(s.posts[0].allowedMentions.users, ['a']);
  assert.equal(world.asked[0].get('country'), 'US');
  assert.equal(world.asked[0].get('key'), 'itad-key');
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1, 'not again the same day');
  s.nextDay();
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1, 'not posted again');
});

test('a bundle nobody wanted anything from is posted once someone does', async () => {
  const s = server(['a']);
  world.apps.set('Later Game', { id: 9103, tags: [] });
  world.bundles = [bundle(5, 'Later Bundle', [[10, ['Later Game']]])];
  await checkBundles(s.client);
  assert.equal(s.posts.length, 0);
  wanted(s.id, 'Later Game', 9103, 'a');
  s.nextDay();
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1);
  assert.match(s.last().description, /Later Game\*\*\]\([^)]+\) for \$10\.00: Wanted by <@a>/);
});

test('a game like what the server plays is posted without pinging, unless the server turned that off', async () => {
  const s = server(['a']);
  plays(s.id, [
    ['Souls Game', 9201, ['Souls-like', 'Dark Fantasy', 'RPG', 'Open World', 'Difficult']],
    ['Farm Game', 9202, ['Farming Sim', 'Life Sim', 'Pixel Graphics', 'Relaxing']],
    ['Shooter Game', 9203, ['FPS', 'Shooter', 'Military', 'Tactical']],
  ]);
  world.apps.set('Close Match', { id: 9204, tags: ['Dark Fantasy', 'RPG', 'Difficult', 'Open World', 'Story Rich'] });
  world.apps.set('Loose Match', { id: 9205, tags: ['Dark Fantasy', 'RPG', 'Difficult', 'Relaxing', 'FPS'] });
  world.bundles = [bundle(6, 'Taste Bundle', [[8, ['Loose Match', 'Close Match']]])];
  setSetting(s.id, 'bundlesLikeWePlay', false);
  await checkBundles(s.client);
  assert.equal(s.posts.length, 0);
  setSetting(s.id, 'bundlesLikeWePlay', true);
  s.nextDay();
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1);
  assert.match(s.last().description, /^\[\*\*Close Match\*\*\]\([^)]+\) for \$8\.00: Like Souls Game \(Dark Fantasy, RPG, Difficult, Open World\)\n/);
  assert.doesNotMatch(s.last().description, /Loose Match/, '3 tags in common isn’t enough');
  assert.equal(s.posts[0].content, undefined);
  assert.deepEqual(s.posts[0].allowedMentions.users, []);
});

test('a game everyone already owns, or one the server hid, isn’t like what it plays', async () => {
  const s = server(['a']);
  plays(s.id, [
    ['Souls Game 2', 9301, ['Souls-like', 'Dark Fantasy', 'RPG', 'Open World']],
    ['Farm Game 2', 9302, ['Farming Sim', 'Life Sim']],
    ['Shooter Game 2', 9303, ['FPS', 'Shooter']],
  ]);
  world.apps.set('Owned Match', { id: 9304, tags: ['Souls-like', 'Dark Fantasy', 'RPG', 'Open World'] });
  world.apps.set('Hidden Match', { id: 9305, tags: ['Souls-like', 'Dark Fantasy', 'RPG', 'Open World'] });
  db.prepare("INSERT INTO steam_links (user_id, steam_id, private, refreshed_at) VALUES ('a', 'steam-a', 0, ?)").run(Date.now());
  db.prepare("INSERT INTO steam_owned (steam_id, appid, playtime) VALUES ('steam-a', 9304, 0)").run();
  db.prepare("INSERT INTO hidden_apps (guild_id, appid, name, hidden_by) VALUES (?, 9305, 'Hidden Match', 'a')").run(s.id);
  world.bundles = [bundle(7, 'Owned Bundle', [[8, ['Owned Match', 'Hidden Match']]])];
  await checkBundles(s.client);
  assert.equal(s.posts.length, 0);
  db.exec("DELETE FROM steam_links WHERE user_id = 'a'; DELETE FROM steam_owned WHERE steam_id = 'steam-a'");
});

test('a server that mostly plays together only hears about multiplayer games, and rogue-like tags count once', async () => {
  const s = server(['a']);
  plays(s.id, [
    ['Co-op Crawler', 9601, ['Rogue-like', 'Pixel Graphics', 'Dungeon Crawler', 'Top-Down', 'Online Co-Op']],
    ['Co-op Sports', 9602, ['Online Co-Op', 'Sports']],
    ['Co-op Comedy', 9603, ['Co-op', 'Comedy']],
  ]);
  world.apps.set('Solo Close', { id: 9604, tags: ['Roguelike', 'Pixel Graphics', 'Dungeon Crawler', 'Top-Down'] });
  world.apps.set('Team Close', { id: 9605, tags: ['Rogue-lite', 'Pixel Graphics', 'Dungeon Crawler', 'Top-Down', 'Co-op'] });
  world.apps.set('Variant Heavy', { id: 9606, tags: ['Rogue-lite', 'Action Roguelike', 'Rogue-like', 'Pixel Graphics', 'Online Co-Op'] });
  world.bundles = [bundle(10, 'Together Bundle', [[6, ['Solo Close', 'Team Close', 'Variant Heavy']]])];
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1);
  const lines = s.last().description.split('\n').filter((line) => line.startsWith('['));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Team Close\*\*\]\([^)]+\) for \$6\.00: Like Co-op Crawler \(Roguelike, Pixel Graphics, Dungeon Crawler, Top-Down\)/);
});

test('every page of bundles is read, and a day’s bundles share one post, the rest waiting for the next', async () => {
  const s = server(['a', 'b']);
  wanted(s.id, 'Everywhere', 9401, 'a');
  wanted(s.id, 'Elsewhere', 9402, 'b');
  world.bundles = [bundle(99, 'Other Bundle', [[1, ['Elsewhere']]]), ...Array.from({ length: 51 }, (_, n) => bundle(100 + n, `Bundle ${n}`, [[1, ['Everywhere']]]))];
  await checkBundles(s.client);
  assert.deepEqual(world.asked.map((q) => q.get('offset')), ['0', '50']);
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].embeds.length, 10, 'a message holds 10 embeds');
  assert.deepEqual(s.posts[0].allowedMentions.users, ['b', 'a'], 'everyone is pinged once');
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1, 'one bundle post a day');
  s.nextDay();
  await checkBundles(s.client);
  assert.equal(s.posts.length, 2);
  assert.equal(s.last().title, '📦 Bundle 9');
});

test('a day’s bundle post stays inside Discord’s 6000 characters', async () => {
  const s = server(['a']);
  const names = Array.from({ length: 10 }, (_, n) => `${'Long Name '.repeat(8)}${n}`);
  names.forEach((name, n) => wanted(s.id, name, 9700 + n, 'a'));
  world.bundles = Array.from({ length: 6 }, (_, n) => bundle(200 + n, `Big ${n}`, [[1, names]]));
  await checkBundles(s.client);
  const total = s.posts[0].embeds.reduce((sum, e) => {
    const { title, description, footer } = e.toJSON();
    return sum + title.length + description.length + footer.text.length;
  }, 0);
  assert.ok(total <= 6000, `${total} characters`);
  assert.ok(s.posts[0].embeds.length < 6);
});

test('nothing is posted before the server’s hour or the day’s sale post, and then it goes out', async (t) => {
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: noon.getTime() });
  const s = server(['a']);
  wanted(s.id, 'Early Game', 9801, 'a');
  world.bundles = [bundle(11, 'Early Bundle', [[1, ['Early Game']]])];
  setSetting(s.id, 'timezone', 'UTC');
  setSetting(s.id, 'salePostHour', 18);
  await checkBundles(s.client);
  assert.equal(s.posts.length, 0);
  t.mock.timers.setTime(noon.getTime() + 6.5 * 3_600_000);
  setKv(`sale_post:${s.id}`, '');
  await checkBundles(s.client);
  assert.equal(s.posts.length, 0, 'not before the day’s sale post');
  setKv(`sale_post:${s.id}`, postDay(s.id)!);
  await checkBundles(s.client);
  assert.equal(s.posts.length, 1);
});

test('nothing is asked with bundle alerts off or without an IsThereAnyDeal key', async (t) => {
  const s = server(['a']);
  wanted(s.id, 'Quiet Game', 9501, 'a');
  world.bundles = [bundle(8, 'Quiet Bundle', [[1, ['Quiet Game']]])];
  setSetting(s.id, 'bundleAlerts', false);
  await checkBundles(s.client);
  setSetting(s.id, 'bundleAlerts', true);
  config.itadKey = null;
  t.after(() => (config.itadKey = 'itad-key'));
  await checkBundles(s.client);
  assert.deepEqual(world.asked, []);
  assert.equal(s.posts.length, 0);
});
