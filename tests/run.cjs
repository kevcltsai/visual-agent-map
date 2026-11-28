// Entry point for the unit and integration suites. `--layer=unit|integration` (read in support.cjs)
// selects which tests register; without it every suite test registers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const suites = [
  'map-model.cjs',
  'settings-and-models.cjs',
  'architecture.cjs',
  'samples-and-workspace.cjs',
  'logging.cjs',
  'codex-runtime.cjs',
  'claude-runtime.cjs',
  'ai-tasks.cjs',
  'notes-repository.cjs',
  'living-node-markdown.cjs',
  'living-node-writer-admission.cjs',
  'living-node-writer-guard.cjs',
  'living-node-provider.cjs',
  'expansion-and-synthesis.cjs',
  'visual-map-view.cjs',
  'map-chat.cjs',
  'topic-chat.cjs',
  'merge-topics.cjs',
  'i18n.cjs',
  'references.cjs',
  'outline-import.cjs',
  'detail-templates.cjs',
  'prompt-presets.cjs',
  'map-ai-dialog.cjs',
  'map-structure.cjs',
  'map-transaction.cjs',
  'shell-entrances.cjs',
  'reframing.cjs',
  'legacy-aim-map.cjs',
  'workspace-folders.cjs',
  'upgrade-0.18.cjs',
  'partial-structured.cjs',
  'research-progress.cjs',
  'sharing.cjs',
  'sharing-viewer.cjs',
  'map-view-color.cjs',
  'mermaid-color.cjs',
  'sharing-export.cjs',
  'sharing-translate.cjs',
  'sharing-translate-dialog.cjs',
  'sharing-mermaid-capture.cjs',
  'test-affected.cjs',
  'check-test-timing.cjs',
  'check-test-wiring.cjs',
  'check-workflows.cjs',
  'ci-shard.cjs',
  'heavy-lock.cjs',
  'obsidian-cdp-trust.cjs',
  'obsidian-cdp-input.cjs',
  'obsidian-cdp-target.cjs',
  'provider-guard.cjs'
];
const directory = path.join(__dirname, 'suites');
assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith('.cjs')).sort(), suites.slice().sort(), 'tests/run.cjs must list every file in tests/suites');
// `--shard=i/n` (1-based) registers only the suites assigned to shard i of n, so `scripts/test-integration.mjs` can run the integration layer in parallel processes.
// Suites share no files or process state (every temp path comes from mkdtemp, and each suite passes alone in a fresh process), so any partition keeps the same tests.
// The assignment is greedy by approximate seconds in the run's layer (default 2) and deterministic; the shards partition `suites`, so no suite is dropped or repeated.
// Unit seconds are each suite run alone (2026-11-26, Apple M1): its headless-Chrome suites used to land on one shard under the integration weights.
const shard = process.argv.find(value => value.startsWith('--shard='))?.split('=')[1];
const layerWeights = {
  unit: { 'sharing-viewer.cjs': 51, 'heavy-lock.cjs': 20, 'map-chat.cjs': 13, 'test-affected.cjs': 5, 'map-view-color.cjs': 4, 'i18n.cjs': 3 },
  integration: { 'map-chat.cjs': 60, 'expansion-and-synthesis.cjs': 16, 'map-ai-dialog.cjs': 11, 'notes-repository.cjs': 11, 'visual-map-view.cjs': 9, 'outline-import.cjs': 6, 'reframing.cjs': 5, 'map-structure.cjs': 5 }
};
const weights = layerWeights[process.argv.find(value => value.startsWith('--layer='))?.split('=')[1]] ?? layerWeights.integration;
function shardOf(index, count) {
  const loads = Array.from({ length: count }, () => ({ weight: 0, suites: [] }));
  for (const suite of suites.slice().sort((a, b) => (weights[b] ?? 2) - (weights[a] ?? 2) || a.localeCompare(b))) {
    const lightest = loads.reduce((a, b) => (b.weight < a.weight ? b : a));
    lightest.weight += weights[suite] ?? 2; lightest.suites.push(suite);
  }
  return loads[index - 1].suites;
}
let selected = suites;
if (shard) {
  const [index, count] = shard.split('/').map(Number);
  assert.ok(Number.isInteger(index) && Number.isInteger(count) && count >= 1 && index >= 1 && index <= count, `bad --shard=${shard}`);
  selected = shardOf(index, count);
}
// `VAM_AFFECTED_TESTS=a,b` (set by scripts/test-affected.mjs) registers only the listed suites, as repo paths such as tests/suites/map-model.cjs.
if (process.env.VAM_AFFECTED_TESTS) {
  const affected = new Set(process.env.VAM_AFFECTED_TESTS.split(','));
  selected = selected.filter(suite => affected.has(`tests/suites/${suite}`));
}
if (process.env.VAM_ISOLATED_SUITES === '1' && process.env.VAM_AFFECTED_TESTS && process.env.CI !== 'true' && !process.env.VAM_CI_SHARD && selected.length) {
  // Node's test runner starts a fresh process per file. Keep concurrency bounded by
  // the existing shards, and pass the layer only to these suite files.
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, VAM_ISOLATED_TEST_LAYER: process.argv.find(value => value.startsWith('--layer='))?.split('=')[1] || '' };
  delete env.VAM_ISOLATED_SUITES;
  delete env.VAM_AFFECTED_TESTS;
  delete env.NODE_TEST_CONTEXT; // nested runner must start its own per-file processes
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selected.map(suite => path.join(directory, suite))], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  for (const suite of selected) require(path.join(directory, suite));
}
