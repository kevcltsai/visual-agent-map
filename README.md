# Visual Agent Map

[English](#english) · [繁體中文](#繁體中文)

## English

### Visual AI research for Obsidian

**Turn complex questions into a visual research map. Explore each branch with Codex or Claude Code. Keep every result as editable Markdown.**

[**Install Visual Agent Map**](#install)

![Visual Agent Map — visual AI research map in Obsidian](assets/screenshots/map-overview.png)

**See the whole question.** Break a broad topic into connected ideas you can navigate at a glance.

**Research one branch at a time.** Run focused AI tasks from the map, preview suggested subtopics, and review synthesis drafts before saving.

**Keep what you learn.** Each topic is a normal Markdown note in your Obsidian vault, readable and editable without the plugin.

**Use your local Codex or Claude Code installation. No VAM API key required.**

### How it works

1. Create a map for a question and add topics or ask your selected AI service to suggest subtopics.
2. Choose a topic and confirm a focused research task.
3. Read the summary on the map and the full result in its Markdown note.
4. Follow the next question or synthesize related findings.

Research and map expansion can use web-enabled Codex or Claude Code tasks. Synthesis uses direct child topics (or selected topics for multi-select) and notes selected for that run; web search is off by default. Choose a service and model per topic; tasks may consume the selected account's allowance.

In each topic note, **Current Summary** is the map-card conclusion, **Prompt** is the topic's standing question, **Preview** is the card preview, and **Detail** is the full knowledge. Put instructions for a single AI run in **Additional requirements**; existing `Rules` text in older notes is preserved but is not applied automatically. Choose the answer language for each task. The six knowledge sections still organize the answer; a request such as “three conclusions” controls the number of points in Core conclusions.

### Install

In **Obsidian Desktop → Settings → Community plugins → Browse**, search for **Visual Agent Map** and install it.

**Requirements:** Obsidian Desktop `1.13.7` or later. Manual maps work without an AI service. AI tasks require a locally installed [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), configured and signed in with the corresponding account. This is a desktop-only plugin; npm is needed only to build from source. Current version: **0.9.9**.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub Release](https://github.com/kevcltsai/visual-agent-map/releases), place them in `<your-vault>/.obsidian/plugins/visual-agent-map/`, and preserve any existing `data.json`. Reload Obsidian and enable the plugin. Configure at least one supported CLI in settings before using AI. Do not install files from a branch, copy the repository into the plugin folder, or run `npm install` there. See [INSTALL.md](INSTALL.md) for first-use steps.

### Your notes and privacy

The plugin stores its workspace under `Agent Workspace/` in your vault. Map structure lives in `Map.md`; topic content stays in ordinary Markdown notes. A fresh install creates an empty workspace and opens a read-only sample. Uninstalling the plugin does not delete your notes.

- No telemetry or stored API keys.
- Before the first task for each provider, the plugin explains that the selected service may use that account's allowance. Relevant topic content, task instructions, and sources selected for that run are sent to the locally configured CLI.
- AI request and reply logging is off by default. If enabled, recent exchanges are saved in the vault's plugin data and can be cleared.
- The plugin launches the configured local CLI with the plugin directory as its working directory. Codex tasks use a read-only App Server thread. Claude tasks use structured JSON output, disable user settings and MCP configuration, and expose no local tools or only web search tools for research. Each process still inherits Obsidian's OS access and environment; CLI restrictions are not an OS sandbox. Use trusted executables. The plugin does not install or update either CLI.
- Node filesystem APIs probe local CLI installation paths and persist AI exchanges and pending suggestions in the plugin directory, including temporary files for atomic replacement. These APIs have system-level access beyond the Vault API.
- Workspace discovery and maintenance enumerate Markdown paths across the vault and may read notes to identify VAM data. This enumeration does not itself send all notes to AI. Copy buttons write the selected log to the clipboard; the plugin does not read the clipboard. Remote Markdown images follow Obsidian's normal image-loading behavior.

### Requirements and synthesis sources

Enter instructions for each task in **Additional requirements**. Old `Rules` in notes are preserved for compatibility but are not automatically applied. The official sample keeps example conditions in Detail and explains how to use them for a run.

Parent and multi-select synthesis default to **Full content synthesis**; choose **Quick summary synthesis** to omit full Detail. Parent synthesis includes direct children only; multi-select synthesis includes only selected topics. Neither automatically includes grandchildren. Extra Markdown sources are always read in full, deduplicated and processed in batches. Full mode includes all Detail in source processing, which can take longer; it does not promise one model request or verbatim preservation in the answer.

### Current limitations

Claude Code support is experimental. Model availability, account access, web search, synthesis and answer quality depend on the installed CLI and account; equivalent live results are not claimed. If Codex models are missing after startup, use **Check again** for Codex in VAM settings, then reopen the task dialog. Search counts are prompt targets and stopping reminders, not strict service-enforced limits.

Desktop only. The outline searches topic titles in the current mind map; it does not search full note text or across maps. Multiple parents and persistent task history are unavailable. Undo and redo last for the current Obsidian session, including saved AI results. Deleted maps can be restored in the same session; topic notes stay in the Vault. A running node task can be stopped while preserving its existing note; after three minutes, the plugin attempts to interrupt it and does not apply incomplete results. External Markdown references remain outside the Vault and are cited as external paths.

See the [changelog](CHANGELOG.md) for version history and [setup instructions](INSTALL.md) for more detail. This project is developed with [OpenAI Codex](https://openai.com/codex/) as a coding collaborator; the maintainer manages product direction, validation, and releases.

### License

Copyright © 2026 Kevin Tsai. Licensed under [AGPL-3.0-only](LICENSE).

---

## 繁體中文

### 為 Obsidian 打造的視覺化 AI 研究工具

**把複雜問題變成研究地圖，用 Codex 或 Claude Code 逐一探索分支，並將成果保留為可編輯的 Markdown 筆記。**

[**安裝 Visual Agent Map**](#安裝)

![Visual Agent Map — Obsidian 視覺化 AI 研究地圖](assets/screenshots/map-overview.png)

**看清整個問題。** 把大主題拆成彼此連結的議題，一眼掌握研究方向。

**一次研究一個分支。** 從地圖執行聚焦的 AI 任務，預覽子議題建議，確認整合草稿後再儲存。

**留下真正可用的知識。** 每個議題都是 Obsidian Vault 中的一般 Markdown 筆記，離開外掛也能閱讀與編輯。

**使用本機 Codex 或 Claude Code，不必為 VAM 設定 API key。**

### 使用方式

1. 為問題建立地圖，手動加入議題或讓所選 AI 服務建議子議題。
2. 選擇一個議題並確認聚焦的研究任務。
3. 在地圖看摘要，在 Markdown 筆記讀完整結果。
4. 繼續追問，或整合相關發現。

研究與展開地圖可使用 Codex 或 Claude Code 搜尋網頁。整合發現使用直屬子議題（多選時使用已選議題）與本次選取的筆記，網頁搜尋預設關閉。每個議題可選服務與模型，任務可能使用該服務帳號的額度。

### 安裝

在 **Obsidian 桌面版 → 設定 → 第三方外掛 → 瀏覽** 搜尋並安裝 **Visual Agent Map**。

**系統需求：** Obsidian 桌面版 `1.13.7` 或更新版本。手動建立地圖不需要 AI 服務；AI 任務需要本機安裝 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，並使用對應帳號完成設定。外掛僅支援桌面版；只有從原始碼建置才需要 npm。目前版本：**0.9.9**。

若要手動安裝，請從同一個 [GitHub Release](https://github.com/kevcltsai/visual-agent-map/releases) 下載 `main.js`、`manifest.json`、`styles.css`，放入 `<你的-vault>/.obsidian/plugins/visual-agent-map/`，並保留既有的 `data.json`。重新載入 Obsidian 並啟用外掛；使用 AI 前，到設定確認至少一個 CLI 路徑與狀態。不要使用 branch 上的檔案、複製整個 repository 至外掛資料夾，或在該資料夾執行 `npm install`。首次使用步驟請見 [INSTALL.md](INSTALL.md)。

### 筆記與隱私

外掛工作區位於 Vault 的 `Agent Workspace/`。地圖結構保存在 `Map.md`，議題內容則是一般 Markdown 筆記。全新安裝會建立空白工作區並開啟唯讀範例；移除外掛不會刪除筆記。

- 不含遙測，也不儲存 API key。
- 首次使用各 AI 服務前會告知可能使用該帳號額度。相關議題內容、任務指令及本次選取來源會送交本機設定的 CLI。
- AI 請求與回覆紀錄預設關閉；啟用後，最近的往返紀錄會保存在 Vault 的外掛資料中，並可清除。
- 外掛以外掛目錄為工作目錄啟動設定的 CLI。Codex 使用唯讀 App Server 工作階段；Claude 使用結構化輸出、停用使用者設定與 MCP，並限制可用工具。程序仍繼承 Obsidian 的作業系統權限與環境，CLI 限制不等於 OS sandbox。請使用可信任的執行檔；外掛不自行安裝或更新 CLI。
- Node 檔案 API 用於探測本機 CLI 安裝路徑，以及在外掛目錄保存 AI 往返紀錄、待確認建議與原子替換用的暫存檔。這些 API 具有超出 Vault API 的系統檔案存取能力。
- 工作區探索與維護會列舉整個 Vault 的 Markdown 路徑，並可能讀取筆記以辨識 VAM 資料；列舉本身不會將全部筆記送交 AI。複製按鈕只將選定日誌寫入剪貼簿，不讀取剪貼簿。Markdown 中的遠端圖片依 Obsidian 一般行為載入。

### 任務要求與整合來源

每次任務的指令請填入「本次附加要求」。筆記中的舊 `Rules` 保留供相容使用，但不會自動套用。官方範例將條件保留在 Detail，並說明如何填入當次任務。

筆記中的 **Current Summary（摘要）** 是地圖卡片結論，**Prompt** 是議題的長期問題，**Preview（預覽）** 是卡片預覽，**Detail（詳情）** 是完整知識。每次任務可選回答語言；六個知識章節仍用於整理答案。「三點結論」等要求決定核心結論的點數，不刪除其餘知識章節。

母議題與多選整合預設採「完整內容整合」，也可選「摘要快速整合」省略完整 Detail。母議題只自動納入直屬子題，多選只納入已選議題；兩者都不自動加入孫題。額外 Markdown 來源一律全文讀取、去重與分批處理。完整模式確保 Detail 納入來源處理，資料多時可能較慢；不保證全文一次送入模型或答案逐字保留所有細節。

### 目前限制

Claude Code 支援仍屬實驗性功能。模型、帳號、網路搜尋、整合及回答品質取決於已安裝的 CLI 與帳號，不宣稱兩家實際結果等價。若啟動後沒有 Codex 模型，請在 VAM 設定按 Codex 的「重新檢查」，再重新開啟任務視窗。搜尋次數是提示目標與收尾提醒，不是服務端強制上限。

僅支援桌面版。大綱可搜尋目前心智圖的議題名稱，不搜尋筆記全文或跨圖內容。尚無多母議題或永久任務歷史。復原與重做只保留於目前 Obsidian 工作階段，包含已保存的 AI 結果；刪除的地圖可在同一工作階段還原，議題筆記仍留在 Vault。執行中的節點任務可停止，原筆記會保留；超過三分鐘時，外掛會嘗試中斷，未完成的結果不會套用。外部 Markdown 來源仍在 Vault 外，以外部路徑引用。

版本紀錄請見 [CHANGELOG.md](CHANGELOG.md)，其他設定資訊請見 [INSTALL.md](INSTALL.md)。本專案使用 [OpenAI Codex](https://openai.com/codex/) 協助開發；產品方向、驗證與發布由維護者負責。

### 授權

Copyright © 2026 Kevin Tsai. 採用 [AGPL-3.0-only](LICENSE) 授權。
