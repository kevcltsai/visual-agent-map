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
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', vaultName: 'Vault One', mapFolder: 'Private Vault Folder/Share Map' }, fixtureMap(), models);
  assert.deepEqual(plain(scan.scanPayloadForLeaks(payload, forbidden)), []);
});

test('sharing: leak scan blocks every forbidden category and reports category and position only', () => {
  const map = fixtureMap();
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', vaultName: 'Vault One', mapFolder: 'Private Vault Folder/Share Map' }, map, [{ model: 'claude:sonnet-secret' }, {}]);
  const cases = {
    'vault-path': '/Users/someone/Vault One/x',
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
  assert.equal(scan.scanForLeaks('x', [{ category: 'wikilink', value: '' }]).length, 0);
  assert.equal(forbidden.some(item => item.value === 'Vault One' && item.category !== 'vault-path'), false, 'a vault name alone is not scanned');
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

// D-2026-10-107/108: only a `[[` inside well-formed code is allowed; every other category looks at all text, code included.
const leakForbidden = () => scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', mapFolder: 'Private Vault Folder/Share Map' }, fixtureMap(), [{ model: 'claude:sonnet-secret' }]);
const payloadWith = fields => {
  const payload = format.buildSharePayload(fixtureMap(), {}, options());
  Object.assign(payload.nodes[0], fields);
  return payload;
};
const leakCategories = fields => new Set(scan.scanPayloadForLeaks(payloadWith(fields), leakForbidden()).map(hit => hit.category));
const notePath = () => fixtureMap().nodes[0].path;

test('sharing leak: [[ inside fenced code, inline code, mermaid and <pre>/<code> is allowed', () => {
  assert.equal(leakCategories({ detail: 'x\n```js\nconst a = [[1,[2]]];\n```\ny `[[z]]` w\n~~~\nA[[x]]\n~~~' }).size, 0);
  assert.equal(leakCategories({ detailHtml: '<pre><code>[[1,[2]]]</code></pre><p>a <code>A[[x]]</code></p>' }).size, 0);
});

test('sharing leak: [[ outside code is blocked, including next to code in the same field', () => {
  assert.ok(leakCategories({ detail: 'see [[私人]]' }).has('wikilink'));
  assert.ok(leakCategories({ detail: '`[[x]]` and [[y]]' }).has('wikilink'));
  assert.ok(leakCategories({ detailHtml: '<code>[[x]]</code> [[y]]' }).has('wikilink'));
  assert.ok(leakCategories({ summary: '`[[x]]`' }).has('wikilink'), 'only detail and detailHtml are code-aware');
  assert.ok(leakCategories({ title: '[[x]]' }).has('wikilink'));
});

test('sharing leak: vault path and note path inside code are still blocked', () => {
  assert.ok(leakCategories({ detail: '```\n/Users/someone/Vault One/x\n```' }).has('vault-path'));
  assert.ok(leakCategories({ detail: '```\n' + notePath() + '\n```' }).has('note-path'));
  assert.ok(leakCategories({ detail: 'a `' + notePath() + '` b' }).has('note-path'));
  assert.ok(leakCategories({ detailHtml: '<pre>' + notePath() + '</pre>' }).has('note-path'));
  assert.ok(leakCategories({ detailHtml: '<code>' + notePath() + '</code>' }).has('note-path'));
  assert.ok(leakCategories({ detailHtml: '<pre>/Users/someone/Vault One/x</pre>' }).has('vault-path'));
});

test('sharing leak: unclosed or unpaired code never hides what follows', () => {
  assert.ok(leakCategories({ detail: '```js\nconst a = 1;\n[[y]]' }).has('wikilink'), 'unclosed fence');
  assert.ok(leakCategories({ detail: '~~~\n[[y]]' }).has('wikilink'), 'unclosed tilde fence');
  assert.ok(leakCategories({ detail: '```\ncode\n~~~\n[[y]]' }).has('wikilink'), 'mismatched fence characters');
  assert.ok(leakCategories({ detail: '````\ncode\n```\n[[y]]' }).has('wikilink'), 'shorter closing fence');
  assert.ok(leakCategories({ detail: 'a ` b\n\n[[y]] `' }).has('wikilink'), 'backticks do not pair across paragraphs');
  assert.ok(leakCategories({ detail: 'a ` b [[y]]' }).has('wikilink'), 'single unpaired backtick');
  assert.ok(leakCategories({ detail: '`` a ` [[y]]' }).has('wikilink'), 'unequal backtick runs');
  assert.ok(leakCategories({ detail: '```\n' + notePath() }).has('note-path'));
  assert.equal(scan.stripMarkdownCode('a\n```\nb\n```\nc'), 'a\n \nc');
});

test('sharing leak: HTML code stripping is conservative about tag shape', () => {
  assert.ok(leakCategories({ detailHtml: '<pre\nclass="x">[[ok]]</pre> [[y]]' }).has('wikilink') && !leakCategories({ detailHtml: '<pre\nclass="x">[[ok]]</pre>' }).has('wikilink'), 'attribute variant is code');
  assert.equal(leakCategories({ detailHtml: '<CODE>[[ok]]</CODE>' }).size, 0);
  assert.ok(leakCategories({ detailHtml: '<code>[[ok]]</code><code>x [[y]]' }).has('wikilink'), 'unclosed code');
  assert.ok(leakCategories({ detailHtml: '<code><code>a</code> [[y]]</code>' }).has('wikilink'), 'nested code: text after the first close is not code');
  assert.ok(leakCategories({ detailHtml: '<pre><code>a</code> [[y]]' }).has('wikilink'), 'unclosed pre');
  assert.ok(leakCategories({ detailHtml: '<preview>[[y]]</preview>' }).has('wikilink'), '<preview> is not <pre>');
  assert.ok(leakCategories({ detailHtml: '<codex>[[y]]</codex>' }).has('wikilink'));
});

test('sharing leak: URL schemes, internal fields and model names inside code are still blocked', () => {
  const cases = { 'obsidian-url': 'obsidian://open', 'app-url': 'app://x/y.png', 'file-url': 'file:///etc/passwd', 'internal-field': 'source-notes', 'model-name': 'claude:sonnet-secret' };
  for (const [category, text] of Object.entries(cases)) {
    assert.ok(leakCategories({ detail: '```\n' + text + '\n```' }).has(category), `${category} in fenced code`);
    assert.ok(leakCategories({ detail: '`' + text + '`' }).has(category), `${category} in inline code`);
    assert.ok(leakCategories({ detailHtml: '<pre><code>' + text + '</code></pre>' }).has(category), `${category} in pre/code`);
  }
});

test('sharing leak: scanPayloadForLeaks reports category and position only and covers asset names and values', () => {
  const payload = payloadWith({});
  payload.assets['obsidian://x'] = 'data:image/webp;base64,AAAA';
  payload.title = 'ok';
  const hits = scan.scanPayloadForLeaks(payload, leakForbidden());
  assert.ok(hits.some(hit => hit.category === 'obsidian-url'));
  for (const hit of hits) assert.deepEqual(plain(Object.keys(hit).sort()), ['category', 'index']);
});

// Review F-A: a backslash-escaped backtick is not a code opener, in the cleaner and the scanner alike.
const cleanMd = md => clean.cleanShareMarkdown(md, { titleOf: () => undefined, assets: clean.createAssetRegistry() });

test('sharing F-A: escaped backtick does not open a code span (cleaner and scanner agree)', () => {
  const md = 'see \\`[[Diary/Secret plan]]` here';
  assert.ok(leakCategories({ detail: md }).has('wikilink'), 'scanner still sees the wikilink');
  assert.equal(cleanMd(md).markdown.includes('[['), false, 'cleaner removes the wikilink');
  assert.ok(leakCategories({ detail: '\\`[[x]]`' }).has('wikilink'));
  assert.equal(cleanMd('\\`[[x]]`').markdown.includes('[['), false);
  assert.equal(cleanMd('\\![[Diary/Secret.png]]').markdown.includes('[['), false);
  assert.equal(cleanMd('\\`![[Diary/Secret.png]]`').markdown.includes('[['), false);
  assert.ok(leakCategories({ detail: '\\`![[x]]`' }).has('wikilink'));
});

test('sharing F-A: an escaped backslash leaves the backtick real, so `\\\\`code [[x]]`` is code in both', () => {
  const md = 'a \\\\`code [[x]]` b';
  assert.equal(leakCategories({ detail: md }).has('wikilink'), false);
  assert.equal(cleanMd(md).markdown, md, 'cleaner leaves it untouched as code');
  assert.equal(scan.stripMarkdownCode(md), 'a \\\\  b');
  // an odd run of backslashes (three) escapes again
  assert.ok(leakCategories({ detail: 'a \\\\\\`[[x]]` b' }).has('wikilink'));
});

test('sharing F-A: an escaped closer does not let a later backtick swallow prose', () => {
  const md = '`a\\` [[Secret]] `b`';
  assert.ok(leakCategories({ detail: md }).has('wikilink'));
  assert.equal(cleanMd(md).markdown.includes('[['), false);
});

// Review F-B: comments are removed before code is split off.
test('sharing F-B: %% comments with inline code or fences inside disappear entirely', () => {
  assert.equal(cleanMd('a %% secret `code` [[Diary/x]] %% b').markdown, 'a  b');
  assert.equal(cleanMd('a %% line\n```js\nsecret\n```\nmore %% b').markdown, 'a  b');
  assert.equal(cleanMd('a\n%%\nmulti\n`x`\n%%\nb').markdown, 'a\n\nb');
});

test('sharing F-B: HTML comments outside code disappear, inside code stay', () => {
  assert.equal(cleanMd('a <!-- secret --> b').markdown, 'a  b');
  assert.equal(cleanMd('a <!-- secret `x` [[y]]\n```\nz\n```\n--> b').markdown, 'a  b');
  assert.equal(cleanMd('a `<!-- keep -->` b').markdown, 'a `<!-- keep -->` b');
  assert.equal(cleanMd('```\n<!-- keep -->\n```').markdown, '```\n<!-- keep -->\n```');
});

test('sharing F-B: a literal %% inside code that pairs with another %% is removed (conservative, recorded)', () => {
  assert.equal(cleanMd('`50%%` and 100%% done').markdown.includes('%%'), false);
  assert.equal(cleanMd('code `a %% b` alone').markdown, 'code `a %% b` alone', 'a single %% in code stays');
});

test('sharing: leak categories have localized labels in every language', () => {
  const cats = ['vault-path', 'map-folder', 'note-path', 'wikilink', 'app-url', 'obsidian-url', 'file-url', 'internal-field', 'model-name'];
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const dict = load(`i18n/${lang}.ts`);
    const table = Object.values(dict).find(v => v && typeof v === 'object' && 'share.leak_blocked_0' in v);
    assert.ok(table, lang);
    for (const cat of cats) assert.ok(table[`share.leak_category_${cat}`], `${lang} ${cat}`);
  }
});

test('sharing F-B: an unclosed %% or <!-- outside code cuts everything after it', () => {
  const a = cleanMd('keep\n%% never closed\n[[私人]] and text');
  assert.equal(a.markdown, 'keep\n');
  assert.equal(cleanMd('keep <!-- never closed [[私人]] text').markdown, 'keep ');
  assert.equal(cleanMd('x %% a %% y %% tail [[私人]]').markdown, 'x  y ');
  assert.equal(cleanMd('keep `a %% b` then [[Real]]').markdown, 'keep `a %% b` then Real', 'unpaired %% in code is not a comment');
  assert.equal(cleanMd('```\n%%\n```\nafter').markdown, '```\n%%\n```\nafter');
  assert.equal(cleanMd('`<!--` still here').markdown, '`<!--` still here');
});
