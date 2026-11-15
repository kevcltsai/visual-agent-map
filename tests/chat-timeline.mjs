import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, promptParts } from '../scripts/chat-timeline.mjs';

// A minimal, made-up vault: one map with one conversation, and two task.run prompts that differ in tone and image rule.
function fixture(t) {
  const vault = mkdtempSync(join(tmpdir(), 'vam-chat-timeline-'));
  t.after(() => rmSync(vault, { recursive: true, force: true }));
  const records = join(vault, 'Agent Workspace/Mind Maps/示範地圖/Chats/records'); mkdirSync(records, { recursive: true });
  const raw = JSON.stringify({ reply: 'ok', actions: [{ kind: 'add_child', title: '第一章' }, { kind: 'edit_md_file', path: 'Agent Workspace/Mind Maps/示範地圖/Notes/很長很長的一個筆記檔名稱.md' }, { kind: 'research', nodeIds: ['a', 'b'], rewrite: true }] });
  const lines = [
    { v: 1, type: 'conversation', id: 'c1', startedAt: '2026-11-15T01:00:00.000Z', pluginVersion: '0.34.0' },
    { v: 1, type: 'turn_start', turn: 1, message: '把這張地圖做成一本書'.repeat(10), at: '2026-11-15T01:00:00.000Z' },
    { v: 1, type: 'turn_end', turn: 1, status: 'plan', reply: '我會先加三章', raw, at: '2026-11-15T01:00:30.000Z' },
    { v: 1, type: 'plan', turn: 1, state: 'applied', at: '2026-11-15T01:01:00.000Z' },
    { v: 1, type: 'event', turn: 1, kind: 'research_batch', topics: [{ id: 'a', title: '甲' }, { id: 'b', title: '乙' }], at: '2026-11-15T01:01:00.000Z' },
    { v: 1, type: 'event', turn: 1, kind: 'research_batch_topic', id: 'a', status: 'succeeded', at: '2026-11-15T01:02:00.000Z' },
    { v: 1, type: 'event', turn: 1, kind: 'research_batch_topic', id: 'b', status: 'failed', at: '2026-11-15T01:02:00.000Z' },
    { v: 1, type: 'event', turn: 1, kind: 'research_batch_end', at: '2026-11-15T01:03:00.000Z' },
    { v: 1, type: 'turn_start', turn: 2, auto: true, round: 2, message: '把這張地圖做成一本書', remaining: '寫第二章', at: '2026-11-15T01:04:00.000Z' },
    { v: 1, type: 'turn_end', turn: 2, status: 'done', reply: '完成', raw: '{"reply":"完成","actions":[]}', at: '2026-11-15T01:05:00.000Z' },
    { v: 1, type: 'event', turn: 2, kind: 'chain_end', reason: 'max_rounds', round: 2, remaining: '還有第三章', at: '2026-11-15T01:05:00.000Z' }
  ];
  writeFileSync(join(records, '20261115-010000-c1.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const prompt = (tone, visual) => ['開頭', 'detail 只用三級標題（###）分段。', '', `寫作語氣：${tone}`, '- 一個例子一段', '', visual, '', '目前議題:', '甲', '', '目前議題的 AI 規則（優先遵守）:', '（無）', '', '目前任務:', '研究「甲」', '', '查證年份'].join('\n');
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map'); mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'ai-exchanges.json'), JSON.stringify([
    { id: 'aaaa1111', step: 'task.run@1', startedAt: '2026-11-15T01:01:10.000Z', topic: '甲', model: 'claude:haiku', prompt: prompt('圖文書。', '不要搜尋新圖片；visualReferences 回傳空陣列。') },
    { id: 'bbbb2222', step: 'map-chat@24', startedAt: '2026-11-15T01:01:20.000Z', prompt: 'not a research prompt' },
    { id: 'cccc3333', step: 'task.run@1', startedAt: '2026-11-15T01:30:00.000Z', topic: '甲', model: 'claude:haiku', prompt: prompt('專業。', '請尋找 1–6 個能幫助理解議題的圖片參考；必須提供真實圖片 URL 與來源頁 URL，找不到可靠圖片時回傳空陣列。') }
  ]));
  return vault;
}
const snapshot = vault => { const out = []; const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); out.push(`${path}:${statSync(path).mtimeMs}`); if (entry.isDirectory()) walk(path); } }; walk(vault); return out.sort().join('\n'); };

