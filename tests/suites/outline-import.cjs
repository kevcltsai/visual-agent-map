const assert = require('node:assert/strict');
const { test, integrationTest, fixture, load, plain, obsidian, until } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const rawApi = load('experiences/visual-map/outline-import.ts', { obsidian });
const api = { ...rawApi, parseOutline: input => plain(rawApi.parseOutline(input)) };
const titles = parse => parse.nodes.map(node => `${'>'.repeat(node.level)}${node.title}@${node.parent ?? '-'}`);
const keys = issues => issues.map(issue => `${issue.key}:${issue.line}`);

test('outline: standard levels, parents by position, line numbers', () => {
  const parse = api.parseOutline('# Trip\n## Food\n### Breakfast\n## Food\n### Dinner\n');
  assert.deepEqual(titles(parse), ['>Trip@-', '>>Food@0', '>>>Breakfast@1', '>>Food@0', '>>>Dinner@3']);
  assert.deepEqual(parse.nodes.map(node => node.line), [1, 2, 3, 4, 5]);
  assert.deepEqual(keys(parse.errors), []);
  assert.deepEqual(keys(parse.warnings), ['ui.outline_warning_duplicate_title:4']);
});

test('outline: preprocessing — CRLF, CR, BOM and front matter', () => {
  assert.deepEqual(titles(api.parseOutline('﻿# A\r\n## B\r## C')), ['>A@-', '>>B@0', '>>C@0']);
  const fm = api.parseOutline('---\ntitle: x\n# comment\n---\n# Real');
  assert.deepEqual(titles(fm), ['>Real@-']);
});

test('outline: lines that are not headings', () => {
  const text = [
    '# Root',
    '```js', '# in fence', '```',
    '~~~', '## tilde fence', '~~~',
    '<!--', '# in comment', '-->',
    '%%', '# in obsidian comment', '%%',
    '$$', '# in math', '$$',
    '    # indented code',
    '> ## quote', '- # list', '1. # ordered',
    'Setext', '===',
    '#tag', '#x',
    '## Child'
  ].join('\n');
  const parse = api.parseOutline(text);
  assert.deepEqual(titles(parse), ['>Root@-', '>>Child@0']);
});

test('outline: a fence closes only with the same character, enough length and no info string', () => {
  assert.deepEqual(titles(api.parseOutline('# R\n```\n# a\n~~~\n# b\n```\n## C')), ['>R@-', '>>C@0']);
  assert.deepEqual(titles(api.parseOutline('# R\n```js\n# a\n```js\n# b\n```\n## C')), ['>R@-', '>>C@0']);
  assert.deepEqual(titles(api.parseOutline('# R\n```\n## never closed')), ['>R@-']);
});

test('outline: the whole outline wrapped in a ```markdown fence is unwrapped', () => {
  assert.deepEqual(titles(api.parseOutline('```markdown\n# R\n## A\n```')), ['>R@-', '>>A@0']);
  assert.deepEqual(titles(api.parseOutline('Here is the outline:\n\n```md\n# R\n## A\n```\nHope it helps.')), ['>R@-', '>>A@0']);
});

test('outline: heading text', () => {
  assert.deepEqual(api.parseOutline('#\tTabbed').nodes[0].title, 'Tabbed');
  assert.equal(api.parseOutline('# Title ##').nodes[0].title, 'Title');
  assert.equal(api.parseOutline('# C#').nodes[0].title, 'C#');
  assert.equal(api.parseOutline('# Foo \\#').nodes[0].title, 'Foo #');
  assert.equal(api.outlineTitle('**Bold** and `code` and [[Note|Alias]] and [[Plain]] and [text](https://x.y)'), 'Bold and code and Alias and Plain and text');
  assert.equal(api.outlineTitle('snake_case_name and *em* and _em_'), 'snake_case_name and em and em');
  assert.equal(api.outlineTitle('\\*literal\\*'), '*literal*');
  assert.deepEqual(keys(api.parseOutline('# ##').errors), ['ui.outline_error_empty_title:1']);
  assert.deepEqual(keys(api.parseOutline('# R\n#').errors), ['ui.outline_error_empty_title:2']);
  assert.deepEqual(keys(api.parseOutline(`# ${'x'.repeat(201)}`).errors), ['ui.outline_error_title_too_long:1']);
  assert.deepEqual(keys(api.parseOutline(`# ${'字'.repeat(200)}`).errors), []);
});

test('outline: structure errors and warnings', () => {
  assert.deepEqual(keys(api.parseOutline('just text').errors), ['ui.outline_error_no_headings:0']);
  assert.deepEqual(keys(api.parseOutline('# A\n# B').errors), ['ui.outline_error_multiple_roots:2']);
  assert.deepEqual(keys(api.parseOutline('## A\n# B').errors), ['ui.outline_error_multiple_roots:2']);
  assert.deepEqual(titles(api.parseOutline('## A\n### B')), ['>>A@-', '>>>B@0']);
  const skipped = api.parseOutline('# A\n## B\n#### D');
  assert.deepEqual(titles(skipped), ['>A@-', '>>B@0', '>>>>D@1']);
  assert.deepEqual(keys(skipped.warnings), ['ui.outline_warning_skipped_level:3']);
  assert.deepEqual(keys(api.parseOutline('# R\n## A/B\n## A:B').warnings), ['ui.outline_warning_filename_collision:3']);
  assert.deepEqual(keys(api.parseOutline('<!-- visual-agent-map:detail:start -->\n# R').errors), ['ui.outline_error_vam_note:1']);
});

test('outline: same-name headings keep their own children', () => {
  const parse = api.parseOutline('# R\n## Food\n### A\n## Food\n### B');
  assert.deepEqual(parse.nodes.map(node => [node.title, node.parent]), [['R', null], ['Food', 0], ['A', 1], ['Food', 0], ['B', 3]]);
});

test('outline: node limit includes the root', () => {
  const lines = n => ['# R', ...Array.from({ length: n - 1 }, (_, i) => `## T${i}`)].join('\n');
  assert.deepEqual(keys(api.parseOutline(lines(100)).errors), []);
  assert.deepEqual(keys(api.parseOutline(lines(101)).errors), ['ui.outline_error_too_many_nodes:0']);
});

test('outline: every line is accounted for exactly once; text around headings is counted, not lost', () => {
  const text = 'Intro sentence\n\n# R\nSome text\n\n## A\n```\ncode\n```\n- item';
  const parse = api.parseOutline(text);
  assert.equal(parse.headingLines + parse.ignoredLines + parse.blankLines + parse.skippedLines, parse.totalLines);
  assert.equal(parse.ignoredLines, 3);
  assert.deepEqual(keys(parse.warnings), ['ui.outline_warning_ignored_lines:0']);
});

test('outline: a 5,000-line note parses quickly', () => {
  const big = ['# R', ...Array.from({ length: 4999 }, (_, i) => (i % 50 === 0 ? `## H${i}` : `text ${i}`))].join('\n');
  const started = Date.now();
  const parse = api.parseOutline(big);
  assert.ok(Date.now() - started < 200);
  assert.equal(parse.nodes.length, 101);
});

test('outline: every Markdown file in the repository parses without throwing and accounts for every line', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const root = path.join(__dirname, '..', '..'); const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.md')) files.push(full); } };
  walk(root);
  assert.ok(files.length > 20);
  for (const file of files) {
    const parse = api.parseOutline(fs.readFileSync(file, 'utf8'));
    assert.equal(parse.headingLines + parse.ignoredLines + parse.blankLines + parse.skippedLines, parse.totalLines, file);
  }
});

test('outline: only a markdown/md fence or a leading bare fence is unwrapped; other fenced blocks stay code', () => {
  const bash = api.parseOutline('```\n# just a bash comment\necho hi\n```');
  assert.equal(bash.nodes.length, 0);
  assert.deepEqual(keys(bash.errors), ['ui.outline_error_no_headings:0']);
  assert.equal(api.parseOutline('Intro\n```bash\n# comment\n```').nodes.length, 0);
  assert.equal(api.parseOutline('Intro\n```\n# comment\n```').nodes.length, 0);
  assert.deepEqual(titles(api.parseOutline('```js\ncode\n```\n```md\n# R\n## A\n```')), ['>R@-', '>>A@0']);
  assert.deepEqual(titles(api.parseOutline('\n```\n# R\n## A\n```')), ['>R@-', '>>A@0']);
  assert.deepEqual(api.parseOutline('Intro\n```md\n# R\n## A\n```').nodes.map(node => node.line), [3, 4]);
});

