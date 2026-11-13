#!/usr/bin/env node
// Development tool, not product code: evaluates map chat replies against the cases in tests/tools/map-chat-eval/cases.cjs.
// Calls the real `claude` CLI the way the product does (same prompt, same schema, same arguments), parses the reply with the
// product parser, and checks the properties each case states. Output has no total score: each check reports how many of the
// repeated runs passed.
//
//   node tests/tools/map-chat-eval.cjs run --out=<dir outside the repo> --slug=<name> [--model=haiku] [--runs=3] [--case=A1,B1] [--group=安全] [--jobs=4]
//   node tests/tools/map-chat-eval.cjs flows --out=<dir outside the repo> --slug=<name> [--model=haiku] [--runs=3] [--flow=FL1,FL3] [--jobs=4]
//        long conversations: several turns on one map that each turn changes; the final map is compared with the expected one
//   node tests/tools/map-chat-eval.cjs compare --out=<dir> --a=<slug> --b=<slug>
//   node tests/tools/map-chat-eval.cjs list
//
// The output (prompts, replies) may contain case text only, but it still must not go inside this repository.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { load } = require("../support-replay.cjs");
const { CASES } = require("./map-chat-eval/cases.cjs");
const { FLOWS, TURN_CHECKS } = require("./map-chat-eval/flows.cjs");
const { SimMap, matchTree } = require("./map-chat-eval/sim.cjs");

const REPO = path.resolve(__dirname, "../..");
const arg = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) || "").slice(name.length + 3) || fallback;
const command = process.argv[2];

function product() {
  const step = load("core/steps/map-chat/step.ts");
  const context = load("core/map-chat-context.ts");
  const cli = load("ai/runtime/claude-code-cli.ts");
  return { step, context, cli };
}

/** Everything one case sends: the context, the prompt, and the parse function bound to that context. */
function prepare(p, kase) {
  const { message, language, ...input } = kase.input;
  const context = p.context.buildMapChatContext(input);
  const request = { message, context, language, model: "claude:haiku", reasoning: "low" };
  return { context, request, prompt: p.step.mapChatStep.render(request), schema: p.step.MAP_CHAT_SCHEMA };
}

function callClaude(p, prompt, schema, model) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "map-chat-eval-"));
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn("claude", p.cli.claudeTaskArgs(model, "low", schema, false), { cwd });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 3 * 60 * 1000);
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("close", code => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      try {
        if (code !== 0) throw new Error(`claude exited ${code}: ${(err || out).slice(0, 200)}`);
        const parsed = JSON.parse(out);
        const result = Array.isArray(parsed) ? parsed.find(e => e.type === "result") : parsed;
        if (!result || result.is_error) throw new Error(`claude error: ${String(result?.result).slice(0, 200)}`);
        if (result.structured_output == null) throw new Error("no structured_output");
        resolve({ raw: JSON.stringify(result.structured_output), ms: Date.now() - started, modelUsed: Object.keys(result.modelUsage || {}).join(",") });
      } catch (error) {
        resolve({ error: String(error.message || error), ms: Date.now() - started });
      }
    });
    child.stdin.end(prompt);
  });
}

/** The model's own output before the parser drops anything: { actions, reply } or null when it is not even JSON. */
function rawLayer(raw) {
  try {
    const value = JSON.parse(raw);
    return { actions: Array.isArray(value.actions) ? value.actions : [], reply: typeof value.reply === "string" ? value.reply : "", remaining: typeof value.remaining === "string" ? value.remaining : "" };
  } catch { return null; }
}

/**
 * Parses a raw reply with the product parser and runs the checks. status is "ok", or "parse_error" when the product would reject the
 * whole reply (the user sees a failure, so every check counts as failed). Pure: used by the live run and by the self-test.
 */
