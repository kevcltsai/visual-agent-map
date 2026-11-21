// Packet A2: the cover block of a note (plan §3 items 2, 4, 5, 9; §6 data-migration): compose, read, put, strip, ownership, source key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const block = S.load('core/book-pipeline/cover-block.ts');
const dedupe = S.load('core/book-pipeline/image-dedupe.ts');
const card = S.load('experiences/visual-map/card-cover.ts', { obsidian: { parseYaml: S.obsidian?.parseYaml ?? (() => ({})), stringifyYaml: () => '' } });
const plain = value => JSON.parse(JSON.stringify(value));
const URL1 = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Mona_Lisa.jpg';
const PAGE = 'https://commons.wikimedia.org/wiki/File:Mona_Lisa.jpg';
const FILE = 'Books/B/封面圖/第一章-1234abcd.jpg';
const found = (extra = {}) => ({ file: FILE, url: URL1, caption: '蒙娜麗莎，達文西作', sourceUrl: PAGE, ...extra });
const note = (body, front = 'title: 第一章') => `---\n${front}\n---\n${body}`;
const BODY = '## Current Summary\n\n摘要\n\n## Detail\n\ntext\n';

test('composeCoverBlock found: embed, caption, Commons file page as the source, marker with file, key and hash', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const lines = text.split('\n');
  assert.match(lines[0], /^<!-- book-cover:v1 \{"file":"Books\/B\/封面圖\/第一章-1234abcd\.jpg","key":"mona_lisa\.jpg","hash":"[0-9a-f]{16}"\} -->$/);
  assert.deepEqual(lines.slice(1), [`![[${FILE}]]`, '蒙娜麗莎，達文西作', `來源：[Wikimedia Commons](${PAGE})`, '<!-- book-cover:end -->']);
  assert.ok(!text.includes('這張圖可能對不上'));
  assert.equal(block.composeCoverBlock('chapter', 'en', found()).split('\n').at(-2), `Source: [Wikimedia Commons](${PAGE})`);
});

test('composeCoverBlock off: "這張圖可能對不上" follows the caption (en has its own sentence)', () => {
  const zh = block.composeCoverBlock('chapter', 'zh', found({ off: true })).split('\n');
  assert.deepEqual(zh.slice(2, 4), ['蒙娜麗莎，達文西作', '這張圖可能對不上']);
  assert.ok(block.composeCoverBlock('book', 'en', found({ off: true })).includes('\nThis picture may not match.\n'));
});

test('composeCoverBlock not found: only the line of the card level, in both languages, no embed and no file in the marker', () => {
  const want = { chapter: '這一章沒找到合適的封面圖。', section: '這一節沒找到合適的封面圖。', book: '這本書沒找到合適的封面圖。' };
  for (const level of ['chapter', 'section', 'book']) {
    const text = block.composeCoverBlock(level, 'zh');
    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[1], want[level]);
    assert.ok(!text.includes('![[') && !/"file"/.test(lines[0]));
    assert.match(block.composeCoverBlock(level, 'en').split('\n')[1], new RegExp(`^No suitable cover picture was found for this ${level === 'chapter' ? 'chapter' : level === 'section' ? 'section' : 'book'}\\.$`));
  }
});

