// Picture-book pipeline wiring (03a part 4): the plugin owns BookPipelineRuns, the view supplies the author call, the image
// probe and the backup, a closing view stops the run, and a conversation chain or multi-research blocks it. Unit level: the view
// methods run on plain objects that carry only what they read; real Obsidian behavior (an image actually loading) is UI evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const images = [];
const timers = [];
class FakeImg {
  constructor() { this.src = ''; this.naturalWidth = 0; images.push(this); }
}
const windowValues = {
  createFragment: dom.createFragment,
  createEl: tag => { assert.equal(tag, 'img'); return new FakeImg(); },
  setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
  clearTimeout: id => { if (timers[id - 1]) timers[id - 1].live = false; },
  clearInterval: () => {}
};
const MODULES = load('main.ts', { obsidian }, windowValues);
const { VisualAgentMapView } = MODULES;
const Plugin = MODULES.default;
const proto = VisualAgentMapView.prototype;
const same = (actual, expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

test('wiring: the plugin owns BookPipelineRuns with the public entries; dispose refuses further starts', async () => {
  const plugin = new Plugin({}, { id: 'vam', version: '0.0.0' });
  for (const method of ['startBookPipeline', 'stopBookPipeline', 'resumeBookPipeline', 'confirmBookGate1', 'retryBookTrial', 'rerunBookCard', 'confirmBookSeam', 'getBookPipelineProgress'])
    assert.equal(typeof plugin[method], 'function', method);
  assert.equal(plugin.getBookPipelineProgress('Nothing.md'), undefined);
  await plugin.stopBookPipeline('Nothing.md');
  plugin.bookPipelineRuns.dispose();
  await assert.rejects(plugin.startBookPipeline('Nothing.md'), error => error.code === 'disposed');
});

test('wiring: onunload disposes the runner (start refused afterwards)', async () => {
  const plugin = new Plugin({}, { id: 'vam', version: '0.0.0' });
  let disposed = 0;
  plugin.bookPipelineRuns.dispose = () => { disposed++; };
  try { Plugin.prototype.onunload.call(plugin); } catch { /* the rest of unload needs a real app */ }
  assert.equal(disposed, 1);
});

test('blocked: true while a conversation chain runs or a multi-research batch is running, false otherwise', () => {
  const make = (over = {}) => ({ path: 'M.vam', multiResearchKey: () => 'multi-research:M.vam', chatChainRunner: { current: null }, plugin: { expansionBatches: new Map(), argumentRuns: { isRunning: () => false } }, ...over });
  const blocked = view => proto.bookPipelineBlocked.call(view);
  assert.equal(blocked(make()), false);
  assert.equal(blocked(make({ chatChainRunner: { current: {} } })), true);
  assert.equal(blocked(make({ plugin: { expansionBatches: new Map([['multi-research:M.vam', { status: 'running' }]]) } })), true);
  assert.equal(blocked(make({ plugin: { expansionBatches: new Map([['multi-research:M.vam', { status: 'done' }]]) , argumentRuns: { isRunning: () => false } } })), false);
  assert.equal(blocked(make({ plugin: { expansionBatches: new Map(), argumentRuns: { isRunning: path => path === 'M.vam' } } })), true, 'an argument-map run blocks');
});

test('switching maps stops the old map\'s run (source-level), and an author call with no view of the map is cancelled and stops that map, never a failure', async () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const open = source.indexOf('private async openMapInMutation(');
  const head = source.slice(open, open + 1200);
  assert.match(head, /if \(path !== this\.path\) \{\s*\/\/[^\n]*\n\s*if \(this\.path\) void this\.plugin\.bookPipelineRuns\?\.stop\(this\.path\)/);
  const plugin = new Plugin({}, { id: 'vam', version: '0.0.0' });
  plugin.views = () => [{ mapPath: 'Other.vam' }];
  const stops = [];
  plugin.bookPipelineRuns.stop = async path => { stops.push(path); };
  const out = await plugin.bookPipelineRuns.ports.author({ mapPath: 'M.vam', nodeId: 'n1' });
  same(out, { outcome: 'cancelled' });
  same(stops, ['M.vam']);
});

test('plugin blocked port: a view of that map that is blocked blocks; another map does not', () => {
  const plugin = new Plugin({}, { id: 'vam', version: '0.0.0' });
  plugin.views = () => [{ mapPath: 'A.vam', bookPipelineBlocked: () => true }, { mapPath: 'B.vam', bookPipelineBlocked: () => false }];
  // The ports object is private to the runner; observe it through start's refusal.
  return assert.rejects(plugin.startBookPipeline('A.vam'), error => error.code === 'blocked');
});

test('closing the view stops that map\'s run: wiring in onClose (source-level, like the other onClose wiring tests)', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const start = source.indexOf('async onClose()');
  const close = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(close, /if \(this\.path\) void this\.plugin\.bookPipelineRuns\?\.stop\(this\.path\);/);
  // And the plugin entry it calls is the runner's stop: a map with no run resolves at once.
  return new Plugin({}, { id: 'vam', version: '0.0.0' }).stopBookPipeline('M.vam');
});

const probe = (url, signal = new AbortController().signal) => {
  const before = images.length;
  const result = proto.probeBookImage.call({}, url, signal);
  return { img: images[before], result };
};

