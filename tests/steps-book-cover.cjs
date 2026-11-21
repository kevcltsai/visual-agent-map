// Packet A1: the pure cover functions (plan §6 security): the Wikimedia-only candidate filter, the thumbnail address, the file name and path, the magic-byte sniff, the cover line.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const cover = S.load('core/book-pipeline/cover.ts');
const slots = S.load('core/book-pipeline/image-slots.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const ORIGINAL = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Mona_Lisa.jpg';
const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mona_Lisa.jpg/1280px-Mona_Lisa.jpg';

test('constants: slot index 0, 5 MB cap, the off token', () => {
  assert.equal(cover.COVER_INDEX, 0);
  assert.equal(cover.COVER_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(cover.coverOffToken, 'cover:off');
});

test('coverCandidates keeps only https upload.wikimedia.org/wikipedia/commons (exact host, no userinfo, no port, no http)', () => {
  const ok = [ORIGINAL, THUMB, 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/A.png/800px-A.png'];
  const bad = [
    'http://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
    'https://upload.wikimedia.org.evil.com/wikipedia/commons/a/ab/X.jpg',
    'https://evil.com/upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
    'https://user:pw@upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
    'https://user@upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
    'https://upload.wikimedia.org:8443/wikipedia/commons/a/ab/X.jpg',
    'https://upload.wikimedia.org/wikipedia/en/a/ab/X.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/../en/a/ab/X.jpg',
    'https://upload.wikimedia.org/wikipedia/commonsx/a/ab/X.jpg',
    'https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg',
    'https://UPLOAD.wikimedia.org.evil.com/wikipedia/commons/a/ab/X.jpg',
    'ftp://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg',
    'not a url', '', 'javascript:alert(1)'
  ];
  const got = cover.coverCandidates([...ok, ...bad].map(url => ({ url, title: url })));
  assert.deepEqual(got.map(c => c.url), ok);
});

test('coverDownloadUrl: builds the 1280px thumbnail from an original or a thumb address; svg gets .png; other types and bad shapes give undefined', () => {
  assert.equal(cover.coverDownloadUrl(ORIGINAL), THUMB);
  assert.equal(cover.coverDownloadUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mona_Lisa.jpg/320px-Mona_Lisa.jpg'), THUMB);
  assert.equal(cover.coverDownloadUrl('https://upload.wikimedia.org/wikipedia/commons/3/3a/Map.svg'), 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Map.svg/1280px-Map.svg.png');
  assert.equal(cover.coverDownloadUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Map.svg/200px-Map.svg.png'), 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Map.svg/1280px-Map.svg.png');
  assert.equal(cover.coverDownloadUrl('https://upload.wikimedia.org/wikipedia/commons/1/1a/Photo.webp'), 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Photo.webp/1280px-Photo.webp');
  for (const bad of ['https://upload.wikimedia.org/wikipedia/commons/a/ab/Anim.gif', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Doc.pdf', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Scan.tif', 'https://evil.com/wikipedia/commons/a/ab/X.jpg', 'https://upload.wikimedia.org/wikipedia/commons/zz/ab/X.jpg', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X'])
    assert.equal(cover.coverDownloadUrl(bad), undefined, bad);
});

test('coverOriginalUrl: the raster original as the fallback after a 4xx; svg has none', () => {
  assert.equal(cover.coverOriginalUrl(THUMB), ORIGINAL);
  assert.equal(cover.coverOriginalUrl(ORIGINAL), ORIGINAL);
  assert.equal(cover.coverOriginalUrl('https://upload.wikimedia.org/wikipedia/commons/3/3a/Map.svg'), undefined);
  assert.equal(cover.coverOriginalUrl('https://evil.com/wikipedia/commons/a/ab/X.jpg'), undefined);
});

test('coverFileName: illegal characters, traversal, control characters and an all-illegal title are cleaned; at most 40 title characters; hash from the source key', () => {
  const hash = slots.shortHash(ORIGINAL);
  assert.equal(cover.coverFileName('文藝復興', ORIGINAL, 'jpg'), `文藝復興-${hash}.jpg`);
  assert.equal(slots.shortHash(THUMB), hash);
  for (const title of ['../../etc/passwd', 'a/b\\c:d*e?f"g<h>i|j#k^l[m]n', '..', '...', '\u0000\u0007\u001f', '/:*?"<>|#^[]', '.hidden', 'a..b', '  ', '']) {
    const name = cover.coverFileName(title, ORIGINAL, 'png');
    assert.match(name, /^[^\\/:*?"<>|#^[\]\u0000-\u001f]+-[0-9a-f]{8}\.png$/, title);
    assert.ok(!name.startsWith('.') && !name.includes('..') && !name.includes('/'), `${title} -> ${name}`);
  }
  assert.equal(cover.coverFileName('/:*?"<>|#^[]', ORIGINAL, 'png'), `cover-${hash}.png`);
  assert.equal(cover.coverFileName('', ORIGINAL, 'png'), `cover-${hash}.png`);
  assert.equal(Array.from(cover.coverFileName('字'.repeat(100), ORIGINAL, 'jpg')).length, 40 + 1 + 8 + 4);
  assert.equal(cover.coverFileName('x', ORIGINAL, 'svg'), undefined, 'an extension outside png/jpg/webp is refused');
  assert.equal(cover.coverFileName('x', ORIGINAL, '../x'), undefined);
});

test('coverPath: inside the folder, no traversal, undefined when a segment or the name would escape', () => {
  assert.equal(cover.coverPath('Books/My Book/封面圖', 'a-12345678.png'), 'Books/My Book/封面圖/a-12345678.png');
  assert.equal(cover.coverPath('Books//My Book/', 'a-12345678.png'), 'Books/My Book/a-12345678.png');
  assert.equal(cover.coverPath('', 'a-12345678.png'), 'a-12345678.png');
  for (const [folder, name] of [['Books/../Secret', 'a.png'], ['..', 'a.png'], ['Books/./x', 'a.png'], ['Books', '../a.png'], ['Books', 'x/a.png'], ['Books', 'x\\a.png'], ['Books', 'a..png'], ['Books', '']])
    assert.equal(cover.coverPath(folder, name), undefined, `${folder} | ${name}`);
});

test('sniffImageMime: png, jpeg, webp by magic bytes; svg, gif, html, short and empty input give undefined', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56]);
  const enc = text => new TextEncoder().encode(text);
  assert.equal(cover.sniffImageMime(png), 'image/png');
  assert.equal(cover.sniffImageMime(jpeg), 'image/jpeg');
  assert.equal(cover.sniffImageMime(webp), 'image/webp');
  assert.equal(cover.sniffImageMime(webp.buffer), 'image/webp', 'an ArrayBuffer works too');
  for (const bad of [enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), enc('<?xml version="1.0"?><svg/>'), enc('GIF89a....'), enc('<!doctype html>'), Uint8Array.from([0xff, 0xd8]), new Uint8Array(0), Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])])
    assert.equal(cover.sniffImageMime(bad), undefined);
});

test('cover line: compose and parse round-trip (zh and en); the search part is optional; the line stays one line without the field separator', () => {
  const plan = { explains: '文藝復興的透視畫法', search: ['Renaissance perspective', 'Brunelleschi'] };
  assert.equal(cover.composeCoverLine(plan), '封面要找：文藝復興的透視畫法｜英文搜尋詞：Renaissance perspective, Brunelleschi');
  assert.deepEqual(plain(cover.parseCoverLine(cover.composeCoverLine(plan))), plan);
  assert.equal(cover.composeCoverLine({ explains: 'Perspective in painting', search: ['perspective'] }, 'en'), 'Cover to find: Perspective in painting｜Search terms: perspective');
  assert.deepEqual(plain(cover.parseCoverLine('Cover to find: Perspective in painting｜Search terms: perspective')), { explains: 'Perspective in painting', search: ['perspective'] });
  assert.deepEqual(plain(cover.parseCoverLine('封面要找：只有描述')), { explains: '只有描述', search: [] });
  const messy = cover.composeCoverLine({ explains: '甲｜乙\n丙', search: ['中文 only', 'ok term', 'ok term', 'a', 'b', 'c', 'd'] });
  assert.ok(!messy.includes('\n') && messy.split('｜').length === 2, messy);
  assert.deepEqual(plain(cover.parseCoverLine(messy).search), ['中文 only', 'ok term', 'a', 'b']);
  for (const bad of ['', '封面要找：', '封面要找： ｜英文搜尋詞：a', '圖位 1｜x', '- 封面要找：x', 'foo 封面要找：x']) assert.equal(cover.parseCoverLine(bad), undefined, bad);
});

test('coverAsSlot: a slot of kind cover at index 0 that carries the plan; a cover line beside the image plan does not change what parseImageSlots reads', () => {
  const slot = cover.coverAsSlot({ explains: '透視', search: ['perspective'] });
  assert.deepEqual(plain(slot), { index: 0, kind: 'cover', explains: '透視', anchor: '', search: ['perspective'] });
  const planText = S.load('core/book-pipeline/plan-text.ts');
  const body = '圖安排：\n- 圖位 1｜繪畫｜透視｜位置：前段｜英文搜尋詞：perspective, painting\n- 圖位 2｜地圖｜城市｜位置：後段';
  const before = plain(planText.parseImageSlots(`目標：x\n${body}`));
  const withLine = plain(planText.parseImageSlots(`目標：x\n${cover.composeCoverLine({ explains: '透視', search: ['perspective'] })}\n${body}`));
  assert.deepEqual(withLine, before);
  assert.equal(before.length, 2);
});