test('composeCoverBlock: a caption cannot open Markdown, a source that is not a Commons file page (or not https) makes it undefined, an unusable file name too', () => {
  const nasty = block.composeCoverBlock('chapter', 'zh', found({ caption: '![x](http://evil)\n## 標題 <b>x</b> %%hide%%' })).split('\n');
  assert.equal(nasty.length, 5, 'the caption stays one line');
  assert.ok(!/^#|<b>|%%|\]\(http/.test(nasty[2]), nasty[2]);
  for (const sourceUrl of ['http://commons.wikimedia.org/wiki/File:A.jpg', 'https://evil.com/wiki/File:A.jpg', 'https://commons.wikimedia.org/wiki/Special:FilePath/A.jpg', 'https://u:p@commons.wikimedia.org/wiki/File:A.jpg', '', 'javascript:alert(1)'])
    assert.equal(block.composeCoverBlock('chapter', 'zh', found({ sourceUrl })), undefined, sourceUrl);
  assert.equal(block.composeCoverBlock('chapter', 'zh', found({ file: '' })), undefined);
  const piped = block.composeCoverBlock('chapter', 'zh', found({ file: 'a|b]]c.jpg' }));
  assert.ok(piped.includes('![[a b  c.jpg]]'), piped);
  assert.equal(block.coverLinkOf('a|b]]c.jpg'), 'a b  c.jpg');
  assert.ok(!block.composeCoverBlock('chapter', 'zh', found({ caption: '-->' })).slice(0, -22).includes('-->\n-->'));
});

test('readCoverBlock: file, key, missing and intact; an edited caption is not intact; damaged or fenced markers are not blocks; CRLF reads the same', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const raw = note(`# 第一章\n\n${text}\n\n${BODY}`);
  const read = block.readCoverBlock(raw);
  assert.deepEqual(plain({ file: read.file, key: read.key, missing: read.missing, intact: read.intact }), { file: FILE, key: 'mona_lisa.jpg', missing: false, intact: true });
  assert.equal(raw.slice(read.from, read.to), text);
  assert.equal(block.readCoverBlock(raw.replace('蒙娜麗莎', '別的')).intact, false);
  assert.equal(block.readCoverBlock(raw.replace(`![[${FILE}]]`, '![[other.jpg]]')).intact, false);
  assert.equal(block.readCoverBlock(raw.replace(/\n/g, '\r\n')).intact, true, 'CRLF');
  const miss = block.readCoverBlock(note(`# T\n\n${block.composeCoverBlock('book', 'zh')}\n`));
  assert.deepEqual([miss.missing, miss.intact, miss.file, miss.key], [true, true, undefined, undefined]);
  assert.equal(block.readCoverBlock(note('# T\n\n<!-- book-cover:v1 {broken -->\nx\n<!-- book-cover:end -->\n')), undefined);
  assert.equal(block.readCoverBlock(note('# T\n\n<!-- book-cover:v1 {"hash":"x"} -->\nno end marker\n')), undefined);
  assert.equal(block.readCoverBlock(note('# T\n\n```\n' + text + '\n```\n')), undefined, 'fenced');
  assert.equal(block.readCoverBlock(note('# T\n\n' + BODY)), undefined);
});

test('coverSourceKey: the key of the placed picture; none for a not-found block or a note without one; it equals imageKey of the picture address', () => {
  const raw = note(`# T\n\n${block.composeCoverBlock('chapter', 'zh', found())}\n\n${BODY}`);
  assert.equal(block.coverSourceKey(raw), dedupe.imageKey(URL1));
  assert.equal(block.coverSourceKey(raw), dedupe.imageKey('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mona_Lisa.jpg/1280px-Mona_Lisa.jpg'), 'original and thumbnail are one picture');
  assert.equal(block.coverSourceKey(note(`# T\n\n${block.composeCoverBlock('chapter', 'zh')}\n`)), undefined);
  assert.equal(block.coverSourceKey(note('# T\n')), undefined);
});

