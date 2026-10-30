// Architecture rules for the Step Runner (tests/steps-*.cjs files are discovered by `npm run test:unit`).
//  1. A model call can only be sent from a PreparedStep, and prepared.parse uses the input it was rendered from.
//  2. Natural-language string literals above a length threshold must be in an explicit allowlist, so prompt text
//     lives in step templates (Markdown) instead of TypeScript. Directories and allowlist entries come from
//     tests/literal-scan/*.json, one file per area, so parallel work never edits the same file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { load, root } = require('./support-replay.cjs');

const { prepareStep, StepRunner } = load('core/step-runner.ts');

function fakeStep(overrides = {}) {
  return { id: 'test.step', version: 2, render: input => `prompt:${input.name}`, parse: (raw, input) => ({ raw, input }), ...overrides };
}
function recordingProvider(reply = 'reply') {
  const calls = [];
  return { calls, complete: async call => { calls.push(call); return reply; } };
}

test('send() accepts only a PreparedStep: strings and look-alike objects are refused before the provider is called', async () => {
  const provider = recordingProvider(), runner = new StepRunner(provider), step = fakeStep();
  await assert.rejects(runner.send('arbitrary prompt', {}), /requires a step made by prepareStep/);
  await assert.rejects(runner.send({ step, input: { name: 'n' }, prompt: 'forged', parse: () => null }, {}), /requires a step made by prepareStep/);
  await assert.rejects(runner.send(undefined, {}), /requires a step made by prepareStep/);
  assert.equal(provider.calls.length, 0);
});

test('compile time: TypeScript rejects send() with a string and accepts it with a prepared step', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-send-type-'));
  const file = path.join(directory, 'probe.ts');
  const runnerModule = path.join(root, 'core', 'step-runner');
  fs.writeFileSync(file, [
    `import { StepRunner, prepareStep, type StepDefinition } from ${JSON.stringify(runnerModule)};`,
    'declare const step: StepDefinition<{ name: string }, string>;',
    'declare const runner: StepRunner<object>;',
    'void runner.send(prepareStep(step, { name: "n" }), {});',
    'void runner.send("a plain prompt string", {});',
    'void runner.send({ step, input: { name: "n" }, prompt: "p", parse: () => "" }, {});'
  ].join('\n'));
  const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [] });
  const lines = ts.getPreEmitDiagnostics(program).filter(item => item.file && path.resolve(item.file.fileName) === file).map(item => item.file.getLineAndCharacterOfPosition(item.start).line + 1);
  assert.deepEqual(lines, [5, 6], 'only the string call (line 5) and the forged object (line 6) are type errors; the prepared call (line 4) compiles');
});

test('prepareStep binds the input: send uses the prepared prompt and label, and parse sees the same input', async () => {
  const input = { name: 'n' }, provider = recordingProvider('raw reply'), step = fakeStep({ schema: { type: 'object' } });
  const prepared = prepareStep(step, input);
  assert.equal(prepared.prompt, 'prompt:n'); assert.equal(prepared.input, input); assert.equal(prepared.step, step);
  assert.ok(Object.isFrozen(prepared));
  const sent = await new StepRunner(provider).send(prepared, { signal: 'controls' });
  assert.deepEqual({ ...sent }, { prompt: 'prompt:n', raw: 'raw reply' });
  assert.equal(provider.calls[0].stepId, 'test.step'); assert.equal(provider.calls[0].version, 2);
  assert.equal(provider.calls[0].prompt, 'prompt:n'); assert.deepEqual({ ...provider.calls[0].schema }, { type: 'object' });
  const parsed = prepared.parse(sent.raw);
  assert.equal(parsed.raw, 'raw reply'); assert.equal(parsed.input, input, 'parse receives the identical input object');
  const events = [];
  assert.throws(() => prepareStep(fakeStep({ policy: () => { events.push('policy'); throw new Error('refused'); } }), input), /refused/);
  assert.deepEqual(events, ['policy']);
});

