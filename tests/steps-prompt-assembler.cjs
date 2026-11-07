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
const FROZEN_FORMATS = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'note-style-frozen', 'legacy-formats.json'), 'utf8'));
// legacyObsidianFormat(language, { diagrams: false, ... }) as the deleted upgrade module produced it, frozen in
// tests/fixtures/note-style-frozen/legacy-formats.json. A missing key throws.
function frozenLegacyFormat(language, preferences) {
  const key = `${language}:${JSON.stringify(Object.fromEntries(Object.entries(preferences).sort()))}`;
  const text = FROZEN_FORMATS.legacyFormats[key];
  if (typeof text !== 'string') throw new Error(`no frozen legacy format for ${key}`);
  return text;
}

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
  assert.equal(templates.join(), 'standard,textbook,hypothesis,evidence,action,atomic,conclusion,guide');
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
export { generalTaskPrompt, assembledTaskPrompt } from "./core/steps/task/render";
export { JSON_CONTRACT, GENERAL_TASK } from "./core/steps/task/fragments";
export { ROLE, SOURCE_SAFETY, withProviderOutput, inLanguage, toneBlock, OBSIDIAN_FORMAT } from "./core/steps/_shared/fragments";
export { builtinTemplateText } from "./core/blocks/builtin";
export { chartsWanted } from "./core/steps/task/assemble";
export { parseTemplateBlock, splitTemplateZones, trimFormatBody } from "./core/blocks/template-block";
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

test('counter 1: format rules without the summary line produce prompts without [!summary] and keep the other lines', () => {
  const m = A();
  for (const language of LANGUAGES) {
    // Q1: the format rules are a part of their own; the edited rules go in as the selection's format, not inside the template.
    const full = m.inLanguage(m.OBSIDIAN_FORMAT, language);
    const edited = dropSummaryLine(full);
    assert.notEqual(edited, full);
    const format = m.trimFormatBody(edited);
    for (const [name, context] of stepContexts(language)) {
      const selection = { ...m.selectionFromContext(context, language), format: { id: 'file:F', body: edited } };
      const { text, segments } = m.assembleTaskPrompt(selection, m.promptStepOf(context), context, language, 'codex');
      assert.equal(text.includes('[!summary]'), false, `${language} ${name}`);
      if (name !== 'decompose' && name !== 'merge') {
        assert.ok(text.includes(format), `${language} ${name}: the other format lines stay`);
        assert.ok(text.includes('[!warning]'), `${language} ${name}`);
        assert.ok(segments.some(s => s.source.kind === 'block' && s.source.part === 'format'), `${language} ${name}`);
      }
    }
  }
});

test('counter 2: an empty format rules part carries no format segment, no callout, mermaid, task list or highlight syntax; the fixed parts stay', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const sectionsOnly = m.builtinTemplateText('standard', language);
    for (const [name, context] of stepContexts(language).filter(([step]) => ['research', 'quick', 'synthesize'].includes(step))) {
      const selection = { ...m.selectionFromContext(context, language), template: { id: 'standard', body: sectionsOnly }, format: { id: 'file:E', body: '\n \n' } };
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
            if (segment.source.category === 'template') assert.ok((segment.source.part === 'format' ? m.inLanguage(m.OBSIDIAN_FORMAT, language) : template).includes(segment.text), `${language} ${name} ${segment.source.part}: ${segment.text.slice(0, 40)}`);
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
      assert.ok(fixed('step').text.includes(language === 'en' ? '160' : '80'));
      assert.ok(fixed('reference-citations'));
      const withoutSources = m.assembleTaskPrompt(m.selectionFromContext({ ...context, sourceContext: undefined }, language), 'research', { ...context, sourceContext: undefined }, language, provider);
      assert.equal(withoutSources.segments.some(s => s.source.id === 'reference-citations'), false);
    }
  }
});

// A count line that is not a number: the sections parser reports it (line 2). A second format rules heading is no problem any more (Q1).
const BROKEN = '## A\nCount: x\nbody\n';

