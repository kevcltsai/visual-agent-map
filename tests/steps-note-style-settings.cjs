// Settings "Note style" area: the intro with Preview AI instructions, the seven topic-type rows (one style picker each, no
// "not set", the AIM row first offers the AIM report), the File location row, the style-file problem texts in every
// language, the plugin methods the old rows used (until they are removed), and the dead template UI is gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const openedModals = [];
class FakeModal { constructor(app) { this.app = app; } open() { openedModals.push(this); } close() {} }
const notices = [];
const obsidian = { ...S.obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: FakeModal, Notice: dom.makeNotice(notices) };
const { renderNoteStyleCard, renderNoteLocationSetting, renderNoteKindSetting, renderMyStylesSetting, kindStyleLine, shownStyleRef, missingStyleRef } = S.load('ui/settings-tab.ts', { obsidian });
const { styleIssueText } = S.load('experiences/visual-map/note-style-picker.ts', { obsidian });
const { default: Plugin } = S.load('main.ts', { obsidian }, { createFragment: dom.createFragment });
const { parseNoteStyleFile } = loadSource('export { parseNoteStyleFile } from "./ai/note-style-file";');
const i18n = S.load('i18n.ts');
const { t } = i18n;
const root = path.resolve(__dirname, '..');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const buttonOf = (log, build) => { const el = dom.element('button'); el.hide = () => { el.hidden = true; }; el.show = () => { el.hidden = false; }; el.focus = () => { log.focused = el; }; return el; };

/** A fake Setting made of real stand-in elements, recording what the row builds. */
function fakeSetting() {
  const view = { name: '', desc: '', heading: false, buttons: [], extras: [], dropdown: undefined, texts: [], descWrites: 0, classes: [], focused: undefined };
  const descEl = dom.element('div');
  const emptyDesc = descEl.empty.bind(descEl);
  descEl.empty = () => { view.descWrites++; emptyDesc(); };
  const settingEl = dom.element('div');
  const nameEl = dom.element('div');
  nameEl.setText = text => { view.name = text; };
  view.descEl = descEl; view.settingEl = settingEl; view.nameEl = nameEl;
  const setting = {
    descEl, settingEl, nameEl,
    setName(name) { view.name = name; return this; }, setDesc(desc) { view.desc = desc; return this; }, setHeading() { view.heading = true; return this; },
    addDropdown(build) {
      const selectEl = dom.element('select'); selectEl.focus = () => { view.focused = selectEl; };
      const entry = { selectEl, disabled: false };
      view.dropdown = entry;
      build({ selectEl, addOption(value, text) { selectEl.createEl('option', { value, text }); }, setValue(value) { selectEl.value = value; return this; }, setDisabled(value) { entry.disabled = value; return this; }, onChange(fn) { entry.change = fn; return this; } });
      return this;
    },
    addButton(build) {
      const entry = { disabled: false, buttonEl: buttonOf(view) };
      entry.buttonEl.focus = () => { view.focused = entry.buttonEl; };
      view.buttons.push(entry);
      build({ setButtonText(text) { entry.text = text; entry.buttonEl.text = text; return this; }, onClick(fn) { entry.click = fn; return this; }, setDisabled(value) { entry.disabled = value; return this; }, buttonEl: entry.buttonEl });
      return this;
    },
    addExtraButton(build) {
      const extraSettingsEl = dom.element('div'); extraSettingsEl.getBoundingClientRect = () => ({ left: 10, bottom: 20 }); extraSettingsEl.focus = () => { view.focused = extraSettingsEl; };
      const entry = { disabled: false, extraSettingsEl };
      view.extras.push(entry);
      build({ extraSettingsEl, setIcon(icon) { entry.icon = icon; return this; }, setTooltip(text) { entry.tooltip = text; return this; }, onClick(fn) { entry.click = fn; return this; }, setDisabled(value) { entry.disabled = value; return this; } });
      return this;
    },
    addText(build) {
      const entry = { disabled: false, value: '', change: undefined, attrs: {} };
      view.texts.push(entry);
      build({ setPlaceholder() { return this; }, setValue(value) { entry.value = value; return this; }, setDisabled(value) { entry.disabled = value; return this; }, onChange(fn) { entry.change = fn; return this; }, getValue: () => entry.value, inputEl: { setAttr: (k, v) => { entry.attrs[k] = v; } } });
      return this;
    }
  };
  return { setting, view };
}

const lines = view => view.descEl.children.map(child => child.text);
const errorLines = view => view.descEl.children.filter(child => child.hasClass('vam-block-status-error')).map(child => child.text);
const optionsOf = view => dom.findAll(view.dropdown.selectEl, node => node.tag === 'option').map(node => [node.optionValue, node.text]);
const groupsOf = view => dom.findAll(view.dropdown.selectEl, node => node.tag === 'optgroup').map(node => ({ label: node.attrs.label, options: node.children.map(child => child.text) }));

function row({ exists = true, folder = 'WS/Styles', settings = {}, items = [], recipes = [], formats = [] } = {}) {
  const { setting, view } = fakeSetting();
  const log = { saved: 0, opened: 0, refreshed: 0, previewed: [] };
  const settingsObject = { language: 'en', ...settings };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { log.saved++; }, openNoteStylesFolder: async () => { log.opened++; },
    openPromptPreview: trigger => { log.previewed.push(trigger); },
    setGlobalPart: (...args) => Plugin.prototype.setGlobalPart.apply(plugin, args),
    topicNoteStyleRefs: () => [], noteStyles: { folderExists: () => exists, folder: () => settingsObject.noteStylesFolder ?? folder, refresh: async () => {}, listBlocks: () => items, listRecipes: () => recipes, listParts: category => (category === 'format' ? formats : []), listUnusedCopies: () => [] }
  };
  return { setting, view, log, plugin, settings: settingsObject };
}


const item = (ref, name, extra = {}) => ({ ref, kind: ref.startsWith('builtin:') ? 'builtin' : 'file', name, modified: false, issues: [], ...extra });
const TEMPLATES = () => [item('builtin:standard', 'Standard'), item('builtin:textbook', 'Textbook')];

