// AI Markdown intake: the write-stage chain per destination, pinned with fixed literal outputs (6f2e1aee behavior), called through ai/markdown-intake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

// Every destination goes through the intake module; the expected values below are fixed literals (the 6f2e1aee outputs).
const intake = loadSource(`export * from './ai/markdown-intake';`, { obsidian: {} });
const SYNC = new Set(['task-detail', 'chat-file-edit', 'argument-detail']);
async function run(kind, text, opts = {}) {
  if (SYNC.has(kind)) return intake.intakeAiMarkdown(text, { kind, ...opts });
  return intake.intakeAiMarkdownChecked(text, { kind }, opts.check);
}

const invalid = async code => (/BAD/.test(code) ? 'invalid' : 'valid');
const unavailable = async () => 'unavailable';
const valid = async () => 'valid';
const FENCE = '```mermaid\nflowchart TD\n  A[<sup>[s](<u>)</sup>]\n```\n<sup>[s](<u>)</sup>\n';
const FRONT = '---\ntitle: T\nlink: <sup>[a](<https://a>)</sup>\nimage: ![x](u)\n---\n![x](u)\n<sup>[a](<https://a>)</sup>\n';
const BADBLOCK = '```mermaid\nflowchart TD\n  A --> BAD\n```\n';
const REPLACE = '<sup>[s](<https://a.org/s>)</sup>\n![i](u)';
const EDIT = { at: 0, insertedLength: REPLACE.length, tail: '\n![i](u)\nEND'.length };

const rows = [
  // 1 guard before dedupe
  ['1 task-detail: guard then dedupe', 'task-detail', '<sup>![a](<https://x.org/a b.png>)</sup>\n\n![a](https://x.org/a%20b.png)\n', {}, '<sup>![a](https://x.org/a%20b.png)</sup>\n'],
  ['1 chat-topic-detail: guard then dedupe', 'chat-topic-detail', '<sup>![a](<https://x.org/a b.png>)</sup>\n\n![a](https://x.org/a%20b.png)\n', {}, '<sup>![a](https://x.org/a%20b.png)</sup>\n'],
  ['1 chat-new-file: guard then dedupe', 'chat-new-file', '<sup>![a](<https://x.org/a b.png>)</sup>\n\n![a](https://x.org/a%20b.png)\n', {}, '<sup>![a](https://x.org/a%20b.png)</sup>\n'],
  // 2 chat-file-edit range end is length - tail
  ['2 chat-file-edit: inserted duplicate image dropped', 'chat-file-edit', REPLACE + '\n![i](u)\nEND', EDIT, '<sup><a href="https://a.org/s">s</a></sup>\n![i](u)\nEND'],
  // 3 selection-insert without mermaid keeps text as is
  ['3 selection-insert: no mermaid word keeps CRLF', 'selection-insert', 'a\r\nb', {}, 'a\r\nb'],
  // 4 CRLF
  ['4 chat-topic-detail: CRLF becomes LF', 'chat-topic-detail', 'a\r\nb', {}, 'a\nb'],
  ['4 task-detail: CRLF kept', 'task-detail', 'a\r\nb', {}, 'a\r\nb'],
  ['4 selection-insert: CRLF mermaid block becomes LF text', 'selection-insert', '```mermaid\r\nflowchart TD\r\n  click A "x"\r\n```\r\n', {}, '```text\nflowchart TD\n  click A "x"\n```\n'],
  // 5 fence content untouched
  ['5 task-detail: fence untouched', 'task-detail', FENCE, {}, '```mermaid\nflowchart TD\n  A[<sup>[s](<u>)</sup>]\n```\n<sup>[s](u)</sup>\n'],
  ['5 chat-topic-detail: fence untouched (block demoted by allow-list)', 'chat-topic-detail', FENCE, {}, '```text\nflowchart TD\n  A[<sup>[s](<u>)</sup>]\n```\n<sup>[s](u)</sup>\n'],
  ['5 chat-new-file: fence untouched', 'chat-new-file', FENCE, {}, '```text\nflowchart TD\n  A[<sup>[s](<u>)</sup>]\n```\n<sup>[s](u)</sup>\n'],
  // 6 frontmatter
  ['6 chat-new-file: frontmatter untouched, image: not seen', 'chat-new-file', FRONT, {}, '---\ntitle: T\nlink: <sup>[a](<https://a>)</sup>\nimage: ![x](u)\n---\n![x](u)\n<sup><a href="https://a">a</a></sup>\n'],
  ['6 chat-topic-detail: same text processed as body', 'chat-topic-detail', FRONT, {}, '---\ntitle: T\nlink: <sup><a href="https://a">a</a></sup>\nimage: ![x](u)\n---\n<sup><a href="https://a">a</a></sup>\n'],
  // 7 compose boundary
  ['7 task-detail: compose output not guarded, repeated image deduped', 'task-detail', '![i](u)\nt\n', { compose: g => g + '\n<sup>[s](<https://a.org/s>)</sup>\n![i](u)\n' }, '![i](u)\nt\n\n<sup>[s](<https://a.org/s>)</sup>\n'],
  // 8 seenImages with compose
  ['8 task-detail: seen image dropped, text kept, with compose', 'task-detail', '![i](u)\ntext line\n![j](v)\n', { seenImages: ['u'], compose: g => g + 'more\n' }, 'text line\n![j](v)\nmore\n'],
  ['8 task-detail: seenImages only', 'task-detail', '![i](u)\ntext line\n![j](v)\n', { seenImages: ['u'] }, 'text line\n![j](v)\n'],
  // 9 check branches
  ['9 chat-topic-detail: no check keeps mermaid', 'chat-topic-detail', BADBLOCK, {}, BADBLOCK],
  ['9 chat-topic-detail: invalid becomes text', 'chat-topic-detail', BADBLOCK, { check: invalid }, '```text\nflowchart TD\n  A --> BAD\n```\n'],
  ['9 chat-new-file: unavailable keeps the whole text', 'chat-new-file', BADBLOCK, { check: unavailable }, BADBLOCK],
  ['9 selection-insert: valid keeps mermaid', 'selection-insert', BADBLOCK, { check: valid }, BADBLOCK],
  ['9 selection-insert: invalid becomes text', 'selection-insert', BADBLOCK, { check: invalid }, '```text\nflowchart TD\n  A --> BAD\n```\n'],
  // 10 neutralize allow-list
  ['10 argument-detail: click directive demotes block', 'argument-detail', '```mermaid\nflowchart TD\n  A --> B\n  click A "x"\n```\n', {}, '```text\nflowchart TD\n  A --> B\n  click A "x"\n```\n'],
  ['10 argument-detail: br becomes space', 'argument-detail', '```mermaid\nflowchart TD\n  A[a<br>b] --> B\n```\n', {}, '```mermaid\nflowchart TD\n  A[a b] --> B\n```\n'],
  ['10 chat-topic-detail: callout mermaid handled', 'chat-topic-detail', '> ```mermaid\n> flowchart TD\n>   click A "x"\n> ```\n', {}, '> ```text\n> flowchart TD\n>   click A "x"\n> ```\n'],
  // 12 callout fence: guard rewrites a label inside a callout fence (current behavior locked, Finding F5)
  ['12 chat-topic-detail: guard rewrites callout mermaid label (block then demoted)', 'chat-topic-detail', '> ```mermaid\n> flowchart TD\n>   A[<sup>[s](<u>)</sup>]\n> ```\n', {}, '> ```text\n> flowchart TD\n>   A[<sup>[s](u)</sup>]\n> ```\n'],
  // no change cases
  ['plain text is unchanged (task-detail)', 'task-detail', 'plain\ntext\n', {}, 'plain\ntext\n'],
  ['argument-detail: no mermaid keeps CRLF', 'argument-detail', 'a\r\nb', {}, 'a\nb']
];

