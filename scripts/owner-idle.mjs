// Read-only check that the owner is not using their testing vault, run before anything installs into it.
// Any one of these refuses: the newest conversation of a map ends on a plan nobody applied or cancelled; an automatic
// continuation is running (the newest turn is an automatic round, `auto`, with no `chain_end` after it); a `turn_start` in the last 15 minutes;
// an AI call in ai-exchanges.json in the last 15 minutes. A file that cannot be read or parsed refuses too.
// waitOwnerIdle (--wait-idle) re-checks every minute for up to an hour instead of refusing at once.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { harnessConfigDir } from "./create-onboarding-test-vault.mjs";

export const OWNER_IDLE_WINDOW_MS = 15 * 60 * 1000;
// A turn or call that started but has not ended counts as running this long (a chain waits up to 30 minutes for research);
// older unfinished ones are left behind by a crash and must not block installing for ever.
export const OWNER_RUNNING_WINDOW_MS = 60 * 60 * 1000;
const SKIP = new Set([harnessConfigDir, ".vam-app", ".trash", ".git", "node_modules"]);

export const taiwanTime = ms => `${new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ")} 台灣時間`;

function recordDirectories(folder, found = []) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.name === "records" && folder.endsWith(`${"/"}Chats`)) found.push(path);
    else recordDirectories(path, found);
  }
  return found;
}

function parseLines(path) {
  return readFileSync(path, "utf8").split("\n").filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`line ${index + 1} is not JSON`); }
  });
}

const time = value => { const ms = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : null; };

// Returns the reasons the owner may be using the vault; an empty list means installing is allowed.
export function ownerBusyReasons(vault, { now = Date.now(), requireQuietWindow = true } = {}) {
  const reasons = [];
  const since = now - OWNER_IDLE_WINDOW_MS, running = now - OWNER_RUNNING_WINDOW_MS;
  let directories;
  try { directories = recordDirectories(vault); } catch (error) { return [`無法讀取 vault（${error.message}），判斷不出狀態`]; }
  for (const directory of directories) {
    const map = relative(vault, join(directory, "../.."));
    let files;
    try { files = readdirSync(directory).filter(name => name.endsWith(".jsonl")).sort(); } catch (error) { reasons.push(`${map}：讀不到對話紀錄資料夾（${error.message}）`); continue; }
    if (!files.length) continue;
    const newest = files[files.length - 1];
    // The newest conversation decides plan and chain state; any conversation written in the window can hold a recent turn.
    const recent = files.filter(name => { try { return name === newest || statSync(join(directory, name)).mtimeMs >= (requireQuietWindow ? since : running); } catch { return true; } });
    for (const name of recent) {
      let lines;
      try { lines = parseLines(join(directory, name)); } catch (error) { reasons.push(`${map}：對話紀錄 ${name} 格式不對（${error.message}），判斷不出狀態`); continue; }
      for (const line of lines) if (line?.type === "turn_start") {
        const at = time(line.at);
        if (at === null) reasons.push(`${map}：對話紀錄 ${name} 有一輪 turn_start 沒有可讀的時間，判斷不出狀態`);
        else if (requireQuietWindow && at >= since) reasons.push(`${map}：${taiwanTime(at)} 剛開始一輪對話（15 分鐘內）`);
      }
      if (name !== newest && requireQuietWindow) continue;
      const lastIndex = predicate => { for (let i = lines.length - 1; i >= 0; i--) if (predicate(lines[i])) return i; return -1; };
      const chainEnd = lastIndex(line => line?.type === "event" && line.kind === "chain_end");
      const turnEnd = lastIndex(line => line?.type === "turn_end");
      const lastTurnStart = lastIndex(line => line?.type === "turn_start");
      if (lastTurnStart > turnEnd && (time(lines[lastTurnStart].at) ?? now) >= running)
        reasons.push(`${map}：第 ${lines[lastTurnStart].turn} 輪（${taiwanTime(time(lines[lastTurnStart].at) ?? now)} 開始）還沒結束`);
      if (name !== newest) continue;
      if (turnEnd >= 0 && lines[turnEnd].status === "plan" && chainEnd < turnEnd && lastIndex(line => line?.type === "plan") < turnEnd)
        reasons.push(`${map}：最後一輪（第 ${lines[turnEnd].turn} 輪）有待套用的計畫，還沒套用或取消`);
      // A turn the user typed after an automatic round ends that continuation even when an older build wrote no chain_end.
      const lastStart = lastIndex(line => line?.type === "turn_start");
      const autoStart = lastStart >= 0 && lines[lastStart].auto === true ? lastStart : -1;
      if (autoStart >= 0 && chainEnd < autoStart)
        reasons.push(`${map}：自動接續還在跑（第 ${lines[autoStart].round ?? "?"} 輪開始後沒有 chain_end）`);
    }
  }
  const exchanges = join(vault, harnessConfigDir, "plugins/visual-agent-map/ai-exchanges.json");
  try {
    const list = JSON.parse(readFileSync(exchanges, "utf8"));
    if (!Array.isArray(list)) throw new Error("not a list");
    let latest = null;
    for (const entry of list) {
      const at = Math.max(...[entry?.startedAt, entry?.sentAt, entry?.completedAt].map(time).filter(value => value !== null));
      if (!Number.isFinite(at)) throw new Error("an entry has no readable time");
      if (time(entry.completedAt) === null && at >= running) reasons.push(`ai-exchanges.json：${taiwanTime(at)} 開始的 AI 呼叫還沒結束`);
      if (latest === null || at > latest) latest = at;
    }
    if (requireQuietWindow && latest !== null && latest >= since) reasons.push(`ai-exchanges.json：${taiwanTime(latest)} 有 AI 呼叫（15 分鐘內）`);
  } catch (error) {
    reasons.push(`讀不到或看不懂 ${existsSync(exchanges) ? "ai-exchanges.json" : "ai-exchanges.json（檔案不存在）"}（${error.message}），判斷不出狀態`);
  }
  return reasons;
}

// Throws with every reason when the owner may be using the vault.
export function assertOwnerIdle(vault, options) {
  const reasons = ownerBusyReasons(vault, options);
  if (reasons.length) throw new Error(`Refusing to install into the owner's vault ${vault}: the owner may be using it.\n${reasons.map(reason => `- ${reason}`).join("\n")}\nRerun with --update-current --wait-idle (run in background) to install as soon as the owner is idle, or ask the session that opened you to get the owner's 「可以裝」 and rerun with --owner-idle-confirmed.`);
}

export const WAIT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export const WAIT_IDLE_INTERVAL_MS = 60 * 1000;

// --wait-idle: re-checks until the owner is idle, then returns; after the timeout it refuses with the current reasons.
export function waitOwnerIdle(vault, { timeoutMs = WAIT_IDLE_TIMEOUT_MS, intervalMs = WAIT_IDLE_INTERVAL_MS, clock = Date.now, sleep, out = text => process.stdout.write(text) } = {}) {
  const startedAt = clock();
  let shown = "";
  for (;;) {
    const reasons = ownerBusyReasons(vault, { now: clock() });
    if (!reasons.length) return;
    if (clock() - startedAt >= timeoutMs) return assertOwnerIdle(vault, { now: clock() });
    const text = reasons.join("\n");
    if (text !== shown) out(`--wait-idle: owner may be using the vault; re-checking every ${Math.round(intervalMs / 1000)}s for up to ${Math.round(timeoutMs / 60000)} minutes.\n${reasons.map(reason => `- ${reason}`).join("\n")}\n`);
    shown = text;
    sleep(intervalMs);
  }
}
