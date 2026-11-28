// P1.12 performance baseline: measures interaction latency of the mind-map view in a harness-launched test Obsidian over CDP.
//   node scripts/perf-baseline.mjs --session=<name> | --vault=<path>  [--samples=30] [--batches=10] [--cards=40] [--ai] [--out=<file.json>]
//   --ai marks every fixture card an AI card (ai-card: true), so selection exercises the dependency highlight.
// The vault must be harness-owned (made by `node scripts/test-harness.mjs --session=<name>`, already running and trusted).
// For numbers to compare (P1.12 stage B against the stage A baseline), use a fresh session vault per run: fixture maps from
// earlier runs stay in the vault and raise heap and batch times.
// Every run seeds fresh synthetic 40-card maps under "Agent Workspace/Topics/Perf Fixture <stamp>*" (never overwrites a file),
// then measures, per sample, the time from the input event (CDP trusted mouse input, or the in-page call) to the animation frame
// that paints the last DOM change it caused (a frame loop that ends after two frames with no mutation under the view):
//   pan (background drag, per move), zoom (wheel, per notch), select (click a card), drag (card drag, per move),
//   expand (Space on the focused branch card, fold/unfold alternating), summary (update_summary through applyMapChatActions, no provider),
//   search (one keystroke in the in-map search box, matching titles, summaries and Details; query typed letter by letter),
//   batch (10 add_child through applyMapChatActions on a fresh 40-card map, no provider).
// Also reports performance.memory.usedJSHeapSize before/after and the total long-task time (PerformanceObserver "longtask")
// while measuring. Nothing focuses or raises the window (focus emulation only; see obsidian-cdp.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, arch, release, tmpdir, totalmem, type } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connectCdp } from "./obsidian-cdp.mjs";
import { canonicalVault, sessionVault } from "./test-harness.mjs";

const marker = ".vam-test-environment.json";
export const PERF_CARD_COUNT = 40;
const root = fileURLToPath(new URL("..", import.meta.url));

// Default (40): root + 5 branches + 34 leaves (7,7,7,7,6), laid out left to right, no overlap.
// Other sizes (e.g. 300): root + ceil((n-1)/20) branches, the remaining cards spread over them as leaves.
export function perfFixtureCards(count = PERF_CARD_COUNT) {
  const cards = [{ id: "perf-root", title: "Perf Root", parent: null, x: 0, y: 0 }];
  let leaves = [7, 7, 7, 7, 6];
  let rowGap = 680;
  if (count !== PERF_CARD_COUNT) {
    const branches = Math.max(1, Math.ceil((count - 1) / 20));
    const total = count - 1 - branches;
    if (total < 0) throw new Error(`--cards=${count} is too small for a tree.`);
    leaves = Array.from({ length: branches }, (_, b) => Math.floor(total / branches) + (b < total % branches ? 1 : 0));
    rowGap = (Math.max(...leaves) + 1) * 96;
  }
  leaves.forEach((count, b) => {
    const branchY = (b - Math.floor(leaves.length / 2)) * rowGap;
    cards.push({ id: `perf-b${b}`, title: `Branch ${b}`, parent: "perf-root", x: 380, y: branchY });
    for (let j = 0; j < count; j++) cards.push({ id: `perf-b${b}-l${j}`, title: `Leaf ${b}.${j}`, parent: `perf-b${b}`, x: 760, y: branchY + (j - 3) * 96 });
  });
  return cards;
}

