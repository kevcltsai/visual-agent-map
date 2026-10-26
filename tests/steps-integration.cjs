// S2 integration guards: every model call goes through AiCalls, and no prompt text is left in i18n.ts.
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

// ---- AiCalls call-site boundary pins -------------------------------------------------------------------
// Limit: these are pure source scans, so they cannot catch every alias (a destructured or computed-name call,
// a re-exported function under another name). The member-list pin (2c) and the exchange-write pin (2e) block
// the main ways around the boundary; the rest is left to review.
function readSources() {
  const sources = {};
  for (const file of sourceFiles(root)) sources[path.relative(root, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
  return sources;
}
/** Per-file match counts of a global `pattern` over `sources` ({ relativePath: text }); only files with count > 0. */
function siteCounts(sources, pattern) {
  const counts = {};
  for (const [file, text] of Object.entries(sources)) {
    const count = [...text.matchAll(pattern)].length;
    if (count > 0) counts[file] = count;
  }
  return counts;
}
/** Violations of `allowed` ([{ file, count, reason }]) by `found` ({ file: count }): unlisted file, wrong count, or listed but absent. */
function pinViolations(found, allowed) {
  const violations = [];
  const listed = new Map(allowed.map(entry => [entry.file, entry]));
  for (const [file, count] of Object.entries(found)) {
    const entry = listed.get(file);
    if (!entry) violations.push(`${file}: ${count} unlisted site(s)`);
    else if (entry.count !== count) violations.push(`${file}: found ${count}, allowed ${entry.count} (${entry.reason})`);
  }
  for (const entry of allowed) if (!(entry.file in found)) violations.push(`${entry.file}: listed with ${entry.count} but found 0 (${entry.reason})`);
  return violations;
}
const SEND_ONCE_START = 'const sendOnce = async (setup?: AttemptSetup)';
const SEND_ONCE_END = '// Only the main call of a research request is observed';
/** The `entryEnd: "caller"` / `calls.run(` pin on the sendOnce slice of core/ai-task-service.ts. */
function sendOnceViolations(taskServiceSource) {
  const start = taskServiceSource.indexOf(SEND_ONCE_START);
  const end = taskServiceSource.indexOf(SEND_ONCE_END);
  if (start < 0 || end <= start) return ['sendOnce slice anchors not found'];
  const slice = taskServiceSource.slice(start, end);
  const violations = [];
  const inSlice = slice.split('entryEnd: "caller"').length - 1;
  const inFile = taskServiceSource.split('entryEnd: "caller"').length - 1;
  if (inSlice !== 1) violations.push(`sendOnce has ${inSlice} entryEnd: "caller", expected 1`);
  if (inFile !== inSlice) violations.push(`${inFile - inSlice} entryEnd: "caller" outside the sendOnce slice`);
  const runs = slice.split('calls.run(').length - 1;
  if (runs !== 1) violations.push(`sendOnce has ${runs} calls.run(, expected 1`);
  return violations;
}
const CALL_OPTION_MEMBERS = 'model,effort,topic,taskName,signal,localCodex,mode,requestLog,stopped,validate,afterReply,exchangeId,extraMilestones,milestones,task,onBegin,failMessage,entryEnd';
/** Member names of `export interface AiCallOptions {` in core/ai-calls.ts, comma-joined. */
function callOptionMembers(aiCallsSource) {
  const start = aiCallsSource.indexOf('export interface AiCallOptions {');
  if (start < 0) return 'AiCallOptions not found';
  const end = aiCallsSource.indexOf('\n}', start);
  return [...aiCallsSource.slice(start, end < 0 ? undefined : end).matchAll(/^  (\w+)\??[:(]/gm)].map(match => match[1]).join(',');
}

const PROVIDER_FOR_MODEL = /\bproviderForModel\b/g;
const CLAUDE_PREFIX = /startsWith\(\s*["'\x60]claude:/g;
const ENTRY_END = /\bentryEnd\b/g;
const EXCHANGE_WRITE = /exchanges(?:\(\))?\??\.(?:begin|sent|received|parsed|completed|failed|milestones)\(/g;
const ACTIVE_TASKS_SET = /\bactiveTasks\s*\.\s*set\(/g;
const PROVIDER_FOR_MODEL_ALLOWED = [
  { file: 'ai/providers/provider.ts', count: 2, reason: 'definition and providerModelId' },
  { file: 'core/ai-runtime-service.ts', count: 2, reason: 'import and aiRuntimeForModel' },
  { file: 'core/steps/relevance-grade/step.ts', count: 3, reason: 'import and two prompt branches (kept, changing them changes the prompt input)' },
  { file: 'experiences/coffee-tables/view.ts', count: 2, reason: 'UI leftover, waits for C1' },
  { file: 'experiences/visual-map/view.ts', count: 2, reason: 'UI leftover, waits for C1' }
];
const CLAUDE_PREFIX_ALLOWED = [{ file: 'ai/providers/provider.ts', count: 1, reason: 'the one place that knows the claude: model prefix' }];
const ENTRY_END_ALLOWED = [
  { file: 'core/ai-calls.ts', count: 4, reason: 'option, doc and the two end-of-entry checks' },
  { file: 'core/ai-task-service.ts', count: 1, reason: 'the single caller-closed entry in sendOnce (D-317)' }
];
const EXCHANGE_WRITE_ALLOWED = [
  { file: 'core/ai-task-service.ts', count: 5, reason: 'AttemptSetup failed marking and the observed main call' },
  { file: 'experiences/visual-map/view.ts', count: 3, reason: 'UI leftover, waits for C1' }
];
const ACTIVE_TASKS_SET_ALLOWED = [
  { file: 'core/ai-calls.ts', count: 1, reason: 'the per-call registration' },
  { file: 'experiences/visual-map/expansion-batch.ts', count: 1, reason: 'batch Stop key (parent path), a whole-job key' },
  { file: 'experiences/visual-map/view.ts', count: 4, reason: 'UI leftover, waits for C1' },
  { file: 'experiences/coffee-tables/handoff-modal.ts', count: 1, reason: 'reframe-modal key, a whole-job Stop key around one registered AiCalls call' }
];
const ACTIVE_TASKS_FILES = ['core/ai-calls.ts', 'core/provider-step-runner.ts', 'main.ts', 'experiences/coffee-tables/handoff-modal.ts', 'experiences/visual-map/modals.ts', 'experiences/visual-map/view.ts', 'experiences/visual-map/expansion-batch.ts'];

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

test('only the AiRuntime adapters call runtime.runTask', () => {
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

test('providerForModel stays out of AiTaskService and the claude: prefix stays in provider.ts', () => {
  const sources = readSources();
  assert.deepEqual(pinViolations(siteCounts(sources, PROVIDER_FOR_MODEL), PROVIDER_FOR_MODEL_ALLOWED), []);
  assert.deepEqual(pinViolations(siteCounts(sources, CLAUDE_PREFIX), CLAUDE_PREFIX_ALLOWED), []);
});

test('entryEnd is only set by the sendOnce main call and AiCallOptions keeps its member list', () => {
  const sources = readSources();
  assert.deepEqual(pinViolations(siteCounts(sources, ENTRY_END), ENTRY_END_ALLOWED), []);
  assert.deepEqual(sendOnceViolations(sources['core/ai-task-service.ts']), []);
  assert.equal(callOptionMembers(sources['core/ai-calls.ts']), CALL_OPTION_MEMBERS);
  const calls = sources['core/ai-calls.ts'];
  assert.equal(calls.split('options.entryEnd !== "caller"').length - 1, 2);
  assert.equal(calls.split('log()?.completed(').length - 1, 1);
  assert.equal(calls.split('log()?.failed(').length - 1, 1);
  assert.deepEqual(pinViolations(siteCounts(sources, EXCHANGE_WRITE), EXCHANGE_WRITE_ALLOWED), []);
});

test('activeTasks.set( is only the AiCalls registration and the listed whole-job Stop keys', () => {
  const sources = readSources();
  assert.deepEqual(pinViolations(siteCounts(sources, ACTIVE_TASKS_SET), ACTIVE_TASKS_SET_ALLOWED), []);
  assert.deepEqual(Object.keys(siteCounts(sources, /\bactiveTasks\b/g)).sort(), [...ACTIVE_TASKS_FILES].sort());
});

test('pin helpers reject every way around the boundary', () => {
  const real = readSources();
  const withFile = (file, text) => ({ ...real, [file]: text });
  const violationsFor = (sources, pattern, allowed) => pinViolations(siteCounts(sources, pattern), allowed);
  // 1 a new file calls providerForModel
  assert.notDeepEqual(violationsFor(withFile('core/x.ts', 'const p = providerForModel(m);'), PROVIDER_FOR_MODEL, PROVIDER_FOR_MODEL_ALLOWED), []);
  // 2 an aliased import is still counted
  assert.notDeepEqual(violationsFor(withFile('core/x.ts', "import { providerForModel as routeOf } from '../ai/providers/provider';"), PROVIDER_FOR_MODEL, PROVIDER_FOR_MODEL_ALLOWED), []);
  // 3 a new claude: prefix check
  assert.notDeepEqual(violationsFor(withFile('core/x.ts', 'if (model.startsWith("claude:")) return;'), CLAUDE_PREFIX, CLAUDE_PREFIX_ALLOWED), []);
  // 4 entryEnd in another file
  assert.notDeepEqual(violationsFor(withFile('core/other.ts', 'run({ entryEnd: "caller" });'), ENTRY_END, ENTRY_END_ALLOWED), []);
  // 5 renaming entryEnd in AiCallOptions fails the member list (on the real file text and on a synthetic one)
  assert.equal(callOptionMembers(real['core/ai-calls.ts']), CALL_OPTION_MEMBERS);
  const optionsStart = real['core/ai-calls.ts'].indexOf('export interface AiCallOptions {');
  const optionsEnd = real['core/ai-calls.ts'].indexOf('\n}', optionsStart);
  const renamed = real['core/ai-calls.ts'].slice(0, optionsEnd).replace(/^  entryEnd\??:/m, '  endBy?:') + real['core/ai-calls.ts'].slice(optionsEnd);
  assert.notEqual(callOptionMembers(renamed), CALL_OPTION_MEMBERS);
  assert.notEqual(callOptionMembers('export interface AiCallOptions {\n  model?: string;\n  endBy?: "caller";\n}'), CALL_OPTION_MEMBERS);
  // 6 a new activeTasks.set( outside the listed files
  assert.notDeepEqual(violationsFor(withFile('experiences/x/y.ts', 'this.plugin.activeTasks.set(k, c);'), ACTIVE_TASKS_SET, ACTIVE_TASKS_SET_ALLOWED), []);
  // 7 an allowed entry that no longer appears
  assert.notDeepEqual(pinViolations({}, [{ file: 'core/gone.ts', count: 1, reason: 'stale entry' }]), []);
  // 8 a second entryEnd: "caller" outside the sendOnce slice
  const service = real['core/ai-task-service.ts'];
  assert.deepEqual(sendOnceViolations(service), []);
  assert.notDeepEqual(sendOnceViolations(service + '\nconst again = { entryEnd: "caller" };\n'), []);
  assert.notDeepEqual(sendOnceViolations('no anchors here'), []);
  // positive case: the real repo has no violations
  assert.deepEqual(pinViolations(siteCounts(real, PROVIDER_FOR_MODEL), PROVIDER_FOR_MODEL_ALLOWED), []);
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