const plainOf = value => JSON.parse(JSON.stringify(value));
const radiosOf = (view, label) => { const group = dom.findAll(view.settingEl, node => node.attrs.role === 'radiogroup').find(node => node.attrs['aria-labelledby'] && dom.findAll(view.settingEl, p => p.attrs.id === node.attrs['aria-labelledby'] && p.text === label).length); return group ? group.children : []; };
const checkedOf = buttons => buttons.filter(button => button.attrs['aria-checked'] === 'true').map(button => button.text);
const sampleOf = view => dom.find(view.settingEl, node => node.hasClass('vam-style-sample'));
const cardRow = (settings = {}) => {
  const state = row({ settings });
  state.plugin.saveSettings = async () => { state.log.saved++; state.saves.push(JSON.stringify(state.settings.noteStyleDefaults ?? null)); };
  state.saves = [];
  state.view.name = t('ui.note_style_card_title');
  renderNoteStyleCard(state.setting, state.plugin);
  return state;
};

test('P3 card: the top of the Note style page is the "How notes are written" card with its help line and a muted Preview AI instructions button that opens from itself; drawing it writes nothing', async () => {
  const { view, log, plugin, settings } = cardRow();
  await flush();
  assert.notEqual(view.heading, true);
  assert.equal(view.name, 'How notes are written');
  assert.equal(view.desc, 'Applies to every topic. To make one type different, change it below.');
  assert.equal(view.buttons.length, 1);
  assert.equal(view.buttons[0].text, 'Preview AI instructions');
  assert.equal(view.buttons[0].buttonEl.hasClass('mod-muted'), true);
  view.buttons[0].click();
  assert.deepEqual(log.previewed, [view.buttons[0].buttonEl]);
  assert.equal(log.saved, 0);
  assert.equal('noteStyleDefaults' in settings, false);
  assert.equal(plugin.settings.noteStyleDefaults, undefined);
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_card_title'), '筆記要怎麼寫');
});

test('P3 card: voice chips are Professional, Plain explanation, Narrative (retired voices are not listed) and format chips are Standard, Lean, Rich, Skim list; the defaults are the ones checked', async () => {
  const { view } = cardRow();
  await flush();
  const voices = radiosOf(view, 'Voice');
  const formats = radiosOf(view, 'Length and layout');
  assert.deepEqual(voices.map(button => button.text), ['Professional', 'Plain explanation', 'Narrative']);
  assert.deepEqual(formats.map(button => button.text), ['Standard', 'Lean', 'Rich', 'Skim list']);
  assert.deepEqual(checkedOf(voices), ['Professional']);
  assert.deepEqual(checkedOf(formats), ['Standard']);
  assert.ok([...voices, ...formats].every(button => button.attrs.role === 'radio'));
  const unchecked = voices.filter(button => button.attrs['aria-checked'] === 'false');
  assert.ok(unchecked.every(button => button.attrs.tabindex === '-1'), 'Tab reaches only the checked chip');
  assert.equal(voices[0].attrs.tabindex, '0');
});

test('P3 card: a chip writes noteStyleDefaults; choosing the default again deletes the key and, when empty, the whole setting', async () => {
  const { view, settings, saves } = cardRow();
  await flush();
  radiosOf(view, 'Voice')[1].fire('click');
  await flush();
  assert.deepEqual(plainOf(settings.noteStyleDefaults), { voice: 'builtin:plain' });
  radiosOf(view, 'Length and layout')[1].fire('click');
  await flush();
  assert.deepEqual(plainOf(settings.noteStyleDefaults), { voice: 'builtin:plain', format: 'builtin:lean' });
  assert.deepEqual(checkedOf(radiosOf(view, 'Voice')), ['Plain explanation']);
  assert.deepEqual(checkedOf(radiosOf(view, 'Length and layout')), ['Lean']);
  radiosOf(view, 'Voice')[0].fire('click');
  await flush();
  assert.deepEqual(plainOf(settings.noteStyleDefaults), { format: 'builtin:lean' }, 'the voice key is deleted');
  radiosOf(view, 'Length and layout')[0].fire('click');
  await flush();
  assert.equal('noteStyleDefaults' in settings, false, 'no key left: the setting goes');
  assert.equal(saves.length, 4);
});

test('P3 card: the sample sentence follows the chosen voice (one sentence per built-in voice, in each language); a voice that is a file has no sample and the card says which voice is in use', async () => {
  const { view } = cardRow();
  await flush();
  const text = () => sampleOf(view).children.map(child => child.text).join('|');
  const seen = new Set();
  for (const [index, id] of [[0, 'academic'], [1, 'plain'], [2, 'magazine']]) {
    radiosOf(view, 'Voice')[index].fire('click');
    await flush();
    assert.equal(text(), `${t('ui.note_style_sample_caption')}|${t(`ui.note_style_sample_${id}`)}`);
    seen.add(text());
  }
  assert.equal(seen.size, 3, 'three different sentences');
  for (const language of ['zh-TW', 'zh-CN', 'en']) for (const id of ['academic', 'plain', 'magazine']) assert.ok(i18n.translate(language, `ui.note_style_sample_${id}`).length > 10);
  // a voice file as the global voice: no sample, no chip checked
  const file = cardRow({ noteStyleDefaults: { voice: 'file:Calm' } });
  await flush();
  assert.deepEqual(checkedOf(radiosOf(file.view, 'Voice')), []);
  const box = sampleOf(file.view);
  assert.equal(box.children.length, 1);
  // UI audit bugfix-2 bug 5 requires the human-readable name here (the raw "file:Calm" string leaked into the summary); this assertion used to lock the raw string, so it is updated to the new behavior.
  assert.equal(box.children[0].text, 'The current voice is “Calm (not found)”, which is not one of the choices above.');
});

