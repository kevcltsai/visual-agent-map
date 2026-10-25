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
  'check-test-timing.cjs'
];
const directory = path.join(__dirname, 'suites');
assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith('.cjs')).sort(), suites.slice().sort(), 'tests/run.cjs must list every file in tests/suites');
for (const suite of suites) require(path.join(directory, suite));
