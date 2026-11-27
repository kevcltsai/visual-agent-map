// Writer matrix, editor side: the selection panel and image translate run the same Living Node admission as the Repository.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { runPanel } = require('./support-selection-ai.cjs');
const { t } = S.load('i18n.ts');
const BEGIN = '<!-- vam-living-node:begin v1 -->', END = '<!-- vam-living-node:end v1 -->';
const RUN_CARD = /Run card|執行卡片/;
const DAMAGED = /Living Node markers|Living Node 標記/;
const plan = placement => JSON.stringify({ action: 'transform', query: '', instruction: 'Make it shorter', placement, captionInstruction: '' });
const PLAN = plan('after');
const embed = '![egg](https://x/egg.png)';
const cases = {
  'healthy region': { fm: 'type: topic\nai-card: true\n', tail: `${BEGIN}\nr\n${END}\n`, refusal: RUN_CARD },
  'converted region (no flag)': { fm: 'type: topic\n', tail: `${BEGIN}\nr\n${END}\n`, refusal: RUN_CARD },
  'unpaired begin': { fm: 'type: topic\nai-card: true\n', tail: `${BEGIN}\nr\n`, refusal: DAMAGED },
  'duplicate end': { fm: 'type: topic\n', tail: `${BEGIN}\nr\n${END}\n${END}\n`, refusal: DAMAGED },
  'flag only': { fm: 'type: topic\nai-card: true\n', tail: '', refusal: RUN_CARD }
};
const note = c => `---\n${c.fm}---\n\nSome text to rewrite. ${embed}\n\n${c.tail}`;

for (const [name, c] of Object.entries(cases)) {
  test(`editor writers: selection panel refuses ${name} before replaceRange`, async () => {
    for (const [placement, action] of [['after', 'ui.context_ai_insert_here'], ['replace', 'ui.context_ai_accept'], ['append', 'ui.context_ai_append']]) {
      const result = await runPanel({ markdown: note(c), selected: 'text to rewrite', replies: [plan(placement), 'Rewritten'], outcome: true, applyAfter: t(action) });
      assert.equal(result.replaced.length, 0, `${action}: nothing written`);
      assert.match(result.status, c.refusal);
    }
  });
  test(`editor writers: image translate refuses ${name} in an open editor and in a closed file`, async () => {
    const notices = [];
    class Component { load() {} unload() {} registerDomEvent() {} }
    class MarkdownView { constructor(editor) { this.editor = editor; this.file = { path: 'Note.md' }; } }
    const { ImageTranslateAction } = S.load('experiences/markdown-context/image-translate-action.ts', { obsidian: { Component, MarkdownView, Notice: class { constructor(m) { notices.push(m); } }, setIcon() {}, parseYaml: text => require('yaml').parse(text) } });
    const text = note(c);
    const target = { token: { text: embed, occurrence: 0, count: 1 } };
    // Closed file: through the injected guarded process.
    let content = text;
    const closed = new ImageTranslateAction({ workspace: { getLeavesOfType: () => [] }, vault: { process: async () => assert.fail('the unguarded vault must not be used') } }, { processNote: async (_f, edit) => { content = edit(content); } });
    await assert.rejects(() => closed.write(target, { path: 'Note.md' }, '![[egg-en.png]]', 'replace'), c.refusal);
    assert.equal(content, text);
    // Open editor.
    const replaced = [];
    const editor = { getValue: () => text, replaceRange: (...a) => replaced.push(a), offsetToPos: n => n };
    const view = new MarkdownView(editor);
    const open = new ImageTranslateAction({ workspace: { getLeavesOfType: () => [{ view }] } }, {});
    await assert.rejects(() => open.write(target, { path: 'Note.md' }, '![[egg-en.png]]', 'replace'), c.refusal);
    assert.equal(replaced.length, 0);
  });
}

test('editor writers: an ordinary note still takes the selection and image edits', async () => {
  const plain = `---\ntype: topic\n---\n\nSome text to rewrite. ${embed}\n`;
  const result = await runPanel({ markdown: plain, selected: 'text to rewrite', replies: [PLAN, 'Rewritten'], outcome: true, applyAfter: t('ui.context_ai_insert_here') });
  assert.equal(result.replaced.length, 1);
  class Component { load() {} unload() {} registerDomEvent() {} }
  class MarkdownView {}
  const { ImageTranslateAction } = S.load('experiences/markdown-context/image-translate-action.ts', { obsidian: { Component, MarkdownView, Notice: class {}, setIcon() {}, parseYaml: text => require('yaml').parse(text) } });
  let content = plain;
  await new ImageTranslateAction({ workspace: { getLeavesOfType: () => [] } }, { processNote: async (_f, edit) => { content = edit(content); } }).write({ token: { text: embed, occurrence: 0, count: 1 } }, { path: 'Note.md' }, '![[egg-en.png]]', 'replace');
  assert.ok(content.includes('![[egg-en.png]]'));
});
