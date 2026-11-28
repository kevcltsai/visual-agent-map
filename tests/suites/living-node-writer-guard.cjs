const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root } = require('../support.cjs');
const { repoFiles } = require('../support-repo-scan.cjs');

// Guarded vault writers: an AI writer must pass an admission flag inside the same call expression. Every other call (or declaration)
// is listed here as `file: { writer: [exact count, reason] }`, so a new unflagged call, or a retired one, fails the test.
const repoSource = fs.readFileSync(path.join(root, 'repository.ts'), 'utf8');
// Every `write*` method the Repository itself defines is a writer, found by name so a new one is covered automatically.
const repoWriters = [...new Set([...repoSource.matchAll(/^  (?:async )?(write[A-Z]\w*)\(/gm)].map(m => m[1]))];
const WRITERS = new RegExp(`(?<![\\w$])(updateNoteGuarded|updateNoteRawGuarded|updateNote|noteChange|vault\\.process|(?<=\\.)(?:${repoWriters.join('|')}))\\s*\\(`, 'g');
const FLAG = /rejectAiCard|newVisualReferences|\bwriteOptions\b/;

/** The text of the call expression starting at the `(` at `open`, with string/template/comment content skipped for paren depth. */
function callText(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if (c === '/' && source[i + 1] === '/') i = source.indexOf('\n', i) - 1;
    else if (c === '/' && source[i + 1] === '*') i = source.indexOf('*/', i) + 1;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return source.slice(open, i + 1);
    if (i < 0) break;
  }
  return source.slice(open);
}

function unflaggedCalls() {
  const found = {};
  for (const name of repoFiles(root).filter(n => n.endsWith('.ts') && n !== 'repository.ts' && !n.startsWith('tests/') && !n.includes('node_modules/'))) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    for (const m of source.matchAll(WRITERS)) {
      const text = callText(source, m.index + m[0].length - 1);
      // noteChange takes the flag as its 4th positional argument.
      const flagged = m[1] === 'noteChange' ? /,\s*true\s*\)$/.test(text) : FLAG.test(text);
      if (flagged) continue;
      ((found[name] ??= {})[m[1]] ??= 0, found[name][m[1]]++);
    }
  }
  return found;
}
const ALLOWED = {
  'core/book-pipeline/plan-edit.ts': { reason: 'plan-edit ports: owner-authorized plan edits, not AI', calls: {'updateNoteGuarded': 3} },
  'core/repository-relocation.ts': { reason: 'folder relocation rewrites, not AI', calls: {'vault.process': 2} },
  'core/repository-workspace-move.ts': { reason: 'workspace move rewrites, not AI', calls: {'vault.process': 1} },
  'experiences/markdown-context/image-translate-action.ts': { reason: 'editor-side AI writer; livingEditorRefusal runs before the write', calls: {'vault.process': 1} },
  'experiences/visual-map/argument-run.ts': { reason: 'AI writer through a port; main.ts wires updateNote to updateNoteGuarded with rejectAiCard (asserted below)', calls: {'updateNote': 2} },
  'experiences/visual-map/book-pipeline-run.ts': { reason: 'AI writer through ports; main.ts and view.ts wrap them with rejectAiCard (asserted below); writePipelineFields/Role are pipeline metadata', calls: {'updateNoteGuarded': 12, 'updateNoteRawGuarded': 10, 'writePipelineFields': 6, 'writePipelineRole': 1} },
  'experiences/visual-map/book-plan-chat.ts': { reason: 'forwards the same wrapped ports', calls: {'updateNoteGuarded': 2, 'updateNoteRawGuarded': 2} },
  'experiences/visual-map/book-structure-port.ts': { reason: 'title rewrite inside a map transaction, not AI content', calls: {'updateNote': 1} },
  'experiences/visual-map/chat-action-writer.ts': { reason: 'chat actions; map-chat-guard refuses Living Node notes first (living_node_protected) and the view port passes rejectAiCard on content', calls: {'noteChange': 3, 'vault.process': 2, 'writeTopicAppearance': 1, 'writeTopicKind': 1, 'writeHypothesisLeaning': 1, 'writeHypothesisStrength': 1} },
  'experiences/visual-map/living-node-markdown.ts': { reason: 'formal-commit port type and its own commit write', calls: {'updateNoteRawGuarded': 2} },
  'experiences/visual-map/living-node-runtime.ts': { reason: 'runtime config save and diagnostic stamp', calls: {'updateNoteRawGuarded': 1, 'updateNoteGuarded': 1} },
  'experiences/visual-map/map-sources-control.ts': { reason: 'owner map-source edit, not AI', calls: {'writeMapSources': 1} },
  'experiences/visual-map/map-transaction.ts': { reason: 'map structure transaction, not AI content', calls: {'vault.process': 2} },
  'experiences/visual-map/math-repair.ts': { reason: 'owner-triggered math repair, not AI', calls: {'vault.process': 1} },
  'experiences/visual-map/outline-import.ts': { reason: 'summary of a card created by the import, not an existing Living Node', calls: {'updateNote': 1} },
  'experiences/visual-map/topic-run.ts': { reason: 'status stamps; content writes carry writeOptions with newVisualReferences (asserted below)', calls: {'updateNote': 3} },
  'experiences/visual-map/view.ts': { reason: 'owner UI actions (metadata, cover, merge stamp, undo restore), chat picture cover (checked on its own bytes); chat content goes through noteChange with the flag', calls: {'noteChange': 7, 'vault.process': 9, 'updateNote': 4, 'writeTopicAppearance': 3, 'writeAiLocked': 3, 'writeBookRoleChoice': 1, 'writeAiCard': 2, 'writeHypothesisStrength': 1, 'writeHypothesisLeaning': 1, 'writeTopicKind': 1, 'writeTopicLinks': 1, 'writeTopicMarkers': 1, 'writeTopicColor': 1, 'writeTopicStyle': 1, 'writeBookSettings': 1, 'updateNoteRawGuarded': 1, 'writeNoteStyle': 1} },
  'main.ts': { reason: 'formal-commit port rawGuarded; pipeline field ports; processNote port for image translate (gated above)', calls: {'updateNoteRawGuarded': 1, 'writePipelineFields': 2, 'writePipelineRole': 1, 'vault.process': 1} }
};

