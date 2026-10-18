// The offline note-style A/B tool (tests/tools/note-style-offline.cjs): arm B differs from arm A only by the two swapped
// prompt blocks, the tool refuses the owner's live test vault and the plugin repository, and the review round-trips.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tool = require('./tools/note-style-offline.cjs');

// <workspace>/vaults/vam-e2e-current, derived from the tool (no personal absolute paths).
const WORKSPACE = tool.WORKSPACE;

const fixture = { workingFindings: 'Finding F [S1]', sourceContext: 'Evidence:\n[S1] Title\nfact 42\n\nSource registry (retain these identities in citations):\n[S1] External file (plain path): https://example.com/a' };

for (const lang of ['zh', 'en'])
  test(`prompt diff between the arms (B textbook, C hybrid) is only the structure + obsidian-format blocks (${lang})`, () => {
    const prompts = tool.buildPrompts(tool.taskContext(tool.TOPICS[0], fixture, lang), lang);
    const { block, fragment, hybridFragment } = prompts;
    assert.ok(block.structure && block.format);
    assert.equal(prompts.A.split(block.joined).length, 2, 'block occurs once in arm A');
    const [head, tail] = prompts.A.split(block.joined);
    assert.equal(prompts.B, head + fragment + tail);
    assert.ok(!prompts.B.includes(block.structure) && !prompts.B.includes(block.format));
    assert.ok(prompts.B.includes(fragment));
    assert.ok(!prompts.A.includes(fragment));
    assert.equal(prompts.C, head + hybridFragment + tail);
    assert.ok(!prompts.C.includes(block.structure) && !prompts.C.includes(block.format));
    assert.ok(prompts.C.includes(hybridFragment) && !prompts.C.includes(fragment) && !prompts.B.includes(hybridFragment));
    assert.notEqual(hybridFragment, fragment);
    assert.equal(hybridFragment, fs.readFileSync(path.join(__dirname, 'tools', 'note-style-offline', `hybrid.${lang}.md`), 'utf8').replace(/\n$/, ''));
    assert.equal(fragment, fs.readFileSync(path.join(__dirname, 'tools', 'note-style-offline', `textbook.${lang}.md`), 'utf8').replace(/\n$/, ''));
  });

test('the tool refuses the live test vault, anything under it, symlinks to it and the plugin repository', () => {
  const live = path.join(WORKSPACE, 'vaults', 'vam-e2e-current');
  for (const target of [live, path.join(live, 'a', 'b.md'), '/private/tmp/vam-e2e-current', '/private/tmp/vam-e2e-current/x.md', '/tmp/vam-e2e-current/x.md', path.join(live, '..', 'vam-e2e-current', 'n.md')])
    assert.throws(() => tool.assertWritable(target), /refusing/, target);
  assert.throws(() => tool.assertWritable(path.join(__dirname, '..', 'out.md')), /plugin repository/);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'note-style-test-'));
  try {
    const link = path.join(scratch, 'link');
    fs.symlinkSync('/private/tmp', link);
    assert.throws(() => tool.assertWritable(path.join(link, 'vam-e2e-current', 'x.md')), /refusing/);
    const linkToRepo = path.join(scratch, 'repo');
    fs.symlinkSync(path.join(__dirname, '..'), linkToRepo);
    assert.throws(() => tool.writeFile(path.join(linkToRepo, 'leak.md'), 'x'), /plugin repository/);
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'leak.md')));
    assert.doesNotThrow(() => tool.assertWritable(path.join(scratch, 'ok', 'note.md')));
    assert.doesNotThrow(() => tool.assertWritable('/private/tmp/vam-e2e-note-style-review/x.md'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('review answers are read back into wins and the gate', () => {
  const key = { pairs: [1, 2, 3, 4, 5, 6, 7, 8].map(index => ({ index, topic: `T${index}`, 甲: { arm: index % 2 ? 'B' : 'A' }, 乙: { arm: index % 2 ? 'A' : 'B' } })) };
  const text = ['| 題 | 主題 | 甲 | 乙 | 你的選擇 | 一句理由 |', '| --- | --- | --- | --- | --- | --- |', ...key.pairs.map(p => `| ${p.index} | ${p.topic} | [[a]] | [[b]] | ${p.index === 8 ? '都可' : p.index % 2 ? '**甲**' : '乙'} | r${p.index} |`)].join('\n');
  const { counts } = tool.tally(key, tool.parseReview(text));
  assert.deepEqual(counts, { textbook: 7, notes: 0, either: 1, neither: 0, blank: 0, invalid: 0 });
  assert.match(tool.gate(counts), /^PASS/);
  assert.match(tool.gate({ ...counts, blank: 1 }), /^PENDING/);
  assert.match(tool.gate({ ...counts, textbook: 3, notes: 4 }), /^STOP/);
  assert.match(tool.gate({ ...counts, textbook: 5, notes: 2 }), /^RETRY/);
});

test('number and mermaid checks', () => {
  const detail = ['| 年 | 值 |', '| --- | --- |', '| 2020 | 1,234 |', '', '```mermaid', 'flowchart TD', '  A1["x 7"] --> B', '```'].join('\n');
  assert.deepEqual(tool.chartNumbers(detail).sort(), ['1234', '2020', '7']);
  assert.deepEqual(tool.mermaidSyntaxProblems(['flowchart TD', 'A --> B']), []);
  assert.ok(tool.mermaidSyntaxProblems(['pie', 'a : 1']).length);
  assert.ok(tool.mermaidSyntaxProblems(['flowchart TD', 'A["x --> B']).length);
});

test('round-2 review (hybrid C vs notes A) tallies the hybrid and treats a miss as final', () => {
  const key = { round: 2, pair: ['C', 'A'], pairs: [1, 2, 3, 4, 5, 6, 7, 8].map(index => ({ index, topic: `T${index}`, 甲: { arm: index % 2 ? 'C' : 'A' }, 乙: { arm: index % 2 ? 'A' : 'C' } })) };
  const text = ['| 題 | 主題 | 甲 | 乙 | 你的選擇 | 一句理由 |', '| --- | --- | --- | --- | --- | --- |', ...key.pairs.map(p => `| ${p.index} | ${p.topic} | [[a]] | [[b]] | ${p.index % 2 ? '甲' : '乙'} | |`)].join('\n');
  const { counts } = tool.tally(key, tool.parseReview(text));
  assert.deepEqual(counts, { textbook: 0, notes: 0, either: 0, neither: 0, blank: 0, invalid: 0, hybrid: 8 });
  assert.match(tool.gate(counts, { final: true }), /^PASS/);
  assert.match(tool.gate({ ...counts, hybrid: 5, notes: 3 }, { final: true }), /^STOP/);
  assert.match(tool.gate({ ...counts, hybrid: 5, notes: 3 }), /^RETRY/);
});
