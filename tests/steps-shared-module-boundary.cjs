// Import boundary of the AIM removal (tickets 05 and 07).
// AIM modules lived in experiences/aim/**, core/steps/aim/**, ai/aim-* and ui/modals/aim-*. Ticket 05 moved the modules AIM shared
// with the general AI features out of them (core/content-language.ts, core/legacy-names.ts); ticket 07 deleted the AIM engine, so
// those directories and files are gone and no product file may import from them. The allowlist of AIM-only imports is empty.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { repoFiles } = require('./support-repo-scan.cjs');

const root = path.resolve(__dirname, '..');
const isAim = file => /^(?:experiences\/aim(?:\/|\.ts$)|core\/steps\/aim(?:\/|\.ts$)|ai\/aim-|ui\/modals\/aim-)/.test(file);
const SHARED = ['core/content-language.ts', 'core/legacy-names.ts'];
const MOVED_FROM = ['experiences/aim/content-language.ts', 'experiences/aim/legacy-names.ts'];
const AIM_DIRECTORIES = ['experiences/aim', 'core/steps/aim'];

// Non-AIM file -> AIM module it imports. Empty since ticket 07: do not add to this list.
const AIM_ONLY_IMPORTS = [];

function productFiles() {
  return repoFiles(root, { skipDirectories: ['node_modules', '.git', 'tests', 'scripts', 'docs'] })
    .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'));
}

/** Repository paths of the relative .ts modules `file` imports or re-exports (static and dynamic). */
function importsOf(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.filter(specifier => specifier.startsWith('.')).map(specifier => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) if (fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile()) return candidate;
    return target;
  });
}

test('AIM import boundary: the shared language and legacy-name modules live outside the AIM directories', () => {
  for (const file of SHARED) assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
  for (const file of MOVED_FROM) assert.equal(fs.existsSync(path.join(root, file)), false, `${file} was moved out of the AIM directory`);
  for (const file of SHARED) assert.deepEqual(importsOf(file).filter(isAim), [], `${file} imports no AIM module`);
});

test('AIM import boundary: the AIM engine is deleted: no AIM directory or AIM module file is left', () => {
  for (const directory of AIM_DIRECTORIES) assert.equal(fs.existsSync(path.join(root, directory)), false, `${directory} is gone`);
  assert.deepEqual(productFiles().filter(isAim), [], 'no product file sits at an AIM module path');
});

test('AIM import boundary: no product file imports an AIM module (the AIM-only allowlist is empty)', () => {
  assert.deepEqual(AIM_ONLY_IMPORTS, [], 'the allowlist stays empty');
  const edges = [];
  for (const file of productFiles()) for (const target of importsOf(file)) if (isAim(target)) edges.push(`${file} -> ${target}`);
  assert.deepEqual(edges.sort(), [], 'an import points into a deleted AIM module');
});

test('AIM import boundary: the scan sees the imports it checks (static, type-only, multi-line) and would catch an AIM path', () => {
  const view = importsOf('experiences/visual-map/view.ts');
  assert.ok(view.includes('core/content-language.ts'), 'the multi-line import of view.ts is read');
  assert.ok(importsOf('ai/types.ts').includes('ai/detail-templates.ts'), 'a type-only import is read');
  assert.ok(importsOf('repository.ts').includes('core/legacy-names.ts'));
  for (const target of ['experiences/aim/manual-flow', 'experiences/aim/availability.ts', 'core/steps/aim/shell.ts', 'ai/aim-contracts', 'ui/modals/aim-start-modal.ts']) assert.equal(isAim(target), true, target);
  for (const target of ['core/content-language.ts', 'core/legacy-names.ts', 'tests/suites/legacy-aim-map.cjs', 'experiences/visual-map/view.ts']) assert.equal(isAim(target), false, target);
});
