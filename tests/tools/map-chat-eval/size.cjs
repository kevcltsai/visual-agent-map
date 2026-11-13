// Size cases for map chat (group "大小"): Chinese inputs large enough to reach every budget of core/map-chat-context.ts, each with a
// small control that asks the same thing. Synthetic text only. A large case states what must hold when part of the input is left
// out or cut: the reply never presents text it did not get as read, and it still does what the part it did get allows.
// The text is generated, not random: the same case always builds the same input (the case hash depends on it).
//
//   SZ1  outline of 500 cards, summaries of 240 characters
//   SZ2  five selected cards whose notes add up to more than MAP_CHAT_DETAIL_BUDGET (the last one goes as detailOmitted)
//   SZ3  research notes over MAP_CHAT_RESEARCH_BUDGET (the oldest one waits in researchDeferred)
//   SZ4  twelve question/answer rounds of long text
//   SZ5  an open note of about 200,000 characters: a fact at its start
//   SZ6  the same note: a fact at its very end
// Each control has the same id plus "c" and fits every budget.
const { C: SHARED } = require("./checks.cjs");

/** Words that say a text was not read, not sent or not in front of the model (Chinese and English). */
const NOT_READ = /沒(?:有)?(?:讀|看|收到|拿到|提供|附上|送)|未(?:讀|看|收到|送|提供|附|包含|納入)|無法(?:讀|看|取得|確認|得知)|看不到|讀不到|不在(?:這次|本次|這一輪|目前)|省略|被截|截斷|太長|下一輪|稍後|之後再|not (?:read|sent|included|available|visible)|omitted|truncated|cut off|can(?:not|'t) see/i;
const ok = () => ({ ok: true });
const fail = note => ({ ok: false, note });
/** The shared checks plus the two this group needs; kept here so the size cases touch no shared eval file. */
const C = {
  ...SHARED,
  /** The reply says some text was not read (for a case where part of the input was left out). */
  replySaysNotRead: desc => ({ id: `replySaysNotRead:${desc}`, desc: `reply says ${desc} was not read`, run: env => (NOT_READ.test(env.reply) ? ok() : fail(`reply: ${env.reply.slice(0, 80)}`)) }),
  /** Either the reply states the fact (it read the text that holds it) or it says the text was not read: never an answer without either. */
  replyFactOrNotRead: (fact, desc) => ({ id: `replyFactOrNotRead:${desc}`, desc: `reply states ${desc} or says that part was not read`, run: env => (fact.test(env.reply) || NOT_READ.test(env.reply) ? ok() : fail(`reply: ${env.reply.slice(0, 80)}`)) })
};

/** Plain Chinese sentences of the kind a work note holds; combined in a fixed order with numbers so no two paragraphs are equal. */
const SENTENCES = [
  "這一段整理本季的進度與遇到的問題",
  "團隊在會議中討論了交付時程與人力配置",
  "供應商回覆的報價比上一季高出一些，需要再議價",
  "測試環境在週三發生兩次中斷，原因是設定檔沒有同步",
  "客戶希望報表能依地區與月份拆開檢視",
  "目前的流程需要三個人工步驟，容易出錯",
  "下一步是把資料來源整合到同一個資料庫",
  "風險在於上線時間與年底旺季重疊",
  "預算的使用率目前大約在七成左右",
  "教育訓練的教材需要依照新版介面更新",
  "倉庫的庫存盤點結果與系統數字有落差",
  "使用者訪談顯示搜尋功能是最常被抱怨的地方",
  "法務提醒合約中的保密條款需要重新確認",
  "行銷活動的轉換率比預期低，需要檢討投放的對象",
  "維運團隊建議把監控警報的門檻調整得更敏感",
  "財務部門要求每個月底提供一次成本明細",
  "新進人員的到職流程還沒有書面化",
  "資料備份每天凌晨執行一次，保留三十天",
  "跨部門溝通主要透過週會與共用文件進行",
  "這個問題暫時用手動方式處理，長期要改成自動化"
];
const DIGITS = "〇一二三四五六七八九";
const zhNumber = n => String(n).split("").map(d => DIGITS[Number(d)]).join("");

/** About `chars` characters of Chinese prose, deterministic in `seed`; paragraphs of five sentences. */
function zhText(chars, seed = 1) {
  const out = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const sentence = `第${zhNumber(seed)}之${zhNumber(i + 1)}項，${SENTENCES[(i * 7 + seed * 3) % SENTENCES.length]}。`;
    out.push(sentence);
    length += sentence.length;
    if (i % 5 === 4) {
      out.push("\n\n");
      length += 2;
    }
  }
  return out.join("").slice(0, chars);
}

