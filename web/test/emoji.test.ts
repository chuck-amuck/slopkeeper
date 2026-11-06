import assert from 'node:assert/strict';
import { test } from 'node:test';

const file = '../public/emoji.js';
const { EMOJI_GROUPS } = (await import(file)) as { EMOJI_GROUPS: [string, [string, string][]][] };

test('every emoji in the picker is one the bot accepts', () => {
  const emoji = EMOJI_GROUPS.flatMap(([, list]) => list);
  assert.ok(emoji.length > 1500);
  // The bot's own check
  for (const [code] of emoji) assert.match(code, /^\p{RGI_Emoji}$/v);
});

test('each emoji is there once, with a name to search by', () => {
  const emoji = EMOJI_GROUPS.flatMap(([, list]) => list);
  assert.equal(new Set(emoji.map(([code]) => code)).size, emoji.length);
  assert.ok(emoji.every(([, name]) => name === name.toLowerCase() && name.length > 0));
});