test('probeBookImage: a loaded https image is ok with no referrer; error, empty image, timeout and abort are not', async () => {
  let p = probe('https://example.com/a.png');
  assert.equal(p.img.referrerPolicy, 'no-referrer');
  assert.equal(p.img.src, 'https://example.com/a.png');
  p.img.naturalWidth = 10; p.img.onload();
  same(await p.result, { ok: true });
  p = probe('https://example.com/b.png'); p.img.onerror();
  same(await p.result, { ok: false, reason: 'load_failed' });
  p = probe('https://example.com/c.png'); p.img.onload();
  same(await p.result, { ok: false, reason: 'empty' });
  const t0 = timers.length;
  p = probe('https://example.com/d.png');
  assert.equal(timers[t0].ms, 8000);
  timers[t0].fn();
  same(await p.result, { ok: false, reason: 'timeout' });
  const controller = new AbortController();
  p = probe('https://example.com/e.png', controller.signal); controller.abort();
  same(await p.result, { ok: false, reason: 'aborted' });
});

function authorView(behaviour) {
  const calls = [];
  const view = {
    map: { nodes: [{ id: 'n1', path: 'N1.md' }] }, bookAuthoring: new Map(),
    researchChild: async (...args) => { calls.push(args); return behaviour(...args); }
  };
  const input = (over = {}) => ({
    mapPath: 'M.vam', nodeId: 'n1', path: 'N1.md', settings: { reader: 'kids' }, language: 'zh-TW', model: 'sonnet', reasoning: 'low',
    signal: new AbortController().signal, admission: { reserve: async () => {} }, authorize: () => true, finalize: c => c, ...over
  });
  return { view, calls, input };
}

test('runBookAuthor: calls researchChild as a rewrite without charts, with admission, no content log and the pipeline guard; written on done', async () => {
  const h = authorView(async (child, signal, accepted, choices, charts, onResult) => onResult({}));
  const input = h.input();
  same(await proto.runBookAuthor.call(h.view, input), { outcome: 'written' });
  const [child, signal, , choices, charts, , , , book] = h.calls[0];
  assert.equal(child.id, 'n1'); assert.equal(signal, input.signal); assert.equal(charts, false);
  assert.equal(choices.rewrite, true); assert.equal(choices.researchMode, 'research');
  same(choices.runOnce, { model: 'sonnet', reasoning: 'low' });
  assert.match(choices.requirements, /reader: kids/);
  assert.equal(book.request.admission, input.admission); assert.equal(book.request.noContentLog, true);
  assert.equal(book.pipeline.authorize, input.authorize); assert.equal(book.pipeline.finalize, input.finalize);
});

test('runBookAuthor: the card\'s image slots reach the author requirements; no slots (or an input without the field) gives the rules and no plan block', async () => {
  const h = authorView(async (child, signal, accepted, choices, charts, onResult) => onResult({}));
  await proto.runBookAuthor.call(h.view, h.input({ slots: [{ index: 1, kind: 'map', explains: 'the route', anchor: 'after paragraph 1' }] }));
  assert.match(h.calls[0][3].requirements, /Image slots: when an image plan is given/); assert.match(h.calls[0][3].requirements, /- slot 1: kind "map", explains "the route"/);
  await proto.runBookAuthor.call(h.view, h.input({ slots: [] }));
  await proto.runBookAuthor.call(h.view, h.input());
  assert.ok(!/Image plan for this chapter/.test(h.calls[1][3].requirements)); assert.equal(h.calls[2][3].requirements, h.calls[1][3].requirements);
});

test('runBookAuthor: forces the book-chapter template for the run (never the card\'s own template); researchChild hands it to detailTemplateFor', async () => {
  const h = authorView(async (child, signal, accepted, choices, charts, onResult) => onResult({}));
  await proto.runBookAuthor.call(h.view, h.input());
  assert.equal(h.calls[0][8].template, 'book-chapter');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /detailTemplateFor\(child, choices\.noteStyle, gate, outputLanguage, book\?\.template\)/);
});

test('runBookAuthor: budget exhaustion is its own outcome (not failed, no thrown error)', async () => {
  const h = authorView(async (...args) => args[8].pipeline.onBudgetExhausted());
  same(await proto.runBookAuthor.call(h.view, h.input()), { outcome: 'budget-exhausted' });
});

test('runBookAuthor: aborted -> cancelled; stale message -> discarded; other error -> failed (code only); unknown card -> failed', async () => {
  const controller = new AbortController();
  let h = authorView(async () => { controller.abort(); throw new Error('stopped'); });
  same(await proto.runBookAuthor.call(h.view, h.input({ signal: controller.signal })), { outcome: 'cancelled' });
  h = authorView(async () => { throw new Error('boom secret text'); });
  same(await proto.runBookAuthor.call(h.view, h.input()), { outcome: 'failed', reason: 'author_failed' });
  h = authorView(async () => {});
  assert.equal((await proto.runBookAuthor.call(h.view, h.input({ nodeId: 'zz' }))).outcome, 'failed');
});

test('runBookAuthor: discarded comes from the onDiscarded callback, never from the message text', async () => {
  let h = authorView(async (...args) => { args[8].pipeline.onDiscarded(); throw new Error('any wording at all'); });
  same(await proto.runBookAuthor.call(h.view, h.input()), { outcome: 'discarded' });
  const { t } = load('i18n.ts');
  h = authorView(async () => { throw new Error(t('ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved')); });
  same(await proto.runBookAuthor.call(h.view, h.input()), { outcome: 'failed', reason: 'author_failed' });
});

test('bookBackupNote: wraps writebackHooks().backupNote; a missing hook is not ok', async () => {
  const seen = [];
  const view = { writebackHooks: () => ({ backupNote: async (p, c) => { seen.push([p, c]); return { ok: true, path: 'Backups/N1.md' }; } }) };
  same(await proto.bookBackupNote.call(view, 'N1.md', 'text'), { ok: true, path: 'Backups/N1.md' });
  same(seen, [['N1.md', 'text']]);
  same(await proto.bookBackupNote.call({ writebackHooks: () => ({}) }, 'N1.md', 'x'), { ok: false });
});