test('P3 card: the chips are a keyboard radio group: Tab lands on the checked chip, the arrow keys pick the next or previous one (wrapping) and keep the focus on the new chip', async () => {
  const { view, settings } = cardRow();
  await flush();
  const press = (button, key) => { let prevented = false; button.fire('keydown', { key, preventDefault() { prevented = true; } }); return prevented; };
  const groups = dom.findAll(view.settingEl, node => node.attrs.role === 'radiogroup');
  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.attrs['aria-labelledby']));
  assert.equal(press(radiosOf(view, 'Voice')[0], 'ArrowRight'), true);
  await flush();
  assert.deepEqual(plainOf(settings.noteStyleDefaults), { voice: 'builtin:plain' });
  assert.equal(radiosOf(view, 'Voice')[1].focused, true, 'the focus follows the pick');
  assert.equal(radiosOf(view, 'Voice')[1].attrs.tabindex, '0');
  assert.equal(press(radiosOf(view, 'Voice')[1], 'ArrowLeft'), true);
  await flush();
  assert.equal('noteStyleDefaults' in settings, false);
  press(radiosOf(view, 'Voice')[0], 'ArrowLeft');
  await flush();
  assert.deepEqual(plainOf(settings.noteStyleDefaults), { voice: 'builtin:magazine' }, 'wraps around');
  assert.equal(press(radiosOf(view, 'Voice')[2], 'a'), false, 'other keys are left alone');
});

test('P3 card: the format line explains the chosen format; a format that is a file says which one is in use', async () => {
  const { view } = cardRow();
  await flush();
  const line = () => dom.find(view.settingEl, node => node.tag === 'p' && node.hasClass('setting-item-description')).text;
  assert.equal(line(), 'Paragraphs first, key points in callouts.');
  const names = ['lean', 'rich', 'skim'];
  for (const [index, id] of names.entries()) {
    radiosOf(view, 'Length and layout')[index + 1].fire('click');
    await flush();
    assert.equal(line(), t(`ui.note_style_format_desc_${id}`));
  }
  const file = cardRow({ noteStyleDefaults: { format: 'file:Mine' } });
  await flush();
  assert.deepEqual(checkedOf(radiosOf(file.view, 'Length and layout')), []);
});

test('P3 card: choosing a chip draws the topic-type rows of the page again, so their lines show the new voice', async () => {
  const recipes = RECIPES();
  const settings = { language: 'en' };
  const plugin = { app: {}, settings, saveSettings: async () => {}, noteStyles: { refresh: async () => {}, listRecipes: () => recipes, listParts: () => [] } };
  plugin.setGlobalPart = (...args) => Plugin.prototype.setGlobalPart.apply(plugin, args);
  const kind = fakeSetting();
  renderNoteKindSetting(kind.setting, plugin, 'topic');
  const card = fakeSetting();
  renderNoteStyleCard(card.setting, plugin);
  await flush();
  assert.match(lines(kind.view)[0], /Academic/);
  for (const r of recipes) r.voice = { ref: 'builtin:plain', name: 'Plain explanation' };
  radiosOf(card.view, 'Voice')[1].fire('click');
  await flush();
  assert.match(lines(kind.view)[0], /Plain explanation/);
});

test('File location row: the folder path (read-only), a Show in file explorer button, and "no files yet" until a file exists', async () => {
  const none = row({ items: TEMPLATES() });
  renderNoteLocationSetting(none.setting, none.plugin, () => { none.log.refreshed++; });
  assert.equal(none.view.name, 'File location');
  assert.equal(none.view.desc, t('ui.note_style_location_desc'), 'before the files are read nothing is claimed');
  await flush();
  assert.equal(none.view.desc, 'No files yet. The first edit or save creates them.');
  assert.equal(none.view.texts[0].disabled, true);
  assert.equal(none.view.texts[0].value, 'WS/Styles');
  assert.equal(none.view.buttons.length, 1);
  assert.equal(none.view.buttons[0].text, 'Show in file explorer');
  await none.view.buttons[0].click();
  assert.equal(none.log.opened, 1);
  const some = row({ items: [...TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] });
  renderNoteLocationSetting(some.setting, some.plugin, () => {});
  await flush();
  assert.equal(some.view.desc, 'Structures and voices you edited or created are stored here.');
  // a folder never made and never chosen is not "not found"
  const fresh = row({ exists: false, items: TEMPLATES() });
  renderNoteLocationSetting(fresh.setting, fresh.plugin, () => {});
  await flush();
  assert.equal(fresh.view.name, 'File location');
  assert.equal(fresh.view.desc, 'No files yet. The first edit or save creates them.');
});

test('File location row: a chosen folder that is gone says so and can be chosen again (only the words changed)', async () => {
  const { setting, view, log, plugin, settings } = row({ exists: false, settings: { noteStylesFolder: 'WS/Old' }, items: TEMPLATES() });
  renderNoteLocationSetting(setting, plugin, () => { log.refreshed++; });
  assert.match(view.name, /File location not found/);
  assert.equal(view.texts[0].disabled, false);
  view.texts[0].change(' WS/Moved ');
  await view.buttons[0].click();
  assert.equal(settings.noteStylesFolder, 'WS/Moved');
  assert.equal(log.refreshed, 1);
  assert.equal(view.buttons[1].text, 'Show in file explorer');
});

test('the settings page has no tone presets row and the modal file no longer offers the settings renderer', () => {
  const tab = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.ok(!/tone_presets|renderTonePresetsSetting|LEGACY_PICK|legacyName/.test(tab));
  const modal = fs.readFileSync(path.join(root, 'ui/modals/prompt-presets-modal.ts'), 'utf8');
  assert.ok(!/renderTonePresetsSetting|ui\.tone_preset|"tone"/.test(modal), 'the library lists outline presets only');
});

test('every style-file problem has a translated message in en, zh-TW and zh-CN, with the limits filled in', () => {
  const bad = {
    file_long: `---\n圖表: 關\n---\n## A\n${'x'.repeat(8100)}`,
    tone_long: `---\n語氣: ${'x'.repeat(1100)}\n---\n## A\nx`,
    frontmatter_unclosed: '---\n圖表: 關\n## A\nx',
    // P2: frontmatter_line and value_invalid are no longer raised by the parser (the old switches are skipped there)
    no_sections: 'just text',
    count_invalid: '## A\n數量: abc\nx',
    comment_unclosed: '## A\n%% never closed\nx'
  };
  for (const [code, text] of Object.entries(bad)) {
    const parsed = parseNoteStyleFile(text, { id: 'x', name: 'x' });
    assert.equal(parsed.ok, false, code);
    const issue = parsed.issues.find(item => item.code === code);
    assert.ok(issue, `${code} is reported`);
    for (const language of ['en', 'zh-TW', 'zh-CN']) {
      i18n.setUiLanguage(language);
      const shown = styleIssueText(issue);
      assert.ok(shown && !/ui\.|\{\d\}/.test(shown), `${code} ${language}: ${shown}`);
    }
  }
  i18n.setUiLanguage('en');
});

