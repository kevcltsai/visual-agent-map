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
  const cleaned = {};
  for (const [id, { fm, detail }] of Object.entries(rawByNode)) {
    const result = clean.cleanShareMarkdown(detail, ctx);
    notesById[id] = { title: fm.title, summary: fm.summary, status: fm.status, relevance: fm['relevance-tier'] ? { tier: fm['relevance-tier'], ...(fm['relevance-manual'] ? { manual: true } : {}) } : undefined, detailHtml: `<p>${fm.title} html</p>` };
    cleaned[id] = result.markdown;
  }
  return { notesById, cleaned, assets, models };
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
  assert.deepEqual(plain(Object.keys(rich).sort()), ['collapsed', 'detailHtml', 'id', 'manual', 'parentId', 'status', 'summary', 'tier', 'title', 'x', 'y']);
  assert.equal(rich.tier, 'support');
  assert.equal(rich.manual, true);
  const cleanedRich = cleanedNotes().cleaned.rich;
  assert.match(cleanedRich, /```mermaid/);
  assert.match(cleanedRich, /\| a \| b \|/);
  assert.match(cleanedRich, /\[!note\] Callout/);
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

test('sharing D-2026-10-110: the P1 payload never carries a Markdown detail, even when the input has one', () => {
  const { notesById } = cleanedNotes();
  notesById.rich.detail = 'SECRET-MARKDOWN [[Diary/secret]]';
  for (const includeDetail of [true, false]) {
    const payload = format.buildSharePayload(fixtureMap(), notesById, options({ includeDetail }));
    for (const node of payload.nodes) assert.equal('detail' in node, false);
    assert.equal(format.serializeShareJson(payload).includes('SECRET-MARKDOWN'), false);
  }
});

test('sharing: an old AIM map is shared like any map, and the payload carries no AIM data', () => {
  const aimNode = { ...fixtureMap(), aim: { branches: [] } };
  const kindMap = fixtureMap();
  kindMap.nodes[0].aimKind = 'topic';
  for (const doc of [aimNode, kindMap]) assert.doesNotMatch(JSON.stringify(format.buildSharePayload(doc, {}, options())), /"aim/);
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
  const { cleaned } = cleanedNotes();
  const links = cleaned.links;
  assert.equal(links.includes('[['), false);
  assert.match(links, /See Private and alias text and Root\./);
  assert.match(cleaned.root, /the private idea/);
});

test('sharing: note embeds become the plain title and bring no embedded content', () => {
  const { cleaned } = cleanedNotes();
  const all = ['root', 'rich', 'links'].map(id => cleaned[id]).join('\n');
  assert.equal(all.includes('SECRET-PRIVATE-BODY'), false);
  assert.match(cleaned.links, /^Private$/m);
  assert.equal(cleaned.links.includes('!['), false);
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
  assert.equal(links.markdown, 'Link guide and [site](https://example.org) %%secret%% end', 'comments are left to the renderer (D-110 step 4)');
  assert.equal(assets.nameFor('../Attachments/photo.png'), 'image-1');
  assert.equal(clean.replaceAssetImages('a ![x](vam-asset:image-1) b', '[image omitted]'), 'a [image omitted] b');
});

test('sharing: a YouTube embed is shared as a plain link, not an image or iframe', () => {
  const ctx = { titleOf: () => undefined, assets: clean.createAssetRegistry() };
  const result = clean.cleanShareMarkdown('Stretch ![Cat stretch](https://www.youtube.com/watch?v=dQw4w9WgXcQ) and ![](https://youtu.be/dQw4w9WgXcQ)', ctx);
  assert.equal(
    result.markdown,
    'Stretch [\uE004▶ Cat stretch](https://www.youtube.com/watch?v=dQw4w9WgXcQ) and [\uE004▶ https://youtu.be/dQw4w9WgXcQ](https://youtu.be/dQw4w9WgXcQ)'
  );
  assert.deepEqual(plain(result.webImages), [], 'a video is never fetched as a web image');
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

// D-2026-10-107/108, narrowed by D-2026-10-110: only a `[[` inside <pre>/<code> of detailHtml is allowed (the P1 payload has no Markdown); every other category looks at all text, code included.
const leakForbidden = () => scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', mapFolder: 'Private Vault Folder/Share Map' }, fixtureMap(), [{ model: 'claude:sonnet-secret' }]);
const payloadWith = fields => {
  const payload = format.buildSharePayload(fixtureMap(), {}, options());
  Object.assign(payload.nodes[0], fields);
  return payload;
};
const leakCategories = fields => new Set(scan.scanPayloadForLeaks(payloadWith(fields), leakForbidden()).map(hit => hit.category));
const notePath = () => fixtureMap().nodes[0].path;

test('sharing leak: [[ inside <pre>/<code> (code, mermaid source) is allowed; a Markdown detail field is not scanned as code any more', () => {
  assert.ok(leakCategories({ detail: 'x\n```js\nconst a = [[x]];\n```' }).has('wikilink'), 'no Markdown code carve-out');
  assert.equal(leakCategories({ detailHtml: '<pre><code>[[1,[2]]]</code></pre><p>a <code>A[[x]]</code></p>' }).size, 0);
});

test('sharing leak: a matrix [[ does not block; link text, also next to it, still does', () => {
  // A matrix written with escaped brackets renders to a literal [[2,0],[0,1]] (the math picture book, 2026-11-22).
  assert.equal(leakCategories({ detailHtml: '<li dir="auto">C3：本節用 [[2,0],[0,1]] 示範伸縮，也用 [[0,-1],[1,0]] 示範旋轉。</li>' }).size, 0);
  assert.equal(leakCategories({ summary: 'A = [[1, 2]; [3, 4]] and B = [[a] [b]]' }).size, 0);
  assert.equal(leakCategories({ detailHtml: '<p>$$[[a],[b]]$$</p>' }).size, 0);
  for (const leak of ['[[2,0],[0,1]] and [[私人]]', '[[[私人]]]', '[[私人|別名]]', '[[私人', '[[私人 <b>x</b>', '[[私人]</p>', '[[私人]', 'a [[私人\nb ]]', 'a [[私人]\r\nb', '[[私人#標題]]', '[[私人|see [1]]]', '[[私人 計畫, cf. [1] x', '[[私人] notes', '[[1,[2]]]'])
    assert.ok(leakCategories({ detailHtml: `<p>${leak}</p>` }).has('wikilink'), leak);
  assert.ok(leakCategories({ summary: 'cut off [[私人筆' }).has('wikilink'), 'a cut-off link still blocks');
  assert.ok(leakCategories({ summary: 'ends [[私人]' }).has('wikilink'), 'a link missing one bracket at the end still blocks');
});

test('sharing leak: [[ outside code is blocked, including next to code in the same field', () => {
  assert.ok(leakCategories({ detailHtml: '<p>see [[私人]]</p>' }).has('wikilink'));
  assert.ok(leakCategories({ detailHtml: '<code>[[x]]</code> [[y]]' }).has('wikilink'));
  assert.ok(leakCategories({ summary: '`[[x]]`' }).has('wikilink'), 'only detailHtml is code-aware');
  assert.ok(leakCategories({ title: '[[x]]' }).has('wikilink'));
});

test('sharing leak: vault path and note path inside code are still blocked', () => {
  assert.ok(leakCategories({ detailHtml: '<pre>' + notePath() + '</pre>' }).has('note-path'));
  assert.ok(leakCategories({ detailHtml: '<code>' + notePath() + '</code>' }).has('note-path'));
  assert.ok(leakCategories({ detailHtml: '<pre>/Users/someone/Vault One/x</pre>' }).has('vault-path'));
});

test('sharing leak: unclosed or mismatched <pre>/<code> never hides what follows', () => {
  assert.ok(leakCategories({ detailHtml: '<pre><code>const a = 1;\n[[y]]' }).has('wikilink'), 'unclosed pre');
  assert.ok(leakCategories({ detailHtml: '<pre>a</code> [[y]]' }).has('wikilink'), 'mismatched close');
  assert.ok(leakCategories({ detailHtml: '<pre>' + notePath() }).has('note-path'));
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

// Review F-A, re-based on D-2026-10-110: the cleaner is the only user of the code heuristic, and any line with a backslash has no inline code.
const cleanMd = md => clean.cleanShareMarkdown(md, { titleOf: () => undefined, assets: clean.createAssetRegistry() });
const SECRET = 'Diary/secret';
const cleanedKeepsSecret = md => cleanMd(md).markdown.includes(SECRET);

test('sharing F-A: escaped backtick does not open a code span', () => {
  assert.equal(cleanMd('see \\`[[Diary/Secret plan]]` here').markdown.includes('[['), false);
  assert.equal(cleanMd('\\`[[x]]`').markdown.includes('[['), false);
  assert.equal(cleanMd('\\![[Diary/Secret.png]]').markdown.includes('[['), false);
  assert.equal(cleanMd('\\`![[Diary/Secret.png]]`').markdown.includes('[['), false);
});

test('sharing F-A: a line with a backslash holds no inline code (adjusted: `\\\\`code [[x]]`` used to be code, now prose)', () => {
  assert.equal(cleanMd('a \\\\`code [[x]]` b').markdown.includes('[['), false);
  assert.equal(cleanMd('a \\\\\\`[[x]]` b').markdown.includes('[['), false);
  assert.equal(cleanMd('`a\\` [[Secret]] `b`').markdown.includes('[['), false);
});

// D-2026-10-110 / advisor Diagnostic Reset: the invariant is that the secret does not survive the cleaner.
test('sharing D-110: F-C cases (heading, list, table, setext, indented fence line, CRLF blank line) never keep the link', () => {
  const cases = {
    heading: '# Title `a\n[[Diary/secret]] b`',
    list: '- item `a\n- [[Diary/secret]] `',
    table: '| a `x |\n|---|\n| [[Diary/secret]] ` |',
    setext: 'para `a\n===\n[[Diary/secret]] `',
    indentFence: 'x `a\n    ```\n[[Diary/secret]] `',
    crlfBlank: 'a `x\r\n\r\n[[Diary/secret]] `',
    crlfOnly: 'a `x\r[[Diary/secret]] `'
  };
  for (const [name, md] of Object.entries(cases)) assert.equal(cleanedKeepsSecret(md), false, name);
});

