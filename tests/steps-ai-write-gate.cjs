// The shared AI write gate (core/ai-write-gate.ts, V3.3 #02): one table, every reason code at least once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support.cjs');
const { aiWriteGate, AI_WRITE_GATE_CODES } = load('core/ai-write-gate.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const same = { read: 'v1', now: 'v1' };
const table = [
  ['owned, nothing else known: allowed', { owned: true }, []],
  ['every fact clean: allowed', { owned: true, aiLocked: false, readOnly: false, identity: same, version: same }, []],
  ['stopped, timed out or replaced run', { owned: false }, ['owner_changed']],
  ['locked at commit', { owned: true, aiLocked: true }, ['ai_locked']],
  ['Living Node card for an unintegrated writer', { owned: true, readOnly: true }, ['read_only']],
  ['another note at the same path', { owned: true, identity: { read: 'map\ntopic-1', now: 'map\ntopic-2' } }, ['identity_changed']],
  ['content changed externally', { owned: true, version: { read: 'v1', now: 'v2' } }, ['stale']],
  ['everything at once: listed in the fixed order', { owned: false, aiLocked: true, readOnly: true, identity: { read: 'a', now: 'b' }, version: { read: 'a', now: 'b' } }, ['owner_changed', 'ai_locked', 'read_only', 'identity_changed', 'stale']],
  ['an absent stamp is not compared', { owned: true, identity: undefined, version: undefined }, []]
];

test('AI write gate: the reason code table', () => {
  for (const [name, input, expected] of table) assert.deepEqual(plain(aiWriteGate(input)), expected, name);
});

test('AI write gate: every reason code has a case in the table', () => {
  const covered = new Set(table.flatMap(([, , codes]) => codes));
  assert.deepEqual(plain(AI_WRITE_GATE_CODES).filter(code => !covered.has(code)), []);
});

test('AI write gate: the AI write paths call it; it holds no structure rule and no manual writer calls it', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const gate = read('core/ai-write-gate.ts');
  assert.doesNotMatch(gate, /canParent\(|mergeEligibility\(|^import /m, 'pure and structure-free');
  for (const file of ['repository.ts', 'experiences/visual-map/topic-run.ts', 'experiences/visual-map/chat-action-writer.ts', 'experiences/visual-map/view.ts'])
    assert.match(read(file), /aiWriteGate\(/, file);
  // The repository runs it only for an AI writer: the manual branch keeps the plain content and authorize checks.
  assert.match(read('repository.ts'), /rejectAiCard\s*\?\s*this\.aiWriteBlocked\(/);
  for (const file of ['experiences/visual-map/card-actions.ts']) assert.doesNotMatch(read(file), /aiWriteGate/, file);
});
