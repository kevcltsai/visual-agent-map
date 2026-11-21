// Packet A1: downloadCover (injected fetch) and saveCover (plan §6 security): every counterexample is refused and no request goes out for a bad address; late results after abort/timeout are dropped; an existing file is reused, never overwritten.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dl = S.load('core/book-pipeline/cover-download.ts');
const cover = S.load('core/book-pipeline/cover.ts');
const ORIGINAL = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Mona_Lisa.jpg';
const THUMB = cover.coverDownloadUrl(ORIGINAL);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const buf = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const answer = (bytes, type, extra = {}) => ({ status: 200, headers: { 'Content-Type': type }, bytes: buf(bytes), ...extra });
const recorder = respond => { const calls = []; return { calls, fetch: async (url, init) => { calls.push({ url, init }); return respond(url, calls.length); } }; };
const reason = async (url, respond, options) => { const r = recorder(respond); const out = await dl.downloadCover(url, r.fetch, options); return { out, calls: r.calls }; };

test('downloadCover: a good jpeg thumbnail comes back with its detected type; the request carries only the policy User-Agent headers', async () => {
  const r = recorder(() => answer(JPEG, 'image/jpeg'));
  const out = await dl.downloadCover(ORIGINAL, r.fetch, { userAgent: 'VisualAgentMap-Obsidian-plugin/9.9.9' });
  assert.equal(out.ok, true);
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.ext, 'jpg');
  assert.equal(out.bytes.byteLength, JPEG.length);
  assert.deepEqual(r.calls.map(c => c.url), [THUMB]);
  assert.deepEqual(Object.keys(r.calls[0].init.headers).sort(), ['Api-User-Agent', 'User-Agent']);
  assert.equal(r.calls[0].init.headers['User-Agent'], 'VisualAgentMap-Obsidian-plugin/9.9.9');
});