test('sharing D-110: fence info with a backtick, table pipes, autolinks, raw HTML attributes, HTML blocks and blockquotes never keep the link', () => {
  const cases = {
    fenceInfoBacktick: '``` a`b\n[[Diary/secret]]\n```',
    tablePipeLine: '| `a | [[Diary/secret]] | b` |\n|---|---|---|',
    autolink: '<http://a`b> [[Diary/secret]] `',
    htmlAttribute: '<span title="`">[[Diary/secret]]`</span>',
    htmlBlockFence: '<div>\n\n```\n[[Diary/secret]]\n```\n\n</div>',
    htmlBlockSameParagraph: '<div>\n```\n[[Diary/secret]]\n```\n</div>',
    blockquoteFence: '> ```\n> [[Diary/secret]]\n> ```',
    blockquoteInline: '> a `x\n\n> [[Diary/secret]] `',
    escapedBacktick: 'a\\\\\\`b [[Diary/secret]] `c`',
    dollar: '$a `b$ [[Diary/secret]] c`'
  };
  for (const [name, md] of Object.entries(cases)) assert.equal(cleanedKeepsSecret(md), false, name);
});

test('sharing D-110: reference definitions with a local target disappear, web and mail targets and footnotes stay', () => {
  for (const md of ['see [x][r]\n\n[r]: Diary/secret.md', '[r]: Diary/secret.md', '[r]: <Diary/secret.md> "t"', '[r]:\n  Diary/secret.md', '  [R]: #Diary/secret']) {
    assert.equal(cleanedKeepsSecret(md), false, md);
    assert.equal(cleanMd(md).markdown.includes('Diary'), false, md);
  }
  assert.equal(cleanMd('[r]: https://example.org/a "t"\n[m]: mailto:a@b.c\n[^1]: note text\n').markdown, '[r]: https://example.org/a "t"\n[m]: mailto:a@b.c\n[^1]: note text\n');
  assert.equal(cleanMd('```\n[r]: Diary/secret.md\n```').markdown, '```\n[r]: Diary/secret.md\n```', 'inside a fence it is code');
  assert.equal(cleanMd('a\n[r]: Diary/secret.md\nb').markdown, 'a\nb');
});

test('sharing D-110: no false blocking of real code (mermaid after a paragraph, single-line inline code, plain fences)', () => {
  const mermaid = 'Intro paragraph\n```mermaid\ngraph TD\nA[[x]] --> B\n```\n';
  assert.equal(cleanMd(mermaid).markdown, mermaid, 'mermaid subroutine A[[x]] stays intact');
  assert.equal(cleanMd('use `[[x]]` here').markdown, 'use `[[x]]` here');
  assert.equal(cleanMd('x\n```js\nconst a = [[1,[2]]];\n```\ny').markdown, 'x\n```js\nconst a = [[1,[2]]];\n```\ny');
  assert.equal(cleanMd('x\n~~~\nA[[x]]\n~~~').markdown, 'x\n~~~\nA[[x]]\n~~~');
  assert.equal(cleanMd('a <br> b\n\n```\n[[k]]\n```').markdown, 'a <br> b\n\n```\n[[k]]\n```', 'a lone inline tag does not turn later fences into prose');
  assert.equal(cleanMd('<http://example.org>\n```\n[[k]]\n```').markdown, '<http://example.org>\n```\n[[k]]\n```', 'an autolink is not an HTML block');
});