for (const [name, kind, text, opts, expected] of rows) {
  test(`intake: ${name}`, async () => {
    assert.equal(await run(kind, text, opts), expected);
  });
}

test('intake: chat-file-edit range end must subtract the tail, not use insertedLength', async () => {
  // source `X\n![i](u)\nEND`, find `X`, replace REPLACE: the edited text holds the image twice
  const text = REPLACE + '\n![i](u)\nEND';
  const next = await run('chat-file-edit', text, EDIT);
  assert.equal(next, '<sup><a href="https://a.org/s">s</a></sup>\n![i](u)\nEND');
  assert.equal((next.match(/!\[i\]\(u\)/g) || []).length, 1);
});

test('intake: chat-file-edit keeps an image the surviving text already has out of the insert', async () => {
  // the inserted image repeats one the surviving tail has: the inserted one is dropped, the tail keeps its own
  const raw = REPLACE + '\n![i](u)\nEND';
  const next = await run('chat-file-edit', raw, { at: 0, insertedLength: REPLACE.length, tail: '\n![i](u)\nEND'.length });
  assert.equal(next, '<sup><a href="https://a.org/s">s</a></sup>\n![i](u)\nEND');
});

test('intake: chat-file-edit frontmatter is not guarded', async () => {
  const raw = '---\nk: <sup>[a](<https://a>)</sup>\n---\nbody';
  assert.equal(await run('chat-file-edit', raw, { at: 0, insertedLength: raw.length, tail: 0 }), raw);
});

// 11 idempotency: every kind, a second pass changes nothing
const idem = [
  ['task-detail', '<sup>![a](<https://x.org/a b.png>)</sup>\n\n![a](https://x.org/a%20b.png)\n![b](v)\n![b](v)\n', {}],
  ['chat-topic-detail', FENCE + '![a](u)\n![a](u)\n', {}],
  ['chat-topic-detail', BADBLOCK, { check: invalid }],
  ['chat-new-file', FRONT + '![x](u)\n', {}],
  ['selection-insert', '```mermaid\nflowchart TD\n  click A "x"\n```\n', {}],
  ['argument-detail', '```mermaid\nflowchart TD\n  A[a<br>b]\n  click A "x"\n```\n', {}]
];
for (const [kind, text, opts] of idem)
  test(`intake: idempotent ${kind}${opts.check ? ' with check' : ''}`, async () => {
    const once = await run(kind, text, opts);
    assert.equal(await run(kind, once, opts), once);
  });

test('intake: idempotent chat-file-edit', async () => {
  const raw = '<sup>[s](<https://a.org/s>)</sup>\n![i](u)\n![i](u)\nEND';
  const o = { at: 0, insertedLength: '<sup>[s](<https://a.org/s>)</sup>\n![i](u)\n![i](u)'.length, tail: 4 };
  const once = await run('chat-file-edit', raw, o);
  assert.equal(await run('chat-file-edit', once, { ...o, insertedLength: once.length - 4 }), once);
});