integrationTest('createOutlineMap: one map, notes in outline order, parents by index, Map.md saved once', async () => {
  const { repo } = fixture('en');
  const parse = api.parseOutline('# Trip\n## Food\n### A\n## Food\n### B');
  let saves = 0; const save = repo.saveMap.bind(repo); repo.saveMap = async (...args) => { saves++; return save(...args); };
  const result = await api.createOutlineMap(repo, 'gpt-6-luna', parse.nodes, 'Inbox/outline.md', new Date('2026-10-13T09:00:00+08:00'));
  assert.equal(result.created, 5); assert.equal(result.total, 5); assert.equal(result.failure, undefined); assert.equal(saves, 1);
  const map = await repo.readMap(result.mapPath);
  assert.equal(map.title, 'Trip'); assert.equal(map.nodes.length, 5);
  const notes = await Promise.all(map.nodes.map(node => repo.readNote(node.path)));
  assert.deepEqual(notes.map(note => note.title), ['Trip', 'Food', 'A', 'Food', 'B']);
  const byId = new Map(map.nodes.map((node, i) => [node.id, notes[i].title]));
  assert.deepEqual(plain(map.nodes.map(node => byId.get(node.parentId) ?? null)), [null, 'Trip', 'Food', 'Trip', 'Food']);
  assert.equal(map.nodes[2].parentId, map.nodes[1].id); assert.equal(map.nodes[4].parentId, map.nodes[3].id);
  assert.notEqual(map.nodes[1].path, map.nodes[3].path);
  assert.match(notes[0].detail, /Imported from an outline \(2026-10-13\): \[\[Inbox\/outline\.md\]\]/);
  assert.equal(notes[1].detail.includes('Imported from an outline'), false);
  assert.ok(notes.every(note => note.status === 'idea' && note.prompt === ''));
  assert.ok(map.nodes.some(node => node.x !== 80 || node.y !== 80), 'arranged');
});

integrationTest('createOutlineMap: pasted text records the import without a source link', async () => {
  const { repo } = fixture('zh-TW');
  const result = await api.createOutlineMap(repo, 'gpt-6-luna', api.parseOutline('# 主題').nodes, null, new Date('2026-10-13T09:00:00+08:00'));
  const note = await repo.readNote((await repo.readMap(result.mapPath)).nodes[0].path);
  assert.match(note.detail, /從大綱匯入（2026-10-13）。/);
});

integrationTest('createOutlineMap: stops at the first failure and keeps every created note in the map', async () => {
  const { repo, app } = fixture('en');
  const create = repo.createNote.bind(repo); let calls = 0;
  repo.createNote = async (...args) => { calls++; if (calls === 3) throw new Error('disk full'); return create(...args); };
  const result = await api.createOutlineMap(repo, 'gpt-6-luna', api.parseOutline('# R\n## A\n## B\n## C').nodes, null);
  assert.equal(result.created, 2); assert.equal(result.total, 4); assert.equal(result.failure, 'disk full');
  const map = await repo.readMap(result.mapPath);
  assert.equal(map.nodes.length, 2);
  const notesFolder = result.mapPath.replace(/Map\.md$/, 'Notes/');
  const files = app.vault.getMarkdownFiles().filter(file => file.path.startsWith(notesFolder));
  assert.equal(files.length, 2, 'no orphan notes');
  assert.deepEqual(plain(files.map(file => file.path).sort()), plain(map.nodes.map(node => node.path).sort()));
});

integrationTest('createOutlineMap: does not touch the source note or other maps', async () => {
  const { repo, app } = fixture('en');
  const source = await app.vault.create('Inbox/outline.md', '# R\n## A');
  const before = await app.vault.read(source);
  const mapsBefore = (await repo.mapFiles()).map(file => file.path);
  const result = await api.createOutlineMap(repo, 'gpt-6-luna', api.parseOutline(before).nodes, 'Inbox/outline.md');
  assert.equal(await app.vault.read(source), before);
  assert.deepEqual(plain((await repo.mapFiles()).map(file => file.path).sort()), plain([...mapsBefore, result.mapPath].sort()));
});

function modalHarness(clipboardFails = false) {
  const element = (tag, options = {}) => ({
    tag, text: options.text ?? '', cls: options.cls ?? '', type: options.type, value: options.value ?? '', checked: false, disabled: false, hidden: false, children: [], listeners: {},
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value = {}) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value = {}) { const child = element('span', value); this.children.push(child); return child; },
    setText(value) { this.text = value; }, empty() { this.children = []; }, replaceChildren() { this.children = []; }, toggleClass(name, on) { this.toggled = { ...(this.toggled ?? {}), [name]: on }; }, setAttr(name, value) { this[name] = value; },
    addEventListener(name, handler) { this.listeners[name] = handler; }, addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass() {}
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  // As in Obsidian, the content sits inside modalEl; the action bar is modalEl's last child.
  class Modal { constructor(app) { this.app = app; this.titleEl = element('title'); this.contentEl = element('content'); this.modalEl = element('modal'); this.modalEl.children.push(this.contentEl); this.closed = false; } open() { this.onOpen(); } close() { this.closed = true; } }
  class FuzzySuggestModal { constructor(app) { this.app = app; } setPlaceholder(text) { this.placeholder = text; } open() { this.opened = true; } }
  const notices = []; const copied = [];
  const mod = load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal, FuzzySuggestModal, Notice: class { constructor(m) { notices.push(m); } } } }, { navigator: { clipboard: { writeText: async text => { if (clipboardFails) throw new Error('denied'); copied.push(text); } } } });
  return { mod, find, all, notices, copied };
}

test('outline modal: preview, errors block creation, shallow option and single submit', async () => {
  const h = modalHarness(); const requests = []; let release;
  const modal = new h.mod.OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, request => { requests.push(request); return new Promise(resolve => { release = resolve; }); });
  modal.open();
  const textarea = h.find(modal.contentEl, item => item.tag === 'textarea');
  const create = h.find(modal.modalEl, item => item.tag === 'button' && item.text === 'Add to mind map');
  assert.equal(create.disabled, true);
  textarea.value = '# A\n# B'; textarea.listeners.input();
  assert.equal(create.disabled, true);
  assert.ok(h.find(modal.contentEl, item => /only one top-level heading/.test(item.text)));
  textarea.value = '# Trip\n## Food\n### Breakfast'; textarea.listeners.input();
  assert.equal(create.disabled, false);
  assert.ok(h.find(modal.contentEl, item => item.text === '3 topics, 3 levels'));
  h.find(modal.contentEl, item => item.tag === 'input' && item.type === 'checkbox').checked = true;
  create.listeners.click(); create.listeners.click();
  assert.equal(requests.length, 1); assert.equal(create.disabled, true);
  assert.deepEqual(plain(requests[0].nodes.map(node => node.title)), ['Trip', 'Food', 'Breakfast']);
  assert.equal(requests[0].source, null); assert.equal(requests[0].shallowResearch, true);
  assert.equal(requests[0].researchDepth, 'fast'); assert.equal(requests[0].model, undefined);
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(modal.closed, true);
});

test('outline modal: research depth and model show only with shallow research and are sent with the request', async () => {
  const h = modalHarness(); const requests = []; let changed = null, unwatched = 0; let models = [];
  const choices = { list: () => models, watch: fn => { changed = fn; return () => { unwatched++; }; } };
  const modal = new h.mod.OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async request => { requests.push(request); }, choices);
  modal.open();
  const options = h.find(modal.contentEl, item => /vam-outline-research-options/.test(item.cls));
  const shallow = h.find(modal.contentEl, item => item.tag === 'input' && item.type === 'checkbox');
  assert.equal(options.toggled['is-hidden'], true);
  shallow.checked = true; shallow.listeners.change(); assert.equal(options.toggled['is-hidden'], false);
  // The shared depth widget: Quick / Standard / Deep radios, Quick checked here (shallow research is deliberately a first look).
  const depthRadios = h.all(modal.contentEl, item => item.tag === 'input' && item.type === 'radio' && ['fast', 'normal', 'deep'].includes(item.value));
  assert.equal(depthRadios.length, 3);
  const model = () => h.find(modal.contentEl, item => item.tag === 'select' && item['aria-label'] === 'Model');
  assert.deepEqual(depthRadios.map(radio => radio.checked), [true, false, false]); assert.deepEqual(plain(model().children.map(c => c.value)), ['']);
  models = [{ id: 'm1', label: 'Model One' }]; changed();
  assert.deepEqual(plain(model().children.map(c => c.value)), ['', 'm1']);
  depthRadios[2].checked = true; depthRadios[2].listeners.change(); model().value = 'm1';
  const textarea = h.find(modal.contentEl, item => item.tag === 'textarea'); textarea.value = '# R\n## A'; textarea.listeners.input();
  h.find(modal.modalEl, item => item.tag === 'button' && item.text === 'Add to mind map').listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests[0].researchDepth, 'deep'); assert.equal(requests[0].model, 'm1');
  modal.onClose(); assert.equal(unwatched, 1);
});

test('outline modal: the content template select sits in the research options and is sent only with shallow research', async () => {
  const h = modalHarness(); const requests = [];
  const templates = [{ id: 'standard', name: 'Standard' }, { id: 't1', name: 'Template one' }];
  const submit = async (shallowOn, picked) => {
    const modal = new h.mod.OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async request => { requests.push(request); }, undefined, templates);
    modal.open();
    const options = h.find(modal.contentEl, item => /vam-outline-research-options/.test(item.cls));
    const select = h.find(options, item => item.tag === 'select' && item['aria-label'] === 'Content template');
    assert.ok(select, 'inside the research options');
    assert.deepEqual(plain(select.children.map(c => [c.value, c.text])), [['', 'Use the workspace default'], ['standard', 'Standard'], ['t1', 'Template one']]);
    const textarea = h.find(modal.contentEl, item => item.tag === 'textarea'); textarea.value = '# R\n## A'; textarea.listeners.input();
    const style = h.find(options, item => item.tag === 'select' && item['aria-label'] === 'Note style');
    if (picked) { style.value = 'custom'; style.listeners.change(); }
    select.value = picked;
    const shallow = h.find(modal.contentEl, item => item.tag === 'input' && item.type === 'checkbox'); shallow.checked = shallowOn; shallow.listeners.change();
    h.find(modal.modalEl, item => item.tag === 'button' && item.text === 'Add to mind map').listeners.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    return requests.at(-1);
  };
  assert.equal('detailTemplateId' in await submit(false, 't1'), false, 'ignored while shallow research is off');
  assert.equal((await submit(true, 't1')).detailTemplateId, 't1');
  assert.equal('detailTemplateId' in await submit(true, ''), false);
});