test('putCoverBlock: directly under the title (frontmatter kept, one blank line each side), replaces an earlier block, idempotent; stripCoverBlock undoes it', () => {
  const plainNote = note(`# 第一章\n\n${BODY}`);
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const put = block.putCoverBlock(plainNote, text);
  assert.equal(put, note(`# 第一章\n\n${text}\n\n${BODY}`));
  assert.equal(block.putCoverBlock(put, text), put, 'idempotent');
  assert.equal(block.stripCoverBlock(put), plainNote, 'strip restores the original');
  const other = block.composeCoverBlock('chapter', 'zh');
  const swapped = block.putCoverBlock(put, other);
  assert.equal(swapped, note(`# 第一章\n\n${other}\n\n${BODY}`));
  assert.equal(swapped.split('book-cover:v1').length - 1, 1, 'one block');
  // A block that wandered down the note comes back under the title.
  assert.equal(block.putCoverBlock(note(`# 第一章\n\n${BODY}\n${text}\n`), text).indexOf('book-cover:v1') < block.putCoverBlock(note(`# 第一章\n\n${BODY}\n${text}\n`), text).indexOf('## Current Summary'), true);
  // Only the first heading level 1 outside a fence counts; no title: unchanged.
  assert.equal(block.putCoverBlock('no title here\n', text), 'no title here\n');
  assert.equal(block.putCoverBlock(note('```\n# not a title\n```\n'), text), note('```\n# not a title\n```\n'));
  // A title that ends the file, an empty note body, CRLF.
  assert.equal(block.putCoverBlock('# T', text), `# T\n\n${text}\n`);
  const crlf = block.putCoverBlock(note(`# T\n\n${BODY}`).replace(/\n/g, '\r\n'), text);
  assert.ok(!/[^\r]\n/.test(crlf), 'every line break stays CRLF');
  assert.equal(block.readCoverBlock(crlf).intact, true);
});

test('stripCoverBlock: a note without a block comes back as the same string', () => {
  const raw = note(`# T\n\n${BODY}`);
  assert.equal(block.stripCoverBlock(raw), raw);
});

test('coverOwnership: none, program and owner (plan §6): topic-cover none/other file/no block, an edited block, a missing block with a hand-set cover', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const missing = block.composeCoverBlock('chapter', 'zh');
  const withBlock = (front, blockText) => note(`# T\n\n${blockText}\n\n${BODY}`, front);
  assert.equal(block.coverOwnership(note(`# T\n\n${BODY}`)), 'none');
  assert.equal(block.coverOwnership(withBlock('title: T', missing)), 'program');
  assert.equal(block.coverOwnership(withBlock(`title: T\ntopic-cover: "[[${FILE}]]"`, text)), 'program');
  assert.equal(block.coverOwnership(withBlock(`title: T\ntopic-cover: "[[${FILE}|alias]]"`, text)), 'program');
  assert.equal(block.coverOwnership(withBlock('title: T', text)), 'program', 'the key was only removed, the block is still ours');
  assert.equal(block.coverOwnership(withBlock('title: T\ntopic-cover: "none"', text)), 'owner');
  assert.equal(block.coverOwnership(withBlock('title: T\ntopic-cover: none', missing)), 'owner');
  assert.equal(block.coverOwnership(withBlock('title: T\ntopic-cover: "[[Mine/own.png]]"', text)), 'owner');
  assert.equal(block.coverOwnership(withBlock('title: T\ntopic-cover: "[[Mine/own.png]]"', missing)), 'owner');
  assert.equal(block.coverOwnership(note(`# T\n\n${BODY}`, 'title: T\ntopic-cover: "[[Mine/own.png]]"')), 'owner', 'topic-cover without a block');
  assert.equal(block.coverOwnership(note(`# T\n\n${BODY}`, 'title: T\ntopic-cover: "none"')), 'owner');
  assert.equal(block.coverOwnership(withBlock(`title: T\ntopic-cover: "[[${FILE}]]"`, text.replace('蒙娜麗莎', '改過'))), 'owner', 'edited caption');
  assert.equal(block.coverOwnership(withBlock('title: T', missing.replace('沒找到', '沒找到(改)'))), 'owner', 'edited not-found line');
});

test('coverOwnership agrees with withCover: the link withCover writes is the link the block names', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const raw = card.withCover(note(`# T\n\n${text}\n\n${BODY}`, 'title: T'), FILE);
  assert.match(raw, /topic-cover: "?\[\[Books\/B\/封面圖\/第一章-1234abcd\.jpg\]\]"?/);
  assert.equal(block.coverOwnership(raw), 'program');
  assert.equal(block.coverOwnership(card.withCoverOff(raw)), 'owner');
});