test('the old template library is gone from the code and the dictionaries', () => {
  assert.ok(!fs.existsSync(path.join(root, 'ui/modals/detail-templates-modal.ts')));
  for (const language of ['en', 'zh-TW', 'zh-CN']) assert.ok(!fs.readFileSync(path.join(root, `i18n/${language}.ts`), 'utf8').includes('"ui.note_style_custom"'));
});

test('R1-4 (replaces Low 2, the standard structure hint; D9): the strings of the five-preset menu are gone from the three dictionaries', () => {
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    const text = fs.readFileSync(path.join(root, `i18n/${language}.ts`), 'utf8');
    assert.ok(!/"ui\.note_style_(custom_0_1|standard|textbook|summary|plain|guide)(_short|_hint)?"/.test(text), language);
  }
});

// ---- the seven topic-type rows ----
const rec = (ref, name, extra = {}) => ({
  ref, kind: ref.startsWith('builtin:') ? 'builtin' : 'file', name,
  structure: { ref: 'builtin:standard', name: 'Standard six' }, voice: { ref: 'builtin:academic', name: 'Academic' }, format: { ref: 'builtin:standard', name: 'Standard format' },
  update: 'merge', description: '', issues: [], usedByKinds: [], ...extra
});
const RECIPES = () => [
  rec('builtin:general', 'General research'), rec('builtin:atomic', 'Atomic note'), rec('builtin:hypothesis', 'Hypothesis test'), rec('builtin:evidence', 'Evidence'),
  rec('builtin:conclusion', 'Conclusion'), rec('builtin:action', 'Action'),
  rec('builtin:aim', 'AIM report', { aimOnly: true, structure: { ref: 'aim-delivery', name: 'AIM report' } })
];
const KIND_ORDER = ['topic', 'atomic', 'hypothesis', 'evidence', 'conclusion', 'action', 'aim'];
const kindName = kind => (kind === 'aim' ? t('ui.note_style_kind_aim') : t(`ui.topic_kind_${kind}`));
function kindRow(kind, { settings = {}, recipes = RECIPES() } = {}) {
  const { setting, view } = fakeSetting();
  const saves = [];
  const settingsObject = { language: 'en', ...settings };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { saves.push(JSON.stringify(settingsObject.noteStyleByKind ?? null)); },
    setKindStyle: (...args) => Plugin.prototype.setKindStyle.apply(plugin, args),
    noteStyles: { refresh: async () => {}, listRecipes: () => recipes, listParts: () => [] }
  };
  renderNoteKindSetting(setting, plugin, kind);
  return { view, setting, settings: settingsObject, saves, plugin };
}

test('seven rows: each is named after its type (the AIM row last), shows the type\'s own built-in style, offers no empty "not set" option, and rendering writes nothing', async () => {
  for (const kind of KIND_ORDER) {
    const state = kindRow(kind);
    await flush();
    assert.equal(state.view.name, kindName(kind));
    assert.equal(state.view.dropdown.selectEl.value, { topic: 'builtin:general', aim: 'builtin:aim' }[kind] ?? `builtin:${kind}`, kind);
    assert.ok(optionsOf(state.view).length > 0 && optionsOf(state.view).every(option => option[0] !== ''), `${kind}: no empty value`);
    assert.equal(state.view.buttons.length + state.view.extras.length, 0, 'only a picker');
    assert.equal(state.saves.length, 0, 'opening the page saves nothing');
    assert.equal('noteStyleByKind' in state.settings, false);
  }
});

test('seven rows: only the AIM row offers the AIM report, and it comes first; the others never list it', async () => {
  const aim = kindRow('aim');
  await flush();
  assert.deepEqual(optionsOf(aim.view)[0], ['builtin:aim', 'AIM report']);
  assert.equal(aim.view.dropdown.selectEl.children[0].tag, 'option', 'ahead of the groups');
  for (const kind of KIND_ORDER.slice(0, 6)) {
    const state = kindRow(kind);
    await flush();
    assert.equal(optionsOf(state.view).some(option => option[0] === 'builtin:aim'), false, kind);
    assert.deepEqual(optionsOf(state.view).map(option => option[1]), ['General research', 'Atomic note', 'Hypothesis test', 'Evidence', 'Conclusion', 'Action'], kind);
  }
});

test('seven rows: a Built-in group, and a Mine group only when own style files exist; a style with a problem is marked', async () => {
  const only = kindRow('topic');
  assert.deepEqual(groupsOf(only.view).map(group => group.label), ['Built-in']);
  const bad = rec('file:Bad', 'Bad', { fileName: 'Bad.md', issues: [{ line: 4, code: 'part_missing', values: ['Gone'], message: 'x' }] });
  const both = kindRow('topic', { recipes: [...RECIPES(), rec('file:Mine', 'Mine', { fileName: 'Mine.md' }), bad] });
  assert.deepEqual(groupsOf(both.view).at(-1), { label: 'Mine', options: ['Mine', 'Bad (has a problem)'] });
  assert.deepEqual(groupsOf(both.view).map(group => group.label), ['Built-in', 'Mine']);
});

test('seven rows: the description lists the four parts "structure · voice · format · update mode"; the AIM report has no update mode', async () => {
  const general = kindRow('topic');
  assert.deepEqual(lines(general.view), [`Standard six · Academic · Standard format · ${t('ui.update_mode_merge')}`]);
  const top = kindRow('topic', { settings: { noteStyleByKind: { topic: 'file:Weekly' } }, recipes: [...RECIPES(), rec('file:Weekly', 'Weekly', { update: 'top', voice: { ref: 'file:Calm', name: 'Calm' } })] });
  await flush();
  assert.deepEqual(lines(top.view), [`Standard six · Calm · Standard format · ${t('ui.update_mode_top')}`]);
  const aim = kindRow('aim');
  assert.deepEqual(lines(aim.view), ['AIM report · Academic · Standard format']);
});