// C2 (owner decision): the vault file picker is removed; an outline is pasted or generated with AI.
test('outline modal: copy format instructions; there is no vault file picker and the source is always pasted text', async () => {
  const h = modalHarness(); const requests = [];
  const modal = new h.mod.OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async request => { requests.push(request); });
  modal.open();
  h.find(modal.contentEl, item => item.tag === 'button' && item.text === 'Copy format instructions').listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(h.copied[0], /exactly one # heading/);
  assert.equal(h.mod.OutlineFileModal, undefined);
  assert.equal(modal.loadFile, undefined);
  assert.equal(h.find(modal.modalEl, item => /vault/i.test(item.text ?? '')), undefined, 'no vault picker or vault hint');
  const textarea = h.find(modal.contentEl, item => item.tag === 'textarea'); textarea.value = '# From paste\n## Child'; textarea.listeners.input();
  h.find(modal.modalEl, item => item.tag === 'button' && item.text === 'Add to mind map').listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests[0].source, null);
});

integrationTest('importOutline creates the map, opens it, and starts shallow research only when asked', async () => {
  const { repo, app } = fixture('en');
  const opened = [], researched = [], notices = [];
  const plugin = { repo, settings: { ...require('../support.cjs').DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (_model, run) => { await run(); return true; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(m) { notices.push(m); } } } });
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.fit = () => {};
  view.enqueue = work => work();
  view.openMapInMutation = async path => { opened.push(path); view.path = path; view.map = await repo.readMap(path); };
  view.startShallowResearch = async (parent, children, options) => { researched.push({ parent: parent.id, children: children.length, options }); };
  const nodes = api.parseOutline('# R\n## A\n### B').nodes;
  await view.importOutline({ nodes, source: null, shallowResearch: false });
  assert.equal(opened.length, 1); assert.equal(researched.length, 0);
  await view.importOutline({ nodes, source: null, shallowResearch: true });
  assert.equal(opened.length, 2); assert.equal(researched.length, 1);
  assert.equal(researched[0].children, 2);
  assert.equal(researched[0].options.researchMode, 'research'); assert.equal(researched[0].options.researchDepth, 'fast');
  const confirms = []; plugin.confirmAiUsage = async (model, run) => { confirms.push(model); await run(); return true; };
  await view.importOutline({ nodes, source: null, shallowResearch: true, researchDepth: 'normal', model: 'model-x' });
  assert.deepEqual(confirms, ['model-x']); assert.equal(researched[1].options.researchDepth, 'normal');
  const map = await repo.readMap(opened[2]);
  for (const node of map.nodes) assert.equal((await repo.readNote(node.path)).model, 'model-x');
});

integrationTest('importOutline writes Reference Links (parent, children, map) into every new note', async () => {
  const { repo, app } = fixture('en');
  const plugin = { repo, settings: { ...require('../support.cjs').DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (_m, run) => { await run(); return true; } };
  plugin.rebuildDerivedData = () => repo.rebuildDerivedData();
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class {} } });
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.fit = () => {}; view.enqueue = work => work();
  let mapPath; view.openMapInMutation = async path => { mapPath = path; };
  await view.importOutline({ nodes: api.parseOutline('# R\n## A\n### B').nodes, source: null, shallowResearch: false });
  const map = await repo.readMap(mapPath);
  const byTitle = new Map(); for (const node of map.nodes) byTitle.set((await repo.readNote(node.path)).title, node);
  const a = await app.vault.read(app.vault.getAbstractFileByPath(byTitle.get('A').path));
  assert.match(a, /## Reference Links/);
  assert.ok(a.includes(`Parent topic: [[${byTitle.get('R').path.replace(/\.md$/, '')}]]`), a);
  assert.ok(a.includes(`Child topics: [[${byTitle.get('B').path.replace(/\.md$/, '')}]]`), a);
});

integrationTest('importOutline reports a partial creation and does not start research', async () => {
  const { repo, app } = fixture('en');
  const notices = [], researched = [];
  const create = repo.createNote.bind(repo); let calls = 0;
  repo.createNote = async (...args) => { calls++; if (calls === 2) throw new Error('disk full'); return create(...args); };
  const plugin = { repo, settings: { ...require('../support.cjs').DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (_m, run) => { await run(); return true; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(m) { notices.push(m); } } } });
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.fit = () => {}; view.enqueue = work => work();
  view.openMapInMutation = async () => {}; view.startShallowResearch = async () => { researched.push(1); };
  await view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: true });
  assert.deepEqual(notices, ['Created 1 of 2 topics: disk full']); assert.equal(researched.length, 0);
});

integrationTest('importOutline still saves the map when the view switched away during creation', async () => {
  const { repo, app } = fixture('en');
  const plugin = { repo, settings: { ...require('../support.cjs').DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async () => true };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.fit = () => {}; view.enqueue = work => work();
  let mapPath; view.openMapInMutation = async path => { mapPath = path; view.closed = true; };
  await view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: false });
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
});

test('outline: code spans keep their text; __x__ needs word boundaries; placeholders cannot collide', () => {
  assert.equal(api.outlineTitle('`__init__` method'), '__init__ method');
  assert.equal(api.outlineTitle('`a*b*c` usage'), 'a*b*c usage');
  assert.equal(api.outlineTitle('Use `[x](y)` syntax'), 'Use [x](y) syntax');
  assert.equal(api.outlineTitle('`[[Note|Alias]]` link'), '[[Note|Alias]] link');
  assert.equal(api.outlineTitle('init__main__x'), 'init__main__x');
  assert.equal(api.outlineTitle('__bold__ word'), 'bold word');
  assert.equal(api.outlineTitle('\uE0000\uE000'), '\uE0000\uE000');
  assert.equal(api.outlineTitle('\\* \uE0000\uE000 `x`'), '* \uE0000\uE000 x');
  assert.equal(api.outlineTitle('\\`a` b'), '`a` b');
});

test('outline: a note with VAM front matter keys is refused', async () => {
  const { core } = require('../support.cjs');
  const mapText = core.serializeMap({ id: 'm1', title: 'Some map', nodes: [] }, 'en');
  assert.deepEqual(keys(api.parseOutline(mapText).errors), ['ui.outline_error_vam_note:1']);
  const note = '---\nagent-map-node: true\nnode-id: n1\n---\n# Heading\n## Child';
  assert.deepEqual(keys(api.parseOutline(note).errors), ['ui.outline_error_vam_note:1']);
  assert.deepEqual(keys(api.parseOutline('---\ntitle: x\n---\n# Heading').errors), []);
});

test('outline: a <!-- inside a code span does not open a comment or drop later headings', () => {
  const parse = api.parseOutline('# R\n## Escape `<!--` in HTML\n## Next\n## Last');
  assert.deepEqual(titles(parse), ['>R@-', '>>Escape <!-- in HTML@0', '>>Next@0', '>>Last@0']);
  assert.deepEqual(keys(parse.errors), []);
});

integrationTest('createOutlineMap: a readMap failure right after createMap marks the map as created', async () => {
  const { repo } = fixture('en');
  repo.readMap = async () => { throw new Error('unreadable'); };
  await assert.rejects(api.createOutlineMap(repo, 'gpt-6-luna', api.parseOutline('# R').nodes, null), error => error.message === 'unreadable' && error.mapCreated === true);
});

integrationTest('createOutlineMap: a Map.md save failure throws with the note paths and marks the map as created', async () => {
  const { repo } = fixture('en');
  repo.saveMap = async () => { throw new Error('locked'); };
  await assert.rejects(api.createOutlineMap(repo, 'gpt-6-luna', api.parseOutline('# R\n## A').nodes, null), error => {
    assert.match(error.message, /could not be saved: locked \(.*R\.md, .*A\.md\)/);
    assert.equal(error.mapCreated, true);
    return true;
  });
});

function importHarness(overrides = {}) {
  const { repo, app } = fixture('en');
  const notices = [], calls = { opened: 0, researched: 0 };
  const NoticeClass = class { constructor(m) { notices.push(m); } };
  const plugin = { repo, settings: { ...require('../support.cjs').DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (_m, run) => { await run(); return true; }, ...overrides };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: NoticeClass } });
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.fit = () => {}; view.enqueue = work => work();
  view.openMapInMutation = async () => { calls.opened++; };
  view.startShallowResearch = async () => { calls.researched++; };
  return { repo, view, notices, calls, plugin };
}

integrationTest('importOutline: an open failure still completes (one Notice from mutate), creates once and skips research', async () => {
  const notices = [];
  const h = importHarness({ mutate: async () => { notices.push('mutate notice'); throw new Error('cannot open'); } });
  const create = h.repo.createMap.bind(h.repo); let creates = 0; h.repo.createMap = async (...args) => { creates++; return create(...args); };
  await h.view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: true });
  assert.equal(creates, 1); assert.deepEqual(notices, ['mutate notice']); assert.deepEqual(h.notices, []); assert.equal(h.calls.researched, 0);
});

