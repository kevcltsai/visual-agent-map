// Living Node share/import redaction: the share projection of a Living Node body never carries private paths, signed-URL secrets,
// suppression/draft/ownership fields or embeds of notes that are not shared; Living Node markers in imported text become plain text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const { load } = support;
const red = load('experiences/sharing/living-node-redaction.ts');
const embeds = load('experiences/sharing/share-embeds.ts');

const SIGNED = 'https://bucket.s3.amazonaws.com/a/file.pdf?X-Amz-Algorithm=AWS4&X-Amz-Signature=abc123&X-Amz-Credential=AKIA%2Fx&page=2';

test('redactLivingShareText: signed-URL secret params are dropped, the address stays', () => {
  const out = red.redactLivingShareText(`> see ${SIGNED}\n> and https://a.example/p?token=SECRET&id=7#top and https://b.example/?sig=1&Signature=2&key=3&expires=4`);
  assert.ok(out.includes('https://bucket.s3.amazonaws.com/a/file.pdf') && !out.includes('page=2'));
  assert.ok(out.includes('https://a.example/p') && !out.includes('id=7'));
  assert.ok(out.includes('https://b.example/'));
  for (const secret of ['abc123', 'AKIA', 'SECRET', 'X-Amz', 'sig=', 'Signature', 'key=', 'expires']) assert.ok(!out.includes(secret), secret);
});

test('redactLivingShareText: vault-absolute and home paths are removed, web addresses with similar segments are kept', () => {
  const out = red.redactLivingShareText('> read /Users/kevin/Vault/Notes/a.md and C:\\Users\\kevin\\Vault\\b.md and file:///home/kevin/v/c.md\n> https://site.example/Users/guide stays');
  for (const leak of ['/Users/kevin', 'C:\\Users', '/home/kevin', 'a.md', 'b.md', 'c.md']) assert.ok(!out.includes(leak), leak);
  assert.ok(out.includes('https://site.example/Users/guide'));
});

test('redactLivingShareText: suppression, draft and ownership fields and Living Node markers are removed', () => {
  const out = red.redactLivingShareText([
    '> claim kept',
    '> living-node-ownership: ai',
    '> "suppressed": ["old claim"]',
    '- suppressed: private reason',
    'draft: true',
    '<!-- vam-living-node:begin v1 -->',
    '> inside',
    '<!-- vam-living-node:end v1 -->',
    '<!-- vam-living-node:claim {"id":1} -->',
    '> tail kept'
  ].join('\n'));
  assert.ok(out.includes('claim kept') && out.includes('tail kept'));
  for (const leak of ['ownership', 'suppressed', 'old claim', 'private reason', 'draft', 'vam-living-node', 'inside']) assert.ok(!out.includes(leak), leak);
});

test('redactLivingShareText: ordinary text without any of these is unchanged', () => {
  const text = '> A claim about https://a.example/p?id=7 with `/Users/x` in code is fine\n> 第二行';
  assert.equal(red.redactLivingShareText('> plain 句子 [[Link]]\n> https://a.example/p'), '> plain 句子 [[Link]]\n> https://a.example/p');
  assert.ok(red.redactLivingShareText(text).includes('第二行'));
});

test('shareNoteMarkdown: the Living Node projection is redacted, the ordinary detail is untouched', () => {
  const detail = 'Ordinary /Users/kevin/x.md ?token=keep stays as written';
  const out = embeds.shareNoteMarkdown({ detail, livingNode: { shareMarkdown: `> out ${SIGNED}\n> /Users/kevin/Vault/a.md\n> ![[Private/Diary#H]] and ![[pic.png]]` } });
  assert.ok(out.startsWith(detail));
  assert.ok(!out.includes('abc123') && !out.includes('/Users/kevin/Vault') && !out.includes('![[Private') && out.includes('[[Private/Diary#H]]') && !out.includes('![[pic.png]]'));
  assert.equal(embeds.shareNoteMarkdown({ detail: 'only' }), 'only');
});

test('redactLivingShareText: the whole query and fragment of every web address go, whatever the parameter names or encoding', () => {
  const out = red.redactLivingShareText([
    '> https://storage.googleapis.com/b/o?X-Goog-Signature=GSIG&X-Goog-Credential=GCRED',
    '> https://x.blob.core.windows.net/c/f?sv=2022&sig=SASSIG&se=2030',
    '> https://api.example/p?access_token=ATOK&id=7#frag',
    '> https://a.example/p?x=1&amp;Signature=AMPSIG&amp;y=2',
    '> https://a.example/p?x=1&#38;sig=NUMSIG',
    '> https://en.wikipedia.org/wiki/Foo_(bar)?token=PARSECRET#sec',
    '> (see https://a.example/q?auth=PAREN) end',
    '> http://a.example:8080/z?;key=SEMI'
  ].join('\n'));
  for (const secret of ['GSIG', 'GCRED', 'SASSIG', 'sv=', 'ATOK', 'frag', 'AMPSIG', 'NUMSIG', 'PARSECRET', '#sec', 'PAREN', 'SEMI', '?']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('https://en.wikipedia.org/wiki/Foo_(bar)') && out.includes('(see https://a.example/q) end') && out.includes('http://a.example:8080/z'));
});

test('shareNoteMarkdown: an unclosed code fence in the detail cannot hide a Living Node embed (every embed there is a plain link, also in code)', () => {
  const out = embeds.shareNoteMarkdown({ detail: 'Intro\n```js\nunclosed', livingNode: { shareMarkdown: '> ![[Private/Diary]]\n> ```\n> ![[Other]]' } });
  assert.ok(!out.includes('![[') && out.includes('[[Private/Diary]]') && out.includes('[[Other]]'));
  const mixed = embeds.shareNoteMarkdown({ detail: '```\nopen', livingNode: { shareMarkdown: '> ![[Private]]' } });
  assert.ok(!mixed.includes('![[Private]]'));
});

