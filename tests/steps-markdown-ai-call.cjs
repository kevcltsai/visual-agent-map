// Characterization of the Markdown selection model call (main.ts runMarkdownContextAi): exchange log events, the
// controls the runtime receives, activeTasks and listener cleanup, the Claude image limits and the stop handling.
// Only the injection points that exist before and after the AiCalls refactor are used (plugin.aiRuntime.claude/codex,
// plugin.exchanges, plugin.pluginDirectory, plugin.markdownContextImage, plugin.settings), so this file does not change
// when the call site moves.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');
const { load } = require('./support-replay.cjs');

const { translate } = load('i18n.ts');
const ORIGINAL = 'data:image/png;base64,ORIGINAL';
const image = { complete: true, naturalWidth: 10, naturalHeight: 10 };

// A fake DOM for fitImageForInput: an img whose natural size depends on its src, and a canvas that records its use.
function fakeDom(sizes) {
  const canvases = [];
  const createEl = tag => {
    if (tag === 'img') {
      const el = { naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null };
      Object.defineProperty(el, 'src', { set: value => { const size = sizes[value] || { w: 10, h: 10 }; el.naturalWidth = size.w; el.naturalHeight = size.h; queueMicrotask(() => el.onload && el.onload()); } });
      return el;
    }
    const canvas = { width: 0, height: 0, calls: [], getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: (type, quality) => { canvas.calls.push([type, quality, canvas.width, canvas.height]); return `data:image/jpeg;fitted-${quality}`; } };
    canvases.push(canvas);
    return canvas;
  };
  return { createEl, canvases };
}

