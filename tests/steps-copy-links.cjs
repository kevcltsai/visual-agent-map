// "Copy to…" rewrites the links of each copied note: links to notes copied in the same run follow the copies, links to
// everything else keep pointing at the original file, unresolved links and links in code stay as written, and the
// source notes are never written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;

// A resolver like Obsidian's: a full path (with or without `.md`), `./` and `../` relative to the linking note's folder,
// and a bare name that prefers the file in the nearest folder, else the first one.
const folderOf = (path = '') => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const shared = (a, b) => { const x = a.split('/'), y = b.split('/'); let n = 0; while (n < x.length && n < y.length && x[n] === y[n]) n++; return n; };
function normalize(parts) {
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!out.length) return undefined; out.pop(); } else out.push(part);
  }
  return out.join('/');
}
function resolverFor(listFiles) {
  return (linkPath, fromPath) => {
    if (!linkPath) return undefined;
    const files = listFiles(), has = path => files.includes(path);
    const withMd = path => (has(path) ? path : has(`${path}.md`) ? `${path}.md` : undefined);
    if (/^\.\.?\//.test(linkPath)) {
      const joined = normalize([...folderOf(fromPath).split('/'), ...linkPath.split('/')]);
      return joined === undefined ? undefined : withMd(joined);
    }
    const full = withMd(linkPath);
    if (full) return full;
    if (linkPath.includes('/')) return undefined;
    const named = files.filter(path => path.slice(path.lastIndexOf('/') + 1) === linkPath || path.slice(path.lastIndexOf('/') + 1) === `${linkPath}.md`);
    if (!named.length) return undefined;
    const from = folderOf(fromPath);
    return named.reduce((best, path) => (shared(folderOf(path), from) > shared(folderOf(best), from) ? path : best), named[0]);
  };
}

const copyLinks = () => load('core/copy-links.ts');
const VAULT = [
  'A/Notes/x.md', 'A/Notes/B.md', 'A/Notes/Out.md', 'A/Attachments/pic.png', 'A/Attachments/a b.png', 'A/Attachments/a.png',
  'B/Attachments/pic.png', 'B/Notes/Other.md',
  'Copies/x copy.md', 'Copies/B copy.md', 'B/Notes/x copy.md'
];
const resolve = resolverFor(() => VAULT);
// The module runs in its own realm; compare plain values.
const plain = value => JSON.parse(JSON.stringify(value));
const run = (body, options = {}) => plain(copyLinks().rewriteCopiedLinks(body, {
  sourcePath: 'A/Notes/x.md', newPath: 'Copies/x copy.md',
  copies: new Map([['A/Notes/x.md', 'Copies/x copy.md'], ['A/Notes/B.md', 'Copies/B copy.md']]),
  resolve, ...options
}));

test('copy links C1: a full-path wikilink to a note copied in the same run points at its copy', () => {
  const result = run('See [[A/Notes/B]] and [[A/Notes/B.md]].');
  assert.equal(result.text, 'See [[Copies/B copy]] and [[Copies/B copy.md]].');
  assert.equal(result.rewritten, 2);
  assert.deepEqual(result.unverified, []);
});

test('copy links C2: a bare-name link with heading and alias follows the copy and keeps #h|alias', () => {
  assert.equal(run('Go [[B#Part|the b]] and ![[B#^blk]].').text, 'Go [[B copy#Part|the b]] and ![[B copy#^blk]].');
});

test('copy links C3: a link of the note to itself points at the copy itself', () => {
  assert.equal(run('Top: [[x#Intro]]').text, 'Top: [[x copy#Intro]]');
});

test('copy links C4: a note outside the copy that resolves the same from the new place stays byte-identical', () => {
  const body = 'Read [[A/Notes/Out]], [[Out|o]] and [o](A/Notes/Out.md).';
  const result = run(body);
  assert.equal(result.text, body);
  assert.equal(result.rewritten, 0);
});

test('copy links C5: with two pic.png the copy keeps the original attachment by naming its full path', () => {
  const result = run('Img ![[pic.png|200]] here', { newPath: 'B/Notes/x copy.md', copies: new Map([['A/Notes/x.md', 'B/Notes/x copy.md']]) });
  assert.equal(result.text, 'Img ![[A/Attachments/pic.png|200]] here');
  assert.equal(resolve('A/Attachments/pic.png', 'B/Notes/x copy.md'), 'A/Attachments/pic.png');
});

test('copy links C6: a relative image link from another folder depth resolves back to the original, spaces as %20', () => {
  const result = run('![t](../Attachments/a%20b.png "Title") and ![u](../Attachments/a.png)');
  assert.equal(result.text, '![t](A/Attachments/a%20b.png "Title") and ![u](A/Attachments/a.png)');
  for (const path of ['A/Attachments/a b.png', 'A/Attachments/a.png']) assert.equal(resolve(path, 'Copies/x copy.md'), path);
});