test('redactLivingShareText: paths with spaces, drive paths, home paths and the vault base path are removed to the line end or closing bracket', () => {
  const out = red.redactLivingShareText('> a /Users/k/My Vault/Secret.md\n> b D:\\Obsidian\\Vault\\x.md\n> c (~/Notes/My Dir/y.md) kept\n> d /srv/data/My Vault/z.md here\n> e [/Users/k/My Vault/Other.md] f', '/srv/data/My Vault');
  for (const leak of ['Secret', 'Obsidian', 'D:', '~/', 'Notes', 'y.md', 'z.md', 'Other', '/srv/data', '/Users/k']) assert.ok(!out.includes(leak), leak);
  assert.ok(out.includes(') kept') && out.includes('] f'));
});

test('redactLivingShareText: scheme-less www addresses lose their query too, and redacting twice changes nothing', () => {
  const once = red.redactLivingShareText('> www.example.com/p?token=WWWSECRET#x and ![[Note]]');
  assert.ok(!once.includes('WWWSECRET') && once.includes('www.example.com/p'));
  assert.equal(red.redactLivingShareText(once), once);
});

// The producer redacts once; the OPML/FreeMind export, the share summary and body and the clipboard text all read these two fields.
const living = load('experiences/visual-map/living-node-markdown.ts', { obsidian: support.obsidian });
const { commitLivingMarkdown } = living;
async function liveNote() {
  const f = support.fixture();
  f.app.vault.adapter.getBasePath = () => '/srv/vaults/Main Vault';
  const initial = '---\nagent-map-id: map\ntopic-id: map\nnode-id: card\nai-card: true\n---\n# Title\n\n## Detail\n\nBody.\n';
  await f.app.vault.create('card.md', initial);
  const claim = 'See https://s3.example.com/f?X-Goog-Signature=GSECRET and /srv/vaults/Main Vault/Private/a.md and ![[Private/Diary]]';
  const base = { revision: 'empty', records: [], suppressed: [], output: { text: '', owner: 'ai', evidence: [] } };
  const candidate = { executionId: 'e1', cardId: 'card', mapId: 'map', baseRevision: living.livingSnapshotRevision(initial), inputRevision: 'i1', viewSession: 'v1' };
  await commitLivingMarkdown(f.repo, { path: 'card.md', expectedContent: initial, base, proposal: { baseRevision: 'empty', operations: [{ kind: 'output', text: claim, evidence: [] }] },
    context: { at: '2026-11-27T04:00:00+08:00', evidence: [] }, signal: new AbortController().signal, isCurrent: () => true, candidate,
    inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) });
  return { note: await f.repo.readNote('card.md'), f };
}
const LEAKS = ['GSECRET', 'X-Goog', '/srv/vaults', 'Private', '![['];
const assertClean = (text, where) => { for (const leak of LEAKS) assert.ok(!text.includes(leak), `${where}: ${leak}`); };

test('Repository.readNote: Living Node shareMarkdown and summary leave no signed URL, local path or note embed', async () => {
  const { note } = await liveNote();
  for (const field of [note.livingNode.shareMarkdown, note.livingNode.shareSummary]) {
    assert.ok(field.length > 0);
    assertClean(field, 'field');
  }
  // The user's own screen keeps what they wrote.
  assert.ok(note.livingNode.summary.includes('GSECRET') && note.livingNode.summary.includes('/srv/vaults'));
});

test('consumer: OPML and FreeMind export of a Repository-read Living Node carries no signed URL, local path or embed', async () => {
  const { note, f } = await liveNote();
  const io = load('experiences/visual-map/outline-exchange-io.ts', { obsidian: support.obsidian });
  for (const folder of ['Agent Workspace', 'Agent Workspace/Topics', 'Agent Workspace/Topics/map-x']) await f.app.vault.createFolder(folder);
  for (const format of ['opml', 'freemind']) {
    const out = await io.exportMapExchange(f.app.vault, { mapPath: 'Agent Workspace/Topics/map-x/Map.md', map: { title: 'Map', nodes: [{ id: 'r', parentId: null }] }, notes: new Map([['r', note]]), format });
    const text = f.contents.get(out);
    assert.ok(text.includes('See https://s3.example.com/f'), format);
    assertClean(text, format);
  }
});

test('consumer: the share export payload summary and body of a Repository-read Living Node carry no signed URL, local path or embed', async () => {
  const { note } = await liveNote();
  class FileSystemAdapter { getBasePath() { return '/srv/vaults/Main Vault'; } }
  const module = load('experiences/sharing/share-exporter.ts', { obsidian: { ...support.obsidian, FileSystemAdapter, Component: class { load() {} unload() {} addChild() {} removeChild() {} } } });
  const map = { id: 'map-1', title: 'Map', outputLanguage: 'en', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', path: 'Folder/A.md', parentId: null, x: 0, y: 0, collapsed: false }] };
  const run = new module.ShareExporter({ vault: { adapter: new FileSystemAdapter(), getName: () => 'V' } }, { map, notes: new Map([['a', note]]), mapPath: 'Folder/Map.md' }, { vamVersion: '1', language: 'en' })
    .assemble({ includeDetail: false, includeImages: false });
  assert.deepEqual(support.plain(run.leakCategories), []);
  assert.ok(run.payload.nodes[0].summary.includes('See https://s3.example.com/f'));
  assertClean(JSON.stringify(run.payload), 'payload');
});
