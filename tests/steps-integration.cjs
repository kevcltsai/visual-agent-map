// S2 integration guards: every model call goes through a StepProvider, and no prompt text is left in i18n.ts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', 'tests', '.git', 'samples', 'scripts'].includes(entry.name)) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

// Every runtime.runTask call outside ai/runtime/ is a provider adapter (or the runtime behind one), pinned by
// file, enclosing function and count so a new direct call anywhere fails this test.
const RUN_TASK_CALLERS = [
  { file: 'core/runtime-step-provider.ts', method: 'export function runtimeStepProvider(', count: 2, reason: 'shared StepProvider over the Claude and Codex runtimes' },
  { file: 'core/reframing-service.ts', method: 'export function providerReframeRunner(', count: 2, reason: 'stop-checking runtime wrappers passed into runtimeStepProvider' },
  { file: 'core/provider-step-runner.ts', method: 'export function providerStepRunner<', count: 2, reason: 'stop-checking runtime wrappers passed into runtimeStepProvider (outline-generate, structure-review)' },
  { file: 'main.ts', method: 'async runCoffeeRequest(', count: 2, reason: 'the runtime behind experiences/coffee-tables/step-provider.ts' }
];
// The function containing `index`: the nearest preceding top-level function or two-space class member.
function enclosingMethod(source, index) {
  const before = source.slice(0, index).split('\n');
  for (let line = before.length - 1; line >= 0; line--) if (/^(?:export )?(?:async )?function |^  (?:private |public |protected )?(?:async )?(?!(?:if|for|while|switch|return|catch|await|const|let)\b)[A-Za-z_$][\w$]*\s*[(<]/.test(before[line])) return before[line].trim();
  return '';
}

test('only StepProvider adapters call runtime.runTask', () => {
  const found = {};
  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.startsWith('ai/runtime/')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\.runTask\(/g)) {
      const method = enclosingMethod(source, match.index);
      const allowed = RUN_TASK_CALLERS.find(entry => entry.file === relative && method.startsWith(entry.method));
      assert.ok(allowed, `${relative}: direct runTask call in "${method}" is not a listed StepProvider adapter`);
      found[`${allowed.file} ${allowed.method}`] = (found[`${allowed.file} ${allowed.method}`] ?? 0) + 1;
    }
  }
  assert.deepEqual(found, Object.fromEntries(RUN_TASK_CALLERS.map(entry => [`${entry.file} ${entry.method}`, entry.count])));
});

test('runCoffeeRequest, which takes a raw prompt, is only wired into the Coffee Tables step provider', () => {
  const uses = sourceFiles(root).flatMap(file => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    return [...fs.readFileSync(file, 'utf8').matchAll(/runCoffeeRequest\(/g)].map(() => relative);
  });
  // The definition, the plugin's own Coffee view factory and the view's engine wiring.
  assert.deepEqual(uses.sort(), ['experiences/coffee-tables/view.ts', 'main.ts', 'main.ts']);
});

test('i18n.ts holds no prompt.* keys', () => {
  assert.deepEqual(require('./support.cjs').i18nSource().match(/["']prompt\.[a-z0-9_]+["']/g) ?? [], []);
});
