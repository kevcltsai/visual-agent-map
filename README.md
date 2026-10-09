# Visual Agent Map

[English](#english) · [繁體中文](#繁體中文)

## English

### Turn a question into a research map you can keep

**Explore a question, see its supporting evidence, and keep the result in editable Markdown.** Visual Agent Map brings visual mapping, guided AI research, and Coffee Tables conversations into Obsidian.

[**Get started**](#get-started) · [Latest published release](https://github.com/kevcltsai/visual-agent-map/releases/latest) · [Installation guide](INSTALL.md)

> **Next release preview:** The guided research improvements described below are in the current development version. The latest published release is 0.13.0.

![Example Visual Agent Map research map with connected topic cards in Obsidian](assets/screenshots/map-overview.png)

*Example visual map; this image does not show every guided research control.*

### Choose how to explore

- **Visual maps.** Organize your own ideas, break a topic into branches, and review AI suggestions before adding them. Manual mapping does not require AI.
- **AIM — Adaptive Inquiry Map.** Let a guided research workflow ask for useful background, plan evidence tasks, search sources, and work toward a document that answers your original question. The current interface labels this workflow **MindSearch**.
- **Coffee Tables.** Talk through an unfinished idea with simulated AI guests. Add `.txt` / `.md` background, choose a conversation style, invite guests with a follow-up question, and revisit observer insights and conversation segments.

Coffee Tables guests are simulated, not real experts. Their conversations are not automatically fact-checked.

### Research that can build on earlier work

AIM keeps your answers, research reports, and final document connected in the map. It distinguishes missing personal context from missing external evidence: it can ask you a question or continue researching as needed.

- **Reuse useful evidence.** Earlier reports on the same answer path can be reused after an applicability and freshness assessment. Changed conditions or evidence gaps can trigger an update or a new search.
- **Research independent topics together.** Up to two independent evidence tasks can run at once. A task with prerequisites waits for their saved reports and receives their actual findings.
- **Keep progress when a step fails.** Completed reports remain saved. A failed step shows its reason and available recovery actions; timeout recovery can extend the affected task's limit from three to ten minutes.
- **Write the final document by section.** Completed sections are saved before the next section starts. A retry can continue unfinished work; changed sources invalidate the sections that depend on them. The assembled document receives a final review, and completed conclusion cards have no **New question** button.

Research tasks use available web search and return supporting source links. Opening or searching a source does **not** prove its claims are true. Reuse assessments and final reviews are AI judgments; check important claims against the original sources. Missing evidence or provider failures can leave a result incomplete.

### Get started

1. In **Obsidian Desktop → Settings → Community plugins → Browse**, find **Visual Agent Map**, then install and enable it. Requires Obsidian **1.13.7+**. macOS is the verified platform; current guided research was tested on Obsidian **1.14.4**.
2. Try the built-in sample or create a visual map. For AI features, install and sign in to [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), then check the CLI in VAM settings. Claude Code support is experimental.
3. In the development version, choose **Create MindSearch map** to try AIM. Enter your question and background, answer the questions that matter, and open the connected notes to inspect research and the final document.

For detailed setup, manual installation, and troubleshooting, see [INSTALL.md](INSTALL.md).

### Your notes and privacy

Maps, research reports, Coffee Tables conversations, and observer notes are readable Markdown in your vault. You can edit and keep them outside VAM.

AI actions for selected Markdown text and clicked images produce editable drafts. You explicitly accept a draft before it changes a note. Image interpretation currently requires Codex and sends the selected image data when you run the action; original images remain unchanged.

VAM has no telemetry and does not store API keys. AI tasks send relevant content, including research context, selected background files, or guest profiles, through your local CLI to OpenAI or Anthropic. Your provider allowance or charges may apply. AI request/reply logging is off by default; enabled logs may contain private note content.

<details>
<summary>Local access and permissions</summary>

The CLI inherits Obsidian's OS permissions; read-only or tool restrictions are not an OS sandbox. VAM may read vault Markdown paths to find its workspace and probe CLI paths outside the vault. Optional AI exchange logs and temporary files are stored in plugin data. Copy actions write requested text to the clipboard; VAM does not read clipboard contents or install/update your CLI.

</details>

### Current limitations

Desktop only. Windows and Linux have not been verified. Guided research has been tested with Codex; successful live Claude Code tasks remain unverified. Older saved research plans can continue sequentially. Source access, account limits, and AI output quality can affect completion; there is no guaranteed research duration or factual accuracy.

Outline search covers titles in the current map, not full text. Map undo/redo is temporary and clears when you switch maps or close the view.

### Research inspiration

AIM's planning, search, and synthesis approach is inspired by [MindSearch](https://github.com/InternLM/MindSearch) and [Chen et al. (2024)](https://arxiv.org/abs/2407.20183). VAM independently implements and adapts this workflow for Obsidian; this attribution does not imply affiliation or endorsement.

### Help and license

[Report an issue](https://github.com/kevcltsai/visual-agent-map/issues) · [Changelog](CHANGELOG.md) · [AGPL-3.0-only](LICENSE)

Copyright © 2026 Kevin Tsai

---

## 繁體中文

### 把問題變成可以留下來的研究地圖

**探索問題、看見支持它的證據，把成果留成可編輯的 Markdown。** Visual Agent Map 在 Obsidian 中結合視覺化地圖、引導式 AI 研究與 Coffee Tables 對談。

[**開始使用**](#開始使用) · [最新正式版](https://github.com/kevcltsai/visual-agent-map/releases/latest) · [安裝指南](INSTALL.md)

> **下版預覽：** 以下引導式研究改進已納入目前開發版本，尚未正式發布。最新正式版為 0.13.0。

![Obsidian 中的 Visual Agent Map 研究地圖範例，顯示相連的議題卡片](assets/screenshots/map-overview.png)

*視覺化地圖範例；圖片未展示所有引導式研究操作。*

### 選擇你的探索方式

- **視覺化地圖。** 整理自己的想法，把議題拆成分支；先查看 AI 建議，再決定是否加入。手動繪圖不需要 AI。
- **AIM — Adaptive Inquiry Map。** 讓引導式研究流程詢問有用的背景、規劃證據任務、搜尋來源，逐步形成回答原始問題的文件。目前介面仍將此流程標示為 **MindSearch**。
- **Coffee Tables。** 把未成形的想法帶來，與模擬 AI 來賓對談。加入 `.txt`／`.md` 背景、選擇對談風格、透過追問邀請來賓，並回看觀察者洞見與對話段落。

Coffee Tables 來賓是模擬角色，不是真實專家；對談內容不會自動查證。

### 讓研究接得上前一次的成果

AIM 把你的回答、研究報告與最終文件連在地圖中。它會區分缺少個人條件與缺少外部證據，視需要詢問你，或繼續研究。

- **沿用有效證據。** 同一回答路徑上的舊報告，通過適用性與時效評估後可以沿用；條件改變或仍有證據缺口時，可改為更新或新查證。
- **獨立子議題同時查證。** 最多兩個獨立證據任務一起執行。有前置依賴的任務會等待報告保存，再收到實際完成的內容。
- **失敗後保留進度。** 已完成的報告仍會保存。失敗步驟會顯示原因與可用的修復操作；逾時重試可把該任務的上限由三分鐘延長至十分鐘。
- **最終文件逐章撰寫。** 完成一章先保存，再進入下一章。重試可接續未完成的部分；來源更新時，會讓依賴它的章節重新產生。整份文件最後再做驗收，已完成的結論卡片不顯示「新問題」按鈕。

查證任務會使用可用的網路搜尋並提供支持來源連結。搜尋或讀取來源**不代表已證明內容真實**。報告沿用與最終驗收仍是 AI 判斷；重要主張請回到原始來源核對。證據不足或服務失敗時，研究可能保留為未完成結果。

### 開始使用

1. 到 **Obsidian 桌面版 → 設定 → 第三方外掛 → 瀏覽** 搜尋 **Visual Agent Map**，安裝並啟用。需要 Obsidian **1.13.7+**。目前已驗證 macOS；這次引導式研究的測試環境為 Obsidian **1.14.4**。
2. 先試內建範例，或建立自己的視覺化地圖。使用 AI 功能前，安裝並登入 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，再到 VAM 設定檢查 CLI。Claude Code 仍屬實驗性支援。
3. 在開發版本選擇「**建立 MindSearch 心智圖**」體驗 AIM。輸入問題與背景，回答重要的條件問題，再開啟相連的筆記查看研究與最終文件。

詳細設定、手動安裝與問題排除，請見 [INSTALL.md](INSTALL.md)。

### 你的筆記與隱私

地圖、研究報告、Coffee Tables 對談與觀察者筆記，都是 Vault 裡可閱讀的 Markdown。你可以編輯它們，也可以離開 VAM 繼續使用。

選取 Markdown 文字與點選圖片的 AI 操作會產生可編輯草稿。你必須明確接受草稿，才會改動筆記。圖片辨識目前需要 Codex，執行時才傳送選取圖片的資料；原始圖片保持不變。

VAM 不含遙測，也不儲存 API key。AI 任務會透過本機 CLI 將相關內容，包括研究脈絡、選取的背景檔或來賓設定，傳送至 OpenAI 或 Anthropic，可能使用帳號額度或產生費用。AI 請求／回覆紀錄預設關閉；啟用後的紀錄可能包含私人筆記。

<details>
<summary>本機存取與權限</summary>

CLI 繼承 Obsidian 的作業系統權限；唯讀或工具限制不等於 OS sandbox。VAM 可能讀取 Vault 的 Markdown 路徑來尋找工作區，也會探測 Vault 外的 CLI 路徑。選用的 AI 往返紀錄與暫存檔會保存在外掛資料中。複製操作只將指定文字寫入剪貼簿；VAM 不讀取剪貼簿內容，也不會自行安裝或更新 CLI。

</details>

### 目前限制

僅支援桌面版；Windows 與 Linux 尚未驗證。引導式研究已使用 Codex 測試；Claude Code 的真實任務成功完成仍待驗證。較舊的研究計畫可能繼續循序執行。來源存取、帳號額度與 AI 輸出品質都會影響完成結果，不保證研究時間或事實正確性。

大綱只搜尋目前地圖的議題名稱，不搜尋全文。地圖的復原／重做是暫存紀錄，切換地圖或關閉視圖後會清除。

### 研究流程參考

AIM 的研究規劃、搜尋與整合方式參考 [MindSearch 原專案](https://github.com/InternLM/MindSearch) 與 [Chen 等人（2024）的論文](https://arxiv.org/abs/2407.20183)。VAM 為 Obsidian 獨立實作與調整此流程；此標註不代表隸屬或獲得原專案背書。

### 支援與授權

[回報問題](https://github.com/kevcltsai/visual-agent-map/issues) · [版本紀錄](CHANGELOG.md) · [AGPL-3.0-only](LICENSE)

Copyright © 2026 Kevin Tsai
