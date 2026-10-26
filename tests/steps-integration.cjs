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
  { file: 'core/ai-runtime-service.ts', method: 'export function claudeCodeAiRuntime(', count: 1, reason: 'AiRuntime adapter over the Claude Code CLI runtime' },
  { file: 'core/ai-runtime-service.ts', method: 'export function codexAppServerAiRuntime(', count: 1, reason: 'AiRuntime adapter over the Codex app server runtime' }
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

test('runCoffeeRequest is a thin wiring over AiCalls.runCall', () => {
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const start = main.indexOf('async runCoffeeRequest(');
  const end = main.indexOf('private async markdownContextImage', start);
  assert.ok(start >= 0 && end > start);
  const body = main.slice(start, end);
  for (const forbidden of ['providerForModel(', '.runTask(', 'new AbortController', 'activeTasks', 'exchanges', 'randomUUID'])
    assert.equal(body.split(forbidden).length - 1, 0, `${forbidden} must not appear in runCoffeeRequest`);
  assert.equal(body.split('this.aiCalls.runCall(').length - 1, 1);
});

test('i18n.ts holds no prompt.* keys', () => {
  assert.deepEqual(require('./support.cjs').i18nSource().match(/["']prompt\.[a-z0-9_]+["']/g) ?? [], []);
});
