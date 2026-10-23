// Share translation: the one Mermaid `render` wrapper that records diagram sources (reviewer F2). A fake Mermaid object
// stands in for Obsidian's shared one; 0 live AI calls.
const assert = require('node:assert/strict');
const { test, load, obsidian, plain } = require('../support.cjs');

function freshExporter() {
  const mermaid = { render: async (id, text) => `svg:${id}:${text}` };
  const original = mermaid.render;
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, loadMermaid: async () => mermaid } });
  return { mermaid, original, module };
}
const draw = (mermaid, id, text) => mermaid.render(id, text);

test('share mermaid capture: overlapping captures share one wrapper and the original comes back when the last one leaves', async () => {
  const { mermaid, original, module } = freshExporter();
  const first = await module.captureMermaidSources();
  const wrapper = mermaid.render;
  assert.notEqual(wrapper, original);
  const second = await module.captureMermaidSources();
  assert.equal(mermaid.render, wrapper, 'the second capture reuses the wrapper, it does not wrap again');
  await draw(mermaid, 'm1', 'graph TD\n A-->B');
  assert.deepEqual(plain([...first.sources]), [['m1', 'graph TD\n A-->B']]);
  assert.deepEqual(plain([...second.sources]), [['m1', 'graph TD\n A-->B']]);
  // Out of order: the first capture leaves while the second still works.
  first.restore();
  assert.equal(mermaid.render, wrapper, 'still wrapped while a capture is open');
  await draw(mermaid, 'm2', 'graph TD\n C-->D');
  assert.equal(second.sources.get('m2'), 'graph TD\n C-->D');
  assert.equal(first.sources.has('m2'), false, 'a closed capture records nothing more');
  second.restore();
  assert.equal(mermaid.render, original, 'the original render is back');
  second.restore();
  first.restore();
  assert.equal(mermaid.render, original, 'restoring twice changes nothing');
  assert.equal(await draw(mermaid, 'x', 'y'), 'svg:x:y');
});

test('share mermaid capture: a build that throws still restores, and a later capture works again', async () => {
  const { mermaid, original, module } = freshExporter();
  const capture = await module.captureMermaidSources();
  try {
    await draw(mermaid, 'm1', 'a');
    throw new Error('render failed');
  } catch {
    // the exporter does this in its `finally`
  } finally {
    capture.restore();
  }
  assert.equal(mermaid.render, original);
  const again = await module.captureMermaidSources();
  await draw(mermaid, 'm9', 'b');
  assert.equal(again.sources.get('m9'), 'b');
  assert.equal(again.sources.has('m1'), false, 'nothing is carried over from the earlier capture');
  again.restore();
  assert.equal(mermaid.render, original);
});

test('share mermaid capture: unload restores the original at once, forgets the sources and a late restore is harmless', async () => {
  const { mermaid, original, module } = freshExporter();
  const open = await module.captureMermaidSources();
  const other = await module.captureMermaidSources();
  await draw(mermaid, 'm1', 'a');
  module.releaseMermaidCapture();
  assert.equal(mermaid.render, original, 'forced back to the original render');
  await draw(mermaid, 'm2', 'b');
  assert.equal(open.sources.has('m2'), false);
  open.restore();
  other.restore();
  assert.equal(mermaid.render, original);
  // A build that starts after unload (a stale one) cleans up after itself.
  const late = await module.captureMermaidSources();
  late.restore();
  assert.equal(mermaid.render, original);
});

test('share mermaid capture: an id drawn from two different sources is ambiguous and is dropped, not mismatched', async () => {
  const { mermaid, module } = freshExporter();
  const capture = await module.captureMermaidSources();
  await draw(mermaid, 'same', 'graph TD\n A-->B');
  await draw(mermaid, 'same', 'graph TD\n A-->B');
  await draw(mermaid, 'clash', 'graph TD\n X-->Y');
  assert.equal(capture.sources.get('same'), 'graph TD\n A-->B', 'the same text again is fine');
  await draw(mermaid, 'clash', 'graph TD\n P-->Q');
  assert.equal(capture.sources.has('clash'), false);
  await draw(mermaid, 'clash', 'graph TD\n X-->Y');
  assert.equal(capture.sources.has('clash'), false, 'once ambiguous, always ambiguous');
  capture.restore();
});

test('share mermaid capture: without Mermaid there is nothing to restore and no source', async () => {
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...obsidian, loadMermaid: async () => { throw new Error('no mermaid'); } } });
  const capture = await module.captureMermaidSources();
  assert.equal(capture.sources.size, 0);
  capture.restore();
  module.releaseMermaidCapture();
});

test('share exporter: a mermaid fence inside a callout or list still turns the capture on', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../experiences/sharing/share-exporter.ts'), 'utf8');
  const match = /const hasDiagram = (\/.*\/[a-z]*)\.test/.exec(src);
  assert.ok(match, 'the detection is still a regex');
  const regex = eval(match[1]);
  for (const text of ['```mermaid\nA\n```', '> [!note]\n> ```mermaid\n> graph TD\n> ```', '- item\n  ```mermaid\n  graph TD\n  ```', '> > ~~~mermaid\n', '1. ```Mermaid\n'])
    assert.ok(regex.test(text), text);
  assert.equal(regex.test('plain text about mermaids'), false);
});