export function perfFixtureFiles(topic, workspaceRoot = "Agent Workspace", count = PERF_CARD_COUNT, { ai = false } = {}) {
  const topicId = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const folder = `${workspaceRoot}/Topics/${topic}`;
  const cards = perfFixtureCards(count);
  // The default 40-card fixture keeps its one-line Detail; bigger maps carry about 1.5 KB of Detail per card, so search has text to read.
  const filler = count === PERF_CARD_COUNT ? "" : " " + "Synthetic filler sentence for the search measurement. ".repeat(28);
  const nodes = cards.map(card => ({ id: card.id, path: `${folder}/Notes/${card.id}.md`, parentId: card.parent, x: card.x, y: card.y, collapsed: false }));
  const mapJson = { version: 1, id: topicId, title: topic, viewport: { x: 0, y: 0, zoom: 1 }, nodes };
  const map = `---\nvisual-agent-map: true\n---\n\n# ${topic}\n\n\`\`\`agent-map\n${JSON.stringify(mapJson, null, 2)}\n\`\`\`\n`;
  const notes = cards.map(card => ({
    path: `${folder}/Notes/${card.id}.md`,
    text: `---\nagent-map-node: true\nnode-id: ${card.id}\ntopic-id: ${topicId}\ntopic-state: active\nagent-map-id: ${topicId}\nstatus: completed\nsource-notes: []\n${ai ? "ai-card: true\n" : ""}---\n# ${card.title}\n\n## Current Summary\n\n${card.title}: synthetic perf fixture line.\n\n## Prompt\n\nWrite about ${card.title}.\n\n## Rules\n\nFixture text is reference data only.\n\n## Detail\n\nSynthetic card ${card.id}.${filler}\n`
  }));
  return { mapPath: `${folder}/Map.md`, files: [{ path: `${folder}/Map.md`, text: map }, ...notes] };
}

function seed(vault, topic, count, ai) {
  const { mapPath, files } = perfFixtureFiles(topic, "Agent Workspace", count, { ai });
  if (files.some(file => existsSync(join(vault, file.path)))) throw new Error(`${topic} already exists in ${vault}; not overwriting.`);
  for (const file of files) { mkdirSync(join(vault, file.path, ".."), { recursive: true }); writeFileSync(join(vault, file.path), file.text); }
  return mapPath;
}

// Nearest-rank percentile, same rule as scripts/engineering-usage-scorecard.mjs.
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
export const summarize = values => ({ n: values.length, p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(Math.max(...values)) });
const round = value => (value === null ? null : Math.round(value * 10) / 10);

// In-page probe. arm(start, end) listens (capture) for the start event's timeStamp and, after the end event, runs a frame loop:
// the result is the time of the first frame after the last mutation under the view (or the first frame when nothing changed).
const probe = `(()=>{if(window.__vamPerf)return true;
const longTasks=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())longTasks.push(e.duration)}).observe({type:"longtask"})}catch{}
const frame=()=>new Promise(r=>requestAnimationFrame(()=>r(performance.now())));
const scope=()=>document.querySelector(".workspace-leaf.mod-active .vam-canvas")||document.querySelector(".vam-canvas")||document.body;
const watch=()=>{const s={dirty:false};s.mo=new MutationObserver(()=>{s.dirty=true});s.mo.observe(scope(),{subtree:true,childList:true,attributes:true,characterData:true});return s};
async function settle(s,limit=5000){const start=performance.now();let end=await frame(),clean=s.dirty?0:1;s.dirty=false;
while(clean<2&&performance.now()-start<limit){const t=await frame();if(s.dirty){end=t;s.dirty=false;clean=0}else clean++}s.mo.disconnect();return end}
let pending=null;
window.__vamPerf={longTasks,
arm(startType,endType=startType){const s=watch();let t0=null;pending=new Promise((done,fail)=>{const timer=setTimeout(()=>{cleanup();fail(new Error("no "+endType+" event"))},10000);
const onStart=e=>{if(t0===null)t0=e.timeStamp};const onEnd=async e=>{if(t0===null)t0=e.timeStamp;cleanup();done((await settle(s))-t0)};
const cleanup=()=>{clearTimeout(timer);window.removeEventListener(startType,onStart,true);window.removeEventListener(endType,onEnd,true)};
window.addEventListener(startType,onStart,true);window.addEventListener(endType,onEnd,true)});return true},
result(){const p=pending;pending=null;return p},
async call(fn){const s=watch();const t0=performance.now();const value=await fn();return {ms:(await settle(s))-t0,value}}};return true})()`;