test('copy links C7: a <…> link stays in <…> form', () => {
  assert.equal(run('![t](<../Attachments/a b.png>) [b](<B.md#Part>)').text, '![t](<A/Attachments/a b.png>) [b](<B copy.md#Part>)');
});

test('copy links C8: unresolved links stay as written', () => {
  const body = 'Lost [[Nowhere]], [[Nowhere#h|n]], [x](missing.png) and ![y](<gone too.png>).';
  assert.deepEqual(run(body), { text: body, rewritten: 0, unverified: [] });
});

test('copy links C9: external links stay as written, VAM image search links included', () => {
  const body = '![t](<https://example.com/a b.png>) [m](mailto:me@example.com) [o](obsidian://open?vault=v) [h](https://x.y/B.md) [s](#Part) [[#Part]]';
  assert.deepEqual(run(body, { resolve: (linkPath, fromPath) => (/^[a-z]+:/i.test(linkPath) ? 'A/Notes/B.md' : resolve(linkPath, fromPath)) }), { text: body, rewritten: 0, unverified: [] });
});

test('copy links C10: links in a code fence or inline code stay as written', () => {
  const body = '```\n[[B]] ![t](../Attachments/a.png)\n```\nInline `[[B]]` and `[b](B.md)`; real [[B]].';
  assert.equal(run(body).text, '```\n[[B]] ![t](../Attachments/a.png)\n```\nInline `[[B]]` and `[b](B.md)`; real [[B copy]].');
});

test('copy links C11: a link that no candidate resolves back is kept as written and reported', () => {
  // From the copy's place, every spelling of pic.png resolves to B's picture.
  const stubborn = (linkPath, fromPath) => (fromPath.startsWith('B/') && /pic\.png$/.test(linkPath) ? 'B/Attachments/pic.png' : resolve(linkPath, fromPath));
  const body = 'Img ![[pic.png]] and ![p](../Attachments/pic.png)';
  const result = run(body, { newPath: 'B/Notes/x copy.md', copies: new Map([['A/Notes/x.md', 'B/Notes/x copy.md']]), resolve: stubborn });
  assert.equal(result.text, body);
  assert.equal(result.rewritten, 0);
  assert.deepEqual(result.unverified, ['![[pic.png]]', '![p](../Attachments/pic.png)']);
});

test('copy links: a path with an unencoded space and no <…> is not read as a link and stays as written', () => {
  const body = '![t](../Attachments/a b.png)';
  assert.equal(run(body).text, body);
});

test('copy links: a Markdown link to a copied note keeps its text, extension and heading', () => {
  assert.equal(run('[the b](B.md#Part) [full](A/Notes/B.md) [enc](../Notes/B.md)').text, '[the b](B%20copy.md#Part) [full](Copies/B%20copy.md) [enc](Copies/B%20copy.md)');
});

// Repository layer: only the copies are written, and only their body.
async function repoSetup() {
  const data = fixture('en', { linkIndex: true });
  data.app.metadataCache.getFirstLinkpathDest = (linkPath, fromPath) => {
    const path = resolverFor(() => [...data.contents.keys()])(linkPath, fromPath);
    return path === undefined ? null : data.app.vault.getAbstractFileByPath(path);
  };
  return data;
}

test('copy links C12: rewriteCopiedNoteLinks changes the body only, leaves the frontmatter and the source alone', async () => {
  const { repo, app, contents } = await repoSetup();
  const head = '---\nrelated: "[[B]]"\nsource-notes:\n  - A/Notes/B.md\n---\n';
  await app.vault.create('A/Notes/B.md', '# B\n');
  await app.vault.create('C/B copy.md', '# B copy\n');
  await app.vault.create('A/Notes/x.md', `${head}# x\nSee [[B]].\n`);
  await app.vault.create('C/x copy.md', `${head}# x copy\nSee [[B]] and [[x]].\n`);
  const source = contents.get('A/Notes/x.md');
  const result = await repo.rewriteCopiedNoteLinks([{ from: 'A/Notes/x.md', to: 'C/x copy.md' }, { from: 'A/Notes/B.md', to: 'C/B copy.md' }]);
  assert.equal(contents.get('C/x copy.md'), `${head}# x copy\nSee [[B copy]] and [[x copy]].\n`);
  assert.equal(contents.get('A/Notes/x.md'), source);
  assert.equal(contents.get('A/Notes/B.md'), '# B\n');
  assert.deepEqual(plain(result), { rewritten: 2, unverified: [] });
});