integrationTest('importOutline: a shallow-research start failure only shows a Notice, and the import no longer waits for the research', async () => {
  // Owner decision 2026-10-19: the import window closes once the topics exist; the research runs in the background.
  const h = importHarness();
  h.view.startShallowResearch = async () => { throw new Error('no cli'); };
  await h.view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: true });
  await until(() => h.notices.length === 1);
  assert.deepEqual(h.notices, ['no cli']);
  const g = importHarness({ confirmAiUsage: async () => { throw new Error('confirm broke'); } });
  await g.view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: true });
  await until(() => g.notices.length === 1);
  assert.deepEqual(g.notices, ['confirm broke']);
  // A research batch that runs for a long time does not hold the import (and so its window) open.
  let finishResearch; const slow = importHarness();
  slow.view.startShallowResearch = () => new Promise(resolve => { finishResearch = resolve; });
  let imported = false;
  await slow.view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: true }).then(() => { imported = true; });
  assert.equal(imported, true, 'importOutline resolved while the research is still running');
  finishResearch();
});

integrationTest('importOutline: a Map.md save failure becomes a Notice with the paths instead of a rejection', async () => {
  const h = importHarness();
  h.repo.saveMap = async () => { throw new Error('locked'); };
  await h.view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: false });
  assert.equal(h.notices.length, 1); assert.match(h.notices[0], /could not be saved: locked/);
  assert.equal(h.calls.opened, 0);
});

integrationTest('importOutline: a failure before anything is created still rejects so the window stays open', async () => {
  const h = importHarness();
  h.repo.createMap = async () => { throw new Error('no folder'); };
  await assert.rejects(h.view.importOutline({ nodes: api.parseOutline('# R').nodes, source: null, shallowResearch: false }), /no folder/);
});

test('outline modal: a clipboard failure shows a Notice', async () => {
  const h = modalHarness(true);
  const modal = new h.mod.OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async () => {});
  modal.open();
  h.find(modal.contentEl, item => item.tag === 'button' && item.text === 'Copy format instructions').listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.notices, ['Could not copy the format instructions to the clipboard.']);
});

