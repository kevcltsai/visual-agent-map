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

test('template blocks are registered with names; every block has a name in all languages', () => {
  const templates = M.BUILTIN_BLOCKS.filter(block => block.category === 'template').map(block => block.id);
  assert.equal(templates.join(), 'standard,textbook');
  for (const block of M.BUILTIN_BLOCKS) {
    for (const language of LANGUAGES) assert.ok(M.translate(language, block.nameKey).length > 0, `${block.id} ${language}`);
  }
});

test('an unknown block id or category throws instead of returning an empty body', () => {
  assert.throws(() => M.lookupBuiltinBlock('template', 'nope', 'en'), /Unknown built-in block/);
  assert.throws(() => M.lookupBuiltinBlock('tone', 'standard', 'en'), /Unknown built-in block/);
  assert.throws(() => M.lookupBuiltinBlock('format', 'standard-obsidian', 'en'), /Unknown built-in block/);
});

// P2: the assembler behind the regular task prompt. Loaded lazily so a missing module fails only these tests.
let assemblerModule;
const A = () => assemblerModule ??= loadSource(`
export { assembleTaskPrompt, promptStepOf, selectionFromContext } from "./core/steps/task/assemble";
export { generalTaskPrompt } from "./core/steps/task/render";
export { JSON_CONTRACT, GENERAL_TASK } from "./core/steps/task/fragments";
export { ROLE, SOURCE_SAFETY, withProviderOutput, inLanguage, toneBlock, OBSIDIAN_FORMAT } from "./core/steps/_shared/fragments";
export { builtinTemplateText } from "./core/blocks/builtin";
export { chartsWanted } from "./core/steps/task/assemble";
export { parseTemplateBlock } from "./core/blocks/template-block";
export { detailStructurePrompt, standardTemplate, textbookTemplate } from "./ai/detail-templates";
export { detailStructure, customDetailStructure, customDetailRule } from "./core/steps/task/fragments";
export { noteLanguageOf } from "./i18n";
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

test('counter 1: a template whose format rules lack the summary line produces prompts without [!summary] and keeps the other lines', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const full = m.builtinTemplateText('standard', language);
    const edited = dropSummaryLine(full);
    assert.notEqual(edited, full);
    const format = m.parseTemplateBlock(edited, { id: 'standard', name: 'standard' }).format;
    const blocks = { 'template/standard': () => edited };
    for (const [name, context] of stepContexts(language)) {
      const { text, segments } = m.assembleTaskPrompt(m.selectionFromContext(context, language), m.promptStepOf(context), context, language, 'codex', { blocks });
      assert.equal(text.includes('[!summary]'), false, `${language} ${name}`);
      if (name !== 'decompose' && name !== 'merge') {
        assert.ok(text.includes(format), `${language} ${name}: the other format lines stay`);
        assert.ok(text.includes('[!warning]'), `${language} ${name}`);
        assert.ok(segments.some(s => s.source.kind === 'block' && s.source.part === 'format'), `${language} ${name}`);
      }
    }
  }
});

test('counter 2: a template without a format rules zone carries no format segment, no callout, mermaid, task list or highlight syntax; the fixed parts stay', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const sectionsOnly = m.builtinTemplateText('standard', language).split(`\n\n# ${M.translate(language, 'ui.block_template_format_heading')}`)[0];
    for (const [name, context] of stepContexts(language).filter(([step]) => ['research', 'quick', 'synthesize'].includes(step))) {
      const selection = { ...m.selectionFromContext(context, language), template: { id: 'standard', body: sectionsOnly } };
      const { text, segments, charts } = m.assembleTaskPrompt(selection, m.promptStepOf(context), context, language);
      for (const banned of ['[!', '```mermaid', '- [ ]', '==highlight==']) assert.equal(text.includes(banned), false, `${language} ${name}: ${banned}`);
      assert.equal(segments.some(s => s.source.kind === 'block' && s.source.part === 'format'), false, `${language} ${name}`);
      assert.ok(segments.some(s => s.source.kind === 'block' && s.source.part === 'sections'), `${language} ${name}`);
      assert.equal(charts, false);
      for (const id of ['role', 'source-safety', 'json-contract', 'step']) assert.ok(segments.some(s => s.source.kind === 'fixed' && s.source.id === id), `${language} ${name}: ${id}`);
    }
  }
});

