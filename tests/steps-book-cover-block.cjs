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

test('composeCoverBlock: a caption of only dashes or equals signs is escaped so it cannot turn the embed line into a setext heading', () => {
  for (const caption of ['---', '===', '-', '=', '--']) {
    const lines = block.composeCoverBlock('chapter', 'zh', found({ caption })).split('\n');
    assert.match(lines[2], /^\\[-=][-=]*$/, caption);
  }
  assert.equal(block.composeCoverBlock('chapter', 'zh', found({ caption: 'a---b' })).split('\n')[2], 'a---b');
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

test('trustedCoverBlock / stripAllCoverBlocks: only a block directly under the title of the note as it was is trusted; every block (also a repeated or forged one) can be stripped; a fenced one is neither', () => {
  const blockText = block.composeCoverBlock('chapter', 'zh');
  const note = `---\ntitle: T\n---\n# T\n\n${blockText}\n\n## 目前摘要\n\nx\n`;
  assert.equal(block.trustedCoverBlock(note), blockText);
  const moved = `---\ntitle: T\n---\n# T\n\n## 目前摘要\n\nx\n\n${blockText}\n`;
  assert.equal(block.trustedCoverBlock(moved), undefined, 'a block not directly under the title is not trusted');
  assert.equal(block.trustedCoverBlock('# T\n\nno block\n'), undefined);
  const edited = note.replace('沒找到', '沒找到（我改的）');
  assert.match(block.trustedCoverBlock(edited), /我改的/, 'an owner-edited block under the title is the note\'s own text');
  const twice = `# T\n\n${blockText}\n\n${blockText}\n\ntext\n`;
  assert.ok(!/book-cover/.test(block.stripAllCoverBlocks(twice)));
  const fenced = '# T\n\n```\n' + blockText + '\n```\n';
  assert.equal(block.stripAllCoverBlocks(fenced), fenced); assert.equal(block.trustedCoverBlock(fenced), undefined);
});

// ---- 2026-11-22-book-cover-placement: the cover record lives in the frontmatter key `book-cover` ----
const REC = { file: FILE, key: 'mona_lisa.jpg', caption: '蒙娜麗莎，達文西作' };
const recNote = (rec, front = 'title: T', body = `# T\n\n${BODY}`) => block.setCoverRecord(note(body, front), rec);

test('setCoverRecord / readCoverRecord: a placed record and a not-found record round-trip; the line is one YAML string with no space in the JSON', () => {
  const raw = recNote(REC);
  const line = /^book-cover: .*$/m.exec(raw)[0];
  assert.match(line, /^book-cover: "\{\\"file\\":/);
  assert.ok(!/ /.test(line.slice('book-cover: '.length)), 'no space for a YAML writer to fold at');
  assert.deepEqual(plain(block.readCoverRecord(raw)), { file: FILE, key: 'mona_lisa.jpg', caption: '蒙娜麗莎，達文西作', missing: false, off: false });
  assert.deepEqual(plain(block.readCoverRecord(recNote({ ...REC, off: 1 }))), { file: FILE, key: 'mona_lisa.jpg', caption: '蒙娜麗莎，達文西作', missing: false, off: true });
  assert.deepEqual(plain(block.readCoverRecord(recNote({ missing: 1 }))), { missing: true, off: false });
  assert.equal(block.coverSourceKey(raw), 'mona_lisa.jpg');
  assert.equal(block.coverSourceKey(recNote({ missing: 1 })), undefined);
  // The body is not touched, and writing again replaces the one line.
  assert.equal(raw.slice(raw.indexOf('\n---\n')), `\n---\n# T\n\n${BODY}`);
  const again = block.setCoverRecord(raw, { missing: 1 });
  assert.equal(again.split('\nbook-cover: ').length - 1, 1);
  assert.equal(block.readCoverRecord(again).missing, true);
});

test('readCoverRecord: a tidy that turned the line single-quoted or plain still reads; damaged, empty or half records are no record; CRLF and no frontmatter', () => {
  const json = JSON.stringify(REC);
  assert.equal(block.readCoverRecord(note('# T\n', `title: T\nbook-cover: '${json}'`)).file, FILE);
  assert.equal(block.readCoverRecord(note('# T\n', `title: T\nbook-cover: ${json}`)).file, FILE);
  for (const bad of ['"nope"', '{broken', '"{\\"file\\":\\"\\",\\"key\\":\\"k\\"}"', '"{\\"file\\":\\"a.png\\"}"', '""', '']) assert.equal(block.readCoverRecord(note('# T\n', `title: T\nbook-cover: ${bad}`)), undefined, bad);
  const crlf = recNote(REC).replace(/\n/g, '\r\n');
  assert.equal(block.readCoverRecord(crlf).file, FILE);
  assert.ok(!/[^\r]\n/.test(block.setCoverRecord(crlf, { missing: 1 })), 'every line break stays CRLF');
  const bare = block.setCoverRecord('# T\n', { missing: 1 });
  assert.equal(bare, '---\nbook-cover: "{\\"missing\\":1}"\n---\n# T\n');
  assert.equal(block.readCoverRecord(note('# T\n')), undefined);
});

test('readCoverRecord: the record wins over an old block; an old block alone is read as before (with the block attached)', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const old = block.readCoverRecord(note(`# T\n\n${text}\n\n${BODY}`));
  assert.deepEqual(plain({ file: old.file, key: old.key, missing: old.missing, off: old.off, intact: old.block.intact }), { file: FILE, key: 'mona_lisa.jpg', missing: false, off: false, intact: true });
  const both = block.setCoverRecord(note(`# T\n\n${text}\n\n${BODY}`), { file: 'new.png', key: 'k2' });
  assert.equal(block.readCoverRecord(both).file, 'new.png');
  assert.equal(block.readCoverRecord(both).block, undefined);
});

test('placeCover: takes the old block out and records the cover; a note with no block only gets the key; idempotent', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const placed = block.placeCover(note(`# 第一章\n\n${text}\n\n${BODY}`), REC);
  assert.ok(!/book-cover:(?:v1|end)/.test(placed));
  assert.equal(placed.slice(placed.indexOf('\n---\n')), `\n---\n# 第一章\n\n${BODY}`);
  assert.equal(block.readCoverRecord(placed).file, FILE);
  assert.equal(block.placeCover(placed, REC), placed);
  assert.equal(block.placeCover(note(`# 第一章\n\n${BODY}`), REC), recNote(REC, 'title: 第一章', `# 第一章\n\n${BODY}`));
});

test('coverOwnership with the record: placed + same/no topic-cover is the program\'s, another file or none is the owner\'s; not found is the program\'s only without topic-cover', () => {
  const placed = front => recNote(REC, front);
  assert.equal(block.coverOwnership(placed('title: T')), 'program', 'topic-cover removed: still ours');
  assert.equal(block.coverOwnership(placed(`title: T\ntopic-cover: "[[${FILE}]]"`)), 'program');
  assert.equal(block.coverOwnership(placed(`title: T\ntopic-cover: "[[${FILE}|alias]]"`)), 'program');
  assert.equal(block.coverOwnership(placed('title: T\ntopic-cover: "[[Mine/own.png]]"')), 'owner');
  assert.equal(block.coverOwnership(placed('title: T\ntopic-cover: none')), 'owner');
  assert.equal(block.coverOwnership(recNote({ missing: 1 })), 'program');
  assert.equal(block.coverOwnership(recNote({ missing: 1 }, 'title: T\ntopic-cover: "[[Mine/own.png]]"')), 'owner');
  assert.equal(block.coverOwnership(recNote({ missing: 1 }, 'title: T\ntopic-cover: none')), 'owner');
  // Old blocks keep their hash rule (the older tests above); an edited one is the owner's even with a record absent.
  const edited = block.composeCoverBlock('chapter', 'zh', found()).replace('蒙娜麗莎', '改過');
  assert.equal(block.coverOwnership(note(`# T\n\n${edited}\n\n${BODY}`, `title: T\ntopic-cover: "[[${FILE}]]"`)), 'owner');
  // The same ownership of the same picture with the owner's withCover frame setting.
  assert.equal(block.coverOwnership(card.withCover(placed('title: T'), FILE)), 'program');
});

test('coverIsOff: the record\'s flag counts while the cover is still the program\'s; an old intact block\'s flag too; an edited block or a re-pointed cover does not', () => {
  assert.equal(block.coverIsOff(recNote({ ...REC, off: 1 })), true);
  assert.equal(block.coverIsOff(recNote(REC)), false);
  assert.equal(block.coverIsOff(recNote({ ...REC, off: 1 }, 'title: T\ntopic-cover: "[[Mine/own.png]]"')), false);
  const off = block.composeCoverBlock('chapter', 'zh', found({ off: true }));
  assert.equal(block.coverIsOff(note(`# T\n\n${off}\n`)), true);
  assert.equal(block.coverIsOff(note(`# T\n\n${off.replace('可能對不上', '可能對不上（看過）')}\n`)), false);
  assert.equal(block.coverIsOff(note('# T\n')), false);
});

test('migrateLegacyCover: the program\'s intact block becomes the record and its credit; not found becomes {missing}; an edited block, a note with a record, no block or no readable source stay', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found({ off: true }));
  const moved = block.migrateLegacyCover(note(`# T\n\n${text}\n\n${BODY}`), 'zh-TW', '第一章');
  assert.deepEqual(plain(moved.record), { file: FILE, key: 'mona_lisa.jpg', caption: '蒙娜麗莎，達文西作', source: PAGE, off: 1 });
  assert.equal(moved.credit.href, PAGE);
  assert.equal(moved.credit.entry, `圖「蒙娜麗莎，達文西作」（封面）：commons.wikimedia.org（[連結](${PAGE})）`);
  const en = block.migrateLegacyCover(note(`# T\n\n${block.composeCoverBlock('chapter', 'en', found())}\n`), 'en', 'Chapter');
  assert.match(en.credit.entry, /^Picture “蒙娜麗莎，達文西作” \(cover\): commons\.wikimedia\.org \(\[link\]\(https:\/\/commons\.wikimedia\.org\/wiki\/File:Mona_Lisa\.jpg\)\)$/);
  const noCaption = block.migrateLegacyCover(note(`# T\n\n${block.composeCoverBlock('chapter', 'zh', found({ caption: '' }))}\n`), 'zh-TW', '第一章');
  assert.equal(noCaption.record.caption, undefined);
  assert.match(noCaption.credit.entry, /^圖「第一章」（封面）：/, 'the card\'s title stands in for a missing caption');
  const paren = block.migrateLegacyCover(note(`# T\n\n${block.composeCoverBlock('chapter', 'zh', found({ sourceUrl: 'https://commons.wikimedia.org/wiki/File:A_(b).jpg' }))}\n`), 'zh-TW', 'T');
  assert.equal(paren.credit.href, 'https://commons.wikimedia.org/wiki/File:A_%28b%29.jpg');
  assert.ok(paren.credit.entry.includes('File:A_%28b%29.jpg)'), 'parentheses are encoded in the link');
  assert.deepEqual(plain(block.migrateLegacyCover(note(`# T\n\n${block.composeCoverBlock('chapter', 'zh')}\n`), 'zh-TW', 'T')), { record: { missing: 1 } });
  assert.equal(block.migrateLegacyCover(note(`# T\n\n${text.replace('蒙娜麗莎', '改過')}\n`), 'zh-TW', 'T'), undefined, 'edited');
  assert.equal(block.migrateLegacyCover(block.setCoverRecord(note(`# T\n\n${text}\n`), { missing: 1 }), 'zh-TW', 'T'), undefined, 'a record exists');
  assert.equal(block.migrateLegacyCover(note(`# T\n\n${BODY}`), 'zh-TW', 'T'), undefined, 'no block');
  assert.equal(block.migrateLegacyCover(recNote(REC), 'zh-TW', 'T'), undefined, 'record only');
  const crlf = block.migrateLegacyCover(note(`# T\n\n${text}\n\n${BODY}`).replace(/\n/g, '\r\n'), 'zh-TW', 'T');
  assert.equal(crlf.credit.href, PAGE, 'CRLF');
});

