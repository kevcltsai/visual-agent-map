// Argument map source proof (P2): a source counts only when the program opened it and found the quote, or the provider's own
// tool log shows it opened that exact URL after the program was blocked. Everything else is not_found.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const sp = S.load('core/argument-map/source-proof.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const NOW = () => '2026-11-09T00:00:00.000Z';
const QUOTE = 'Youth unemployment rose to 9.2 percent in March';
const PAGE = `<html><head><title>t</title><script>var hidden="Secret script sentence here";</script></head><body><p>Report: ${QUOTE}, the highest in a decade, according to the bureau of statistics.</p>${'<p>filler text for length</p>'.repeat(20)}</body></html>`;
/** Test parser: the production parser is DOMParser (inert); this one only drops script/style and tags. */
const parseHtml = html => html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
const reply = (status, text, type = 'text/html; charset=utf-8', extra = {}) => ({ status, text, headers: { 'Content-Type': type }, ...extra });
const make = (responder, opts = {}) => {
  const calls = [];
  const fetch = async req => { calls.push(req.url); return typeof responder === 'function' ? responder(req) : responder; };
  const run = (over = {}) => sp.verifySource({ url: 'https://stats.example.org/report', quote: QUOTE, claim: 'Rate rose', openedUrls: [], fetch, now: NOW, parseHtml, ...opts, ...over });
  return { calls, run };
};
const notFound = (result, reason) => { assert.equal(result.ok, false); assert.equal(result.result, 'not_found'); if (reason) assert.equal(result.reason, reason); };

test('page_match: 2xx html that contains the quote passes, with the proof recorded', async () => {
  const { run, calls } = make(reply(200, PAGE));
  const r = await run();
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.proof), { url: 'https://stats.example.org/report', quote: QUOTE, claim: 'Rate rose', check: 'page_match', checkedAt: NOW() });
  assert.deepEqual(calls, ['https://stats.example.org/report']);
});

test('quote folding: NFKC, case, whitespace and punctuation differences still match', async () => {
  const { run } = make(reply(200, '<p>Youth   unemployment\n rose to 9.2 percent, in March!</p>'));
  assert.equal((await run({ quote: 'Ｙouth unemployment rose to 9.2 percent in March' })).ok, true);
});

test('not_found: quote is not in the page (fabricated quote)', async () => {
  const { run } = make(reply(200, PAGE));
  notFound(await run({ quote: 'Youth unemployment fell to 3.1 percent in March' }), 'quote_missing');
});

test('not_found: quote only present inside script text is ignored', async () => {
  const { run } = make(reply(200, PAGE));
  notFound(await run({ quote: 'Secret script sentence here' }), 'quote_missing');
});

test('not_found: 404, 410 and other non-blocked 4xx', async () => {
  for (const status of [404, 410, 400]) notFound(await make(reply(status, 'nope')).run({ openedUrls: ['https://stats.example.org/report'] }), 'http_status');
});

test('not_found: DNS or network failure (fetch throws) even when the provider claims to have opened it', async () => {
  const { run } = make(() => { throw new Error('getaddrinfo ENOTFOUND'); });
  notFound(await run({ openedUrls: ['https://stats.example.org/report'] }), 'network_error');
});

test('not_found: url appears only in AI text (not in the tool log) when the program is blocked', async () => {
  for (const status of [401, 403, 429, 500, 503]) notFound(await make(reply(status, 'blocked')).run({ openedUrls: ['https://other.example.org/x'] }), 'blocked_unverified');
});

test('provider_read only when blocked AND the same URL was opened in the tool log', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const r = await make(reply(status, 'blocked')).run({ openedUrls: ['https://STATS.example.org/report#section'] });
    assert.equal(r.ok, true, `status ${status}`);
    assert.equal(r.proof.check, 'provider_read');
    assert.equal(r.proof.url, 'https://stats.example.org/report');
  }
});

test('provider_read: timeout, pdf, js shell and oversize are blocked classes', async () => {
  const opened = ['https://stats.example.org/report'];
  const hang = make(() => new Promise(() => {}), { timeoutMs: 20 });
  assert.equal((await hang.run({ openedUrls: opened })).proof.check, 'provider_read');
  notFound(await make(() => new Promise(() => {}), { timeoutMs: 20 }).run(), 'blocked_unverified');
  assert.equal((await make(reply(200, '%PDF-1.7', 'application/pdf')).run({ openedUrls: opened })).proof.check, 'provider_read');
  notFound(await make(reply(200, '%PDF-1.7', 'application/pdf')).run(), 'blocked_unverified');
  assert.equal((await make(reply(200, '<html><body><div id="root"></div><script>x</script></body></html>')).run({ openedUrls: opened })).proof.check, 'provider_read');
  notFound(await make(reply(200, '<html><body><div id="root"></div></body></html>')).run(), 'blocked_unverified');
  const big = reply(200, 'x', 'text/html', { arrayBuffer: { byteLength: 2 * 1024 * 1024 + 1 } });
  assert.equal((await make(big).run({ openedUrls: opened })).proof.check, 'provider_read');
  notFound(await make(big).run(), 'blocked_unverified');
});