const base = { mapTitle: "大型專案筆記", selected: [], references: [], snippets: [], files: [], history: [], language: "zh-TW" };
const sz = (id, title, source, covers, input, checks, review) => ({ id, group: "大小", title, source, covers, input: { ...base, ...input }, checks, ...(review ? { review } : {}) });
const node = (id, title, parentId, depth, summary) => ({ id, title, summary, parentId, depth });

// ---- SZ1: outline size ----
const TARGET = { id: "t-target", title: "冷鏈物流的溫度紀錄" };
/** 1 root, 10 branches, 7 sub-branches each, the rest leaves: `count` cards in tree order, the target last. */
function bigOutline(count, summaryChars) {
  const rows = [node("r", "年度營運地圖", null, 0, zhText(summaryChars, 1))];
  for (let b = 1; b <= 10 && rows.length < count - 1; b++) {
    rows.push(node(`b${b}`, `營運面向${zhNumber(b)}`, "r", 1, zhText(summaryChars, b + 10)));
    for (let s = 1; s <= 7 && rows.length < count - 1; s++) {
      rows.push(node(`b${b}s${s}`, `面向${zhNumber(b)}的子題${zhNumber(s)}`, `b${b}`, 2, zhText(summaryChars, b * 10 + s)));
      const leaves = Math.ceil((count - 1 - 81) / 70);
      for (let l = 1; l <= leaves && rows.length < count - 1; l++)
        rows.push(node(`b${b}s${s}l${l}`, `子題${zhNumber(b)}之${zhNumber(s)}的細項${zhNumber(l)}`, `b${b}s${s}`, 3, zhText(summaryChars, b * 100 + s * 10 + l)));
    }
  }
  rows.push(node(TARGET.id, TARGET.title, rows.findLast(row => row.depth === 2).id, 3, zhText(summaryChars, 9999)));
  return rows;
}
const SZ1_MESSAGE = `在「${TARGET.title}」底下加三個子議題：感測器、警報門檻、稽核報表`;
const sz1Checks = [C.noRejected(), C.addChildParentsIn([TARGET.id]), C.titlesCover(["感測器", "警報", "稽核"])];

// ---- SZ2: card Detail over MAP_CHAT_DETAIL_BUDGET ----
const CONCLUSIONS = ["改用季度盤點", "外包客服夜班", "停用舊版報表", "合併兩個倉庫", "延後海外上線"];
/** Five selected cards; each note opens with its own conclusion and is padded to `chars` characters. */
const detailCards = chars =>
  CONCLUSIONS.map((conclusion, i) => ({
    id: `d${i + 1}`,
    title: `決策筆記${zhNumber(i + 1)}`,
    summary: `第${zhNumber(i + 1)}份決策的摘要`,
    detail: `本筆記的核心結論：${conclusion}。\n\n${zhText(chars - conclusion.length - 12, 200 + i)}`,
    path: `Maps/Notes/d${i + 1}.md`
  }));