test('living node writer guard: every guarded-writer call outside repository.ts has an admission flag in its own call expression or is allow-listed', () => {
  const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, v]) => [file, v.calls]));
  assert.deepEqual(unflaggedCalls(), expected, 'a new unflagged writer call: pass rejectAiCard/newVisualReferences (noteChange: 4th argument true) for an AI writer, or allow-list it with its reason');
});

test('living node writer guard: the scanner binds the flag to the call and sees the writers', () => {
  assert.ok(repoWriters.includes('writeAiRunStamp') && repoWriters.length > 10);
  const source = 'a.updateNoteGuarded(p, { x: 1 }, { rejectAiCard: true });\nb.updateNoteGuarded(p, x);\n// rejectAiCard\nconst o = { rejectAiCard: true };';
  const calls = [...source.matchAll(WRITERS)].map(m => FLAG.test(callText(source, m.index + m[0].length - 1)));
  assert.deepEqual(calls, [true, false], 'a flag next to the call but outside its parentheses does not count');
  const text = callText('x.noteChange(node, { a: "(" }, undefined, true)', 12);
  assert.match(text, /,\s*true\s*\)$/);
});

test('living node writer guard: shared writer options and the AI ports keep their flags', () => {
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  for (const line of read('experiences/visual-map/topic-run.ts').split('\n').filter(l => /const writeOptions\s*=/.test(l)))
    assert.match(line, /newVisualReferences: true/);
  for (const name of ['main.ts', 'experiences/visual-map/view.ts']) {
    const source = read(name);
    assert.match(source, /updateNoteGuarded\(path, patch, \{ \.\.\.options, rejectAiCard: true \}\)/, name);
    assert.match(source, /updateNoteRawGuarded\(path, transform, \{ \.\.\.options, rejectAiCard: true \}\)/, name);
  }
  assert.match(read('main.ts'), /updateNoteGuarded\(path, patch, \{ rejectAiCard: true \}\)/, 'argument-run port');
  assert.match(read('experiences/visual-map/view.ts').replace(/\s+/g, ' '), /noteChange\( again\.node, \{ detail:[^;]*?, true \)/, 'chat picture placement passes rejectAiCard');
});