test('sharing D-110: code ranges follow the narrowed heuristic', () => {
  const code = load('experiences/sharing/share-code.ts');
  const ranges = md => plain(code.markdownCodeRanges(md)).map(r => md.slice(r.start, r.end));
  assert.deepEqual(ranges('a `b` c'), ['`b`']);
  assert.deepEqual(ranges('a `b\nc` d'), [], 'inline code is single-line');
  assert.deepEqual(ranges('a `b | c` d'), []);
  assert.deepEqual(ranges('a `b < c` d'), []);
  assert.deepEqual(ranges('a `b $ c` d'), []);
  assert.deepEqual(ranges('a `b \\ c` d'), []);
  assert.deepEqual(ranges('    `b` d'), [], 'indented code line is not inline code');
  assert.deepEqual(ranges('``` a`b\nx\n```'), [], 'backtick fence info with a backtick');
  assert.deepEqual(ranges('~~~ a`b\nx\n~~~'), ['~~~ a`b\nx\n~~~'], 'tilde fence info may hold backticks');
  assert.deepEqual(ranges('```js\nx\n'), [], 'unclosed fence is prose');
  assert.equal(code.normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
});

// Review F-B, re-based on D-2026-10-110 step 4: the renderer hides comments (live-checked), the cleaner leaves them alone.
test('sharing F-B: the cleaner no longer deletes %% or <!-- --> comments (the renderer hides them; verified live)', () => {
  assert.equal(cleanMd('a %% secret `code` %% b').markdown, 'a %% secret `code` %% b');
  assert.equal(cleanMd('a <!-- secret --> b').markdown, 'a <!-- secret --> b');
  assert.equal(cleanMd('keep\n%% never closed\ntext').markdown, 'keep\n%% never closed\ntext');
  assert.equal(cleanMd('a `x %% hidden` and\n# h `b\n%% secret rest').markdown.includes('secret rest'), true, 'division of labor: hiding is the renderer\'s job (live case)');
  // a link inside a comment is still rewritten, so no `[[` survives even if some renderer showed the comment
  assert.equal(cleanMd('%% [[Diary/secret]] %%').markdown, '%% secret %%');
  assert.equal(cleanMd('<!-- [[Diary/secret]] -->').markdown, '<!-- secret -->');
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


// Ticket 33 P4: topic markers in the share payload. Optional field, same version, whitelist only.
test('sharing markers: the payload carries only whitelisted marker ids in fixed order, and no key when there are none', () => {
  const { notesById } = cleanedNotes();
  const hostile = ['star', 'done', 'done', 'Done', '<img src=x onerror=alert(1)>', 3, null, { id: 'done' }, 'priority-3', 'future-x'];
  const withMarkers = { ...notesById, rich: { ...notesById.rich, markers: hostile }, [Object.keys(notesById)[0]]: { ...notesById[Object.keys(notesById)[0]], markers: [] } };
  const payload = format.buildSharePayload(fixtureMap(), withMarkers, options());
  assert.equal(payload.version, 1, 'no version bump');
  const added = format.buildSharePayload(fixtureMap(), { ...notesById, rich: { ...notesById.rich, markers: ['question', 'flag-red', 'progress-50', 'priority-5', '<img src=x onerror=alert(1)>', 'flag-purple'] } }, options());
  assert.deepEqual(plain(added.nodes.find(n => n.id === 'rich').markers), ['priority-5', 'progress-50', 'flag-red', 'question']);
  const rich = payload.nodes.find(n => n.id === 'rich');
  assert.deepEqual(plain(rich.markers), ['done', 'star', 'priority-3']);
  assert.ok(!JSON.stringify(payload).includes('onerror'), 'unknown values never reach the file');
  for (const node of payload.nodes.filter(n => n.id !== 'rich')) assert.equal('markers' in node, false, `${node.id} has no markers key`);
  const notList = format.buildSharePayload(fixtureMap(), { ...notesById, rich: { ...notesById.rich, markers: 'done' } }, options());
  assert.equal('markers' in notList.nodes.find(n => n.id === 'rich'), false, 'a non-list value reads as nothing');
  assert.ok(format.serializeShareJson(payload).includes('"markers":["done","star","priority-3"]'));
});

// topic-links P3: topic links in the share payload. Optional field, same version, valid http(s) only.
test('sharing links: the payload carries only valid deduplicated http(s) hrefs, and no key when there are none', () => {
  const { notesById } = cleanedNotes();
  const hostile = ['https://b.example/x', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:x', 'data:text/html,x', 'https://u:p@h.example/', 3, null, { href: 'https://c.example' }, ' HTTPS://A.example ', 'https://a.example/', 'https://e.example/' + 'a'.repeat(2100)];
  const firstId = Object.keys(notesById)[0];
  const payload = format.buildSharePayload(fixtureMap(), { ...notesById, rich: { ...notesById.rich, links: hostile }, [firstId]: { ...notesById[firstId], links: [] } }, options());
  assert.equal(payload.version, 1, 'no version bump');
  assert.deepEqual(plain(payload.nodes.find(n => n.id === 'rich').links), ['https://b.example/x', 'https://a.example/']);
  assert.ok(!JSON.stringify(payload).includes('javascript'), 'unsafe values never reach the file');
  for (const node of payload.nodes.filter(n => n.id !== 'rich')) assert.equal('links' in node, false, `${node.id} has no links key`);
  const notList = format.buildSharePayload(fixtureMap(), { ...notesById, rich: { ...notesById.rich, links: { 0: 'https://a.example/' } } }, options());
  assert.equal('links' in notList.nodes.find(n => n.id === 'rich'), false, 'a non-list value reads as nothing');
  assert.ok(format.serializeShareJson(payload).includes('"links":["https://b.example/x","https://a.example/"]'));
  const plainPayload = format.buildSharePayload(fixtureMap(), notesById, options());
  assert.equal(JSON.stringify(plainPayload).includes('"links":["'), false, 'a map without topic links is unchanged');
});

test('sharing topic-style: the payload carries only whitelisted style tokens, and no key when there is none', () => {
  const { notesById } = cleanedNotes();
  const styled = { ...notesById, rich: { ...notesById.rich, style: ['bold', 'text-large', 'text-small', 'BOLD', 'x', 3] } };
  const payload = format.buildSharePayload(fixtureMap(), styled, options());
  assert.equal(payload.version, 1, 'no version bump');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.nodes.find(n => n.id === 'rich').style)), ['bold', 'text-large']);
  for (const bad of ['BOLD', 3, null, {}, '"><script>', ['nope'], []]) {
    const p = format.buildSharePayload(fixtureMap(), { ...notesById, rich: { ...notesById.rich, style: bad } }, options());
    assert.equal('style' in p.nodes.find(n => n.id === 'rich'), false, `${JSON.stringify(bad)} is dropped`);
  }
  const plainPayload = format.buildSharePayload(fixtureMap(), notesById, options());
  assert.ok(!format.serializeShareJson(plainPayload).includes('"style"'), 'a map without styles is unchanged');
});

// Ticket 37 P3: topic colour in the share payload. Optional field, same version, whitelist only.
test('sharing topic-color: the payload carries only a whitelisted colour id, and no key when there is none', () => {
  const { notesById } = cleanedNotes();
  const first = Object.keys(notesById)[0];
  const colored = { ...notesById, rich: { ...notesById.rich, color: 'blue' }, [first]: { ...notesById[first], color: 'Red' } };
  const payload = format.buildSharePayload(fixtureMap(), colored, options());
  assert.equal(payload.version, 1, 'no version bump');
  assert.equal(payload.nodes.find(n => n.id === 'rich').color, 'blue');
  for (const bad of ['Red', ['red'], 3, null, 'red; background:url(x)', '<img src=x onerror=alert(1)>', {}, '']) {
    const p = format.buildSharePayload(fixtureMap(), { ...notesById, rich: { ...notesById.rich, color: bad } }, options());
    assert.equal('color' in p.nodes.find(n => n.id === 'rich'), false, `${JSON.stringify(bad)} is dropped`);
    assert.ok(!JSON.stringify(p).includes('onerror'), 'unknown values never reach the file');
  }
  for (const node of payload.nodes.filter(n => n.id !== 'rich')) assert.equal('color' in node, false, `${node.id} has no color key`);
  const plainPayload = format.buildSharePayload(fixtureMap(), notesById, options());
  assert.ok(!format.serializeShareJson(plainPayload).includes('"color"'), 'a map without colours is unchanged');
  assert.ok(format.serializeShareJson(payload).includes('"color":"blue"'));
});

// card-resize: the payload carries a custom card width only when one is set, same version.
test('sharing card-width: the payload carries width only for a custom width and the viewer applies it', () => {
  const { notesById } = cleanedNotes();
  const map = fixtureMap();
  map.nodes[0].width = 400;
  map.nodes[1].width = 280;
  map.nodes[2].width = 9999;
  map.nodes[3].width = 'wide';
  const payload = format.buildSharePayload(map, notesById, options());
  assert.equal(payload.version, 1, 'no version bump');
  const widths = payload.nodes.map(n => ('width' in n ? n.width : null));
  assert.deepEqual(plain(widths.slice(0, 4)), [400, null, 560, null]);
  for (const node of payload.nodes.slice(4)) assert.equal('width' in node, false, `${node.id} has no width key`);
  const plainMap = format.buildSharePayload(fixtureMap(), notesById, options());
  assert.equal(JSON.stringify(plainMap).includes('"width"'), false, 'a map without widths serializes without the key');
  const viewerSource = fs.readFileSync(path.join(root, 'experiences', 'sharing', 'viewer', 'main.ts'), 'utf8');
  assert.match(viewerSource, /clampCardWidth\(item\.width\)/);
  assert.match(viewerSource, /card\.style\.width = `\$\{node\.width\}px`/);
});

// card-height: the payload carries a custom card height only when one is set, same version.
test('sharing card-height: the payload carries a cleaned height only when one is set', () => {
  const { notesById } = cleanedNotes();
  const map = fixtureMap();
  map.nodes[0].height = 320;
  map.nodes[1].height = 9999;
  map.nodes[2].height = 'tall';
  map.nodes[3].height = 50.4;
  const payload = format.buildSharePayload(map, notesById, options());
  assert.equal(payload.version, 1, 'no version bump');
  const heights = payload.nodes.map(n => ('height' in n ? n.height : null));
  assert.deepEqual(plain(heights.slice(0, 4)), [320, 720, null, 80]);
  for (const node of payload.nodes.slice(4)) assert.equal('height' in node, false, `${node.id} has no height key`);
  const plainPayload = format.buildSharePayload(fixtureMap(), notesById, options());
  assert.equal(JSON.stringify(plainPayload).includes('"height"'), false, 'a map without heights serializes without the key');
});

// tree-text-node (P4): text nodes travel as plain text in an optional `textNodes` list; the viewer only uses textContent.
test('sharing text-nodes: no text nodes means no key and unchanged bytes; text nodes carry parent, orphans get null', () => {
  const { notesById } = cleanedNotes();
  const before = format.serializeShareJson(format.buildSharePayload(fixtureMap(), notesById, options()));
  assert.ok(!before.includes('textNodes'));
  const emptyItems = fixtureMap();
  emptyItems.canvasItems = [{ id: 'img', kind: 'mystery' }];
  assert.equal(format.serializeShareJson(format.buildSharePayload(emptyItems, notesById, options())), before);
  const map = fixtureMap();
  const first = map.nodes[0].id;
  map.canvasItems = [
    { id: 't1', kind: 'text', text: ' hello ', parentId: first, x: 10, y: 20 },
    { id: 't2', kind: 'text', text: 'orphan', parentId: 'gone', x: 5, y: 6 },
    { id: 't3', kind: 'text', text: 'free', x: 7, y: 8 },
    { id: 't4', kind: 'text', text: 'self', parentId: 't4', x: 1, y: 2 },
    { id: 't5', kind: 'text', text: '   ', parentId: first, x: 1, y: 2 },
    { id: 't6', kind: 'text', text: 'x'.repeat(2500), parentId: first, x: 1, y: 2 },
    { id: 't7', kind: 'text', text: 42, parentId: first, x: 1, y: 2 },
    { id: 't8', kind: 'text', text: 'bad xy', parentId: first, x: Infinity, y: 2 },
    { id: 't1', kind: 'text', text: 'dup id', parentId: first, x: 1, y: 2 }
  ];
  const payload = format.buildSharePayload(map, notesById, options());
  assert.equal(payload.version, 1);
  const byId = Object.fromEntries(payload.textNodes.map(t => [t.id, t]));
  assert.deepEqual(plain(Object.keys(byId).sort()), ['t1', 't2', 't3', 't4', 't6']);
  assert.deepEqual(plain(byId.t1), { id: 't1', parentId: first, text: 'hello', x: 10, y: 20 });
  for (const id of ['t2', 't3', 't4']) assert.equal(byId[id].parentId, null, `${id} is an orphan`);
  assert.equal(byId.t6.text.length, 2000);
  assert.deepEqual(plain(Object.keys(byId.t1).sort()), ['id', 'parentId', 'text', 'x', 'y']);
  // Structure-only share still carries the user's own text: it is map structure, not note detail.
  assert.equal(format.buildSharePayload(map, notesById, options({ includeDetail: false })).textNodes.length, 5);
});

test('sharing text-nodes: counterexample - script and img text stay literal in the file and the viewer never uses HTML', () => {
  const { notesById } = cleanedNotes();
  const map = fixtureMap();
  const evil = '</script><script>alert(1)</script><img src=x onerror=alert(1)>';
  map.canvasItems = [{ id: 't1', kind: 'text', text: evil, parentId: map.nodes[0].id, x: 0, y: 0 }];
  const payload = format.buildSharePayload(map, notesById, options());
  assert.equal(payload.textNodes[0].text, evil, 'stored as typed, never rewritten');
  const json = format.serializeShareJson(payload);
  assert.ok(!json.includes('<'), 'every < is escaped in the JSON block');
  assert.equal(JSON.parse(json).textNodes[0].text, evil);
  const src = fs.readFileSync(path.join(root, 'experiences', 'sharing', 'viewer', 'main.ts'), 'utf8');
  const start = src.indexOf('function renderTexts');
  const block = src.slice(start, src.indexOf('function renderCards'));
  assert.ok(start > 0 && block.includes('el.textContent = text.text'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/.test(block));
});

// canvas-text-node: a free text block's links travel as an optional `links` list of live topic ids.
test('sharing text-nodes: links appear only when live, dangling and duplicate ids drop, a tree text node carries none', () => {
  const { notesById } = cleanedNotes();
  const map = fixtureMap();
  const a = map.nodes[0].id;
  map.canvasItems = [
    { id: 'f1', kind: 'text', text: 'budget', x: 1, y: 2, links: [a, a, 'gone', 7, 'f1'] },
    { id: 'f2', kind: 'text', text: 'no links', x: 3, y: 4, links: ['gone'] },
    { id: 'f3', kind: 'text', text: 'tree', parentId: a, x: 5, y: 6, links: [a] }
  ];
  const payload = format.buildSharePayload(map, notesById, options());
  const byId = Object.fromEntries(payload.textNodes.map(t => [t.id, t]));
  assert.deepEqual(plain(byId.f1.links), [a]);
  assert.ok(!('links' in byId.f2), 'no live link means no key');
  assert.ok(!('links' in byId.f3), 'a text node under a topic has no links');
  const src = fs.readFileSync(path.join(root, 'experiences', 'sharing', 'viewer', 'main.ts'), 'utf8');
  const start = src.indexOf('Free text linked to topics');
  const block = src.slice(start, src.indexOf('let edgeFrame'));
  assert.ok(start > 0 && block.includes('vam-text-link'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/.test(block));
});

// summary-bracket (P3): brackets travel as an optional `summaries` list; the card heights are known only on the page.
test('sharing summaries: no bracket means no key and unchanged bytes; a bracket carries its whole run, side and plain text', () => {
  const { notesById } = cleanedNotes();
  const before = format.serializeShareJson(format.buildSharePayload(fixtureMap(), notesById, options()));
  assert.ok(!before.includes('summaries'));
  const map = fixtureMap();
  const root = map.nodes.find(node => !node.parentId);
  const kids = map.nodes.filter(node => node.parentId === root.id);
  assert.ok(kids.length >= 3);
  const evil = '</script><img src=x onerror=alert(1)>';
  map.canvasItems = [
    { id: 's1', kind: 'summary', parentId: root.id, members: [kids[0].id, kids[2].id], text: ` ${evil} ` },
    { id: 's2', kind: 'summary', parentId: root.id, members: ['gone'], text: 'dangling' },
    { id: 's3', kind: 'summary', parentId: 'gone', members: [kids[0].id], text: 'no parent' },
    { id: 's4', kind: 'summary', parentId: root.id, members: [kids[0].id], text: '   ' },
    { id: 's5', kind: 'summary', parentId: root.id, members: [kids[1].id], text: 5 },
    { id: 's1', kind: 'summary', parentId: root.id, members: [kids[1].id], text: 'duplicate id' }
  ];
  const payload = format.buildSharePayload(map, notesById, options());
  assert.equal(payload.version, 1);
  assert.equal(payload.summaries.length, 1);
  assert.deepEqual(plain(payload.summaries[0]), { id: 's1', parentId: root.id, members: [kids[0].id, kids[1].id, kids[2].id], side: 'right', text: evil });
  const json = format.serializeShareJson(payload);
  assert.ok(!json.includes('<'), 'every < is escaped in the JSON block');
  assert.equal(JSON.parse(json).summaries[0].text, evil);
  // Structure-only shares keep the user's own text, like text nodes.
  assert.equal(format.buildSharePayload(map, notesById, options({ includeDetail: false })).summaries.length, 1);
  // Other canvas items alone leave the bytes unchanged.
  const other = fixtureMap();
  other.canvasItems = [{ id: 'img', kind: 'mystery' }];
  assert.equal(format.serializeShareJson(format.buildSharePayload(other, notesById, options())), before);
});

test('sharing summaries: left/down/up carry their side; radial, timeline, fishbone and a balanced run on both halves are left out of the file', () => {
  const { notesById } = cleanedNotes();
  const build = (direction, edit) => {
    const map = fixtureMap();
    const root = map.nodes.find(node => !node.parentId);
    const kids = map.nodes.filter(node => node.parentId === root.id);
    map.layout = { direction };
    if (edit) edit(root, kids);
    map.canvasItems = [{ id: 's1', kind: 'summary', parentId: root.id, members: [kids[0].id, kids[1].id], text: 'conclusion' }];
    return format.buildSharePayload(map, notesById, options()).summaries?.[0]?.side ?? null;
  };
  assert.equal(build('left'), 'left');
  assert.equal(build('down'), 'down');
  assert.equal(build('up'), 'up');
  for (const direction of ['radial', 'timeline', 'fishbone']) assert.equal(build(direction), null, direction);
  assert.equal(build('balanced', (root, kids) => { root.x = 1000; kids[0].x = 1400; kids[1].x = 1400; }), 'right');
  assert.equal(build('balanced', (root, kids) => { root.x = 1000; kids[0].x = 600; kids[1].x = 600; }), 'left');
  assert.equal(build('balanced', (root, kids) => { root.x = 1000; kids[0].x = 600; kids[1].x = 1400; }), null);
});

// share-match-map P1: the cover look and the picture rules of buildSharePayload.
test('sharing: a cover keeps only a usable look, needs its asset in the file, and appears only with notes and images', () => {
  const map = { id: 'm', title: 'T', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, path: `${id}.md`, parentId: id === 'a' ? null : 'a', x: 0, y: 0, collapsed: false })) };
  const notesById = Object.fromEntries(map.nodes.map(n => [n.id, { title: n.id, summary: '', status: 'idea' }]));
  const covers = {
    a: { asset: 'image-1', frame: { x: 0, y: 0, w: 1, h: 1 }, size: 1, position: 'top' },
    b: { asset: 'image-1', frame: { x: 0.5, y: 0.5, w: 0.9, h: 0.5 }, size: 0.1, position: 'sideways' },
    c: { asset: 'image-2', frame: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, size: 0.5, position: 'left' },
    d: { asset: 'image-1', frame: { x: NaN, y: 0, w: 1, h: 1 }, size: NaN }
  };
  const build = overrides => plain(format.buildSharePayload(map, notesById, options({ covers, ...overrides }))).nodes.map(n => n.cover);
  assert.deepEqual(build(), [{ asset: 'image-1' }, { asset: 'image-1' }, undefined, { asset: 'image-1' }], 'defaults and unusable values are not written; an asset that is not in the file gives no cover');
  assert.deepEqual(build({ assets: { 'image-2': 'data:image/webp;base64,AA' } })[2], { asset: 'image-2', frame: [0.1, 0.2, 0.3, 0.4], size: 0.5, position: 'left' });
  assert.deepEqual(build({ includeImages: false }), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(build({ includeDetail: false }), [undefined, undefined, undefined, undefined]);
  assert.equal('layout' in plain(format.buildSharePayload(map, notesById, options({}))), false);
  assert.equal('images' in plain(format.buildSharePayload(map, notesById, options({}))), false);
});

test('sharing leak: external-path blocks an outside data folder root (as typed and real) anywhere in the payload; a clean payload passes', () => {
  const external = ['/Users/someone/Research/client-research', '/Volumes/Real/client-research'];
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', mapFolder: 'Private Vault Folder/Share Map', externalPaths: external }, fixtureMap(), []);
  const categories = fields => new Set(scan.scanPayloadForLeaks(payloadWith(fields), forbidden).map(hit => hit.category));
  assert.ok(categories({ summary: 'from /Users/someone/Research/client-research/a.md' }).has('external-path'));
  assert.ok(categories({ detailHtml: '<code>/Volumes/Real/client-research</code>' }).has('external-path'), 'code is scanned too');
  assert.ok(!categories({ summary: 'from client-research/a.md' }).has('external-path'), 'the label alone is fine');
  assert.ok(!categories({ summary: 'plain' }).has('external-path'));
  assert.ok(scan.forbiddenStringsFor({ mapFolder: 'M' }, { nodes: [] }, []).every(item => item.category !== 'external-path'));
});

test('sharing leak: an outside folder path containing & is found through HTML entities (text, attribute value, code and pre), raw or encoded', () => {
  const forbidden = scan.forbiddenStringsFor({ mapFolder: 'Private Vault Folder/Share Map', externalPaths: ['/outside/R&D', "/outside/a'b"] }, fixtureMap(), []);
  const categories = fields => new Set(scan.scanPayloadForLeaks(payloadWith(fields), forbidden).map(hit => hit.category));
  for (const html of ['<p>/outside/R&amp;D/a.md</p>', '<a title="/outside/R&amp;D">x</a>', '<code>/outside/R&amp;D</code>', '<pre>/outside/R&#38;D</pre>', '<p>/outside/R&#x26;D</p>', '<p>/outside/a&#39;b</p>', '<p>/outside/R&D</p>'])
    assert.ok(categories({ detailHtml: html }).has('external-path'), html);
  assert.ok(!categories({ detailHtml: '<p>/outside/R&amp;E and R&amp;D alone</p>' }).has('external-path'));
  assert.equal(scan.decodeHtmlEntities('a&amp;lt;b &unknown; &#0;'), 'a&lt;b &unknown; &#0;', 'one pass, unknown references stay');
});

test('sharing leak: an entity-encoded wikilink is found after decoding; code and an encoded matrix row stay allowed', () => {
  const forbidden = scan.forbiddenStringsFor({ mapFolder: 'Private Vault Folder/Share Map' }, fixtureMap(), []);
  const categories = fields => new Set(scan.scanPayloadForLeaks(payloadWith(fields), forbidden).map(hit => hit.category));
  for (const html of ['<p>&#91;&#91;Secret note]]</p>', '<p>&#x5b;&#X5B;Secret note&#93;&#93;</p>', '<p>&lsqb;&lbrack;Secret note]]</p>', '<p>&#91&#91Secret note]]</p>', '<p>[&#91;Secret note]]</p>'])
    assert.ok(categories({ detailHtml: html }).has('wikilink'), html);
  assert.ok(categories({ summary: '&#91;&#91;Secret note]]' }).has('wikilink'), 'plain string fields too');
  assert.ok(!categories({ detailHtml: '<code>&#91;&#91;Secret note]]</code>' }).has('wikilink'), 'code stays allowed');
  assert.ok(!categories({ detailHtml: '<p>&#91;&#91;2,0],[0,1]]</p>' }).has('wikilink'), 'a matrix row stays allowed');
  assert.equal(scan.decodeHtmlEntities('&#91&#93;&rsqb;&rbrack;'), '[]]]');
});

test('sharing leak: a path under a VAM folder (note-style backup) blocks; the bare folder name and other text do not', () => {
  const forbidden = scan.forbiddenStringsFor(
    { mapFolder: 'Agent Workspace/Mind Maps/數學在幹嘛', internalFolders: ['Agent Workspace', '/Agent Workspace/Mind Maps/', 'Agent Workspace/筆記風格', ' '] },
    fixtureMap(),
    []
  );
  assert.ok(forbidden.some(item => item.category === 'vault-folder' && item.value === 'Agent Workspace/'));
  assert.ok(!forbidden.some(item => item.category === 'vault-folder' && item.value === '/'), 'a blank folder adds nothing');
  const categories = fields => new Set(scan.scanPayloadForLeaks(payloadWith(fields), forbidden).map(hit => hit.category));
  const line = '<p>2026-11-22　已重新寫入，舊版備份在 Agent Workspace/筆記風格/備份/筆記/線性代數 2026-11-22 171239.md</p>';
  assert.ok(categories({ detailHtml: line }).has('vault-folder'));
  assert.ok(categories({ detailHtml: '<p>Agent&#32;Workspace&#47;Topics/x.md</p>' }).has('vault-folder'), 'encoded too');
  assert.ok(!categories({ detailHtml: '<p>The Agent Workspace holds your maps.</p>' }).has('vault-folder'));
});

test('sharing leak: long numeric references and &sol; / &colon; decode as a browser reads them', () => {
  assert.equal(scan.decodeHtmlEntities('&#00000091;&#x000005b;&sol;&colon;&#99999999999;'), '[[/:&#99999999999;');
  const forbidden = scan.forbiddenStringsFor({ mapFolder: 'M', internalFolders: ['Agent Workspace'] }, fixtureMap(), []);
  const categories = fields => new Set(scan.scanPayloadForLeaks(payloadWith(fields), forbidden).map(hit => hit.category));
  assert.ok(categories({ detailHtml: '<p>Agent Workspace&sol;x.md</p>' }).has('vault-folder'));
  assert.ok(categories({ detailHtml: '<p>app&colon;//x</p>' }).has('app-url'));
});

test('sharing clean: the write-back\'s own backup log line is removed (any note language, callout or list); an edited line or code stays', () => {
  const md = [
    '> [!note]- 研究備註',
    '>',
    '> 2026-11-22　已重新寫入，舊版備份在 Agent Workspace/筆記風格/備份/筆記/線性代數 2026-11-22 171239.md',
    '> - 2026-11-20　Rewritten; the earlier version is backed up at Agent Workspace/Note styles/Backups/Notes/x 2026-11-20 012627 (2).md',
    '2026-11-18　已重新寫入，舊版備份在 A/b 2026-11-18 233604.md',
    '> 2026-11-22　已重新寫入，舊版備份在 Agent Workspace/筆記風格/備份/筆記/線性代數 2026-11-22 171239.md，我刪過一段',
    '```',
    '2026-11-22　已重新寫入，舊版備份在 Agent Workspace/x 2026-11-22 171239.md',
    '```',
    'body'
  ].join('\n');
  const out = cleanMd(md).markdown;
  assert.ok(!out.includes('線性代數 2026-11-22 171239.md\n'), 'own zh-TW line gone');
  assert.ok(!out.includes('012627 (2).md') && !out.includes('233604.md'), 'en list item and a line outside a callout gone');
  assert.ok(out.includes('171239.md，我刪過一段'), 'an edited line stays for the leak gate');
  assert.ok(out.includes('Agent Workspace/x 2026-11-22 171239.md'), 'code stays');
  assert.ok(out.includes('> [!note]- 研究備註') && out.includes('body'));
});

// share-complete P1: kind, shape, relations, boundaries, free pictures. Only whitelisted values travel; plain text only.
test('sharing complete: kind and shape take whitelisted values only; rounded and topic are not written', () => {
  const { notesById } = cleanedNotes();
  const ids = Object.keys(notesById);
  const withNote = (id, extra) => ({ ...notesById, [id]: { ...notesById[id], ...extra } });
  const build = notes => format.buildSharePayload(fixtureMap(), notes, options());
  const base = build(notesById);
  assert.ok(base.nodes.every(node => !('kind' in node) && !('shape' in node)), 'no new data, no new keys');
  assert.ok(!format.serializeShareJson(base).includes('relations') && !format.serializeShareJson(base).includes('boundaries'));
  const good = build(withNote(ids[0], { kind: 'hypothesis', shape: 'diamond' })).nodes[0];
  assert.equal(good.kind, 'hypothesis');
  assert.equal(good.shape, 'diamond');
  for (const [kind, shape] of [['topic', 'rounded'], ['<img onerror=1>', 'url(x)'], [42, {}], ['__proto__', 'circle'], ['Hypothesis', 'RECT']]) {
    const node = build(withNote(ids[0], { kind, shape })).nodes[0];
    assert.ok(!('kind' in node) && !('shape' in node), `${String(kind)}/${String(shape)} is dropped`);
  }
});

test('sharing complete: relations keep known kinds with both ends in the file; unknown kind, missing end, self link and markup stay out', () => {
  const { notesById } = cleanedNotes();
  const map = fixtureMap();
  const [a, b] = map.nodes.map(node => node.id);
  const evil = '</script><img src=x onerror=alert(1)>[[private/path]]';
  map.topicRelations = [
    { kind: 'supports', from: a, to: b, description: ` line one\n  two ${evil} ` },
    { kind: 'cites', from: a, to: b },
    { kind: 'related', from: a, to: 'gone' },
    { kind: 'related', from: 'gone', to: b },
    { kind: 'related', from: a, to: a },
    { kind: 'contradicts', from: b, to: a, description: 'x'.repeat(500) },
    null,
    { kind: 'verifies', from: 7, to: b }
  ];
  const payload = format.buildSharePayload(map, notesById, options({ plainText: text => text.replace(/\[\[([^\]]+)\]\]/g, '$1') }));
  assert.equal(payload.version, 1);
  assert.equal(payload.relations.length, 2);
  assert.deepEqual(plain(payload.relations[0]), { kind: 'supports', from: a, to: b, description: `line one two ${evil.replace('[[private/path]]', 'private/path')}` });
  assert.equal(payload.relations[1].description.length, 200);
  const json = format.serializeShareJson(payload);
  assert.ok(!json.includes('</script') && !json.includes('<!--') && !json.includes('<img'), 'every < is escaped');
  assert.equal(JSON.parse(json).relations[0].description.includes('<img src=x'), true, 'kept as text, never as markup');
});

