// Import boundary between AIM and the rest of the plugin (AIM removal, ticket 05).
// AIM modules: experiences/aim/**, core/steps/aim/**, ai/aim-*, ui/modals/aim-*. Every other product .ts file is non-AIM.
// Modules that AIM and the general AI features share live outside the AIM directories (core/content-language.ts,
// core/legacy-names.ts). A non-AIM file may still import an AIM module only for an AIM entry point or an AIM-only
// branch; those imports are listed below, one by one, and go away when the AIM engine is deleted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { repoFiles } = require('./support-repo-scan.cjs');

const root = path.resolve(__dirname, '..');
const isAim = file => /^(?:experiences\/aim\/|core\/steps\/aim\/|ai\/aim-|ui\/modals\/aim-)/.test(file);
const SHARED = ['core/content-language.ts', 'core/legacy-names.ts'];
const MOVED_FROM = ['experiences/aim/content-language.ts', 'experiences/aim/legacy-names.ts'];

// Non-AIM file -> AIM module it imports. Each one is an AIM entry point, an AIM-only branch (behind aimEnabled() or the
// "aim" prompt profile), or the AIM feature flag itself; none is used by a general feature. Do not add to this list.
const AIM_ONLY_IMPORTS = [
  'core/steps/task/parse.ts -> ai/aim-contracts.ts',
  'core/steps/task/render.ts -> core/steps/aim/shell.ts',
  'core/steps/task/schemas.ts -> ai/aim-contracts.ts',
  'core/steps/task/schemas.ts -> ai/aim-gap-audit-schema.ts',
  'core/steps/task/step.ts -> ai/aim-contracts.ts',
  'core/steps/task/step.ts -> ai/aim-prompt.ts',
  'ai/types.ts -> ai/aim-contracts.ts',
  'experiences/sharing/share-format.ts -> experiences/aim/availability.ts',
  'experiences/visual-map/cross-map-history.ts -> experiences/aim/availability.ts',
  'experiences/visual-map/view.ts -> experiences/aim/aim-note-style.ts',
  'experiences/visual-map/view.ts -> experiences/aim/availability.ts',
  'experiences/visual-map/view.ts -> experiences/aim/create-map.ts',
  'experiences/visual-map/view.ts -> experiences/aim/failure-hint.ts',
  'experiences/visual-map/view.ts -> experiences/aim/manual-flow-support.ts',
  'experiences/visual-map/view.ts -> experiences/aim/manual-flow.ts',
  'experiences/visual-map/view.ts -> experiences/aim/research-run-store.ts',
  'experiences/visual-map/view.ts -> experiences/aim/retry-targets.ts',
  'experiences/visual-map/view.ts -> ui/modals/aim-answer-modal.ts',
  'experiences/visual-map/view.ts -> ui/modals/aim-assumption-modal.ts',
  'experiences/visual-map/view.ts -> ui/modals/aim-clarification-modal.ts',
  'experiences/visual-map/view.ts -> ui/modals/aim-start-modal.ts',
  'experiences/visual-map/view.ts -> ui/modals/aim-steer-modal.ts',
  'main.ts -> experiences/aim/availability.ts',
  'main.ts -> experiences/aim/flow-limits.ts',
  'map-model.ts -> experiences/aim/availability.ts',
  'map-model.ts -> experiences/aim/final-delivery.ts',
  'map-model.ts -> experiences/aim/research-plan.ts',
  'repository.ts -> experiences/aim/availability.ts',
  'ui/modals/note-style-manage-modal.ts -> experiences/aim/availability.ts',
  'ui/settings-tab.ts -> experiences/aim/availability.ts'
].sort();

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

test('AIM import boundary: non-AIM files import AIM modules only for the listed AIM entry points and AIM-only branches', () => {
  const edges = new Set();
  for (const file of productFiles().filter(item => !isAim(item))) for (const target of importsOf(file)) if (isAim(target)) edges.add(`${file} -> ${target}`);
  const actual = [...edges].sort();
  assert.deepEqual(actual.filter(edge => !AIM_ONLY_IMPORTS.includes(edge)), [], 'a non-AIM file imports an AIM module: move a shared module out of the AIM directories instead');
  assert.deepEqual(AIM_ONLY_IMPORTS.filter(edge => !edges.has(edge)), [], 'listed imports that no longer exist must be removed from AIM_ONLY_IMPORTS');
  for (const file of SHARED) assert.equal(actual.some(edge => edge.endsWith(`-> ${file}`)), false);
});

test('AIM import boundary: the scan sees the imports it checks (static, type-only, multi-line)', () => {
  const view = importsOf('experiences/visual-map/view.ts');
  assert.ok(view.includes('core/content-language.ts'), 'the multi-line import of view.ts is read');
  assert.ok(importsOf('ai/types.ts').includes('ai/aim-contracts.ts'), 'a type-only import is read');
  assert.ok(importsOf('repository.ts').includes('core/legacy-names.ts'));
});
