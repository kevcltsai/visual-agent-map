#!/usr/bin/env node
// Development tool, not product code: the owner-labelled real-failure corpus for map chat.
// The owner marks bad turns of a real conversation; this tool reads the Map Chat record (Chats/records/<id>.jsonl, setting
// "保存心智圖 AI 對話"), checks the owner's case files, replays the exact context of each marked turn on the cheap model, and puts
// the model's answer next to the owner's three sentences. It never invents a verdict: a case is judged by `<id>.check.cjs`
// (exporting an array of checks from tests/tools/map-chat-eval/checks.cjs) when the owner/agent wrote one, otherwise it is listed UNDETERMINED.
//
//   node tests/tools/map-chat-corpus.cjs template                       prints the case file template
//   node tests/tools/map-chat-corpus.cjs turns <record.jsonl>           lists the turns of one record so you can name the bad one
//   node tests/tools/map-chat-corpus.cjs show <record.jsonl> --turn=N   what was sent and answered in that turn
//   node tests/tools/map-chat-corpus.cjs validate --dir=<corpus dir>    checks every case file has the six parts
//   node tests/tools/map-chat-corpus.cjs run --dir=<corpus dir> --records=<dir with the .jsonl files> --out=<dir outside repo> [--runs=3] [--model=haiku]
//
// Real corpora hold the owner's private maps: keep the corpus directory in agents-spec, never in this repository.
const fs = require("node:fs");
const path = require("node:path");

// A case names its turn either as "<record>.jsonl 第 N 輪" (Map Chat records) or "<file>.json 第 N 筆" (the AI exchange log array, replayed with the exact stored prompt).
const SOURCE_RECORD = /^(.+\.jsonl)\s*第\s*(\d+)\s*輪$/;
const SOURCE_EXCHANGE = /^(.+\.json)\s*第\s*(\d+)\s*筆$/;
const FIELDS = ["來源", "類別", "使用者說", "該答什麼或做什麼", "不可接受的答案", "可接受的答案", "為什麼不合格", "hold-out"];
const CATEGORIES = ["答非所問", "多做", "少做", "編造", "語氣", "格式", "其他"];
const TEMPLATE = `# 案例 C01
來源: <record 檔名>.jsonl 第 <N> 輪
類別: ${CATEGORIES.join("／")}（選一個）
使用者說: <那一輪使用者的原話>
該答什麼或做什麼: <一個具體的事實或行為>
不可接受的答案: <一個你不接受的答案>
可接受的答案: <一個你接受的答案，或可接受的澄清>
為什麼不合格: <一句話>
hold-out: 否
`;

