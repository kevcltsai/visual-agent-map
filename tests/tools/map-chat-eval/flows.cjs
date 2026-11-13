// Long-conversation flows: several turns, each building on the map the earlier turns made (see sim.cjs). After the last turn the
// map is compared with the expected one, so the flow passes only when the stacked actions leave the output the user asked for.
//   id, title, source, start { title, rows: [[id, title, parentId]] }, turns: [{ say, expect?: checks }], final { tree, relations?, none? }
// `tree` is exact (see matchTree); `relations` are [{ from: RegExp, to: RegExp, kind }]; `none` is a RegExp no title may match.
const { C } = require("./checks.cjs");

const FLOWS = [
  {
    id: "FL1", title: "咖啡樹：建樹、加子項、移動、改名、刪除、外觀（7 輪）", source: "多動作疊加：建樹後連續改結構",
    start: { title: "", rows: [] },
    turns: [
      { say: "幫我建一棵咖啡的樹，三個分支：手沖、義式、冷萃" },
      { say: "在手沖底下加兩個子議題：濾杯、手沖壺" },
      { say: "在義式底下加兩個子議題：濃縮、拿鐵" },
      { say: "把冷萃移到手沖底下" },
      { say: "把義式改名成義式咖啡" },
      { say: "刪掉手沖壺" },
      { say: "把濃縮設成紅色並加上星號" }
    ],
    final: { tree: [{ t: /咖啡/, c: [{ t: /手沖/, c: [{ t: /濾杯/ }, { t: /冷萃/ }] }, { t: /義式咖啡/, c: [{ t: /濃縮/, color: "red", marker: "star" }, { t: /拿鐵/ }] }] }] }
  },
  {
    id: "FL2", title: "營收診斷：類型、證據、關係、外觀疊加（6 輪）", source: "多動作疊加：議題類型與關係",
    start: { title: "營收", rows: [["r", "營收下滑", null], ["h1", "價格太高", "r"], ["h2", "競爭者變多", "r"], ["e1", "客單價上升 12%", "r"]] },
    turns: [
      { say: "把價格太高設成假設，被強烈支持" },
      { say: "把競爭者變多設成假設，被反駁，強度中" },
      { say: "客單價上升 12% 是一條證據" },
      { say: "連一條 supports 關係：從客單價上升 12% 到價格太高" },
      { say: "把價格太高設成紅色" },
      { say: "把根議題改名成「營收下滑原因」" }
    ],
    final: {
      tree: [{ t: /營收下滑原因/, c: [{ t: /價格太高/, kind: "hypothesis", leaning: "supported", strength: "strong", color: "red" }, { t: /競爭者變多/, kind: "hypothesis", leaning: "refuted", strength: "medium" }, { t: /客單價/, kind: "evidence" }] }],
      relations: [{ from: /客單價/, to: /價格太高/, kind: "supports" }]
    }
  },
  {
    id: "FL3", title: "整理重複：合併、加子項、改名、改摘要（4 輪）", source: "多動作疊加：合併後繼續編輯",
    start: { title: "咖啡", rows: [["r", "咖啡", null], ["x", "手沖", "r"], ["x1", "濾杯", "x"], ["y", "手沖咖啡", "r"], ["y1", "濾杯種類", "y"], ["z", "義式", "r"]] },
    turns: [
      { say: "「手沖」和「手沖咖啡」是重複的，把它們合併成「手沖咖啡」" },
      { say: "在手沖咖啡底下加「手沖壺」" },
      { say: "把義式改名成義式咖啡" },
      { say: "把「濾杯種類」的摘要改成：常見濾杯的差異" }
    ],
    final: { tree: [{ t: /咖啡/, c: [{ t: /手沖咖啡/, c: [{ t: /^濾杯$/ }, { t: /濾杯種類/, s: /常見濾杯的差異/ }, { t: /手沖壺/ }] }, { t: /義式咖啡/ }] }] }
  },
  {
    id: "FL4", title: "更正：Python 改成 JavaScript 後繼續擴充（4 輪）", source: "多輪：使用者更正，之後不可再出現被否定的內容",
    start: { title: "", rows: [] },
    turns: [
      { say: "做一個 Python 學習路線，三個分支：語法、資料結構、套件" },
      { say: "不對，我要的是 JavaScript，不是 Python" },
      { say: "在資料結構底下加陣列和物件" },
      { say: "把套件那個分支改名成 npm 套件" }
    ],
    final: { tree: [{ t: /JavaScript/, c: [{ t: /語法/ }, { t: /資料結構/, c: [{ t: /陣列/ }, { t: /物件/ }] }, { t: /npm/ }] }], none: /python/i }
  },
  {
    id: "FL5", title: "日本旅行：建樹、分城市加景點、刪分支、移動、外觀、改名（8 輪）", source: "多動作疊加：最長流程",
    start: { title: "", rows: [] },
    turns: [
      { say: "幫我規劃日本旅行，三個城市：東京、京都、大阪" },
      { say: "東京底下加淺草寺和澀谷" },
      { say: "京都底下加清水寺和伏見稻荷" },
      { say: "大阪底下加大阪城和道頓堀" },
      { say: "刪掉大阪整個分支" },
      { say: "把東京設成藍色並加星號" },
      { say: "把清水寺移到東京底下" },
      { say: "把京都改名成京都古都" }
    ],
    final: { tree: [{ t: /日本/, c: [{ t: /東京/, color: "blue", marker: "star", c: [{ t: /淺草寺/ }, { t: /澀谷/ }, { t: /清水寺/ }] }, { t: /京都古都/, c: [{ t: /伏見稻荷/ }] }] }], none: /大阪|道頓堀/ }
  }
];

/** Checks every turn gets whatever the flow does: nothing dropped by the parser, no done-claims, no approval requests. */
const TURN_CHECKS = [C.noRejected(), C.replyNoDoneClaim(), C.replyNoApprovalAsk()];

module.exports = { FLOWS, TURN_CHECKS };
