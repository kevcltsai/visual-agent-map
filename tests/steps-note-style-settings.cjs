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

class FakeModal { constructor(app) { this.app = app; } open() {} close() {} }
const notices = [];
const obsidian = { ...S.obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: FakeModal, Notice: dom.makeNotice(notices) };
const { renderNoteStyleIntro, renderNoteLocationSetting, renderNoteKindSetting, shownStyleRef, missingStyleRef } = S.load('ui/settings-tab.ts', { obsidian });
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
  view.descEl = descEl;
  const setting = {
    descEl, settingEl, nameEl: { setText: text => { view.name = text; } },
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

function row({ exists = true, folder = 'WS/Styles', settings = {}, items = [] } = {}) {
  const { setting, view } = fakeSetting();
  const log = { saved: 0, opened: 0, refreshed: 0, previewed: [] };
  const settingsObject = { language: 'en', ...settings };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { log.saved++; }, openNoteStylesFolder: async () => { log.opened++; },
    openPromptPreview: trigger => { log.previewed.push(trigger); },
    noteStyles: { folderExists: () => exists, folder: () => settingsObject.noteStylesFolder ?? folder, refresh: async () => {}, listBlocks: () => items }
  };
  return { setting, view, log, plugin, settings: settingsObject };
}


const item = (ref, name, extra = {}) => ({ ref, kind: ref.startsWith('builtin:') ? 'builtin' : 'file', name, modified: false, issues: [], ...extra });
const TEMPLATES = () => [item('builtin:standard', 'Standard'), item('builtin:textbook', 'Textbook')];

test('intro: the Note style sub-page opens with a plain row (not a heading) holding the help line and a muted Preview AI instructions button that gets the focus back', () => {
  const { setting, view, log, plugin } = row();
  view.name = t('ui.settings_note_style_intro'); // Obsidian applies the definition name before render
  renderNoteStyleIntro(setting, plugin);
  assert.notEqual(view.heading, true, 'an ordinary row, not a heading');
  assert.equal(view.name, '', 'the sentence is in the description only, not also in the name Obsidian pre-filled');
  assert.equal(view.desc, t('ui.settings_note_style_intro'));
  assert.equal(view.desc, 'Pick the note style AI uses for each topic type. A style picked on a topic or for one run still wins.');
  assert.equal(view.buttons.length, 1);
  assert.equal(view.buttons[0].text, 'Preview AI instructions');
  assert.equal(view.buttons[0].buttonEl.hasClass('mod-muted'), true);
  view.buttons[0].click();
  assert.deepEqual(log.previewed, [view.buttons[0].buttonEl]);
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

test('Low 2: the standard structure hint states the effect only, in three languages (no "same as today\'s default")', () => {
  assert.equal(t('ui.note_style_standard_hint'), 'Six fixed sections in a neutral, evidence-first voice.');
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_standard_hint'), '六個固定分類，中性、以證據為本。');
  assert.equal(i18n.translate('zh-CN', 'ui.note_style_standard_hint'), '六个固定分类，中性、以证据为本。');
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
    noteStyles: { refresh: async () => {}, listRecipes: () => recipes }
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

test('seven rows: every picker is named "Note style for <type>" (zh-TW: "<類型>的筆記風格"), all different', async () => {
  for (const kind of KIND_ORDER) assert.equal(kindRow(kind).view.dropdown.selectEl.attrs['aria-label'], `Note style for ${kindName(kind)}`);
  assert.equal(new Set(KIND_ORDER.map(kind => kindRow(kind).view.dropdown.selectEl.attrs['aria-label'])).size, 7);
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_kind_row_aria_0', i18n.translate('zh-TW', 'ui.topic_kind_hypothesis')), '假設的筆記風格');
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_kind_row_aria_0', i18n.translate('zh-TW', 'ui.note_style_kind_aim')), 'AIM 結論筆記的筆記風格');
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
