// S7 cases: things a long conversation does to the model. History keeps only the last 6 question/answer rounds
// (MAP_CHAT_DEFAULT_TURNS), so a fact said earlier is simply not in front of the model; conflicting sources must resolve to the newest
// explicit user instruction; a continuation round must build only on what really finished.
const { C } = require("./checks.cjs");

function tree(rows) {
  const byId = new Map(rows.map(([id, title, parentId, summary = `${title} 的摘要`, extra = {}]) => [id, { id, title, summary, parentId, depth: 0, ...extra }]));
  const depth = n => (n.parentId ? depth(byId.get(n.parentId)) + 1 : 0);
  const out = [];
  const walk = parent => rows.filter(r => (r[2] ?? null) === parent).forEach(r => { const n = byId.get(r[0]); n.depth = depth(n); out.push(n); walk(r[0]); });
  walk(null);
  return out;
}
const OUTLINE = tree([["r", "英文學習", null], ["s", "口說", "r"], ["w", "寫作", "r"]]);
const GOAL_TEXT = "我在準備雅思口說考試，幫我建英文學習地圖";
/** `total` rounds of history; the goal is said in round `goalRound` (1-based). Every other round is neutral small talk. */
function rounds(total, goalRound) {
  const small = ["收合口說", "展開口說", "把畫面移到寫作", "展開寫作", "收合寫作", "選取英文學習", "重新排版"];
  const out = [];
  for (let i = 1; i <= total; i++) {
    out.push({ role: "user", text: i === goalRound ? GOAL_TEXT : small[(i - 2) % small.length] });
    out.push({ role: "assistant", text: i === goalRound ? "我會建立英文學習地圖。" : "我會處理。" });
  }
  return out;
}
const base = { mapTitle: "測試地圖", selected: [], references: [], snippets: [], files: [], history: [], language: "zh-TW" };
const mk = (id, group, title, source, covers, input, checks, review) => ({ id, group, title, source, covers, input: { ...base, ...input }, checks, ...(review ? { review } : {}) });
const mentions = re => a => Object.values(a).some(v => typeof v === "string" && re.test(v));

const HISTORY = [
  mk("S7a", "多輪", "目標在 8 輪前：已掉出視窗，不能憑空說出", "history cap: MAP_CHAT_DEFAULT_TURNS=6", ["add_child"],
    { message: "再補幾個和我考試目標有關的子議題", outline: OUTLINE, selected: [{ id: "s", title: "口說", summary: "口說的摘要", detail: "", path: "Maps/Notes/s.md" }], history: rounds(8, 1) },
    [C.noRejected(), C.rawNone(mentions(/雅思|IELTS/i), "invents the exam from outside its window"), C.rawReplyNot(/雅思|IELTS/i, "names the exam it cannot see"), C.replyNonEmpty()],
    "目標已超出對話視窗：AI 是承認看不到、問你考什麼，還是憑空補一般性內容？兩者都要看有沒有誠實"),
  mk("S7ac", "多輪", "對照：目標在視窗內（第 3 輪）", "control of S7a", ["add_child"],
    { message: "再補幾個和我考試目標有關的子議題", outline: OUTLINE, selected: [{ id: "s", title: "口說", summary: "口說的摘要", detail: "", path: "Maps/Notes/s.md" }], history: rounds(8, 3) },
    [C.noRejected(), C.hasKind("add_child", 2), C.anyTextMatches(/雅思|IELTS|Part\s?[123]|口說評分/i, "uses the stated exam goal")]),
  mk("S7b", "多輪", "最新更正壓過舊歷史與檔案", "newest explicit user instruction wins", ["add_child"],
    { message: "不對，改成 JavaScript，建三個分支", outline: tree([["r", "程式學習", null]]), history: [{ role: "user", text: "做一個 Python 學習路線" }, { role: "assistant", text: "我會建立 Python 學習路線。" }], files: [{ path: "Notes/主題.md", content: "# 主題\n這張地圖的主題是 Python。\n" }] },
    [C.noRejected(), C.hasKind("add_child", 3), C.rawNone(a => a.kind === "add_child" && /python/i.test(a.title), "creates a card titled Python after the correction"), C.anyTitleMatches(/javascript|js/i, "a JavaScript title")]),
  mk("S7c", "多輪", "使用者指定的名稱壓過研究全文的建議", "user instruction vs research text", ["add_child"],
    { message: "把研究列出的三類建成子議題，名稱我要用：甲類、乙類、丙類", outline: tree([["r", "分類", null]]), researchNotes: [{ id: "r", title: "分類", path: "Maps/Notes/r.md", detail: "建議把三類命名為：Alpha、Beta、Gamma。" }] },
    [C.noRejected(), C.titlesCover(["甲類", "乙類", "丙類"]), C.noTitleMatches(/alpha|beta|gamma/i, "the research text's own names")]),
  mk("S7d", "接續", "第 2 輪：只對真的完成的研究建子議題", "continuation: failed research was not done", ["add_child"],
    { message: "幫我做完整的茶知識樹", outline: tree([["r", "茶", null], ["g", "綠茶", "r"], ["w", "白茶", "r"]]),
      researchNotes: [{ id: "g", title: "綠茶", path: "Maps/Notes/g.md", detail: "綠茶：龍井、碧螺春、煎茶。" }],
      continuation: { round: 2, maxRounds: 8, remaining: "依研究結果補上子議題", lastResults: [{ text: "研究「綠茶」完成", status: "done" }, { text: "研究「白茶」失敗", status: "failed" }], research: [{ id: "g", title: "綠茶", status: "succeeded" }, { id: "w", title: "白茶", status: "failed", error: "timeout" }] } },
    [C.noRejected(), C.hasKind("add_child", 3), C.titlesCover(["龍井", "碧螺春", "煎茶"]), C.rawNone(a => a.kind === "add_child" && a.parentId === "w", "builds children under the card whose research failed"), C.rawReplyNot(/白茶.{0,6}(已|完成|研究過)/, "says the failed 白茶 research is done")])
];
module.exports = { HISTORY };
