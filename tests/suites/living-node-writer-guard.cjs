const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root } = require('../support.cjs');
const { repoFiles } = require('../support-repo-scan.cjs');

// Every call of a guarded vault writer outside repository.ts either passes an admission flag (rejectAiCard / newVisualReferences)
// or is one of these non-AI or already-gated callers. Values are the exact number of unflagged call sites per file (declarations included).
const unflagged = {
  'core/book-pipeline/plan-edit.ts': [3, 'plan-edit ports: owner-authorized plan edits, not AI'],
  'core/repository-relocation.ts': [2, 'folder relocation rewrites, not AI'],
  'core/repository-workspace-move.ts': [1, 'workspace move rewrites, not AI'],
  'experiences/markdown-context/image-translate-action.ts': [1, 'editor-side AI writer; livingEditorRefusal runs before the write'],
  'experiences/visual-map/book-pipeline-run.ts': [22, 'AI writer through ports; main.ts and view.ts wrap the ports with rejectAiCard (asserted below)'],
  'experiences/visual-map/book-plan-chat.ts': [4, 'forwards the same wrapped ports'],
  'experiences/visual-map/chat-action-writer.ts': [2, 'chat file edit; map-chat-guard refuses Living Node notes first (living_node_protected)'],
  'experiences/visual-map/living-node-markdown.ts': [2, 'formal-commit port type and its own commit write'],
  'experiences/visual-map/living-node-runtime.ts': [2, 'runtime config save and diagnostic stamp'],
  'experiences/visual-map/map-transaction.ts': [2, 'map structure transaction, not AI content'],
  'experiences/visual-map/math-repair.ts': [1, 'owner-triggered math repair, not AI'],
  'experiences/visual-map/view.ts': [10, 'owner UI actions (cover, merge stamp, undo restore), not AI'],
  'main.ts': [2, 'formal-commit port rawGuarded; processNote port for image translate (gated above)']
};
const call = /\b(updateNoteGuarded|updateNoteRawGuarded|vault\.process)\s*\(/g;

test('living node writer guard: every guarded-writer call outside repository.ts has an admission flag or is allow-listed', () => {
  const counts = {};
  for (const name of repoFiles(root).filter(n => n.endsWith('.ts') && n !== 'repository.ts' && !n.startsWith('tests/') && !n.startsWith('node_modules/') && !n.includes('/node_modules/'))) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    for (const m of source.matchAll(call)) {
      if (/rejectAiCard|newVisualReferences|\.\.\.writeOptions/.test(source.slice(m.index, m.index + 700))) continue;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  const expected = Object.fromEntries(Object.entries(unflagged).map(([k, v]) => [k, v[0]]));
  assert.deepEqual(counts, expected, 'a new unflagged guarded-writer call: pass rejectAiCard/newVisualReferences for an AI writer, or allow-list it with its reason');
});

test('living node writer guard: shared writer options and the book-pipeline port wrappers keep their flags', () => {
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  for (const line of read('experiences/visual-map/topic-run.ts').split('\n').filter(l => /const writeOptions\s*=/.test(l)))
    assert.match(line, /newVisualReferences: true/);
  for (const name of ['main.ts', 'experiences/visual-map/view.ts']) {
    const source = read(name);
    assert.match(source, /updateNoteGuarded\(path, patch, \{ \.\.\.options, rejectAiCard: true \}\)/, name);
    assert.match(source, /updateNoteRawGuarded\(path, transform, \{ \.\.\.options, rejectAiCard: true \}\)/, name);
  }
});