test('sharing complete: boundaries keep members present in the file; a frame with none left is not written; the label is plain text', () => {
  const { notesById } = cleanedNotes();
  const map = fixtureMap();
  const [a, b] = map.nodes.map(node => node.id);
  map.canvasItems = [
    { id: 'bd1', kind: 'boundary', members: [a, 'gone', b, a], label: '<b>Group</b> [[x]]' },
    { id: 'bd2', kind: 'boundary', members: ['gone'] },
    { id: 'bd3', kind: 'boundary', members: [a] },
    { id: 'bd1', kind: 'boundary', members: [b] },
    { id: 'img1', kind: 'image', path: 'Secret/vault/pic.png', x: 1, y: 2, w: 30, h: 40 },
    { id: 'bd4', kind: 'boundary', members: ['img1', 'ghost'] }
  ];
  const payload = format.buildSharePayload(map, notesById, options({ plainText: text => text.replace(/\[\[([^\]]+)\]\]/g, '$1') }));
  assert.deepEqual(plain(payload.boundaries), [{ id: 'bd1', members: [a, b], label: '<b>Group</b> x' }, { id: 'bd3', members: [a] }, { id: 'bd4', members: ['img1'] }]);
  const json = format.serializeShareJson(payload);
  assert.ok(!json.includes('Secret/vault') && !json.includes('"path"'), 'a free picture never carries its vault path');
  assert.deepEqual(plain(payload.images), [{ id: 'img1', x: 1, y: 2, w: 30, h: 40, anchors: [], free: true }], 'a free picture without an attached file is listed without an asset');
});

