// Language gate (multilingual P3, Acceptance #3): outside tests and the i18n dictionaries, no source branches on a
// specific language id, and fixed note text (note.* / detail.*) is never looked up in an interface-only language.
// Everything language-specific comes from the registry (i18n/languages.ts); a new language must not need an edit here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { root } = require('./support.cjs');
const { load } = require('./support-replay.cjs');

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'tests', 'i18n', 'samples', 'assets', 'scripts']);
function sourceFiles(directory = '') {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(relative);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && relative !== 'i18n.ts' ? [relative] : [];
  });
}
const FILES = sourceFiles();

// Language ids come from the registry, so a language added later is covered without editing this file.
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REGISTRY_IDS = load('i18n/languages.ts').LANGUAGES.map(item => item.id);
const LANGUAGE_IDS = `(?:${[...new Set(['en', ...REGISTRY_IDS])].map(escape).join('|')})`;
const REGIONAL_IDS = `(?:${REGISTRY_IDS.filter(id => id.includes('-')).map(escape).join('|')})`;
const QUOTE = '["\'`]';
// Comparing a language id literal, switching on one, testing array membership, or keying an object by a regional id.
const BRANCH_ON_ID = [
  new RegExp(`[=!]==? ?${QUOTE}${LANGUAGE_IDS}${QUOTE}`),
  new RegExp(`${QUOTE}${LANGUAGE_IDS}${QUOTE} ?[=!]==?`),
  new RegExp(`\\bcase ${QUOTE}${LANGUAGE_IDS}${QUOTE}:`),
  /startsWith\(["'`]zh/,
  new RegExp(`${QUOTE}${REGIONAL_IDS}${QUOTE}\\s*:`),
  // [ "zh-TW", "en" ].includes(language) and the reverse, language-like variables only.
  new RegExp(`\\[[^\\]]*${QUOTE}${LANGUAGE_IDS}${QUOTE}[^\\]]*\\]\\.(?:includes|indexOf|some)\\(`),
  new RegExp(`\\b\\w*[lL]ang(?:uage)?\\w*\\)?\\.includes\\(${QUOTE}${LANGUAGE_IDS}${QUOTE}\\)`),
  new RegExp(`\\bnew Set\\(\\[[^\\]]*${QUOTE}${LANGUAGE_IDS}${QUOTE}[^\\]]*\\]\\)\\.has\\(`)
];
// Tables keyed by NoteLanguage are the one allowed shape of per-language data; each is listed with its file and declaration.
const NOTE_LANGUAGE_TABLES = [{ file: 'repository.ts', declaration: /^const REFERENCE_TEXT: Readonly<Record<NoteLanguage, ReferenceText>>/ }];
// Display-only uses of note.* / detail.* keys in the interface language (never written into notes).
const NOTE_KEY_IN_UI_ALLOWLIST = [{ file: 'ui/preview-utils.ts', call: 't("note.visual_reference")', reason: 'alt text of an image shown in the preview pane, not written to a note' }];

function enclosingDeclaration(lines, index) {
  for (let cursor = index; cursor >= 0; cursor--) if (/^(?:export )?(?:const|let|function|class) /.test(lines[cursor])) return lines[cursor];
  return '';
}

test('language gate: no source outside i18n branches on a language id', () => {
  const hits = [];
  for (const file of FILES) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!BRANCH_ON_ID.some(pattern => pattern.test(line))) return;
      const allowed = NOTE_LANGUAGE_TABLES.some(table => table.file === file && table.declaration.test(enclosingDeclaration(lines, index)));
      if (!allowed) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
  assert.ok(FILES.length > 100, `the scan covers the product sources (${FILES.length} files)`);
});

test('language gate: the allowed NoteLanguage tables still exist and are typed as such', () => {
  for (const table of NOTE_LANGUAGE_TABLES) {
    const lines = fs.readFileSync(path.join(root, table.file), 'utf8').split('\n');
    assert.ok(lines.some(line => table.declaration.test(line)), `${table.file} declares its NoteLanguage table`);
  }
});

test('language gate: note.* and detail.* keys are translated with a NoteLanguage, or are on the display-only allowlist', () => {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const checker = program.getTypeChecker();
  const noteLanguages = new Set(['zh-TW', 'en']);
  const NOTE_KEY = /^(?:note|detail)\./;
  const offenders = [];
  let checked = 0;
  const visit = (file, node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      const position = () => { const { line } = file.getLineAndCharacterOfPosition(node.getStart(file)); return `${path.relative(root, file.fileName)}:${line + 1}`; };
      if (callee === 't' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && NOTE_KEY.test(node.arguments[0].text)) {
        const relative = path.relative(root, file.fileName);
        const allowed = NOTE_KEY_IN_UI_ALLOWLIST.some(item => item.file === relative && node.getText(file) === item.call);
        if (!allowed) offenders.push(`${position()}: ${node.getText(file)} uses the interface language`);
      }
      if (callee === 'translate' && node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[1]) && NOTE_KEY.test(node.arguments[1].text)) {
        checked++;
        const type = checker.getTypeAtLocation(node.arguments[0]);
        const members = type.isUnion() ? type.types : [type];
        const ok = members.every(member => member.isStringLiteral() && noteLanguages.has(member.value));
        if (!ok) offenders.push(`${position()}: translate(${node.arguments[0].getText(file)}, "${node.arguments[1].text}") first argument is ${checker.typeToString(type)}, not NoteLanguage`);
      }
    }
    ts.forEachChild(node, child => visit(file, child));
  };
  for (const file of program.getSourceFiles()) {
    const relative = path.relative(root, file.fileName);
    if (file.isDeclarationFile || relative.startsWith('..') || relative.startsWith('tests') || relative.startsWith('i18n') || relative.startsWith('node_modules')) continue;
    visit(file, file);
  }
  assert.deepEqual(offenders, []);
  assert.ok(checked >= 10, `the scan saw the note.* / detail.* translate calls (${checked})`);
});