/** Reads "key: value" parts; a value runs until the next known key, so it can span lines. */
function parseCase(text) {
  const out = {};
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^(${FIELDS.join("|")}):\\s?(.*)$`));
    if (m) { key = m[1]; out[key] = m[2]; } else if (key && !line.startsWith("#")) out[key] += `\n${line}`;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

function validateCase(c) {
  const problems = FIELDS.filter(f => !c[f] || /^<.*>$/.test(c[f])).map(f => `缺「${f}」或還是範本文字`);
  if (c["類別"] && !CATEGORIES.some(x => c["類別"].includes(x))) problems.push(`類別要是：${CATEGORIES.join("、")}`);
  if (c["來源"] && !SOURCE_RECORD.test(c["來源"]) && !SOURCE_EXCHANGE.test(c["來源"])) problems.push("來源格式：<檔名>.jsonl 第 N 輪，或 <檔名>.json 第 N 筆");
  return problems;
}

function readRecord(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const turns = new Map();
  for (const l of lines) {
    if (l.type === "turn_start") turns.set(l.turn, { ...(turns.get(l.turn) || {}), start: l });
    if (l.type === "turn_end") turns.set(l.turn, { ...(turns.get(l.turn) || {}), end: l });
  }
  return { head: lines.find(l => l.type === "conversation"), turns };
}

const kindsOf = raw => { try { return JSON.parse(raw).actions.map(a => a.kind).join("、") || "無"; } catch { return "(無法解析)"; } };
const clip = (t, n) => String(t ?? "").replace(/\s+/g, " ").slice(0, n);

function listTurns(file) {
  const { turns } = readRecord(file);
  for (const [n, t] of [...turns].sort((a, b) => a[0] - b[0])) {
    console.log(`第 ${n} 輪｜${t.end?.status ?? "?"}｜${t.start?.backfilled ? "補錄(無原始請求)" : "有請求"}｜使用者：${clip(t.start?.message, 40)}｜回覆：${clip(t.end?.reply, 50)}｜動作：${kindsOf(t.end?.raw)}`);
  }
}

function showTurn(file, n) {
  const t = readRecord(file).turns.get(n);
  if (!t) throw new Error(`no turn ${n}`);
  console.log([
    `使用者：${t.start?.message}`, `模型：${t.start?.request?.model ?? "?"}`, `回覆：${t.end?.reply}`, `動作：${kindsOf(t.end?.raw)}`,
    `被丟棄：${JSON.stringify(t.end?.rejected ?? [])}`, "套用結果列：", ...(t.end?.lines ?? []).map(l => `  [${l.status}] ${l.text}`),
    "（這份紀錄沒有套用後的地圖快照）"
  ].join("\n"));
}

/** Exchange-log turns have no stored context object, so only the RAW layer exists: checks run on what the model itself proposed. */
function evaluateRawOnly(checks, raw) {
  const layer = require("./map-chat-eval.cjs").rawLayer(raw);
  if (!layer) return [{ desc: "回覆不是 JSON", ok: false }];
  const env = { reply: layer.reply, actions: layer.actions, rejected: [], remaining: layer.remaining, input: { outline: [] }, raw: layer };
  return checks.map(c => { try { const r = c.run(env); return { desc: c.desc, ok: r.ok }; } catch (e) { return { desc: c.desc, ok: false }; } });
}

function loadCorpus(dir) {
  return fs.readdirSync(dir).filter(f => /\.md$/.test(f)).sort().map(f => ({ file: f, id: f.replace(/\.md$/, ""), fields: parseCase(fs.readFileSync(path.join(dir, f), "utf8")) }));
}

function validate(dir) {
  let bad = 0;
  for (const c of loadCorpus(dir)) {
    const problems = validateCase(c.fields);
    if (problems.length) { bad++; console.log(`✖ ${c.file}：${problems.join("；")}`); } else console.log(`✔ ${c.file}`);
  }
  if (bad) process.exitCode = 1;
}

/** The request a turn was sent with, rebuilt from the record (no builder: the stored context is exactly what was sent). */
function requestOf(turn) {
  const r = turn.start?.request;
  if (!r?.context) throw new Error("this turn has no stored request (backfilled); pick another turn");
  return { message: r.message, context: r.context, language: r.language, contentLanguage: r.contentLanguage, model: r.model, reasoning: r.reasoning || "low" };
}

async function run(args, ask) {
  const { product, evaluate, callClaudeForCorpus } = require("./map-chat-eval.cjs");
  ask = ask || callClaudeForCorpus;
  const dir = args.dir, records = args.records, out = args.out;
  if (!dir || !records || !out) throw new Error("--dir, --records and --out are required");
  const resolved = path.resolve(out);
  if (resolved.startsWith(path.resolve(__dirname, "../..") + path.sep)) throw new Error("--out must be outside this repository");
  const p = product();
  const runs = Number(args.runs || 3), model = args.model || "haiku";
  const lines = ["# 真實失敗案例庫回放", "", `模型 ${model}，每案 ${runs} 次。沒有檢查檔的案例標「未裁定」：請對照你寫的三句話自己看。hold-out 案例不拿來調 prompt。`, ""];
  for (const c of loadCorpus(dir)) {
    const problems = validateCase(c.fields);
    if (problems.length) { lines.push(`## ${c.id}`, `略過：${problems.join("；")}`, ""); continue; }
    const exchange = c.fields["來源"].match(SOURCE_EXCHANGE);
    let prompt, request;
    if (exchange) {
      const entry = JSON.parse(fs.readFileSync(path.join(records, exchange[1]), "utf8"))[Number(exchange[2])];
      if (!entry || !String(entry.step).startsWith("map-chat")) { lines.push(`## ${c.id}`, `略過：${exchange[1]} 第 ${exchange[2]} 筆不是地圖對話`, ""); continue; }
      prompt = entry.prompt;
    } else {
      const [, recFile, turnNo] = c.fields["來源"].match(SOURCE_RECORD);
      const turn = readRecord(path.join(records, recFile)).turns.get(Number(turnNo));
      if (!turn) { lines.push(`## ${c.id}`, `略過：找不到 ${recFile} 第 ${turnNo} 輪`, ""); continue; }
      request = requestOf(turn);
      prompt = p.step.mapChatStep.render(request);
    }
    const checkFile = path.join(dir, `${c.id}.check.cjs`);
    const checks = fs.existsSync(checkFile) ? require(path.resolve(checkFile)) : [];
    lines.push(`## ${c.id}（${c.fields["類別"]}${/是/.test(c.fields["hold-out"]) ? "，hold-out" : ""}）`, `使用者說：${c.fields["使用者說"]}`, `該答什麼：${c.fields["該答什麼或做什麼"]}`, `不可接受：${c.fields["不可接受的答案"]}`, `可接受：${c.fields["可接受的答案"]}`, "");
    for (let i = 1; i <= runs; i++) {
      const reply = await ask(p, prompt, p.step.MAP_CHAT_SCHEMA, model);
      if (!reply.raw) { lines.push(`- 第 ${i} 次：呼叫失敗 ${reply.error}`); continue; }
      const verdict = checks.length ? (request ? evaluate(p, { input: {}, checks }, { context: request.context }, reply.raw) : evaluateRawOnly(checks, reply.raw)).map(x => `${x.ok ? "過" : "不過"}：${x.desc}`).join("；") : "未裁定";
      let shown = "";
      try { const j = JSON.parse(reply.raw); shown = `${clip(j.reply, 120)}｜動作：${j.actions.map(a => a.kind).join("、") || "無"}`; } catch { shown = "(無法解析)"; }
      lines.push(`- 第 ${i} 次：${verdict}｜${shown}`);
    }
    lines.push("");
  }
  fs.mkdirSync(resolved, { recursive: true });
  const target = path.join(resolved, "corpus-report.md");
  fs.writeFileSync(target, lines.join("\n") + "\n");
  console.log(`wrote ${target}`);
  return target;
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = Object.fromEntries(rest.filter(a => a.startsWith("--")).map(a => { const [k, ...v] = a.slice(2).split("="); return [k, v.join("=")]; }));
  const positional = rest.find(a => !a.startsWith("--"));
  try {
    if (cmd === "template") process.stdout.write(TEMPLATE);
    else if (cmd === "turns") listTurns(positional);
    else if (cmd === "show") showTurn(positional, Number(args.turn));
    else if (cmd === "validate") validate(args.dir);
    else if (cmd === "run") run(args).catch(e => { console.error(e.message); process.exit(2); });
    else { console.error("usage: map-chat-corpus.cjs template|turns|show|validate|run (see the header)"); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(2); }
}

module.exports = { run, parseCase, validateCase, readRecord, requestOf, FIELDS, CATEGORIES };