test('counter 6: an unknown block id throws instead of leaving the prompt without that block', () => {
  const m = A();
  const context = { ...base, outputLanguage: 'en' };
  const selection = m.selectionFromContext(context, 'en');
  assert.throws(() => m.assembleTaskPrompt({ ...selection, template: { id: 'nope' } }, 'research', context, 'en'), /Unknown built-in block/);
  // A template body that cannot be read no longer throws: the built-in stands in and the problem is reported (ticket 05, see the counters below).
  assert.doesNotThrow(() => m.assembleTaskPrompt({ ...selection, template: { id: 'standard', body: BROKEN } }, 'research', context, 'en'));
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
    // P2: the old note style switches no longer ride on the selection (they are written into the block by the upgrade).
    assert.equal('legacyPreferences' in m.selectionFromContext(base, language).template, false);
    const noteStyle = { callouts: 'placed', diagrams: false, tables: true, tasks: true, highlight: true };
    assert.deepEqual(m.selectionFromContext({ ...base, noteStyle }, language), m.selectionFromContext(base, language));
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

test('P3: every template block parses as a note style file and has the section headings of the built-in template (was: the canonical v2 files; grilling Q12)', () => {
  const S = loadSource(`
export { parseNoteStyleFile } from "./ai/note-style-file";
export { standardTemplate, textbookTemplate } from "./ai/detail-templates";
export { noteLanguageOf } from "./i18n";
`);
  for (const id of ['standard', 'textbook']) {
    for (const language of LANGUAGES) {
      const body = M.lookupBuiltinBlock('template', id, language);
      const parsed = S.parseNoteStyleFile(body, { id, name: id });
      assert.equal(parsed.ok, true, `${id} ${language} ${JSON.stringify(parsed.issues)}`);
      assert.equal(/tone:|語氣|语气|%%/.test(body), false, `${id} ${language} keeps no switch or comment`);
      const reference = id === 'standard' ? S.standardTemplate(S.noteLanguageOf(language)) : S.textbookTemplate(S.noteLanguageOf(language));
      const names = style => style.sections.map(section => section.name);
      assert.deepEqual(names(parsed.style), names(reference), `${id} ${language}`);
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

test('counter 10: a built-in template text parses into the sections of today and holds no format rules (Q1)', () => {
  const t = T();
  for (const id of ['standard', 'textbook']) {
    for (const language of LANGUAGES) {
      const text = t.builtinTemplateText(id, language);
      const parsed = t.parseTemplateBlock(text, { id, name: id });
      assert.equal(parsed.ok, true, `${id} ${language} ${JSON.stringify(parsed.issues)}`);
      assert.equal('format' in parsed, false, `${id} ${language} format`);
      assert.equal(parsed.notices.length, 0, `${id} ${language} notices`);
      assert.equal(text.includes(t.inLanguage(t.OBSIDIAN_FORMAT, language).trim()), false, `${id} ${language} no format rules in the text`);
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
              assert.ok(parsedPath.text.includes(added[1]), `${language} ${provider} ${name} ${id} the fixed update log rule is added`);
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
  assert.equal('format' in none, false);
  assert.equal(none.notices.length, 0);
});

test('counter 11: a format rules heading is noted, not read (Q1); a second one is no problem; a heading inside fenced code is not one', () => {
  const t = T();
  const name = t.templateFormatHeading('en');
  const twice = t.parseTemplateBlock(`## A\nbody\n# ${name}\nr\n# ${name}\nr2\n`, { id: 'x', name: 'x' });
  assert.equal(twice.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(twice.notices)), [{ line: 3, code: 'format_zone_moved' }]);
  const fenced = t.parseTemplateBlock(`## A\nbody\n# ${name}\n\`\`\`\n# ${name}\n\`\`\`\n`, { id: 'x', name: 'x' });
  assert.equal(fenced.ok, true);
  assert.equal(fenced.notices.length, 1);
  const inFence = t.parseTemplateBlock(`## A\n\`\`\`\n# ${name}\n\`\`\`\n`, { id: 'x', name: 'x' });
  assert.equal(inFence.ok, true);
  assert.equal(inFence.notices.length, 0);
});

test('Q1: the sections zone keeps original line numbers in parse issues', () => {
  const t = T();
  const parsed = t.parseTemplateBlock('## A\n數量: x\nbody\n', { id: 'x', name: 'x' });
  if (!parsed.ok) assert.ok(parsed.issues.every(issue => issue.line >= 1));
});

test('charts: the prompt asks for charts exactly when the sections or the format rules hold a mermaid code block', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const context = { ...base, outputLanguage: language };
    const selection = m.selectionFromContext(context, language);
    assert.equal(m.assembleTaskPrompt(selection, 'research', context, language).charts, true, language);
    // Q1: the built-in sections hold no mermaid block, the format rules do; take the mermaid line out of the format.
    const format = m.inLanguage(m.OBSIDIAN_FORMAT, language);
    const sections = m.builtinTemplateText('standard', language);
    assert.ok(!sections.includes('```mermaid') && format.includes('```mermaid'));
    const without = { ...selection, template: { id: 'standard', body: sections }, format: { id: 'file:F', body: format.split('\n').filter(line => !line.includes('```mermaid')).join('\n') } };
    assert.equal(m.assembleTaskPrompt(without, 'research', context, language).charts, false, language);
    assert.equal(m.chartsWanted(without, context, language), false);
    assert.equal(m.chartsWanted(selection, context, language), true);
    // What the old diagrams switch did, as the upgrade writes it: a format whose text lacks the mermaid line.
    const offFormat = frozenLegacyFormat(language, { callouts: 'auto', diagrams: false, tables: true, tasks: true, highlight: true });
    assert.ok(!offFormat.includes('```mermaid'));
    const off = { ...selection, template: { id: 'standard', body: sections }, format: { id: 'file:F', body: offFormat } };
    assert.equal(m.chartsWanted(off, context, language), false, `${language}: a format without the mermaid line asks for no chart`);
    assert.equal(m.assembleTaskPrompt(off, 'research', context, language).charts, false);
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
    const withLead = full;
    // The text before the first section is the lead; the sections start at the first level-two heading.
    const sectionsOnly = withLead.slice(withLead.search(/^## /m));
    for (const [name, context] of stepContexts(language)) {
      const step = m.promptStepOf(context);
      const selection = { ...m.selectionFromContext(context, language), template: { id: 'textbook', body: sectionsOnly }, format: { id: 'file:E', body: '' } };
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

test('06 P2 (decision 18): the request\'s own old template in the intro layout keeps the intro structure text next to a block body; a block with a lead and no such template keeps the lead layout', () => {
  const m = A();
  const old = { id: 'style:S', name: 'S', layout: 'intro', intro: 'Open with a short guide.', sections: [{ id: 's1', name: 'Story', description: '', role: 'none', aliases: [] }] };
  const body = 'Open with a short guide.\n\n## Story\n';
  for (const language of ['en', 'zh-TW']) {
    const context = { ...base, outputLanguage: language };
    const selection = { ...m.selectionFromContext(context, language), template: { id: 'style:S', body } };
    const lead = m.assembleTaskPrompt(selection, 'research', context, language).text;
    const intro = m.assembleTaskPrompt(selection, 'research', { ...context, detailTemplate: old }, language).text;
    const sentence = m.detailStructurePrompt(old, language, () => '');
    assert.ok(intro.includes(sentence) && sentence.includes('Open with a short guide.'), `${language}: the intro structure text`);
    assert.ok(!lead.includes(sentence), `${language}: a lead block has the lead layout`);
    assert.notEqual(intro, lead);
  }
});

// Ticket 05: a template block that cannot be read falls back to the built-in one and is reported with its line.
const STEPS = ['research', 'quick', 'decompose', 'synthesize', 'merge'];

test('05 counter 1: a broken body of a built-in id gives the built-in text byte for byte, with the line reported (5 steps x 3 languages)', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const [name, raw] of stepContexts(language)) {
      const context = { ...raw, outputLanguage: language };
      const selection = m.selectionFromContext(context, language);
      const step = m.promptStepOf(context);
      const want = m.assembleTaskPrompt(selection, step, context, language);
      for (const id of ['standard', 'textbook']) {
        const got = m.assembleTaskPrompt({ ...selection, template: { ...selection.template, id, body: BROKEN, fileName: 'My.md' } }, step, context, language);
        const builtin = m.assembleTaskPrompt({ ...selection, template: { ...selection.template, id } }, step, context, language);
        assert.equal(got.text, builtin.text, `${language} ${name} ${id}`);
        assert.equal(got.charts, builtin.charts);
        if (name === 'decompose') assert.equal(got.issues.length, 0, 'the decompose step carries no template');
        else {
          assert.equal(got.issues[0].line, 2, `${language} ${name} ${id}`);
          assert.equal(got.issues[0].category, 'template');
          assert.equal(got.issues[0].id, id);
          assert.equal(got.issues[0].fileName, 'My.md');
          assert.equal(got.issues[0].code, 'count_invalid');
        }
      }
      assert.equal(want.issues.length, 0);
    }
  }
});

test('05 counter 2: a broken body of a non-built-in id falls back to standard and keeps adaptive (the old switches no longer exist: a noteStyle in the context changes nothing)', () => {
  const m = A();
  const noteStyle = { callouts: 'placed', diagrams: false, tables: true, tasks: true, highlight: true };
  for (const language of LANGUAGES) {
    const context = { ...base, outputLanguage: language, noteStyle };
    const selection = m.selectionFromContext(context, language);
    const custom = { ...selection, template: { ...selection.template, id: 'uuid-x', body: BROKEN } };
    const std = m.assembleTaskPrompt({ ...selection, template: { ...selection.template, id: 'standard' } }, 'research', context, language);
    const got = m.assembleTaskPrompt(custom, 'research', context, language);
    assert.equal(got.text, std.text);
    assert.equal(got.issues[0].id, 'uuid-x');
    assert.equal(got.issues[0].fileName, undefined);
    // the old switches are gone: the same text with and without a noteStyle in the context
    const without = m.assembleTaskPrompt({ ...custom, template: { id: 'uuid-x', body: BROKEN } }, 'research', { ...base, outputLanguage: language }, language);
    assert.equal(without.text, got.text);
    // adaptive: no sections text, the adaptive structure text instead
    const adaptive = m.assembleTaskPrompt({ ...custom, template: { ...custom.template, adaptive: true } }, 'research', context, language);
    const adaptiveStd = m.assembleTaskPrompt({ ...selection, template: { id: 'standard', adaptive: true } }, 'research', context, language);
    assert.equal(adaptive.text, adaptiveStd.text);
    assert.equal(adaptive.issues.length, 1);
    // an old custom template object of the same id is not used either
    const old = { id: 'uuid-x', name: 'Old', sections: [{ id: 's', name: 'Only', description: '', role: 'none', aliases: [] }] };
    const withOld = m.assembleTaskPrompt(custom, 'research', { ...context, detailTemplate: old }, language);
    assert.equal(withOld.text, std.text);
  }
});

test('05 counter 3: chartsWanted does not throw on a broken body and equals the fallback answer', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const context = { ...base, outputLanguage: language };
    const selection = m.selectionFromContext(context, language);
    for (const id of ['standard', 'textbook', 'uuid-y']) {
      const broken = { ...selection, template: { ...selection.template, id, body: BROKEN } };
      const fallback = { ...selection, template: { ...selection.template, id: id === 'uuid-y' ? 'standard' : id } };
      assert.equal(m.chartsWanted(broken, context, language), m.chartsWanted(fallback, context, language));
    }
  }
});

test('05 counter 4: an id without a body that is not a built-in still throws', () => {
  const m = A();
  const context = { ...base, outputLanguage: 'en' };
  const selection = m.selectionFromContext(context, 'en');
  for (const step of STEPS) assert.throws(() => m.assembleTaskPrompt({ ...selection, template: { id: 'nope' } }, step === 'decompose' ? 'research' : step, context, 'en'), /Unknown built-in block/);
  assert.throws(() => m.chartsWanted({ ...selection, template: { id: 'nope' } }, context, 'en'), /Unknown built-in block/);
});

test('05 counter 5: a valid edited body reports no issue (no false alarm)', () => {
  const m = A();
  for (const language of LANGUAGES) {
    const edited = m.builtinTemplateText('standard', language).split('\n').filter(line => !line.includes('[!summary]')).join('\n');
    for (const [name, context] of stepContexts(language)) {
      const selection = m.selectionFromContext(context, language);
      const got = m.assembleTaskPrompt({ ...selection, template: { ...selection.template, body: edited } }, m.promptStepOf(context), context, language);
      assert.equal(got.issues.length, 0, `${language} ${name}`);
      assert.equal(m.assembleTaskPrompt(selection, m.promptStepOf(context), context, language).issues.length, 0);
    }
  }
});

test('05: assembledTaskPrompt carries the segments and issues, and generalTaskPrompt returns its text', () => {
  const m = A();
  for (const language of LANGUAGES) {
    for (const [name, context] of stepContexts(language)) {
      const assembled = m.assembledTaskPrompt(context, language, 'claude');
      assert.equal(assembled.text, m.generalTaskPrompt(context, language, 'claude'), `${language} ${name}`);
      assert.equal(assembled.segments.map(s => s.text).join(''), assembled.text);
      assert.equal(assembled.issues.length, 0);
    }
  }
});

// AI suggested style (P2): the decide and follow fragments. Unit level.
let aiModule;
const AI = () => aiModule ??= loadSource(`
export { assembleTaskPrompt, promptStepOf, selectionFromContext, chartsWanted } from "./core/steps/task/assemble";
export { AI_DECIDED_SECTIONS, AI_FOLLOWED_SECTIONS } from "./core/steps/task/fragments";
export { inLanguage } from "./core/steps/_shared/fragments";
export { BUILTIN_BLOCKS, builtinTemplateText } from "./core/blocks/builtin";
export { parseTemplateBlock } from "./core/blocks/template-block";
export { standardTemplate } from "./ai/detail-templates";
`);
const aiPrompt = (context, language) => { const m = AI(); return m.assembleTaskPrompt(m.selectionFromContext(context, language), m.promptStepOf(context), context, language, 'codex'); };
const idsOf = segments => segments.filter(s => s.source.kind === 'fixed').map(s => s.source.id);
const HEADING_NOTE = { 'zh-TW': '標準', 'zh-CN': '标准', en: 'six standard Detail headings' };

test('AI suggested decide: the rule stands in for the sections; no detail-structure, no heading-rule-note, no tone or format words', () => {
  const m = AI();
  for (const language of LANGUAGES) {
    const context = { ...base, detail: '', aiSections: 'decide', outputLanguage: language };
    const plain = aiPrompt({ ...context, aiSections: undefined }, language);
    const { text, segments } = aiPrompt(context, language);
    assert.ok(idsOf(segments).includes('ai-decided-sections'), language);
    assert.equal(idsOf(segments).includes('detail-structure'), false, language);
    assert.equal(segments.some(s => s.source.kind === 'block' && s.source.part === 'sections'), false, language);
    assert.ok(text.includes(m.inLanguage(m.AI_DECIDED_SECTIONS, language)), language);
    // The positive control: the same context without the flag does carry the heading rule.
    assert.ok(idsOf(plain.segments).includes('detail-structure') && plain.text.includes(m.inLanguage(m.AI_DECIDED_SECTIONS, language)) === false, language);
    const fragment = m.inLanguage(m.AI_DECIDED_SECTIONS, language);
    assert.equal(/口吻|語氣|格式|tone|format|voice/i.test(fragment), false, `${language}: the fragment leaves tone and format to the settings`);
    // The format rules zone stays (the format follows the settings).
    assert.ok(segments.some(s => s.source.kind === 'block' && s.source.part === 'format'), language);
  }
  // The heading rule note (and every other wrapper sentence of the sections text) lives in the detail-structure segments.
  for (const language of LANGUAGES) {
    const plain = aiPrompt({ ...base, detail: '', outputLanguage: language }, language);
    const decided = aiPrompt({ ...base, detail: '', aiSections: 'decide', outputLanguage: language }, language);
    for (const segment of plain.segments.filter(s => s.source.kind === 'fixed' && s.source.id === 'detail-structure')) assert.equal(decided.text.includes(segment.text), false, `${language}: ${segment.text.slice(0, 30)}`);
  }
});

test('AI suggested decide: only the general research steps; other steps keep their sections', () => {
  for (const [name, context] of stepContexts('en')) {
    const { segments } = aiPrompt({ ...context, aiSections: 'decide' }, 'en');
    const decides = idsOf(segments).includes('ai-decided-sections');
    assert.equal(decides, name === 'research' || name === 'quick', name);
  }
});

test('AI suggested follow: the followed rule comes after the sections for research and synthesize, not for the other steps', () => {
  for (const language of LANGUAGES) {
    for (const [name, context] of stepContexts(language)) {
      const { segments, text } = aiPrompt({ ...context, aiSections: 'follow' }, language);
      const followed = idsOf(segments).includes('ai-followed-sections');
      assert.equal(followed, name === 'research' || name === 'synthesize' || name === 'quick', `${language} ${name}`);
      assert.equal(idsOf(segments).includes('ai-decided-sections'), false);
      if (followed) {
        const after = text.indexOf(AI().inLanguage(AI().AI_FOLLOWED_SECTIONS, language));
        assert.ok(after > text.indexOf('###'), `${language} ${name}: after the sections list`);
        assert.ok(idsOf(segments).includes('detail-structure'), 'the note\'s own sections stay');
      }
    }
  }
});

// The language rule used to say "the six standard Detail headings ..." in the decide and follow prompts too, against
// "the sections are yours to decide" and "keep the note's sections". The scan covers the whole prompt, not one segment.
const SIX_STANDARD = /六個標準|六个标准|six standard/i;
test('AI suggested decide and follow: no sentence about the six standard headings anywhere in the prompt', () => {
  for (const language of LANGUAGES) {
    for (const flag of ['decide', 'follow']) {
      let opened = 0;
      for (const [name, context] of stepContexts(language)) {
        const { text, segments } = aiPrompt({ ...context, aiSections: flag }, language);
        const open = idsOf(segments).includes(flag === 'decide' ? 'ai-decided-sections' : 'ai-followed-sections');
        const plain = aiPrompt({ ...context, aiSections: undefined }, language).text;
        if (open) {
          opened++;
          assert.equal(SIX_STANDARD.test(text), false, `${language} ${flag} ${name}`);
          assert.ok(text.includes(AI().inLanguage(flag === 'decide' ? AI().AI_DECIDED_SECTIONS : AI().AI_FOLLOWED_SECTIONS, language)), `${language} ${flag} ${name}`);
          // The rest of the language rule stays: the content language and the quote rule.
          assert.ok(idsOf(segments).includes('output-language'), `${language} ${flag} ${name}`);
        } else assert.equal(text, plain, `${language} ${flag} ${name}: steps without the fragment stay byte for byte`);
      }
      assert.ok(opened > 0, `${language} ${flag}`);
    }
    // The positive control: the plain prompt still carries the sentence.
    assert.ok(SIX_STANDARD.test(aiPrompt({ ...base, detail: '', outputLanguage: language }, language).text), `${language} control`);
  }
});

test('AI suggested: general and an absent flag give the same prompt as before (byte for byte)', () => {
  for (const language of LANGUAGES) {
    for (const [, context] of stepContexts(language)) {
      assert.equal(aiPrompt({ ...context, aiSections: 'general' }, language).text, aiPrompt(context, language).text);
    }
  }
});

test('AI suggested decide: charts are asked for by the format text only, not by sections', () => {
  const m = AI();
  const context = { ...base, detail: '', aiSections: 'decide' };
  for (const language of LANGUAGES) {
    const selection = { ...m.selectionFromContext(context, language), format: { id: 'file:F', body: 'No diagrams here.' } };
    const withChart = { ...selection, format: { id: 'file:F', body: 'Use a ```mermaid diagram.' } };
    assert.equal(m.chartsWanted(selection, context, language), false);
    assert.equal(m.chartsWanted(withChart, context, language), true);
  }
});

test('AI suggested decide: the structures listed in the fragment match the built-in structures (anti-drift)', () => {
  const m = AI();
  const structures = ['standard', 'atomic', 'hypothesis', 'evidence', 'conclusion', 'action', 'guide'];
  for (const [language, noteLanguage, separator] of [['zh', 'zh-TW', '／'], ['en', 'en', ' / ']]) {
    const lines = m.AI_DECIDED_SECTIONS[language].split('\n').filter(line => line.startsWith('- ') && line.includes(separator) && !/[0-9]/.test(line));
    const listed = lines.map(line => line.slice(2));
    const real = ['standard', 'atomic', 'hypothesis', 'evidence', 'conclusion', 'action', 'guide'].map(id => {
      const parsed = m.parseTemplateBlock(m.builtinTemplateText(id, noteLanguage), { id, name: id });
      assert.ok(parsed.ok, id);
      return parsed.template.sections.map(section => section.name).join(separator);
    });
    // The fragment lists them in the order: standard, atomic, hypothesis, evidence, conclusion, action, guide.
    const order = ['standard', 'atomic', 'hypothesis', 'evidence', 'conclusion', 'action', 'guide'];
    assert.deepEqual(listed, order.map(id => real[structures.indexOf(id)]), `${language}: structures listed`);
  }
  // Every built-in template block except the Standard look-alike (Textbook) is listed.
  const blocks = m.BUILTIN_BLOCKS.filter(block => block.category === 'template').map(block => block.id).filter(id => id !== 'textbook');
  assert.deepEqual([...blocks].sort(), [...structures].sort());
});