function evaluateRun(p, kase, prepared, raw) {
  let env;
  try {
    const parsed = p.step.parseMapChat(raw, prepared.context);
    env = { reply: parsed.reply, actions: JSON.parse(JSON.stringify(parsed.actions)), rejected: parsed.rejected, remaining: parsed.remaining, input: kase.input, raw: rawLayer(raw) };
  } catch (error) {
    return { status: "parse_error", checks: kase.checks.map(c => ({ id: c.id, desc: c.desc, ok: false, note: `reply not valid: ${error.message}` })) };
  }
  const checks = kase.checks.map(c => {
    try {
      const r = c.run(env);
      return { id: c.id, desc: c.desc, ok: r.ok, ...(c.diag ? { diag: true } : {}), ...(r.note ? { note: r.note } : {}) };
    } catch (error) {
      return { id: c.id, desc: c.desc, ok: false, ...(c.diag ? { diag: true } : {}), note: `check crashed: ${error.message}` };
    }
  });
  return { status: "ok", checks };
}
const evaluate = (p, kase, prepared, raw) => evaluateRun(p, kase, prepared, raw).checks;

const sha = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 16);
/** Identity of a case: what it sends and what it checks (including the code of each check), so a changed case is never compared as the same one. */
const caseHash = kase => sha(JSON.stringify(kase.input) + kase.checks.map(c => c.id + c.desc + String(c.run)).join("|"));
const flowHash = flow => sha(JSON.stringify([flow.start, flow.turns.map(t => [t.say, (t.expect || []).map(c => c.id + String(c.run))]), String(flow.final.tree.map(String)), String(flow.final.none), String(flow.final.relations)]));

/** Where a result came from: enough to tell whether two runs are comparable and what produced them. */
function runMeta(p, model) {
  const git = args => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout.trim();
  const version = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();
  return { gitSha: git(["rev-parse", "--short", "HEAD"]), gitDirty: git(["status", "--porcelain"]).split("\n").filter(Boolean).length, claudeVersion: version, model, effort: "low", schemaHash: sha(p.step.MAP_CHAT_SCHEMA), promptTemplateHash: sha(p.step.mapChatStep.render({ message: "x", context: p.context.buildMapChatContext({ mapTitle: "", outline: [], selected: [], references: [], snippets: [], files: [], history: [] }), language: "zh-TW", model: "claude:haiku", reasoning: "low" })) };
}

function assertOutsideRepo(dir) {
  const resolved = path.resolve(dir);
  if (resolved === REPO || resolved.startsWith(REPO + path.sep)) throw new Error("--out must be outside this repository");
  return resolved;
}

async function pool(items, jobs, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  }));
  return results;
}


/**
 * Plays one flow: each turn is built from the simulated map, answered by `ask(prompt, schema)` -> { raw } | { error }, parsed with the
 * product parser, checked, and applied to the map. Returns the per-turn results and the final comparison. Pure apart from `ask`.
 */
async function playFlow(p, flow, ask) {
  const sim = new SimMap(flow.start.title, flow.start.rows);
  const history = [];
  const turns = [];
  for (const turn of flow.turns) {
    const input = { selected: [], references: [], snippets: [], files: [], history: history.slice(), language: "zh-TW", message: turn.say, ...sim.contextInput(), mapNeedsName: !sim.title };
    const kase = { input, checks: [...TURN_CHECKS, ...(turn.expect || [])] };
    const prepared = prepare(p, kase);
    const reply = await ask(prepared.prompt, prepared.schema);
    if (!reply.raw) { turns.push({ say: turn.say, error: reply.error || "no reply", checks: [] }); break; }
    const run = evaluateRun(p, kase, prepared, reply.raw);
    if (run.status !== "ok") { turns.push({ say: turn.say, error: "reply not valid (the product rejects the whole reply)", raw: reply.raw, prompt: prepared.prompt, checks: run.checks }); break; }
    const parsed = p.step.parseMapChat(reply.raw, prepared.context);
    const actions = JSON.parse(JSON.stringify(parsed.actions));
    sim.apply(actions);
    history.push({ role: "user", text: turn.say }, { role: "assistant", text: parsed.reply });
    turns.push({ say: turn.say, reply: parsed.reply, actions, raw: reply.raw, prompt: prepared.prompt, checks: run.checks });
  }
  // A turn that failed (CLI error, rejected reply) makes the whole flow INVALID, even if the map happens to match: nothing was proven.
  const failed = turns.findIndex(t => t.error);
  const invalid = failed >= 0 || turns.length < flow.turns.length;
  const problems = invalid ? [`invalid: turn ${(failed >= 0 ? failed : turns.length) + 1} failed (${turns[failed]?.error ?? "no reply"})`] : matchTree(sim.snapshot(), flow.final.tree);
  const titles = [...sim.nodes.values()].map(n => n.title);
  if (!invalid && flow.final.none && titles.some(t => flow.final.none.test(t))) problems.push(`a title still matches ${flow.final.none}: ${titles.filter(t => flow.final.none.test(t)).join("、")}`);
  for (const want of flow.final.relations || []) {
    const title = id => sim.nodes.get(id)?.title ?? "";
    if (!sim.relations.some(r => want.from.test(title(r.from)) && want.to.test(title(r.to)) && r.kind === want.kind)) problems.push(`relation ${want.from} ${want.kind} ${want.to} missing`);
  }
  if (sim.skipped.length) problems.push(`unsimulated actions used: ${sim.skipped.join(",")}`);
  const turnFailures = turns.flatMap((t, i) => t.checks.filter(c => !c.ok).map(c => `turn ${i + 1}: ${c.desc}${c.note ? ` (${c.note})` : ""}`));
  return { turns, problems, turnFailures, final: sim.snapshot(), invalid, evidence: sim.evidence(), finalOk: !invalid && problems.length === 0 };
}