test('sharing complete: image links carry a whitelisted kind and plain description; an unknown kind is left out of the link only', () => {
  const { notesById } = cleanedNotes();
  const map = fixtureMap();
  const [a, b] = map.nodes.map(node => node.id);
  map.canvasItems = [
    { id: 'im', kind: 'annotated-image', path: 'p.png', x: 0, y: 0, w: 10, h: 10, anchors: [{ id: 'p1', at: { kind: 'image-2d', x: 0.5, y: 0.5 } }], relations: [
      { kind: 'supports', from: 'p1', to: a, description: ' why ' },
      { kind: 'bogus', from: 'p1', to: b, description: '</script>' }
    ] }
  ];
  const links = format.buildSharePayload(map, notesById, options()).images[0].links;
  assert.deepEqual(plain(links), [{ anchor: 'p1', topic: a, kind: 'supports', description: 'why' }, { anchor: 'p1', topic: b, description: '</script>' }]);
});

// ---- share-complete P3: links between the notes of one map ----
const nodeLinks = load('experiences/sharing/share-node-links.ts');
const supportHtml = require('../support-html-dom.cjs');
const applyLinks = (html, ids) => {
  const root = supportHtml.parse(html);
  nodeLinks.applyNodeLinks(root, new Set(ids), () => new supportHtml.El('a', root.ownerDocument));
  return supportHtml.serialize(root);
};
const markdownOf = (md, nodeIdOf) => clean.cleanShareMarkdown(md, { titleOf: target => (target === 'Water' ? 'Water in food' : undefined), nodeIdOf, assets: clean.createAssetRegistry() }).markdown;