function setup({ sizes = {}, logging = true } = {}) {
  const dom = fakeDom(sizes);
  const mod = loadWithAiCalls('tests/fixtures/entries/markdown-call.ts', { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { createEl: dom.createEl });
  const plugin = new mod.Plugin();
  plugin.app = { vault: {}, fileManager: {} };
  plugin.logs = { appendLog() {} };
  plugin.settings.aiExchangeLoggingEnabled = logging;
  const events = [];
  plugin.exchanges = {
    begin: entry => events.push(['begin', entry]),
    sent: (id, request, prompt) => events.push(['sent', id, JSON.parse(request), prompt]),
    received: (id, response) => events.push(['received', id, response]),
    milestones: (id, data) => events.push(['milestones', id, Object.keys(data)]),
    parsed: id => events.push(['parsed', id]),
    completed: id => events.push(['completed', id]),
    failed: (id, message) => events.push(['failed', id, message])
  };
  const state = { runs: [], directoryCalls: 0, imageCalls: 0, codexLocal: [], claudeCalls: 0, during: null };
  plugin.pluginDirectory = () => { state.directoryCalls++; return '/plugin'; };
  plugin.markdownContextImage = async () => { state.imageCalls++; return ORIGINAL; };
  const script = { run: async () => 'reply' };
  const runtime = kind => ({
    runTask: async (prompt, model, effort, schema, controls) => {
      state.runs.push({ kind, prompt, model, effort, schema, controls });
      state.during = [...plugin.activeTasks.keys()];
      controls.onRequest({ via: kind });
      return script.run({ controls, state });
    }
  });
  plugin.aiRuntime.codex = (_directory, local) => { state.codexLocal.push(local); return runtime('codex'); };
  plugin.aiRuntime.claude = () => { state.claudeCalls++; return runtime('claude'); };
  const prepared = () => mod.prepareStep(mod.planStep, { instruction: 'Condense', selected: 'Selected text', context: '', hasImage: false });
  return { plugin, mod, events, state, script, dom, prepared, names: () => events.map(event => event[0]) };
}

/** An external signal that counts its abort listeners. */
function countedSignal() {
  const controller = new AbortController();
  const counter = { add: 0, remove: 0, live: () => counter.add - counter.remove };
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, ...rest) => { if (type === 'abort') counter.add++; return add(type, ...rest); };
  controller.signal.removeEventListener = (type, ...rest) => { if (type === 'abort') counter.remove++; return remove(type, ...rest); };
  return { controller, signal: controller.signal, counter };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('markdown call: a Codex text call logs begin, sent, received, milestones, completed (no parsed) and passes the text-only controls', async () => {
  const h = setup();
  const { signal, counter } = countedSignal();
  const raw = await h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', signal);
  assert.equal(raw, 'reply');
  assert.deepEqual(h.names(), ['begin', 'sent', 'received', 'milestones', 'completed']);
  const [begin, sent, received, milestones, completed] = h.events;
  const id = begin[1].id;
  assert.deepEqual({ ...begin[1], id: undefined, startedAt: undefined }, { id: undefined, startedAt: undefined, topic: 'Markdown selection', mode: 'task', model: 'gpt-6-luna', effort: begin[1].effort, step: 'markdown.plan@1' });
  assert.ok(begin[1].effort, 'the effort is the setting in effect');
  assert.equal(sent[1], id);
  assert.deepEqual(sent[2], { request: { via: 'codex' }, prompt: h.state.runs[0].prompt });
  assert.equal(sent[3], h.state.runs[0].prompt);
  assert.deepEqual([received[1], received[2], milestones[1], milestones[2], completed[1]], [id, 'reply', id, ['receivedAt'], id]);
  assert.equal(h.events.some(event => event[0] === 'parsed'), false);
  const [run] = h.state.runs;
  assert.equal(h.state.runs.length, 1);
  assert.equal(run.kind, 'codex');
  assert.deepEqual(h.state.codexLocal, [true]);
  assert.equal(run.model, 'gpt-6-luna');
  const controls = run.controls;
  assert.deepEqual([controls.textOnly, controls.webSearchOnly, controls.generateImage, controls.searchBudget, controls.imageDataUrl], [true, false, false, 0, undefined]);
  assert.equal('timeoutMs' in controls, false);
  assert.notEqual(controls.signal, signal, 'the runtime gets the internal signal');
  assert.equal(h.state.during.length, 1);
  assert.match(h.state.during[0], /^markdown-context:/);
  assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(counter.live(), 0);
  assert.ok(counter.add >= 1);
});

test('markdown call: web search uses the Codex runtime with search and a budget of 4', async () => {
  const h = setup();
  await h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', new AbortController().signal, undefined, true);
  const { controls } = h.state.runs[0];
  assert.deepEqual(h.state.codexLocal, [false]);
  assert.deepEqual([controls.textOnly, controls.webSearchOnly, controls.generateImage, controls.searchBudget], [false, true, false, 4]);
  assert.equal('timeoutMs' in controls, false);
});

test('markdown call: Codex image generation sets generateImage, drops textOnly and allows six minutes', async () => {
  const h = setup();
  await h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', new AbortController().signal, undefined, false, true);
  const { controls } = h.state.runs[0];
  assert.deepEqual(h.state.codexLocal, [true]);
  assert.deepEqual([controls.textOnly, controls.webSearchOnly, controls.generateImage, controls.searchBudget, controls.timeoutMs], [false, false, true, 0, 360000]);
});

test('markdown call: Claude cannot draw: refused before any event, image read, directory lookup or runtime call', async () => {
  const h = setup();
  await assert.rejects(h.plugin.runMarkdownContextAi(h.prepared(), 'claude:sonnet', new AbortController().signal, image, false, true), error => {
    assert.equal(error.message, translate('en', 'ui.context_ai_image_generation_codex'));
    return true;
  });
  assert.equal(h.events.length, 0);
  assert.equal(h.state.imageCalls, 0);
  assert.equal(h.state.directoryCalls, 0);
  assert.equal(h.state.runs.length, 0);
  assert.equal(h.state.claudeCalls, 0);
  assert.equal(h.plugin.activeTasks.size, 0);
});

test('markdown call: a Claude image over the edge limit or 5 MB is re-encoded; Codex and an image within the limits keep the original', async () => {
  const wide = setup({ sizes: { [ORIGINAL]: { w: 3000, h: 2000 } } });
  await wide.plugin.runMarkdownContextAi(wide.prepared(), 'claude:sonnet', new AbortController().signal, image);
  assert.equal(wide.state.runs[0].kind, 'claude');
  assert.equal(wide.state.runs[0].model, 'sonnet', 'the claude: prefix is removed');
  assert.equal(wide.state.runs[0].controls.imageDataUrl, 'data:image/jpeg;fitted-0.9');
  assert.deepEqual(wide.dom.canvases[0].calls, [['image/jpeg', 0.9, 1568, 1045]]);

  const codex = setup({ sizes: { [ORIGINAL]: { w: 3000, h: 2000 } } });
  await codex.plugin.runMarkdownContextAi(codex.prepared(), 'gpt-6-luna', new AbortController().signal, image);
  assert.equal(codex.state.runs[0].controls.imageDataUrl, ORIGINAL);
  assert.equal(codex.dom.canvases.length, 0, 'Codex never re-encodes');

  const small = setup({ sizes: { [ORIGINAL]: { w: 800, h: 600 } } });
  await small.plugin.runMarkdownContextAi(small.prepared(), 'claude:sonnet', new AbortController().signal, image);
  assert.equal(small.state.runs[0].controls.imageDataUrl, ORIGINAL);
  assert.equal(small.dom.canvases.length, 0);

  const heavy = '#'.repeat(5 * 1024 * 1024 + 1);
  const big = setup({ sizes: { [heavy]: { w: 800, h: 600 } } });
  big.plugin.markdownContextImage = async () => heavy;
  await big.plugin.runMarkdownContextAi(big.prepared(), 'claude:sonnet', new AbortController().signal, image);
  assert.equal(big.state.runs[0].controls.imageDataUrl, 'data:image/jpeg;fitted-0.9');
});

test('markdown call: a reply that arrives after Stop is refused and logged failed, never received or completed', async () => {
  const h = setup();
  const { controller, signal, counter } = countedSignal();
  h.script.run = async () => { controller.abort(); return 'late reply'; };
  await assert.rejects(h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', signal), error => {
    assert.equal(error.message, translate('en', 'ui.ai_task_cancelled'));
    return true;
  });
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.equal(h.events[2][2], translate('en', 'ui.ai_task_cancelled'));
  assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(counter.live(), 0);
});

