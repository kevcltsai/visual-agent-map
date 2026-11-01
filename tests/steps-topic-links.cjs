// Topic links (topic-links P1): http(s) whitelist read, validating add, remove, 0.28 compatibility.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { load, loadSource } = require('./support-replay.cjs');

const m = load('topic-links.ts');
const own = value => (value === null ? null : [...value]);
const read = value => own(m.readTopicLinks({ 'topic-links': value }));

/** The shared cases; the sharing-viewer test runs the same file through the viewer's own check. */
const { rejected: REJECTED, accepted: ACCEPTED } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'topic-link-cases.json'), 'utf8'));

test('links normalize: only http(s) passes, with the trimmed URL.href', () => {
  for (const bad of REJECTED) assert.equal(m.normalizeTopicLink(bad), null, JSON.stringify(bad.slice(0, 40)));
  for (const bad of [3, null, undefined, {}, [], ['https://example.com'], true]) assert.equal(m.normalizeTopicLink(bad), null);
  for (const [input, href] of ACCEPTED) assert.equal(m.normalizeTopicLink(input), href);
});

test('links read: rejected values and non-strings read as nothing', () => {
  assert.deepEqual(read(REJECTED), []);
  assert.deepEqual(read([3, null, {}, ['https://example.com'], 'https://ok.example/']), ['https://ok.example/']);
  assert.deepEqual(own(m.readTopicLinks({})), []);
  assert.deepEqual(read(7), []);
  assert.deepEqual(read({ a: 'https://example.com' }), []);
});

test('links read: a single string is a one-item list, order kept, deduplicated by href', () => {
  assert.deepEqual(read('  https://Example.com/a  '), ['https://example.com/a']);
  assert.deepEqual(read(['https://b.example/', 'https://a.example/', 'HTTPS://B.example', ' https://b.example/ ']), ['https://b.example/', 'https://a.example/']);
});

test('links read: at most 20 valid items, bad ones do not count toward the limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => `https://e${i}.example/`);
  assert.deepEqual(read(['javascript:x', ...many]), many.slice(0, 20));
  assert.equal(m.TOPIC_LINKS_MAX, 20);
  assert.equal(m.TOPIC_LINK_MAX_LENGTH, 2048);
});

test('links read: the longest allowed address passes, one more character does not', () => {
  const base = 'https://example.com/';
  assert.equal(m.normalizeTopicLink(base + 'a'.repeat(2048 - base.length)).length, 2048);
  assert.equal(m.normalizeTopicLink(base + 'a'.repeat(2049 - base.length)), null);
});

test('links read does not mutate its input', () => {
  const raw = ['  https://Example.com/a ', 'x'];
  m.readTopicLinks({ 'topic-links': raw });
  assert.deepEqual(raw, ['  https://Example.com/a ', 'x']);
});

test('links add: appends the normalized href and keeps values it does not understand', () => {
  const r = m.addTopicLink(['future-x', 3, 'https://a.example/'], ' HTTPS://B.example/p ');
  assert.equal(r.ok, true);
  assert.deepEqual(own(r.next), ['future-x', 3, 'https://a.example/', 'https://b.example/p']);
  assert.deepEqual(own(m.addTopicLink(undefined, 'https://a.example').next), ['https://a.example/']);
  assert.deepEqual(own(m.addTopicLink('https://a.example', 'https://b.example').next), ['https://a.example', 'https://b.example/']);
});

test('links add: invalid, duplicate and too-many give a reason and no list', () => {
  for (const bad of REJECTED) assert.deepEqual({ ...m.addTopicLink([], bad) }, { ok: false, reason: 'invalid' });
  assert.deepEqual({ ...m.addTopicLink(['https://a.example/'], 'HTTPS://A.example') }, { ok: false, reason: 'duplicate' });
  assert.deepEqual({ ...m.addTopicLink([' https://a.example/ '], 'https://a.example/') }, { ok: false, reason: 'duplicate' });
  const full = Array.from({ length: 20 }, (_, i) => `https://e${i}.example/`);
  assert.deepEqual({ ...m.addTopicLink(full, 'https://new.example/') }, { ok: false, reason: 'too-many' });
  assert.equal(m.addTopicLink(full.slice(0, 19), 'https://new.example/').ok, true);
  // Unreadable stored values do not use up the 20.
  assert.equal(m.addTopicLink([...full.slice(0, 19), ...Array(10).fill('javascript:x')], 'https://new.example/').ok, true);
});

test('links add does not mutate its input', () => {
  const raw = ['https://a.example/'];
  m.addTopicLink(raw, 'https://b.example/');
  assert.deepEqual(raw, ['https://a.example/']);
});

test('links remove: by normalized href, duplicates and spelling variants go, invalid and non-string values stay, null when empty', () => {
  const raw = ['future-x', 'https://a.example/', ' https://b.example/ '];
  assert.deepEqual(own(m.removeTopicLink(raw, 'https://a.example/')), ['future-x', ' https://b.example/ ']);
  assert.deepEqual(own(m.removeTopicLink(raw, 'https://b.example/')), ['future-x', 'https://a.example/']);
  assert.deepEqual(own(m.removeTopicLink(raw, 'https://none.example/')), raw);
  const messy = ['javascript:alert(1)', 7, 'https://a.example', null, 'HTTPS://A.example/', { x: 1 }, 'https://a.example/', 'https://c.example/'];
  assert.deepEqual(own(m.removeTopicLink(messy, 'https://a.example/')), ['javascript:alert(1)', 7, null, { x: 1 }, 'https://c.example/'], 'invalid, duplicate and non-string items: all matches go, the rest stay');
  assert.equal(m.removeTopicLink(['https://a.example/', 'https://A.example'], 'https://a.example/'), null);
  assert.equal(m.removeTopicLink('https://a.example/', 'https://a.example/'), null);
  assert.equal(m.removeTopicLink(undefined, 'https://a.example/'), null);
  assert.deepEqual(raw, ['future-x', 'https://a.example/', ' https://b.example/ ']);
});

test('links compat: the 0.28 frontmatter writer keeps topic-links when it changes other keys', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-frontmatter-0.28.ts.txt'), 'utf8');
  const legacy = loadSource(`${source}\n`, { obsidian: { parseYaml: text => YAML.parse(text) } });
  const note = '---\ntitle: T\ntopic-links:\n  - "https://a.example/"\n  - "javascript:alert(1)"\ntopic-markers:\n  - star\nupdated: 2026-01-01\n---\n\n# T\n\nbody\n';
  assert.doesNotThrow(() => legacy.frontmatter(note));
  assert.deepEqual(own(m.readTopicLinks(legacy.frontmatter(note))), ['https://a.example/']);
  const toggled = legacy.setFrontmatterKeys(note, { 'topic-markers': ['star', 'done'] });
  const summary = legacy.setFrontmatterKeys(toggled, { updated: '2026-02-02' });
  for (const out of [toggled, summary]) {
    assert.match(out, /topic-links:\n  - "https:\/\/a\.example\/"\n  - "javascript:alert\(1\)"\n/, 'topic-links lines are untouched');
    assert.deepEqual(own(m.readTopicLinks(legacy.frontmatter(out))), ['https://a.example/']);
  }
  assert.equal(summary.endsWith('\n---\n\n# T\n\nbody\n'), true);
});
