// Living Node share/import redaction: the share projection of a Living Node body never carries private paths, signed-URL secrets,
// suppression/draft/ownership fields or embeds of notes that are not shared; Living Node markers in imported text become plain text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const { load } = support;
const red = load('experiences/sharing/living-node-redaction.ts');
const embeds = load('experiences/sharing/share-embeds.ts');

const SIGNED = 'https://bucket.s3.amazonaws.com/a/file.pdf?X-Amz-Algorithm=AWS4&X-Amz-Signature=abc123&X-Amz-Credential=AKIA%2Fx&page=2';

test('redactLivingShareText: signed-URL secret params are dropped, harmless params and the address stay', () => {
  const out = red.redactLivingShareText(`> see ${SIGNED}\n> and https://a.example/p?token=SECRET&id=7#top and https://b.example/?sig=1&Signature=2&key=3&expires=4`);
  assert.ok(out.includes('https://bucket.s3.amazonaws.com/a/file.pdf?page=2'));
  assert.ok(out.includes('https://a.example/p?id=7#top'));
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
  assert.equal(red.redactLivingShareText('> plain 句子 [[Link]]\n> https://a.example/p?id=7'), '> plain 句子 [[Link]]\n> https://a.example/p?id=7');
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
  assert.ok(!out.includes('abc123') && !out.includes('/Users/kevin/Vault') && !out.includes('![[Private') && out.includes('[[Private/Diary#H]]') && out.includes('![[pic.png]]'));
  assert.equal(embeds.shareNoteMarkdown({ detail: 'only' }), 'only');
});
