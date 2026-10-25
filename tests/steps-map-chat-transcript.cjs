// Map chat "save as a note" (B3-feat): the file name and the whitelist serialization of a conversation. Pure functions, no AI, no vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { chatNoteName, chatFirstSentence, transcriptMarkdown, replyMarkdown, escapeText, localDate, localStamp } = load('core/map-chat-transcript.ts');

const FALLBACK = 'Chat';
const day = new Date(2026, 9, 26, 23, 59);
const name = message => chatNoteName(message, day, FALLBACK);

test('B3 file name: local date, first sentence up to 。！？.!? or a line break', () => {
  assert.equal(localDate(day), '2026-10-26');
  assert.equal(localStamp(day), '2026-10-26 23:59');
  assert.equal(name('Add three cards about tea. Then rate them.'), '2026-10-26 Add three cards about tea');
  assert.equal(name('幫我整理咖啡豆的產區。再補上圖'), '2026-10-26 幫我整理咖啡豆的產區');
  assert.equal(name('Really!? Do it'), '2026-10-26 Really');
  assert.equal(name('first line\nsecond line'), '2026-10-26 first line');
  assert.equal(name('  \n  Leading blank lines are skipped'), '2026-10-26 Leading blank lines are skipped');
});
test('B3 file name: characters a file or link name cannot hold become blanks; leading dots and blanks go', () => {
  assert.equal(name('a/b\\c:d*e"f<g>h|i#j^k[l]m'), '2026-10-26 a b c d e f g h i j k l m');
  assert.equal(name('/ #hidden file'), '2026-10-26 hidden file');
  assert.equal(name('..hidden file'), `2026-10-26 ${FALLBACK}`, 'a period ends the sentence before anything is left');
  assert.equal(name('trailing dots...'), '2026-10-26 trailing dots');
  assert.equal(name('x \u0000 y'), '2026-10-26 x y');
});
test('B3 file name: a first sentence with nothing usable in it takes the fallback', () => {
  for (const message of ['???///', '。。。', '...', '   ', '\n\n', '#^[]', '']) assert.equal(name(message), `2026-10-26 ${FALLBACK}`, JSON.stringify(message));
});
test('B3 file name: at most 40 graphemes, cut without an ellipsis and never inside an emoji', () => {
  const forty = 'a'.repeat(40);
  assert.equal(chatFirstSentence(forty), forty);
  assert.equal(chatFirstSentence(forty + 'b'), forty, '41 characters are cut to 40');
  const family = '👨‍👩‍👧‍👦';
  assert.equal(chatFirstSentence(family.repeat(40)), family.repeat(40));
  assert.equal(chatFirstSentence(family.repeat(41)), family.repeat(40), 'a family emoji is one grapheme, so the cut is on its edge');
  const flags = '🇹🇼'.repeat(41);
  assert.equal([...chatFirstSentence(flags)].length, 80, 'flags are two code points each, 40 of them are kept');
  assert.equal(chatFirstSentence('漢'.repeat(41)), '漢'.repeat(40));
  assert.equal(chatFirstSentence('x'.repeat(40) + '…more'), 'x'.repeat(40), 'no ellipsis is added');
});
test('B3 file name: the first sentence ends at the cut before illegal characters are cleaned', () => {
  // 38 letters, then "/" and "?": the "?" ends the sentence, the "/" is a blank, and the trailing blank goes.
  assert.equal(chatFirstSentence('a'.repeat(38) + '/?tail'), 'a'.repeat(38));
});

// ---- serialization ----------------------------------------------------------------------------------------------------
const labels = {
  title: 'Map chat', map: 'Map', saved: 'Saved', you: 'You', ai: 'AI', references: 'References', results: 'Results',
  planPending: 'Plan: waiting for a decision', planApplied: 'Plan: applied', planCancelled: 'Plan: cancelled',
  images: 'Picture candidates for {0}', imagesSearching: 'Searching: {0}', imagesNone: 'No loadable picture was found', imagesFailed: 'Search failed: {0}', imagesStopped: 'Search stopped',
  inserted: '(inserted into {0})'
};
const turn = (extra = {}) => ({ question: 'What is tea?', refs: [], answer: 'Tea is a drink.', lines: [], images: [], ...extra });
const render = (turns, extra = {}) => transcriptMarkdown({ mapTitle: 'Tea', mapPath: 'Maps/Tea/Map.md', savedAt: day, labels, turns, ...extra });

