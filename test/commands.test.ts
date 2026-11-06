import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freeGames } from '../src/features/freegames.ts';
import { gameNights } from '../src/features/gamenight.ts';
import { gamePings } from '../src/features/gameroles.ts';
import { games } from '../src/features/games.ts';
import { gameStats } from '../src/features/gamestats.ts';
import { gameVotes } from '../src/features/gamevote.ts';
import { help } from '../src/features/help.ts';
import { hopOn } from '../src/features/hopon.ts';
import { recap } from '../src/features/recap.ts';
import { sales } from '../src/features/sales.ts';
import { sessions } from '../src/features/sessions.ts';
import { setup } from '../src/features/setup.ts';
import { soundboard } from '../src/features/soundboard.ts';
import { steam } from '../src/features/steam.ts';

const features = [hopOn, gamePings, gameNights, sessions, gameStats, recap, games, gameVotes, steam, sales, freeGames, soundboard, setup];
const commands = [...features, help(features)].flatMap((f) => f.commands ?? []).map((c) => c.data.toJSON());

interface Option {
  name: string;
  description: string;
  options?: Option[];
}

test('command names are unique', () => {
  assert.equal(new Set(commands.map((c) => c.name)).size, commands.length);
});

test('every command fits Discord’s limits', () => {
  const check = (o: Option, path: string) => {
    assert.ok(o.description.length <= 100, `${path}: description is ${o.description.length} characters`);
    assert.ok((o.options ?? []).length <= 25, `${path}: too many options`);
    for (const sub of o.options ?? []) check(sub, `${path} ${sub.name}`);
  };
  for (const c of commands) check(c as Option, c.name);
});