test('share node links: a wikilink to a map card is marked, a non-map wikilink stays plain text', () => {
  const idOf = target => (target === 'Water' ? 'water' : undefined);
  const md = markdownOf('See [[Water]], [[Water|the wet one]] and [[Elsewhere]] and [[#Heading]].', idOf);
  const html = applyLinks(`<p>${md}</p>`, ['water']);
  assert.match(html, /<a class="vam-node-link" href="#vam-node-water">Water in food<\/a>/);
  assert.match(html, /<a class="vam-node-link" href="#vam-node-water">the wet one<\/a>/);
  assert.ok(html.includes('and Elsewhere and Heading.'), 'no link for a target that is not a card');
  assert.ok(!/[-]/.test(html), 'no mark character is left');
  assert.equal((html.match(/<a /g) ?? []).length, 2);
});

test('share node links: private-use characters typed by the author cannot forge a link', () => {
  const md = markdownOf('Clickwater and [[Water]]', target => (target === 'Water' ? 'water' : undefined));
  assert.ok(!/Click/.test(md), 'the forged marks are gone from the markdown');
  const html = applyLinks(`<p>${md}</p>`, ['water']);
  assert.equal((html.match(/<a /g) ?? []).length, 1, 'only the real wikilink became a link');
  assert.ok(html.includes('Clickwater'), 'the forged text stays plain');
  // A mark that reaches the html anyway (a renderer that split it, an id not in the file, an unsafe id) ends as text.
  assert.ok(!/<a /.test(applyLinks('<p>xghost</p>', ['water'])));
  assert.equal(applyLinks('<p>x"onmouseover=1</p>', ['"onmouseover=1']), '<p>x</p>');
  assert.equal(nodeLinks.markNodeLink('a b', 'T'), 'T', 'an id outside the safe charset is not marked');
  assert.equal(applyLinks('<p><a href="https://example.org">xwater</a></p>', ['water']), '<p><a href="https://example.org">x</a></p>', 'no link inside a link');
});

test('share node links: the generated link carries only href and class', () => {
  const root = supportHtml.parse('<p>Twater</p>');
  nodeLinks.applyNodeLinks(root, new Set(['water']), () => new supportHtml.El('a', root.ownerDocument));
  const link = root.childNodes[0].childNodes[0];
  assert.equal(link.localName, 'a');
  assert.deepEqual([...link.attrs.keys()].sort(), ['class', 'href']);
});

// ---- P4: inline note embeds ----
const embeds = load('experiences/sharing/share-embeds.ts');
const NOTE = '---\ntitle: Source\n---\nIntro line\n\n# Top\nTop text\n## Part A\nA text ![[Other]] and ![[pic.png]]\n### Deep\nDeep text\n## Part B\nB text\n\nA block para ^blk1\n\n- item one ^li1\n  - child\n- item two\n';
const embedCtx = (map, extra = {}) => ({ titleOf: t => ({ Source: 'Source Title', Other: 'Other Title' })[t], assets: clean.createAssetRegistry(), embedOf: t => map[t], ...extra });

test('sharing embeds: whole note without frontmatter, heading section to the next same-or-higher heading, block paragraph and list item', () => {
  const whole = embeds.extractEmbedContent(NOTE, '');
  assert.ok(whole.startsWith('Intro line') && !whole.includes('title: Source'));
  assert.equal(embeds.extractEmbedContent(NOTE, 'Part A'), '## Part A\nA text [[Other]] and ![[pic.png]]\n### Deep\nDeep text');
  assert.equal(embeds.extractEmbedContent(NOTE, 'part   b'), '## Part B\nB text\n\nA block para ^blk1\n\n- item one ^li1\n  - child\n- item two', 'case and spacing are ignored; the section runs to the end');
  assert.equal(embeds.extractEmbedContent(NOTE, '^blk1'), 'A block para');
  assert.equal(embeds.extractEmbedContent(NOTE, '^li1'), '- item one\n  - child');
  assert.equal(embeds.extractEmbedContent(NOTE, 'Missing'), undefined);
  assert.equal(embeds.extractEmbedContent(NOTE, '^nope'), undefined);
  assert.equal(embeds.extractEmbedContent('```\n# Not heading\n```\n# Real\nx', 'Not heading'), undefined, 'a # line in a code fence is not a heading');
  assert.equal(embeds.extractEmbedContent('---\na: 1\n---\n', ''), undefined, 'an empty note shows nothing');
  assert.equal(embeds.extractEmbedContent('Line one\r\n\r\nPara ^b\r\n', '^b'), 'Para', 'CRLF');
});

test('sharing embeds: the cleaner puts the content in a vam-embed callout; nested note embeds become titles, images stay', () => {
  const content = embeds.extractEmbedContent(NOTE, 'Part A');
  const out = clean.cleanShareMarkdown('Before\n\n![[Source#Part A]]\n\nAfter', embedCtx({ 'Source#Part A': content }, { embedTitle: t => `Embedded: ${t}` }));
  assert.equal(out.markdown, 'Before\n\n\n\n> [!vam-embed] Embedded: Source Title\n> ## Part A\n> A text Other Title and ![](vam-asset:image-1)\n> ### Deep\n> Deep text\n\n\n\nAfter');
  assert.deepEqual(plain(out.attachments), [{ ref: 'pic.png', name: 'image-1' }]);
});

test('sharing embeds: no content (self, cycle, not found) keeps the title only; an embed in the middle of a line is cut into its own block', () => {
  assert.equal(clean.cleanShareMarkdown('See ![[Source]] now', embedCtx({})).markdown, 'See Source Title now');
  const mid = clean.cleanShareMarkdown('See ![[Source]] now', embedCtx({ Source: 'Body' })).markdown;
  assert.match(mid, /^See \n\n> \[!vam-embed\] Source Title\n> Body\n\n now$/);
});

test('sharing embeds: embedded content gets the same cleaning (private links, local reference definitions, writeback lines, marks), and the embed does not recurse', () => {
  const body = 'Link [[private/Path/Secret]] and [x](Private/Folder/y.md)\n\n[ref]: Private/z.md\n\n![[Other]]';
  const out = clean.cleanShareMarkdown('![[Source]]', embedCtx({ Source: embeds.extractEmbedContent(body, '') }, { embedOf: t => ({ Source: embeds.extractEmbedContent(body, ''), Other: 'LOOP' })[t] }));
  assert.ok(!out.markdown.includes('private/Path') && !out.markdown.includes('Private/') && !out.markdown.includes('LOOP'), out.markdown);
  assert.match(out.markdown, /> Link Secret and x/);
  assert.match(out.markdown, /> Other Title/);
});

