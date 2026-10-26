// fitImageForInput (ui/fit-image-input.ts): re-encodes an image to the runtime's input limits; no limits means no work.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { translate } = load('i18n.ts');
const unavailable = translate('en', 'ui.context_ai_image_unavailable');
const cancelled = translate('en', 'ui.ai_task_cancelled');
const MB5 = 5 * 1024 * 1024;

/** A fake DOM: the img's natural size comes from `sizes[src]`; `outputs(quality, width, height)` gives the canvas string. */
function setup({ sizes = {}, outputs = () => 'x', fail = false, onLoad } = {}) {
  const created = [], canvases = [];
  const createEl = tag => {
    created.push(tag);
    if (tag === 'img') {
      const el = { naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null };
      Object.defineProperty(el, 'src', { set: value => {
        const size = sizes[value] || { w: 10, h: 10 };
        el.naturalWidth = size.w; el.naturalHeight = size.h;
        queueMicrotask(() => { onLoad?.(); if (fail) el.onerror?.(); else el.onload?.(); });
      } });
      return el;
    }
    const canvas = { width: 0, height: 0, calls: [], getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: (type, quality) => { canvas.calls.push([type, quality, canvas.width, canvas.height]); return outputs(quality, canvas.width, canvas.height); } };
    canvases.push(canvas);
    return canvas;
  };
  const mod = load('ui/fit-image-input.ts', {}, { createEl });
  return { mod, created, canvases };
}
const LIMITS = { maxEdgePx: 1568, maxBytes: MB5 };
const signal = () => new AbortController().signal;

test('undefined limits: the original string comes back and createEl is never called, even for an aborted signal', async () => {
  const h = setup();
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await h.mod.fitImageForInput('data:ORIGINAL', undefined, aborted.signal), 'data:ORIGINAL');
  assert.deepEqual(h.created, []);
});

test('within the limits: the original image comes back and no canvas is made', async () => {
  const h = setup({ sizes: { 'data:IN': { w: 1568, h: 1000 } } });
  assert.equal(await h.mod.fitImageForInput('data:IN', LIMITS, signal()), 'data:IN');
  assert.equal(h.canvases.length, 0);
});

test('over the edge limit: the canvas is scaled to 1568 and encoded as JPEG 0.9', async () => {
  const h = setup({ sizes: { 'data:BIG': { w: 3136, h: 1568 } }, outputs: quality => `fitted-${quality}` });
  assert.equal(await h.mod.fitImageForInput('data:BIG', LIMITS, signal()), 'fitted-0.9');
  assert.equal(h.canvases.length, 1);
  assert.deepEqual(h.canvases[0].calls, [['image/jpeg', 0.9, 1568, 784]]);
});

test('over the byte limit at the first step falls to 1280 / 0.85, then 1024 / 0.8', async () => {
  const sizes = { 'data:BIG': { w: 3000, h: 1500 } };
  const second = setup({ sizes, outputs: quality => (quality === 0.9 ? 'x'.repeat(MB5 + 1) : `fitted-${quality}`) });
  assert.equal(await second.mod.fitImageForInput('data:BIG', LIMITS, signal()), 'fitted-0.85');
  assert.deepEqual(second.canvases[0].calls, [['image/jpeg', 0.9, 1568, 784], ['image/jpeg', 0.85, 1280, 640]]);
  const third = setup({ sizes, outputs: quality => (quality === 0.8 ? 'small' : 'x'.repeat(MB5 + 1)) });
  assert.equal(await third.mod.fitImageForInput('data:BIG', LIMITS, signal()), 'small');
  assert.deepEqual(third.canvases[0].calls.map(call => [call[1], call[2], call[3]]), [[0.9, 1568, 784], [0.85, 1280, 640], [0.8, 1024, 512]]);
});

test('all three steps over the byte limit: ui.context_ai_image_unavailable', async () => {
  const h = setup({ sizes: { 'data:BIG': { w: 3000, h: 1500 } }, outputs: () => 'x'.repeat(MB5 + 1) });
  await assert.rejects(h.mod.fitImageForInput('data:BIG', LIMITS, signal()), error => error.message === unavailable);
  assert.equal(h.canvases[0].calls.length, 3);
});

test('an image that fails to load: ui.context_ai_image_unavailable', async () => {
  const h = setup({ fail: true });
  await assert.rejects(h.mod.fitImageForInput('data:BAD', LIMITS, signal()), error => error.message === unavailable);
});

test('a signal aborted while the image loads: ui.ai_task_cancelled, and no canvas is made', async () => {
  const controller = new AbortController();
  const h = setup({ sizes: { 'data:BIG': { w: 3000, h: 1500 } }, onLoad: () => controller.abort() });
  await assert.rejects(h.mod.fitImageForInput('data:BIG', LIMITS, controller.signal), error => error.message === cancelled);
  assert.equal(h.canvases.length, 0);
});

test('custom limits move the thresholds: edge 100 px and a 50 byte cap', async () => {
  const sizes = { 'data:A': { w: 200, h: 100 }, 'data:B': { w: 100, h: 100 } };
  const edge = setup({ sizes, outputs: () => 'tiny' });
  assert.equal(await edge.mod.fitImageForInput('data:A', { maxEdgePx: 100, maxBytes: MB5 }, signal()), 'tiny');
  assert.equal(edge.canvases.length, 1);
  assert.equal(await edge.mod.fitImageForInput('data:B', { maxEdgePx: 100, maxBytes: MB5 }, signal()), 'data:B');
  assert.equal(edge.canvases.length, 1);
  const long = 'z'.repeat(51);
  const bytes = setup({ sizes: { [long]: { w: 100, h: 100 } }, outputs: () => 'y'.repeat(60) });
  await assert.rejects(bytes.mod.fitImageForInput(long, { maxEdgePx: 100, maxBytes: 50 }, signal()), error => error.message === unavailable);
  const over = setup({ sizes: { [long]: { w: 100, h: 100 } }, outputs: () => 'ok' });
  assert.equal(await over.mod.fitImageForInput(long, { maxEdgePx: 100, maxBytes: 50 }, signal()), 'ok');
});
