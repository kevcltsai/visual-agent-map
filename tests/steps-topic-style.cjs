// Card style (card-style P1): whitelist read, preserving toggle, 0.28 compatibility.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { load, loadSource } = require('./support-replay.cjs');

const m = load('topic-colors.ts');
const own = value => (value === null ? null : [...value]);
const read = value => own(m.readTopicStyle({ 'topic-style': value }));

test('style list is the five whitelisted tokens in order', () => {
  assert.deepEqual(own(m.TOPIC_STYLES), ['bold', 'text-small', 'text-large', 'border-thick', 'line-thick']);
});

test('style read: each token reads back; output follows whitelist order', () => {
  for (const id of m.TOPIC_STYLES) assert.deepEqual(read([id]), [id]);
  assert.deepEqual(read(['line-thick', 'bold']), ['bold', 'line-thick']);
  assert.deepEqual(read(['bold', 'bold']), ['bold']);
});

test('style read: missing, casing, numbers, objects, null, injected and unknown values read as nothing', () => {
  assert.deepEqual(own(m.readTopicStyle({})), []);
  for (const bad of ['BOLD', 'Bold', ' bold', 3, null, true, {}, [], '', ['BOLD', 7, null, {}, ['bold']], '"><script>', ['"><script>alert(1)</script>'], { bold: true }])
    assert.deepEqual(read(bad), [], JSON.stringify(bad));
});

test('style read: a single string is a one-item list; unknown tokens mixed in are ignored', () => {
  assert.deepEqual(read('bold'), ['bold']);
  assert.deepEqual(read(['future-x', 'bold', 3, 'border-thick']), ['bold', 'border-thick']);
});

test('style read: text sizes are one choice, the first written wins', () => {
  assert.deepEqual(read(['text-large', 'text-small']), ['text-large']);
  assert.deepEqual(read(['text-small', 'bold', 'text-large']), ['bold', 'text-small']);
});

test('style toggle: unknown and non-string values are kept; the token is appended or removed', () => {
  assert.deepEqual(own(m.toggleTopicStyle(['future-x', 3], 'bold')), ['future-x', 3, 'bold']);
  assert.deepEqual(own(m.toggleTopicStyle(['future-x', 'bold', 3], 'bold')), ['future-x', 3]);
  assert.deepEqual(own(m.toggleTopicStyle('bold', 'line-thick')), ['bold', 'line-thick']);
  assert.deepEqual(own(m.toggleTopicStyle(['BOLD'], 'bold')), ['BOLD', 'bold'], 'other casing is unknown and stays');
});

test('style toggle: pressing the set value again turns it off, and the last token removes the key', () => {
  assert.equal(m.toggleTopicStyle(['bold'], 'bold'), null);
  assert.equal(m.toggleTopicStyle('bold', 'bold'), null);
  assert.equal(m.toggleTopicStyle(undefined, 'bold') && own(m.toggleTopicStyle(undefined, 'bold')).join(), 'bold');
  assert.deepEqual(own(m.toggleTopicStyle(['future-x', 'border-thick'], 'border-thick')), ['future-x'], 'an unknown value alone survives');
});

test('style toggle: text size is one choice', () => {
  assert.deepEqual(own(m.toggleTopicStyle(['text-small'], 'text-large')), ['text-large']);
  assert.deepEqual(own(m.toggleTopicStyle(['bold', 'text-large', 'future-x'], 'text-small')), ['bold', 'future-x', 'text-small']);
  assert.equal(m.toggleTopicStyle(['text-large'], 'text-large'), null);
  assert.deepEqual(own(m.toggleTopicStyle(['text-large', 'text-small', 'bold'], 'text-large')), ['bold'], 'the hidden second size goes too');
});

test('style toggle does not mutate its input', () => {
  const raw = ['future-x', 'text-small'];
  m.toggleTopicStyle(raw, 'text-large');
  assert.deepEqual(raw, ['future-x', 'text-small']);
});

test('style set: replaces whitelisted tokens, keeps unknown, null when empty', () => {
  assert.deepEqual(own(m.setTopicStyle(['future-x', 'bold', 'text-small'], ['line-thick'])), ['future-x', 'line-thick']);
  assert.deepEqual(own(m.setTopicStyle(undefined, ['bold', 'text-large'])), ['bold', 'text-large']);
  assert.equal(m.setTopicStyle(['bold'], []), null);
  assert.deepEqual(own(m.setTopicStyle(['future-x', 'bold'], [])), ['future-x']);
  assert.deepEqual(own(m.setTopicStyle(undefined, ['text-small', 'text-large'])), ['text-small'], 'one text size at most');
});

test('style label keys: one i18n key per token', () => {
  const keys = m.TOPIC_STYLES.map(id => m.styleLabelKey(id));
  assert.equal(new Set(keys).size, 5);
  for (const k of keys) assert.match(k, /^ui\.topic_style_/);
});

test('style compat: the 0.28 frontmatter writer keeps topic-style when it changes other keys', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-frontmatter-0.28.ts.txt'), 'utf8');
  const legacy = loadSource(`${source}\n`, { obsidian: { parseYaml: text => YAML.parse(text) } });
  const note = '---\ntitle: T\ntopic-style:\n  - "bold"\n  - "future-x"\n  - "text-large"\ntopic-markers:\n  - star\nupdated: 2026-01-01\n---\n\n# T\n\nbody\n';
  assert.doesNotThrow(() => legacy.frontmatter(note));
  assert.deepEqual(own(m.readTopicStyle(legacy.frontmatter(note))), ['bold', 'text-large']);
  const toggled = legacy.setFrontmatterKeys(note, { 'topic-markers': ['star', 'done'] });
  const colored = legacy.setFrontmatterKeys(toggled, { 'topic-color': 'red' });
  const summary = legacy.setFrontmatterKeys(colored, { updated: '2026-02-02' });
  for (const out of [toggled, colored, summary]) {
    assert.match(out, /topic-style:\n  - "bold"\n  - "future-x"\n  - "text-large"\n/, 'topic-style lines are untouched');
    assert.deepEqual(own(m.readTopicStyle(legacy.frontmatter(out))), ['bold', 'text-large']);
  }
  assert.equal(summary.endsWith('\n---\n\n# T\n\nbody\n'), true);
});