test('counter 3: the academic rigor tone equals no tone and adds no tone rule sentence', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const [name, context] of stepContexts(language)) {
      const none = m.assembleTaskPrompt(m.selectionFromContext(context, language), m.promptStepOf(context), context, language);
      assert.equal(m.selectionFromContext(context, language).tone.id, 'academic');
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
          const parts = segments.filter(s => s.source.kind === 'block' && s.source.category === 'template').map(s => s.source.part);
          if (context.mode === 'decompose') assert.equal(categories.includes('template'), false);
          else assert.ok(parts.includes('sections') || context.detailFormat === 'adaptive');
          // The sections text is cut into the block's own words (block segments) and the plugin's wrapper sentences (fixed segments).
          if (context.mode === 'merge') assert.deepEqual([...new Set(parts)], ['sections']);
          // F2: every block segment is a substring of the block's own text; the wrapper sentences are not in a block segment.
          const template = m.builtinTemplateText(context.detailTemplate?.id ?? 'standard', language);
          for (const segment of segments) {
            if (segment.source.kind !== 'block') continue;
            if (segment.source.category === 'template') assert.ok(template.includes(segment.text), `${language} ${name} ${segment.source.part}: ${segment.text.slice(0, 40)}`);
            else assert.equal(segment.text, segment.source.id === 'custom-legacy' ? context.toneText : M.lookupBuiltinBlock('tone', segment.source.id, language));
          }
          if (!context.detailFormat && context.mode !== 'decompose') assert.ok(segments.some(s => s.source.kind === 'fixed' && s.source.id === 'detail-structure'));
          if (context.mode === 'synthesize' || context.mode === 'task') assert.ok(parts.includes('format'));
          if (context.intermediateDetail) assert.equal(parts.includes('format'), false);
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
  assert.throws(() => m.assembleTaskPrompt({ ...selection, template: { id: 'nope' } }, 'research', context, 'en'), /Unknown built-in block/);
  const broken = '## A\nbody\n# Format rules\nr\n# Format rules\nr2\n';
  assert.throws(() => m.assembleTaskPrompt({ ...selection, template: { id: 'standard', body: broken } }, 'research', context, 'en'), /line 5/i);
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
    assert.equal(m.selectionFromContext(base, language).tone.id, 'academic');
    assert.equal(m.selectionFromContext(base, language).tone.body, undefined);
    assert.equal('format' in m.selectionFromContext(base, language), false);
    assert.equal(m.selectionFromContext(base, language).template.legacyPreferences, undefined);
    const noteStyle = { callouts: 'placed', diagrams: false, tables: true, tasks: true, highlight: true };
    assert.deepEqual(m.selectionFromContext({ ...base, noteStyle }, language).template.legacyPreferences, noteStyle);
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
    }
  }
  for (const language of ['zh-TW', 'en']) {
    const standard = S.parseNoteStyleFile(M.lookupBuiltinBlock('template', 'standard', language), { id: 's', name: 's' });
    const names = standard.style.sections.map(section => section.name);
    assert.deepEqual(names, S.standardTemplate(language).sections.map(section => section.name), language);
  }
});

// Q1: the two-zone template text (sections, then the format rules after a level-one heading line).
let templateModule;
const T = () => templateModule ??= loadSource(`
export { parseTemplateBlock, splitTemplateZones, templateFormatHeading } from "./core/blocks/template-block";
export { builtinTemplateText } from "./core/blocks/builtin";
export { detailStructurePrompt, standardTemplate, textbookTemplate } from "./ai/detail-templates";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { noteLanguageOf } from "./i18n";
`);

