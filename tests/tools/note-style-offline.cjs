#!/usr/bin/env node
// Development tool, not product code: offline A/B of "textbook" vs the current "key-points notes" writing shape.
// Not bundled into main.js, no UI. See agents-spec/intents/note-style/INTENT.md and
// agents-spec/docs/history/tasks/2026-10-19-note-style/plan.md (P1).
//
//   node tests/tools/note-style-offline.cjs research [--topics=herbs,maillard] [--concurrency=4] [--force]
//        One web research per topic (Claude Code CLI, WebSearch/WebFetch) -> <task-dir>/fixtures/<slug>.json
//        (shared workingFindings + sourceContext). Web content: private repo only.
//   node tests/tools/note-style-offline.cjs run [--topics=...] [--arms=A,B,C] [--lang=zh|en] [--concurrency=4]
//        [--force] [--regen]   Writes one note per topic and arm with researchMode "local" -> <task-dir>/runs/.
//        --regen regenerates a failing note (old attempt kept as attemptN, at most one regeneration per note).
//   node tests/tools/note-style-offline.cjs checks     Prints the automated-check table for every written note.
//   node tests/tools/note-style-offline.cjs render [--out=<review dir>] [--seed=<text>] [--allow-failed] [--pair=B,A] [--round=2]
//        --pair=<new arm>,<base arm> (default B,A; round 2 uses C,A). --round=2 also changes the review text and key file names.
//        16 notes with random code names + owner-review-key.json (arm mapping; the owner does not open it).
//   node tests/tools/note-style-offline.cjs review [--out=<review dir>] [--force]   Writes owner-review.md.
//   node tests/tools/note-style-offline.cjs compare [--out=<review dir>]   Reads owner-review.md back: wins and cost ratio.
//
// Arm A: production generalTaskPrompt; reply -> parse -> normalizeDetailHeadings -> resolveDetailReferences ->
//        canonicalDetail(standard) -> detailWithVisualReferences.
// Arm C (round 2): the same swap with note-style-offline/hybrid.<lang>.md (textbook-led lead-in + A's categories);
//        post-processing identical to Arm B.
// Arm B: the same prompt with the OBSIDIAN_FORMAT block and the detail-structure block replaced by
//        note-style-offline/textbook.<lang>.md; reply -> parse (neutralizeUnsafeMermaid) -> normalizeDetailHeadings
//        -> resolveDetailReferences -> neutralizeUnsafeMermaid -> detailWithVisualReferences.
// Model: claude:sonnet through the Claude Code CLI only.
//
// Nothing is read from or written to the owner's live test vault (vaults/vam-e2e-current or /private/tmp/vam-e2e-current)
// or to the plugin repository. Every write goes through assertWritable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL_DIR = path.join(__dirname, 'note-style-offline');
// The workspace holds agents-spec/ and obsidian-plugin/; worktrees live in <workspace>-worktrees/. Override with VAM_WORKSPACE.
const WORKSPACE = process.env.VAM_WORKSPACE || path.resolve(ROOT, '..', '..', 'Obsdian_VAM');
const DEFAULT_TASK_DIR = path.join(WORKSPACE, 'agents-spec', 'docs', 'history', 'tasks', '2026-10-19-note-style');
const DEFAULT_REVIEW_DIR = '/private/tmp/vam-e2e-note-style-review';
const MODEL = 'sonnet';
const EFFORT = 'low';

const TOPICS = [
  { slug: 'herbs', title: '要怎麼養香草' },
  { slug: 'maillard', title: '料理的科學：梅納反應' },
  { slug: 'present-perfect', title: '英文文法：現在完成式' },
  { slug: 'photosynthesis', title: '光合作用' },
  { slug: 'tw-semiconductor', title: '台灣半導體產業史' },
  { slug: 'index-vs-active', title: '指數型基金 vs 主動型基金' },
  { slug: 'tw-population', title: '台灣人口結構變化' },
  { slug: 'tw-trip', title: '台灣三天兩夜旅遊規劃' }
];
const TASK_TEXT = { zh: '請針對這個主題寫一頁完整、可獨立閱讀的知識頁。', en: 'Write one complete, self-contained knowledge page on this topic.' };
const UI_LANGUAGE = { zh: 'zh-TW', en: 'en' };

// ---- path safety ---------------------------------------------------------------------------------------------

const PROTECTED_ABSOLUTE = ['/private/tmp/vam-e2e-current', '/tmp/vam-e2e-current'];
const PLUGIN_REPO_PARENTS = [ROOT, path.join(WORKSPACE, 'obsidian-plugin')];

