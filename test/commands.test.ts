import './helpers.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { features } from '../src/features/all.ts';

const commands = features.flatMap((f) => f.commands ?? []).map((c) => c.data.toJSON());

interface Option {
  name: string;
  description: string;
  choices?: { name: string; value: string | number }[];
  options?: Option[];
}

test('command names are unique', () => {
  assert.equal(new Set(commands.map((c) => c.name)).size, commands.length);
});

// One command over a limit makes Discord refuse the whole set, so no command would update or register at all
test('every command fits Discord’s limits', () => {
  assert.ok(commands.length <= 100, `${commands.length} commands`);
  const check = (o: Option, path: string) => {
    assert.match(o.name, /^[-_\p{Ll}\p{N}]{1,32}$/u, `${path}: bad name`);
    assert.ok(o.description.length >= 1 && o.description.length <= 100, `${path}: description is ${o.description.length} characters`);
    assert.ok((o.options ?? []).length <= 25, `${path}: ${o.options?.length} options`);
    assert.ok((o.choices ?? []).length <= 25, `${path}: ${o.choices?.length} choices`);
    for (const choice of o.choices ?? []) assert.ok(choice.name.length <= 100 && String(choice.value).length <= 100, `${path}: choice ${choice.name} too long`);
    const names = (o.options ?? []).map((sub) => sub.name);
    assert.equal(new Set(names).size, names.length, `${path}: repeated option names`);
    for (const sub of o.options ?? []) check(sub, `${path} ${sub.name}`);
  };
  // Discord counts names, descriptions and choices towards each command's 8,000 characters
  const size = (o: Option): number =>
    o.name.length + o.description.length + (o.choices ?? []).reduce((sum, c) => sum + c.name.length + String(c.value).length, 0) + (o.options ?? []).reduce((sum, sub) => sum + size(sub), 0);
  for (const c of commands) {
    check(c as Option, c.name);
    assert.ok(size(c as Option) <= 8000, `/${c.name} is ${size(c as Option)} characters`);
  }
});

test('/help covers every command, however many there are', () => {
  const help = commands.find((c) => c.name === 'help')!;
  const option = (help.options as Option[]).find((o) => o.name === 'command')! as Option & { autocomplete?: boolean };
  assert.equal(option.autocomplete, true);
  assert.equal(option.choices, undefined);
});