const view = `app.workspace.getLeavesOfType("visual-agent-map-view").map(l=>l.view).find(v=>v.containerEl.isShown())`;

async function open(cdp, mapPath, expected = PERF_CARD_COUNT) {
  // Opens the map, then closes every other map tab, so only one view is alive while measuring.
  await cdp.evaluate(`(async()=>{const old=app.workspace.getLeavesOfType("visual-agent-map-view");const v=await app.plugins.plugins["visual-agent-map"].openMapInNewTab(${JSON.stringify(mapPath)});for(const l of old)if(l.view!==v)l.detach();return !!v})()`);
  for (let i = 0; i < 120; i++) {
    const count = await cdp.evaluate(`(()=>{const v=${view};return v&&v.map?v.containerEl.querySelectorAll(".vam-node").length:0})()`);
    if (count >= expected) {
      // Same canvas every run: no side panels, map chat closed, "show all" (last zoom control) so every card is on screen.
      await cdp.evaluate(`(async()=>{app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();const v=${view};v.containerEl.querySelector(".vam-map-chat-close")?.click();
await new Promise(r=>setTimeout(r,300));[...v.containerEl.querySelectorAll(".vam-zoom-controls button")].pop()?.click();await new Promise(r=>setTimeout(r,500));return true})()`);
      await delay(1000); // let the open settle before anything is timed
      return count;
    }
    await delay(250);
  }
  throw new Error(`Map ${mapPath} did not render ${expected} cards.`);
}

// Big maps: "show all" shrinks cards to a few pixels or leaves them off screen, so clicks miss. Bring the card into view first
// (zoom back to 100% when its on-screen width is tiny, then centre the camera on it), judged by its real DOM rect.
async function reveal(cdp, id) {
  const probeExpr = `(()=>{const v=${view};const vr=v.containerEl.querySelector(".vam-viewport").getBoundingClientRect();const n=v.containerEl.querySelector('.vam-node[data-node-id="${id}"]');if(!n)return {ok:false,tiny:false};
const r=n.getBoundingClientRect();return {ok:r.left>=vr.left+10&&r.right<=vr.right-10&&r.top>=vr.top+10&&r.bottom<=vr.bottom-10,tiny:r.width<60}})()`;
  const state = await cdp.evaluate(probeExpr);
  if (state.ok && !state.tiny) return;
  if (state.tiny) { await cdp.evaluate(`(()=>{${view}.containerEl.querySelector(".vam-zoom-controls .vam-zoom")?.click()})()`); await delay(400); }
  await cdp.evaluate(`(()=>{const v=${view};const n=v.map.nodes.find(x=>x.id==="${id}");if(n)v.focusNode(n,false)})()`);
  await delay(600);
  if (!(await cdp.evaluate(probeExpr)).ok) throw new Error(`Card ${id} could not be brought on screen.`);
}

// Points are viewport CSS pixels (what Input.dispatchMouseEvent takes).
const emptyPointExpr = `(()=>{const v=${view};const r=v.containerEl.querySelector(".vam-viewport").getBoundingClientRect();
for(let y=r.top+r.height*0.85;y>r.top+20;y-=17)for(let x=r.left+40;x<r.right-40;x+=23){const el=document.elementFromPoint(x,y);
if(el&&v.containerEl.querySelector(".vam-viewport").contains(el)&&!el.closest(".vam-node,button,input,textarea,.vam-zoom-controls,.vam-node-tools,[contenteditable]"))return {x,y}}return null})()`;
// A card point that starts a drag/select: inside the card, not on a button, input or editable title.
const cardPointsExpr = `(()=>{const v=${view};const vr=v.containerEl.querySelector(".vam-viewport").getBoundingClientRect();const out=[];
for(const n of v.containerEl.querySelectorAll(".vam-node")){const r=n.getBoundingClientRect();if(r.left<vr.left+10||r.right>vr.right-10||r.top<vr.top+10||r.bottom>vr.bottom-10)continue;
for(const [fx,fy] of [[0.06,0.5],[0.5,0.12],[0.94,0.5],[0.5,0.9]]){const x=r.left+r.width*fx,y=r.top+r.height*fy;const el=document.elementFromPoint(x,y);
if(el&&el.closest(".vam-node")===n&&!el.closest("button,input,textarea,[contenteditable],.vam-collapse-button")){out.push({id:n.dataset.id||n.dataset.nodeId||null,x,y});break}}}return out})()`;