const detailOutline = [node("r", "決策紀錄", null, 0, "本年度的決策"), ...CONCLUSIONS.map((_, i) => node(`d${i + 1}`, `決策筆記${zhNumber(i + 1)}`, "r", 1, `第${zhNumber(i + 1)}份決策的摘要`))];
const SZ2_MESSAGE = "根據這五張卡片的筆記，在每張卡片底下各加一張子卡，標題寫出那份筆記的核心結論";

// ---- SZ3: research notes over MAP_CHAT_RESEARCH_BUDGET ----
const FINDINGS = ["電動車電池回收率偏低", "共享單車使用量回升", "公車準點率改善", "停車費調漲效果有限", "自行車道使用集中在週末"];
/** Five researched cards, oldest first; each note opens with its finding and is padded to `chars` characters. */
const researchNotes = chars =>
  FINDINGS.map((finding, i) => ({ id: `q${i + 1}`, title: `交通研究${zhNumber(i + 1)}`, path: `Maps/Notes/q${i + 1}.md`, detail: `主要發現：${finding}。\n\n${zhText(chars - finding.length - 8, 300 + i)}` }));
const researchOutline = [node("r", "城市交通", null, 0, "城市交通研究"), ...FINDINGS.map((_, i) => node(`q${i + 1}`, `交通研究${zhNumber(i + 1)}`, "r", 1, `第${zhNumber(i + 1)}項研究`))];
const SZ3_MESSAGE = "用研究結果，在每張研究過的卡片底下各加一張子卡，標題寫出那份研究的主要發現";

// ---- SZ4: twelve long rounds of history ----
const BUDGET_FACT = "我的採購預算上限是新台幣 37,500 元";
/** `rounds` question/answer rounds of `chars` characters each; the fact is said in the second-to-last round. */
function longHistory(rounds, chars) {
  const out = [];
  for (let i = 1; i <= rounds; i++) {
    const user = i === rounds - 1 ? `${BUDGET_FACT}。以下是我貼上的會議紀錄：${zhText(chars, 400 + i)}` : `請幫我看看這段會議紀錄：${zhText(chars, 400 + i)}`;
    out.push({ role: "user", text: user }, { role: "assistant", text: `我看完了，重點如下：${zhText(chars, 500 + i)}` });
  }
  return out;
}
const historyOutline = [node("r", "辦公室採購", null, 0, "採購規劃"), node("p", "採購", "r", 1, "要買的東西")];
const SZ4_MESSAGE = "依照我前面說的預算上限，在「採購」底下加一張卡，標題寫出預算上限的金額";

// ---- SZ5 / SZ6: a very long open note ----
const HEAD = "本週重點專案有三個：晨曦計畫、潮汐計畫、北極星計畫。";
const TAIL = "最終結論：採用方案丙，預計十二月上線。";
const longNote = chars => ({ path: "Notes/年度會議紀錄.md", content: `# 年度會議紀錄\n\n${HEAD}\n\n${zhText(chars - HEAD.length - TAIL.length - 14, 600)}\n\n${TAIL}` });
const noteOutline = [node("r", "專案總覽", null, 0, "所有專案")];
const SZ5_MESSAGE = "把這份筆記開頭提到的三個專案名稱各加成一張卡片，放在「專案總覽」底下";
const SZ6_MESSAGE = "這份筆記最後的結論是什麼？";