test('counter 10: a built-in template text parses into the sections of today and the format rules of today', () => {
  const t = T();
  for (const id of ['standard', 'textbook']) {
    for (const language of LANGUAGES) {
      const text = t.builtinTemplateText(id, language);
      const parsed = t.parseTemplateBlock(text, { id, name: id });
      assert.equal(parsed.ok, true, `${id} ${language} ${JSON.stringify(parsed.issues)}`);
      assert.equal(parsed.format, t.inLanguage(t.OBSIDIAN_FORMAT, language), `${id} ${language} format`);
      const today = (id === 'textbook' ? t.textbookTemplate : t.standardTemplate)(t.noteLanguageOf(language));
      // Decision 22: the section files carry today's wording, so every section field the prompt uses is equal.
      const shape = template => JSON.stringify(template.sections.map(section => [section.name, section.description, section.role, section.count ?? null]));
      assert.equal(shape(parsed.template), shape(today), `${id} ${language} sections`);
      assert.equal(parsed.template.layout === 'intro', false);
    }
  }
});

test('decision 22: the parsed built-in text gives the same prompt as today, in every step and language, taken through the parser', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const provider of ['codex', 'claude']) {
      for (const [name, context] of stepContexts(language)) {
        const step = m.promptStepOf(context);
        for (const id of ['standard', 'textbook']) {
          const selection = { ...m.selectionFromContext(context, language), template: { id } };
          const plain = m.assembleTaskPrompt(selection, step, context, language, provider);
          const full = m.builtinTemplateText(id, language);
          const withBody = m.assembleTaskPrompt({ ...selection, template: { id, body: full } }, step, context, language, provider);
          assert.equal(withBody.text, plain.text, `${language} ${provider} ${name} ${id} (body = built-in text)`);
          // A comment line makes the text differ from the built-in, so the assembler must parse it; the parser drops the comment.
          const parsedPath = m.assembleTaskPrompt({ ...selection, template: { id, body: `%% note %%\n${full}` } }, step, context, language, provider);
          if (id === 'standard') {
            assert.equal(parsedPath.text, plain.text, `${language} ${provider} ${name} ${id} (parsed path)`);
            assert.equal(JSON.stringify(parsedPath.segments), JSON.stringify(plain.segments));
          } else {
            // Decision 26: a modified textbook body has a lead, so the plugin's fixed heading list, count and update log
            // rule follow it. Taking those two fixed pieces out of the parsed path gives today's text, byte for byte;
            // the block segments are the same ones.
            const template = m.textbookTemplate(m.noteLanguageOf(language));
            const log = template.sections.find(section => section.role === 'log');
            const added = [
              '\n' + m.customDetailStructure(language, { count: String(template.sections.length), headings: template.sections.map(x => `### ${x.name}`).join(', '), rules: '' }),
              '\n' + m.customDetailRule('log', language, { heading: `### ${log.name}` })
            ];
            const hasSections = parsedPath.text.includes(added[0]);
            if (step === 'decompose') assert.equal(parsedPath.text, plain.text);
            else {
              assert.ok(hasSections, `${language} ${provider} ${name} ${id} the fixed structure text is added`);
              const stripped = added.reduce((text, piece) => text.replace(piece, ''), parsedPath.text);
              assert.equal(stripped, plain.text, `${language} ${provider} ${name} ${id} (parsed path, fixed segment excluded)`);
              const blocks = result => JSON.stringify(result.segments.filter(segment => segment.source.kind === 'block'));
              assert.equal(blocks(parsedPath), blocks(plain));
            }
          }
        }
      }
    }
  }
});

test('counter 10: every spelling of the format heading splits the zones, in any language', () => {
  const t = T();
  const names = LANGUAGES.map(language => t.templateFormatHeading(language));
  assert.equal(new Set(names).size, 3);
  for (const name of names) {
    const zones = t.splitTemplateZones(`## A\nbody\n\n# ${name}\n\n\nrule 1\nrule 2\n\n`);
    assert.equal(zones.sections, '## A\nbody\n');
    assert.equal(zones.format, 'rule 1\nrule 2');
  }
  const none = t.parseTemplateBlock('## A\nbody\n', { id: 'x', name: 'x' });
  assert.equal(none.ok, true);
  assert.equal(none.format, '');
});

