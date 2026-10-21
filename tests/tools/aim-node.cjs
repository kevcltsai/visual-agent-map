#!/usr/bin/env node
// L2 single-node AIM harness: runs ONE AIM step through the product path (AiTaskService -> StepRunner -> provider
// runtime) from upstream state restored out of a checkpoint, and reports what came back. It is a proof-ladder tool,
// not a test: `npm run test:aim:node -- --step=<step> --checkpoint=<fixture|file> --lang=zh|en` and it is not part of
// `npm test`. Results are labelled layer=L2 and are never an end-to-end PASS.
//
//   --step=<name>          AIM step variant, for example initial-clarification, research-plan, report-review-first
//   --checkpoint=<src>     `fixture` (default): the step contexts captured from the real AimManualFlow by
//                          tests/support-aim-flow-capture.cjs, or a JSON file exported with --export-checkpoint
//   --lang=zh|en           content language of the map the step belongs to (zh = zh-TW)
//   --ui=zh|en             interface language (default: same as --lang); the prompt must not depend on it
//   --provider=codex|claude  picks the product default model of that provider when --model is absent
//   --model=<id> --effort=<low|medium|high|auto>   override; the default is what the product uses (DEFAULT_SETTINGS)
//   --replay=<file>        answer from recorded replies instead of a provider: no network, no CLI
//   --record=<file>        after a live call, save the reply as a replay file for --replay
//   --checks=language,schema,fields|none   reply checks (default: all); a failed check exits 1
//   --out=<file>           result JSON (default: /private/tmp/vam-l2/<step>.<lang>.<mode>.<time>.json)
//   --export-checkpoint=<file>  write every step context for --lang/--ui and exit
//   --list                 list the step names of the fixture and exit
//   --json                 print the full result JSON instead of the summary
//
// Exit codes: 0 ok, 1 a reply check failed, 2 usage or checkpoint error, 3 provider/replay/parse error.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const LANG = { zh: 'zh-TW', 'zh-tw': 'zh-TW', 'zh-TW': 'zh-TW', en: 'en' };
const TOPIC = { en: 'Plan a 5-day Taipei trip', 'zh-TW': '東京五天自由行怎麼排' };

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw usage(`Unexpected argument: ${arg}`);
    const [key, ...rest] = arg.slice(2).split('=');
    options[key] = rest.length ? rest.join('=') : true;
  }
  return options;
}
function usage(message) { const error = new Error(message); error.exitCode = 2; return error; }

// --- Reply checks -------------------------------------------------------------------------------------------------