// View layer: the real copySelected on a map with P → Q, while another map has its own pic.png.
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-u/Map.md`, MAP_V = `${TOPICS}/map-v/Map.md`;
const stable = text => text.split('\n').filter(line => !/^(updated|agent-map-id):/.test(line)).join('\n');

async function viewHarness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  app.metadataCache.getFirstLinkpathDest = (linkPath, fromPath) => {
    const path = resolverFor(() => [...contents.keys()])(linkPath, fromPath);
    return path === undefined ? null : app.vault.getAbstractFileByPath(path);
  };
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const docs = {};
  for (const [id, path] of [['map-u', MAP], ['map-v', MAP_V]]) {
    docs[id] = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await repo.ensureTopicFolders(`${TOPICS}/${id}`);
    await app.vault.create(path, core.serializeMap(docs[id]));
  }
  await app.vault.create(`${TOPICS}/map-u/Attachments/pic.png`, 'png-u');
  await app.vault.create(`${TOPICS}/map-v/Attachments/pic.png`, 'png-v');
  const doc = docs['map-u'];
  const target = await repo.createNote('Target', 'gpt-6-luna', doc, MAP, 'workspace');
  const p = await repo.createNote('P', 'gpt-6-luna', doc, MAP, 'workspace');
  const q = await repo.createNote('Q', 'gpt-6-luna', doc, MAP, 'workspace');
  p.parentId = target.id; q.parentId = p.id; p.x = 300; q.x = 600; target.y = 400;
  doc.nodes.push(target, p, q);
  await repo.saveMap(MAP, doc);
  contents.set(p.path, `${contents.get(p.path)}\nNext: [[Q]]\n`);
  contents.set(q.path, `${contents.get(q.path)}\nImage: ![[pic.png]]\n`);
  await repo.rebuildDerivedData();
  const spy = Object.create(repo);
  const notices = [];
  class Modal extends dom.makeModal() { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo: spy, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const node = id => view.map.nodes.find(n => n.id === id);
  const copyP = async () => { view.multiSelected.clear(); view.multiSelected.add(p.id); await view.copySelected(node(target.id)); };
  const copies = () => view.map.nodes.filter(n => ![target.id, p.id, q.id].includes(n.id));
  const snapshot = () => new Map([...contents].map(([path, text]) => [path, path.endsWith('Map.md') ? text : stable(text)]));
  return { repo, app, contents, view, spy, p, q, target, copyP, copies, snapshot };
}
const stem = path => path.replace(/\.md$/, '');
const base = path => stem(path).slice(stem(path).lastIndexOf('/') + 1);

test('copy links V1: copySelected points the copy of P at the copy of Q, the copy of Q at the original pic, and leaves P and Q alone', async () => {
  const h = await viewHarness();
  const pBefore = h.contents.get(h.p.path), qBefore = h.contents.get(h.q.path);
  await h.copyP();
  const [pCopy, qCopy] = h.copies();
  assert.ok(pCopy && qCopy, 'two copies on the map');
  const pText = h.contents.get(pCopy.path), qText = h.contents.get(qCopy.path);
  assert.ok(pText.includes(`Next: [[${base(qCopy.path)}]]`), pText);
  assert.equal(h.app.metadataCache.getFirstLinkpathDest(base(qCopy.path), pCopy.path).path, qCopy.path);
  assert.ok(qText.includes('Image: ![[pic.png]]'), 'resolves the same from the copy, so kept as written');
  assert.equal(h.app.metadataCache.getFirstLinkpathDest('pic.png', qCopy.path).path, `${TOPICS}/map-u/Attachments/pic.png`);
  assert.equal(h.contents.get(h.p.path), pBefore);
  assert.equal(h.contents.get(h.q.path), qBefore);
});

test('copy links V2: a failing rewriteCopiedNoteLinks rejects, parks the copies, and leaves Map.md, sources and history alone', async () => {
  const h = await viewHarness();
  const map = h.contents.get(MAP), pBefore = h.contents.get(h.p.path), qBefore = h.contents.get(h.q.path), canUndo = h.view.history.canUndo;
  h.spy.rewriteCopiedNoteLinks = async () => { throw new Error('injected rewrite'); };
  await assert.rejects(h.copyP(), /injected rewrite/);
  assert.equal(h.contents.get(MAP), map);
  assert.equal(h.contents.get(h.p.path), pBefore);
  assert.equal(h.contents.get(h.q.path), qBefore);
  assert.equal(h.view.history.canUndo, canUndo);
  assert.equal([...h.contents.keys()].filter(path => path.startsWith(`${TOPICS}/map-u/Unassigned/`)).length, 2, 'both copies parked');
  assert.equal([...h.contents.keys()].filter(path => path.startsWith(`${TOPICS}/map-u/Notes/`) && /copy/i.test(path)).length, 0);
});

test('copy links V3: undo and redo after a copy are not stale and the copies keep the rewritten text', async () => {
  const h = await viewHarness();
  await h.copyP();
  const [pCopy, qCopy] = h.copies();
  const rewritten = h.contents.get(pCopy.path);
  assert.ok(rewritten.includes(`Next: [[${base(qCopy.path)}]]`), rewritten);
  await h.view.travel(false);
  assert.equal(h.copies().length, 0);
  await h.view.travel(true);
  assert.equal(h.copies().length, 2);
  const again = h.copies()[0];
  assert.equal(stable(h.contents.get(again.path)).split('\n').filter(line => line.startsWith('Next:')).join(), stable(rewritten).split('\n').filter(line => line.startsWith('Next:')).join());
});
