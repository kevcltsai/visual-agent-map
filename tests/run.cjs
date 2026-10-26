// Entry point for the unit and integration suites. `--layer=unit|integration` (read in support.cjs)
// selects which tests register; without it every suite test registers, which test:aim relies on.
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
  'expansion-and-synthesis.cjs',
  'visual-map-view.cjs',
  'map-chat.cjs',
  'merge-topics.cjs',
  'i18n.cjs',
  'references.cjs',
  'outline-import.cjs',
  'detail-templates.cjs',
  'detail-templates-ui.cjs',
  'prompt-presets.cjs',
  'map-ai-dialog.cjs',
  'map-structure.cjs',
  'map-transaction.cjs',
  'relevance-grade.cjs',
  'shell-entrances.cjs',
  'coffee-tables-core.cjs',
  'coffee-tables-session.cjs',
  'reframing.cjs',
  'aim-planner.cjs',
  'aim-start-and-lifecycle.cjs',
  'aim-branches-and-recovery.cjs',
  'aim-coverage-and-delivery.cjs',
  'aim-language-audit.cjs',
  'aim-flow-limits.cjs',
  'aim-note-paths.cjs',
  'workspace-folders.cjs',
  'upgrade-0.18.cjs',
  'partial-structured.cjs',
  'research-progress.cjs',
  'sharing.cjs',
  'sharing-viewer.cjs',
  'sharing-export.cjs',
  'sharing-translate.cjs',
  'sharing-translate-dialog.cjs',
  'sharing-mermaid-capture.cjs',
  'check-test-timing.cjs',
  'check-test-wiring.cjs'
];
const directory = path.join(__dirname, 'suites');
assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith('.cjs')).sort(), suites.slice().sort(), 'tests/run.cjs must list every file in tests/suites');
// `--shard=i/n` (1-based) registers only the suites assigned to shard i of n, so `scripts/test-integration.mjs` can run the integration layer in parallel processes.
// Suites share no files or process state (every temp path comes from mkdtemp, and each suite passes alone in a fresh process), so any partition keeps the same tests.
// The assignment is greedy by approximate integration seconds (default 2) and deterministic; the shards partition `suites`, so no suite is dropped or repeated.
const shard = process.argv.find(value => value.startsWith('--shard='))?.split('=')[1];
const weights = { 'map-chat.cjs': 60, 'relevance-grade.cjs': 18, 'expansion-and-synthesis.cjs': 16, 'map-ai-dialog.cjs': 11, 'notes-repository.cjs': 11, 'visual-map-view.cjs': 9, 'outline-import.cjs': 6, 'aim-coverage-and-delivery.cjs': 5, 'reframing.cjs': 5, 'map-structure.cjs': 5 };
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
for (const suite of selected) require(path.join(directory, suite));