/** The real path of the deepest existing ancestor plus the not-yet-existing tail (so symlinks are followed). */
function realForm(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function inside(candidate, base) {
  return candidate === base || candidate.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** Throws for the owner's live test vault (any spelling or symlink) and for anything under the plugin repository. */
function assertWritable(target) {
  const forms = new Set([path.resolve(target), realForm(target)]);
  for (const form of forms) {
    for (const protectedPath of PROTECTED_ABSOLUTE.flatMap(p => [p, realForm(p)]))
      if (inside(form, protectedPath)) throw new Error(`refusing to touch the live test vault: ${form}`);
    if (form.split(path.sep).join('/').includes('/vaults/vam-e2e-current')) throw new Error(`refusing to touch the live test vault: ${form}`);
    for (const repo of PLUGIN_REPO_PARENTS.flatMap(p => [p, realForm(p)]))
      if (inside(form, repo)) throw new Error(`refusing to write inside the plugin repository: ${form}`);
  }
  return path.resolve(target);
}

function writeFile(target, content) {
  assertWritable(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertWritable(target);
  fs.writeFileSync(target, content);
}

// ---- product code (bundled with the repo's own test build, nothing is edited) -------------------------------

let productCache = null;
function product() {
  if (productCache) return productCache;
  const { buildSync } = require('../build.cjs');
  const repositorySource = fs.readFileSync(path.join(ROOT, 'repository.ts'), 'utf8');
  const start = repositorySource.indexOf('function detailWithVisualReferences(');
  const end = repositorySource.indexOf('\nfunction initialPreview(', start);
  if (start < 0 || end < 0) throw new Error('detailWithVisualReferences not found in repository.ts');
  const visualReferencesSource = repositorySource.slice(start, end);
  const contents = [
    'import { generalTaskPrompt } from "./core/steps/task/render";',
    'import { detailStructure } from "./core/steps/task/fragments";',
    'import { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";',
    'import { detailStructurePrompt, standardTemplate, sourcesHeadingKeys, type DetailTemplate } from "./ai/detail-templates";',
    'import { parseAiResult } from "./core/steps/task/parse";',
    'import { normalizeDetailHeadings, fencedLines } from "./ai/markdown-blocks";',
    'import { neutralizeUnsafeMermaid } from "./ai/mermaid-safety";',
    'import { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";',
    'import { resolveDetailReferences, referenceCatalog } from "./ai/reference-materials";',
    'import { claudeTaskArgs, claudeStructuredOutput } from "./ai/runtime/claude-code-cli";',
    'import responseSchema from "./response-schema.json";',
    visualReferencesSource,
    'export { generalTaskPrompt, detailStructure, OBSIDIAN_FORMAT, inLanguage, detailStructurePrompt, standardTemplate, parseAiResult, normalizeDetailHeadings, neutralizeUnsafeMermaid, canonicalDetail, visualReferencesMarkdown, resolveDetailReferences, referenceCatalog, claudeTaskArgs, claudeStructuredOutput, responseSchema, detailWithVisualReferences, fencedLines };'
  ].join('\n');
  const code = buildSync({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'note-style-offline-entry.ts', loader: 'ts' },
    external: ['obsidian', 'node:*']
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require,
    console: Object.assign(Object.create(console), { debug() {} }),
    TextDecoder,
    crypto: crypto.webcrypto,
    process
  });
  productCache = module.exports;
  return productCache;
}

// ---- prompts -------------------------------------------------------------------------------------------------

function taskContext(topic, fixture, lang) {
  return {
    title: topic.title,
    summary: '',
    rules: '',
    detail: '',
    task: TASK_TEXT[lang],
    ancestors: '',
    workingFindings: fixture.workingFindings,
    sourceContext: fixture.sourceContext,
    mode: 'task',
    researchMode: 'local',
    researchDepth: 'normal',
    visualMode: 'off',
    outputLanguage: UI_LANGUAGE[lang]
  };
}

const FRAGMENT_FILE = { B: 'textbook', C: 'hybrid' };
function fragmentFor(arm, lang) {
  return fs.readFileSync(path.join(TOOL_DIR, `${FRAGMENT_FILE[arm]}.${lang}.md`), 'utf8').replace(/\n$/, '');
}
function textbookFragment(lang) {
  return fragmentFor('B', lang);
}

/** The two blocks Arm B swaps out, joined exactly the way generalTaskPrompt joins them. */
function replacedBlock(lang) {
  const p = product();
  const language = UI_LANGUAGE[lang];
  const structure = p.detailStructurePrompt(p.standardTemplate(language), language, headings => p.detailStructure(language, headings));
  return { structure, format: p.inLanguage(p.OBSIDIAN_FORMAT, language), joined: `${structure}\n\n${p.inLanguage(p.OBSIDIAN_FORMAT, language)}` };
}

function buildPrompts(context, lang) {
  const p = product();
  const prompt = p.generalTaskPrompt(context, UI_LANGUAGE[lang]);
  const block = replacedBlock(lang);
  const index = prompt.indexOf(block.joined);
  if (index < 0 || prompt.indexOf(block.joined, index + 1) >= 0) throw new Error('the structure + obsidian-format block is not in the prompt exactly once');
  const swap = fragment => prompt.slice(0, index) + fragment + prompt.slice(index + block.joined.length);
  const fragment = fragmentFor('B', lang);
  const hybridFragment = fragmentFor('C', lang);
  return { A: prompt, B: swap(fragment), C: swap(hybridFragment), block, fragment, hybridFragment };
}

// ---- model call ----------------------------------------------------------------------------------------------

function callClaude(prompt, { schema, webSearch }) {
  const p = product();
  const args = p.claudeTaskArgs(MODEL, EFFORT, schema, webSearch);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'note-style-offline-'));
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', error => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      reject(error);
    });
    child.on('close', status => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      if (status !== 0) return reject(new Error(`claude exited ${status}: ${(stderr || stdout).slice(0, 300)}`));
      try {
        const text = p.claudeStructuredOutput(stdout);
        const value = JSON.parse(stdout);
        const events = Array.isArray(value) ? value : [value];
        const final = [...events].reverse().find(item => item && item.type === 'result') || events[events.length - 1];
        resolve({ text, usage: final.usage || null, cost: final.total_cost_usd ?? null, durationMs: final.duration_ms ?? null });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(prompt);
  });
}