test('seven rows: every picker is named "Sections for <type>" (zh-TW: "<類型>的段落", P3 / A1), all different', async () => {
  for (const kind of KIND_ORDER) assert.equal(kindRow(kind).view.dropdown.selectEl.attrs['aria-label'], `Sections for ${kindName(kind)}`);
  assert.equal(new Set(KIND_ORDER.map(kind => kindRow(kind).view.dropdown.selectEl.attrs['aria-label'])).size, 7);
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_kind_row_aria_0', i18n.translate('zh-TW', 'ui.topic_kind_hypothesis')), '假設的段落');
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_kind_row_aria_0', i18n.translate('zh-TW', 'ui.note_style_kind_aim')), 'AIM 結論筆記的段落');
  assert.equal(kindRow('topic').view.descEl.attrs['aria-live'], 'polite');
});

test('seven rows: choosing writes the ref; choosing the type\'s own built-in style again deletes the kind and, when empty, the whole key (decision D8)', async () => {
  const a = kindRow('hypothesis');
  await flush();
  await a.view.dropdown.change('file:Mine');
  assert.deepEqual({ ...a.settings.noteStyleByKind }, { hypothesis: 'file:Mine' });
  assert.equal(a.saves.length, 1);
  const b = kindRow('evidence', { settings: { noteStyleByKind: { hypothesis: 'file:Mine', evidence: 'file:Other' } }, recipes: [...RECIPES(), rec('file:Mine', 'Mine'), rec('file:Other', 'Other')] });
  await flush();
  assert.equal(b.view.dropdown.selectEl.value, 'file:Other');
  await b.view.dropdown.change('builtin:evidence');
  assert.deepEqual({ ...b.settings.noteStyleByKind }, { hypothesis: 'file:Mine' });
  assert.equal(b.view.dropdown.selectEl.value, 'builtin:evidence');
  const c = kindRow('hypothesis', { settings: { noteStyleByKind: { hypothesis: 'file:Mine' } }, recipes: [...RECIPES(), rec('file:Mine', 'Mine')] });
  await flush();
  await c.view.dropdown.change('builtin:hypothesis');
  assert.equal('noteStyleByKind' in c.settings, false, 'no empty object is left in data.json');
  assert.equal(c.saves.length, 1);
  // another type's built-in style is a real choice and is kept
  const d = kindRow('topic');
  await d.view.dropdown.change('builtin:hypothesis');
  assert.deepEqual({ ...d.settings.noteStyleByKind }, { topic: 'builtin:hypothesis' });
});

test('seven rows: a saved style that is gone shows "Not found: X" selected with an error line and is never rewritten, also after a refresh', async () => {
  const gone = kindRow('action', { settings: { noteStyleByKind: { action: 'file:已刪' } } });
  assert.deepEqual(lines(gone.view), [], 'before the first read of the style files nothing is claimed, no error either');
  assert.equal(optionsOf(gone.view).some(option => /Not found/.test(option[1])), false);
  await flush();
  assert.equal(gone.view.dropdown.selectEl.value, 'file:已刪');
  assert.deepEqual(optionsOf(gone.view)[0], ['file:已刪', 'Not found: 已刪']);
  assert.deepEqual(lines(gone.view), ['⚠ ' + t('ui.note_style_row_missing_0_1', 'Action', '已刪')]);
  assert.deepEqual(errorLines(gone.view), lines(gone.view));
  assert.equal(gone.settings.noteStyleByKind.action, 'file:已刪');
  assert.equal(gone.saves.length, 0);
  assert.equal(missingStyleRef(gone.plugin, 'action'), 'file:已刪');
  assert.equal(missingStyleRef(gone.plugin, 'topic'), undefined);
  assert.equal(shownStyleRef(gone.plugin, 'action'), 'file:已刪');
  assert.equal(shownStyleRef(gone.plugin, 'topic'), 'builtin:general');
  // the AIM report is not a style a topic type can use: saved there it is "not found" too; on the AIM row it is fine
  const wrong = kindRow('topic', { settings: { noteStyleByKind: { topic: 'builtin:aim' } } });
  await flush();
  assert.equal(wrong.view.dropdown.selectEl.value, 'builtin:aim');
  assert.deepEqual(optionsOf(wrong.view)[0], ['builtin:aim', 'Not found: aim']);
  assert.equal(missingStyleRef(kindRow('aim', { settings: { noteStyleByKind: { aim: 'builtin:aim' } } }).plugin, 'aim'), undefined);
  // choosing another style brings the normal description back
  await gone.view.dropdown.change('builtin:action');
  assert.equal(optionsOf(gone.view).some(option => /Not found/.test(option[1])), false);
  assert.equal(errorLines(gone.view).length, 0);
});

test('seven rows: a style file with a problem shows its first problem, translated, with the line number (part files and style files)', async () => {
  const partIssue = { line: 5, code: 'part_missing', values: ['Calm'], message: 'x' };
  const bad = kindRow('action', { settings: { noteStyleByKind: { action: 'file:Broken' } }, recipes: [...RECIPES(), rec('file:Broken', 'Broken', { issues: [partIssue, { line: 1, code: 'update_invalid', values: [], message: 'y' }] })] });
  await flush();
  assert.deepEqual(optionsOf(bad.view).find(option => option[0] === 'file:Broken'), ['file:Broken', 'Broken (has a problem)']);
  assert.deepEqual(lines(bad.view), ['⚠ Line 5: ' + t('ui.note_style_issue_part_missing', 'Calm')]);
  assert.deepEqual(errorLines(bad.view), lines(bad.view));
  assert.ok(!/ui\.|part_missing/.test(lines(bad.view)[0]), 'the code is translated, not shown raw');
  for (const code of ['part_missing', 'update_invalid', 'part_name_invalid', 'builtin_name', 'format_zone_moved'])
    for (const language of ['en', 'zh-TW', 'zh-CN']) assert.ok(i18n.translate(language, `ui.note_style_issue_${code}`, 'X') && !/^ui\./.test(i18n.translate(language, `ui.note_style_issue_${code}`, 'X')), `${code} ${language}`);
  const partFile = kindRow('action', { settings: { noteStyleByKind: { action: 'file:Broken' } }, recipes: [...RECIPES(), rec('file:Broken', 'Broken', { issues: [{ line: 3, code: 'format_heading_repeated', values: [], message: 'x' }] })] });
  await flush();
  assert.match(lines(partFile.view)[0], /^⚠ Line 3: /);
});