const LARGE = [
  sz("SZ1", "500 張卡的大綱（摘要 240 字）", "size: outline has no card cap", ["add_child"], { message: SZ1_MESSAGE, outline: bigOutline(500, 240) }, sz1Checks),
  sz("SZ1c", "對照：同樣請求，12 張卡的大綱", "control of SZ1", ["add_child"], { message: SZ1_MESSAGE, outline: bigOutline(12, 240) }, sz1Checks),
  sz("SZ2", "選取卡筆記超過 Detail 預算（最後一張 detailOmitted）", "size: MAP_CHAT_DETAIL_BUDGET", ["add_child"], { message: SZ2_MESSAGE, outline: detailOutline, selected: detailCards(13_000) },
    [C.noRejected(), C.childrenPerParent(["d1", "d2", "d3", "d4"], 1), C.titlesCover(CONCLUSIONS.slice(0, 4)), C.noTargetIds(["d5"]), C.replySaysNotRead("the omitted note")],
    "第五張的筆記沒有送出：AI 有沒有說它沒讀到，而不是從標題編一個結論"),
  sz("SZ2c", "對照：同樣五張卡，筆記都很短", "control of SZ2", ["add_child"], { message: SZ2_MESSAGE, outline: detailOutline, selected: detailCards(1_500) },
    [C.noRejected(), C.childrenPerParent(["d1", "d2", "d3", "d4", "d5"], 1), C.titlesCover(CONCLUSIONS)]),
  sz("SZ3", "研究筆記超過研究預算（最舊一份延後）", "size: MAP_CHAT_RESEARCH_BUDGET", ["add_child"], { message: SZ3_MESSAGE, outline: researchOutline, researchNotes: researchNotes(20_000) },
    [C.noRejected(), C.titlesCover(FINDINGS.slice(1)), C.noTargetIds(["q1"]), C.replySaysNotRead("the deferred research note")],
    "最舊的研究筆記這一輪沒送：AI 有沒有說它還沒讀到或下一輪再處理"),
  sz("SZ3c", "對照：同樣五份研究，筆記都很短", "control of SZ3", ["add_child"], { message: SZ3_MESSAGE, outline: researchOutline, researchNotes: researchNotes(2_000) },
    [C.noRejected(), C.childrenPerParent(["q1", "q2", "q3", "q4", "q5"], 1), C.titlesCover(FINDINGS)]),
  sz("SZ4", "12 輪長對話（每則約 3000 字）", "size: earlierTurns text is not capped", ["add_child"], { message: SZ4_MESSAGE, outline: historyOutline, history: longHistory(12, 3_000) },
    [C.noRejected(), C.addChildParentsIn(["p"]), C.anyTextMatches(/37,?500|3\.75\s*萬|三萬七千五/, "the budget said in the history")]),
  sz("SZ4c", "對照：同樣請求，2 輪短對話", "control of SZ4", ["add_child"], { message: SZ4_MESSAGE, outline: historyOutline, history: longHistory(2, 120) },
    [C.noRejected(), C.addChildParentsIn(["p"]), C.anyTextMatches(/37,?500|3\.75\s*萬|三萬七千五/, "the budget said in the history")]),
  sz("SZ5", "約 20 萬字的開啟筆記：問開頭", "size: activeFile content is not capped", ["add_child"], { message: SZ5_MESSAGE, outline: noteOutline, activeFile: longNote(200_000) },
    [C.noRejected(), C.addChildParentsIn(["r"]), C.titlesCover(["晨曦", "潮汐", "北極星"])]),
  sz("SZ5c", "對照：同樣請求，短筆記", "control of SZ5", ["add_child"], { message: SZ5_MESSAGE, outline: noteOutline, activeFile: longNote(3_000) },
    [C.noRejected(), C.addChildParentsIn(["r"]), C.titlesCover(["晨曦", "潮汐", "北極星"])]),
  sz("SZ6", "約 20 萬字的開啟筆記：問最後的結論", "size: activeFile content is not capped", [], { message: SZ6_MESSAGE, outline: noteOutline, activeFile: longNote(200_000) },
    [C.noRejected(), C.noActions(), C.replyFactOrNotRead(/方案丙/, "the conclusion at the end")],
    "結論在筆記最後：送出的內容若被截掉了結尾，AI 要說沒讀到，不能編一個結論"),
  sz("SZ6c", "對照：同樣問題，短筆記", "control of SZ6", [], { message: SZ6_MESSAGE, outline: noteOutline, activeFile: longNote(3_000) },
    [C.noRejected(), C.noActions(), C.replyMatch(/方案丙/, "the conclusion at the end")])
];

module.exports = { LARGE, zhText, NOT_READ };
