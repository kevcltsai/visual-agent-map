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

test('stripLivingNodeMarkers: imported marker comments become plain text, region content is not treated as an owned region', () => {
  const out = red.stripLivingNodeMarkers('a\n<!-- vam-living-node:begin v1 -->\nowned?\n<!--   VAM-LIVING-NODE:end v1 -->\nb');
  assert.ok(!/vam-living-node/i.test(out) && !out.includes('<!--'));
  assert.ok(out.includes('owned?') && out.startsWith('a') && out.endsWith('b'));
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
