# Visual Agent Map

[English](#english) · [繁體中文](#繁體中文)

## English

### Explore big questions with visual AI research in Obsidian

**Start with a question. See the pieces. Follow the ideas worth exploring.** Build a visual research map, let AIM investigate a question, or talk through a new idea in Coffee Tables. Keep what you learn in editable Markdown notes.

[**Get started**](#get-started) · [See the 0.14.0 release](https://github.com/kevcltsai/visual-agent-map/releases/tag/0.14.0) · [Installation guide](INSTALL.md)

### Take a look

![Example Visual Agent Map research map with connected topic cards in Obsidian](assets/screenshots/map-overview.png)

*Example visual map; this image does not show every guided research control.*

### Three ways to explore

- **Visual maps.** Break a question into topics, research a branch with AI, and review suggestions before adding them. Manual mapping needs no AI.
- **AIM — Adaptive Inquiry Map.** Work from your question and background toward a document with supporting sources. Follow the research in the map, build on useful earlier findings, and resume unfinished work when a step fails. The current interface calls this workflow **MindSearch**.
- **Coffee Tables.** Bring an unfinished idea to simulated AI guests. Add `.txt` / `.md` background, choose a conversation style, invite guests with a question, and revisit observer insights and conversation segments.

Coffee Tables guests are simulated, not real experts; their conversations are not automatically fact-checked.

### Get started

1. In **Obsidian Desktop → Settings → Community plugins → Browse**, find **Visual Agent Map**, then install and enable it. Requires Obsidian **1.13.7+**.
2. Try the built-in sample or create a visual map. For AI features, install and sign in to [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), then check the CLI in VAM settings.
3. Choose **Create MindSearch map** to try AIM. Enter your question and background, answer the questions that matter, and open the connected notes to inspect research and the final document.

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

Desktop only; macOS with Obsidian 1.14.4 is the verified environment for AIM. Windows and Linux remain unverified. Claude Code support is experimental; successful live tasks remain unverified.

AIM searches the web and provides source links, but finding a source does not prove its claims are true. AI judgments, unavailable sources, and account limits can leave research incomplete. Check important claims against the original sources.

Outline search covers titles in the current map, not full text. Map undo/redo is temporary and clears when you switch maps or close the view.

### Research inspiration

AIM's planning, search, and synthesis approach is inspired by [MindSearch](https://github.com/InternLM/MindSearch) and [Chen et al. (2024)](https://arxiv.org/abs/2407.20183). VAM independently implements and adapts this workflow for Obsidian; this attribution does not imply affiliation or endorsement.

### Help and license

[Report an issue](https://github.com/kevcltsai/visual-agent-map/issues) · [Changelog](CHANGELOG.md) · [AGPL-3.0-only](LICENSE)

Copyright © 2026 Kevin Tsai

---

## 繁體中文

### 在 Obsidian，用視覺化 AI 地圖探索問題

**從一個問題出發，看見各個部分，再追你想探索的線索。** 建立視覺化研究地圖、讓 AIM 深入查證問題，或到 Coffee Tables 聊出新角度；想留下的發現都能存成可編輯的 Markdown 筆記。

[**開始使用**](#開始使用) · [查看 0.14.0 正式版](https://github.com/kevcltsai/visual-agent-map/releases/tag/0.14.0) · [安裝指南](INSTALL.md)

### 看看畫面

![Obsidian 中的 Visual Agent Map 研究地圖範例，顯示相連的議題卡片](assets/screenshots/map-overview.png)

*視覺化地圖範例；圖片未展示所有引導式研究操作。*

### 三種探索方式

- **視覺化地圖。** 把問題拆成議題，用 AI 深入一個分支；先查看建議，再決定是否加入。手動繪圖不需要 AI。
- **AIM — Adaptive Inquiry Map。** 從你的問題與背景出發，逐步形成附有來源的文件。在地圖中追蹤研究、沿用有用的既有發現，遇到失敗時接續未完成的工作。目前介面仍將此流程標示為 **MindSearch**。
- **Coffee Tables。** 把未成形的想法帶來，與模擬 AI 來賓對談。加入 `.txt`／`.md` 背景、選擇對談風格、透過追問邀請來賓，並回看觀察者洞見與對話段落。

Coffee Tables 來賓是模擬角色，不是真實專家；對談內容不會自動查證。

### 開始使用

1. 到 **Obsidian 桌面版 → 設定 → 第三方外掛 → 瀏覽** 搜尋 **Visual Agent Map**，安裝並啟用。需要 Obsidian **1.13.7+**。
2. 先試內建範例，或建立自己的視覺化地圖。使用 AI 功能前，安裝並登入 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，再到 VAM 設定檢查 CLI。
3. 選擇「**建立 MindSearch 心智圖**」體驗 AIM。輸入問題與背景，回答重要的條件問題，再開啟相連的筆記查看研究與最終文件。

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

僅支援桌面版；AIM 已驗證環境為 macOS 與 Obsidian 1.14.4。Windows 與 Linux 尚未驗證。Claude Code 屬實驗性支援，真實任務成功完成仍待驗證。

AIM 會搜尋網路並提供來源連結，但找到來源不代表內容已證實。AI 判斷、無法存取的來源與帳號額度，都可能讓研究未能完成。重要主張請回到原始來源核對。

大綱只搜尋目前地圖的議題名稱，不搜尋全文。地圖的復原／重做是暫存紀錄，切換地圖或關閉視圖後會清除。

### 研究流程參考

AIM 的研究規劃、搜尋與整合方式參考 [MindSearch 原專案](https://github.com/InternLM/MindSearch) 與 [Chen 等人（2024）的論文](https://arxiv.org/abs/2407.20183)。VAM 為 Obsidian 獨立實作與調整此流程；此標註不代表隸屬或獲得原專案背書。

### 支援與授權

[回報問題](https://github.com/kevcltsai/visual-agent-map/issues) · [版本紀錄](CHANGELOG.md) · [AGPL-3.0-only](LICENSE)

Copyright © 2026 Kevin Tsai
