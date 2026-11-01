// Built-in note-style blocks (P1): the registry bodies equal the text the prompt carries today. Unit level.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { BUILTIN_BLOCKS, lookupBuiltinBlock } from "./core/blocks/builtin";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { builtinPresets } from "./ai/prompt-presets";
export { translate } from "./i18n";
`);
const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];

test('standard Obsidian format block equals the format fragment in all three languages', () => {
  for (const language of LANGUAGES) {
    assert.equal(M.lookupBuiltinBlock('format', 'standard-obsidian', language), M.inLanguage(M.OBSIDIAN_FORMAT, language));
  }
});

test('academic rigor tone block is empty; the other tones equal the built-in tone presets', () => {
  for (const language of LANGUAGES) {
    assert.equal(M.lookupBuiltinBlock('tone', 'academic', language), '');
    for (const id of ['plain', 'magazine', 'summary', 'guide', 'auto']) {
      const preset = M.builtinPresets(language, 'tone').find(item => item.id === id);
      assert.ok(preset.text.length > 0);
      assert.equal(M.lookupBuiltinBlock('tone', id, language), preset.text);
    }
  }
});

test('plain text format has no callout, mermaid, task list or highlight syntax and keeps the shared rules', () => {
  for (const language of LANGUAGES) {
    const body = M.lookupBuiltinBlock('format', 'plain-text', language);
    for (const banned of ['[!', 'mermaid', '- [ ]', '==']) assert.equal(body.includes(banned), false, `${language}: ${banned}`);
    assert.ok(body.includes('####'));
    assert.ok(body.endsWith('\\]`。') || body.endsWith('\\]`.'));
  }
});

test('plain text rules are verbatim lines of the standard format rules', () => {
  for (const language of LANGUAGES) {
    const standard = M.lookupBuiltinBlock('format', 'standard-obsidian', language);
    const rules = M.lookupBuiltinBlock('format', 'plain-text', language).split('\n').filter(line => /^\d\. /.test(line));
    assert.equal(rules.length, 5);
    for (const rule of rules) assert.ok(standard.includes(rule.replace(/^\d\. /, '')), rule);
  }
});

test('template blocks are registered with names; every block has a name in all languages', () => {
  const templates = M.BUILTIN_BLOCKS.filter(block => block.category === 'template').map(block => block.id);
  assert.equal(templates.join(), 'standard,textbook');
  for (const block of M.BUILTIN_BLOCKS) {
    for (const language of LANGUAGES) assert.ok(M.translate(language, block.nameKey).length > 0, `${block.id} ${language}`);
  }
});

test('an unknown block id or category throws instead of returning an empty body', () => {
  assert.throws(() => M.lookupBuiltinBlock('format', 'nope', 'en'), /Unknown built-in block/);
  assert.throws(() => M.lookupBuiltinBlock('tone', 'standard-obsidian', 'en'), /Unknown built-in block/);
});

// P2: the assembler behind the regular task prompt. Loaded lazily so a missing module fails only these tests.
let assemblerModule;
const A = () => assemblerModule ??= loadSource(`
export { assembleTaskPrompt, promptStepOf, selectionFromContext } from "./core/steps/task/assemble";
export { generalTaskPrompt } from "./core/steps/task/render";
export { JSON_CONTRACT, GENERAL_TASK } from "./core/steps/task/fragments";
export { ROLE, SOURCE_SAFETY, withProviderOutput, inLanguage, toneBlock } from "./core/steps/_shared/fragments";
`);
const base = { title: 'Topic T', summary: 'Current summary S', rules: 'Rule R', detail: 'Existing detail D', task: 'Do task X', ancestors: 'Ancestor A', workingFindings: 'Older finding F', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
const STEP_CONTEXTS = {
  research: { ...base },
  quick: { ...base, researchMode: 'local', visualMode: 'off', mapAiMode: 'quick' },
  decompose: { ...base, mode: 'decompose', researchDepth: 'deep' },
  synthesize: { ...base, mode: 'synthesize', researchMode: 'local', visualMode: 'off' },
  merge: { ...base, mode: 'merge', researchMode: 'local', visualMode: 'off' }
};
const stepContexts = language => Object.entries(STEP_CONTEXTS).map(([name, context]) => [name, { ...context, outputLanguage: language }]);
const dropSummaryLine = body => body.split('\n').filter(line => !line.includes('[!summary]')).join('\n');

test('counter 1: a format block without the summary line produces prompts without [!summary] and keeps the other lines', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const body = dropSummaryLine(M.lookupBuiltinBlock('format', 'standard-obsidian', language));
    assert.notEqual(body, M.lookupBuiltinBlock('format', 'standard-obsidian', language));
    const blocks = { 'format/standard-obsidian': () => body };
    for (const [name, context] of stepContexts(language)) {
      const { text } = m.assembleTaskPrompt(m.selectionFromContext(context, language), m.promptStepOf(context), context, language, 'codex', { blocks });
      assert.equal(text.includes('[!summary]'), false, `${language} ${name}`);
      if (name !== 'decompose' && name !== 'merge') {
        assert.ok(text.includes(body), `${language} ${name}: the other format lines stay`);
        assert.ok(text.includes('[!warning]'), `${language} ${name}`);
      }
    }
  }
});

test('counter 2: the plain text format carries no callout, mermaid, task list or highlight syntax; the fixed parts stay', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const [name, context] of stepContexts(language).filter(([step]) => ['research', 'quick', 'synthesize'].includes(step))) {
      const selection = { ...m.selectionFromContext(context, language), format: { id: 'plain-text' } };
      const { text, segments } = m.assembleTaskPrompt(selection, m.promptStepOf(context), context, language);
      for (const banned of ['[!', 'mermaid', '- [ ]', '==']) assert.equal(text.includes(banned), false, `${language} ${name}: ${banned}`);
      assert.ok(text.includes(M.lookupBuiltinBlock('format', 'plain-text', language)));
      for (const id of ['role', 'source-safety', 'json-contract', 'step']) assert.ok(segments.some(s => s.source.kind === 'fixed' && s.source.id === id), `${language} ${name}: ${id}`);
    }
  }
});

test('counter 3: the academic rigor tone equals no tone and adds no tone rule sentence', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const [name, context] of stepContexts(language)) {
      const none = m.assembleTaskPrompt(m.selectionFromContext(context, language), m.promptStepOf(context), context, language);
      const selection = { ...m.selectionFromContext(context, language), tone: { id: 'academic' } };
      const academic = m.assembleTaskPrompt(selection, m.promptStepOf(context), context, language);
      assert.equal(academic.text, none.text, `${language} ${name}`);
      assert.equal(academic.text, m.generalTaskPrompt(context, language));
      assert.equal(/語氣規則|语气规则|Tone rule/.test(academic.text), false);
    }
  }
});

test('counter 4: segments join into the text, none is empty, each has a source; decompose has no template or format, merge no format', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const provider of ['codex', 'claude']) {
      for (const [name, base0] of stepContexts(language)) {
        for (const context of [base0, { ...base0, sourceContext: undefined, toneText: 'Tone: example.' }, { ...base0, mode: undefined, detailFormat: 'adaptive' }]) {
          const { text, segments } = m.assembleTaskPrompt(m.selectionFromContext(context, language), m.promptStepOf(context), context, language, provider);
          assert.equal(segments.map(s => s.text).join(''), text, `${language} ${name}`);
          assert.equal(text, m.generalTaskPrompt(context, language, provider));
          for (const segment of segments) {
            assert.ok(segment.text.length > 0);
            assert.ok(['block', 'fixed', 'input', 'separator'].includes(segment.source.kind));
          }
          const categories = segments.filter(s => s.source.kind === 'block').map(s => s.source.category);
          if (context.mode === 'decompose') assert.equal(categories.filter(c => c === 'template' || c === 'format').length, 0);
          if (context.mode === 'merge') assert.equal(categories.includes('format'), false);
        }
      }
    }
  }
});

test('counter 5: the fixed parts are present and equal their fragments', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const provider of ['codex', 'claude']) {
      const context = { ...base, outputLanguage: language };
      const { segments } = m.assembleTaskPrompt(m.selectionFromContext(context, language), 'research', context, language, provider);
      const fixed = id => segments.find(s => s.source.kind === 'fixed' && s.source.id === id);
      assert.equal(fixed('role').text, m.inLanguage(m.ROLE, language));
      assert.equal(fixed('source-safety').text, m.inLanguage(m.SOURCE_SAFETY, language));
      assert.equal(fixed('json-contract').text, m.withProviderOutput(m.inLanguage(m.JSON_CONTRACT, language), provider, language));
      assert.equal(fixed('json-contract').text.includes('StructuredOutput'), provider === 'claude');
      assert.equal(fixed('step').text, m.inLanguage(m.GENERAL_TASK, language));
      assert.ok(fixed('step').text.includes('80'));
      assert.ok(fixed('reference-citations'));
      const withoutSources = m.assembleTaskPrompt(m.selectionFromContext({ ...context, sourceContext: undefined }, language), 'research', { ...context, sourceContext: undefined }, language, provider);
      assert.equal(withoutSources.segments.some(s => s.source.id === 'reference-citations'), false);
    }
  }
});

test('counter 6: an unknown block id throws instead of leaving the prompt without that block', () => {
  const m = A();
  const context = { ...base, outputLanguage: 'en' };
  const selection = m.selectionFromContext(context, 'en');
  assert.throws(() => m.assembleTaskPrompt({ ...selection, format: { id: 'nope' } }, 'research', context, 'en'), /Unknown built-in block/);
  assert.throws(() => m.assembleTaskPrompt({ ...selection, tone: { id: 'nope' } }, 'research', context, 'en'), /Unknown built-in block/);
});

test('counter 7: selectionFromContext maps a known tone text to its built-in block and keeps an unknown one as custom-legacy', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const plain = M.lookupBuiltinBlock('tone', 'plain', language);
    assert.equal(m.selectionFromContext({ ...base, toneText: plain }, language).tone.id, 'plain');
    const custom = m.selectionFromContext({ ...base, toneText: 'my own voice' }, language).tone;
    assert.equal(custom.id, 'custom-legacy');
    assert.equal(custom.body, 'my own voice');
    assert.equal(m.selectionFromContext(base, language).tone, undefined);
    assert.equal(m.selectionFromContext(base, language).format.id, 'standard-obsidian');
    assert.equal(m.selectionFromContext({ ...base, detailFormat: 'adaptive' }, language).template.adaptive, true);
  }
});

test('counter 8: promptStepOf covers all six values; a quick count repair is a research step', () => {
  const m = A();
  assert.equal(m.promptStepOf(STEP_CONTEXTS.research), 'research');
  assert.equal(m.promptStepOf(STEP_CONTEXTS.quick), 'quick');
  assert.equal(m.promptStepOf(STEP_CONTEXTS.decompose), 'decompose');
  assert.equal(m.promptStepOf(STEP_CONTEXTS.synthesize), 'synthesize');
  assert.equal(m.promptStepOf(STEP_CONTEXTS.merge), 'merge');
  assert.equal(m.promptStepOf({ ...base, mode: undefined }), 'default');
  assert.equal(m.promptStepOf({ ...STEP_CONTEXTS.quick, countRepair: true }), 'research');
});

test('P3: every template block parses as a note style file and has the canonical v2 section headings', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const S = loadSource(`
export { parseNoteStyleFile } from "./ai/note-style-file";
export { standardTemplate, textbookTemplate } from "./ai/detail-templates";
`);
  for (const id of ['standard', 'textbook']) {
    for (const language of LANGUAGES) {
      const body = M.lookupBuiltinBlock('template', id, language);
      const parsed = S.parseNoteStyleFile(body, { id, name: id });
      assert.equal(parsed.ok, true, `${id} ${language} ${JSON.stringify(parsed.issues)}`);
      assert.equal(/tone:|語氣|语气|%%/.test(body), false, `${id} ${language} keeps no switch or comment`);
      const canonical = fs.readFileSync(path.join(__dirname, '..', 'core', 'note-styles', 'canonical', 'v2', `${id}.${language}.md`), 'utf8');
      const reference = S.parseNoteStyleFile(canonical, { id, name: id });
      assert.equal(reference.ok, true);
      const names = style => style.sections.map(section => section.name);
      assert.deepEqual(names(parsed.style), names(reference.style), `${id} ${language}`);
      assert.equal(parsed.style.intro, reference.style.intro, `${id} ${language} intro`);
    }
  }
  for (const language of ['zh-TW', 'en']) {
    const standard = S.parseNoteStyleFile(M.lookupBuiltinBlock('template', 'standard', language), { id: 's', name: 's' });
    const names = standard.style.sections.map(section => section.name);
    assert.deepEqual(names, S.standardTemplate(language).sections.map(section => section.name), language);
  }
});