test('downloadCover: addresses outside the whitelist are refused and no request is made', async () => {
  for (const url of ['http://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg', 'https://upload.wikimedia.org.evil.com/wikipedia/commons/a/ab/X.jpg', 'https://u:p@upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg', 'https://upload.wikimedia.org:444/wikipedia/commons/a/ab/X.jpg', 'https://upload.wikimedia.org/wikipedia/en/a/ab/X.jpg', 'https://evil.com/x.png', 'file:///etc/passwd', '', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.gif']) {
    const { out, calls } = await reason(url, () => answer(PNG, 'image/png'));
    assert.deepEqual([out.ok, out.reason, calls.length], [false, 'url', 0], url);
  }
});

test('downloadCover: oversize (content-length or real size), wrong type, mismatching magic bytes, svg, html and an error status are refused', async () => {
  const six = new Uint8Array(6 * 1024 * 1024); six.set(PNG);
  assert.equal((await reason(ORIGINAL, () => answer(six, 'image/png'))).out.reason, 'size', 'real size');
  assert.equal((await reason(ORIGINAL, () => answer(PNG, 'image/png', { headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) } }))).out.reason, 'size', 'content-length alone');
  assert.equal((await reason(ORIGINAL, () => answer(PNG, 'text/html; charset=utf-8'))).out.reason, 'type');
  assert.equal((await reason(ORIGINAL, () => answer(JPEG, 'image/png'))).out.reason, 'mismatch', 'header says png, bytes are jpeg');
  assert.equal((await reason(ORIGINAL, () => answer(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'))).out.reason, 'type', 'svg by header');
  assert.equal((await reason(ORIGINAL, () => answer(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'))).out.reason, 'mismatch', 'svg body under a png header');
  assert.equal((await reason(ORIGINAL, () => answer(new TextEncoder().encode('GIF89a'), 'image/gif'))).out.reason, 'type');
  assert.equal((await reason(ORIGINAL, () => ({ status: 200, bytes: buf(PNG) }))).out.reason, 'type', 'no content-type');
  assert.equal((await reason(ORIGINAL, () => ({ status: 500, headers: {}, bytes: new ArrayBuffer(0) }))).out.reason, 'status');
  assert.equal((await reason(ORIGINAL, () => ({ status: 429, headers: {}, bytes: new ArrayBuffer(0) }))).calls.length, 1, '429 is a failure, not a fallback');
  assert.equal((await reason(ORIGINAL, () => answer(new Uint8Array(0), 'image/png'))).out.reason, 'mismatch', 'empty body');
});

test('downloadCover: a 4xx thumbnail falls back to the raster original once; an svg has no fallback; the fallback answer faces the same checks', async () => {
  let r = await reason(ORIGINAL, (url, n) => n === 1 ? { status: 400, headers: {}, bytes: new ArrayBuffer(0) } : answer(JPEG, 'image/jpeg'));
  assert.equal(r.out.ok, true);
  assert.deepEqual(r.calls.map(c => [c.url, c.init.method]), [[THUMB, undefined], [ORIGINAL, 'HEAD'], [ORIGINAL, undefined]], 'the original is asked for its headers first');
  r = await reason(ORIGINAL, (url, n) => n === 1 ? { status: 404, headers: {}, bytes: new ArrayBuffer(0) } : answer(JPEG, 'text/html'));
  assert.deepEqual([r.out.ok, r.out.reason, r.calls.length], [false, 'type', 3]);
  r = await reason('https://upload.wikimedia.org/wikipedia/commons/3/3a/Map.svg', () => ({ status: 400, headers: {}, bytes: new ArrayBuffer(0) }));
  assert.deepEqual([r.out.ok, r.out.reason, r.calls.length], [false, 'status', 1]);
  assert.equal(r.calls[0].url, 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Map.svg/1280px-Map.svg.png', 'svg asks only for the png thumbnail');
  const png = await reason('https://upload.wikimedia.org/wikipedia/commons/3/3a/Map.svg', () => answer(PNG, 'image/png'));
  assert.equal(png.out.ext, 'png');
  r = await reason(ORIGINAL, () => ({ status: 500, headers: {}, bytes: new ArrayBuffer(0) }));
  assert.equal(r.calls.length, 1, '5xx does not fall back');
});

test('downloadCover: an oversize original is refused from its HEAD content-length, before the GET (the body is never requested)', async () => {
  const big = { status: 200, headers: { 'content-length': String(6 * 1024 * 1024) }, bytes: new ArrayBuffer(0) };
  let r = await reason(ORIGINAL, (url, n) => n === 1 ? { status: 404, headers: {}, bytes: new ArrayBuffer(0) } : big);
  assert.deepEqual([r.out.ok, r.out.reason, r.calls.map(c => c.init.method)], [false, 'size', [undefined, 'HEAD']]);
  r = await reason(ORIGINAL, (url, n) => n === 1 ? { status: 404, headers: {}, bytes: new ArrayBuffer(0) } : n === 2 ? { status: 405, headers: {}, bytes: new ArrayBuffer(0) } : answer(JPEG, 'image/jpeg'));
  assert.equal(r.out.ok, true, 'a HEAD that is refused is no verdict');
});

test('downloadCover: a fetch that throws is a failure, not an exception', async () => {
  const out = await dl.downloadCover(ORIGINAL, async () => { throw new Error('network down'); });
  assert.deepEqual([out.ok, out.reason], [false, 'failed']);
});

test('downloadCover: an answer arriving after the timeout is dropped', async () => {
  let release;
  const slow = new Promise(resolve => { release = () => resolve(answer(PNG, 'image/png')); });
  const out = await dl.downloadCover(ORIGINAL, () => slow, { timeoutMs: 20 });
  assert.deepEqual([out.ok, out.reason], [false, 'timeout']);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('downloadCover: an abort (before the call, or while it waits) drops the answer, even one that arrives later', async () => {
  const early = new AbortController(); early.abort();
  const r = await reason(ORIGINAL, () => answer(PNG, 'image/png'), { signal: early.signal });
  assert.deepEqual([r.out.ok, r.out.reason, r.calls.length], [false, 'aborted', 0]);
  const live = new AbortController();
  let release;
  const slow = new Promise(resolve => { release = () => resolve(answer(PNG, 'image/png')); });
  const pending = dl.downloadCover(ORIGINAL, () => slow, { signal: live.signal });
  live.abort();
  assert.deepEqual([(await pending).ok, (await pending).reason], [false, 'aborted']);
  release();
  // The fetch answers inside the same turn as the abort: still dropped.
  const racing = new AbortController();
  const out = await dl.downloadCover(ORIGINAL, async () => { racing.abort(); return answer(PNG, 'image/png'); }, { signal: racing.signal });
  assert.deepEqual([out.ok, out.reason], [false, 'aborted']);
});

const vault = (existing = {}, options = {}) => {
  const files = new Map(Object.entries(existing));
  const writes = [];
  return {
    files, writes,
    ports: {
      exists: async path => files.has(path),
      createBinary: async (path, data) => { if (options.throws) throw new Error(options.throws); if (files.has(path)) throw new Error('File already exists.'); files.set(path, data); writes.push(path); },
      ensureFolder: async () => {}
    }
  };
};
const good = (ext = 'jpg', bytes = JPEG) => ({ ok: true, bytes, mime: ext === 'png' ? 'image/png' : 'image/jpeg', ext, url: THUMB });

test('saveCover: writes a new file inside the folder with a cleaned name; the path is the sanitized title plus the hash', async () => {
  const v = vault();
  const out = await dl.saveCover(v.ports, 'Books/B/封面圖', '../../etc/passwd', ORIGINAL, good());
  assert.equal(out.ok, true);
  assert.equal(out.reused, false);
  assert.match(out.path, /^Books\/B\/封面圖\/[^/]+-[0-9a-f]{8}\.jpg$/);
  assert.ok(!out.path.includes('..'));
  assert.deepEqual(v.writes, [out.path]);
});

test('saveCover: an existing path is reused: no write, the stored bytes are untouched; running twice is idempotent', async () => {
  const v = vault();
  const first = await dl.saveCover(v.ports, 'B/c', '標題', ORIGINAL, good());
  const mine = v.files.get(first.path);
  const again = await dl.saveCover(v.ports, 'B/c', '標題', ORIGINAL, good('jpg', Uint8Array.from([0xff, 0xd8, 0xff, 9, 9])));
  assert.deepEqual([again.ok, again.reused, again.path], [true, true, first.path]);
  assert.equal(v.files.get(first.path), mine, 'not overwritten');
  assert.equal(v.writes.length, 1);
  // The owner's own file under that name stays theirs.
  const owner = vault({ [first.path]: 'owner file' });
  const kept = await dl.saveCover(owner.ports, 'B/c', '標題', ORIGINAL, good());
  assert.deepEqual([kept.ok, kept.reused, owner.files.get(first.path)], [true, true, 'owner file']);
  assert.equal(owner.writes.length, 0);
});

test('saveCover: a create that loses a race to another writer counts as reuse; any other write error is a failure; a bad folder is refused', async () => {
  const racing = vault();
  racing.ports.exists = async path => racing.files.has(path) && racing.writes.length > 0;
  racing.ports.createBinary = async path => { racing.files.set(path, 'other'); racing.writes.push(path); throw new Error('File already exists.'); };
  const raced = await dl.saveCover(racing.ports, 'B/c', 't', ORIGINAL, good());
  assert.deepEqual([raced.ok, raced.reused], [true, true]);
  const broken = await dl.saveCover(vault({}, { throws: 'disk full' }).ports, 'B/c', 't', ORIGINAL, good());
  assert.deepEqual([broken.ok, broken.reason], [false, 'failed']);
  const escape = vault();
  const out = await dl.saveCover(escape.ports, 'B/../Secret', 't', ORIGINAL, good());
  assert.deepEqual([out.ok, out.reason, escape.writes.length], [false, 'path', 0]);
});

test('saveCover: after an abort nothing is written (a download that arrives late is thrown away); a failed download result writes nothing', async () => {
  const ctl = new AbortController(); ctl.abort();
  const v = vault();
  const out = await dl.saveCover(v.ports, 'B/c', 't', ORIGINAL, good(), ctl.signal);
  assert.deepEqual([out.ok, out.reason, v.writes.length], [false, 'aborted', 0]);
  const failed = await dl.saveCover(v.ports, 'B/c', 't', ORIGINAL, { ok: false, reason: 'timeout' });
  assert.deepEqual([failed.ok, failed.reason, v.writes.length], [false, 'timeout', 0]);
  const aborting = vault();
  const mid = new AbortController();
  aborting.ports.exists = async () => { mid.abort(); return false; };
  const late = await dl.saveCover(aborting.ports, 'B/c', 't', ORIGINAL, good(), mid.signal);
  assert.deepEqual([late.ok, late.reason, aborting.writes.length], [false, 'aborted', 0]);
});

test('downloadCover (review B-4): a 429 with Retry-After is waited out once and asked again; a longer wait than 8 s (or none) is a failed download without waiting; a second 429 is a failure; a stop during the wait ends it', async () => {
  const tooMany = retry => ({ status: 429, headers: retry === undefined ? {} : { 'Retry-After': retry }, bytes: new ArrayBuffer(0) });
  const took = async work => { const from = Date.now(); const out = await work(); return { out, spent: Date.now() - from }; };
  const base = await took(() => reason(ORIGINAL, () => answer(JPEG, 'image/jpeg')));
  const waited = await took(() => reason(ORIGINAL, (url, n) => n === 1 ? tooMany('1') : answer(JPEG, 'image/jpeg')));
  assert.equal(waited.out.out.ok, true); assert.equal(waited.out.calls.length, 2); assert.equal(waited.out.calls[1].url, THUMB, 'the same address again');
  assert.ok(waited.spent > base.spent * 5 + 100, 'it did wait (the Retry-After second)');
  const over = await took(() => reason(ORIGINAL, () => tooMany('9')));
  assert.deepEqual([over.out.out.ok, over.out.out.reason, over.out.calls.length], [false, 'status', 1]); assert.ok(over.spent * 5 < waited.spent, 'over the limit: no wait');
  let r = await reason(ORIGINAL, () => tooMany('Wed, 21 Oct 2099 07:28:00 GMT'));
  assert.deepEqual([r.out.reason, r.calls.length], ['status', 1], 'a date far away is over the limit too');
  r = await reason(ORIGINAL, () => tooMany(undefined));
  assert.deepEqual([r.out.reason, r.calls.length], ['status', 1], 'no Retry-After: no retry');
  r = await reason(ORIGINAL, () => tooMany('0'));
  assert.deepEqual([r.out.reason, r.calls.length], ['status', 2], 'the wait happens once: a second 429 is a failure');
  const controller = new AbortController();
  const pending = took(() => reason(ORIGINAL, () => tooMany('8'), { signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  const stopped = await pending;
  assert.deepEqual([stopped.out.out.ok, stopped.out.out.reason, stopped.out.calls.length], [false, 'aborted', 1]); assert.ok(stopped.spent * 5 < waited.spent * 8, 'the stop ended an 8 s wait early');
});
