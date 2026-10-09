const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
function load(file) {
  const module = { exports: {} };
  vm.runInNewContext(buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text, { module, exports: module.exports, require, console, AbortController });
  return module.exports;
}
const { evidenceCard } = load('experiences/mind-search/evidence-context.ts');
const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
const report = 'Unique earlier evidence '.repeat(3000) + '\n\nUnresolved: provider availability\n\nSource: https://example.org/report';
const id = 'report-v1';
const context = { title: 'Goal', summary: '', detail: '', rules: '', task: '<!-- mindsearch-phase: report-review -->\nReview evidence.', ancestors: evidenceCard(id, 'Known finding', report), mindSearchEvidenceIds: [id] };
const lookup = { summary: 'Need full evidence', detail: '<!-- mindsearch-evidence-request {"ids":["report-v1"]} -->', suggestions: [] };
function setup(ask, read = async () => ({ detail: report })) {
  const flow = new MindSearchManualFlow({ settings: { language: 'en' }, readNote: read }, {}, ask);
  flow.evidenceReports.set(id, { path: 'report.md', hash: createHash('sha256').update(report).digest('hex') });
  return flow;
}
test('MindSearch evidence card remains compact with sources and explicit omissions', () => {
  assert.ok(context.ancestors.length < 1200);
  assert.match(context.ancestors, /https:\/\/example.org\/report/);
  assert.match(context.ancestors, /Unresolved: provider availability/);
  assert.match(context.ancestors, /index is incomplete/);
  assert.ok(!context.ancestors.includes(report));
});
test('MindSearch requested report is loaded intact only for the authorized context', async () => {
  const calls = [];
  const flow = setup(async request => { calls.push(request); return calls.length === 1 ? lookup : { summary: 'Checked', detail: 'Supported', suggestions: [] }; });
  await flow.askMindSearchModel(context, 'test');
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].task.includes(report));
  assert.ok(calls[1].task.includes(report));
  assert.equal(calls[0].promptProfile, 'mindsearch');
});
test('MindSearch text cannot authorize evidence outside the branch allowlist', async () => {
  let reads = 0;
  const flow = setup(async () => lookup, async () => { reads++; return { detail: report }; });
  await assert.rejects(flow.askMindSearchModel({ ...context, mindSearchEvidenceIds: [] }, 'test'), /Invalid MindSearch evidence lookup/);
  assert.equal(reads, 0);
});
test('MindSearch changed evidence and repeated lookup cannot reach conclusion', async () => {
  await assert.rejects(setup(async () => lookup, async () => ({ detail: 'Changed' })).askMindSearchModel(context, 'test'), /evidence changed/);
  await assert.rejects(setup(async () => lookup).askMindSearchModel(context, 'test'), /lookup limit reached/);
});