// ---- string literal scan ----
const WEIGHTED_MINIMUM = 40; // a CJK character counts 2, any other character 1
const CJK = /[㐀-鿿]/;
const isNaturalLanguage = text => CJK.test(text) || text.split(/\s+/).filter(Boolean).length >= 5;
const weightedLength = text => [...text].reduce((total, character) => total + (CJK.test(character) ? 2 : 1), 0);
/** Message text passed to `new XError(...)`, `XError(...)` or a `throw` is an error message, not prompt text. */
function insideErrorConstruction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isThrowStatement(current)) return true;
    if ((ts.isNewExpression(current) || ts.isCallExpression(current)) && /Error$/.test(current.expression.getText())) return true;
  }
  return false;
}
function typescriptFiles(directory, found = []) {
  if (fs.statSync(directory).isFile()) {
    if (directory.endsWith('.ts') && !directory.endsWith('.d.ts')) found.push(directory);
    return found;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) typescriptFiles(file, found);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(file);
  }
  return found;
}
/** Every natural-language literal of at least WEIGHTED_MINIMUM characters outside an Error construction. */
function longLiterals(directory) {
  const found = [];
  for (const file of typescriptFiles(directory)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2020, true);
    const visit = node => {
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      if (isText && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        const text = node.text.trim();
        if (weightedLength(text) >= WEIGHTED_MINIMUM && isNaturalLanguage(text) && !insideErrorConstruction(node))
          found.push({ file: path.relative(root, file).split(path.sep).join('/'), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
/** Split literals into allowed and unlisted; an entry with `text` matches by literal prefix, without it the whole file. */
function applyAllowlist(literals, allow) {
  const used = new Set(), unlisted = [];
  for (const literal of literals) {
    const index = allow.findIndex(entry => entry.file === literal.file && (entry.text === undefined || literal.text.startsWith(entry.text)));
    if (index < 0) unlisted.push(literal); else used.add(index);
  }
  return { unlisted, unused: allow.filter((_entry, index) => !used.has(index)) };
}

// An entry in `dirs` may also name a single .ts file, for areas whose neighbours belong to other work.
const configurations = fs.readdirSync(path.join(__dirname, 'literal-scan')).filter(name => name.endsWith('.json')).sort()
  .map(name => ({ name, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'literal-scan', name), 'utf8')) }));

test('the literal scan finds long natural-language literals, skips error messages and applies the allowlist', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-literal-scan-'));
  const file = path.join(directory, 'sample.ts');
  fs.writeFileSync(file, [
    'export const short = "Short label";',
    'export const prompt = "Summarize the following notes and return only a JSON object with a title field";',
    'export const chinese = "請整理以下內容並以繁體中文回答，保留所有條件與限制。";',
    'export const identifier = "experiences/coffee-tables/steps/convergence/prompt.en.md.something-long-without-spaces";',
    'export function fail() { throw new Error("This is a long error message that explains what went wrong clearly"); }',
    'export const wrapped = new RangeError(`A long template error message that spans ${1} several words in a row`);'
  ].join('\n'));
  const found = longLiterals(directory);
  assert.deepEqual(found.map(item => item.line), [2, 3]);
  const relative = path.relative(root, file).split(path.sep).join('/');
  assert.deepEqual(applyAllowlist(found, [{ file: relative, text: 'Summarize the following' }, { file: relative, text: '請整理' }]), { unlisted: [], unused: [] });
  const partial = applyAllowlist(found, [{ file: relative, text: 'Summarize the following' }, { file: relative, text: 'never matches' }]);
  assert.deepEqual(partial.unlisted.map(item => item.line), [3]);
  assert.deepEqual(partial.unused.map(item => item.text), ['never matches']);
  assert.deepEqual(applyAllowlist(found, [{ file: relative }]), { unlisted: [], unused: [] }, 'an entry without text allows the whole file');
});

test('scan configuration is well formed and the scanned directories are not empty', () => {
  assert.ok(configurations.length >= 1);
  for (const configuration of configurations) {
    assert.ok(Array.isArray(configuration.dirs) && configuration.dirs.length, `${configuration.name}: dirs`);
    for (const directory of configuration.dirs) assert.ok(typescriptFiles(path.join(root, directory)).length > 0, `${configuration.name}: ${directory} has no TypeScript files`);
    for (const entry of configuration.allow) {
      assert.ok(typeof entry.file === 'string' && entry.file && typeof entry.reason === 'string' && entry.reason.trim().length >= 20, `${configuration.name}: every allowlist entry needs a file and a reason (${JSON.stringify(entry)})`);
      assert.ok(entry.text === undefined || (typeof entry.text === 'string' && entry.text), `${configuration.name}: text must be a non-empty prefix when present`);
      assert.ok(configuration.dirs.some(directory => entry.file === directory || entry.file.startsWith(`${directory}/`)), `${configuration.name}: ${entry.file} is outside the scanned directories`);
    }
  }
});

for (const configuration of configurations) {
  test(`literal scan ${configuration.name}: prompt text stays in step templates; everything else is allowlisted with a reason`, () => {
    const literals = configuration.dirs.flatMap(directory => longLiterals(path.join(root, directory)));
    const { unlisted, unused } = applyAllowlist(literals, configuration.allow);
    assert.deepEqual(unlisted.map(item => `${item.file}:${item.line} ${JSON.stringify(item.text.slice(0, 60))}`), [], `natural-language literal of ${WEIGHTED_MINIMUM}+ characters outside tests/literal-scan/${configuration.name}: move prompt text to a step template, or allowlist it with a reason`);
    assert.deepEqual(unused.map(entry => `${entry.file} ${entry.text ?? '(whole file)'}`), [], 'allowlist entries that match nothing must be removed');
  });
}

test('Coffee shared fragments: every language pair exists and each fragment is used by a step', () => {
  const directory = path.join(root, 'experiences', 'coffee-tables', 'steps', '_shared');
  const names = fs.readdirSync(directory);
  const pairs = names.filter(name => /\.(zh|en)\.md$/.test(name)).map(name => name.replace(/\.(zh|en)\.md$/, ''));
  for (const base of new Set(pairs)) for (const language of ['zh', 'en']) assert.ok(names.includes(`${base}.${language}.md`), `${base}.${language}.md is missing`);
  const fragments = fs.readFileSync(path.join(directory, 'fragments.ts'), 'utf8');
  for (const name of names.filter(item => item.endsWith('.md'))) assert.ok(fragments.includes(`./${name}`), `${name} is not imported by fragments.ts`);
});

// ---- AiCalls call-site boundary and i18n guards (S2 integration guards: every model call goes through AiCalls, and no prompt text is left in i18n.ts) ----
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