integrationTest('createOutlineMap writes the import line into the template log section, or the first section without one', async () => {
  const section = (id, name, role = 'none') => ({ id, name, description: '', role, aliases: [] });
  const when = new Date('2026-10-13T09:00:00+08:00');
  {
    const { repo } = fixture('en');
    const template = { id: 't1', name: 'T', sections: [section('a', '重點'), section('log', '紀錄', 'log')] };
    const result = await api.createOutlineMap(repo, 'gpt-6-luna', api.parseOutline('# R').nodes, null, when, template);
    const detail = (await repo.readNote((await repo.readMap(result.mapPath)).nodes[0].path)).detail;
    assert.match(detail, /### 紀錄\n\n- Imported from an outline \(2026-10-13\)/);
    assert.match(detail, /^### 重點\n\nNo new information in this task\.\n\n### 紀錄/);
  }
  {
    const { repo } = fixture('en');
    const template = { id: 't2', name: 'T', sections: [section('a', '重點'), section('b', '其他')] };
    const result = await api.createOutlineMap(repo, 'gpt-6-luna', api.parseOutline('# R').nodes, null, when, template);
    const detail = (await repo.readNote((await repo.readMap(result.mapPath)).nodes[0].path)).detail;
    assert.match(detail, /^### 重點\n\n- Imported from an outline \(2026-10-13\)/);
    assert.doesNotMatch(detail, /### Update log/);
  }
});

integrationTest('importOutline: the chosen template becomes the map default and holds the root log line', async () => {
  const { repo, app } = fixture('en');
  const template = { id: 't1', name: 'Template one', sections: [
    { id: 's1', name: 'Findings', description: '', role: 'none', aliases: [] },
    { id: 's2', name: 'History', description: '', role: 'log', aliases: [] }] };
  const plugin = { repo, settings: { ...require('../support.cjs').DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', detailTemplates: [template] }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (_m, run) => { await run(); return true; } };
  repo.settings = plugin.settings;
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class {} } });
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.fit = () => {}; view.enqueue = work => work();
  const paths = []; view.openMapInMutation = async path => { paths.push(path); };
  view.startShallowResearch = async () => {};
  const nodes = api.parseOutline('# R\n## A').nodes;
  await view.importOutline({ nodes, source: null, shallowResearch: true, detailTemplateId: 't1' });
  const map = await repo.readMap(paths[0]);
  assert.equal(map.detailTemplateId, 't1');
  const root = map.nodes.find(node => node.parentId === null);
  assert.match((await repo.readNote(root.path)).detail, /### History\n\n- /);
  assert.equal((await repo.readNote(root.path)).detailTemplateId, undefined, 'a map default, not a per-topic field');
  await view.importOutline({ nodes, source: null, shallowResearch: false });
  assert.equal((await repo.readMap(paths[1])).detailTemplateId, undefined);
});

// ---- Placement: a new map, this map as a new tree, or under the selected topic ----

function placementModal(target) {
  const h = modalHarness(); const requests = [];
  const modal = new h.mod.OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async request => { requests.push(request); }, undefined, [], target);
  modal.open();
  const radios = h.all(modal.contentEl, item => item.tag === 'input' && item.type === 'radio' && ['new', 'tree', 'under'].includes(item.value));
  const label = value => h.find(modal.contentEl, item => item.tag === 'label' && item.children.some(child => child === radios.find(radio => radio.value === value)));
  const text = value => h.find(label(value), item => item.tag === 'span').text;
  const submit = async () => {
    const textarea = h.find(modal.contentEl, item => item.tag === 'textarea'); textarea.value = '# R\n## A'; textarea.listeners.input();
    h.find(modal.modalEl, item => item.tag === 'button' && item.text === 'Add to mind map').listeners.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    return requests.at(-1);
  };
  const choose = value => { const radio = radios.find(item => item.value === value); radio.checked = true; radio.listeners.change(); };
  const hints = () => h.all(modal.contentEl, item => /vam-outline-placement-reason/.test(item.cls)).map(item => item.text);
  return { h, modal, radios, text, submit, choose, hints };
}

test('outline modal: "Put it in" offers only places in the open map, a new tree by default, before the shallow option', async () => {
  const m = placementModal({ map: 'editable' });
  assert.ok(m.h.find(m.modal.contentEl, item => item.text === 'Put it in'));
  assert.deepEqual(plain(m.radios.map(radio => [radio.value, radio.checked])), [['tree', true], ['under', false]], 'no new-map option');
  assert.equal(m.text('tree'), 'This mind map, as a new tree'); assert.equal(m.text('under'), 'Under the selected topic');
  const order = []; const walk = item => { order.push(item); item.children.forEach(walk); }; walk(m.modal.contentEl);
  assert.ok(order.indexOf(m.radios[0]) < order.findIndex(item => item.tag === 'input' && item.type === 'checkbox'), 'before the shallow-research checkbox');
  assert.deepEqual(plain((await m.submit()).placement), { kind: 'tree' });
  const none = placementModal();
  assert.deepEqual(plain(none.radios.map(radio => radio.disabled)), [true, true]);
  assert.deepEqual(none.hints(), ['No editable mind map is open.', 'No editable mind map is open.']);
});

test('outline modal: an AIM map disables both in-map places with its own reason', () => {
  const m = placementModal({ map: 'aim', selected: { id: 'n1', title: 'Q' } });
  assert.deepEqual(plain(m.radios.map(radio => radio.disabled)), [true, true]);
  assert.deepEqual(m.hints(), ["AIM maps don't support imports.", "AIM maps don't support imports."]);
});

test('outline modal: an editable map allows a new tree; under needs a selected topic', async () => {
  const m = placementModal({ map: 'editable' });
  assert.deepEqual(plain(m.radios.map(radio => radio.disabled)), [false, true]);
  assert.deepEqual(m.hints(), ['Select a topic on the map first.']);
  m.choose('tree');
  assert.deepEqual(plain((await m.submit()).placement), { kind: 'tree' });
});

test('outline modal: under the selected topic shows its title and sends its id', async () => {
  const m = placementModal({ map: 'editable', selected: { id: 'n1', title: 'Food' } });
  assert.deepEqual(plain(m.radios.map(radio => radio.disabled)), [false, false]);
  assert.equal(m.text('under'), 'Under the selected topic (Food)');
  assert.deepEqual(m.hints(), []);
  m.choose('under');
  assert.deepEqual(plain((await m.submit()).placement), { kind: 'under', parentId: 'n1' });
});

test('outline modal: placement labels in Traditional Chinese', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.outline_import_placement'), '放到哪裡');
  assert.equal(translate('zh-TW', 'ui.outline_import_add'), '加入心智圖');
  assert.equal(translate('zh-TW', 'ui.outline_import_placement_tree'), '目前心智圖（新增一棵樹）');
  assert.equal(translate('zh-TW', 'ui.outline_import_placement_under'), '選取的議題底下');
  assert.equal(translate('zh-TW', 'ui.outline_import_placement_under_named', 'X'), '選取的議題底下（X）');
  assert.equal(translate('zh-TW', 'ui.outline_import_placement_no_map'), '目前沒有開啟可加入的心智圖。');
  assert.equal(translate('zh-TW', 'ui.outline_import_placement_aim'), 'AIM 心智圖不支援匯入。');
  assert.equal(translate('zh-TW', 'ui.outline_import_placement_no_selection'), '先在心智圖上選一個議題。');
  assert.equal(translate('zh-TW', 'ui.outline_import_selected_missing'), '選取的議題已不在心智圖上。');
});

async function placementHarness(settingsOverrides = {}, obsidianOverrides = {}, globals = {}) {
  const { repo, app } = fixture('en');
  const { core, DEFAULT_SETTINGS, withExpansionCoordinator } = require('../support.cjs');
  const notices = [], researched = [], confirms = [];
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', ...settingsOverrides };
  repo.settings = settings;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'Existing', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const oldRoot = await repo.createNote('Old root', 'parent-model', mapDoc, mapPath, 'manual');
  const oldChild = await repo.createNote('Old child', 'parent-model', mapDoc, mapPath, 'inherited');
  Object.assign(oldRoot, { x: 80, y: 80 }); Object.assign(oldChild, { parentId: oldRoot.id, x: 440, y: 80 });
  mapDoc.nodes.push(oldRoot, oldChild);
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const plugin = withExpansionCoordinator({ repo, settings, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, rebuildDerivedData: () => repo.rebuildDerivedData(), mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (model, run) => { confirms.push(model); await run(); return true; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(m) { notices.push(m); } }, ...obsidianOverrides } }, globals);
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.startShallowResearch = async (parent, children, options) => { researched.push({ parent: parent.id, children: children.map(child => child.id), options }); };
  const titleOf = async id => (await repo.readNote((await repo.readMap(mapPath)).nodes.find(item => item.id === id).path)).title;
  const notesInFolder = () => app.vault.getMarkdownFiles().filter(file => file.path.startsWith('Agent Workspace/Topics/map-a/Notes/')).map(file => file.path).sort();
  return { repo, app, view, plugin, notices, researched, confirms, mapPath, oldRoot, oldChild, titleOf, notesInFolder };
}

const overlaps = (a, b) => Math.abs(a.x - b.x) < 300 && Math.abs(a.y - b.y) < 190;

integrationTest('importOutline as a new tree: a new top-level topic in the open map, existing nodes stay put, undo restores', async () => {
  const h = await placementHarness();
  const before = plain((await h.repo.readMap(h.mapPath)).nodes);
  await h.view.importOutline({ nodes: api.parseOutline('# New\n## A\n### A1\n## B').nodes, source: 'Inbox/o.md', shallowResearch: false, placement: { kind: 'tree' } });
  const saved = await h.repo.readMap(h.mapPath);
  assert.equal(saved.nodes.length, 6);
  for (const old of before) assert.deepEqual(plain(saved.nodes.find(item => item.id === old.id)), old, 'existing node unchanged');
  const fresh = saved.nodes.filter(item => !before.some(old => old.id === item.id));
  const top = fresh.find(item => item.parentId === null);
  assert.ok(top); assert.equal(await h.titleOf(top.id), 'New');
  const byTitle = new Map(); for (const item of fresh) byTitle.set(await h.titleOf(item.id), item);
  assert.equal(byTitle.get('A').parentId, top.id); assert.equal(byTitle.get('A1').parentId, byTitle.get('A').id); assert.equal(byTitle.get('B').parentId, top.id);
  for (const item of fresh) for (const old of before) assert.ok(!overlaps(item, old), 'no overlap');
  assert.deepEqual(plain(h.view.map.nodes.map(item => item.id)), plain(saved.nodes.map(item => item.id)), 'the open view holds the written map');
  assert.equal(h.view.selected, top.id);
  const topNote = await h.repo.readNote(top.path);
  assert.match(topNote.detail, /Imported from an outline \(\d{4}-\d\d-\d\d\): \[\[Inbox\/o\.md\]\]/);
  for (const item of fresh) assert.equal((await h.repo.readNote(item.path)).model, 'gpt-6-luna', 'tree uses the workspace model');
  const a = await h.app.vault.read(h.app.vault.getAbstractFileByPath(byTitle.get('A').path));
  assert.ok(a.includes(`Parent topic: [[${top.path.replace(/\.md$/, '')}]]`), a);
  assert.ok(a.includes(`Child topics: [[${byTitle.get('A1').path.replace(/\.md$/, '')}]]`), a);
  assert.equal(saved.title, 'Existing'); assert.equal(saved.detailTemplateId, undefined);
  assert.equal(h.researched.length, 0); assert.deepEqual(h.notices, []);
  assert.equal(h.view.history.canUndo, true);
  await h.view.history.undo().undo();
  assert.deepEqual(plain((await h.repo.readMap(h.mapPath)).nodes.map(item => item.id)), plain(before.map(item => item.id)));
});

integrationTest('importOutline under the selected topic: the outline root becomes its child with the parent model and the chosen template per topic', async () => {
  const template = { id: 't1', name: 'Template one', sections: [
    { id: 's1', name: 'Findings', description: '', role: 'none', aliases: [] },
    { id: 's2', name: 'History', description: '', role: 'log', aliases: [] }] };
  const h = await placementHarness({ detailTemplates: [template] });
  const before = plain((await h.repo.readMap(h.mapPath)).nodes);
  await h.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1\n### S1a').nodes, source: null, shallowResearch: false, placement: { kind: 'under', parentId: h.oldChild.id }, detailTemplateId: 't1' });
  const saved = await h.repo.readMap(h.mapPath);
  for (const old of before) assert.deepEqual(plain(saved.nodes.find(item => item.id === old.id)), { ...old, collapsed: false });
  const fresh = saved.nodes.filter(item => !before.some(old => old.id === item.id));
  assert.equal(fresh.length, 3);
  const sub = fresh.find(item => item.parentId === h.oldChild.id);
  assert.equal(await h.titleOf(sub.id), 'Sub');
  const s1 = fresh.find(item => item.parentId === sub.id); assert.equal(await h.titleOf(s1.id), 'S1');
  const s1a = fresh.find(item => item.parentId === s1.id); assert.equal(await h.titleOf(s1a.id), 'S1a');
  for (const item of fresh) {
    const note = await h.repo.readNote(item.path);
    assert.equal(note.model, 'parent-model', 'inherits the parent topic model');
    assert.equal(note.detailTemplateId, 't1', 'template recorded on each created topic');
  }
  assert.match((await h.repo.readNote(sub.path)).detail, /### History\n\n- Imported from an outline/);
  assert.equal(saved.detailTemplateId, undefined, 'the map default is untouched');
  for (const item of fresh) for (const old of before) assert.ok(!overlaps(item, old));
  assert.equal(h.view.selected, sub.id);
});

integrationTest('importOutline under the selected topic with shallow research: researches only the outline root descendants with the chosen model', async () => {
  const h = await placementHarness();
  await h.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1\n## S2').nodes, source: null, shallowResearch: true, researchDepth: 'normal', model: 'model-x', placement: { kind: 'under', parentId: h.oldRoot.id } });
  const saved = await h.repo.readMap(h.mapPath);
  const sub = saved.nodes.find(item => item.parentId === h.oldRoot.id && item.id !== h.oldChild.id);
  assert.equal(h.researched.length, 1);
  assert.equal(h.researched[0].parent, sub.id);
  const expected = saved.nodes.filter(item => item.parentId === sub.id).map(item => item.id);
  assert.deepEqual(plain(h.researched[0].children), plain(expected));
  assert.equal(h.researched[0].options.researchDepth, 'normal'); assert.equal(h.researched[0].options.researchMode, 'research');
  assert.deepEqual(h.confirms, ['model-x']);
  for (const item of [sub, ...saved.nodes.filter(node => node.parentId === sub.id)]) assert.equal((await h.repo.readNote(item.path)).model, 'model-x');
});

integrationTest('quick explore: the real create path researches every created subtopic with the dialog research choices, at Quick depth', async () => {
  const template = { id: 't1', name: 'Template one', sections: [{ id: 's1', name: 'Findings', description: '', role: 'none', aliases: [] }] };
  const h = await placementHarness({ detailTemplates: [template] });
  // The reviewed outline as the Next Step dialog hands it over: the topic's own root is already dropped.
  const nodes = [{ index: 0, title: 'Food', level: 1, parent: null }, { index: 1, title: 'Breakfast', level: 2, parent: 0 }];
  const group = { id: 'group-1', label: 'Sources', documents: [{ path: 'Inbox/source.md', content: 'x' }] };
  const signal = new AbortController().signal;
  await h.view.quickOutline(h.oldRoot).create(nodes, {
    researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', referenceGroups: [group], outputLanguage: 'zh-TW',
    toneId: 'tone-1', requirements: 'Keep it short', detailTemplateId: 't1', shallowResearch: true, signal, onProgress: () => {}
  });
  const saved = await h.repo.readMap(h.mapPath);
  const food = saved.nodes.find(item => item.parentId === h.oldRoot.id && item.id !== h.oldChild.id);
  const breakfast = saved.nodes.find(item => item.parentId === food.id);
  assert.equal(await h.titleOf(food.id), 'Food'); assert.equal(await h.titleOf(breakfast.id), 'Breakfast');
  assert.equal(h.researched.length, 1);
  assert.equal(h.researched[0].parent, h.oldRoot.id, 'researched under the topic quick explore ran on');
  assert.deepEqual(plain(h.researched[0].children.slice().sort()), plain([food.id, breakfast.id].sort()), 'the single top heading is researched too');
  const options = h.researched[0].options;
  // S7: the dialog allowed the web (and images), but the quick pass reads local context only unless "also search the web" is on.
  assert.equal(options.researchMode, 'local'); assert.equal(options.researchDepth, 'fast', 'shallow research stays Quick');
  assert.equal(options.visualMode, 'off'); assert.equal(options.outputLanguage, 'zh-TW'); assert.equal(options.toneId, 'tone-1');
  assert.equal(options.requirements, 'Keep it short'); assert.equal(JSON.stringify(options.referenceGroups), JSON.stringify([group]));
  assert.equal(options.signal, undefined); assert.equal(options.onProgress, undefined);
  assert.equal(options.detailTemplateId, 't1');
  for (const item of [food, breakfast]) assert.equal((await h.repo.readNote(item.path)).detailTemplateId, 't1', 'the chosen template is recorded on each subtopic');
  // S7: with the checkbox on, the dialog's web and image choices reach the quick research.
  const web = await placementHarness();
  await web.view.quickOutline(web.oldRoot).create(nodes, { researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', referenceGroups: [], shallowResearch: true, shallowWebSearch: true });
  assert.equal(web.researched[0].options.researchMode, 'research'); assert.equal(web.researched[0].options.visualMode, 'auto');
  // Without shallow research nothing is researched.
  const g = await placementHarness();
  await g.view.quickOutline(g.oldRoot).create(nodes, { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', shallowResearch: false });
  assert.equal(g.researched.length, 0);
});

integrationTest('importOutline into the open map: a partial failure keeps every created note in the map and skips research', async () => {
  for (const kind of ['tree', 'under']) {
    const h = await placementHarness();
    const create = h.repo.createNote.bind(h.repo); let calls = 0;
    h.repo.createNote = async (...args) => { calls++; if (calls === 3) throw new Error('disk full'); return create(...args); };
    const placement = kind === 'tree' ? { kind } : { kind, parentId: h.oldRoot.id };
    await h.view.importOutline({ nodes: api.parseOutline('# R\n## A\n## B\n## C').nodes, source: null, shallowResearch: true, placement });
    assert.deepEqual(h.notices, ['Created 2 of 4 topics: disk full'], kind);
    const saved = await h.repo.readMap(h.mapPath);
    assert.equal(saved.nodes.length, 4, kind);
    assert.deepEqual(h.notesInFolder(), plain(saved.nodes.map(item => item.path).sort()), `${kind}: no orphan notes`);
    assert.equal(h.researched.length, 0, kind);
  }
});

integrationTest('importOutline under a topic that is no longer on the map rejects and creates nothing', async () => {
  const h = await placementHarness();
  const files = h.notesInFolder();
  await assert.rejects(h.view.importOutline({ nodes: api.parseOutline('# R\n## A').nodes, source: null, shallowResearch: false, placement: { kind: 'under', parentId: 'gone' } }), /The selected topic is no longer on the map\./);
  assert.deepEqual(h.notesInFolder(), files); assert.equal((await h.repo.readMap(h.mapPath)).nodes.length, 2);
  h.view.map = null;
  await assert.rejects(h.view.importOutline({ nodes: api.parseOutline('# R').nodes, source: null, shallowResearch: false, placement: { kind: 'tree' } }), /No editable mind map is open\./);
  assert.deepEqual(h.notesInFolder(), files);
});

integrationTest('the import window gets its target from the open view: editable map, selection title, AIM, built-in sample', async () => {
  const h = await placementHarness();
  assert.deepEqual(plain(h.view.outlineImportTarget()), { map: 'editable' });
  h.view.selected = h.oldChild.id; h.view.notes.set(h.oldChild.id, await h.repo.readNote(h.oldChild.path));
  assert.deepEqual(plain(h.view.outlineImportTarget()), { map: 'editable', selected: { id: h.oldChild.id, title: 'Old child' } });
  h.view.map = { ...h.view.map, aim: { version: 1 } };
  assert.equal(h.view.outlineImportTarget().map, 'aim');
  h.view.builtIn = true;
  assert.equal(h.view.outlineImportTarget().map, 'none');
  h.view.builtIn = false; h.view.map = null;
  assert.deepEqual(plain(h.view.outlineImportTarget()), { map: 'none' });
});

integrationTest('importOutline under a topic removed from Map.md meanwhile: choosing the file version makes the outline a new tree, never a dangling parent', async () => {
  // The conflict window picks the file (disk) version.
  class Modal { constructor(app) { this.app = app; } open() { if (this.disk && this.resolve) this.resolve(JSON.parse(JSON.stringify(this.disk))); } close() {} }
  const h = await placementHarness({}, { Modal });
  const disk = await h.repo.readMap(h.mapPath);
  disk.nodes = disk.nodes.filter(item => item.id !== h.oldChild.id);
  await h.repo.saveMap(h.mapPath, disk); // an external edit: the open view still shows the old map
  await h.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1\n## S2').nodes, source: null, shallowResearch: false, placement: { kind: 'under', parentId: h.oldChild.id } });
  const saved = await h.repo.readMap(h.mapPath); // parses: no dangling parent
  assert.equal(saved.nodes.some(item => item.id === h.oldChild.id), false);
  const fresh = saved.nodes.filter(item => item.id !== h.oldRoot.id);
  assert.equal(fresh.length, 3);
  const sub = fresh.find(item => item.parentId === null);
  assert.equal(await h.titleOf(sub.id), 'Sub', 'the outline became a new tree');
  assert.equal(fresh.filter(item => item.parentId === sub.id).length, 2);
  for (const item of fresh) assert.ok(!overlaps(item, saved.nodes.find(node => node.id === h.oldRoot.id)));
  for (const item of fresh) assert.ok(h.app.vault.getAbstractFileByPath(item.path), 'note present');
  assert.equal(h.view.selected, sub.id);
});

integrationTest('importOutline into the open map: a Map.md save failure lists the created notes, keeps the selection and skips research', async () => {
  const h = await placementHarness();
  h.view.selected = h.oldRoot.id;
  h.repo.saveMap = async () => { throw new Error('locked'); };
  await h.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1').nodes, source: null, shallowResearch: true, placement: { kind: 'under', parentId: h.oldRoot.id } });
  assert.equal(h.notices.length, 1, h.notices.join(' | '));
  assert.match(h.notices[0], /could not be saved: locked \(.*Sub\.md, .*S1\.md\)/);
  assert.equal(h.view.selected, h.oldRoot.id, 'selection unchanged');
  assert.equal(h.researched.length, 0);
  assert.deepEqual(plain(h.view.map.nodes.map(item => item.id)), plain([h.oldRoot.id, h.oldChild.id]));
});
test('outline modal: a create failure keeps the dialog open with the reason beside the button', async () => {
  const h = modalHarness();
  const modal = new h.mod.OutlineImportModal({ vault: { getMarkdownFiles: () => [] } }, async () => { throw new Error('Map.md could not be saved'); });
  modal.open();
  const textarea = h.find(modal.contentEl, item => item.tag === 'textarea'); textarea.value = '# R\n## A'; textarea.listeners.input();
  assert.ok(h.find(modal.modalEl, item => item.tag === 'button' && item.text === 'Cancel'));
  await h.find(modal.modalEl, item => item.tag === 'button' && item.text === 'Add to mind map').listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(modal.closed, false);
  assert.ok(h.find(modal.modalEl, item => /vam-next-status/.test(item.cls) && /Map.md could not be saved/.test(item.text)));
  assert.equal(h.notices.length, 0);
});


integrationTest('quick explore from the view: the generator gets the topic, preset and its model; the reviewed outline goes under the topic and several top headings are researched there', async () => {
  const h = await placementHarness({ promptPresets: [{ id: 'mine', kind: 'outline', name: 'Mine', text: 'Tree for {research topic}' }] });
  const generated = [];
  h.plugin.outlineGeneration = { generate: async (request, signal) => { generated.push({ request, signal }); return { markdown: '# Old root\n## A\n## B\n', nodes: api.parseOutline('# Old root\n## A\n## B').nodes }; } };
  const quick = h.view.quickOutline(h.oldRoot);
  assert.deepEqual(plain(quick.presets.map(p => p.id)), ['knowledge-tree', 'mine']);
  const signal = new AbortController().signal;
  const nodes = await quick.generate({ presetId: 'mine', requirements: 'Focus on habits', language: 'en' }, signal);
  assert.equal(generated[0].request.topic, 'Old root');
  assert.equal(generated[0].request.presetText, 'Tree for {research topic}\n\nFocus on habits');
  assert.equal(generated[0].request.model, 'parent-model'); assert.equal(generated[0].signal, signal);
  assert.equal(nodes.length, 3);
  const modals = load('experiences/visual-map/modals.ts', { obsidian });
  const reviewed = modals.proposalOutline(modals.outlineProposals(nodes));
  await quick.create(reviewed, { shallowResearch: true, researchMode: 'research', researchDepth: 'fast', visualMode: 'off' });
  const saved = await h.repo.readMap(h.mapPath);
  const fresh = saved.nodes.filter(item => item.parentId === h.oldRoot.id && item.id !== h.oldChild.id);
  assert.deepEqual(await Promise.all(fresh.map(item => h.titleOf(item.id))), ['A', 'B'], 'both headings sit directly under the topic');
  assert.equal(h.researched.length, 1);
  assert.equal(h.researched[0].parent, h.oldRoot.id, 'research runs under the topic');
  assert.deepEqual(plain(h.researched[0].children), plain(fresh.map(item => item.id)));
  assert.equal(h.view.history.canUndo, true);
});

const draftInputs = (over = {}) => ({ topic: 'T', presetId: 'knowledge-tree', presetText: 'p', placement: 'tree', target: { map: 'editable' }, shallow: false, depth: 'fast', ...over });
integrationTest('the import window generator asks about AI usage first, hides the window only once AI starts, and says so when it does not start', async () => {
  const h = await placementHarness();
  const calls = [], order = [];
  h.plugin.outlineGeneration = { generate: async request => { order.push('provider'); calls.push(request); return { markdown: '# T\n## A\n', nodes: [] }; } };
  const confirm = h.plugin.confirmAiUsage;
  h.plugin.confirmAiUsage = async (model, run) => { order.push('confirm'); return confirm(model, run); };
  const generator = h.view.outlineGenerator('Topic');
  assert.equal(generator.initialTopic, 'Topic'); assert.equal(generator.presets, h.plugin);
  assert.equal(await generator.generate({ topic: 'T', presetText: 'p' }, new AbortController().signal, () => { order.push('started'); return draftInputs(); }), '# T\n## A\n');
  assert.deepEqual(order, ['confirm', 'started', 'provider'], 'the window hides after usage is confirmed and before the provider call');
  assert.equal(calls[0].model, 'gpt-6-luna'); assert.equal(calls[0].language, 'en'); assert.deepEqual(h.confirms, ['gpt-6-luna']);
  // Declined: nothing starts, the window is never told to hide.
  h.plugin.confirmAiUsage = async () => false;
  let startedCalls = 0;
  await assert.rejects(generator.generate({ topic: 'T', presetText: 'p' }, new AbortController().signal, () => { startedCalls++; return draftInputs(); }), /did not start/);
  assert.equal(calls.length, 1); assert.equal(startedCalls, 0);
});
integrationTest('the import window generator answers in the typed topic language, not the interface language', async () => {
  const h = await placementHarness();
  const calls = [];
  h.plugin.outlineGeneration = { generate: async request => { calls.push(request); return { markdown: '# T\n', nodes: [] }; } };
  const generator = h.view.outlineGenerator();
  await generator.generate({ topic: '要如何在陽台養香草', presetText: 'p' }, new AbortController().signal, () => draftInputs());
  await generator.generate({ topic: 'Balcony herbs', presetText: 'p' }, new AbortController().signal, () => draftInputs());
  assert.deepEqual(calls.map(c => c.language), ['en', 'en'], 'errors stay in the interface language');
  assert.deepEqual(calls.map(c => c.contentLanguage), ['zh-TW', 'en']);
  const { outlineGenerateStep } = load('core/steps/outline-generate/step.ts', { obsidian });
  const prompt = outlineGenerateStep.render({ ...calls[0], topic: '要如何在陽台養香草', presetText: 'p', model: 'm', reasoning: 'low' });
  assert.match(prompt, /Traditional Chinese/);
  assert.doesNotMatch(outlineGenerateStep.render({ ...calls[1], topic: 'Balcony herbs', presetText: 'p', model: 'm', reasoning: 'low' }), /Traditional Chinese/);
  assert.doesNotMatch((() => { try { outlineGenerateStep.parse('', calls[0]); } catch (e) { return e.message; } return ''; })(), /[\u4e00-\u9fff]/);
});

// ---- Background AI outline: the view owns the run once the import window hides ---------------------------------------
async function draftHarness() {
  const log = [], modals = [];
  const Notice = dom.makeNotice(log);
  const Base = dom.makeModal();
  class Modal extends Base { open() { modals.push(this); super.open(); } }
  const h = await placementHarness({}, { Modal, Notice, FuzzySuggestModal: class {} }, { createFragment: dom.createFragment });
  Object.assign(h.plugin, { availableModels: () => ['model-x'], modelLabel: model => model, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async () => {} });
  const gates = [], calls = [];
  const ignoreAbort = { value: false };
  h.plugin.outlineGeneration = { generate: (request, signal) => new Promise((resolve, reject) => {
    calls.push({ request, signal });
    const gate = { resolve: markdown => resolve({ markdown, nodes: [] }), reject };
    gates.push(gate);
    signal.addEventListener('abort', () => { if (!ignoreAbort.value) reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  }) };
  const press = label => { const action = Notice.all.flatMap(n => n.actions).find(b => b.text === label); assert.ok(action, `notice button ${label}`); action.click(); };
  const bar = () => { const parent = dom.element('div'); h.view.renderBackgroundBars(parent); return parent; };
  const start = async (inputs = draftInputs()) => {
    const ctl = new AbortController();
    let startedCalls = 0;
    const generator = h.view.outlineGenerator('T');
    const run = generator.generate({ topic: inputs.topic, presetText: inputs.presetText }, ctl.signal, () => { startedCalls++; return inputs; });
    await until(() => gates.length);
    return { run, ctl, startedCalls: () => startedCalls };
  };
  return { ...h, log, modals, Notice, gates, calls, ignoreAbort, press, bar, start };
}
integrationTest('outline AI in the background: the status bar shows running and Stop; Stop aborts the provider and nothing arrives later (b, f)', async () => {
  const h = await draftHarness();
  const { run, startedCalls } = await h.start();
  assert.equal(startedCalls(), 1); assert.equal(h.view.outlineDraftTask.state, 'running');
  assert.equal(dom.find(h.bar(), i => i.tag === 'span' && i.text === 'AI is writing the outline…') !== undefined, true);
  h.ignoreAbort.value = true; // a provider that ignores Stop and still answers
  dom.button(h.bar(), 'Stop research').click();
  assert.equal(h.calls[0].signal.aborted, true, 'Stop aborts the provider call');
  assert.equal(h.view.outlineDraftTask.state, 'stopped');
  h.gates[0].resolve('# T\n## Late\n'); await run;
  assert.equal(h.view.outlineDraftTask.markdown, undefined, 'a result that arrives after Stop is dropped');
  assert.equal(h.Notice.all.length, 0, 'no Notice for a stopped run');
  assert.equal(h.modals.length, 0);
});
integrationTest('outline AI in the background: completion is one Notice with a Review button and a status-bar entry; no window opens by itself (d)', async () => {
  const h = await draftHarness();
  const { run } = await h.start();
  h.gates[0].resolve('# T\n## A\n'); await run;
  assert.equal(h.view.outlineDraftTask.state, 'done');
  assert.equal(h.Notice.all.filter(n => n.actions.length).length, 1); assert.match(h.log[0], /AI outline is ready/);
  assert.equal(h.modals.length, 0, 'the import window is never reopened automatically');
  assert.ok(dom.button(h.bar(), 'Review'), 'the status bar keeps a Review entry');
  assert.ok(dom.button(h.bar(), '×'), 'and can be dismissed');
});
integrationTest('outline AI in the background: Review reopens the window with every earlier input and the AI result in the outline box (e)', async () => {
  const h = await draftHarness();
  const inputs = draftInputs({ topic: 'Balcony herbs', presetId: 'knowledge-tree', presetText: 'Unsaved preset edit', placement: 'under', target: { map: 'editable', selected: { id: h.oldRoot.id, title: 'Old root' } }, shallow: true, depth: 'deep' });
  const { run } = await h.start(inputs);
  h.gates[0].resolve('# T\n## A\n### A1\n'); await run;
  h.press('Review');
  const modal = h.modals.at(-1);
  assert.equal(h.view.outlineDraftTask, null, 'reopening consumes the waiting result');
  const text = dom.find(modal.contentEl, i => dom.hasCls(i, 'vam-outline-text'));
  assert.equal(text.value, '# T\n## A\n### A1', 'the AI result is in the outline box');
  assert.equal(dom.byLabel(modal.contentEl, 'Research topic').value, 'Balcony herbs');
  assert.equal(dom.byLabel(modal.contentEl, 'Preset instructions').value, 'Unsaved preset edit', 'the unsaved preset text is back');
  const radios = dom.findAll(modal.contentEl, i => i.type === 'radio');
  assert.equal(radios.find(r => r.checked && r.value === 'under') !== undefined, true, 'placement under the topic is back');
  assert.equal(dom.find(modal.contentEl, i => i.type === 'checkbox' && dom.hasCls(i.parent ?? {}, 'vam-outline-check')).checked, true, 'shallow research is back');
  assert.equal(dom.find(modal.contentEl, i => i.type === 'radio' && i.value === 'deep').checked, true, 'research depth is back');
  assert.ok(dom.find(modal.contentEl, i => i.text === '3 topics, 3 levels'), 'previewed like pasted text');
});
integrationTest('outline AI in the background: a failure is a Notice plus a failed status entry; Review reopens with the inputs and the reason', async () => {
  const h = await draftHarness();
  const { run } = await h.start(draftInputs({ topic: 'Keep me', presetText: 'edit' }));
  h.gates[0].reject(new Error('The provider failed')); await run;
  assert.equal(h.view.outlineDraftTask.state, 'failed'); assert.ok(h.log.some(m => /provider failed/.test(m)));
  assert.equal(h.modals.length, 0);
  dom.button(h.bar(), 'Review').click();
  const modal = h.modals.at(-1);
  assert.equal(dom.byLabel(modal.contentEl, 'Research topic').value, 'Keep me');
  assert.equal(dom.find(modal.contentEl, i => dom.hasCls(i, 'vam-outline-text')).value, '', 'no result to show');
  assert.ok(dom.find(modal.contentEl, i => dom.hasCls(i, 'vam-outline-ai-status') && /provider failed/.test(i.text)));
});
integrationTest('outline AI in the background: closing the window before AI starts stops it; after it started only Stop does; a second run is refused while one runs (c)', async () => {
  const h = await draftHarness();
  // Before the usage notice is answered the window can still cancel.
  let release; h.plugin.confirmAiUsage = (model, run) => new Promise(resolve => { release = async () => { await run(); resolve(true); }; });
  const ctl = new AbortController(); let startedCalls = 0;
  const pending = h.view.outlineGenerator('T').generate({ topic: 'T', presetText: 'p' }, ctl.signal, () => { startedCalls++; return draftInputs(); });
  ctl.abort(); release();
  await assert.rejects(pending, /did not start/);
  assert.equal(startedCalls, 0); assert.equal(h.calls.length, 0, 'no provider request after cancelling before the start');
  // After it started, aborting the window's own signal (closing the window) no longer reaches the provider.
  h.plugin.confirmAiUsage = async (_m, run) => { await run(); return true; };
  const second = await h.start(); 
  second.ctl.abort();
  assert.equal(h.calls[0].signal.aborted, false, 'the hidden run is not tied to the window any more');
  await assert.rejects(h.view.outlineGenerator('T').generate({ topic: 'T2', presetText: 'p' }, new AbortController().signal, () => draftInputs()), /running/i);
  h.gates[0].resolve('# T\n'); await second.run;
});
integrationTest('outline AI in the background: view close or another map aborts the run and clears the status (g)', async () => {
  const h = await draftHarness();
  const { run } = await h.start();
  await h.view.onClose();
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.view.outlineDraftTask, null);
  h.gates[0].resolve('# T\n## Late\n'); await run;
  assert.equal(h.Notice.all.length, 0, 'a result after the view closed is dropped');
  const other = await draftHarness();
  const second = await other.start();
  other.view.dropMapBackground();
  assert.equal(other.calls[0].signal.aborted, true); assert.equal(other.view.outlineDraftTask, null);
  second.run.catch(() => {});
});

test('limitOutline keeps the chosen levels below the root and the chosen number of topics, parents before children', () => {
  const { parseOutline, limitOutline } = load('experiences/visual-map/outline-import.ts', { obsidian });
  const nodes = parseOutline('# Root\n## A\n### A1\n#### A1x\n### A2\n## B\n### B1').nodes;
  const titles = result => plain(result.nodes.map(node => node.title));
  assert.deepEqual(titles(limitOutline(nodes, { levels: 1, maxTopics: 30 })), ['Root', 'A', 'B']);
  assert.deepEqual(titles(limitOutline(nodes, { levels: 2, maxTopics: 3 })), ['Root', 'A', 'A1', 'B'], 'every main branch before any grows deeper, in document order');
  assert.equal(limitOutline(nodes, { levels: 2, maxTopics: 3 }).dropped, 3);
  assert.deepEqual(titles(limitOutline(nodes, { levels: 2, maxTopics: 1 })), ['Root', 'A']);
  assert.deepEqual(titles(limitOutline(nodes, { levels: 6, maxTopics: 30 })), titles({ nodes }), 'within bounds nothing changes');
  const forest = [{ index: 0, title: 'A', level: 1, parent: null, line: 1 }, { index: 1, title: 'A1', level: 2, parent: 0, line: 2 }, { index: 2, title: 'B', level: 1, parent: null, line: 3 }];
  assert.deepEqual(titles(limitOutline(forest, { levels: 1, maxTopics: 30 })), ['A', 'B'], 'several top headings are the first level');
});
test('the outline prompt states the chosen levels and size after the preset only when they are given', () => {
  const { buildOutlineGeneratePrompt } = load('core/outline-generation-service.ts', { obsidian });
  const base = { topic: 'Sleep', presetText: 'Preset {research topic}', model: 'gpt-test', reasoning: 'low' };
  const zh = buildOutlineGeneratePrompt({ ...base, language: 'zh-TW', limits: { levels: 3, maxTopics: 12 } });
  assert.match(zh, /展開 3 層子標題/); assert.match(zh, /最多 12 個標題/);
  assert.ok(zh.indexOf('Preset') < zh.indexOf('展開 3 層'), 'the limits follow the preset, so they override it');
  assert.match(buildOutlineGeneratePrompt({ ...base, language: 'en', limits: { levels: 2, maxTopics: 15 } }), /expand 2 levels of sub-headings/);
  assert.doesNotMatch(buildOutlineGeneratePrompt({ ...base, language: 'en' }), /Levels and size for this run/);
});

integrationTest('importOutline under a manual parent: a shallow-research model equal to the workspace model but different from the parent is kept as a manual choice', async () => {
  const h = await placementHarness({ cliModel: 'claude:sonnet' });
  await h.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1').nodes, source: null, shallowResearch: true, researchDepth: 'normal', model: 'claude:sonnet', placement: { kind: 'under', parentId: h.oldRoot.id } });
  const saved = await h.repo.readMap(h.mapPath);
  const fresh = saved.nodes.filter(item => item.parentId !== null && item.id !== h.oldChild.id);
  assert.equal(fresh.length, 2);
  for (const item of fresh) { const note = await h.repo.readNote(item.path, saved); assert.equal(note.modelSource, 'manual'); assert.equal(note.model, 'claude:sonnet'); }
  assert.deepEqual(h.confirms, ['claude:sonnet']);
});
integrationTest('importOutline under a manual parent: no chosen model, or the parent model itself, stays inherited', async () => {
  const h = await placementHarness({ cliModel: 'claude:sonnet' });
  await h.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1').nodes, source: null, shallowResearch: true, researchDepth: 'normal', model: 'parent-model', placement: { kind: 'under', parentId: h.oldRoot.id } });
  const saved = await h.repo.readMap(h.mapPath);
  for (const item of saved.nodes.filter(item => item.parentId !== null && item.id !== h.oldChild.id)) { const note = await h.repo.readNote(item.path, saved); assert.equal(note.modelSource, 'inherited'); assert.equal(note.model, 'parent-model'); }
});

integrationTest('importOutline: a chosen writing tone becomes the new map default next to the template (never a per-topic field)', async () => {
  const { repo, app } = fixture('en');
  const opened = [];
  const plugin = { repo, settings: { ...require('../support.cjs').DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), releaseOutline() {}, confirmAiUsage: async (_m, run) => { await run(); return true; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class {} } });
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.fit = () => {}; view.enqueue = work => work();
  view.openMapInMutation = async path => { opened.push(path); view.path = path; view.map = await repo.readMap(path); };
  view.startShallowResearch = async () => {};
  const nodes = api.parseOutline('# R\n## A').nodes;
  await view.importOutline({ nodes, source: null, shallowResearch: true, detailTemplateId: 'textbook', toneId: 'academic' });
  const withBoth = await repo.readMap(opened[0]);
  assert.equal(withBoth.detailTemplateId, 'textbook'); assert.equal(withBoth.toneId, 'academic');
  for (const node of withBoth.nodes) { const note = await repo.readNote(node.path); assert.equal(note.detailTemplateId, undefined); assert.equal(note.toneId, undefined); }
  await view.importOutline({ nodes, source: null, shallowResearch: true, toneId: 'plain' });
  const toneOnly = await repo.readMap(opened[1]);
  assert.equal(toneOnly.toneId, 'plain'); assert.equal(toneOnly.detailTemplateId, undefined);
  await view.importOutline({ nodes, source: null, shallowResearch: false });
  const none = await repo.readMap(opened[2]);
  assert.equal(none.toneId, undefined); assert.equal(none.detailTemplateId, undefined);
});

integrationTest('importOutline into the open map: the chosen template and tone are recorded on each created topic and reach the shallow research, over the quick-explore tone; the map default is untouched', async () => {
  const h = await placementHarness();
  await h.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1\n### S1a').nodes, source: null, shallowResearch: true, placement: { kind: 'under', parentId: h.oldChild.id }, detailTemplateId: 'textbook', toneId: 'plain', researchOptions: { toneId: 'magazine' } });
  const saved = await h.repo.readMap(h.mapPath);
  const fresh = saved.nodes.filter(item => item.id !== h.oldRoot.id && item.id !== h.oldChild.id);
  assert.equal(fresh.length, 3);
  for (const item of fresh) {
    const note = await h.repo.readNote(item.path);
    assert.equal(note.detailTemplateId, 'textbook'); assert.equal(note.toneId, 'plain');
  }
  assert.equal(saved.detailTemplateId, undefined); assert.equal(saved.toneId, undefined, 'an import never changes the map default');
  assert.equal(h.researched.length, 1);
  assert.equal(h.researched[0].options.toneId, 'plain', 'the dialog choice overrides researchOptions.toneId');
  assert.equal(h.researched[0].options.detailTemplateId, 'textbook');
  // Without a tone choice (quick explore keeps its own), nothing is recorded and researchOptions.toneId stands.
  const second = await placementHarness();
  await second.view.importOutline({ nodes: api.parseOutline('# Sub\n## S1').nodes, source: null, shallowResearch: true, placement: { kind: 'tree' }, researchOptions: { toneId: 'magazine' } });
  assert.equal(second.researched[0].options.toneId, 'magazine');
  const created = (await second.repo.readMap(second.mapPath)).nodes.filter(item => item.id !== second.oldRoot.id && item.id !== second.oldChild.id);
  for (const item of created) assert.equal((await second.repo.readNote(item.path)).toneId, undefined);
});