test('chat-timeline lists turns in Taiwan time with USER/AUTO, actions, plan, batch and chain_end, and writes nothing', t => {
  const vault = fixture(t); const before = snapshot(vault);
  const text = run([vault, '示範']).join('\n');
  assert.equal(snapshot(vault), before);
  assert.match(text, /== 對話 c1（11-15 09:00:00 開始/);
  assert.match(text, /11-15 09:00:00 {2}USER（turn 1）：(把這張地圖做成一本書){8}…/);
  assert.match(text, /→ 計畫待確認：我會先加三章/);
  assert.match(text, /· add_child 「第一章」/);
  assert.match(text, /· edit_md_file 「…/);
  assert.match(text, /· research 「2 個議題」 \(rewrite\)/);
  assert.match(text, /計畫 已套用（turn 1）/);
  assert.match(text, /研究批次開始：2 個議題（甲、乙）/);
  assert.match(text, /研究批次結束：succeeded 1、failed 1/);
  assert.match(text, /AUTO 第 2 輪（turn 2）：寫第二章/);
  assert.match(text, /chain_end max_rounds（第 2 輪） remaining：還有第三章/);
  assert.throws(() => run([vault, '沒有這張']), /找不到有對話紀錄的地圖/);
});

test('chat-timeline --prompt picks a task.run by id or nearest time; --diff shows what changed', t => {
  const vault = fixture(t); const before = snapshot(vault);
  const byId = run([vault, '示範地圖', '--prompt', 'aaaa']).join('\n');
  assert.match(byId, /task\.run aaaa1111（11-15 09:01:10 台灣時間/);
  assert.match(byId, /--- 三級標題規則\ndetail 只用三級標題（###）分段。/);
  assert.match(byId, /--- 圖片規則（visual）\n不要搜尋新圖片/);
  assert.match(byId, /--- 目前議題\n甲\n/);
  assert.match(byId, /--- 目前任務\n研究「甲」\n\n查證年份/);
  assert.match(byId, /--- 寫作語氣\n寫作語氣：圖文書。\n- 一個例子一段/);
  // The nearest task.run, never the map-chat call in between.
  assert.match(run([vault, '示範地圖', '--prompt', '2026-11-15T01:01:21Z']).join('\n'), /task\.run aaaa1111/);
  const diff = run([vault, '示範地圖', '--diff', 'aaaa', 'cccc']).join('\n');
  assert.match(diff, /--- 三級標題規則：相同/);
  assert.match(diff, /--- 圖片規則（visual）：不同\n- 不要搜尋新圖片[^\n]*\n\+ 請尋找 1–6 個/);
  assert.match(diff, /--- 寫作語氣：不同\n- 寫作語氣：圖文書。\n\+ 寫作語氣：專業。/);
  assert.match(diff, /--- 目前任務：相同/);
  assert.equal(snapshot(vault), before);
  assert.throws(() => run([vault, '示範地圖', '--prompt', 'zzzz']), /找不到 id 或時間/);
});

test('promptParts reads the English labels too', () => {
  const parts = promptParts(['Tone: plain.', '- short', '', 'Current topic:', 'A', '', 'Current task:', 'Research A'].join('\n'));
  assert.equal(parts['目前議題'], 'A');
  assert.equal(parts['目前任務'], 'Research A');
  assert.equal(parts['寫作語氣'], 'Tone: plain.\n- short');
});
