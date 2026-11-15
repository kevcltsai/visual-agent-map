// Read-only view of a map's chat records and research prompts, for diagnosing what the owner reports. Writes nothing.
// Usage:
//   node scripts/chat-timeline.mjs <vault> <map name>                    every turn of every conversation, in Taiwan time
//   node scripts/chat-timeline.mjs <vault> <map name> --prompt <ISO time|id>   the key parts of one task.run prompt
//   node scripts/chat-timeline.mjs <vault> <map name> --diff <A> <B>          the key parts of two task.run prompts compared
// <map name> is the map's folder name (an exact match wins, else a unique substring). Prompts come from the vault's
// .obsidian/plugins/visual-agent-map/ai-exchanges.json; an ISO time picks the task.run that started closest to it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessConfigDir } from "./create-onboarding-test-vault.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set([harnessConfigDir, ".vam-app", ".trash", ".git", "node_modules"]);
export const taiwanTime = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(5, 19).replace("T", " ") : "??-?? ??:??:??"; };
const cut = (text, length = 80) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return [...flat].length > length ? `${[...flat].slice(0, length).join("")}…` : flat; };

function mapFolders(folder, found = []) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const path = join(folder, entry.name);
    if (existsSync(join(path, "Chats/records"))) found.push(path);
    mapFolders(path, found);
  }
  return found;
}

export function findMap(vault, name) {
  const maps = mapFolders(vault);
  const exact = maps.filter(path => basename(path) === name);
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : maps.filter(path => basename(path).includes(name));
  if (partial.length === 1) return partial[0];
  throw new Error(partial.length ? `「${name}」符合多張地圖：${partial.map(path => basename(path)).join("、")}` : `找不到有對話紀錄的地圖「${name}」。有：${maps.map(path => basename(path)).join("、") || "（沒有）"}`);
}

function actionSummary(action) {
  const tail = text => [...text].length > 40 ? `…${[...text].slice(-39).join("")}` : text;
  const target = (action.path && tail(action.path)) || action.title || action.action || (Array.isArray(action.nodeIds) && action.nodeIds.length ? `${action.nodeIds.length} 個議題` : "");
  const flags = ["rewrite", "images", "needsWeb"].filter(key => action[key] === true);
  return [action.kind, target && `「${cut(target, 40)}」`, flags.length && `(${flags.join(",")})`].filter(Boolean).join(" ");
}

function turnActions(line) {
  try { const raw = JSON.parse(line.raw ?? "null"); return Array.isArray(raw?.actions) ? raw.actions : []; } catch { return []; }
}

// One text line per record line worth showing; research_batch_topic lines are counted into their batch's end.
export function timeline(mapFolder) {
  const directory = join(mapFolder, "Chats/records");
  const out = [];
  for (const name of readdirSync(directory).filter(file => file.endsWith(".jsonl")).sort()) {
    const lines = readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean).map(text => { try { return JSON.parse(text); } catch { return { type: "unreadable", text }; } });
    const topics = new Map();
    for (const line of lines) {
      const at = taiwanTime(line.at ?? line.startedAt);
      if (line.type === "conversation") out.push(`== 對話 ${line.id}（${at} 開始，外掛 ${line.pluginVersion ?? "?"}）`);
      else if (line.type === "turn_start") out.push(line.auto ? `${at}  AUTO 第 ${line.round ?? "?"} 輪（turn ${line.turn}）${line.resumed ? "［接續］" : ""}：${cut(line.remaining || line.message)}` : `${at}  USER（turn ${line.turn}）：${cut(line.message)}`);
      else if (line.type === "turn_end") {
        const actions = turnActions(line);
        out.push(`${at}    → ${line.status === "plan" ? "計畫待確認" : line.status}${line.reason ? `（${line.reason}）` : ""}：${cut(line.reply)}`);
        for (const action of actions) out.push(`              · ${actionSummary(action)}`);
      } else if (line.type === "plan") out.push(`${at}    計畫 ${{ applied: "已套用", cancelled: "已取消", stopped: "已停止" }[line.state] ?? line.state}（turn ${line.turn}）`);
      else if (line.type === "images") out.push(`${at}    圖片 ${line.state}（${Array.isArray(line.items) ? line.items.length : 0} 張）`);
      else if (line.type === "event" && line.kind === "chain_end") out.push(`${at}    chain_end ${line.reason}（第 ${line.round ?? "?"} 輪${line.calls ? `，${line.calls} 次呼叫` : ""}）${line.remaining ? ` remaining：${cut(line.remaining)}` : ""}`);
      else if (line.type === "event" && line.kind === "research_batch") out.push(`${at}    研究批次開始：${Array.isArray(line.topics) ? line.topics.length : "?"} 個議題（${(line.topics ?? []).slice(0, 3).map(topic => cut(topic.title, 20)).join("、")}${(line.topics?.length ?? 0) > 3 ? "…" : ""}）`);
      else if (line.type === "event" && line.kind === "research_batch_topic") { const count = topics.get(line.turn) ?? {}; count[line.status] = (count[line.status] ?? 0) + 1; topics.set(line.turn, count); }
      else if (line.type === "event" && line.kind === "research_batch_end") { const count = topics.get(line.turn) ?? {}; topics.delete(line.turn); out.push(`${at}    研究批次結束${line.status ? `（${line.status}）` : ""}：${Object.entries(count).map(([status, n]) => `${status} ${n}`).join("、") || "沒有議題紀錄"}`); }
      else if (line.type === "event") out.push(`${at}    ${line.kind}`);
      else if (line.type === "moved") out.push(`${at}    地圖搬移：${line.from} → ${line.to}`);
      else if (line.type === "unreadable") out.push(`  ??  看不懂的一行：${cut(line.text, 60)}`);
    }
  }
  return out;
}