test('B3 transcript: a fixture conversation is written exactly as expected', () => {
  const out = render([
    turn({
      question: 'Add a card about green tea.\nThen find pictures',
      refs: [
        { kind: 'topic', path: 'Maps/Tea/Notes/Green.md', title: 'Green tea' },
        { kind: 'file', path: 'Notes/Reading.md', title: '' },
        { kind: 'snippet', path: 'Notes/Reading.md', title: '', text: 'Leaves are *steamed*' }
      ],
      answer: '## Plan\n\nI will add **one** card and show [Wikipedia](https://en.wikipedia.org/wiki/Tea) and [[Green tea|the card]].\n\n- first\n- second',
      lines: ['Done: Add a card "Green tea"', 'Skipped: Find pictures (one card only)'],
      plan: 'applied',
      images: [{ nodeTitle: 'Green tea', query: 'green tea leaves', state: 'ready', items: [{ title: 'Leaves', source: 'https://example.org/leaves', inserted: 'Green tea' }, { title: 'Cup', source: 'https://example.org/cup' }] }]
    })
  ]);
  assert.equal(out, [
    '# Map chat',
    '',
    'Map: [[Maps/Tea/Map|Tea]]\\',
    'Saved: 2026-10-26 23:59',
    '',
    '---',
    '',
    '## 1. You',
    '',
    'Add a card about green tea\\.\\',
    'Then find pictures',
    '',
    'References: [[Maps/Tea/Notes/Green|Green tea]], [[Notes/Reading]], [[Notes/Reading]] Leaves are \\*steamed\\*',
    '',
    '### AI',
    '',
    '## Plan',
    '',
    'I will add **one** card and show [Wikipedia](<https://en.wikipedia.org/wiki/Tea>) and [[Green tea|the card]]\\.',
    '',
    '- first',
    '- second',
    '',
    '**Results**',
    '',
    '- Done\\: Add a card \\"Green tea\\"',
    '- Skipped\\: Find pictures \\(one card only\\)',
    '',
    'Plan\\: applied',
    '',
    '**Picture candidates for Green tea**',
    '',
    '- [Leaves](<https://example.org/leaves>) \\(inserted into Green tea\\)',
    '- [Cup](<https://example.org/cup>)',
    ''
  ].join('\n'));
});
test('B3 transcript: no front matter and none of the keys the plugin reads', () => {
  const out = render([turn({ question: 'agent-map-node node-id topic-id', answer: 'Use `node-id` and `topic-id` and agent-map-node.\n\n```\nagent-map-node: x\n```' })]);
  assert.ok(out.startsWith('# '), 'the note starts with a heading, not a front matter fence');
  assert.doesNotMatch(out, /agent-map-node|node-id|topic-id/);
  assert.doesNotMatch(out.split('\n')[0], /^---/);
});
test('B3 transcript whitelist: an image, an embed, HTML, a code-block processor, a comment, math and a script link all stay text', () => {
  const hostile = [
    '![](https://x/a.png)',
    '![[secret]]',
    '<img src=x onerror=alert(1)>',
    '%%comment%%',
    '$$x$$',
    '[x](javascript:alert(1))',
    '<iframe src="https://x"></iframe>',
    '![alt](<https://x/b.png>)',
    '```dataviewjs\ndv.view("x")\n```',
    '~~~query\nfile\n~~~',
    '    indented code',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '> [!note] Callout',
    '[[javascript:alert(1)]]',
    '[[folder/..\\secret|x]]'
  ].join('\n\n');
  const out = render([turn({ question: hostile, answer: hostile, lines: [hostile.replace(/\n/g, ' ')] })]);
  assert.ok(!out.includes('!['), 'not one image opener anywhere');
  assert.doesNotMatch(out.replace(/\]\(<https?:\/\/[^\s<>]+>\)/g, ''), /(^|[^\\])</, 'no HTML tag is written raw: every "<" has its backslash');
  assert.doesNotMatch(out, /(^|[^\\])%%/, 'no comment');
  assert.doesNotMatch(out, /(^|[^\\])\$\$/, 'no math block');
  assert.doesNotMatch(out, /\]\(javascript:/i);
  assert.doesNotMatch(out, /\[\[secret\]\]/, 'the embed target is not a link either');
  assert.doesNotMatch(out, /\[\[javascript:/i);
  assert.ok(!/```[a-z]/i.test(out) && !/~~~/.test(out), 'no fence carries a language, and no tilde fence is written');
  assert.ok(out.includes('dv.view'), 'the code stays visible as code');
  assert.ok(out.includes('<img'.replace('<', '\\<')), 'the HTML is visible as escaped text');
});
test('B3 transcript whitelist: the reply is written again from the chat window\'s own parse', () => {
  const reply = '# Heading\n\nText with **bold**, *italic*, ~~strike~~, `code`, [[Note]] and [site](https://example.org).\n\n1. one\n2. two\n\n> quoted\n\n---\n\n```js\nlet a = 1;\n```';
  assert.equal(replyMarkdown(reply), [
    '# Heading',
    '',
    'Text with **bold**\\, *italic*\\, ~~strike~~\\, `code`\\, [[Note]] and [site](<https://example.org>)\\.',
    '',
    '1. one',
    '2. two',
    '',
    '> quoted',
    '',
    '---',
    '',
    '```',
    'let a = 1;',
    '```'
  ].join('\n'));
});
test('B3 transcript whitelist: a code fence is longer than any backtick run inside, and has no language', () => {
  const out = replyMarkdown('````\n```inner```\n````');
  assert.equal(out, '````\n```inner```\n````');
  assert.equal(replyMarkdown('``a ` b``'), '``a ` b``'.replace('``a ` b``', '``a ` b``'));
});
test('B3 transcript whitelist: an image written in a reply is text, and a code span or fence cannot hold an image opener either', () => {
  const out = replyMarkdown('Wow![link](https://example.org) and wow![[Note]] and `![a](b)`\n\n```\n![c](d)\n```');
  assert.ok(!out.includes('!['));
  assert.ok(out.includes('\\!\\[link\\]'));
  assert.ok(out.includes('![a](b)'.replace('!', '!\u200b')), 'in code a zero-width space splits the opener');
});
test('B3 transcript whitelist: line starts that would open a block are escaped', () => {
  for (const line of ['# not a heading', '- not a list', '+ not a list', '1. not a list', '> not a quote', '=== not setext', '--- not a rule', '* not a list', '~~~ not a fence']) {
    const out = render([turn({ question: `${line}\n${line}` })]);
    const body = out.split('\n').slice(8, 12).join('\n');
    assert.doesNotMatch(body, /^(#|-|\+|\d+\.|>|=|\*|~)/m, line);
  }
  assert.equal(escapeText('a.b!c'), 'a\\.b\\!c');
});
test('B3 transcript: the wikilink of a reference and of a reply never carries "!", "|" or brackets of their own', () => {
  const out = render([turn({ refs: [{ kind: 'topic', path: 'A/B|C!.md', title: 'T]|[x' }], answer: '[[Note|a]] [[A![[b]]|c]]' })]);
  assert.match(out, /\[\[A\/B C\|T x\]\]/);
  assert.doesNotMatch(out, /!\[\[/);
});
test('B3 transcript: candidates are links only, and a picture inserted into a card says which', () => {
  const out = render([turn({ images: [
    { nodeTitle: 'Card', query: 'q', state: 'ready', items: [{ title: 'A [x] ![y](z)', source: 'https://example.org/a', inserted: 'Card' }, { title: 'No page', source: 'javascript:alert(1)' }] },
    { nodeTitle: 'Card', query: 'cups', state: 'searching', items: [] },
    { nodeTitle: 'Card', query: 'q', state: 'empty', items: [] },
    { nodeTitle: 'Card', query: 'q', state: 'failed', reason: 'timeout <b>', items: [] },
    { nodeTitle: 'Card', query: 'q', state: 'stopped', items: [] }
  ] })]);
  assert.ok(!out.includes('!['));
  assert.match(out, /- \[A \\\[x\\\] \\!\\\[y\\\]\\\(z\\\)\]\(<https:\/\/example\.org\/a>\) \\\(inserted into Card\\\)/);
  assert.doesNotMatch(out, /javascript:alert\(1\)\)/);
  assert.match(out, /No loadable picture was found/);
  assert.match(out, /Search failed\\: timeout \\<b\\>/);
  assert.match(out, /Search stopped/);
  assert.match(out, /Searching\\: cups/);
});
test('B3 transcript: the three plan states are written in words', () => {
  for (const [plan, text] of [['pending', /waiting for a decision/], ['applied', /applied/], ['cancelled', /cancelled/]]) assert.match(render([turn({ plan })]), text);
  assert.doesNotMatch(render([turn()]), /Plan/);
});
test('B3 transcript: control and bidirectional override characters are dropped', () => {
  const rlo = String.fromCharCode(0x202e), lri = String.fromCharCode(0x2066), lre = String.fromCharCode(0x202a);
  const out = render([turn({ question: `a\u0000b${rlo}c${lri}d`, answer: `x\u0007y${lre}z` })]);
  assert.doesNotMatch(out, new RegExp(`[${rlo}${lri}${lre}\\u0000\\u0007]`));
});
