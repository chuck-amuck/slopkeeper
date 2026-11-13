import { readFileSync } from 'node:fs';

/** How the web UI is doing, sent to the bot every 30 seconds for its health numbers (the bot's features/health.ts) */

const REPORT_MS = 30_000;

/** Requests answered since the last report, by status class, and how many the bot didn't answer */
export const counts = { requests: {} as Record<string, number>, botUnreachable: 0 };

export function answered(status: number) {
  const key = `${Math.floor(status / 100)}xx`;
  counts.requests[key] = (counts.requests[key] ?? 0) + 1;
}

/** This container's memory and CPU from its cgroup, as `docker stats` counts them, or this process's outside one (as the bot's src/perf.ts) */
export function containerUsage(root = '/sys/fs/cgroup') {
  try {
    const file = (name: string) => readFileSync(`${root}/${name}`, 'utf8');
    const stat = (text: string, key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
    const max = file('memory.max').trim();
    return {
      memoryBytes: Math.max(0, Number(file('memory.current')) - stat(file('memory.stat'), 'inactive_file')),
      memoryLimitBytes: max === 'max' ? null : Number(max),
      cpuSeconds: stat(file('cpu.stat'), 'usage_usec') / 1e6,
    };
  } catch {
    const { user, system } = process.cpuUsage();
    return { memoryBytes: process.memoryUsage.rss(), memoryLimitBytes: null, cpuSeconds: (user + system) / 1e6 };
  }
}

/** Sends one report. The counts start again only once the bot has them */
export async function report(botUrl: string, apiToken: string) {
  const sent = { requests: { ...counts.requests }, botUnreachable: counts.botUnreachable };
  const res = await fetch(`${botUrl}/perf/web`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...containerUsage(), ...sent }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  for (const [status, n] of Object.entries(sent.requests)) if (!(counts.requests[status] -= n)) delete counts.requests[status];
  counts.botUnreachable -= sent.botUnreachable;
}

/** Reports every 30 seconds. A bot that's restarting misses one and gets the counts in the next */
export function reportEvery(botUrl: string, apiToken: string) {
  return setInterval(() => void report(botUrl, apiToken).catch(() => {}), REPORT_MS).unref();
}