/** Minimal JSON-schema subset check (type, enum, required, properties, additionalProperties, items, anyOf); returns problems. */
function validateSchema(value, schema, at = '$') {
  const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  if (!schema || typeof schema !== 'object') return [];
  if (schema.anyOf) {
    const attempts = schema.anyOf.map(option => validateSchema(value, option, at));
    return attempts.some(list => !list.length) ? [] : [`${at}: matches none of anyOf (${attempts.map(list => list[0]).join(' | ')})`];
  }
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const actual = typeOf(value);
  if (types && !types.some(type => type === actual || (type === 'number' && actual === 'integer'))) return [`${at}: expected ${types.join('|')}, got ${actual}`];
  const problems = [];
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) problems.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${at}.${key}: required field missing`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) problems.push(...validateSchema(value[key], sub, `${at}.${key}`));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) problems.push(`${at}.${key}: unexpected field`);
  }
  if (actual === 'array' && schema.items) value.forEach((item, index) => problems.push(...validateSchema(item, schema.items, `${at}[${index}]`)));
  return problems;
}

/** Reader-facing text of an AiResult: summary, detail, suggestion titles, and the human-language strings inside aim-* markers. */
function readerText(result) {
  const strip = text => String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\]\([^)]*\)/g, ']');
  // Marker payloads carry the questions, rationales and options the user reads; skip machine tokens (ids, enums, hashes).
  const marked = [];
  const collect = value => {
    if (typeof value === 'string') { if (!/^[\w.:/#@+-]*$/.test(value)) marked.push(strip(value)); }
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const match of String(result.detail ?? '').matchAll(/<!--\s*aim-[a-z-]+\s+(\{[\s\S]*?\})\s*-->/g)) { try { collect(JSON.parse(match[1])); } catch { /* an unparsable marker is reported by the parser, not here */ } }
  return [strip(result.summary), strip(result.detail), ...(result.suggestions ?? []).map(item => strip(item.title)), ...marked].join('\n');
}
/** Heuristic: share of CJK characters against Latin letters (4 letters ~ one word ~ one CJK character of content). */
function languageCheck(result, lang) {
  const text = readerText(result);
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const share = cjk + latin / 4 === 0 ? 0 : cjk / (cjk + latin / 4);
  const pass = lang === 'zh-TW' ? cjk > 0 && share >= 0.6 : cjk === 0;
  return { check: 'language', expected: lang, pass, cjkChars: cjk, latinLetters: latin, cjkShare: Number(share.toFixed(3)), rule: lang === 'zh-TW' ? 'cjkShare >= 0.6' : 'no CJK characters in reader-facing text', note: 'Heuristic over summary, detail, suggestion titles and the natural-language strings inside aim-* markers (code, URLs and machine tokens removed).' };
}
const MARKER = { intake: 'aim-intake', plan: 'aim-plan', reuse: 'aim-reuse', review: 'aim-review', outline: 'aim-delivery-outline', 'delivery-research': 'aim-delivery-research' };
function fieldsCheck(result, context) {
  const missing = [];
  if (typeof result.summary !== 'string' || !result.summary.trim()) missing.push('summary');
  if (typeof result.detail !== 'string' || !result.detail.trim()) missing.push('detail');
  if (!Array.isArray(result.suggestions)) missing.push('suggestions');
  const kind = context.aimContract?.kind;
  if (kind && MARKER[kind] && !new RegExp(`<!--\\s*${MARKER[kind]}\\s`).test(result.detail ?? '')) missing.push(`detail marker ${MARKER[kind]}`);
  if (kind === 'question' && !(result.suggestions ?? []).length && result.summary !== '__AIM_NO_QUESTION__') missing.push('suggestions (answer options)');
  return { check: 'fields', contract: kind ?? null, pass: !missing.length, missing };
}

// --- Checkpoint ---------------------------------------------------------------------------------------------------

/** Every AIM step context for one content/interface language, captured from the unchanged flow (as the prompt-language test does). */
async function captureFixture(support, lang, ui) {
  const { captureAimPhaseVariants } = require('../support-aim-flow-capture.cjs');
  const found = new Map();
  for (const [variant, context] of await captureAimPhaseVariants({ topic: TOPIC[lang], ui })) found.set(variant, context);
  const subject = await support.coverageSetup(TOPIC[lang], { sharedRepo: support.fixture(ui).repo });
  const first = new Map(), inner = subject.model.ask;
  const { AimManualFlow } = support.load('experiences/aim/manual-flow.ts');
  const { AimRunStore } = support.load('experiences/aim/research-run-store.ts');
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async context => {
    const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1] ?? 'none';
    const key = phase === 'report-review' && /Hard floor: \d+ answered/.test(context.task) ? `${phase}-${first.has(phase) ? 'later' : 'first'}` : phase;
    if (!first.has(key)) first.set(key, { ...context, onProgress: undefined, signal: undefined });
    return inner(context);
  });
  await support.coverageThreeAnswers(subject);
  for (const [phase, context] of first) if (!found.has(phase)) found.set(phase, context);
  return found;
}
const cleanContext = context => JSON.parse(JSON.stringify({ ...context, onProgress: undefined, signal: undefined }));

function loadCheckpointFile(file, step) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.steps && typeof data.steps === 'object') {
    if (!data.steps[step]) throw usage(`Checkpoint ${file} has no step "${step}". Steps: ${Object.keys(data.steps).join(', ')}`);
    return data.steps[step];
  }
  const rows = Array.isArray(data) ? data : [data];
  const row = rows.find(item => item.step === step) ?? (rows.length === 1 && !rows[0].step ? rows[0] : undefined);
  const context = row?.context ?? (row?.task ? row : undefined);
  if (!context?.task) throw usage(`Checkpoint ${file} does not contain a step context for "${step}".`);
  return context;
}

// --- Main ---------------------------------------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const lang = LANG[options.lang ?? 'zh'];
  if (!lang) throw usage('--lang must be zh or en');
  const ui = LANG[options.ui ?? options.lang ?? 'zh'];
  if (!ui) throw usage('--ui must be zh or en');
  const support = require('../support.cjs');

  if (options['export-checkpoint'] || options.list) {
    const variants = await captureFixture(support, lang, ui);
    if (options.list) { console.log([...variants.keys()].sort().join('\n')); return 0; }
    const file = path.resolve(options['export-checkpoint']);
    const steps = Object.fromEntries([...variants].sort(([a], [b]) => a.localeCompare(b)).map(([name, context]) => [name, cleanContext(context)]));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, kind: 'aim-step-contexts', layer: 'L2-input', lang, ui, steps }, null, 2)}\n`);
    console.error(`[L2] exported ${Object.keys(steps).length} step contexts -> ${file}`);
    return 0;
  }

  const step = options.step;
  if (!step || step === true) throw usage('--step=<step> is required (use --list to see the fixture steps)');
  const checkpointArg = options.checkpoint === undefined || options.checkpoint === true ? 'fixture' : options.checkpoint;
  let context, checkpoint;
  if (checkpointArg === 'fixture' || checkpointArg.startsWith('fixture:')) {
    const variants = await captureFixture(support, lang, ui);
    if (!variants.has(step)) throw usage(`Unknown step "${step}". Steps: ${[...variants.keys()].sort().join(', ')}`);
    context = cleanContext(variants.get(step));
    checkpoint = { kind: 'fixture', name: 'aim-phase-variants', source: 'tests/support-aim-flow-capture.cjs + tests/support.cjs coverage flow' };
  } else {
    const file = path.resolve(checkpointArg);
    if (!fs.existsSync(file)) throw usage(`Checkpoint not found: ${file}`);
    context = loadCheckpointFile(file, step);
    checkpoint = { kind: 'file', file };
  }
  if (context.outputLanguage && context.outputLanguage !== lang) console.error(`[L2] warning: checkpoint outputLanguage ${context.outputLanguage} differs from --lang ${lang}; the prompt is rendered from the checkpoint as is`);

  const { DEFAULT_SETTINGS } = support;
  const providerCore = require('../support-replay.cjs');
  const { providerForModel } = providerCore.load('ai/providers/provider.ts');
  const wantProvider = options.provider === undefined || options.provider === true ? null : options.provider;
  if (wantProvider && !['codex', 'claude'].includes(wantProvider)) throw usage('--provider must be codex or claude');
  let model = options.model && options.model !== true ? options.model : undefined, modelSource = 'flag';
  if (model && wantProvider === 'claude' && !model.startsWith('claude:')) model = `claude:${model}`;
  if (!model) { model = wantProvider === 'claude' ? 'claude:sonnet' : DEFAULT_SETTINGS.cliModel; modelSource = wantProvider === 'claude' ? 'product-default (first Claude choice)' : 'product-default (DEFAULT_SETTINGS.cliModel)'; }
  if (wantProvider && providerForModel(model) !== wantProvider) throw usage(`--model ${model} belongs to provider ${providerForModel(model)}, not ${wantProvider}`);
  const effortFlag = options.effort && options.effort !== true ? options.effort : undefined;
  const reasoning = effortFlag ?? DEFAULT_SETTINGS.cliReasoning;
  const effortSource = effortFlag ? 'flag' : 'product-default (DEFAULT_SETTINGS.cliReasoning)';

  const checks = options.checks === 'none' ? [] : (options.checks && options.checks !== true ? options.checks.split(',') : ['language', 'schema', 'fields']);
  for (const name of checks) if (!['language', 'schema', 'fields'].includes(name)) throw usage(`Unknown check: ${name}`);

  // The provider runtime: replay entries (no network) or the product's AiRuntimeService, wired as main.ts does.
  const taps = [];
  const mode = options.replay ? 'replay' : 'live';
  let source;
  if (mode === 'replay') {
    const replayFile = path.resolve(options.replay);
    if (!fs.existsSync(replayFile)) throw usage(`Replay file not found: ${replayFile}`);
    const data = JSON.parse(fs.readFileSync(replayFile, 'utf8'));
    const entries = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(entries) || !entries.length) throw usage(`Replay file ${replayFile} has no entries`);
    const runtime = providerCore.replayRuntime(entries);
    source = () => runtime;
  } else {
    const globals = { window: { process, setTimeout, clearTimeout, setInterval, clearInterval } };
    const { AiRuntimeService } = providerCore.load('core/ai-runtime-service.ts', {}, globals);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const logs = [];
    const aiRuntime = new AiRuntimeService({ codexPath: () => DEFAULT_SETTINGS.codexPath, claudePath: () => DEFAULT_SETTINGS.claudePath, clientVersion: () => manifest.version, onLog: (level, message) => logs.push(`${level}: ${message}`) });
    process.on('exit', () => aiRuntime.reset());
    source = { codex: (directory, local) => aiRuntime.codex(directory, local), claude: directory => aiRuntime.claude(directory), logs };
  }
  const tap = (runtime, label) => ({
    runTask: async (prompt, runModel, effort, schema, controls) => {
      const started = Date.now();
      const call = { prompt, model: runModel, effort, schema, runtime: label, startedAt: new Date(started).toISOString() };
      taps.push(call);
      try { call.raw = await runtime.runTask(prompt, runModel, effort, schema, controls); return call.raw; }
      catch (error) { call.error = error instanceof Error ? error.message : String(error); throw error; }
      finally { call.durationMs = Date.now() - started; }
    }
  });
  const pluginDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-l2-plugin-'));
  const service = (() => {
    const { AiTaskService } = providerCore.load('core/ai-task-service.ts');
    const pick = (label, get) => (...args) => tap(get(...args), label);
    return new AiTaskService({
      pluginDirectory: () => pluginDirectory,
      language: () => ui,
      defaultReasoning: () => DEFAULT_SETTINGS.cliReasoning,
      exchangeLoggingEnabled: () => false,
      exchanges: () => null,
      codexRuntime: mode === 'replay' ? pick('replay', () => source()) : pick('codex', (directory, local) => source.codex(directory, local)),
      claudeRuntime: mode === 'replay' ? pick('replay', () => source()) : pick('claude', directory => source.claude(directory))
    });
  })();

  const controller = new AbortController();
  const timeoutMs = Number(options['timeout-ms'] ?? 300_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  process.on('SIGINT', () => controller.abort());
  const totalStarted = Date.now();
  let parsed, failure;
  try { parsed = await service.askModel(context, model, reasoning, controller.signal); }
  catch (error) { failure = error; }
  finally { clearTimeout(timer); }
  const totalMs = Date.now() - totalStarted;

  const last = taps.at(-1);
  const result = {
    layer: 'L2',
    notE2E: 'Single-node evidence from a restored checkpoint. This is not an end-to-end PASS.',
    mode,
    step, lang, ui, checkpoint,
    // The runtime receives the model without its provider prefix, so the provider comes from the requested model.
    provider: providerForModel(model),
    model: last?.model ?? model, modelSource,
    effort: last?.effort ?? reasoning, effortSource,
    promptSha256: last ? providerCore.sha256(last.prompt) : null,
    promptSha256Raw: last ? require('node:crypto').createHash('sha256').update(last.prompt).digest('hex') : null,
    promptChars: last?.prompt.length ?? null,
    providerCalls: taps.length,
    durationMs: last?.durationMs ?? null,
    totalMs,
    startedAt: last?.startedAt ?? null,
    rawReply: last?.raw ?? null,
    parsed: parsed ?? null,
    error: failure ? (failure instanceof Error ? failure.message : String(failure)) : null,
    checks: [],
    ok: false
  };
  if (!failure && last) {
    const extract = providerCore.load('core/steps/task/parse.ts').extractJsonObject;
    if (checks.includes('language')) result.checks.push(languageCheck(parsed, lang));
    if (checks.includes('schema')) {
      let problems;
      try { problems = last.schema ? validateSchema(JSON.parse(extract(last.raw)), last.schema) : ['no response schema was sent for this step']; }
      catch (error) { problems = [`reply is not JSON: ${error instanceof Error ? error.message : String(error)}`]; }
      result.checks.push({ check: 'schema', pass: !problems.length, problems, note: 'The raw reply is validated against the response schema AiTaskService sent to the provider.' });
    }
    if (checks.includes('fields')) result.checks.push(fieldsCheck(parsed, context));
  }
  result.ok = !failure && result.checks.every(item => item.pass);

  if (options.record && mode === 'live' && !failure && last) {
    const file = path.resolve(options.record);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, kind: 'aim-node-l2', layer: 'L2', step, lang, ui, provider: result.provider, model: result.model, effort: result.effort, recordedAt: new Date().toISOString(), entries: taps.filter(call => call.raw !== undefined).map(call => ({ promptSha256: providerCore.sha256(call.prompt), response: call.raw })) }, null, 2)}\n`);
    result.recordedTo = file;
  }
  const out = path.resolve(options.out && options.out !== true ? options.out : path.join('/private/tmp/vam-l2', `${step}.${lang}.${mode}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  fs.rmSync(pluginDirectory, { recursive: true, force: true });

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`layer=L2 mode=${mode} step=${step} lang=${lang} ok=${result.ok}`);
    console.log(`provider=${result.provider} model=${result.model} effort=${result.effort} durationMs=${result.durationMs} promptSha256=${result.promptSha256}`);
    for (const item of result.checks) console.log(`check ${item.check}: ${item.pass ? 'PASS' : 'FAIL'}${item.pass ? '' : ` ${JSON.stringify(item.problems ?? item.missing ?? item)}`}`);
    if (result.error) console.log(`error: ${result.error}`);
    console.log(`result=${out}`);
  }
  if (failure) return 3;
  return result.ok ? 0 : 1;
}

main().then(code => process.exit(code), error => {
  console.error(`[L2] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error?.exitCode ?? 2);
});