test('seven rows: the description is written only when its text changes (live region), and the row carries the wrapping class', async () => {
  const state = kindRow('topic');
  await flush();
  assert.deepEqual(state.setting.settingEl.classes, ['vam-block-row']);
  const writes = state.view.descWrites;
  assert.ok(writes >= 1);
  await state.view.dropdown.change('builtin:general');
  await flush();
  assert.equal(state.view.descWrites, writes, 'a pick that leaves the text alone does not write it twice');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /^\.vam-block-row > \.setting-item-control \{[^}]*flex-wrap: wrap/m);
  assert.match(css, /^\.vam-block-row \.vam-block-status-error \{ color: var\(--text-error\); \}/m);
});

test('Low 4: the File location description is rewritten when its update runs after a style file appeared, without reopening the page', async () => {
  const items = TEMPLATES();
  const loc = row({ items });
  const update = renderNoteLocationSetting(loc.setting, loc.plugin, () => {});
  await flush();
  assert.equal(loc.view.desc, 'No files yet. The first edit or save creates them.');
  update();
  await flush();
  assert.equal(loc.view.desc, 'No files yet. The first edit or save creates them.', 'no file was made');
  items.push(item('file:Mine', 'Mine', { fileName: 'Mine.md' }));
  update();
  await flush();
  assert.equal(loc.view.desc, 'Structures and voices you edited or created are stored here.');
});

test('Bug bash E #20: a style recipe or a format rule file counts as a file in the File location row, and the row is rewritten when the manage window closes', async () => {
  openedModals.length = 0;
  const withRecipe = row({ items: TEMPLATES(), recipes: [{ ref: 'file:R', kind: 'file', name: 'R', fileName: 'R.md' }] });
  renderNoteLocationSetting(withRecipe.setting, withRecipe.plugin, () => {});
  await flush();
  assert.equal(withRecipe.view.desc, t('ui.note_style_location_desc'), 'a recipe file alone is a file');
  const withFormat = row({ items: TEMPLATES(), formats: [{ ref: 'file:F', kind: 'file', name: 'F', fileName: 'F.md' }] });
  renderNoteLocationSetting(withFormat.setting, withFormat.plugin, () => {});
  await flush();
  assert.equal(withFormat.view.desc, t('ui.note_style_location_desc'), 'a format rule file alone is a file');
  // the window closes after a recipe was made in it: the location row of the same page follows
  const recipes = [];
  const page = row({ items: TEMPLATES(), recipes });
  renderNoteLocationSetting(page.setting, page.plugin, () => {});
  await flush();
  assert.equal(page.view.desc, t('ui.note_style_location_empty'));
  const manage = fakeSetting();
  renderMyStylesSetting(manage.setting, page.plugin);
  manage.view.buttons[0].click();
  recipes.push({ ref: 'file:R', kind: 'file', name: 'R', fileName: 'R.md' });
  openedModals.at(-1).onClosed();
  await flush();
  assert.equal(page.view.desc, t('ui.note_style_location_desc'));
});

// ---- the "My styles" row (settings-redesign P3; replaces the four "Custom" rows) ----
const part = (ref, name) => ({ ref, kind: ref.startsWith('builtin:') ? 'builtin' : 'file', name, issues: [], usedBy: [] });
function mineRow({ recipes = RECIPES(), parts = {}, unused = [], folder = 'WS/Styles' } = {}) {
  const { setting, view } = fakeSetting();
  const log = { refreshes: 0, opened: 0, writes: 0 };
  const plugin = {
    app: { marker: 'app' }, settings: { language: 'en' }, openNoteStylesFolder: async () => { log.opened++; },
    topicNoteStyleRefs: () => [], noteStyles: { refresh: async () => { log.refreshes++; }, folder: () => folder, listRecipes: () => recipes, listParts: category => parts[category] ?? [], listUnusedCopies: () => unused }
  };
  renderMyStylesSetting(setting, plugin);
  return { view, plugin, log };
}
const pathLink = view => dom.find(view.descEl, node => node.tag === 'a');

test('P3 My styles: one row names how many styles and how many structures, voices and formats are the user\'s own (built-ins and the AIM report are not counted); Manage… opens the manage window on the styles tab with itself as the trigger', async () => {
  openedModals.length = 0;
  const parts = { structure: [part('builtin:a', 'A'), part('file:S1', 'S1')], voice: [part('builtin:b', 'B'), part('file:V1', 'V1'), part('file:V2', 'V2')], format: [part('file:F1', 'F1')] };
  const state = mineRow({ recipes: [...RECIPES(), rec('file:Mine', 'Mine'), rec('file:Other', 'Other')], parts });
  assert.equal(state.view.name, '2 styles, 4 structures, voices and formats');
  assert.equal(state.view.buttons.length, 1);
  assert.equal(state.view.buttons[0].text, 'Manage…');
  assert.equal(state.view.buttons[0].buttonEl.attrs['aria-label'], 'Manage my styles');
  state.view.buttons[0].click();
  const modal = openedModals.at(-1);
  assert.equal(modal.tab, 'recipe');
  assert.equal(modal.trigger, state.view.buttons[0].buttonEl);
  assert.equal(modal.plugin, state.plugin);
  await flush();
  assert.equal(state.log.refreshes, 1, 'the files are read again after drawing');
  assert.equal(i18n.translate('zh-TW', 'ui.my_styles_count_0_1', 2, 4), '2 份風格、4 份段落、口吻與格式');
  assert.equal(i18n.translate('zh-TW', 'ui.settings_group_my_styles'), '我的風格');
  assert.equal(i18n.translate('zh-TW', 'ui.my_styles_manage'), '管理…');
});

