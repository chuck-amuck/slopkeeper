import './helpers.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { machineChange, readMachine, stallTotal } from '../src/machine.ts';

// The machine as every container sees it, from /proc: read twice, and what happened between

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** A /proc with CPU ticks (user, idle, iowait, steal), memory in kB, swapped pages and stall microseconds */
function proc({ user = 0, idle = 0, iowait = 0, steal = 0, available = 6_000_000, swapFree = 1_000_000, swapped = 0, io = 0, pressure = true }) {
  const root = mkdtempSync(path.join(tmpdir(), 'sk-proc-'));
  roots.push(root);
  writeFileSync(path.join(root, 'stat'), `cpu  ${user} 0 0 ${idle} ${iowait} 0 0 ${steal} 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\nintr 1\n`);
  writeFileSync(path.join(root, 'meminfo'), `MemTotal:       12000000 kB\nMemFree:  1 kB\nMemAvailable:    ${available} kB\nSwapTotal:       2000000 kB\nSwapFree:        ${swapFree} kB\n`);
  writeFileSync(path.join(root, 'vmstat'), `nr_free_pages 1\npswpin ${swapped}\npswpout 0\n`);
  if (pressure) {
    mkdirSync(path.join(root, 'pressure'));
    for (const r of ['cpu', 'memory']) writeFileSync(path.join(root, 'pressure', r), 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
    writeFileSync(path.join(root, 'pressure', 'io'), `some avg10=0.00 avg60=0.00 avg300=0.00 total=${io}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`);
  }
  return root;
}

test('a reading has the CPU, memory, swap, stall times and disk, and what changed between two is shares of the time', () => {
  const before = readMachine(tmpdir(), proc({}), 0);
  assert.equal(before.cpu?.cores, 2);
  assert.equal(before.memory?.total, 12_000_000 * 1024);
  assert.equal(before.memory?.available, 6_000_000 * 1024);
  assert.ok(before.disk && before.disk.total > 0 && before.disk.free <= before.disk.total);
  // Ten seconds later: of 1000 ticks, 500 busy, 300 idle, 100 waiting on the disk, 100 taken by the host
  const later = readMachine(tmpdir(), proc({ user: 500, idle: 300, iowait: 100, steal: 100, swapped: 50, io: 2_500_000 }), 10_000);
  const change = machineChange(before, later);
  assert.equal(change.cpuBusy, 0.5);
  assert.equal(change.cpuIowait, 0.1);
  assert.equal(change.cpuSteal, 0.1);
  assert.equal(change.swapPagesPerSecond, 5);
  assert.deepEqual(change.stall, { cpu: 0, memory: 0, io: 0.25 });
});

test('totals that went backwards, or files that aren’t there, say nothing', () => {
  const before = readMachine(tmpdir(), proc({ user: 500, idle: 500, io: 9_000_000 }), 0);
  const after = readMachine(tmpdir(), proc({ user: 10, idle: 10, io: 1 }), 10_000);
  const change = machineChange(before, after);
  assert.equal(change.cpuBusy, null);
  assert.equal(change.stall.io, null);
  const bare = readMachine('/no/such/folder', proc({ pressure: false }), 0);
  assert.deepEqual(bare.stall, { cpu: null, memory: null, io: null });
  assert.equal(bare.disk, null);
  const nothing = readMachine('/no/such/folder', '/no/such/proc', 0);
  assert.equal(nothing.cpu, null);
  assert.equal(nothing.memory, null);
  assert.equal(stallTotal('full avg10=0.00 total=5'), null, 'only “some” counts');
});
