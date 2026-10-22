// Sharing P1 (Worker A): vam-share v1 payload, Markdown cleaning, leak scan, size and image helpers. No Obsidian needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { test, load, root, plain } = require('../support.cjs');

const format = load('experiences/sharing/share-format.ts');
const clean = load('experiences/sharing/share-clean.ts');
const scan = load('experiences/sharing/share-leak-scan.ts');
const { parseMap } = load('map-model.ts');

const fixtureDir = path.join(root, 'tests', 'fixtures', 'sharing');
const readFixture = relative => fs.readFileSync(path.join(fixtureDir, relative), 'utf8');
const fixtureMap = () => parseMap(readFixture('Map.md'));
function fixtureNotes() {
  const rawByNode = {};
  const titles = {};
  const models = [];
  for (const node of fixtureMap().nodes) {
    const content = readFixture(node.path.replace('Private Vault Folder/Share Map/', ''));
    const [, front, body] = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const fm = YAML.parse(front);
    const detail = body.split('## Detail')[1].trim();
    rawByNode[node.id] = { fm, detail };
    titles[fm.title] = fm.title;
    models.push({ model: fm.model });
  }
  return { rawByNode, titles, models };
}
const cleanedNotes = (includeDetail = true) => {
  const { rawByNode, titles, models } = fixtureNotes();
  const assets = clean.createAssetRegistry();
  const ctx = { titleOf: target => titles[target.replace(/\.md$/, '')], assets };
  const notesById = {};
  for (const [id, { fm, detail }] of Object.entries(rawByNode)) {
    const result = clean.cleanShareMarkdown(detail, ctx);
    notesById[id] = { title: fm.title, summary: fm.summary, status: fm.status, relevance: fm['relevance-tier'] ? { tier: fm['relevance-tier'], ...(fm['relevance-manual'] ? { manual: true } : {}) } : undefined, detail: result.markdown, detailHtml: `<p>${fm.title} html</p>` };
  }
  return { notesById, assets, models };
};
const options = overrides => ({ includeDetail: true, includeImages: true, language: 'en', vamVersion: '0.25.0', exportedAt: '2026-10-23T00:00:00.000Z', assets: { 'image-1': 'data:image/webp;base64,AAAA' }, ...overrides });