async function runFlows() {
  const out = assertOutsideRepo(arg("out", ""));
  const slug = arg("slug", "");
  if (!arg("out") || !slug) throw new Error("--out and --slug are required");
  const model = arg("model", "haiku");
  const runs = Number(arg("runs", "3"));
  const ids = arg("flow") ? arg("flow").split(",") : null;
  const flows = FLOWS.filter(f => !ids || ids.includes(f.id));
  const p = product();
  const jobs = flows.flatMap(flow => Array.from({ length: runs }, (_, i) => ({ flow, n: i + 1 })));
  console.log(`${flows.length} flows x ${runs} runs = ${jobs.length} conversations (${flows.reduce((n, f) => n + f.turns.length, 0) * runs} ${model} calls)`);
  let done = 0;
  const results = await pool(jobs, Number(arg("jobs", "4")), async ({ flow, n }) => {
    const r = await playFlow(p, flow, (prompt, schema) => callClaude(p, prompt, schema, model));
    process.stdout.write(`\r${++done}/${jobs.length}`);
    return { id: flow.id, run: n, flowHash: flowHash(flow), ...r };
  });
  console.log("");
  const dir = path.join(out, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "flows.json"), JSON.stringify({ slug, model, runs, at: new Date().toISOString(), meta: runMeta(p, model), results }, null, 1));
  const lines = [`# 長對話流程評測：${slug}`, "", `模型 ${model}，每個流程 ${runs} 次。通過 = 最後一張地圖和預期完全一致（卡片、層級、類型、外觀、關係、不該出現的字）。`, "「模擬器證據」的流程用到產品沒有現成純函式的操作（移動、類型、關係、合併），是參考，不計入產品通過數。", ""];
  lines.push("| 流程 | 證據 | 最終地圖一致 | 無效（有一輪失敗） | 每輪檢查全過 |", "| --- | --- | --- | --- | --- |");
  for (const f of flows) {
    const mine = results.filter(r => r.id === f.id);
    const ev = mine[0]?.evidence;
    lines.push(`| ${f.id} ${f.title} | ${ev ? (ev.label === "product" ? "產品證據" : `模擬器證據（用到：${ev.simulatorOnly.join("、")}）`) : "?"} | ${mine.filter(r => r.finalOk).length}/${mine.length} | ${mine.filter(r => r.invalid).length}/${mine.length} | ${mine.filter(r => !r.turnFailures.length).length}/${mine.length} |`);
  }
  lines.push("");
  for (const f of flows) for (const r of results.filter(x => x.id === f.id && (!x.finalOk || x.turnFailures.length))) {
    lines.push(`## ${f.id} 第 ${r.run} 次`, ...r.problems.map(x => `- 最終地圖：${x}`), ...r.turnFailures.map(x => `- ${x}`), "");
  }
  fs.writeFileSync(path.join(dir, "flows-report.md"), lines.join("\n") + "\n");
  console.log(`wrote ${path.join(dir, "flows-report.md")}`);
}