test('counter 11: a second format heading reports its line; a heading inside fenced code is not one', () => {
  const t = T();
  const name = t.templateFormatHeading('en');
  const twice = t.parseTemplateBlock(`## A\nbody\n# ${name}\nr\n# ${name}\nr2\n`, { id: 'x', name: 'x' });
  assert.equal(twice.ok, false);
  assert.equal(twice.issues[0].line, 5);
  const fenced = t.parseTemplateBlock(`## A\nbody\n# ${name}\n\`\`\`\n# ${name}\n\`\`\`\n`, { id: 'x', name: 'x' });
  assert.equal(fenced.ok, true);
  assert.equal(fenced.format, `\`\`\`\n# ${name}\n\`\`\``);
});

test('Q1: the sections zone keeps original line numbers in parse issues', () => {
  const t = T();
  const parsed = t.parseTemplateBlock('## A\n數量: x\nbody\n', { id: 'x', name: 'x' });
  if (!parsed.ok) assert.ok(parsed.issues.every(issue => issue.line >= 1));
});

test('charts: the prompt asks for charts exactly when the template text holds a mermaid code block', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const context = { ...base, outputLanguage: language };
    const selection = m.selectionFromContext(context, language);
    assert.equal(m.assembleTaskPrompt(selection, 'research', context, language).charts, true, language);
    const without = m.builtinTemplateText('standard', language).split(`\n\n# ${M.translate(language, 'ui.block_template_format_heading')}`)[0];
    assert.equal(m.assembleTaskPrompt({ ...selection, template: { id: 'standard', body: without } }, 'research', context, language).charts, false, language);
    assert.equal(m.chartsWanted({ ...selection, template: { id: 'standard', body: without } }, context, language), false);
    assert.equal(m.chartsWanted(selection, context, language), true);
    const off = { ...selection, template: { ...selection.template, legacyPreferences: { callouts: 'auto', diagrams: false, tables: true, tasks: true, highlight: true } } };
    assert.equal(m.chartsWanted(off, context, language), false, `${language}: diagrams off removes the mermaid line`);
  }
});

test('counter 4 (F2): the wrapper sentences of every built-in template are fixed segments, the lead and descriptions are block segments', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const id of ['standard', 'textbook']) {
      const context = { ...base, outputLanguage: language };
      const full = m.builtinTemplateText(id, language);
      for (const template of [{ id }, { id, body: `%% note %%\n${full}` }]) {
        const { segments, text } = m.assembleTaskPrompt({ ...m.selectionFromContext(context, language), template }, 'research', context, language, 'codex');
        const blocks = segments.filter(s => s.source.kind === 'block' && s.source.category === 'template' && s.source.part === 'sections');
        assert.ok(blocks.length >= 6, `${language} ${id}`);
        for (const segment of blocks) assert.ok(full.includes(segment.text), `${language} ${id} ${segment.text.slice(0, 30)}`);
        assert.equal(segments.map(s => s.text).join(''), text);
        // Cutting the sections text adds no blank line: only one separator segment lies between the sections and the format rules.
        const inner = segments.slice(segments.indexOf(blocks[0]), segments.lastIndexOf(blocks[blocks.length - 1]));
        assert.equal(inner.some(s => s.source.kind === 'separator'), false, `${language} ${id} no separator inside the sections text`);
        if (id === 'textbook') assert.ok(blocks[0].text.includes('[!warning]'), `${language} the warning rule is block text`);
      }
    }
  }
});