function usageTotals(usage) {
  if (!usage) return { input: null, output: null, freshInput: null };
  const fresh = usage.input_tokens ?? 0;
  return {
    input: fresh + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    output: usage.output_tokens ?? 0,
    freshInput: fresh
  };
}

async function pool(items, size, worker) {
  const results = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

// ---- research ------------------------------------------------------------------------------------------------

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, url: { type: 'string' }, facts: { type: 'string' } },
        required: ['title', 'url', 'facts'],
        additionalProperties: false
      }
    }
  },
  required: ['findings', 'sources'],
  additionalProperties: false
};

function researchPrompt(topic, lang) {
  if (lang === 'en')
    return `Research the topic "${topic.title}" on the web (use WebSearch, then WebFetch to read the pages) so a learner-facing note can be written from your material alone.\n\nChoose 5 to 8 reliable, readable sources (no paywalled pages). Return JSON only:\n- findings: a 400-800 word summary in English of what a beginner needs (key concepts, a worked example with real numbers, common misconceptions, practical advice), citing sources as [S1], [S2] matching the order of "sources".\n- sources: for each source, its title, the exact URL you actually read, and "facts": the definitions, numbers, dates and steps taken from that page (200-500 words, English). Never invent a URL or a number.`;
  return `請在網路上研究主題「${topic.title}」（先用 WebSearch，再用 WebFetch 讀內容），讓之後只憑你的整理就能寫出給初學者的筆記。\n\n挑 5 到 8 個可靠、可讀取的來源（不要付費牆頁面）。只回傳 JSON：\n- findings：400–800 字的繁體中文整理（初學者需要的核心概念、帶實際數字的完整例子、常見誤解、實用建議），用 [S1]、[S2] 標示來源，編號對應 sources 的順序。\n- sources：每個來源的 title、你實際讀過的完整 URL，以及 facts：從該頁取出的定義、數字、日期與步驟（200–500 字，繁體中文）。不可編造 URL 或數字。`;
}

function fixtureFromResearch(reply, lang) {
  const data = JSON.parse(reply);
  const sources = data.sources.filter(s => /^https?:\/\//i.test(s.url));
  if (sources.length < 3) throw new Error(`research returned only ${sources.length} usable sources`);
  const catalog = sources.map((s, i) => `[S${i + 1}] External file (plain path): ${s.url}`).join('\n');
  const evidence = sources.map((s, i) => `Evidence:\n[S${i + 1}] ${s.title}\n${s.facts.trim()}`).join('\n\n');
  return {
    sources,
    workingFindings: data.findings.trim(),
    sourceContext: `${evidence}\n\nSource registry (retain these identities in citations):\n${catalog}`,
    lang
  };
}

async function commandResearch(args) {
  const lang = args.lang || 'zh';
  const taskDir = args['task-dir'] || DEFAULT_TASK_DIR;
  const fixtures = path.join(taskDir, 'fixtures');
  const topics = pickTopics(args);
  await pool(topics, Number(args.concurrency || 4), async topic => {
    const file = path.join(fixtures, `${topic.slug}.json`);
    if (fs.existsSync(file) && !args.force) return process.stdout.write(`${topic.slug}: fixture exists, skipped\n`);
    const prompt = researchPrompt(topic, lang);
    const reply = await callClaude(prompt, { schema: RESEARCH_SCHEMA, webSearch: true });
    const fixture = { topic, ...fixtureFromResearch(reply.text, lang), research: { prompt, usage: reply.usage, cost: reply.cost, model: `claude:${MODEL}`, at: new Date().toISOString() } };
    writeFile(file, JSON.stringify(fixture, null, 2) + '\n');
    process.stdout.write(`${topic.slug}: ${fixture.sources.length} sources\n`);
  });
}

// ---- pipeline and checks -------------------------------------------------------------------------------------

function groupsFor(fixture) {
  return [{ id: 'web', name: 'web', location: 'web', documents: fixture.sources.map(s => ({ path: s.url, content: s.facts, external: true })) }];
}

/** Production order: normalize headings, resolve [S#] footnotes, then Arm A's canonicalDetail, then visual references. */
function processReply(arm, raw, topic, fixture, lang) {
  const p = product();
  const language = UI_LANGUAGE[lang];
  const parsed = p.parseAiResult(raw, topic.title, language);
  let detail = p.normalizeDetailHeadings(parsed.detail);
  detail = p.resolveDetailReferences(detail, groupsFor(fixture), '', undefined);
  detail = arm === 'A' ? p.canonicalDetail(detail, language, p.standardTemplate(language)) : p.neutralizeUnsafeMermaid(detail);
  detail = p.detailWithVisualReferences(detail, p.visualReferencesMarkdown(parsed.visualReferences, language), p.standardTemplate(language));
  return { summary: parsed.summary, detail, rawDetail: JSON.parse(raw).detail };
}

const URL_PATTERN = /https?:\/\/[^\s)\]>"'`，。；、]+/g;
const cleanUrl = url => url.replace(/[.,;:!?)\]]+$/, '');