test('sharing: payload has only the Spec fields and the 7 content kinds survive cleaning', () => {
  const { notesById } = cleanedNotes();
  const payload = format.buildSharePayload(fixtureMap(), notesById, options({ goal: 'Learn it' }));
  assert.equal(payload.format, 'vam-share');
  assert.equal(payload.version, 1);
  assert.deepEqual(plain(Object.keys(payload).sort()), ['assets', 'exportedAt', 'format', 'goal', 'language', 'nodes', 'source', 'title', 'version', 'viewport']);
  assert.deepEqual(plain(payload.source), { vamVersion: '0.25.0', mapId: 'share-fixture' });
  const rich = payload.nodes.find(n => n.id === 'rich');
  assert.deepEqual(plain(Object.keys(rich).sort()), ['collapsed', 'detail', 'detailHtml', 'id', 'manual', 'parentId', 'status', 'summary', 'tier', 'title', 'x', 'y']);
  assert.equal(rich.tier, 'support');
  assert.equal(rich.manual, true);
  assert.match(rich.detail, /```mermaid/);
  assert.match(rich.detail, /\| a \| b \|/);
  assert.match(rich.detail, /\[!note\] Callout/);
  assert.equal(payload.nodes.find(n => n.id === 'links').status, 'idea');
});

test('sharing: structure-only mode drops detail and detailHtml; no-images mode empties assets', () => {
  const { notesById } = cleanedNotes();
  const structure = format.buildSharePayload(fixtureMap(), notesById, options({ includeDetail: false }));
  for (const node of structure.nodes) {
    assert.equal('detail' in node, false);
    assert.equal('detailHtml' in node, false);
  }
  assert.deepEqual(plain(Object.keys(structure.assets)), ['image-1']);
  const noImages = format.buildSharePayload(fixtureMap(), notesById, options({ includeImages: false }));
  assert.deepEqual(plain(noImages.assets), {});
  assert.ok(noImages.nodes.some(n => n.detailHtml));
  assert.equal(format.SHARE_DEFAULT_INCLUDE_DETAIL, true);
});

test('sharing: AIM maps are refused with an explicit error', () => {
  const aimNode = { ...fixtureMap(), aim: { branches: [] } };
  assert.throws(() => format.buildSharePayload(aimNode, {}, options()), error => error.name === 'ShareError' && error.code === 'aim-map');
  const kindMap = fixtureMap();
  kindMap.nodes[0].aimKind = 'topic';
  assert.throws(() => format.buildSharePayload(kindMap, {}, options()), /AIM maps cannot be shared/);
});

test('sharing: serialized JSON never contains "</" or "<!--" and round-trips', () => {
  const { notesById } = cleanedNotes();
  notesById.rich.detailHtml = '</script><script>alert(1)</script><!-- x -->\u2028';
  const payload = format.buildSharePayload(fixtureMap(), notesById, options());
  const json = format.serializeShareJson(payload);
  assert.equal(json.includes('</'), false);
  assert.equal(json.includes('<!--'), false);
  assert.equal(json.includes('\u2028'), false);
  assert.deepEqual(plain(JSON.parse(json)), JSON.parse(JSON.stringify(payload)));
});

test('sharing: wikilinks keep the alias or the title as plain text and never leave "[["', () => {
  const { notesById } = cleanedNotes();
  const links = notesById.links.detail;
  assert.equal(links.includes('[['), false);
  assert.match(links, /See Private and alias text and Root\./);
  assert.match(notesById.root.detail, /the private idea/);
});

test('sharing: note embeds become the plain title and bring no embedded content', () => {
  const { notesById } = cleanedNotes();
  const all = ['root', 'rich', 'links'].map(id => notesById[id].detail).join('\n');
  assert.equal(all.includes('SECRET-PRIVATE-BODY'), false);
  assert.match(notesById.links.detail, /^Private$/m);
  assert.equal(notesById.links.detail.includes('!['), false);
});

test('sharing: vault attachments are listed for embedding, web images keep their link, vault links lose their path', () => {
  const assets = clean.createAssetRegistry();
  const ctx = { titleOf: () => undefined, assets };
  const rich = clean.cleanShareMarkdown(readFixture('Notes/Rich.md').split('## Detail')[1], ctx);
  assert.deepEqual(plain(rich.attachments), [
    { ref: '../Attachments/photo.png', name: 'image-1' },
    { ref: '../Attachments/diagram.svg', name: 'image-2' }
  ]);
  assert.deepEqual(plain(rich.webImages), [{ url: 'https://example.org/pic.jpg', alt: 'web' }]);
  assert.match(rich.markdown, /!\[\]\(vam-asset:image-1\)/);
  assert.match(rich.markdown, /!\[diagram\]\(vam-asset:image-2\)/);
  assert.match(rich.markdown, /!\[web\]\(https:\/\/example\.org\/pic\.jpg\)/);
  assert.equal(rich.markdown.includes('Attachments'), false);
  const links = clean.cleanShareMarkdown('Link [guide](Private Vault Folder/Notes/P.md) and [site](https://example.org) %%secret%% end', ctx);
  assert.equal(links.markdown, 'Link guide and [site](https://example.org)  end');
  assert.equal(assets.nameFor('../Attachments/photo.png'), 'image-1');
  assert.equal(clean.replaceAssetImages('a ![x](vam-asset:image-1) b', '[image omitted]'), 'a [image omitted] b');
});

test('sharing: code is left untouched', () => {
  const ctx = { titleOf: () => undefined, assets: clean.createAssetRegistry() };
  const md = 'Use `[[x]]` here\n```js\nconst a = [[1]];\n```\nand [[Real]]';
  assert.equal(clean.cleanShareMarkdown(md, ctx).markdown, 'Use `[[x]]` here\n```js\nconst a = [[1]];\n```\nand Real');
});

test('sharing: leak scan passes the cleaned fixture payload', () => {
  const { notesById, models } = cleanedNotes();
  const payload = format.buildSharePayload(fixtureMap(), notesById, options());
  const html = `<html><script type="application/json" id="vam-map">${format.serializeShareJson(payload)}</script></html>`;
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', vaultName: 'Vault One', mapFolder: 'Private Vault Folder/Share Map' }, fixtureMap(), models);
  assert.deepEqual(plain(scan.scanForLeaks(html, forbidden)), []);
});

test('sharing: leak scan blocks every forbidden category and reports category and position only', () => {
  const map = fixtureMap();
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', vaultName: 'Vault One', mapFolder: 'Private Vault Folder/Share Map' }, map, [{ model: 'claude:sonnet-secret' }, {}]);
  const cases = {
    'vault-path': '/Users/someone/Vault One/x',
    'vault-name': 'in Vault One',
    'map-folder': 'Private Vault Folder/Share Map',
    'note-path': 'Private Vault Folder/Share Map/Notes/Rich.md',
    wikilink: 'see [[Private]]',
    'app-url': 'app://abc/img.png',
    'obsidian-url': 'obsidian://open',
    'file-url': 'file:///etc/passwd',
    'internal-field': 'agent-map-references',
    'model-name': 'claude:sonnet-secret'
  };
  for (const [category, text] of Object.entries(cases)) {
    const hits = scan.scanForLeaks(`<p>ok</p>${text}`, forbidden);
    assert.ok(hits.some(hit => hit.category === category), `${category} must be detected`);
    for (const hit of hits) assert.deepEqual(plain(Object.keys(hit).sort()), ['category', 'index']);
  }
  assert.ok(scan.scanForLeaks('source-notes: x', forbidden).some(h => h.category === 'internal-field'));
  assert.equal(scan.scanForLeaks('<p>nothing private</p>', forbidden).length, 0);
  assert.equal(scan.scanForLeaks('x', [{ category: 'vault-name', value: '' }]).length, 0);
});

test('sharing: leak scan catches a field deliberately left in the payload', () => {
  const { notesById, models } = cleanedNotes();
  const payload = format.buildSharePayload(fixtureMap(), notesById, options());
  payload.nodes[0].summary = 'leaked: Private Vault Folder/Share Map/Notes/Root.md';
  const html = format.serializeShareJson(payload);
  const hits = scan.scanForLeaks(html, scan.forbiddenStringsFor({ vaultName: 'Vault One', mapFolder: 'Private Vault Folder/Share Map' }, fixtureMap(), models));
  assert.ok(hits.some(hit => hit.category === 'map-folder') && hits.some(hit => hit.category === 'note-path'));
});

test('sharing: size classes and image fitting', () => {
  const MB = 1024 * 1024;
  assert.equal(format.SHARE_SIZE_WARN_BYTES, 10 * MB);
  assert.equal(format.SHARE_SIZE_SUGGEST_NO_IMAGES_BYTES, 20 * MB);
  assert.equal(format.classifySize(10 * MB), 'ok');
  assert.equal(format.classifySize(10 * MB + 1), 'warn');
  assert.equal(format.classifySize(20 * MB), 'warn');
  assert.equal(format.classifySize(20 * MB + 1), 'large');
  assert.equal(format.classifySize(150, { warn: 100, large: 200 }), 'warn');
  assert.equal(format.classifySize(250, { warn: 100, large: 200 }), 'large');
  assert.deepEqual(plain(format.fitWithin(800, 600, 1600)), { width: 800, height: 600 });
  assert.deepEqual(plain(format.fitWithin(3200, 1600)), { width: 1600, height: 800 });
  assert.deepEqual(plain(format.fitWithin(1000, 4000)), { width: 400, height: 1600 });
  assert.deepEqual(plain(format.fitWithin(10000, 1)), { width: 1600, height: 1 });
  assert.throws(() => format.fitWithin(0, 10), /Image dimensions/);
});
