import './helpers.ts';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The README and the pages in docs/ link to each other's sections: each link has to reach a file and a heading that's there

const root = path.join(import.meta.dirname, '..');
const files = ['README.md', ...readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

/** Text outside code, where a link is a link */
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

/** Each heading's anchor as GitHub makes it, with -1, -2 for a heading that's there again */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const [, heading] of prose(readFileSync(path.join(root, file), 'utf8')).matchAll(/^#{1,6} (.+)$/gm)) {
    const base = heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

test('every link between the README and the docs reaches a file and a heading in it', () => {
  const broken: string[] = [];
  for (const file of files) {
    for (const [, target] of prose(readFileSync(path.join(root, file), 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [where, anchor] = target.split('#');
      const to = where ? path.normalize(path.join(path.dirname(file), where)) : file;
      if (!existsSync(path.join(root, to))) {
        broken.push(`${file}: ${target} (no ${to})`);
        continue;
      }
      if (anchor !== undefined && !(to.endsWith('.md') && statSync(path.join(root, to)).isFile() && anchors(to).has(anchor))) broken.push(`${file}: ${target} (no such heading in ${to})`);
    }
  }
  assert.deepEqual(broken, []);
});

test('no page has the same heading twice, which would give one of them an anchor nobody expects', () => {
  for (const file of files) {
    const headings = [...prose(readFileSync(path.join(root, file), 'utf8')).matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].toLowerCase());
    assert.deepEqual(
      headings.filter((h, i) => headings.indexOf(h) !== i),
      [],
      file,
    );
  }
});
