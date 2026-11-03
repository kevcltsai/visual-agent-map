const assert = require('node:assert/strict');
const { test, load, core, plain, map, tree, Repository, DEFAULT_SETTINGS } = require('../support.cjs');
const presets = load('ai/prompt-presets.ts');
const { toneBlock } = load('core/steps/_shared/fragments.ts');
const { taskPrompt } = load('core/steps/task/render.ts');
const base = { title: 'T', summary: 'S', rules: 'R', detail: 'D', task: 'Do X', ancestors: 'A', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
const custom = [{ id: 'mine', kind: 'tone', name: 'Mine', text: 'Tone: be brief.' }, { id: 'tree2', kind: 'outline', name: 'Tree 2', text: 'Outline {x}' }];

test('built-in presets: six tones plus the knowledge-tree outline, localized, academic is the default', () => {
  for (const language of ['zh-TW', 'zh-CN', 'en']) {
    const tones = presets.builtinPresets(language, 'tone');
    assert.deepEqual(plain(tones.map(item => item.id)), ['plain', 'magazine', 'summary', 'guide', 'academic', 'auto']);
    assert.ok(tones.every(item => item.name && item.text && !item.text.endsWith('\n')));
    const [outline] = presets.builtinPresets(language, 'outline');
    assert.equal(outline.id, 'knowledge-tree');
    assert.ok(outline.text.includes(presets.OUTLINE_TOPIC_PLACEHOLDER[language]));
  }
  assert.deepEqual(plain(presets.builtinPresets('zh-TW', 'tone').map(item => item.name)), ['白話說明', '雜誌專欄', '重點摘要', '實用指南', '學術嚴謹', 'AI 建議']);
  assert.ok(presets.builtinPresets('zh-TW', 'outline')[0].text.startsWith('# VAM Knowledge Tree Generator'));
  assert.equal(presets.DEFAULT_TONE_ID, 'academic');
});

test('normalizePresets drops malformed, duplicate and built-in-id entries; missing setting is empty', () => {
  assert.deepEqual(plain(presets.normalizePresets(undefined)), []);
  assert.deepEqual(plain(presets.normalizePresets('x')), []);
  const result = presets.normalizePresets([custom[0], { ...custom[0], name: 'dup' }, { id: 'academic', kind: 'tone', name: 'x', text: 'y' }, { id: 'bad', kind: 'other', name: 'x', text: 'y' }, { id: 'n', kind: 'tone', name: ' ', text: 'y' }, { id: 't', kind: 'tone', name: 'x' }, null, custom[1]]);
  assert.deepEqual(plain(result), custom);
});

test('list and resolve: built-ins first, then custom; unknown or missing id falls back to the default', () => {
  assert.deepEqual(plain(presets.listPresets(custom, 'tone', 'en').map(item => item.id)), ['plain', 'magazine', 'summary', 'guide', 'academic', 'auto', 'mine']);
  assert.deepEqual(plain(presets.listPresets(custom, 'outline', 'en').map(item => item.id)), ['knowledge-tree', 'tree2']);
  assert.equal(presets.resolvePreset(custom, 'tone', 'mine', 'en').preset.id, 'mine');
  const unknown = presets.resolvePreset(custom, 'tone', 'gone', 'en');
  assert.equal(unknown.preset.id, 'academic'); assert.equal(unknown.missing, true);
  const none = presets.resolvePreset(custom, 'tone', undefined, 'en');
  assert.equal(none.preset.id, 'academic'); assert.equal(none.missing, false);
  assert.equal(presets.resolvePreset(undefined, 'outline', 'gone', 'zh-TW').preset.id, 'knowledge-tree');
});

test('resolveToneText: topic override beats map default; unknown falls through; academic and absent yield nothing', () => {
  const text = id => presets.resolveToneText(custom, id, 'en');
  assert.equal(text(['mine', 'plain']), 'Tone: be brief.');
  assert.equal(text([undefined, 'mine']), 'Tone: be brief.');
  assert.equal(text(['plain', 'mine']), presets.builtinPresets('en', 'tone')[0].text);
  assert.equal(text(['gone', 'mine']), 'Tone: be brief.');
  assert.equal(text(['gone', 'gone2']), undefined);
  assert.equal(text(['academic', 'mine']), undefined, 'explicit academic topic override beats a map default');
  assert.equal(text([undefined, undefined]), undefined);
  assert.equal(text([]), undefined);
  assert.equal(presets.resolveToneText([{ id: 'blank', kind: 'tone', name: 'B', text: '  ' }], ['blank'], 'en'), undefined);
});

test('preset CRUD helpers are pure; built-ins are immutable', () => {
  const start = plain(custom);
  const created = presets.createPreset(custom, { kind: 'tone', name: ' New ', text: 'T' });
  assert.deepEqual(plain(custom), start);
  assert.equal(created.presets.length, 3);
  assert.deepEqual(plain(created.created), { id: 'custom-tone-1', kind: 'tone', name: 'New', text: 'T' });
  assert.equal(presets.createPreset(custom, { kind: 'tone', name: '  ', text: 'T' }).presets.length, 2);
  assert.equal(presets.createPreset(created.presets, { kind: 'tone', name: 'Again', text: '' }).created.id, 'custom-tone-2');
  const copy = presets.duplicatePreset(custom, 'academic', 'en');
  assert.equal(copy.created.kind, 'tone'); assert.equal(copy.created.name, 'Academic rigor copy');
  assert.equal(copy.created.text, presets.builtinPresets('en', 'tone').find(item => item.id === 'academic').text);
  assert.equal(presets.duplicatePreset(custom, 'mine', 'zh-TW').created.name, 'Mine 副本');
  assert.equal(presets.duplicatePreset(custom, 'nope', 'en').created, undefined);
  assert.deepEqual(plain(presets.updatePreset(custom, 'mine', { name: 'Renamed', text: 'New text' })[0]), { id: 'mine', kind: 'tone', name: 'Renamed', text: 'New text' });
  assert.deepEqual(plain(presets.updatePreset(custom, 'academic', { name: 'Hacked' })), start);
  assert.deepEqual(plain(presets.updatePreset(custom, 'mine', { name: ' ' })), start);
  assert.deepEqual(plain(presets.deletePreset(custom, 'mine')), [custom[1]]);
  assert.deepEqual(plain(presets.deletePreset(custom, 'academic')), start);
  assert.deepEqual(plain(custom), start);
  assert.ok(presets.isBuiltinPreset('auto') && !presets.isBuiltinPreset('mine'));
});

test('tone prompt: absent or academic is byte-identical; a tone adds the rule block after the JSON contract (task and AIM)', () => {
  for (const language of ['en', 'zh-TW']) {
    for (const context of [base, { ...base, promptProfile: 'aim', researchMode: 'local' }]) {
      const plainPrompt = taskPrompt(context, language);
      assert.equal(taskPrompt({ ...context, toneText: undefined }, language), plainPrompt);
      assert.equal(taskPrompt({ ...context, toneText: presets.resolveToneText(custom, ['academic'], language) }, language), plainPrompt);
      const toned = taskPrompt({ ...context, toneText: 'TONE-TEXT' }, language);
      assert.ok(toned.includes('TONE-TEXT'));
      assert.ok(toned.includes(language === 'en' ? 'never lowers the source, citation or accuracy requirements' : '絕不降低來源、引用與準確性的要求'));
      assert.equal(toned.replace(`\n\n${toneBlock('TONE-TEXT', language)}`, ''), plainPrompt);
    }
  }
});

test('tone covers research, decompose and synthesize task modes', () => {
  for (const mode of ['task', 'decompose', 'synthesize'])
    assert.ok(taskPrompt({ ...base, mode, toneText: 'TONE-TEXT' }, 'en').includes('TONE-TEXT'), mode);
});

test('MapDocument.toneId round-trips; old Map.md without it loads; a non-string toneId is dropped', () => {
  const doc = map(tree()); doc.toneId = 'mine';
  assert.equal(core.parseMap(core.serializeMap(doc)).toneId, 'mine');
  assert.equal(core.parseMap(core.serializeMap(map(tree()))).toneId, undefined);
  const bad = map(tree()); bad.toneId = 5;
  assert.equal('toneId' in core.parseMap(core.serializeMap(bad)), false);
});

test('promptPresets default is empty and settings without the field normalize to empty', () => {
  assert.deepEqual(plain(DEFAULT_SETTINGS.promptPresets), []);
  assert.deepEqual(plain(presets.normalizePresets(plain({}).promptPresets)), []);
});

// ---- Note style presets (D9): the five-preset menu is gone ------------------------------------------------------------
test('note style (D9, replaces the five-preset and styleLabel tests): the old preset table and its helpers have no module; ai/note-style-label keeps only runStyleLabelText', () => {
  const { existsSync } = require('node:fs'), { join } = require('node:path');
  assert.equal(existsSync(join(__dirname, '..', '..', 'experiences', 'visual-map', 'note-style.ts')), false);
  const label = load('ai/note-style-label.ts');
  assert.deepEqual(Object.keys(label).sort(), ['runStyleLabelText']);
});
test('note style: the settings and dialog strings that remain read in both languages', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.note_style'), '筆記風格'); assert.equal(translate('en', 'ui.note_style'), 'Note style');
  assert.equal(translate('zh-TW', 'ui.note_style_each_topic'), '各議題自己的設定'); /* was ui.note_style_keep_each (key removed, D3) */
});
test('06 P4: the settings tone-presets row is gone (replaces "tone settings row: the description points at the tone line of a note style file")', () => {
  const { obsidian } = require('../support.cjs');
  const mod = load('ui/modals/prompt-presets-modal.ts', { obsidian: { ...obsidian, Modal: class { open() {} } } });
  assert.equal(mod.renderTonePresetsSetting, undefined);
  assert.equal(typeof mod.PromptPresetsModal, 'function');
});