function codeMask(lines) {
  return product().fencedLines(lines);
}

function numbersIn(text) {
  // Footnote markers ([^3]) are labels, not data.
  return [...text.replace(/\[\^[^\]\s]+\]/g, ' ').matchAll(/(?<![A-Za-z\d.])\d+(?:[.,]\d+)*/g)].map(m => m[0].replace(/,/g, '').replace(/\.$/, ''));
}

/** Numbers that sit in a table row or a mermaid block. */
function chartNumbers(detail) {
  const lines = detail.split('\n');
  const result = [];
  let mermaid = false;
  for (const raw of lines) {
    const line = raw.replace(/^(\s*>\s*)+/, '');
    if (/^\s*```\s*mermaid/i.test(line)) mermaid = true;
    else if (mermaid && /^\s*```\s*$/.test(line)) mermaid = false;
    else if (mermaid) result.push(...numbersIn(line));
    else if (/^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) result.push(...numbersIn(line));
  }
  return result;
}

function mermaidBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/^(\s*>\s*)+/, '');
    if (!current && /^\s*```\s*mermaid/i.test(line)) current = [];
    else if (current && /^\s*```\s*$/.test(line)) {
      blocks.push(current);
      current = null;
    } else if (current) current.push(line);
  }
  return blocks;
}

