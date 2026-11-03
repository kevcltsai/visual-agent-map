// Note style files (P1b): structure text (sections and intro layouts, callout instructions),
// canonicalDetail for the intro layout, count checks, and the background chart gate. Pure prompt/parse level (unit).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { parseNoteStyleFile } from "./ai/note-style-file";
export { detailStructurePrompt, checkCounts, standardTemplate, textbookTemplate, validateTemplate, sectionLookup } from "./ai/detail-templates";
export { canonicalDetail } from "./ai/result-utils";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { translate } from "./i18n";
export { AiTaskService } from "./core/ai-task-service";
`);
const parse = text => {
  const result = M.parseNoteStyleFile(text, { id: 'style:S', name: 'S' });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result.style;
};
const structure = (style, language = 'en') => M.detailStructurePrompt(style.template, language, headings => `STANDARD ${headings}`);

const INTRO = '---\n圖表: 關\n---\n先用 2–4 段導讀\n帶讀者進入主題。\n\n## 核心結論\n數量: 至少 3\n> [!summary]-\n> 用 1–3 句\n> 講結論。\n\n## 常見誤解\n> [!warning]\n> 用「初學者常以為…，其實…」。\n\n## 證據與來源\n列出來源。\n\n## 更新紀錄\n一行。\n';
const SECTIONS = '## 核心結論\n講結論。\n\n## 常見誤解\n> [!warning]\n> 句型。\n\n## 更新紀錄\n一行。\n';

test('intro layout: lead-in sentence, headings in order, empty sections omitted, callout sentences, multi-line bodies joined', () => {
  const style = parse(INTRO);
  assert.equal(style.template.layout, 'intro');
  assert.equal(style.template.intro, '先用 2–4 段導讀\n帶讀者進入主題。');
  const en = structure(style, 'en');
  assert.match(en, /2–4 lead-in paragraphs with no heading[^]*先用 2–4 段導讀 帶讀者進入主題。/);
  assert.match(en, /these 4 level-three headings in order: ### 核心結論, ### 常見誤解, ### 證據與來源, ### 更新紀錄/);
  assert.match(en, /never write 'No new content this time'/);
  assert.match(en, /In ### 核心結論, use one `> \[!summary\]-` callout: 用 1–3 句 講結論。/);
  assert.match(en, /In ### 常見誤解, use one `> \[!warning\]` callout: 用「初學者常以為…，其實…」。/);
  assert.match(en, /### 核心結論 has at least 3 items|核心結論.*3/);
  const zh = structure(style, 'zh-TW');
  assert.match(zh, /導讀指示：「先用 2–4 段導讀 帶讀者進入主題。」/);
  assert.match(zh, /### 核心結論 使用一個 `> \[!summary\]-` callout：用 1–3 句 講結論。/);
  assert.match(zh, /### 更新紀錄 只新增一行本次變更摘要/);
});

test('sections layout uses the custom structure with the "no new content" sentence and callout rules; nothing is added without callouts', () => {
  const style = parse(SECTIONS);
  assert.equal(style.template.layout, 'sections');
  const en = structure(style, 'en');
  assert.match(en, /Write 'No new content this time' in sections with nothing applicable/);
  assert.match(en, /In ### 常見誤解, use one `> \[!warning\]` callout: 句型。/);
  const plainTemplate = { id: 'u1', name: 'U', sections: [{ id: 'a', name: 'A', description: 'd', role: 'none', aliases: [] }] };
  assert.doesNotMatch(M.detailStructurePrompt(plainTemplate, 'en', () => ''), /callout|lead-in/);
});

test('an empty callout body leaves just the placement sentence', () => {
  const style = parse('## A\n> [!tip]\n\n## B\ntext\n');
  const text = structure(style, 'en');
  assert.match(text, /In ### A, use one `> \[!tip\]` callout\./);
  assert.doesNotMatch(text, /callout:\s*$/m);
});

test('canonicalDetail intro layout: keeps the lead-in, omits empty sections, footnotes join the sources section or go last', () => {
  const style = parse(INTRO);
  const reply = ['Lead one.', '', 'Lead two.', '', '### 核心結論', '', 'A\n- 1\n- 2\n- 3', '', '### 常見誤解', '', 'No new content this time', '', '### 證據與來源', '', 'S[^1]', '', '[^1]: [Doc](https://example.com)'].join('\n');
  const out = M.canonicalDetail(reply, 'zh-TW', style.template);
  assert.match(out, /^Lead one\.\n\nLead two\.\n\n### 核心結論/);
  assert.doesNotMatch(out, /常見誤解|更新紀錄|No new content/);
  assert.match(out, /### 證據與來源\n\nS\[\^1\]\n\n\[\^1\]: \[Doc\]/);
  const noSources = parse('Intro.\n\n## A\ntext\n');
  const last = M.canonicalDetail('Intro.\n\n### A\n\nbody[^1]\n\n[^1]: [Doc](https://example.com)', 'zh-TW', noSources.template);
  assert.match(last, /body\[\^1\]\n\n\[\^1\]: \[Doc\]\(https:\/\/example\.com\)$/);
});

test('canonicalDetail sections layout writes the no-new-content sentence for empty sections; standard and textbook are unchanged', () => {
  const style = parse(SECTIONS);
  const out = M.canonicalDetail('### 核心結論\n\nx', 'en', style.template);
  assert.match(out, /### 常見誤解\n\n[^\n]+/);
  assert.match(out, /### 更新紀錄/);
  const standard = M.standardTemplate('en');
  assert.equal(M.canonicalDetail('### Core conclusions\n\nx', 'en', standard).split('###').length, 7);
  const textbook = M.textbookTemplate('en');
  assert.equal(M.canonicalDetail('lead\n\n### Core conclusions\n\nx', 'en', textbook), 'lead\n\n### Core conclusions\n\nx');
});

test('count syntax reaches checkCounts; validateTemplate and sectionLookup still accept the style template unchanged', () => {
  const style = parse(INTRO);
  const issues = M.checkCounts('### 核心結論\n\n- a\n- b\n', style.template);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].n, 3);
  assert.equal(M.checkCounts('### 核心結論\n\n- a\n- b\n- c\n', style.template).length, 0);
  assert.equal(M.validateTemplate(style.template, []).length, 0);
  assert.equal(M.sectionLookup(style.template).get('核心結論'), 0);
});

test('chartEligible (was: styleDiagrams false blocks the chart step): the upgraded block decides; the old flag is gone and ignored', () => {
  const service = new M.AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false });
  const base = { title: 'T', summary: 's', rules: '', detail: '', task: 'x', ancestors: '', mode: 'task', addCharts: true };
  const diagrams = service.diagramsOn();
  assert.equal(service.chartEligible(base), diagrams);
  // The old gate no longer exists: the flag changes nothing.
  assert.equal(service.chartEligible({ ...base, styleDiagrams: false }), diagrams);
  // The format rules are a part of their own (Q1): rules that lack the mermaid line turn the chart step off.
  const block = format => ({ template: { id: 'file:X', body: '## A\nx\n' }, format: { id: 'file:X', body: format }, tone: { id: 'academic' } });
  const full = M.inLanguage(M.OBSIDIAN_FORMAT, 'en');
  const withoutMermaid = full.split('\n').filter(line => !line.includes('mermaid')).join('\n');
  assert.notEqual(withoutMermaid, full);
  const off = block(withoutMermaid);
  const on = block(full);
  for (const mode of ['task', 'synthesize']) {
    assert.equal(service.chartEligible({ ...base, mode, styleSelection: off }), false, mode);
    assert.equal(service.chartEligible({ ...base, mode, styleSelection: on }), diagrams, mode);
  }
});