test('counter 12 (F1): a textbook template without its format zone and lead carries no callout syntax and no self-check in any step', () => {
  const m = A();
  const selfCheck = /自我檢核|自我检核|self-check/i;
  for (const language of LANGUAGES) {
    const full = m.builtinTemplateText('textbook', language);
    const withLead = full.split('\n\n# ')[0];
    // The text before the first section is the lead; the sections start at the first level-two heading.
    const sectionsOnly = withLead.slice(withLead.search(/^## /m));
    for (const [name, context] of stepContexts(language)) {
      const step = m.promptStepOf(context);
      const selection = { ...m.selectionFromContext(context, language), template: { id: 'textbook', body: sectionsOnly } };
      const { text, segments } = m.assembleTaskPrompt(selection, step, context, language, 'codex');
      assert.equal(text.includes('[!'), false, `${language} ${name} no [!`);
      assert.equal(selfCheck.test(text), false, `${language} ${name} no self-check`);
      assert.equal(segments.some(s => s.source.kind === 'block' && s.source.part === 'format'), false);
      // Without the lead the textbook id adds nothing of its own: the generic wrapper stands in.
      assert.equal(text.includes(withLead.split('\n\n')[0]), false);
    }
    // With the lead, the unchanged built-in text still shows the guide, the warning and the self-check.
    const research = m.assembleTaskPrompt({ ...m.selectionFromContext(stepContexts(language)[0][1], language), template: { id: 'textbook' } }, 'research', stepContexts(language)[0][1], language, 'codex');
    assert.ok(research.text.includes('[!warning]') && selfCheck.test(research.text));
    // Editing one word of the lead changes that word only.
    const edited = full.replace(/\[!warning\]/, '[!tip]');
    const changed = m.assembleTaskPrompt({ ...m.selectionFromContext(stepContexts(language)[0][1], language), template: { id: 'textbook', body: edited } }, 'research', stepContexts(language)[0][1], language, 'codex');
    // Decision 26: both go through the parser, so the plugin's fixed heading list is in both; the edit changes that word only.
    const parsedSame = m.assembleTaskPrompt({ ...m.selectionFromContext(stepContexts(language)[0][1], language), template: { id: 'textbook', body: `%% note %%\n${full}` } }, 'research', stepContexts(language)[0][1], language, 'codex');
    assert.equal(changed.text, parsedSame.text.replace('[!warning]', '[!tip]'));
  }
});

test('counter 13 (N1, decision 26): a custom template with a lead and no descriptions still carries the heading list, count and log rule', () => {
  const m = A();
  const cases = [
    ['en', 'Write warmly for kids.\n\n## Story\n\n## Facts\n\n## Log', 'Write warmly for kids.'],
    ['zh-TW', '用溫暖的語氣寫給小朋友。\n\n## 故事\n\n## 事實\n\n## 紀錄', '用溫暖的語氣寫給小朋友。'],
    // The update log rule belongs to the section the parser knows as the update log (as before the block files).
    ['en', 'Write warmly for kids.\n\n## Story\n\n## Facts\n\n## Update log', 'Write warmly for kids.', /### Update log gets only one new line/],
    ['zh-TW', '用溫暖的語氣寫給小朋友。\n\n## 故事\n\n## 事實\n\n## 更新紀錄', '用溫暖的語氣寫給小朋友。', /### 更新紀錄 只新增一行/]
  ];
  for (const [language, body, lead, logRule] of cases) {
    const names = body.match(/^## (.+)$/gm).map(line => line.slice(3));
    for (const [name, context] of stepContexts(language)) {
      const step = m.promptStepOf(context);
      if (step === 'decompose') continue; // a decompose prompt carries no template
      const selection = { ...m.selectionFromContext(context, language), template: { id: 'kids-note', body } };
      const { text, segments } = m.assembleTaskPrompt(selection, step, context, language, 'codex');
      for (const heading of names) assert.ok(text.includes(`### ${heading}`), `${language} ${name} lists ### ${heading}`);
      assert.ok(text.includes(`${names.length}`) && text.includes(names.map(n => `### ${n}`).join(', ')), `${language} ${name} count and ordered list`);
      if (logRule) assert.match(text, logRule, `${language} ${name} log rule`);
      const leadSegment = segments.find(s => s.source.kind === 'block' && s.source.part === 'sections');
      assert.equal(leadSegment.text, lead);
      assert.equal(segments.map(s => s.text).join(''), text);
    }
  }
});