test('sharing embeds: the embed box title and content survive a script or iframe in the embedded text only as text that the scrub later drops (leak scan has nothing to find)', () => {
  const out = clean.cleanShareMarkdown('![[Source]]', embedCtx({ Source: '<script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>' }));
  assert.match(out.markdown, /> <script>alert\(1\)<\/script>/);
  assert.match(out.markdown, /\[!vam-embed\]/);
});

// ---- share-complete P5: file attachment cards ----
const attachCtx = extra => ({ titleOf: () => undefined, assets: clean.createAssetRegistry(), attachmentOf: ref => (ref.endsWith('.pdf') ? 'file-1' : undefined), ...extra });

test('sharing attachments: a file embed becomes a mark that carries the name; without the hook it stays the escaped file name', () => {
  const md = clean.cleanShareMarkdown('See ![[Docs/Sub/report.pdf]] here', attachCtx()).markdown;
  assert.ok(md.startsWith('See ') && md.includes('file-1'), md);
  assert.ok(!md.includes('Docs/') && !md.includes('Sub'), 'only the base name is in the text');
  assert.equal(clean.cleanShareMarkdown('See ![[Docs/report.pdf]]', { titleOf: () => undefined, assets: clean.createAssetRegistry() }).markdown, 'See report.pdf');
  assert.equal(clean.cleanShareMarkdown('![[a.mp4]]', attachCtx()).markdown, 'a.mp4', 'a file the hook refuses stays text');
});

