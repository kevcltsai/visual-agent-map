#!/usr/bin/env node
// Measures the size of the prompts the product sends to the model. A proof tool, not a test: it is not part of `npm test`.
//   node tests/tools/payload-size.cjs            table of the committed prompt snapshots (tests/snapshots/prompts)
//   node tests/tools/payload-size.cjs --scaled   also drives the AIM flow with empty / typical / long saved reports
//   node tests/tools/payload-size.cjs --json     machine-readable output (compare two runs with diff)
// Sizes are characters and `estimateTokens` (characters / 4, the product's own estimate; it under-counts CJK text).
// "dup" is the number of characters in lines of at least 120 characters that appear more than once in the same prompt,
// the repeated content a request could carry once. Only the product's own fixtures and generated filler are used.
const fs = require('node:fs');
const path = require('node:path');
const { promptsFor } = require('../support-replay.cjs');
const support = require('../support.cjs');

const SNAPSHOTS = path.join(__dirname, '..', 'snapshots', 'prompts');
const tokens = chars => Math.ceil(chars / 4);
const DUP_MIN_LINE = 120;

/** Characters in long lines that occur more than once in `prompt`. */
function duplicatedChars(prompt) {
  const seen = new Map();
  for (const line of String(prompt).split('\n')) if (line.length >= DUP_MIN_LINE) seen.set(line, (seen.get(line) ?? 0) + 1);
  let total = 0;
  for (const [line, count] of seen) total += line.length * (count - 1);
  return total;
}
const summarize = prompts => {
  const sizes = prompts.map(prompt => prompt.length);
  const chars = sizes.reduce((sum, size) => sum + size, 0);
  return { count: sizes.length, chars, tokens: tokens(chars), mean: sizes.length ? Math.round(chars / sizes.length) : 0, max: Math.max(0, ...sizes), dup: prompts.reduce((sum, prompt) => sum + duplicatedChars(prompt), 0) };
};

/** Committed snapshots grouped by request family (the name before the first dot) and instruction language tag. */
function snapshotTable() {
  const groups = new Map();
  for (const file of fs.readdirSync(SNAPSHOTS).filter(name => name.endsWith('.txt')).sort()) {
    const [family, ...rest] = file.slice(0, -4).split('.');
    const language = rest[rest.length - 1];
    const key = `${family}|${language}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fs.readFileSync(path.join(SNAPSHOTS, file), 'utf8'));
  }
  return [...groups].map(([key, prompts]) => ({ family: key.split('|')[0], language: key.split('|')[1], ...summarize(prompts) }));
}

const filler = (tag, paragraphs, sentence) => Array.from({ length: paragraphs }, (_, index) => `${tag} paragraph ${index}: ${'Evidence sentence about the subject with detail and figures. '.repeat(sentence)}unique-${tag}-${index}`).join('\n\n');
// Saved reports of increasing size: none, ordinary notes (paragraphs of a few hundred characters) and a very long note.
const SCALES = { empty: { paragraphs: 0, sentence: 0 }, typical: { paragraphs: 6, sentence: 4 }, long: { paragraphs: 60, sentence: 8 } };

/** Every model call of a full three-answer AIM branch with saved reports of the given size, as { phase, context, reports }. */
async function aimFlowContexts(scale) {
  const { AimManualFlow } = support.load('experiences/aim/manual-flow.ts');
  const { AimRunStore } = support.load('experiences/aim/research-run-store.ts');
  const subject = await support.coverageSetup('Snapshot goal');
  const seen = [], reports = [];
  const ask = async context => {
    const result = await subject.model.ask(context);
    const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1] ?? 'none';
    if (scale.paragraphs && /Research status: search completed|Applicable evidence and limitations|Concrete example/.test(result.detail ?? '')) {
      const extra = filler(`${phase}${seen.length}`, scale.paragraphs, scale.sentence);
      result.detail += `\n\n${extra}`;
      reports.push(extra);
    }
    seen.push({ phase, context: { ...context, onProgress: undefined, signal: undefined } });
    return result;
  };
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), ask);
  await support.coverageThreeAnswers(subject);
  return { calls: seen, reports };
}

/** The same calls as the prompt AiTaskService sends, summarized per phase. */
async function aimFlowPrompts(scale) {
  const { calls } = await aimFlowContexts(scale);
  const rows = new Map();
  for (const { phase, context } of calls) {
    const prompt = (await promptsFor(context, { language: 'en' }))[0]?.prompt ?? '';
    if (!rows.has(phase)) rows.set(phase, []);
    rows.get(phase).push(prompt);
  }
  return [...rows].map(([phase, prompts]) => ({ phase, ...summarize(prompts) }));
}

/** The general task prompt with a note (detail), reference text and findings of the given size. */
async function taskPrompts(scale) {
  const body = scale.paragraphs ? filler('note', scale.paragraphs, scale.sentence) : '', source = scale.paragraphs ? filler('source', scale.paragraphs, scale.sentence) : '';
  const base = { title: 'Topic T', summary: 'Current summary S', rules: 'Rule R', detail: body, task: 'Do task X', ancestors: 'Ancestor A', workingFindings: body ? 'Older finding F' : '', sourceContext: body ? `Source [S1]: ${source}` : '', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', outputLanguage: 'en' };
  const rows = [];
  for (const mode of ['task', 'decompose', 'synthesize']) rows.push({ phase: `task:${mode}`, ...summarize((await promptsFor({ ...base, mode }, { language: 'en' })).map(call => call.prompt)) });
  return rows;
}

async function main() {
  const json = process.argv.includes('--json'), scaled = process.argv.includes('--scaled');
  const out = { snapshots: snapshotTable() };
  if (scaled) {
    out.scaled = {};
    for (const [name, scale] of Object.entries(SCALES)) out.scaled[name] = { aimFlow: await aimFlowPrompts(scale), task: await taskPrompts(scale) };
  }
  if (json) return console.log(JSON.stringify(out, null, 2));
  const row = (label, item) => `${label.padEnd(34)} n=${String(item.count).padStart(3)} chars=${String(item.chars).padStart(8)} ~tok=${String(item.tokens).padStart(7)} mean=${String(item.mean).padStart(6)} max=${String(item.max).padStart(6)} dup=${String(item.dup).padStart(6)}`;
  console.log('== committed prompt snapshots by request family and instruction language ==');
  for (const item of out.snapshots) console.log(row(`${item.family} [${item.language}]`, item));
  for (const [name, groups] of Object.entries(out.scaled ?? {})) {
    console.log(`\n== scaled: saved reports "${name}" ==`);
    for (const item of groups.aimFlow) console.log(row(`aim:${item.phase}`, item));
    for (const item of groups.task) console.log(row(item.phase, item));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });
module.exports = { duplicatedChars, summarize, SCALES, aimFlowContexts, filler };
