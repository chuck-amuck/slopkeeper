import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIds } from '../src/config.ts';

test('an empty or unset id list means no restriction', () => {
  assert.equal(parseIds(undefined), null);
  assert.equal(parseIds(''), null);
  assert.equal(parseIds(' , '), null);
});

test('ids are split and trimmed', () => {
  assert.deepEqual(parseIds('1, 2,,3 '), ['1', '2', '3']);
});