test('a readable page without the quote is never rescued by the tool log', async () => {
  const { run } = make(reply(200, PAGE));
  notFound(await run({ quote: 'This sentence was invented by the model', openedUrls: ['https://stats.example.org/report'] }), 'quote_missing');
});

test('oversize page (> 2 MB) is not parsed', async () => {
  let parsed = 0;
  const big = reply(200, 'x'.repeat(10), 'text/html', { arrayBuffer: { byteLength: 3 * 1024 * 1024 } });
  const { run } = make(big, { parseHtml: html => { parsed++; return parseHtml(html); } });
  await run();
  assert.equal(parsed, 0);
  const huge = make(reply(200, 'y'.repeat(2 * 1024 * 1024 + 1)), { parseHtml: () => { parsed++; return ''; } });
  await huge.run();
  assert.equal(parsed, 0);
});

test('rejected URLs never reach fetch (0 calls) and are not_found even if the tool log lists them', async () => {
  const bad = [
    'file:///etc/passwd', 'ftp://example.org/a', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', '',
    'http://localhost/a', 'http://localhost:8080/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://printer.local/', 'http://nas.local./',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/', 'http://0.0.0.0/', 'http://224.0.0.1/',
    'http://[::1]/', 'http://[::]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
    'https://user:pass@example.org/'
  ];
  for (const url of bad) {
    const { run, calls } = make(reply(200, PAGE));
    notFound(await run({ url, openedUrls: [url] }), 'rejected_url');
    assert.equal(calls.length, 0, `fetch must not be called for ${url}`);
  }
});

test('public hosts and public IPv4 literals are allowed', async () => {
  for (const url of ['http://example.org/a', 'https://sub.example.co.uk:8443/a?b=1', 'http://8.8.8.8/', 'http://172.32.0.1/', 'http://[2606:4700::1111]/', 'https://locally.example.org/']) {
    const { run, calls } = make(reply(200, PAGE));
    assert.equal((await run({ url })).ok, true, url);
    assert.equal(calls.length, 1);
  }
});

test('quote length: under 12 or over 200 characters, or empty after folding, is not_found and fetch is skipped', async () => {
  for (const quote of ['', 'short quote', 'x'.repeat(201), '.,;:!? .,;:!? .,;:!?', ' \n\t '.repeat(5), '- - - - - - - - - - - -']) {
    const { run, calls } = make(reply(200, PAGE));
    notFound(await run({ quote }), 'bad_quote');
    assert.equal(calls.length, 0);
  }
  const { run } = make(reply(200, `<p>${'ab'.repeat(100)}</p>`));
  assert.equal((await run({ quote: 'ab'.repeat(100) })).ok, true, '200 characters is allowed');
  assert.equal((await make(reply(200, '<p>九百二十萬人口在三月份失業</p>')).run({ quote: '九百二十萬人口在三月份失業' })).ok, true, '12 CJK characters is allowed');
});

test('empty claim is not_found', async () => {
  notFound(await make(reply(200, PAGE)).run({ claim: '  ' }), 'bad_claim');
});

test('non-text content types are not_found; plain text works', async () => {
  notFound(await make(reply(200, QUOTE, 'application/json')).run(), 'content_type');
  notFound(await make(reply(200, 'GIF89a', 'image/gif')).run(), 'content_type');
  assert.equal((await make(reply(200, `plain ${QUOTE} plain`, 'text/plain')).run()).ok, true);
});

test('no inert parser available fails closed', async () => {
  const calls = [];
  const r = await sp.verifySource({ url: 'https://stats.example.org/report', quote: QUOTE, claim: 'c', openedUrls: [], fetch: async q => { calls.push(q); return reply(200, PAGE); }, now: NOW });
  notFound(r, 'no_parser');
});

test('the request is a plain GET with throw:false', async () => {
  let seen;
  await make(req => { seen = req; return reply(200, PAGE); }).run();
  assert.equal(seen.method, 'GET');
  assert.equal(seen.throw, false);
});

test('openedUrlsFromEvents: only completed openPage events with a url count', () => {
  const ev = (method, action, id = 'i') => ({ method, params: { item: { id, type: 'webSearch', action } } });
  const urls = sp.openedUrlsFromEvents([
    ev('item/started', null), ev('item/completed', { type: 'search', query: 'q' }),
    ev('item/completed', { type: 'openPage', url: 'https://a.example.org/x' }),
    ev('item/started', { type: 'openPage', url: 'https://started-only.example.org/' }),
    ev('item/completed', { type: 'openPage' }), ev('item/completed', { type: 'openPage', url: 42 }),
    { method: 'item/completed', params: null }, null
  ]);
  assert.deepEqual(plain(urls), ['https://a.example.org/x']);
});