/** Lightweight structural check (the mermaid library is not available offline); the owner sees the real render. */
function mermaidSyntaxProblems(block) {
  const lines = block.map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
  if (!lines.length) return ['empty block'];
  const problems = [];
  const header = lines[0];
  if (/^(flowchart|graph)\b/i.test(header)) {
    if (!/^(flowchart|graph)\s+(TD|TB|LR|RL|BT)\s*$/i.test(header)) problems.push(`bad flowchart header: ${header}`);
    lines.slice(1).forEach(line => {
      if ((line.match(/"/g) || []).length % 2) problems.push(`unbalanced quotes: ${line}`);
      const open = (line.match(/[[({]/g) || []).length;
      const close = (line.match(/[\])}]/g) || []).length;
      if (open !== close && !/"/.test(line)) problems.push(`unbalanced brackets: ${line}`);
    });
  } else if (/^timeline\b/i.test(header)) {
    lines.slice(1).forEach(line => {
      if (!/^title\b/i.test(line) && !/^section\b/i.test(line) && !/:/.test(line)) problems.push(`timeline line without ':': ${line}`);
    });
  } else problems.push(`type not allowed: ${header}`);
  return problems;
}

function checkNote(arm, result, fixture, topic) {
  const input = `${topic.title}\n${fixture.workingFindings}\n${fixture.sourceContext}`;
  const inputUrls = new Set((input.match(URL_PATTERN) || []).map(cleanUrl));
  for (const s of fixture.sources) inputUrls.add(cleanUrl(s.url));
  const finalDetail = result.detail;
  const outputUrls = [...new Set((finalDetail.match(URL_PATTERN) || []).map(cleanUrl))];
  const rawUrls = [...new Set((result.rawDetail.match(URL_PATTERN) || []).map(cleanUrl))];
  const fabricatedUrls = [...new Set([...outputUrls, ...rawUrls])].filter(url => !inputUrls.has(url));
  const lines = finalDetail.split('\n');
  const code = codeMask(lines);
  const referenced = new Set();
  const defined = new Set();
  lines.forEach((line, i) => {
    if (code[i]) return;
    const def = /^\[\^([^\]\s]+)\]:/.exec(line);
    if (def) defined.add(def[1]);
    else for (const m of line.matchAll(/\[\^([^\]\s]+)\]/g)) referenced.add(m[1]);
  });
  const undefinedFootnotes = [...referenced].filter(label => !defined.has(label));
  const unconfirmed = (finalDetail.match(/來源待確認|Source to confirm/g) || []).length;
  const p = product();
  const neutralizedBlocks = result.rawDetail !== p.neutralizeUnsafeMermaid(result.rawDetail) ? 1 : 0;
  const syntaxProblems = mermaidBlocks(finalDetail).flatMap(mermaidSyntaxProblems);
  const headings = lines.filter((line, i) => !code[i] && /^###\s/.test(line)).length;
  const callouts = lines.filter((line, i) => !code[i] && /^>\s*\[!(?!figure)\w+/i.test(line)).length;
  const inputNumbers = new Set(numbersIn(input.replace(/(\d),(?=\d{3}\b)/g, '$1')));
  const chart = chartNumbers(finalDetail);
  const unseen = [...new Set(chart.filter(n => !inputNumbers.has(n)))];
  const failures = [];
  if (fabricatedUrls.length) failures.push(`fabricated URL: ${fabricatedUrls.join(', ')}`);
  if (undefinedFootnotes.length) failures.push(`footnote without definition: ${undefinedFootnotes.join(', ')}`);
  if (unconfirmed) failures.push(`${unconfirmed} unconfirmed [S#] source marker(s)`);
  if (neutralizedBlocks) failures.push('mermaid neutralized as unsafe');
  if (syntaxProblems.length) failures.push(`mermaid syntax: ${syntaxProblems.join('; ')}`);
  if (arm !== 'A') {
    if (/本次無新增內容|No new content this time|No new information in this task/.test(finalDetail)) failures.push('contains the empty-section filler');
    if (headings > 7) failures.push(`${headings} ### headings (max 7)`);
    if (callouts > 3) failures.push(`${callouts} non-figure callouts (max 3)`);
  }
  return { headings, callouts, fabricatedUrls, undefinedFootnotes, unconfirmed, neutralizedBlocks, syntaxProblems, chartNumbers: chart.length, unseenNumbers: unseen, failures, pass: failures.length === 0 };
}

// ---- run -----------------------------------------------------------------------------------------------------

function pickTopics(args) {
  if (!args.topics) return TOPICS;
  const wanted = String(args.topics).split(',');
  const unknown = wanted.filter(slug => !TOPICS.some(t => t.slug === slug));
  if (unknown.length) throw new Error(`unknown topics: ${unknown.join(', ')}`);
  return TOPICS.filter(t => wanted.includes(t.slug));
}

function loadFixture(taskDir, slug) {
  const file = path.join(taskDir, 'fixtures', `${slug}.json`);
  if (!fs.existsSync(file)) throw new Error(`no fixture for ${slug}; run research first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const ARMS = ['A', 'B', 'C'];
const runFile = (taskDir, slug, arm) => path.join(taskDir, 'runs', `${slug}.${arm}.json`);

async function commandRun(args) {
  const lang = args.lang || 'zh';
  const taskDir = args['task-dir'] || DEFAULT_TASK_DIR;
  const arms = String(args.arms || 'A,B').split(',');
  if (arms.some(arm => !ARMS.includes(arm))) throw new Error(`unknown arms: ${arms.join(',')}`);
  const jobs = pickTopics(args).flatMap(topic => arms.map(arm => ({ topic, arm })));
  await pool(jobs, Number(args.concurrency || 4), async ({ topic, arm }) => {
    const file = runFile(taskDir, topic.slug, arm);
    let attempt = 1;
    if (fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!args.force && !args.regen) return process.stdout.write(`${topic.slug}.${arm}: exists, skipped\n`);
      if (args.regen) {
        if (old.checks?.pass) return process.stdout.write(`${topic.slug}.${arm}: passed, not regenerated\n`);
        if ((old.attempt ?? 1) >= 2) throw new Error(`${topic.slug}.${arm}: already regenerated once`);
        attempt = (old.attempt ?? 1) + 1;
        writeFile(file.replace(/\.json$/, `.attempt${old.attempt ?? 1}.json`), JSON.stringify(old, null, 2) + '\n');
      }
    }
    const fixture = loadFixture(taskDir, topic.slug);
    const prompts = buildPrompts(taskContext(topic, fixture, lang), lang);
    const prompt = prompts[arm];
    const reply = await callClaude(prompt, { schema: product().responseSchema, webSearch: false });
    const record = { topic, arm, lang, attempt, model: `claude:${MODEL}`, prompt, raw: reply.text, usage: reply.usage, tokens: usageTotals(reply.usage), cost: reply.cost, durationMs: reply.durationMs, at: new Date().toISOString() };
    try {
      const result = processReply(arm, reply.text, topic, fixture, lang);
      Object.assign(record, result, { checks: checkNote(arm, result, fixture, topic) });
    } catch (error) {
      record.checks = { pass: false, failures: [`pipeline error: ${error.message}`] };
    }
    writeFile(file, JSON.stringify(record, null, 2) + '\n');
    process.stdout.write(`${topic.slug}.${arm}: ${record.checks.pass ? 'pass' : 'FAIL ' + record.checks.failures.join(' | ')} (out ${record.tokens.output} tok)\n`);
  });
}

function loadRuns(taskDir) {
  const runs = {};
  for (const topic of TOPICS)
    for (const arm of ARMS) {
      const file = runFile(taskDir, topic.slug, arm);
      if (fs.existsSync(file)) runs[`${topic.slug}.${arm}`] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  return runs;
}

function commandChecks(args) {
  const taskDir = args['task-dir'] || DEFAULT_TASK_DIR;
  const runs = loadRuns(taskDir);
  const checkArms = args.arms ? String(args.arms).split(',') : ['A', 'B'];
  const rows = ['| topic | arm | attempt | pass | ### | callouts | fab URL | bad mermaid | chart nums | unseen nums | failures |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const unseen = {};
  for (const topic of TOPICS)
    for (const arm of checkArms) {
      const r = runs[`${topic.slug}.${arm}`];
      if (!r) {
        rows.push(`| ${topic.slug} | ${arm} | - | missing | | | | | | | |`);
        continue;
      }
      const c = (r.checks = checkNote(arm, r, loadFixture(taskDir, topic.slug), topic));
      writeFile(runFile(taskDir, topic.slug, arm), JSON.stringify(r, null, 2) + '\n');
      if (arm !== 'A') unseen[arm] = (unseen[arm] || 0) + (c.unseenNumbers || []).length;
      rows.push(`| ${topic.slug} | ${arm} | ${r.attempt} | ${c.pass ? 'pass' : 'FAIL'} | ${c.headings ?? ''} | ${c.callouts ?? ''} | ${(c.fabricatedUrls || []).length} | ${(c.neutralizedBlocks || 0) + (c.syntaxProblems || []).length} | ${c.chartNumbers ?? ''} | ${(c.unseenNumbers || []).join(' ')} | ${(c.failures || []).join('; ')} |`);
    }
  rows.push('');
  for (const [arm, count] of Object.entries(unseen)) rows.push(`Arm ${arm} numbers in tables/charts not found in the input: ${count} (limit 1 across 8 notes)${count > 1 ? ' -> FAIL' : ''}`);
  process.stdout.write(rows.join('\n') + '\n');
  return { unseen, unseenB: unseen.B ?? 0 };
}

// ---- render / review / compare -------------------------------------------------------------------------------

function seededRandom(seed) {
  let counter = 0;
  return () => {
    const digest = crypto.createHash('sha256').update(`${seed}:${counter++}`).digest();
    return digest.readUInt32BE(0) / 0x100000000;
  };
}

function noteText(run) {
  return `---\ntitle: ${JSON.stringify(run.topic.title)}\n---\n# ${run.topic.title}\n\n## Current Summary\n\n${run.summary.trim()}\n\n## Detail\n\n${run.detail.trim()}\n`;
}

function commandRender(args) {
  const taskDir = args['task-dir'] || DEFAULT_TASK_DIR;
  const out = args.out || DEFAULT_REVIEW_DIR;
  assertWritable(out);
  const runs = loadRuns(taskDir);
  const [newArm, baseArm] = String(args.pair || 'B,A').split(',');
  if (!ARMS.includes(newArm) || !ARMS.includes(baseArm) || newArm === baseArm) throw new Error(`bad --pair=${args.pair}`);
  const missing = TOPICS.flatMap(t => [newArm, baseArm].filter(arm => !runs[`${t.slug}.${arm}`]).map(arm => `${t.slug}.${arm}`));
  if (missing.length) throw new Error(`missing runs: ${missing.join(', ')}`);
  const failed = Object.entries(runs).filter(([k, r]) => [newArm, baseArm].includes(r.arm) && !r.checks?.pass).map(([k]) => k);
  if (failed.length && !args['allow-failed']) throw new Error(`automated checks failed for ${failed.join(', ')}; not handing them to the owner (use --allow-failed to override)`);
  const random = seededRandom(args.seed || crypto.randomBytes(8).toString('hex'));
  const codes = new Set();
  const code = () => {
    for (;;) {
      const value = Array.from({ length: 6 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(random() * 31)]).join('');
      if (!codes.has(value)) return codes.add(value) && value;
    }
  };
  const pairs = TOPICS.map((topic, index) => {
    const aFirst = random() < 0.5;
    const first = aFirst ? baseArm : newArm;
    const second = aFirst ? newArm : baseArm;
    const entry = { index: index + 1, slug: topic.slug, topic: topic.title, 甲: { arm: first, file: `${code()}.md` }, 乙: { arm: second, file: `${code()}.md` } };
    for (const side of ['甲', '乙']) writeFile(path.join(out, entry[side].file), noteText(runs[`${topic.slug}.${entry[side].arm}`]));
    return entry;
  });
  writeFile(path.join(out, '.obsidian', 'app.json'), '{}\n');
  const key = { model: `claude:${MODEL}`, round: args.round ? Number(args.round) : 1, pair: [newArm, baseArm], arms: { A: 'notes (current six-heading format)', B: 'textbook', C: 'hybrid (textbook-led lead-in + categorized sections)' }, generatedAt: new Date().toISOString(), pairs };
  writeFile(path.join(out, 'owner-review-key.json'), JSON.stringify(key, null, 2) + '\n');
  writeFile(path.join(taskDir, key.round === 2 ? 'owner-review-key-r2.json' : 'owner-review-key.json'), JSON.stringify(key, null, 2) + '\n');
  process.stdout.write(`rendered 16 notes into ${out}\n`);
}

const CHOICES = ['甲', '乙', '都可', '都不對'];

function commandReview(args) {
  const out = args.out || DEFAULT_REVIEW_DIR;
  const file = path.join(out, 'owner-review.md');
  assertWritable(file);
  if (fs.existsSync(file) && !args.force) throw new Error('owner-review.md exists; --force overwrites it');
  const key = JSON.parse(fs.readFileSync(path.join(out, 'owner-review-key.json'), 'utf8'));
  const link = entry => `[[${entry.file.replace(/\.md$/, '')}]]`;
  const rows = key.pairs.map(pair => `| ${pair.index} | ${pair.topic} | ${link(pair.甲)} | ${link(pair.乙)} | | |`);
  const second = key.round === 2;
  const text = [
    second ? '# Owner review（筆記風格第 2 輪，盲評）' : '# Owner review（筆記風格 A/B，盲評）',
    '',
    ...(second ? ['這一輪是拿一個新版本和上一輪的重點筆記版本比較。請每一列都填「你的選擇」，因為結果需要每題的選擇才能判斷；約 25 分鐘。', ''] : []),
    `${second ? '' : '約 25 分鐘。'}每個主題有甲、乙兩篇筆記，內容寫同一個主題，只是寫法不同。不會顯示哪一篇是哪種寫法。`,
    '',
    `1. 在 Obsidian 開啟這個資料夾（\`${out}\`）當 vault，或直接點下表的連結讀。`,
    '2. 每一列讀完甲、乙，在「你的選擇」填 **甲**、**乙**、**都可** 或 **都不對**。',
    `3. 「一句理由」可留白，但寫了才能${second ? '改進' : '修下一版'}。第一欄請勿修改。`,
    '4. 不要開 `owner-review-key.json`，那是對照表。',
    '',
    '判斷標準：哪一篇比較好讀、比較容易學會這個主題。',
    '',
    '| 題 | 主題 | 甲 | 乙 | 你的選擇 | 一句理由 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n');
  writeFile(file, text);
  process.stdout.write(`wrote ${file}\n`);
}

function median(values) {
  const sorted = values.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function costSummary(runs, newArm = 'B') {
  const result = {};
  for (const arm of ['A', newArm]) {
    const own = Object.values(runs).filter(r => r.arm === arm);
    result[arm] = { notes: own.length, input: median(own.map(r => r.tokens?.input)), freshInput: median(own.map(r => r.tokens?.freshInput)), output: median(own.map(r => r.tokens?.output)), cost: median(own.map(r => r.cost)) };
  }
  const ratio = (b, a) => (a ? b / a : null);
  result.new = result[newArm];
  result.ratio = { input: ratio(result.new.input, result.A.input), output: ratio(result.new.output, result.A.output), cost: ratio(result.new.cost, result.A.cost) };
  return result;
}

function parseReview(text) {
  const answers = new Map();
  for (const line of text.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 7 || !/^\d+$/.test(cells[1])) continue;
    answers.set(Number(cells[1]), { choice: cells[5].replace(/[*\s]/g, ''), reason: cells[6] });
  }
  return answers;
}

function tally(key, answers) {
  const counts = { textbook: 0, notes: 0, either: 0, neither: 0, blank: 0, invalid: 0 };
  if (key.pair?.includes('C')) counts.hybrid = 0;
  const rows = [];
  for (const pair of key.pairs) {
    const answer = answers.get(pair.index);
    const choice = answer?.choice ?? '';
    let outcome;
    if (!choice) outcome = 'blank';
    else if (!CHOICES.includes(choice)) outcome = 'invalid';
    else if (choice === '都可') outcome = 'either';
    else if (choice === '都不對') outcome = 'neither';
    else outcome = { A: 'notes', B: 'textbook', C: 'hybrid' }[pair[choice].arm];
    counts[outcome]++;
    rows.push({ index: pair.index, topic: pair.topic, choice, outcome, reason: answer?.reason ?? '' });
  }
  return { counts, rows };
}

function gate(counts, { final = false } = {}) {
  if (counts.blank || counts.invalid) return `PENDING: ${counts.blank} blank / ${counts.invalid} invalid answers`;
  const bad = [];
  const name = counts.hybrid !== undefined ? 'hybrid' : 'textbook';
  const wins = counts[name];
  if (wins < 6) bad.push(`${name} wins ${wins}/8 (need >= 6)`);
  if (counts.notes > 1) bad.push(`notes wins ${counts.notes}/8 (need <= 1)`);
  if (counts.neither > 1) bad.push(`neither ${counts.neither}/8 (need <= 1)`);
  if (counts.blank || counts.invalid) bad.push(`${counts.blank} blank / ${counts.invalid} invalid answers`);
  if (!bad.length) return 'PASS: preference thresholds met';
  if (final) return `STOP (final round did not meet the thresholds; the whole feature stops): ${bad.join('; ')}`;
  if (wins >= 4 && wins <= 5) return `RETRY (one fragment revision + one more blind round allowed): ${bad.join('; ')}`;
  if (wins >= 6) return `treated like 4-5/8 (one fragment revision allowed): ${bad.join('; ')}`;
  return `STOP (${name} <= 3/8 stops the whole feature): ${bad.join('; ')}`;
}

function commandCompare(args) {
  const taskDir = args['task-dir'] || DEFAULT_TASK_DIR;
  const out = args.out || DEFAULT_REVIEW_DIR;
  const key = JSON.parse(fs.readFileSync(path.join(out, 'owner-review-key.json'), 'utf8'));
  const answers = parseReview(fs.readFileSync(path.join(out, 'owner-review.md'), 'utf8'));
  const { counts, rows } = tally(key, answers);
  const runs = loadRuns(taskDir);
  const newArm = key.pair?.[0] ?? 'B';
  const newLabel = { B: 'B 教科書', C: 'C 混合' }[newArm];
  const cost = costSummary(runs, newArm);
  const fmt = v => (v === null ? 'n/a' : Number.isInteger(v) ? String(v) : v.toFixed(3));
  const text = [
    '# 筆記風格 P1 compare',
    '',
    `- ${newArm === 'C' ? '混合版' : '教科書'}勝: ${counts[newArm === 'C' ? 'hybrid' : 'textbook']}/8`,
    `- 重點筆記勝: ${counts.notes}/8`,
    `- 都可: ${counts.either}/8`,
    `- 都不對: ${counts.neither}/8`,
    counts.blank || counts.invalid ? `- 未填 ${counts.blank}、無法辨識 ${counts.invalid}` : '',
    `- Gate G1: ${gate(counts, { final: key.round === 2 })}`,
    '',
    '| 題 | 主題 | 選擇 | 結果 | 理由 |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.index} | ${r.topic} | ${r.choice} | ${r.outcome} | ${r.reason} |`),
    '',
    '## 成本（中位數，claude:sonnet）',
    '',
    '| arm | notes | input tokens（含 cache） | 非 cache input | output tokens | cost USD |',
    '| --- | --- | --- | --- | --- | --- |',
    `| A 重點筆記 | ${cost.A.notes} | ${fmt(cost.A.input)} | ${fmt(cost.A.freshInput)} | ${fmt(cost.A.output)} | ${fmt(cost.A.cost)} |`,
    `| ${newLabel} | ${cost.new.notes} | ${fmt(cost.new.input)} | ${fmt(cost.new.freshInput)} | ${fmt(cost.new.output)} | ${fmt(cost.new.cost)} |`,
    `| ${newArm} / A | | ${fmt(cost.ratio.input)} | | ${fmt(cost.ratio.output)} | ${fmt(cost.ratio.cost)} |`,
    ''
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
  writeFile(path.join(taskDir, key.round === 2 ? 'compare-r2.md' : 'compare.md'), text);
  process.stdout.write(text + '\n');
}

// ---- main ----------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const commands = { research: commandResearch, run: commandRun, checks: commandChecks, render: commandRender, review: commandReview, compare: commandCompare };
  if (!commands[command]) throw new Error(`usage: note-style-offline.cjs <${Object.keys(commands).join('|')}> [--options]`);
  await commands[command](args);
}

module.exports = { WORKSPACE, TOPICS, assertWritable, writeFile, buildPrompts, taskContext, replacedBlock, textbookFragment, parseReview, tally, gate, checkNote, mermaidSyntaxProblems, chartNumbers, costSummary, product };

if (require.main === module)
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
