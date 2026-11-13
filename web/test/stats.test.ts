import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { answered, containerUsage, counts, report } from '../src/stats.ts';

const TOKEN = 'bot-token';

/** A bot that keeps the reports it's sent, and refuses them while `down` */
async function fakeBot(t: import('node:test').TestContext) {
  const got: { auth: string | undefined; body: any }[] = [];
  const state = { down: false };
  const bot = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (state.down) return res.writeHead(503).end();
    got.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => bot.listen(0, '127.0.0.1', resolve));
  t.after(() => bot.close());
  return { got, state, url: `http://127.0.0.1:${(bot.address() as AddressInfo).port}` };
}

test('reports its usage and answers to the bot, and counts again only once the bot has them', async (t) => {
  const { got, state, url } = await fakeBot(t);
  for (const status of [200, 200, 304, 502]) answered(status);
  counts.botUnreachable += 1;
  state.down = true;
  await assert.rejects(report(url, TOKEN));
  answered(200);
  state.down = false;
  await report(url, TOKEN);
  assert.equal(got.length, 1);
  assert.equal(got[0].auth, `Bearer ${TOKEN}`);
  const { requests, botUnreachable, memoryBytes, cpuSeconds } = got[0].body;
  assert.deepEqual([requests, botUnreachable], [{ '2xx': 3, '3xx': 1, '5xx': 1 }, 1], 'what a refused report had is sent with the next');
  assert.ok(memoryBytes > 0 && cpuSeconds > 0);
  answered(404);
  await report(url, TOKEN);
  assert.deepEqual([got[1].body.requests, got[1].body.botUnreachable], [{ '4xx': 1 }, 0]);
});

test('a container’s usage is the cgroup’s, or the process’s outside one', () => {
  const outside = containerUsage('/no/such/cgroup');
  assert.ok(outside.memoryBytes > 0 && outside.memoryLimitBytes === null);
});
