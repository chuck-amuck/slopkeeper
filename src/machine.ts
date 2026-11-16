import { readFileSync, statfsSync } from 'node:fs';

/**
 * The machine the containers run on, as any container can see it: /proc isn't the container's own,
 * so its CPU, memory, swap and stall times are the whole machine's. Readings are running totals; `machineChange` turns
 * two of them into what happened between. Each part is left out where it can't be read, as outside Linux
 */

/** Running totals and levels at one moment */
export interface MachineReading {
  /** performance.now() when read, for the time between two readings */
  at: number;
  /** CPU time in clock ticks: all of it, and the parts that were idle, waiting on the disk, or taken by the host */
  cpu: { total: number; idle: number; iowait: number; steal: number; cores: number } | null;
  memory: { total: number; available: number; swapTotal: number; swapFree: number } | null;
  /** Pages swapped in and out since the machine started */
  swapPages: number | null;
  /** Microseconds some task waited for each, since the machine started (Linux's pressure stall information) */
  stall: { cpu: number | null; memory: number | null; io: number | null };
  /** The disk holding `dataDir` */
  disk: { free: number; total: number } | null;
}

const tryRead = <T>(fn: () => T): T | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** The `some ... total=` of a pressure file: microseconds at least one task was stalled */
export const stallTotal = (text: string) => {
  const total = /^some .*\btotal=(\d+)/m.exec(text)?.[1];
  return total === undefined ? null : Number(total);
};

const kb = (text: string, key: string) => {
  const value = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1];
  if (value === undefined) throw new Error(`No ${key}`);
  return Number(value) * 1024;
};

export function readMachine(dataDir: string, proc = '/proc', at = performance.now()): MachineReading {
  const file = (name: string) => readFileSync(`${proc}/${name}`, 'utf8');
  const cpu = tryRead(() => {
    const text = file('stat');
    // user nice system idle iowait irq softirq steal, then guest time, which user already includes
    const ticks = /^cpu\s+(.+)$/m.exec(text)![1].trim().split(/\s+/).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal = 0] = ticks;
    if ([user, nice, system, idle, iowait, irq, softirq].some((n) => !Number.isFinite(n))) throw new Error('Odd /proc/stat');
    return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle, iowait, steal, cores: text.match(/^cpu\d+ /gm)?.length ?? 1 };
  });
  const memory = tryRead(() => {
    const text = file('meminfo');
    return { total: kb(text, 'MemTotal'), available: kb(text, 'MemAvailable'), swapTotal: kb(text, 'SwapTotal'), swapFree: kb(text, 'SwapFree') };
  });
  const swapPages = tryRead(() => {
    const text = file('vmstat');
    const n = (key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(text)![1]);
    return n('pswpin') + n('pswpout');
  });
  const stall = {
    cpu: tryRead(() => stallTotal(file('pressure/cpu'))),
    memory: tryRead(() => stallTotal(file('pressure/memory'))),
    io: tryRead(() => stallTotal(file('pressure/io'))),
  };
  const disk = tryRead(() => {
    const s = statfsSync(dataDir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  });
  return { at, cpu, memory, swapPages, stall, disk };
}

/** Shares of the time are 0 to 1; the CPU's are of all its cores together */
export interface MachineChange {
  cpuBusy: number | null;
  cpuIowait: number | null;
  cpuSteal: number | null;
  swapPagesPerSecond: number | null;
  stall: { cpu: number | null; memory: number | null; io: number | null };
}

const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : null);

/** What happened between two readings. A total that went backwards, as after a restart, says nothing */
export function machineChange(before: MachineReading, after: MachineReading): MachineChange {
  const seconds = (after.at - before.at) / 1000;
  const grew = (a: number | null, b: number | null) => (a !== null && b !== null && b >= a ? b - a : null);
  let cpuBusy = null;
  let cpuIowait = null;
  let cpuSteal = null;
  if (before.cpu && after.cpu && after.cpu.total > before.cpu.total) {
    const total = after.cpu.total - before.cpu.total;
    const idle = after.cpu.idle - before.cpu.idle;
    const iowait = after.cpu.iowait - before.cpu.iowait;
    const steal = after.cpu.steal - before.cpu.steal;
    cpuBusy = share(total - idle - iowait - steal, total);
    cpuIowait = share(iowait, total);
    cpuSteal = share(steal, total);
  }
  const swapped = grew(before.swapPages, after.swapPages);
  const stalled = (key: keyof MachineReading['stall']) => {
    const us = grew(before.stall[key], after.stall[key]);
    return us === null || seconds <= 0 ? null : share(us / 1e6, seconds);
  };
  return {
    cpuBusy,
    cpuIowait,
    cpuSteal,
    swapPagesPerSecond: swapped === null || seconds <= 0 ? null : swapped / seconds,
    stall: { cpu: stalled('cpu'), memory: stalled('memory'), io: stalled('io') },
  };
}
