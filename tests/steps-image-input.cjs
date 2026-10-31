// Image input whitelist (map-images P1): dropped, pasted and stored bytes are untrusted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const inp = load('experiences/visual-map/image-input.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const accept = c => plain(inp.acceptImage(c));

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const JPG = Buffer.from([255, 216, 255, 224, 0]);
const GIF = Buffer.from('GIF89a....');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
const bytesOf = b => new Uint8Array(b);

test('sniffImage recognises the four whitelisted formats', () => {
  assert.equal(inp.sniffImage(bytesOf(PNG)), 'image/png');
  assert.equal(inp.sniffImage(bytesOf(JPG)), 'image/jpeg');
  assert.equal(inp.sniffImage(bytesOf(GIF)), 'image/gif');
  assert.equal(inp.sniffImage(bytesOf(WEBP)), 'image/webp');
  assert.equal(inp.sniffImage(bytesOf(PNG).buffer.slice(0, 10)), 'image/png');
  assert.equal(inp.sniffImage(new Uint8Array(0)), null);
});

test('acceptImage takes a real PNG and uses the sniffed type', () => {
  assert.deepEqual(accept({ mime: 'image/png', size: PNG.length, bytes: bytesOf(PNG) }), { ok: true, mime: 'image/png' });
  assert.deepEqual(accept({ mime: 'image/jpeg', size: PNG.length, bytes: bytesOf(PNG) }), { ok: true, mime: 'image/png' });
});

test('counter-example 1: .png name but HTML content is refused', () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.deepEqual(accept({ mime: 'image/png', size: html.length, bytes: bytesOf(html) }), { ok: false, reason: 'bad-content' });
});

test('counter-example 2: image/svg+xml is refused, even with a PNG body', () => {
  assert.deepEqual(accept({ mime: 'image/svg+xml', size: PNG.length, bytes: bytesOf(PNG) }), { ok: false, reason: 'svg' });
  assert.deepEqual(accept({ mime: 'text/html', size: PNG.length, bytes: bytesOf(PNG) }), { ok: false, reason: 'not-image-mime' });
});

test('counter-example 3: larger than 10 MB is refused by declared size or real length', () => {
  const big = 10 * 1024 * 1024 + 1;
  assert.deepEqual(accept({ mime: 'image/png', size: big, bytes: bytesOf(PNG) }), { ok: false, reason: 'too-large' });
  const real = new Uint8Array(big);
  real.set(PNG);
  assert.deepEqual(accept({ mime: 'image/png', size: 1, bytes: real }), { ok: false, reason: 'too-large' });
  const edge = new Uint8Array(10 * 1024 * 1024);
  edge.set(PNG);
  assert.equal(accept({ mime: 'image/png', size: edge.length, bytes: edge }).ok, true);
});

test('empty bytes are refused', () => {
  assert.deepEqual(accept({ mime: 'image/png', size: 0, bytes: new Uint8Array(0) }), { ok: false, reason: 'empty' });
});

test('counter-example 4: only text/uri-list and text/html, no files, gives an empty array', () => {
  const transfer = { files: [], getData: type => (type === 'text/uri-list' ? 'https://example.com/a.png' : '<img src="https://x/a.png">'), types: ['text/uri-list', 'text/html'] };
  assert.deepEqual(plain(inp.imageFilesFrom(transfer)), []);
  assert.deepEqual(plain(inp.imageFilesFrom(null)), []);
  assert.deepEqual(plain(inp.imageFilesFrom({})), []);
});

test('imageFilesFrom keeps only image/* files', () => {
  const a = { type: 'image/png', name: 'a' };
  const files = [a, { type: 'text/plain', name: 'b' }, { type: '', name: 'c' }, { type: 'image/webp', name: 'd' }];
  assert.deepEqual(plain(inp.imageFilesFrom({ files })).map(f => f.name), ['a', 'd']);
});

test('safeImageName keeps safe characters and takes the extension from the sniffed type', () => {
  assert.equal(inp.safeImageName('My Photo-1_x.jpeg', 'image/png'), 'My Photo-1_x.png');
  assert.equal(inp.safeImageName('../../etc/passwd', 'image/jpeg'), 'passwd.jpg');
  assert.equal(inp.safeImageName('a\\b\\c<>:"|?*.gif', 'image/gif'), 'c_______.gif');
  assert.equal(inp.safeImageName('', 'image/webp'), 'image.webp');
  assert.equal(inp.safeImageName('...', 'image/png'), 'image.png');
  assert.equal(inp.safeImageName('x.png', 'image/svg+xml'), null);
  assert.ok(inp.safeImageName('a'.repeat(500), 'image/png').length <= 90);
});