async function run() {
  const out = assertOutsideRepo(arg("out", ""));
  const slug = arg("slug", "");
  if (!arg("out") || !slug) throw new Error("--out and --slug are required");
  const model = arg("model", "haiku");
  const runs = Number(arg("runs", "3"));
  const ids = arg("case") ? arg("case").split(",") : null;
  const group = arg("group");
  const cases = CASES.filter(k => (!ids || ids.includes(k.id)) && (!group || k.group === group));
  const p = product();
  const jobs = [];
  for (const kase of cases) for (let n = 1; n <= runs; n++) jobs.push({ kase, n });
  const dir = path.join(out, slug);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`${cases.length} cases x ${runs} runs = ${jobs.length} ${model} calls`);
  let done = 0;
  const results = await pool(jobs, Number(arg("jobs", "4")), async ({ kase, n }) => {
    const prepared = prepare(p, kase);
    const reply = await callClaude(p, prepared.prompt, prepared.schema, model);
    const run = reply.raw ? evaluateRun(p, kase, prepared, reply.raw) : { status: "infra_error", checks: [] };
    process.stdout.write(`\r${++done}/${jobs.length}`);
    return { id: kase.id, run: n, caseHash: caseHash(kase), model, modelUsed: reply.modelUsed, ms: reply.ms, status: run.status, error: reply.error, prompt: prepared.prompt, raw: reply.raw, checks: run.checks };
  });
  console.log("");
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ slug, model, runs, at: new Date().toISOString(), meta: runMeta(p, model), results }, null, 1));
  fs.writeFileSync(path.join(dir, "report.md"), report(cases, results, runs, model, slug));
  console.log(`wrote ${path.join(dir, "report.md")}`);
}

function summarize(cases, results) {
  return cases.map(kase => {
    const mine = results.filter(r => r.id === kase.id);
    const errors = mine.filter(r => r.error).length;
    const received = mine.filter(r => r.raw);
    // Denominator = replies received. A reply the product rejects counts as failed on every check; an infrastructure error is not a reply.
    const rows = kase.checks.map(c => {
      const passes = received.filter(r => r.checks.find(x => x.id === c.id)?.ok).length;
      const notes = [...new Set(received.map(r => r.checks.find(x => x.id === c.id)).filter(x => x && !x.ok && x.note).map(x => x.note))].slice(0, 2);
      return { id: c.id, desc: c.desc, diag: !!c.diag, passes, total: received.length, notes };
    });
    return { kase, errors, parseErrors: received.filter(r => r.status === "parse_error").length, received: received.length, attempts: mine.length, rows, replies: received.filter(r => r.status !== "parse_error").map(r => JSON.parse(r.raw)) };
  });
}