const firstLine = path => readFileSync(path, "utf8").split("\n")[0].trim();
// Text pieces the prompt is built from, read from this checkout's step templates so the markers follow the prompts.
function promptMarkers() {
  const task = join(root, "core/steps/task"), shared = join(root, "core/steps/_shared");
  const visuals = readdirSync(task).filter(name => /^visual-.*\.md$/.test(name)).map(name => firstLine(join(task, name)).split("{{")[0]).filter(text => text.length >= 8);
  const labels = Object.fromEntries(["topic", "task", "rules", "summary-direction", "summary"].map(key => [key, ["zh", "en"].map(lang => join(shared, `label-${key}.${lang}.md`)).filter(existsSync).map(firstLine)]));
  const allLabels = readdirSync(shared).filter(name => /^label-.*\.md$/.test(name)).map(name => firstLine(join(shared, name)));
  return { visuals, labels, allLabels };
}

// The parts of a task.run prompt the owner asks about: heading rules, the image (visual) rule, the task and its direction, the tone.
export function promptParts(prompt, markers = promptMarkers()) {
  const lines = String(prompt).split("\n");
  const isLabel = (line, list) => list.some(label => line.trim() === `${label}:` || line.trim() === `${label}：`);
  const block = list => {
    const start = lines.findIndex(line => isLabel(line, list));
    if (start < 0) return "";
    const body = [];
    for (const line of lines.slice(start + 1)) { if (isLabel(line, markers.allLabels)) break; body.push(line); }
    return body.join("\n").trim();
  };
  const tone = [];
  const toneStart = lines.findIndex(line => /^(寫作語氣：|Tone: )/.test(line));
  if (toneStart >= 0) for (const line of lines.slice(toneStart)) { if (!line.trim()) break; tone.push(line); }
  return {
    "三級標題規則": lines.filter(line => line.includes("###")).join("\n"),
    "圖片規則（visual）": lines.filter(line => markers.visuals.some(text => line.startsWith(text))).join("\n"),
    "目前議題": block(markers.labels.topic),
    "目前任務": block(markers.labels.task),
    "議題 AI 規則": block(markers.labels.rules),
    "結論方向": block(markers.labels["summary-direction"]),
    "寫作語氣": tone.join("\n")
  };
}

export function readExchanges(vault) {
  const list = JSON.parse(readFileSync(join(vault, harnessConfigDir, "plugins/visual-agent-map/ai-exchanges.json"), "utf8"));
  if (!Array.isArray(list)) throw new Error("ai-exchanges.json 不是清單");
  return list.filter(entry => String(entry?.step ?? "").startsWith("task.run"));
}

// An id (or its unique prefix) or an ISO time (the closest startedAt).
export function pickExchange(exchanges, key) {
  const byId = exchanges.filter(entry => String(entry.id ?? "").startsWith(key));
  if (byId.length === 1) return byId[0];
  const ms = Date.parse(key);
  if (!Number.isFinite(ms)) throw new Error(byId.length ? `id「${key}」符合 ${byId.length} 次呼叫，請多給幾碼` : `找不到 id 或時間「${key}」的 task.run`);
  let best = null;
  for (const entry of exchanges) { const at = Date.parse(entry.startedAt); if (Number.isFinite(at) && (!best || Math.abs(at - ms) < Math.abs(Date.parse(best.startedAt) - ms))) best = entry; }
  if (!best) throw new Error("ai-exchanges.json 裡沒有 task.run");
  return best;
}

const header = entry => `task.run ${entry.id}（${taiwanTime(entry.startedAt)} 台灣時間，議題「${entry.topic ?? "?"}」，${entry.model ?? "?"}）`;

export function showPrompt(entry, markers) {
  const out = [header(entry)];
  for (const [name, text] of Object.entries(promptParts(entry.prompt, markers))) out.push(`--- ${name}`, text || "（沒有）");
  return out;
}

export function diffPrompts(a, b, markers) {
  const left = promptParts(a.prompt, markers), right = promptParts(b.prompt, markers);
  const out = [`A ${header(a)}`, `B ${header(b)}`];
  for (const name of Object.keys(left)) {
    if (left[name] === right[name]) { out.push(`--- ${name}：相同`); continue; }
    const aLines = left[name].split("\n"), bLines = right[name].split("\n");
    out.push(`--- ${name}：不同`);
    for (const line of aLines) if (!bLines.includes(line)) out.push(`- ${line}`);
    for (const line of bLines) if (!aLines.includes(line)) out.push(`+ ${line}`);
  }
  return out;
}

export function run(args) {
  const [vaultArg, name, flag, ...rest] = args;
  if (!vaultArg || !name) throw new Error("用法：node scripts/chat-timeline.mjs <vault> <地圖名> [--prompt <ISO 時間|id> | --diff <A> <B>]");
  const vault = resolve(vaultArg);
  const map = findMap(vault, name);
  if (!flag) return [`地圖：${map}（時間為台灣時間）`, ...timeline(map)];
  // Prompts are the vault's, not the map's: the map name only checks the map exists, and the topic is shown in the header.
  const exchanges = readExchanges(vault);
  if (flag === "--prompt" && rest.length === 1) return showPrompt(pickExchange(exchanges, rest[0]));
  if (flag === "--diff" && rest.length === 2) return diffPrompts(pickExchange(exchanges, rest[0]), pickExchange(exchanges, rest[1]));
  throw new Error(`不認得的參數：${[flag, ...rest].join(" ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${run(process.argv.slice(2)).join("\n")}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