test('P3 My styles: the unused-copy line shows the number only when there are unused copies; the folder path is a link that shows the folder in the file explorer', async () => {
  const none = mineRow();
  assert.equal(dom.find(none.view.descEl, node => node.hasClass('vam-style-unused')), undefined);
  const three = mineRow({ unused: [{ ref: 'file:a' }, { ref: 'file:b' }, { ref: 'file:c' }] });
  assert.equal(dom.find(three.view.descEl, node => node.hasClass('vam-style-unused')).text, '3 unused copies can be cleared at once');
  assert.equal(i18n.translate('zh-TW', 'ui.my_styles_unused_0', 3), '有 3 份沒在用的複本，可以一次清掉');
  const link = pathLink(three.view);
  assert.equal(link.text, 'WS/Styles');
  let prevented = false;
  link.fire('click', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(three.log.opened, 1);
});

test('P3 My styles: the numbers are written again when the window closes (after files were made in it), and drawing the row writes no setting', async () => {
  openedModals.length = 0;
  const recipes = RECIPES();
  const unused = [];
  const state = mineRow({ recipes, unused });
  assert.equal(state.view.name, '0 styles, 0 structures, voices and formats');
  state.view.buttons[0].click();
  recipes.push(rec('file:New', 'New'));
  unused.push({ ref: 'file:New' });
  openedModals.at(-1).onClosed();
  assert.equal(state.view.name, '1 styles, 0 structures, voices and formats');
  assert.ok(dom.find(state.view.descEl, node => node.hasClass('vam-style-unused')));
  assert.equal(state.plugin.settings.noteStyleByKind, undefined);
});

test('F1 R6 (was failing first): when the manage window closes, the seven topic-type rows of the open page are drawn again from the store, so a style made or deleted in the window shows in their pickers', async () => {
  openedModals.length = 0;
  const recipes = RECIPES();
  const settings = { language: 'en' };
  const plugin = { app: {}, settings, saveSettings: async () => {}, topicNoteStyleRefs: () => [], noteStyles: { refresh: async () => {}, folder: () => 'WS/Styles', listRecipes: () => recipes, listParts: () => [], listUnusedCopies: () => [] } };
  plugin.setKindStyle = (...args) => Plugin.prototype.setKindStyle.apply(plugin, args);
  const rows = KIND_ORDER.map(kind => { const { setting, view } = fakeSetting(); renderNoteKindSetting(setting, plugin, kind); return { kind, view }; });
  const manage = fakeSetting();
  renderMyStylesSetting(manage.setting, plugin);
  await flush();
  for (const row of rows) assert.equal(optionsOf(row.view).some(option => option[0] === 'file:Fresh'), false);
  manage.view.buttons[0].click();
  recipes.push(rec('file:Fresh', 'Fresh'));
  for (const row of rows) assert.equal(optionsOf(row.view).some(option => option[0] === 'file:Fresh'), false, 'not before the window closes');
  openedModals.at(-1).onClosed();
  await flush();
  for (const row of rows) assert.ok(optionsOf(row.view).some(option => option[0] === 'file:Fresh'), `${row.kind} shows the new style`);
  assert.equal('noteStyleByKind' in settings, false, 'drawing again saves nothing');
});

test('K3 (P4, now on the My styles row): a retired built-in is never counted, only the user\'s own files are', async () => {
  const retired = (ref, name, usedBy) => ({ ...part(ref, name), retired: true, usedBy });
  const parts = { voice: [part('builtin:a', 'A'), retired('builtin:r1', 'R1', []), retired('builtin:r2', 'R2', ['Old']), part('file:Mine', 'Mine')] };
  assert.equal(mineRow({ parts }).view.name, '0 styles, 1 structures, voices and formats');
});

test('P3 rows (was failing first): no space follows a full-width closing bracket before the dot, so "（另外指定）" is not followed by a gap', async () => {
  const line = kindStyleLine(rec('file:X', 'X', { voiceSource: 'global', formatSource: 'global', voice: { ref: 'file:V', name: '口吻（另外指定）' } }));
  assert.ok(line.includes('口吻（另外指定）· '), line);
  assert.ok(!line.includes('） '), line);
});

// ---- the topic-type rows: set apart, voice retired, only new content (settings-redesign P3) ----
test('P3 rows: a voice or format the style sets apart says "(set apart)" in the line; the ones that follow the global choice say nothing; the AIM report is never marked', async () => {
  const apart = rec('builtin:evidence', 'Evidence', { format: { ref: 'builtin:lean', name: 'Lean format' }, formatSource: 'style', voiceSource: 'global' });
  assert.equal(kindStyleLine(apart), `Standard six · Academic · Lean format (set apart) · ${t('ui.update_mode_merge')}`);
  const both = rec('file:X', 'X', { voiceSource: 'style', formatSource: 'style' });
  assert.equal(kindStyleLine(both), `Standard six · Academic (set apart) · Standard format (set apart) · ${t('ui.update_mode_merge')}`);
  assert.equal(kindStyleLine(rec('file:Y', 'Y', { voiceSource: 'global', formatSource: 'global' })), `Standard six · Academic · Standard format · ${t('ui.update_mode_merge')}`);
  assert.equal(kindStyleLine(rec('builtin:aim', 'AIM report', { aimOnly: true, voiceSource: 'style', formatSource: 'style', structure: { ref: 'aim-delivery', name: 'AIM report' } })), 'AIM report · Academic · Standard format');
  const row = kindRow('evidence', { settings: { noteStyleByKind: { evidence: 'builtin:evidence' } }, recipes: [...RECIPES().filter(r => r.ref !== 'builtin:evidence'), apart] });
  await flush();
  assert.match(lines(row.view)[0], /Lean format \(set apart\)/);
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_set_apart_0', '精簡'), '精簡（另外指定）');
});

const tagTexts = view => view.nameEl.children.map(child => child.text);
test('P3 rows: "Voice retired" shows beside the name only when the style\'s voice is a retired built-in (summary, guide, auto), and the line marks that voice', async () => {
  for (const id of ['summary', 'guide', 'auto']) {
    const retired = rec('file:Old', 'Old', { voice: { ref: `builtin:${id}`, name: 'Key-point summary' }, voiceSource: 'style' });
    const row = kindRow('atomic', { settings: { noteStyleByKind: { atomic: 'file:Old' } }, recipes: [...RECIPES(), retired] });
    await flush();
    assert.deepEqual(tagTexts(row.view), ['Voice retired'], id);
    assert.equal(row.view.nameEl.children[0].hasClass('vam-style-tag'), true);
    assert.match(lines(row.view)[0], /Key-point summary \(retired\) \(set apart\)/);
  }
  for (const id of ['academic', 'plain', 'magazine']) {
    const live = rec('file:Live', 'Live', { voice: { ref: `builtin:${id}`, name: 'X' }, voiceSource: 'style' });
    const row = kindRow('atomic', { settings: { noteStyleByKind: { atomic: 'file:Live' } }, recipes: [...RECIPES(), live] });
    await flush();
    assert.deepEqual(tagTexts(row.view), [], id);
  }
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_tag_voice_retired'), '口吻已停用');
});

test('P3 rows: "Only new content" shows only when the update mode is fresh, named like the update mode; choosing another style takes the tags away again', async () => {
  const fresh = rec('file:Fresh', 'Fresh', { update: 'fresh' });
  const row = kindRow('hypothesis', { settings: { noteStyleByKind: { hypothesis: 'file:Fresh' } }, recipes: [...RECIPES(), fresh] });
  await flush();
  assert.deepEqual(tagTexts(row.view), [t('ui.update_mode_fresh')]);
  assert.equal(t('ui.update_mode_fresh'), 'Save new content only');
  assert.equal(i18n.translate('zh-TW', 'ui.update_mode_fresh'), '只存新內容');
  for (const update of ['merge', 'top']) {
    const other = kindRow('hypothesis', { settings: { noteStyleByKind: { hypothesis: 'file:Other' } }, recipes: [...RECIPES(), rec('file:Other', 'Other', { update })] });
    await flush();
    assert.deepEqual(tagTexts(other.view), [], update);
  }
  await row.view.dropdown.change('builtin:hypothesis');
  assert.deepEqual(tagTexts(row.view), [], 'redrawn without the tag');
  const both = kindRow('atomic', { settings: { noteStyleByKind: { atomic: 'file:B' } }, recipes: [...RECIPES(), rec('file:B', 'B', { update: 'fresh', voice: { ref: 'builtin:summary', name: 'S' }, voiceSource: 'style' })] });
  await flush();
  assert.deepEqual(tagTexts(both.view), ['Voice retired', 'Save new content only']);
});

test('P3 rows: a style with a problem or a missing style shows no tags; the dropdown stays a style picker (no new key) and rendering saves nothing', async () => {
  const bad = rec('file:Bad', 'Bad', { update: 'fresh', issues: [{ line: 4, code: 'part_missing', values: ['Gone'], message: 'x' }] });
  const row = kindRow('topic', { settings: { noteStyleByKind: { topic: 'file:Bad' } }, recipes: [...RECIPES(), bad] });
  await flush();
  assert.deepEqual(tagTexts(row.view), []);
  const gone = kindRow('topic', { settings: { noteStyleByKind: { topic: 'file:Gone' } } });
  await flush();
  assert.deepEqual(tagTexts(gone.view), []);
  assert.equal(row.saves.length + gone.saves.length, 0);
  assert.equal(JSON.stringify(Object.keys(row.settings)), '["language","noteStyleByKind"]');
});

test('P3 page: opening the Note style page writes nothing, at the card, the rows and the My styles row together', async () => {
  const writes = [];
  const recipes = RECIPES();
  const settings = { language: 'en' };
  const plugin = { app: {}, settings, saveSettings: async () => { writes.push('save'); }, openNoteStylesFolder: async () => { writes.push('folder'); }, topicNoteStyleRefs: () => [], noteStyles: { refresh: async () => {}, folder: () => 'WS/S', listRecipes: () => recipes, listParts: () => [], listUnusedCopies: () => [] } };
  plugin.setKindStyle = (...args) => Plugin.prototype.setKindStyle.apply(plugin, args);
  const before = JSON.stringify(settings);
  renderNoteStyleCard(fakeSetting().setting, plugin);
  for (const kind of KIND_ORDER) renderNoteKindSetting(fakeSetting().setting, plugin, kind);
  renderMyStylesSetting(fakeSetting().setting, plugin);
  await flush();
  assert.deepEqual(writes, []);
  assert.equal(JSON.stringify(settings), before);
});

// ---- AI suggested (P4): offered to the general topic row only ----
const realBuiltins = language => {
  const { NoteStyleStore } = S.load('ai/note-style-store.ts', { obsidian });
  const settings = { language, workspaceFolder: 'WS', noteStylesFolder: 'WS/S', detailTemplates: [], promptPresets: [] };
  const store = new NoteStyleStore({ settings: () => settings, port: { folderExists: () => false, listFiles: async () => [], readFile: async () => '' }, save: async () => {} });
  return store.listRecipes();
};

test('P4 settings: AI suggested is the last built-in of the general topic row only; the other five types and the AIM row do not offer it', async () => {
  const recipes = realBuiltins('en');
  for (const kind of KIND_ORDER) {
    const state = kindRow(kind, { recipes });
    await flush();
    const has = optionsOf(state.view).some(option => option[0] === 'builtin:ai-suggested');
    assert.equal(has, kind === 'topic', kind);
    if (kind === 'topic') {
      const builtin = groupsOf(state.view).find(group => group.label === 'Built-in');
      assert.equal(builtin.options.at(-1), 'AI suggested');
    }
  }
});

test('P4 settings: the AI suggested line reads "AI decides sections · Professional · Standard format · Merge rewrite" in every language, and choosing it saves the ref', async () => {
  for (const [language, expected] of [['zh-TW', 'AI 決定段落 · 專業 · 標準格式 · 整合改寫'], ['en', null], ['zh-CN', null]]) {
    const recipes = realBuiltins(language);
    const state = kindRow('topic', { settings: { language }, recipes });
    await flush();
    state.view.dropdown.selectEl.value = 'builtin:ai-suggested';
    await state.view.dropdown.change('builtin:ai-suggested');
    assert.deepEqual({ ...state.settings.noteStyleByKind }, { topic: 'builtin:ai-suggested' }, language);
    const item = recipes.find(entry => entry.ref === 'builtin:ai-suggested');
    assert.equal(kindStyleLine(item).split(' · ')[0], i18n.translate(language, 'ui.note_style_ai_sections_decide'));
    // The settings page bundle has its own interface language (English here); the first three parts come from the store in the settings language.
    if (expected) {
      assert.equal(kindStyleLine(item).split(' · ').slice(0, 3).join(' · '), expected.split(' · ').slice(0, 3).join(' · '));
      assert.equal(i18n.translate(language, 'ui.update_mode_merge'), expected.split(' · ')[3]);
    }
  }
});