function report(cases, results, runs, model, slug) {
  const sum = summarize(cases, results);
  const lines = [`# 地圖對話評測：${slug}`, "", `模型 ${model}，每題 ${runs} 次。「2/3」代表 3 次中 2 次通過；沒有總分。`, ""];
  const calls = results.length;
  const errored = results.filter(r => r.error).length;
  const allChecks = sum.flatMap(s => s.rows);
  const received = sum.reduce((n, s) => n + s.received, 0);
  const parseErrors = sum.reduce((n, s) => n + s.parseErrors, 0);
  const casePass = results.filter(r => r.raw && r.status === "ok" && r.checks.every(c => c.ok || c.diag)).length;
  lines.push(`呼叫成功率 ${received}/${calls}（基礎設施失敗 ${errored} 次）；可解析率 ${received - parseErrors}/${received}（產品會整則拒絕的壞格式 ${parseErrors} 次）；題目通過 ${casePass}/${received}（只算任務檢查；壞格式算失敗；語氣與格式屬「診斷」，另列）。`, "");
  lines.push(`呼叫 ${calls} 次（失敗 ${errored} 次）；檢查項 ${allChecks.length} 條，全部通過 ${allChecks.filter(r => r.passes === r.total && r.total > 0).length} 條，有任一次失敗 ${allChecks.filter(r => r.passes < r.total).length} 條。`, "");
  const failing = sum.filter(s => s.rows.some(r => r.passes < r.total) || s.errors || s.parseErrors);
  const weak = sum.filter(s => s.kase.weak);
  if (weak.length) lines.push("## 弱檢查（通過不代表答對）", "", ...weak.map(s => `- ${s.kase.id} ${s.kase.title}：${s.kase.weak}`), "");
  lines.push("## 有失敗的案例", "");
  if (!failing.length) lines.push("無。", "");
  for (const s of failing) {
    lines.push(`### ${s.kase.id} ${s.kase.title}（${s.kase.group}）`, `來源：${s.kase.source}`, "");
    if (s.errors) lines.push(`- 基礎設施失敗 ${s.errors} 次`);
    if (s.parseErrors) lines.push(`- 壞格式（整則被產品拒絕）${s.parseErrors} 次`);
    for (const r of s.rows) if (r.passes < r.total) lines.push(`- ${r.diag ? "（診斷）" : ""}${r.passes}/${r.total} ${r.desc}${r.notes.length ? `（${r.notes.join("；")}）` : ""}`);
    if (s.kase.weak) lines.push(`- 注意：${s.kase.weak}`);
    lines.push("");
  }
  const negs = sum.filter(x => x.kase.group === "不該做");
  if (negs.length) {
    lines.push("## 不該做（負向測試）：模型有沒有提出違規動作", "", "「提出違規」= 原始輸出裡出現被禁止的事（解析器丟棄之前）。每條規則分開看，不加總，也不是實際風險率。對照題檢查的是「合法的同類操作有被做到」。", "", "| 案例 | 類型 | 提出違規／收到回覆 | 其他檢查未過 |", "| --- | --- | --- | --- |");
    for (const s of negs) {
      const control = /^control of/.test(s.kase.source);
      const attempt = s.rows.filter(r => r.id.startsWith("raw:"));
      const violated = attempt.reduce((n, r) => Math.max(n, r.total - r.passes), 0);
      const other = s.rows.filter(r => !r.id.startsWith("raw:") && r.passes < r.total).map(r => `${r.desc} ${r.passes}/${r.total}`);
      lines.push(`| ${s.kase.id} ${s.kase.title} | ${control ? "對照" : "誘惑"} | ${control ? "—" : `${violated}/${s.received}`} | ${other.join("；") || "—"} |`);
    }
    lines.push("");
  }
  lines.push("## 需要你抽看的（不計分）", "");
  for (const s of sum.filter(x => x.kase.review)) {
    lines.push(`### ${s.kase.id} ${s.kase.title}`, `看什麼：${s.kase.review}`, `訊息：${s.kase.input.message}`);
    s.replies.slice(0, 1).forEach(r => lines.push(`回覆：${r.reply}`, `動作：${r.actions.map(a => a.kind + (a.title ? `「${a.title}」` : "")).join("、") || "無"}`));
    lines.push("");
  }
  lines.push("## 全部案例", "", "| 案例 | 群組 | 通過 |", "| --- | --- | --- |");
  for (const s of sum) lines.push(`| ${s.kase.id} ${s.kase.title} | ${s.kase.group} | ${s.rows.reduce((n, r) => n + r.passes, 0)}/${s.rows.reduce((n, r) => n + r.total, 0)} |`);
  return lines.join("\n") + "\n";
}

/**
 * Compares two runs on the cases whose definition hash is the same in both. Added, changed and removed cases are listed, never skipped
 * silently. It prints raw counts only: no better/worse verdict (a small sample cannot support one). Flows are compared the same way.
 */
