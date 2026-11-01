// Note style files (P1b): structure text (sections and intro layouts, callout instructions), format preferences,
// canonicalDetail for the intro layout, count checks, and the background chart gate. Pure prompt/parse level (unit).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { parseNoteStyleFile, CANONICAL_VERSIONS, CANONICAL_LANGUAGES, NOTE_STYLE_BUILTIN_IDS } from "./ai/note-style-file";
export { detailStructurePrompt, checkCounts, standardTemplate, textbookTemplate, validateTemplate, sectionLookup } from "./ai/detail-templates";
export { canonicalDetail } from "./ai/result-utils";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
// P2: the switches moved into the upgrade module and are frozen there (only the upgrade applies them to the format zone).
export { legacyObsidianFormat as obsidianFormat, readLegacyFormatPreferences } from "./ai/note-style-upgrade";
export { translate } from "./i18n";
export { AiTaskService } from "./core/ai-task-service";
`);
const parse = text => {
  const result = M.parseNoteStyleFile(text, { id: 'style:S', name: 'S' });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  return result.style;
};
const structure = (style, language = 'en') => M.detailStructurePrompt(style.template, language, headings => `STANDARD ${headings}`);
const ON = { callouts: 'auto', diagrams: true, tables: true, tasks: true, highlight: true };
const LANGUAGES = ['en', 'zh-TW'];

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

test('format preferences: all default is the original text, for both instruction languages', () => {
  for (const language of LANGUAGES) {
    const original = M.inLanguage(M.OBSIDIAN_FORMAT, language);
    assert.equal(M.obsidianFormat(language, undefined), original);
    assert.equal(M.obsidianFormat(language, ON), original);
  }
});

test('canonical v2 builds exactly the same prompt as v1 for every built-in and language', () => {
  const pref = text => M.readLegacyFormatPreferences(text);
  for (const id of M.NOTE_STYLE_BUILTIN_IDS)
    for (const language of M.CANONICAL_LANGUAGES) {
      const one = parse(M.CANONICAL_VERSIONS[0][id][language]), two = parse(M.CANONICAL_VERSIONS[1][id][language]);
      for (const instruction of LANGUAGES) {
        assert.equal(M.obsidianFormat(instruction, pref(M.CANONICAL_VERSIONS[1][id][language])), M.obsidianFormat(instruction, pref(M.CANONICAL_VERSIONS[0][id][language])), `${id}.${language}`);
        assert.equal(structure(two, instruction), structure(one, instruction), `${id}.${language}`);
      }
      assert.equal(two.tone, one.tone);
      assert.equal(two.layout, one.layout);
      assert.equal(two.intro, one.intro);
    }
});

const SENTINELS = {
  'en': { callout: '`> [!summary]`', diagrams: '```mermaid```', tables: 'a Markdown table', tasks: '`- [ ]`', highlight: '==highlight==' },
  'zh-TW': { callout: '`> [!summary]`', diagrams: '```mermaid```', tables: 'Markdown 表格', tasks: '`- [ ]`', highlight: '==highlight==' }
};
test('format preferences: each switch alone removes its syntax line, names itself in the sentence, keeps rules 1-10 verbatim', () => {
  for (const language of LANGUAGES) {
    const original = M.inLanguage(M.OBSIDIAN_FORMAT, language);
    const rulesOf = text => text.slice(text.search(/\n(?:規則|Rules)[:：]\n/));
    const cases = [
      ['diagrams', { ...ON, diagrams: false }, /mermaid/],
      ['tables', { ...ON, tables: false }, SENTINELS[language].tables],
      ['tasks', { ...ON, tasks: false }, /`- \[ \]`/],
      ['highlight', { ...ON, highlight: false }, /==highlight==/]
    ];
    for (const [key, preferences, gone] of cases) {
      const text = M.obsidianFormat(language, preferences);
      const bullets = text.split('\n').filter(line => line.startsWith('- '));
      const before = original.split('\n').filter(line => line.startsWith('- '));
      if (key === 'diagrams') {
        assert.equal(bullets.length, before.length - 1);
        assert.ok(!bullets.some(line => line.includes('```mermaid```')));
        const tableLine = bullets.find(line => line.includes(SENTINELS[language].tables));
        assert.ok(tableLine && !/xychart|pie/.test(tableLine), 'table line keeps only the table');
      } else {
        assert.equal(bullets.length, before.length - 1, key);
        assert.ok(!bullets.some(line => (typeof gone === 'string' ? line.includes(gone) : gone.test(line))), key);
      }
      assert.ok(bullets.some(line => line.includes('> [!summary]')), `${key}: callout lines stay`);
      assert.equal(rulesOf(text), rulesOf(original), `${key}: rules unchanged`);
      assert.match(text, language === 'en' ? /This style does not use:/ : /這個風格不使用：/);
      assert.doesNotMatch(text, language === 'en' ? /only where the style places/ : /callout 只用在風格指定的位置/);
    }
  }
});

test('format preferences: callouts "auto" with other switches off keeps callout lines and never says callouts are only placed', () => {
  for (const language of LANGUAGES) {
    const text = M.obsidianFormat(language, { callouts: 'auto', diagrams: false, tables: false, tasks: false, highlight: false });
    assert.ok(text.includes('> [!summary]'));
    assert.doesNotMatch(text, language === 'en' ? /Use callouts only where/ : /callout 只用在風格指定的位置/);
  }
});

test('format preferences: placed callouts remove callout lines, say rule 5 is overridden, and leave no other "must use a callout" line', () => {
  for (const language of LANGUAGES) {
    const text = M.obsidianFormat(language, { ...ON, callouts: 'placed' });
    const bullets = text.split('\n').filter(line => line.startsWith('- '));
    assert.ok(!bullets.some(line => line.includes('> [!')));
    assert.match(text, language === 'en' ? /Use callouts only where the style places them; the foldable callout in rule 5/ : /callout 只用在風格指定的位置；規則 5 的可摺疊 callout/);
    assert.match(text, language === 'en' ? /This style does not use: callouts/ : /這個風格不使用：callout/);
  }
});

test('format preferences: every syntax off still yields one coherent block', () => {
  const text = M.obsidianFormat('en', { callouts: 'placed', diagrams: false, tables: false, tasks: false, highlight: false });
  assert.match(text, /by the shape of the content[^]*\n\nThis style does not use:[^\n]*\n\nRules:\n1\./);
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
  // What the old switch did, as the upgrade writes it: a block whose format zone lacks the mermaid line.
  const block = format => ({ template: { id: 'file:X', body: `## A\nx\n\n# ${M.translate('en', 'ui.block_template_format_heading')}\n\n${format}\n` }, tone: { id: 'academic' } });
  const off = block(M.obsidianFormat('en', { ...ON, diagrams: false }));
  const on = block(M.obsidianFormat('en', ON));
  for (const mode of ['task', 'synthesize']) {
    assert.equal(service.chartEligible({ ...base, mode, styleSelection: off }), false, mode);
    assert.equal(service.chartEligible({ ...base, mode, styleSelection: on }), diagrams, mode);
  }
});

