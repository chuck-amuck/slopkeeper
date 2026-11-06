import { el, emojiNode } from './lib.js';
import { EMOJI_GROUPS } from './emoji.js';

const PASTED = /^(\p{RGI_Emoji}|<a?:\w{2,32}:\d{17,20}>)$/v;

/** A search box and a grid of emoji, the server's first. Enter takes an emoji pasted in, otherwise the first match */
export function emojiPicker(serverEmoji, pick) {
  const groups = [
    ...(serverEmoji.length ? [['This server', serverEmoji.map((e) => ({ code: e.code, name: e.name.toLowerCase() }))]] : []),
    ...EMOJI_GROUPS.map(([label, emoji]) => [label, emoji.map(([code, name]) => ({ code, name }))]),
  ];
  const heads = new Map();
  let first = null;

  const grid = el('div', { className: 'emoji-picker' });
  const tabs = el(
    'div',
    { className: 'emoji-tabs' },
    groups.map(([label]) => el('button', { type: 'button', onclick: () => heads.get(label)?.scrollIntoView({ block: 'start' }) }, label)),
  );

  function paint() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const found = groups.map(([label, emoji]) => [label, emoji.filter((e) => words.every((word) => e.name.includes(word)))]).filter(([, emoji]) => emoji.length);
    first = found[0]?.[1][0] ?? null;
    heads.clear();
    tabs.hidden = words.length > 0;
    grid.scrollTop = 0;
    grid.replaceChildren(
      ...found.flatMap(([label, emoji]) => {
        const head = el('h3', {}, label);
        heads.set(label, head);
        return [
          head,
          el(
            'div',
            { className: 'emoji-grid' },
            emoji.map((e) => el('button', { type: 'button', title: e.name, ariaLabel: e.name, onclick: () => pick(e.code) }, emojiNode(e.code, e.name))),
          ),
        ];
      }),
    );
    if (!found.length && !PASTED.test(search.value.trim())) grid.append(el('p', {}, 'No emoji match that.'));
  }

  const search = el('input', { type: 'search', placeholder: 'Search or paste an emoji', ariaLabel: 'Search or paste an emoji', oninput: paint });
  paint();
  return {
    nodes: [search, tabs, grid],
    /** What Enter would pick, if anything */
    chosen() {
      const text = search.value.trim();
      return PASTED.test(text) ? text : (text && first?.code) || null;
    },
  };
}