function compare() {
  const out = assertOutsideRepo(arg("out", ""));
  const read = (slug, file) => { const f = path.join(out, slug, file); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };
  const [A, B] = [arg("a"), arg("b")];
  const a = read(A, "results.json"), b = read(B, "results.json");
  if (!a || !b) throw new Error("both runs need a results.json");
  const lines = [`# 比較 ${A} → ${B}`, ""];
  for (const key of ["gitSha", "claudeVersion", "model", "effort", "schemaHash", "promptTemplateHash"]) {
    const x = a.meta?.[key], y = b.meta?.[key];
    if (x === undefined || y === undefined) lines.push(`- ${key}：其中一邊沒有記錄（舊格式）`);
    else if (x !== y) lines.push(`- ${key} 不同：${x} → ${y}`);
  }
  const hashOf = (data, id) => data.results.find(r => r.id === id)?.caseHash;
  const ids = [...new Set([...a.results, ...b.results].map(r => r.id))];
  const same = [], changed = [], added = [], removed = [];
  for (const id of ids) {
    const x = hashOf(a, id), y = hashOf(b, id);
    if (x && y) (x === y ? same : changed).push(id); else (x ? removed : added).push(id);
  }
  lines.push("", `題目：相同 ${same.length}，定義已變更 ${changed.length}${changed.length ? `（${changed.join("、")}）` : ""}，新增 ${added.length}${added.length ? `（${added.join("、")}）` : ""}，移除 ${removed.length}${removed.length ? `（${removed.join("、")}）` : ""}。只比較「相同」的題目。`, "");
  const stat = (data, id) => { const rs = data.results.filter(r => r.id === id && r.raw); return { n: rs.length, ok: rs.filter(r => r.status === "ok" && r.checks.every(c => c.ok)).length }; };
  const diffs = [];
  for (const id of same) {
    const kase = CASES.find(k => k.id === id);
    const x = stat(a, id), y = stat(b, id);
    const perCheck = (kase?.checks ?? []).flatMap(c => {
      const px = a.results.filter(r => r.id === id && r.raw).filter(r => r.checks.find(z => z.id === c.id)?.ok).length;
      const py = b.results.filter(r => r.id === id && r.raw).filter(r => r.checks.find(z => z.id === c.id)?.ok).length;
      return px === py ? [] : [`    ${c.desc}：${px}/${x.n} → ${py}/${y.n}`];
    });
    if (perCheck.length || x.ok !== y.ok) diffs.push(`- ${id} ${kase?.title ?? ""}：整題通過 ${x.ok}/${x.n} → ${y.ok}/${y.n}`, ...perCheck);
  }
  lines.push("## 次數有差的題目（原始次數，不是結論）", "", ...(diffs.length ? diffs : ["沒有任何題目的次數改變。"]));
  const fa = read(A, "flows.json"), fb = read(B, "flows.json");
  if (fa && fb) {
    lines.push("", "## 長流程");
    for (const id of [...new Set([...fa.results, ...fb.results].map(r => r.id))]) {
      const ra = fa.results.filter(r => r.id === id), rb = fb.results.filter(r => r.id === id);
      if (ra[0]?.flowHash !== rb[0]?.flowHash) { lines.push(`- ${id}：定義不同或只在一邊，不比較`); continue; }
      lines.push(`- ${id}：最終地圖一致 ${ra.filter(r => r.finalOk).length}/${ra.length} → ${rb.filter(r => r.finalOk).length}/${rb.length}；無效 ${ra.filter(r => r.invalid).length} → ${rb.filter(r => r.invalid).length}`);
    }
  }
  console.log(lines.join("\n"));
}

if (require.main === module) {
  if (command === "flows") runFlows().catch(e => { console.error(e.message); process.exit(2); });
  else if (command === "run") run().catch(e => { console.error(e.message); process.exit(2); });
  else if (command === "compare") compare();
  else if (command === "list") CASES.forEach(k => console.log(`${k.id}\t${k.group}\t${k.title}\t${k.checks.length} checks`));
  else { console.error("usage: map-chat-eval.cjs run|compare|list (see the header)"); process.exit(2); }
}

const callClaudeForCorpus = (p, prompt, schema, model) => callClaude(p, prompt, schema, model);
module.exports = { callClaudeForCorpus, prepare, evaluate, evaluateRun, product, playFlow, rawLayer, caseHash, flowHash };
