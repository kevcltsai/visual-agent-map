// Ticket 05 P1: the full-prompt preview is the prompt a run sends (same code path), cut into labelled groups; the workspace
// style fields come from one source shared with the map view; a template block that cannot be read never stops a note.
// Unit level, plus one service-level check with a fake provider. The modal and the settings button are UI-checked separately.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { PREVIEW_STEPS, previewPrompt, previewSections, sampleTaskContext } from "./core/blocks/prompt-preview";
export { createTaskStep } from "./core/steps/task/step";
export { assembledTaskPrompt } from "./core/steps/task/render";
export { lookupBuiltinBlock, builtinTemplateText } from "./core/blocks/builtin";
export { textbookTemplate } from "./ai/detail-templates";
export { NoteStyleStore } from "./ai/note-style-store";
export { translate, noteLanguageOf } from "./i18n";
export { AiTaskService } from "./core/ai-task-service";
`);
const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const PROVIDERS = ['codex', 'claude'];
// A count line that is not a number: the sections parser reports it (line 2). A second format rules heading is no problem any more (Q1).
const BROKEN = '## A\nCount: x\nbody\n';
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const styleCases = language => ({
  default: {},
  textbook: { detailTemplate: M.textbookTemplate(M.noteLanguageOf(language)) },
  'tone summary': { toneText: M.lookupBuiltinBlock('tone', 'summary', language) },
  'custom-legacy tone': { toneText: 'my own voice' },
  'broken body': { styleSelection: { template: { id: 'standard', body: BROKEN }, tone: { id: 'academic' } } }
});
const renderOf = (context, language, provider) =>
  M.createTaskStep('task.run', {}).render({ context, language, provider, providerLabel: 'x', strictGapAudit: false, webResearch: false });

test('counter 6: the preview text is the text the task step renders, and its sections join to it (150 combinations)', () => {
  let combinations = 0;
  for (const step of M.PREVIEW_STEPS) for (const language of LANGUAGES) for (const provider of PROVIDERS) {
    for (const [name, fields] of Object.entries(styleCases(language))) {
      const preview = M.previewPrompt(step.id, language, provider, fields);
      const sent = renderOf(M.sampleTaskContext(step.id, language, fields), language, provider);
      const label = `${step.id} ${language} ${provider} ${name}`;
      assert.equal(preview.text, sent, label);
      assert.equal(preview.sections.map(section => section.text).join(''), preview.text, label);
      assert.ok(preview.sections.length > 0 && preview.sections.every(section => section.text.length > 0), label);
      combinations++;
    }
  }
  assert.equal(combinations, 150);
});

test('counter 6 (sample inputs): the five steps map to their own prompt step, and the sample text is translated', () => {
  const stepOf = { research: 'research', quick: 'quick', decompose: 'decompose', synthesize: 'synthesize', merge: 'merge' };
  assert.equal(M.PREVIEW_STEPS.map(step => step.id).join(), Object.keys(stepOf).join());
  for (const language of LANGUAGES) {
    const titles = new Set();
    for (const step of M.PREVIEW_STEPS) {
      assert.ok(M.translate(language, step.nameKey).length > 0);
      const context = M.sampleTaskContext(step.id, language, {});
      titles.add(context.title);
      assert.equal(context.title, M.translate(language, 'ui.preview_sample_title'));
      assert.equal(M.assembledTaskPrompt(context, language).text.includes(context.task), true, `${step.id} ${language}`);
    }
    assert.equal(titles.size, 1);
  }
  assert.equal(M.sampleTaskContext('quick', 'en', {}).mapAiMode, 'quick');
  assert.equal(M.sampleTaskContext('quick', 'en', {}).researchMode, 'local');
  assert.equal(M.sampleTaskContext('quick', 'en', {}).mode, 'task');
  for (const mode of ['decompose', 'synthesize', 'merge']) assert.equal(M.sampleTaskContext(mode, 'en', {}).mode, mode);
});

test('counter 7 and decision 7: the sections only regroup the text; group names and the sample section are not added to it', () => {
  for (const language of LANGUAGES) for (const step of M.PREVIEW_STEPS) {
    const { text, sections } = M.previewPrompt(step.id, language, 'codex', { toneText: M.lookupBuiltinBlock('tone', 'plain', language) });
    assert.equal(sections.map(section => section.text).join(''), text);
    const groups = sections.map(section => section.group);
    assert.ok(groups.includes('role') && groups.includes('fixed') && groups.includes('input') && groups.includes('tone'), `${step.id} ${language}`);
    assert.equal(groups.includes('template'), step.id !== 'decompose', `${step.id} ${language}`);
    // neighbours of one group are joined
    groups.forEach((group, index) => { if (index) assert.notEqual(group, groups[index - 1]); });
    // the first part is the output-language rule, the last is the task input
    assert.equal(groups[groups.length - 1], 'input');
    for (const word of ['role', 'template', 'tone', 'fixed', 'input']) assert.equal(sections.some(section => section.text.trim() === word), false);
  }
});

test('counter 1 (preview): a broken body shows the built-in text and the reported line', () => {
  for (const language of LANGUAGES) {
    const bad = M.previewPrompt('research', language, 'codex', { styleSelection: { template: { id: 'standard', body: BROKEN, fileName: 'Mine.md' }, tone: { id: 'academic' } } });
    const good = M.previewPrompt('research', language, 'codex', {});
    assert.equal(bad.text, good.text);
    assert.equal(bad.issues.length, 1);
    assert.equal(bad.issues[0].line, 2);
    assert.equal(bad.issues[0].fileName, 'Mine.md');
    assert.equal(good.issues.length, 0);
  }
});

// ---- the workspace style fields ----
const PRESETS = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];
const OWN = '---\n語氣: 簡明\n---\n## 重點\n說明\n';
function makeStore(settingsPatch = {}, files = {}) {
  const state = { ...files };
  const port = {
    list: async folder => Object.keys(state).filter(path => path.startsWith(`${folder}/`)).map(path => path.slice(folder.length + 1)),
    read: async path => state[path],
    folderExists: () => true, createFolder: async () => undefined, create: async () => undefined, trash: async () => undefined
  };
  const settings = { detailTemplates: [], promptPresets: PRESETS, workspaceFolder: 'WS', noteStylesFolder: 'WS/S', language: 'en', ...settingsPatch };
  return new M.NoteStyleStore({ settings: () => settings, port, save: async () => undefined });
}

test('counter 11 (was: the workspace fields, 5 presets, a style file, unset; grilling Q5/Q10): runStyle with no choice gives the general research fields whatever old workspace keys exist, in all three languages', async () => {
  const cases = [...["standard", "textbook", "summary", "plain", "guide"].map(id => ({ defaultNoteStyleId: id })), { defaultNoteStyleId: 'style:Own' }, {}, { defaultDetailTemplateId: 'textbook' }];
  assert.equal(cases.length, 8);
  for (const patch of cases) for (const language of LANGUAGES) {
    const store = makeStore({ ...patch, language }, { 'WS/S/Own.md': OWN });
    await store.refresh();
    const resolved = store.runStyle({ outputLanguage: language });
    const got = { detailTemplate: resolved.template, ...(resolved.toneText ? { toneText: resolved.toneText } : {}), ...resolved.contextFields };
    const label = JSON.stringify(patch) + language;
    assert.equal(resolved.issues.invalid, undefined, label);
    assert.deepEqual(plain(got.detailTemplate), plain(resolved.template), label);
    assert.equal(resolved.template.id, 'standard', label);
    assert.equal(got.toneText, undefined, label);
    assert.equal(got.noteStyle, undefined, label);
    assert.equal(got.styleDiagrams, undefined, label);
    assert.equal(resolved.label.fileName, undefined, label);
    // the preview of these fields is the prompt a run with the same fields renders
    const preview = M.previewPrompt('research', language, 'codex', got);
    assert.equal(preview.text, renderOf(M.sampleTaskContext('research', language, got), language, 'codex'), label);
    assert.equal(preview.issues.length, 0);
  }
});

test('counter 9 (was: a default style file that does not parse is returned as invalid; grilling Q12): an old default style file that does not parse is not read: nothing is invalid, nothing throws', async () => {
  const store = makeStore({ defaultNoteStyleId: 'style:Bad' }, { 'WS/S/Bad.md': '---\n語氣: x\n' });
  await store.refresh();
  let got;
  assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'en' }); });
  assert.equal(got.issues.invalid, undefined);
  assert.equal(got.issues.blockIssues.length, 0);
  assert.equal(got.contextFields.styleSelection, undefined);
});

test('runStyle tone text (was: an old style file decides its own tone; grilling Q12): the tone is the topic\'s tone preset, else academic; an old style file is not read; academic is nothing', async () => {
  const withFile = async (content) => {
    const store = makeStore({}, { 'WS/S/F.md': content });
    await store.refresh();
    return store;
  };
  const text = await withFile('---\n語氣: from file\n---\n## A\ntext\n');
  assert.equal(text.runStyle({ topic: { template: 'style:F' }, map: { tone: 'custom-tone-1' }, outputLanguage: 'en' }).toneText, undefined, 'neither the file nor the map tone is read');
  assert.equal(text.runStyle({ topic: { template: 'style:F', tone: 'custom-tone-1' }, outputLanguage: 'en' }).toneText, 'Talk like a pirate.');
  const store = makeStore({}, {});
  await store.refresh();
  assert.equal(store.runStyle({ topic: { tone: 'custom-tone-1' }, outputLanguage: 'en' }).toneText, 'Talk like a pirate.');
  // #18: a run's own tone is gone, so { choice: { tone: 'academic' } } no longer beats the topic's tone (replacement: steps-run-style.cjs slice 12)
  assert.equal(store.runStyle({ choice: { tone: 'academic' }, topic: { tone: 'custom-tone-1' }, outputLanguage: 'en' }).toneText, 'Talk like a pirate.');
  assert.equal(store.runStyle({ outputLanguage: 'en' }).toneText, undefined);
});

// ---- the service: a broken block never stops a note ----
test('counter 10: with a broken body in styleSelection the fake provider still writes the note and gets the built-in template text', async () => {
  const prompts = [];
  const NOTE = 'A written note.';
  const runtime = { runTask: async prompt => { prompts.push(prompt); return JSON.stringify({ summary: 'S', detail: NOTE, suggestions: [], visualReferences: [] }); } };
  const service = new M.AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false,
    diagramsEnabled: () => false, mermaidParses: async () => true, codexRuntime: () => runtime, claudeRuntime: () => runtime
  });
  const base = { title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do it', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'auto', outputLanguage: 'en' };
  const result = await service.askModel({ ...base, styleSelection: { template: { id: 'standard', body: BROKEN }, tone: { id: 'academic' } } }, 'gpt-6-luna', 'low');
  assert.equal(result.detail, NOTE);
  const plainRun = await service.askModel({ ...base }, 'gpt-6-luna', 'low');
  assert.equal(plainRun.detail, NOTE);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1], 'the prompt is the built-in one');
  assert.equal(prompts[0].includes('### A\n'), false, 'the unreadable block text is not in it');
  assert.ok(prompts[0].includes('### Key knowledge: The concepts, data, mechanisms and background needed to understand the conclusions.\n'), 'the built-in standard template section is in it');
});

// P2: group headings are UI only (never inside the prompt text), exist in every language, and the modal shows text as plain text.
test('counter 7 (P2): the group headings are translated and never appear in the prompt text', () => {
  const groups = ['role', 'template', 'tone', 'fixed', 'input'];
  for (const language of LANGUAGES) {
    const titles = groups.map(group => M.translate(language, `ui.preview_group_${group}`));
    assert.equal(new Set(titles).size, groups.length, `${language}: five different headings`);
    for (const step of M.PREVIEW_STEPS) for (const provider of PROVIDERS) {
      const preview = M.previewPrompt(step.id, language, provider, {});
      for (const title of titles) assert.equal(preview.text.includes(title), false, `${language} ${step.id}: "${title}" is not prompt text`);
    }
  }
});

test('counter 8 (P2): the modal never renders markup or Markdown', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'ui/modals/prompt-preview-modal.ts'), 'utf8');
  assert.equal(/MarkdownRenderer|innerHTML|insertAdjacentHTML/.test(source), false);
});

// F1: the reason text from styleIssueText already ends with its own full stop, so the two notice templates must not add another.
test('F1: the unreadable-block and invalid-style notices never end a reason with doubled sentence punctuation', () => {
  const S = require('./support.cjs');
  const i18n = S.load('i18n.ts');
  const obsidian = { ...S.obsidian, PluginSettingTab: class {}, Setting: class {}, Modal: class {} };
  const { styleIssueText } = S.load('experiences/visual-map/note-style-picker.ts', { obsidian });
  const codes = ['file_long', 'tone_long', 'frontmatter_unclosed', 'key_duplicate', 'no_sections', 'count_invalid', 'comment_unclosed', 'format_heading_repeated'];
  const doubled = /[。．.！!？?]\s*[。．.！!？?]/;
  try {
    for (const language of LANGUAGES) {
      i18n.setUiLanguage(language);
      for (const code of codes) {
        const reason = styleIssueText({ code, line: 3, values: ['a', 'b'], message: 'x' });
        for (const key of ['ui.preview_style_invalid_0_1_2', 'ui.preview_issue_0_1_2']) {
          const shown = i18n.t(key, 'Style.md', 3, reason);
          assert.ok(shown.includes(reason), `${language} ${key} ${code}: the reason is shown`);
          assert.equal(doubled.test(shown), false, `${language} ${key} ${code}: ${shown}`);
        }
      }
    }
  } finally { i18n.setUiLanguage('en'); }
});

// Note style recipe T5 P4 (decision #42 D7): the preview can show a style that is not saved (the style editor's draft).
test('P4: the preview modal shows the style `styleOf` gives, read each time the body is drawn; without it the workspace default style is shown as before', () => {
  const dom = require('./support-dom.cjs');
  const S = require('./support.cjs');
  const { PromptPreviewModal } = S.load('ui/modals/prompt-preview-modal.ts', { obsidian: { ...S.obsidian, Modal: dom.makeModal() } });
  const textbook = M.textbookTemplate('en');
  const store = { refresh: async () => {}, runStyle: () => ({ template: M.textbookTemplate('en'), formatText: '', contextFields: {}, issues: {} }) };
  const draft = { template: { ...textbook, sections: [{ ...textbook.sections[0], name: 'Draft section name' }, ...textbook.sections.slice(1)] }, formatText: '', contextFields: {}, issues: {} };
  const bodyText = modal => dom.texts(modal.contentEl).join('\n');
  const withDraft = new PromptPreviewModal({}, store, 'en', 'codex', undefined, () => draft);
  withDraft.open();
  assert.match(bodyText(withDraft), /Draft section name/);
  const plainModal = new PromptPreviewModal({}, store, 'en', 'codex');
  plainModal.open();
  assert.equal(/Draft section name/.test(bodyText(plainModal)), false);
});
