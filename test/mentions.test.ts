import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessagePayload } from 'discord.js';
import { client } from '../src/client.ts';

const body = (options: object) => new MessagePayload({ client } as never, options).resolveBody().body as { allowed_mentions: unknown };

test('nothing in a message pings unless it says so', () => {
  assert.deepEqual(body({ content: '➕ Added **@everyone**' }).allowed_mentions, { parse: [] });
});

test('a message can still ping who it names', () => {
  assert.deepEqual(body({ content: '<@1>', allowedMentions: { users: ['1'] } }).allowed_mentions, { users: ['1'] });
});
