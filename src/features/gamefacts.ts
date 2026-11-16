import { setTimeout as wait } from 'node:timers/promises';
import { db } from '../db.ts';
import { gameKey } from '../gameNames.ts';
import { requestTimeout } from '../util.ts';

const REFRESH_AFTER_MS = 30 * 24 * 3_600_000;
// A game remembered without tags is asked about again sooner: older versions only asked SteamSpy, which has no tags for newer games
const NO_TAGS_REFRESH_MS = 24 * 3_600_000;
const TAG_NAMES_MS = 7 * 24 * 3_600_000;
const KEPT_TAGS = 12;
// SteamSpy asks for no more than one request a second
export const lookups = { gapMs: 1000 };

/** What Steam knows about a game. An appid of null means it isn't on Steam */
export interface GameFacts {
  appid: number | null;
  positive: number;
  negative: number;
  tags: string[];
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs jobs one at a time, however many servers ask at once */
function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const turn = queue.then(job, job);
  queue = turn.catch(() => {}).then(() => wait(lookups.gapMs));
  return turn;
}

async function getJson(url: string) {
  const res = await fetch(url, { signal: requestTimeout() });
  if (!res.ok) throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, any>;
}

/** The Steam game with this exact name, ignoring case and punctuation */
export async function findOnSteam(title: string) {
  const { items = [] } = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=US`);
  return (items as { id: number; name: string }[]).find((item) => gameKey(item.name) === gameKey(title)) ?? null;
}

let tagNames: { at: number; names: Map<number, string> } | null = null;

/** A game's tags from Steam's store, most voted first, which covers games too new for SteamSpy */
async function steamTags(appid: number) {
  if (!tagNames || Date.now() - tagNames.at > TAG_NAMES_MS) {
    const { response } = await getJson('https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english');
    const names = new Map(((response?.tags ?? []) as { tagid: number; name: string }[]).map((t) => [t.tagid, t.name]));
    // An empty list is a bad answer, not a week without tags
    if (!names.size) throw new Error('Steam sent no tag names');
    tagNames = { at: Date.now(), names };
  }
  const input = { ids: [{ appid }], context: { language: 'english', country_code: 'US' }, data_request: { include_tag_count: KEPT_TAGS } };
  const { response } = await getJson(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
  const tags = (response?.store_items?.[0]?.tags ?? []) as { tagid: number; weight: number }[];
  return [...tags]
    .sort((a, b) => b.weight - a.weight)
    .flatMap((t) => tagNames!.names.get(t.tagid) ?? [])
    .slice(0, KEPT_TAGS);
}

async function lookUp(title: string): Promise<GameFacts> {
  const match = await findOnSteam(title);
  if (!match) return { appid: null, positive: 0, negative: 0, tags: [] };
  const spy = await getJson(`https://steamspy.com/api.php?request=appdetails&appid=${match.id}`);
  // It sends an empty array rather than an object when a game has no tags
  let tags = Object.entries((spy.tags ?? {}) as Record<string, number>)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)
    .slice(0, KEPT_TAGS);
  if (!tags.length) tags = await steamTags(match.id).catch((err) => (console.error(err), []));
  return { appid: match.id, positive: Number(spy.positive) || 0, negative: Number(spy.negative) || 0, tags };
}

const remembered = (key: string) => db.prepare('SELECT appid, positive, negative, tags, checked_at FROM game_facts WHERE key = ?').get(key) as (Omit<GameFacts, 'tags'> & { tags: string; checked_at: number }) | undefined;

function known(key: string): GameFacts | null {
  const row = remembered(key);
  if (!row || Date.now() - row.checked_at >= REFRESH_AFTER_MS) return null;
  if (row.appid !== null && row.tags === '[]' && Date.now() - row.checked_at >= NO_TAGS_REFRESH_MS) return null;
  return { appid: row.appid, positive: row.positive, negative: row.negative, tags: JSON.parse(row.tags) as string[] };
}

/** What Steam knows about a game, from the last month's answer if there is one. Throws if nobody could be asked */
export async function factsFor(title: string): Promise<GameFacts> {
  const key = gameKey(title);
  return (
    known(key) ??
    inTurn(async () => {
      // Someone else may have asked while this waited its turn
      const already = known(key);
      if (already) return already;
      const facts = await lookUp(title);
      db.prepare('INSERT OR REPLACE INTO game_facts (key, appid, positive, negative, tags, checked_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        key,
        facts.appid,
        facts.positive,
        facts.negative,
        JSON.stringify(facts.tags),
        Date.now(),
      );
      return facts;
    })
  );
}