test('placeCover: an old block that is not intact (edited or pasted by the owner) stays exactly as it is next to the record', () => {
  const text = block.composeCoverBlock('chapter', 'zh', found());
  const edited = text.replace('蒙娜麗莎', '我改的');
  const raw = block.setCoverRecord(note(`# T\n\n${edited}\n\n${BODY}`), { file: 'a.png', key: 'k' });
  const placed = block.placeCover(raw, { file: 'b.png', key: 'k2' });
  assert.equal(block.trustedCoverBlock(placed), edited);
  assert.equal(block.readCoverRecord(placed).file, 'b.png');
  assert.ok(placed.includes(`\n${edited}\n`));
});

test('removeCoverCredit: only the cover credit line of that Commons page goes; body-picture credits, other covers and other text stay', () => {
  const entry = `- 圖「大教堂」（封面）：commons.wikimedia.org（[連結](${PAGE})）`;
  const body = `- 圖「大教堂」：commons.wikimedia.org（[連結](${PAGE})）`;
  const other = '- 圖「別的」（封面）：commons.wikimedia.org（[連結](https://commons.wikimedia.org/wiki/File:Other.jpg)）';
  const detail = `正文\n\n## 來源\n\n${entry}\n${body}\n${other}\n- 我自己的來源\n`;
  assert.equal(block.removeCoverCredit(detail, PAGE, 'zh-TW'), `正文\n\n## 來源\n\n${body}\n${other}\n- 我自己的來源\n`);
  assert.equal(block.removeCoverCredit(detail, 'https://commons.wikimedia.org/wiki/File:None.jpg', 'zh-TW'), detail);
  const reworded = detail.replace('（封面）', '（我的封面）');
  assert.ok(block.removeCoverCredit(reworded, PAGE, 'zh-TW').includes('（我的封面）'), 'a line the owner reworded is not our shape and stays');
});
