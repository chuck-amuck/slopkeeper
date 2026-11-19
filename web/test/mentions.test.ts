import assert from 'node:assert/strict';
import { test } from 'node:test';

const file = '../public/mentions.js';
type Member = { id: string; name: string; username?: string | null; globalName?: string | null };
const { matching, withPicked } = (await import(file)) as { matching: (members: Member[], query: string) => Member[]; withPicked: (typed: string, picked: Map<string, string>) => string };

const members: Member[] = [
  { id: '1', name: 'Sam', username: 'samwise', globalName: 'Samwise Gamgee' },
  { id: '2', name: 'Big Al', username: 'al_88', globalName: null },
  { id: '3', name: 'Alex', username: 'xela', globalName: null },
  { id: '4', name: 'Kim', username: 'kimchi.al', globalName: null },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `z${i}`, name: `Zed ${i}`, username: `zed${i}` })),
];
const names = (query: string) => matching(members, query).map((m) => m.name);

test('the @ list shows who an @ could mean, as Discord matches them: a name that starts with it, then a word in one, then any', () => {
  // Alex and al_88 start with it, Big Al has a word that does, and kimchi.al has one after a dot
  assert.deepEqual(names('al'), ['Alex', 'Big Al', 'Kim']);
  // By username or display name, in any case
  assert.deepEqual(names('SAMW'), ['Sam']);
  assert.deepEqual(names('gamg'), ['Sam']);
  // A space carries on into a name that has one
  assert.deepEqual(names('big a'), ['Big Al']);
  assert.deepEqual(names('nobody'), []);
  // A bare @ shows the first few, in order of name
  assert.equal(names('').length, 8);
  assert.deepEqual(names('').slice(0, 3), ['Alex', 'Big Al', 'Kim']);
});

test('those picked from the @ list are sent as their mentions, by the name put in for them, and nothing else is', () => {
  const picked = new Map([['Big Al', '2'], ['Sam', '1']]);
  assert.equal(withPicked('roast @Big Al and @Sam, not @Samuel or me@Sam.test', picked), 'roast <@2> and <@1>, not @Samuel or me@Sam.test');
  assert.equal(withPicked('hi @Sam', new Map()), 'hi @Sam');
});
