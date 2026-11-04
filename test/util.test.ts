import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paginate, pingWarning } from '../src/util.ts';

test('splits lines into pages that fit', () => {
  const lines = Array.from({ length: 30 }, (_, n) => `game ${n}`.padEnd(100, '.'));
  const pages = paginate(lines, 400);
  assert.equal(pages.flat().length, 30);
  for (const page of pages) assert.ok(page.join('\n').length <= 400);
  assert.equal(pages[0].length, 3);
});

test('nothing to split means no pages', () => {
  assert.deepEqual(paginate([], 400), []);
});

const role = (mentionable: boolean, mentionEveryone: boolean) =>
  ({
    mentionable,
    toString: () => '@role',
    guild: { members: { me: { permissions: { has: () => mentionEveryone } } } },
  }) as never;

test('warns only when pinging a role won’t notify anyone', () => {
  assert.equal(pingWarning(role(true, false)), '');
  assert.equal(pingWarning(role(false, true)), '');
  assert.match(pingWarning(role(false, false)), /Allow anyone to @mention/);
});
