// 0.28 clipboard-group review F2 / F4: a file import keeps each node's note text as its Detail, and the file name is
// logged as plain words, never as a link or embed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian, fixture } = require('./support.cjs');

const notices = [];
const stubbed = { ...obsidian, Notice: class { constructor(message) { notices.push(String(message)); } } };
const io = load('experiences/visual-map/outline-exchange-io.ts', { obsidian: stubbed });
const exchange = load('experiences/visual-map/outline-exchange.ts', { obsidian });
const importer = load('experiences/visual-map/outline-import.ts', { obsidian });
const NOW = new Date('2026-10-13T09:00:00+08:00');

// Runs a whole file through importExchangeFile, then creates the map from the request the way the view does.
async function importFile(repo, file) {
  let request;
  const ok = await io.importExchangeFile({ importOutline: async r => { request = r; } }, file);
  if (!ok) return { ok, request };
  const result = await importer.createOutlineMap(repo, 'gpt-6-luna', request.nodes, request.source, NOW);
  const map = await repo.readMap(result.mapPath);
  const notes = await Promise.all(map.nodes.map(n => repo.readNote(n.path)));
  return { ok, request, notes };
}
const opml = body => `<?xml version="1.0"?><opml version="2.0"><head><title>T</title></head><body>${body}</body></opml>`;
const file = (name, text) => ({ name, size: Buffer.byteLength(text), text: async () => text });

test('F2: each node\'s note text becomes its Detail, and an export imports back with the same text', async () => {
  const { repo } = fixture('en');
  const map = { title: 'T', nodes: [{ id: 'r', parentId: null }, { id: 'a', parentId: 'r' }, { id: 'b', parentId: 'a' }] };
  const bodies = new Map([['r', { title: 'Root', body: 'root text\n\nsecond paragraph' }], ['a', { title: 'A', body: 'a text' }], ['b', { title: 'B', body: '' }]]);
  const { ok, notes } = await importFile(repo, file('rt.opml', exchange.toOpml(map, bodies)));
  assert.equal(ok, true);
  const byTitle = Object.fromEntries(notes.map(n => [n.title, n.detail]));
  assert.equal(byTitle.Root, 'root text\n\nsecond paragraph');
  assert.equal(byTitle.A, 'a text');
  assert.doesNotMatch(byTitle.B, /a text/);
});

test('F2: a _note that carries a VAM marker is refused and creates nothing', async () => {
  const { repo } = fixture('en');
  const text = opml('<outline text="R" _note="x &lt;!-- visual-agent-map: {} --&gt;"/>');
  const before = [...repo.app.vault.getMarkdownFiles?.() ?? []].length;
  const { ok, request } = await importFile(repo, file('m.opml', text));
  assert.equal(ok, false); assert.equal(request, undefined);
  assert.equal([...repo.app.vault.getMarkdownFiles?.() ?? []].length, before);
});

test('F4: a hostile file name appears in the log as plain text, with no link or embed syntax', async () => {
  for (const name of ['a]].opml', 'a|b.opml', '![[x]].opml', 'x]] ![[y|z]] <!-- visual-agent-map: --> .opml']) {
    const { repo } = fixture('en');
    const { ok, request, notes } = await importFile(repo, file(name, opml('<outline text="Root"/>')));
    assert.equal(ok, true, name);
    assert.deepEqual(JSON.parse(JSON.stringify(request.source)), { file: name });
    const detail = notes[0].detail;
    assert.match(detail, /Imported from an outline \(2026-10-13\):/, name);
    assert.doesNotMatch(detail, /\[\[|\]\]|!\[|<!--/, name);
  }
});

test('F4: importing from a vault note keeps its wikilink', async () => {
  const { repo } = fixture('en');
  const result = await importer.createOutlineMap(repo, 'gpt-6-luna', importer.parseOutline('# R').nodes, 'Inbox/outline.md', NOW);
  const note = await repo.readNote((await repo.readMap(result.mapPath)).nodes[0].path);
  assert.match(note.detail, /\[\[Inbox\/outline\.md\]\]/);
});