test('sharing attachments: the card carries only href and class; an unknown name, a mark inside a link or typed by the author gives plain text', () => {
  const applyCards = (html, names) => {
    const root = supportHtml.parse(html);
    nodeLinks.applyNodeLinks(root, new Set(), () => new supportHtml.El('a', root.ownerDocument), new Set(names));
    return supportHtml.serialize(root);
  };
  const mark = nodeLinks.markAttachment('file-1', 'r.pdf');
  const html = applyCards(`<p>${mark}</p>`, ['file-1']);
  assert.equal(html, '<p><a class="vam-attachment-card" href="#vam-attachment-file-1">r.pdf</a></p>');
  assert.equal(applyCards(`<p>${mark}</p>`, ['file-2']), '<p>r.pdf</p>', 'a name the file does not have is text');
  assert.equal(applyCards(`<p><a href="https://e.example">${mark}</a></p>`, ['file-1']), '<p><a href="https://e.example">r.pdf</a></p>');
  assert.equal(nodeLinks.markAttachment('a"b', 'x'), 'x', 'an unsafe name is not marked');
  // The author types the marks: cleaning strips them, so no card is forged.
  const typed = clean.cleanShareMarkdown('evil.exefile-1 and ![[x.pdf]]', attachCtx()).markdown;
  assert.equal((typed.match(//g) ?? []).length, 1, 'only the real embed keeps its mark');
});

test('sharing attachments: payload lists the file name only; bytes only with notes and images on; wrong prefix or no entry gives no asset; old maps are unchanged', () => {
  const { notesById } = cleanedNotes();
  const OCT = 'data:application/octet-stream;base64,QUJD';
  const files = [{ name: 'file-1', file: 'Private/Folder/report.pdf', size: 3 }, { name: 'file-2', file: 'x.html', size: 5 }, { name: 'bad name', file: 'z', size: 1 }];
  const withData = format.buildSharePayload(fixtureMap(), notesById, options({ attachments: files, assets: { 'file-1': OCT, 'file-2': 'data:text/html;base64,QUJD' } }));
  assert.deepEqual(plain(withData.attachments), [{ name: 'file-1', file: 'report.pdf', size: 3, asset: 'file-1' }, { name: 'file-2', file: 'x.html', size: 5 }]);
  assert.ok(!JSON.stringify(withData).includes('Private/Folder'), 'no vault path in the file');
  const noImages = format.buildSharePayload(fixtureMap(), notesById, options({ includeImages: false, attachments: files, assets: { 'file-1': OCT } }));
  assert.ok(noImages.attachments.every(item => !('asset' in item)));
  assert.equal(noImages.assets['file-1'], undefined);
  const noDetail = format.buildSharePayload(fixtureMap(), notesById, options({ includeDetail: false, attachments: files }));
  assert.equal('attachments' in noDetail, false);
  const old = format.buildSharePayload(fixtureMap(), notesById, options());
  assert.equal('attachments' in old, false);
  assert.equal(format.serializeShareJson(old), format.serializeShareJson(format.buildSharePayload(fixtureMap(), notesById, options({ attachments: [] }))));
  assert.equal(format.SHARE_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
});

test('sharing embeds: embedded file references are anchored to the embedded note own folder; internal or missing files become plain text', () => {
  const resolve = ref => ({ '../img/x.png': 'Notes/img/x.png', 'a.pdf': 'Notes/Sub/a.pdf', 'Agent/s.png': null })[ref] ?? null;
  const out = embeds.anchorEmbeddedFiles('![[../img/x.png|cap]] ![](../img/x.png) ![[a.pdf]] ![[Agent/s.png]] ![](Agent/s.png) ![w](https://e.example/p.png) ![[Note]] ![[gone.png]]\n```\n![[a.pdf]]\n```', resolve);
  assert.ok(out.startsWith('![[Notes/img/x.png|cap]] ![[Notes/img/x.png]] ![[Notes/Sub/a.pdf]] '), out);
  assert.ok(!out.includes('Agent/s.png') && !out.includes('![[gone.png]]') && !out.includes('![[../img'), out);
  assert.ok(out.includes('![w](https://e.example/p.png)') && out.includes('![[Note]]'));
  assert.ok(out.endsWith('```\n![[a.pdf]]\n```'), 'code is left alone');
});

// ---- share-complete P6: video and other media ----
const media = load('experiences/sharing/share-media.ts');
const videoCore = load('core/video-embeds.ts');
const viewerVideo = load('experiences/sharing/viewer/video.ts');
const mediaLabels = { label: (kind, host) => `${{ video: 'Video', audio: 'Audio', embed: 'Embedded' }[kind]}${host ? `: ${host}` : ''}` };
const mediaOf = html => {
  const root = supportHtml.parse(html);
  media.replaceMediaWithLinks(root, mediaLabels, tag => new supportHtml.El(tag, root.ownerDocument));
  return supportHtml.serialize(root);
};

test('share media: iframe, video, audio, embed and object with a web source become a link card with the host', () => {
  assert.equal(mediaOf('<iframe src="https://evil.example/x"></iframe>'), '<a class="vam-media-link" href="https://evil.example/x">Embedded: evil.example</a>');
  assert.equal(mediaOf('<video src="http://www.cdn.example/v.mp4" controls></video>'), '<a class="vam-media-link" href="https://www.cdn.example/v.mp4">Video: cdn.example</a>');
  assert.equal(mediaOf('<video><source src="https://cdn.example/v.webm" type="video/webm"></video>'), '<a class="vam-media-link" href="https://cdn.example/v.webm">Video: cdn.example</a>');
  assert.equal(mediaOf('<audio src="https://cdn.example/a.mp3"></audio>'), '<a class="vam-media-link" href="https://cdn.example/a.mp3">Audio: cdn.example</a>');
  assert.equal(mediaOf('<embed src="//cdn.example/e.swf"><object data="https://cdn.example/o"></object>'), '<a class="vam-media-link" href="https://cdn.example/e.swf">Embedded: cdn.example</a><a class="vam-media-link" href="https://cdn.example/o">Embedded: cdn.example</a>');
});

test('share media: a source that is not a web address is visible text with no link and no address', () => {
  for (const src of ['javascript:alert(1)', 'file:///Users/me/secret.mp4', 'data:text/html;base64,AAAA', 'app://abc/v.mp4', 'obsidian://open?vault=V', ' java\nscript:x']) {
    const out = mediaOf(`<p>before</p><iframe src="${src}"></iframe><video src="${src}"></video>`);
    assert.ok(!/<a |href|<iframe|<video|src=/.test(out), out);
    assert.ok(/Embedded/.test(out) && /Video/.test(out), `visible, not silent: ${out}`);
    assert.ok(!/secret|Users|alert/.test(out), `no address leaks: ${out}`);
  }
  assert.equal(mediaOf('<video></video>'), '<span class="vam-media-text">Video</span>', 'a media element with no source is a label too');
  assert.equal(mediaOf('<p>plain <a href="https://example.org">link</a></p>'), '<p>plain <a href="https://example.org">link</a></p>', 'other content is untouched');
});

test('share media: the video mark makes only the cleaner\'s own https link a video link; an author class never survives', () => {
  const marked = `<p><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">${nodeLinks.VIDEO_MARK}▶ Cat</a> <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">plain</a> <a class="vam-video-link x" href="https://youtu.be/dQw4w9WgXcQ">forged</a> <a href="javascript:x">${nodeLinks.VIDEO_MARK}bad</a></p>`;
  const out = applyLinks(marked, []);
  assert.ok(out.includes('<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" class="vam-video-link">▶ Cat</a>'), out);
  assert.ok(out.includes('<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">plain</a>'), 'an author link stays plain');
  assert.ok(out.includes('<a class="x" href="https://youtu.be/dQw4w9WgXcQ">forged</a>'), 'a hand-written video class is removed');
  assert.ok(out.includes('<a href="javascript:x">bad</a>') && !/[\uE000-\uE004]/.test(out), 'the mark is gone everywhere, a non-https link gets no class');
  assert.equal(nodeLinks.stripNodeLinkMarks(`a${nodeLinks.VIDEO_MARK}b`), 'ab');
  assert.ok(!clean.cleanShareMarkdown(`x${nodeLinks.VIDEO_MARK}y`, { titleOf: () => undefined, assets: clean.createAssetRegistry() }).markdown.includes(nodeLinks.VIDEO_MARK), 'typed marks are stripped from the author text');
});

test('share viewer video: the viewer id parser agrees with the plugin parser on every address', () => {
  const urls = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'http://youtube.com/watch?v=dQw4w9WgXcQ&t=5', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?si=x', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ', 'https://www.youtube.com/v/dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://youtu.be.evil.example/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload=1', 'https://www.youtube.com/watch', 'https://youtu.be/', 'javascript:alert(1)', 'ftp://youtu.be/dQw4w9WgXcQ', 'not a url', '', ' https://youtu.be/dQw4w9WgXcQ '];
  for (const url of urls) assert.equal(viewerVideo.viewerYoutubeId(url), videoCore.youtubeVideoId(url), url);
  assert.equal(viewerVideo.viewerYoutubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(viewerVideo.viewerYoutubeId('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ'), null);
});

// ---- share-complete P6b: math as MathML ----
const shareMath = load('experiences/sharing/share-math.ts');
const viewerMath = load('experiences/sharing/viewer/math.ts');
const outer = el => { const d = new supportHtml.El('div', supportHtml.parse('').ownerDocument); d.append(el); return supportHtml.serialize(d); };
const mathDeps = (mml, extra = {}) => ({
  tex2mml: mml === undefined ? undefined : () => mml,
  parse: text => supportHtml.parse(text).children.find(el => el.localName === 'math') ?? null,
  create: name => new supportHtml.El(name, supportHtml.parse('').ownerDocument),
  ...extra
});
const HOSTILE_MML = '<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline" class="x" style="color:red" onload="evil()" href="javascript:evil()"><semantics><mrow><msup onclick="e()" href="https://e.example" style="x:y"><mi mathvariant="italic" class="c">x</mi><mn>2</mn></msup><maction actiontype="toggle"><mi>HIDDEN</mi></maction><mfrac linethickness="2"><mn>1</mn><mn>3</mn></mfrac><script>alert(1)</script></mrow><annotation encoding="application/x-tex">x^2 LATEX</annotation><annotation-xml encoding="x"><mi>AXML</mi></annotation-xml></semantics></math>';

test('share math: the whitelist keeps structure and drops maction, href, annotation-xml, annotation, onload, style, class and script', () => {
  const math = shareMath.mathFromLatex('x^2', false, mathDeps(HOSTILE_MML));
  const out = outer(math);
  assert.ok(out.includes('<msup>') && out.includes('<mfrac linethickness="2">') && out.includes('mathvariant="italic"'), out);
  assert.ok(!/maction|HIDDEN|AXML|LATEX|annotation|alert|script|href|onload|onclick|style|class=|xmlns|javascript/i.test(out), out);
  assert.ok(!out.includes('display='), 'inline math carries no display attribute');
});

test('share math: block math gets display="block"; the namespace factory is used for every element', () => {
  const made = [];
  const math = shareMath.mathFromLatex('x', true, mathDeps(HOSTILE_MML, { create: name => (made.push(name), new supportHtml.El(name, supportHtml.parse('').ownerDocument)) }));
  assert.equal(math.getAttribute('display'), 'block');
  assert.ok(made.includes('math') && made.includes('msup') && !made.includes('maction') && !made.includes('script'), made.join());
});

test('share math: no MathJax, a throwing tex2mml, an empty or non-math result, or empty LaTeX gives null (the caller shows the source)', () => {
  assert.equal(shareMath.mathFromLatex('x^2', false, mathDeps(undefined)), null);
  assert.equal(shareMath.mathFromLatex('x^2', false, mathDeps('', {})), null);
  assert.equal(shareMath.mathFromLatex('x^2', false, mathDeps('<p>no math</p>')), null);
  assert.equal(shareMath.mathFromLatex('x^2', false, mathDeps('<math></math>')), null);
  assert.equal(shareMath.mathFromLatex('x^2', false, mathDeps('<math><mi>x</mi></math>', { tex2mml: () => { throw new Error('boom'); } })), null);
  assert.equal(shareMath.mathFromLatex('  ', false, mathDeps('<math><mi>x</mi></math>')), null);
});

test('share math: an unknown element is unwrapped (its text kept), text stays text', () => {
  const math = shareMath.mathFromLatex('x', false, mathDeps('<math><mrow><foo><mi>a&lt;b</mi></foo></mrow></math>'));
  assert.equal(outer(math), '<math><mrow><mi>a&lt;b</mi></mrow></math>');
});

test('viewer math: the viewer whitelist is the same lists as share-math, and it cleans a hand-edited file', () => {
  assert.deepEqual(plain(viewerMath.VIEWER_MATHML_ELEMENTS), plain(shareMath.MATHML_ELEMENTS));
  assert.deepEqual(plain(viewerMath.VIEWER_MATHML_ATTRIBUTES), plain(shareMath.MATHML_ATTRIBUTES));
  const root = supportHtml.parse('<p>a <math display="block" onload="x()"><msup class="c"><mi>x</mi><mn>2</mn></msup><maction><mi>H</mi></maction><mfrac><mn>1</mn><mn>2</mn></mfrac><annotation-xml><mi>A</mi></annotation-xml></math></p>');
  viewerMath.cleanViewerMath(root);
  assert.equal(supportHtml.serialize(root), '<p>a <math display="block"><msup><mi>x</mi><mn>2</mn></msup><mfrac><mn>1</mn><mn>2</mn></mfrac></math></p>');
});

test('share math: MathML carries no link, so the local-reference count and the leak scan see nothing in it', () => {
  const math = shareMath.mathFromLatex('x', false, mathDeps(HOSTILE_MML));
  const html = outer(math);
  assert.ok(!/href|src=|http|file:|app:/i.test(html), html);
});

// ---- R2: commented embeds stay hidden, markdown file embeds become cards ----
const readsOf = () => { const reads = []; return { reads, ctx: extra => ({ titleOf: () => undefined, assets: clean.createAssetRegistry(), embedOf: t => { reads.push(t); return 'body'; }, attachmentOf: ref => reads.push(`att:${ref}`) && 'file-1', ...extra }) }; };

test('sharing R2: an embed inside %% or <!-- --> is left untouched: no expansion, no read, no asset or attachment', () => {
  const { reads, ctx } = readsOf();
  for (const md of ['%% ![[Draft]] %%', 'see <!-- ![[D2]] --> now', 'a\n%%\nx ![[Draft]]\n![[pic.png]] ![[f.pdf]] ![](a.png)\n%%\nb', '<!--\n![[D2]]\n-->']) {
    const out = clean.cleanShareMarkdown(md, ctx());
    assert.equal(out.markdown, md);
    assert.ok(!out.markdown.includes('vam-embed') && !out.attachments.length);
  }
  assert.deepEqual(reads, []);
  const open = clean.cleanShareMarkdown('x ![[Draft]]', ctx()).markdown;
  assert.ok(open.includes('[!vam-embed]'), 'outside a comment it still expands');
  assert.equal(clean.cleanShareMarkdown('`%%` ![[Draft]] `%%`', ctx()).markdown.includes('[!vam-embed]'), true, '%% in code opens no comment');
});

test('sharing R2: embedded content drops comments (outside code) before it is quoted', () => {
  assert.equal(embeds.extractEmbedContent('Public %%private remark%% tail', ''), 'Public  tail');
  assert.equal(embeds.extractEmbedContent('A\n%%\n![[Draft]]\nsecret\n%%\nB', ''), 'A\n\nB');
  assert.equal(embeds.extractEmbedContent('x <!-- secret --> y', ''), 'x  y');
  assert.equal(embeds.extractEmbedContent('`%% keep %%` and ```a %% b```', ''), '`%% keep %%` and ```a %% b```');
  assert.equal(embeds.extractEmbedContent('```\n%% keep %%\n```', ''), '```\n%% keep %%\n```');
});

test('sharing R2: ![](doc.pdf) is an attachment card, not an image asset', () => {
  const out = clean.cleanShareMarkdown('![](Docs/doc.pdf) ![x](p.png)', attachCtx());
  assert.ok(out.markdown.includes('file-1') && !out.markdown.includes('vam-asset:image-1](') , out.markdown);
  assert.ok(!/!\[\]\(vam-asset:/.test(out.markdown) && /\(vam-asset:image-1\)/.test(out.markdown), out.markdown);
  assert.equal(clean.cleanShareMarkdown('![](doc.pdf)', { titleOf: () => undefined, assets: clean.createAssetRegistry() }).markdown, 'doc.pdf');
});