test('callout map (P1): swaps the type, keeps danger, tip line swaps both types, off drops the line, placed overrides, default is byte-identical', () => {
  for (const language of LANGUAGES) {
    const original = M.inLanguage(M.OBSIDIAN_FORMAT, language);
    assert.equal(M.obsidianFormat(language, { ...ON, calloutMap: {} }), original);
    const mapped = M.obsidianFormat(language, { ...ON, calloutMap: { summary: 'abstract', warning: 'caution', tip: 'example' } });
    const bullets = mapped.split('\n').filter(line => line.startsWith('- '));
    assert.ok(!bullets.some(line => line.includes('`> [!summary]`')));
    assert.ok(bullets.some(line => line.includes('`> [!abstract]`')));
    assert.ok(bullets.some(line => line.includes('`> [!caution]`') && line.includes('`> [!danger]`') && !line.includes('[!warning]')));
    assert.ok(bullets.some(line => line.includes('`> [!example]`') && !line.includes('[!tip]')));
    assert.ok(bullets.some(line => line.includes('`> [!question]`')));
    assert.equal(bullets.length, original.split('\n').filter(line => line.startsWith('- ')).length);
    const off = M.obsidianFormat(language, { ...ON, calloutMap: { question: 'off', warning: 'off' } });
    assert.ok(!off.includes('[!question]') && !off.includes('[!danger]') && !off.includes('[!warning]'));
    assert.ok(off.includes('`> [!summary]`'));
    assert.ok(!/這個風格不使用|This style does not use/.test(off));
    const placed = M.obsidianFormat(language, { ...ON, callouts: 'placed', calloutMap: { summary: 'abstract' } });
    assert.equal(placed, M.obsidianFormat(language, { ...ON, callouts: 'placed' }));
  }
});

test('callout map (P1): a parsed style file carries its map into the prompt', () => {
  const style = parse('---\n方框: 自動\n結論方框: abstract\n問題方框: 關\n---\n## A\nx\n');
  const text = M.obsidianFormat('en', M.readLegacyFormatPreferences('---\n方框: 自動\n結論方框: abstract\n問題方框: 關\n---\n## A\nx\n'));
  assert.ok(style.sections.length === 1);
  assert.ok(text.includes('`> [!abstract]`') && !text.includes('[!question]') && !text.includes('`> [!summary]`'));
});
