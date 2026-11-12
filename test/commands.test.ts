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

test('the Apps menus fit Discord’s limits, and /help lists them', () => {
  const menus = features.flatMap((f) => f.menus ?? []);
  const json = menus.map((m) => m.data.toJSON());
  assert.equal(new Set(json.map((m) => m.name)).size, json.length);
  // Discord allows five of each kind in a server
  for (const type of [2, 3]) assert.ok(json.filter((m) => m.type === type).length <= 5);
  for (const m of json) assert.ok(m.name.length >= 1 && m.name.length <= 32, m.name);
  for (const m of menus) assert.ok(m.about.length > 0);

  let reply: { embeds: { toJSON(): { fields: { name: string; value: string }[] } }[] } | undefined;
  const helpCommand = features[0].commands![0];
  return helpCommand
    .run({ guildId: null, guild: null, memberPermissions: null, options: { getString: () => null }, reply: async (r: typeof reply) => (reply = r) } as never)
    .then(() => {
      const apps = reply!.embeds[0].toJSON().fields.at(-1)!;
      assert.match(apps.name, /^Apps/);
      assert.deepEqual([...apps.value.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]), menus.map((m) => m.data.name));
    });
});
