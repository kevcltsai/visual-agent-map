// V3.3 G09 / P5.6: OPML / FreeMind import ends with a safety notice once it succeeded (and only then), a failed or refused
// import writes nothing, and an export carries no selection or preview state.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian, fixture } = require('./support.cjs');

const notices = [];
const stubbed = { ...obsidian, Notice: class { constructor(message) { notices.push(String(message)); } } };
const io = load('experiences/visual-map/outline-exchange-io.ts', { obsidian: stubbed });
const opml = body => `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>T</title></head><body>${body}</body></opml>`;
const file = (name, text) => ({ name, size: Buffer.byteLength(text), text: async () => text });
const SAFETY = /Only titles and notes were imported/;

test('a successful import ends with the safety notice, once', async () => {
  notices.length = 0;
  const host = { importOutline: async () => {} };
  assert.equal(await io.importExchangeFile(host, file('ok.opml', opml('<outline text="Root"/>'))), true);
  assert.equal(notices.filter(m => SAFETY.test(m)).length, 1, notices.join('|'));
});

test('a refused or failed import shows no safety notice and writes nothing to the vault', async () => {
  const { app, contents } = fixture('en');
  const before = [...contents.keys()].sort().join('\n');
  notices.length = 0;
  let calls = 0;
  const host = { importOutline: async () => { calls++; throw new Error('map folder exists'); } };
  for (const bad of ['<opml><body><outline text="x"></body></opml>', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><opml><body><outline text="&a;"/></body></opml>', 'not xml at all'])
    assert.equal(await io.importExchangeFile(host, file('bad.opml', bad)), false, bad);
  assert.equal(calls, 0, 'a refused file never reaches the new-map flow');
  assert.equal(await io.importExchangeFile(host, file('ok.opml', opml('<outline text="R"/>'))), false);
  assert.equal(calls, 1);
  assert.equal(notices.some(m => SAFETY.test(m)), false, notices.join('|'));
  assert.equal([...contents.keys()].sort().join('\n'), before, 'the vault is untouched');
  void app;
});

test('OPML and FreeMind exports carry no selection or preview state, whatever the nodes hold', async () => {
  const { app, contents } = fixture('en');
  for (const folder of ['Agent Workspace', 'Agent Workspace/Topics', 'Agent Workspace/Topics/map-x']) await app.vault.createFolder(folder);
  const mapPath = 'Agent Workspace/Topics/map-x/Map.md';
  const notes = new Map([['r', { title: 'Root', detail: 'root text' }], ['c', { title: 'Kid', detail: '' }]]);
  const plainNodes = [{ id: 'r', parentId: null }, { id: 'c', parentId: 'r' }];
  const stateful = [{ id: 'r', parentId: null, selected: true, isSelected: true, preview: 'PREVIEW-STATE', previewing: true }, { id: 'c', parentId: 'r', selection: ['SELECTION-STATE'], focused: true }];
  for (const format of ['opml', 'freemind']) {
    const a = contents.get(await io.exportMapExchange(app.vault, { mapPath, map: { title: 'Map', nodes: plainNodes }, notes, format }));
    const b = contents.get(await io.exportMapExchange(app.vault, { mapPath, map: { title: 'Map', nodes: stateful }, notes, format }));
    assert.equal(b, a, `${format}: the same file with or without selection and preview state`);
    assert.equal(/PREVIEW-STATE|SELECTION-STATE|selected|preview|focused/i.test(b), false, format);
  }
});
