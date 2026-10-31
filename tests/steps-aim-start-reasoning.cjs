// MS-04 P4b: the AIM start dialog offers auto; the map data never stores auto; the root follows the workspace only
// when both model and reasoning equal the current ones.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');

const { fixture, load, obsidian, core, plain } = support;
const { createAimMap } = load('experiences/aim/create-map.ts');
const rawLevel = (contents, path) => contents.get(path).match(/^reasoning-level: (.*)$/m)?.[1];
const start = (extra = {}) => ({ requestId: 'req-1', topic: 'Topic', context: 'ctx', model: 'cur-model', ...extra });
const setup = (cliReasoning, cliModel = 'cur-model') => {
  const data = fixture('en'); data.repo.settings.cliModel = cliModel; data.repo.settings.cliReasoning = cliReasoning;
  return data;
};

test('AIM start: auto while the model and the current reasoning are the same makes a workspace root with no reasoning-level, and the map re-parses', async () => {
  const { repo, app, contents } = setup('auto');
  const created = await createAimMap(repo, 'cur-model', start({ reasoning: 'auto' }));
  const note = await repo.readNote(created.root.path);
  assert.equal(note.modelSource, 'workspace'); assert.equal(rawLevel(contents, created.root.path), undefined);
  const raw = await app.vault.read(repo.file(created.mapPath));
  const parsed = core.parseMap(raw);
  assert.equal(parsed.aim.rootDraft, undefined);
  assert.equal(parsed.nodes.length, 1);
});

test('AIM start: the root draft never carries reasoning when auto is chosen, and a resume that is passed auto again writes auto', async () => {
  const { repo, app, contents } = setup('low');
  const realCreateNoteAt = repo.createNoteAt.bind(repo); let fail = true;
  repo.createNoteAt = async (...args) => { if (fail) { fail = false; throw new Error('crash before note'); } return realCreateNoteAt(...args); };
  await assert.rejects(createAimMap(repo, 'cur-model', start({ reasoning: 'auto' })), /crash before note/);
  const mapFile = (await repo.mapFiles())[0];
  const parsed = core.parseMap(await app.vault.read(repo.file(mapFile.path)));
  assert.ok(parsed.aim.rootDraft, 'the draft is saved'); assert.equal('reasoning' in parsed.aim.rootDraft, false);
  const created = await createAimMap(repo, 'cur-model', start({ reasoning: 'auto' }));
  assert.equal(rawLevel(contents, created.root.path), 'auto');
  assert.equal((await repo.readNote(created.root.path)).modelSource, 'manual', 'auto differs from the current low');
});

test('AIM start: the same model with high while the current is low is a manual root with high', async () => {
  const { repo, contents } = setup('low');
  const created = await createAimMap(repo, 'cur-model', start({ reasoning: 'high' }));
  const note = await repo.readNote(created.root.path);
  assert.equal(note.modelSource, 'manual'); assert.equal(note.reasoning, 'high'); assert.equal(rawLevel(contents, created.root.path), 'high');
});

test('AIM start: the same model and the same reasoning as the current ones stays workspace', async () => {
  const { repo, contents } = setup('medium');
  const created = await createAimMap(repo, 'cur-model', start({ reasoning: 'medium' }));
  assert.equal((await repo.readNote(created.root.path)).modelSource, 'workspace'); assert.equal(rawLevel(contents, created.root.path), undefined);
});

test('AIM start dialog: reasoning menu offers auto first and preselects the current setting', () => {
  const makeElement = (tag, options = {}) => ({ tag, text: options.text ?? '', value: options.value ?? '', cls: options.cls ?? '', children: [], disabled: false, style: {},
    createEl(name, value) { const child = makeElement(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = makeElement('span', value); this.children.push(child); return child; },
    replaceChildren() { this.children = []; }, setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addClass() {}, toggleClass() {}, addEventListener(name, handler) { this[name] = handler; }, focus() {}, querySelector() {} });
  class Modal { constructor() { this.titleEl = makeElement('title'); this.contentEl = makeElement('content'); } close() {} }
  class Setting { constructor(root) { this.controlEl = makeElement('setting'); root.children.push(this.controlEl); } addButton(configure) { const b = makeElement('button'); b.setButtonText = () => b; b.setCta = () => b; b.onClick = () => b; configure(b); return this; } }
  const { AimStartModal } = load('ui/modals/aim-start-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  const modal = new AimStartModal({}, async () => {}, [{ id: 'm', label: 'm' }], 'm', 'auto');
  modal.onOpen();
  const reasoning = modal.contentEl.children.filter(c => c.cls === 'vam-field').flatMap(c => c.children).find(c => c['aria-label'] === 'Reasoning level');
  assert.deepEqual(plain(reasoning.children.map(o => o.value)), ['auto', 'low', 'medium', 'high']);
  assert.equal(reasoning.value, 'auto');
});

// MS-07 P7b (plan D9): a resume compares the draft with the current model and reasoning at the moment of resuming.
const crashedStart = async (repo, extra) => {
  const realCreateNoteAt = repo.createNoteAt.bind(repo);
  repo.createNoteAt = async () => { throw new Error('crash before note'); };
  await assert.rejects(createAimMap(repo, 'cur-model', start(extra)), /crash before note/);
  repo.createNoteAt = realCreateNoteAt;
};
test('AIM resume: a draft equal to the current model and reasoning at resume time becomes a workspace root with no reasoning-level', async () => {
  const { repo, contents } = setup('medium');
  await crashedStart(repo, { reasoning: 'medium' });
  const created = await createAimMap(repo, 'cur-model', start({ reasoning: 'medium' }));
  assert.equal((await repo.readNote(created.root.path)).modelSource, 'workspace'); assert.equal(rawLevel(contents, created.root.path), undefined);
});
test('AIM resume: a draft with another model or another reasoning becomes a manual root', async () => {
  for (const [extra, label] of [[{ model: 'gpt-x', reasoning: 'medium' }, 'model'], [{ reasoning: 'high' }, 'reasoning']]) {
    const { repo } = setup('medium');
    await crashedStart(repo, extra);
    const created = await createAimMap(repo, 'cur-model', start(extra));
    assert.equal((await repo.readNote(created.root.path)).modelSource, 'manual', label);
  }
});
test('AIM resume: the current model is read when resuming, so a switch between start and resume makes the root manual', async () => {
  const { repo } = setup('medium');
  await crashedStart(repo, { reasoning: 'medium' });
  repo.settings.cliModel = 'switched-model';
  const created = await createAimMap(repo, 'switched-model', start({ reasoning: 'medium' }));
  assert.equal((await repo.readNote(created.root.path)).modelSource, 'manual');
});