test('markdown call: a runtime error is rethrown unchanged and logged failed with its message', async () => {
  const h = setup();
  const boom = h.mod.makeError('runtime exploded'); // the bundle's own realm, as in production
  h.script.run = async () => { throw boom; };
  await assert.rejects(h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', new AbortController().signal), error => error === boom);
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.equal(h.events[2][2], 'runtime exploded');
  assert.equal(h.plugin.activeTasks.size, 0);
});

test('markdown call: logging off at the start writes nothing; turned off mid-call leaves only begin and sent', async () => {
  const off = setup({ logging: false });
  await off.plugin.runMarkdownContextAi(off.prepared(), 'gpt-6-luna', new AbortController().signal);
  assert.equal(off.events.length, 0);
  assert.equal(off.state.runs.length, 1);

  const mid = setup();
  mid.script.run = async () => { mid.plugin.settings.aiExchangeLoggingEnabled = false; return 'reply'; };
  await mid.plugin.runMarkdownContextAi(mid.prepared(), 'gpt-6-luna', new AbortController().signal);
  assert.deepEqual(mid.names(), ['begin', 'sent']);
});

test('markdown call: a signal that is already aborted is refused before any event or runtime call', async () => {
  const h = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', controller.signal), error => {
    assert.equal(error.message, translate('en', 'ui.ai_task_cancelled'));
    return true;
  });
  assert.equal(h.events.length, 0);
  assert.equal(h.state.runs.length, 0);
  assert.equal(h.plugin.activeTasks.size, 0);
});

test('markdown call: a plugin directory that cannot be found fails before any event or registration', async () => {
  const h = setup();
  h.plugin.pluginDirectory = () => { throw new Error(translate('en', 'ui.cli_mode_requires_desktop_obsidian')); };
  await assert.rejects(h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', new AbortController().signal), error => {
    assert.equal(error.message, translate('en', 'ui.cli_mode_requires_desktop_obsidian'));
    return true;
  });
  assert.equal(h.events.length, 0);
  assert.equal(h.state.runs.length, 0);
  assert.equal(h.plugin.activeTasks.size, 0);
});

test('markdown call: resetCodexRuntime during a call aborts it, and the reply that arrives afterwards is refused', async () => {
  const h = setup();
  const gate = S.deferred();
  h.script.run = async () => gate.promise;
  const { signal, counter } = countedSignal();
  const settled = h.plugin.runMarkdownContextAi(h.prepared(), 'gpt-6-luna', signal).then(value => ({ value }), error => ({ error }));
  await tick();
  assert.equal(h.state.runs.length, 1);
  assert.equal(h.plugin.activeTasks.size, 1);
  h.plugin.resetCodexRuntime();
  assert.equal(h.state.runs[0].controls.signal.aborted, true);
  gate.resolve('late reply');
  const result = await settled;
  assert.equal(result.error?.message, translate('en', 'ui.ai_task_cancelled'));
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(counter.live(), 0);
});