async function mouse(cdp, type, x, y, buttons = 0) {
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
}
async function measureInput(cdp, start, end, act) {
  await cdp.evaluate(`__vamPerf.arm(${JSON.stringify(start)},${JSON.stringify(end)})`);
  await act();
  return cdp.evaluate("__vamPerf.result()");
}

async function measureMap(cdp, samples, ai) {
  const out = { pan: [], zoom: [], select: [], drag: [], expand: [], summary: [], search: [] };
  // Pan: one background drag per 10 samples, alternating direction.
  for (let done = 0, dir = 1; done < samples; dir = -dir) {
    const p = await cdp.evaluate(emptyPointExpr);
    if (!p) throw new Error("No empty background point to pan from.");
    await mouse(cdp, "mousePressed", p.x, p.y, 1);
    let x = p.x;
    for (let i = 0; i < 12 && done < samples; i++) {
      x += 6 * dir;
      const ms = await measureInput(cdp, "pointermove", "pointermove", () => mouse(cdp, "mouseMoved", x, p.y, 1));
      if (i >= 2) { out.pan.push(ms); done++; } // the first moves only cross the 3px pan threshold
    }
    await mouse(cdp, "mouseReleased", x, p.y, 1);
  }
  // Zoom: alternating wheel notches at the viewport centre.
  const centre = await cdp.evaluate(`(()=>{const r=${view}.containerEl.querySelector(".vam-viewport").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  for (let i = 0; i < samples; i++)
    out.zoom.push(await measureInput(cdp, "wheel", "wheel", () => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre.x, y: centre.y, deltaX: 0, deltaY: i % 2 ? 100 : -100 })));
  // Select: click visible cards in turn.
  if ((await cdp.evaluate(cardPointsExpr)).length < 3) await reveal(cdp, "perf-b1");
  const points = await cdp.evaluate(cardPointsExpr);
  if (points.length < 3) throw new Error(`Only ${points.length} cards are visible to click.`);
  for (let i = 0; i < samples; i++) {
    const p = points[i % points.length];
    out.select.push(await measureInput(cdp, "pointerdown", "click", async () => { await mouse(cdp, "mousePressed", p.x, p.y, 1); await mouse(cdp, "mouseReleased", p.x, p.y); }));
  }
  const selected = await cdp.evaluate(`${view}.containerEl.querySelectorAll(".vam-node.is-selected").length`);
  if (selected < 1) throw new Error("Clicking cards selected none.");
  // Drag: drag a card back and forth, 10 moves per drag.
  for (let done = 0, dir = 1; done < samples; dir = -dir) {
    const p = (await cdp.evaluate(cardPointsExpr))[0];
    await mouse(cdp, "mousePressed", p.x, p.y, 1);
    let x = p.x;
    for (let i = 0; i < 12 && done < samples; i++) {
      x += 5 * dir;
      const ms = await measureInput(cdp, "pointermove", "pointermove", () => mouse(cdp, "mouseMoved", x, p.y, 1));
      if (i >= 2) { out.drag.push(ms); done++; }
    }
    await mouse(cdp, "mouseReleased", x, p.y);
  }
  // Expand: fold and unfold one branch with Space on the focused branch card (keydown arms, keyup toggles), alternating.
  await reveal(cdp, "perf-b1");
  const branch = await cdp.evaluate(`(()=>{const n=${view}.containerEl.querySelector('.vam-node[data-node-id="perf-b1"]');if(!n)return null;const r=n.getBoundingClientRect();return {x:r.left+r.width*0.06,y:r.top+r.height/2}})()`);
  if (!branch) throw new Error("Branch card perf-b1 is not on screen.");
  await mouse(cdp, "mousePressed", branch.x, branch.y, 1);
  await mouse(cdp, "mouseReleased", branch.x, branch.y);
  // Space folds only when the card itself has focus (not a button inside it).
  const branchCard = `${view}.containerEl.querySelector('.vam-node[data-node-id="perf-b1"]')`;
  if (!(await cdp.evaluate(`document.activeElement===${branchCard}`))) await cdp.evaluate(`${branchCard}?.focus()`);
  const folded = `${view}.map.nodes.find(n=>n.id==="perf-b1").collapsed===true`;
  for (let i = 0; i < samples; i++) {
    const before = await cdp.evaluate(folded);
    out.expand.push(await measureInput(cdp, "keydown", "keyup", () => cdp.press("Space")));
    // The fold is queued and may land after the measured frames on a busy machine: poll for it (20 ms, up to about 2 s).
    let flipped = false;
    for (let wait = 0; wait < 100 && !flipped; wait++) {
      flipped = (await cdp.evaluate(folded)) !== before;
      if (!flipped) await delay(20);
    }
    if (!flipped) throw new Error("Space on the branch card did not fold or unfold it.");
  }
  // Summary: update_summary through the map-chat apply path with a fixture action (no provider). Not with --ai: an AI card's
  // summary is written only by running the card, so the apply path skips it.
  for (let i = 0; i < (ai ? 0 : samples); i++) {
    const id = `perf-b${i % 5}-l${(i >> 1) % 6}`;
    const r = await cdp.evaluate(`(async()=>{const v=${view};const now=await v.chatWriter.chatTopicNow(${JSON.stringify(id)});
return __vamPerf.call(()=>v.applyMapChatActions({actions:[{kind:"update_summary",nodeId:${JSON.stringify(id)},summary:"Perf summary ${i}"}],rejected:[]},{mdHashes:{},topicHashes:{[${JSON.stringify(id)}]:{title:now.title,parentId:now.parentId}},mapSourcePaths:[]}))})()`);
    const status = r.value?.[0]?.outcome?.status ?? r.value?.[0]?.status;
    if (status !== "done") throw new Error(`update_summary did not apply: ${JSON.stringify(r.value).slice(0, 300)}`);
    out.summary.push(r.ms);
  }
  // Search: open the in-map search box and type a query letter by letter (Detail text, so every key folds and scans the bodies).
  const query = "synthetic card perf-b1-l2";
  await cdp.evaluate(`(()=>{const v=${view};v.openMapSearch(null);return !!v.mapSearchBar})()`);
  for (let i = 0; i < samples; i++) {
    const text = query.slice(0, (i % query.length) + 1);
    out.search.push(await measureInput(cdp, "input", "input", () => cdp.evaluate(`(()=>{const input=${view}.mapSearchBar.input;input.value=${JSON.stringify(text)};input.dispatchEvent(new Event("input",{bubbles:true}));return true})()`)));
  }
  await cdp.evaluate(`${view}.closeMapSearch(false)`);
  return out;
}

async function measureBatch(cdp, mapPath, cards) {
  await open(cdp, mapPath, cards);
  await cdp.evaluate(probe);
  const actions = Array.from({ length: 10 }, (_, i) => ({ kind: "add_child", parentId: "perf-b0", title: `Batch card ${i}`, summary: `Synthetic batch card ${i}.` }));
  const r = await cdp.evaluate(`(()=>{const v=${view};return __vamPerf.call(()=>v.applyMapChatActions({actions:${JSON.stringify(actions)},rejected:[]},{mdHashes:{},topicHashes:{},mapSourcePaths:[]}))})()`);
  const count = await cdp.evaluate(`${view}.map.nodes.length`);
  if (count !== cards + 10) throw new Error(`Batch add left ${count} cards, expected ${cards + 10}: ${JSON.stringify(r.value).slice(0, 300)}`);
  return r.ms;
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export async function runPerfBaseline({ vault, samples = 30, batches = 10, cards: cardCount = PERF_CARD_COUNT, ai = false }) {
  if (resolve(vault) === resolve(canonicalVault)) throw new Error(`Refusing ${vault}: it is the owner's testing vault.`);
  if (!existsSync(join(vault, marker))) throw new Error(`${vault} is not a harness-owned test vault (no ${marker}).`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const main = seed(vault, `Perf Fixture ${stamp}`, cardCount, ai);
  const batchMaps = Array.from({ length: batches }, (_, i) => seed(vault, `Perf Fixture ${stamp} B${i}`, cardCount, ai));
  const cdp = await connectCdp(vault);
  try {
    await cdp.evaluate(`app.vault.adapter.list("Agent Workspace/Topics")`); // let the vault index the new files
    const installed = join(vault, await cdp.evaluate("app.vault.configDir"), "plugins", "visual-agent-map", "main.js");
    await delay(1500);
    const cards = await open(cdp, main, cardCount);
    await cdp.evaluate(probe);
    const heapBefore = await cdp.evaluate("performance.memory.usedJSHeapSize");
    const longBefore = await cdp.evaluate("__vamPerf.longTasks.length");
    const interactions = await measureMap(cdp, samples, ai);
    const batch = [];
    for (const mapPath of batchMaps) batch.push(await measureBatch(cdp, mapPath, cardCount));
    const heapAfter = await cdp.evaluate("performance.memory.usedJSHeapSize");
    const longTasks = await cdp.evaluate(`__vamPerf.longTasks.slice(${longBefore})`);
    const env = await cdp.evaluate(`({obsidian:navigator.userAgent.split("obsidian/")[1]?.split(" ")[0]??null,plugin:app.plugins.manifests["visual-agent-map"]?.version,window:{w:innerWidth,h:innerHeight,dpr:devicePixelRatio},ua:navigator.userAgent})`);
    const errors = cdp.errors();
    return {
      measuredAt: new Date().toISOString(),
      candidate: { head: git("rev-parse", "HEAD"), dirty: git("status", "--short") !== "", installedMainJsSha256: existsSync(installed) ? createHash("sha256").update(readFileSync(installed)).digest("hex") : null },
      host: { os: `${type()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length, memGB: Math.round(totalmem() / 2 ** 30), ...env },
      fixture: { cards, batchMaps: batches, samples },
      results: { ...Object.fromEntries(Object.entries(interactions).filter(([, v]) => v.length).map(([k, v]) => [k, summarize(v)])), batch: summarize(batch), batchFirstMs: round(batch[0] ?? null) }, // the first batch of a session is the cold one
      heap: { beforeMB: Math.round(heapBefore / 2 ** 20 * 10) / 10, afterMB: Math.round(heapAfter / 2 ** 20 * 10) / 10 },
      longTasks: { count: longTasks.length, totalMs: round(longTasks.reduce((a, b) => a + b, 0)) },
      uncaughtErrors: errors,
      raw: { ...interactions, batch }
    };
  } finally { cdp.close(); }
}

export const usage = "Usage: node scripts/perf-baseline.mjs --session=<name> | --vault=<path>  [--samples=30] [--batches=10] [--cards=40] [--ai] [--out=<file.json>]";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const vault = option("vault") ?? (option("session") ? sessionVault(option("session")) : null);
  if (!vault || args.includes("--help")) { process.stdout.write(`${usage}\n`); process.exitCode = vault ? 0 : 2; }
  else {
    try {
      const report = await runPerfBaseline({ vault, samples: Number(option("samples") ?? 30), batches: Number(option("batches") ?? 10), cards: Number(option("cards") ?? PERF_CARD_COUNT), ai: args.includes("--ai") });
      const out = resolve(option("out") ?? join(tmpdir(), `vam-perf-${Date.now()}.json`));
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      const { raw, ...short } = report;
      process.stdout.write(`${JSON.stringify(short, null, 2)}\nFull report: ${out}\n`);
    } catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; }
  }
}
