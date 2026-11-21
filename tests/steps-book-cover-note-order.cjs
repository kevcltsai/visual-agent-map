// Packet A2: repository.ts keeps the cover block directly under `# Title` when it tidies a note (plan §3 item 11), in both layouts;
// a note with no block comes out byte for byte as before (the goldens below were taken from the repository before this change).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const block = support.load('core/book-pipeline/cover-block.ts');

const BLOCK = block.composeCoverBlock('chapter', 'zh', { file: 'Books/B/封面圖/第一章-1234abcd.jpg', url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Mona_Lisa.jpg', caption: '蒙娜麗莎', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Mona_Lisa.jpg' });
const MISSING = block.composeCoverBlock('chapter', 'zh');
const GOLDEN = {
  answerFirst: { input: "# 第一章\n\n## 目前摘要\n\n尚未形成結論\n\n## 詳細內容\n\n<!-- visual-agent-map:detail:start -->\n\n<!-- visual-agent-map:detail:end -->\n", expected: "# 第一章\n\n## 目前摘要\n\n新摘要\n\n> [!info]- 預覽\n> 新摘要\n\n## 詳細內容\n\n<!-- visual-agent-map:detail:start -->\n\n<!-- visual-agent-map:detail:end -->\n" },
  legacy: { input: "# 第一章\n\n## Current Summary\n\n摘要\n\n## Prompt\n\n任務\n\n## 預覽\n\n預覽文\n\n## Detail\n\n<!-- visual-agent-map:detail:start -->\n### A\n\n內文\n<!-- visual-agent-map:detail:end -->\n\n## User Notes\n\n我的筆記\n", expected: "# 第一章\n\n## Current Summary\n\n新摘要\n\n## Prompt\n\n任務\n\n## 預覽\n\n預覽文\n\n我的筆記\n\n## Detail\n\n<!-- visual-agent-map:detail:start -->\n### A\n\n內文\n<!-- visual-agent-map:detail:end -->\n" },
  answer: { input: "# 第一章\n\n## Current Summary\n\n摘要\n\n## Detail\n\n<!-- visual-agent-map:detail:start -->\n### A\n\n內文\n<!-- visual-agent-map:detail:end -->\n\n## User Notes\n\n![[a.png]]\n\n<!-- book-slots:v1 {\"slots\":[],\"bad\":0} -->\n", expected: "# 第一章\n\n## Current Summary\n\n新摘要\n\n> [!info]- 預覽\n> ![[a.png]]\n>\n> <!-- book-slots:v1 {\"slots\":[],\"bad\":0} -->\n\n## Detail\n\n<!-- visual-agent-map:detail:start -->\n### A\n\n內文\n<!-- visual-agent-map:detail:end -->\n" }
};
const frontmatterOf = raw => raw.slice(0, raw.indexOf('\n---\n') + 5);
const bodyOf = raw => raw.slice(raw.indexOf('\n---\n') + 5);
async function tidy(body, patch = { summary: '新摘要' }) {
  const { repo, contents } = support.fixture('zh-TW');
  const note = await support.topicNote(repo, '第一章');
  contents.set(note.path, `${frontmatterOf(contents.get(note.path))}${body}`);
  await repo.updateNote(note.path, patch);
  return bodyOf(contents.get(note.path));
}
/** The golden body with `text` put directly under the title. */
const withBlock = (body, text) => body.replace(/^# 第一章\n\n/, `# 第一章\n\n${text}\n\n`);

test('no block: the tidied output of an answer-first note, a legacy note and a note with a Preview callout is byte for byte what it was', async () => {
  for (const [name, { input, expected }] of Object.entries(GOLDEN)) assert.equal(await tidy(input), expected, name);
  const again = await tidy(GOLDEN.answerFirst.expected);
  assert.equal(again, GOLDEN.answerFirst.expected, 'tidying twice changes nothing');
});

test('answer-first layout: the block stays directly under the title, before the summary, for a found cover and a not-found line', async () => {
  for (const text of [BLOCK, MISSING]) {
    const out = await tidy(withBlock(GOLDEN.answer.input, text));
    assert.equal(out, withBlock(GOLDEN.answer.expected, text));
    assert.ok(out.startsWith(`# 第一章\n\n${text}\n\n## Current Summary`), 'directly under # title');
    assert.equal(out.split('book-cover:v1').length - 1, 1);
  }
});

test('legacy layout (Prompt above Detail): the block stays under the title as well', async () => {
  const out = await tidy(withBlock(GOLDEN.legacy.input, BLOCK));
  assert.equal(out, withBlock(GOLDEN.legacy.expected, BLOCK));
  assert.ok(out.startsWith(`# 第一章\n\n${BLOCK}\n\n## Current Summary`));
  assert.ok(out.indexOf('## Prompt') < out.indexOf('## Detail'), 'the layout stays legacy');
});

test('a block that sits elsewhere in the note (below Detail, or glued to the title) is brought under the title; a second tidy changes nothing', async () => {
  const lower = await tidy(`${GOLDEN.answer.input}\n${BLOCK}\n`);
  assert.equal(lower, withBlock(GOLDEN.answer.expected, BLOCK));
  const glued = await tidy(GOLDEN.answer.input.replace('# 第一章\n\n', `# 第一章\n${BLOCK}\n`));
  assert.equal(glued, withBlock(GOLDEN.answer.expected, BLOCK));
  assert.equal(await tidy(lower), lower);
});

test('the block stays in place and unchanged when other fields are updated (summary, detail)', async () => {
  const input = withBlock(GOLDEN.answer.input, BLOCK);
  for (const patch of [{ summary: '改過的摘要' }, { detail: '### B\n\n新內文' }, { prompt: '新任務' }]) {
    const out = await tidy(input, patch);
    assert.ok(out.startsWith(`# 第一章\n\n${BLOCK}\n\n## Current Summary`), JSON.stringify(patch));
    assert.equal(block.readCoverBlock(out).intact, true);
  }
});

test('a block inside a code fence is ordinary text: it is not pulled under the title', async () => {
  const fenced = `\`\`\`\n${BLOCK}\n\`\`\``;
  const out = await tidy(`${GOLDEN.answer.input}\n${fenced}\n`);
  assert.ok(out.startsWith('# 第一章\n\n## Current Summary'), 'nothing was inserted under the title');
  assert.ok(out.includes('book-cover:v1'), 'its text is kept (this note layout moves a fenced embed into the Preview, as before)');
});
