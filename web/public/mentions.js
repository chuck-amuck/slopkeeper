// Mentions typed in the web UI as Discord's @ list would make them. No page parts, so the tests can load it

// As many people as the @ list shows at once
const MOST_SHOWN = 8;

/**
 * Who an @ typed so far could be, as Discord's list would show them: those with a name that starts with it first, then
 * a word in a name that does, then any name with it in, each lot in order of name
 */
export function matching(members, query) {
  const q = query.toLowerCase();
  const rank = (m) => {
    const names = [m.name, m.globalName, m.username].filter(Boolean).map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) return 0;
    if (names.some((n) => n.split(/[\s._-]+/).some((w) => w.startsWith(q)))) return 1;
    return names.some((n) => n.includes(q)) ? 2 : 3;
  };
  return members
    .map((m) => [rank(m), m])
    .filter(([r]) => r < 3)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name))
    .slice(0, MOST_SHOWN)
    .map(([, m]) => m);
}

/** What's typed, with the people picked from the @ list as their mentions, by the name put in for each */
export function withPicked(typed, picked) {
  if (!picked.size) return typed;
  const names = [...picked.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const at = new RegExp(`(?<![\\p{L}\\p{N}_<])@(${names.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return typed.replace(at, (_, name) => `<@${picked.get(name)}>`);
}
