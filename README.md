# Visual Agent Map

[English](#english) · [繁體中文](#繁體中文)

## English

### Explore big questions with visual AI research in Obsidian

**Start with a question. See the pieces. Follow the ideas worth exploring.** Build a visual AI research map in Obsidian, or talk through a new idea in Coffee Tables. Keep what you learn in editable Markdown notes.

[**Get started**](#get-started) · [See the 0.10.0 release](https://github.com/kevcltsai/visual-agent-map/releases/tag/0.10.0)

### Take a look

![Example Visual Agent Map research map with connected topic cards in Obsidian](assets/screenshots/map-overview.png)

*Example research map in Obsidian.*

### Two ways to explore

- **Visual research map.** Break a question into topics, research one branch with AI, and review suggestions before saving them. Your map and research stay in Markdown.
- **Coffee Tables conversations.** Bring an unfinished idea to the table. Simulated AI guests discuss different angles; you can listen, ask a guest, or continue the conversation. Observer notes help you revisit open questions.

Coffee Tables is included in **0.10.0**. Its guests are simulated, not real experts; the conversation is not fact-checked.

### Get started

1. In **Obsidian Desktop → Settings → Community plugins → Browse**, find **Visual Agent Map**, then install and enable it. Requires Obsidian **1.13.7+**; macOS with 1.13.7 is the verified environment.
2. Try the built-in sample or create a map. Manual mapping needs no AI. For AI research or Coffee Tables, sign in to [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), then check the CLI in VAM settings. Claude Code support is experimental.

Setup and troubleshooting: [INSTALL.md](INSTALL.md) · [Manual installation from the 0.10.0 release](https://github.com/kevcltsai/visual-agent-map/releases/tag/0.10.0)

### Your notes and privacy

Maps, research notes, Coffee Tables conversations, and observer notes are readable Markdown in your vault. VAM has no telemetry or stored API keys. AI tasks send relevant content through your local CLI to OpenAI or Anthropic; your provider allowance or charges may apply. AI request/reply logging is off by default.

<details>
<summary>Local access and permissions</summary>

The CLI inherits Obsidian's OS permissions; its read-only or tool restrictions are not an OS sandbox. VAM may read vault Markdown paths to find its workspace and probe CLI paths outside the vault. Optional AI exchange logs and temporary files are stored in plugin data. VAM does not install or update your CLI.

</details>

#### Current limitations

Desktop only; macOS is the verified platform. Claude Code live tasks remain unverified. Outline search covers titles in the current map, not full text. Map undo/redo is temporary and clears when you switch maps or close the view. AI answers depend on your CLI and account.

### Help and license

[Installation guide](INSTALL.md) · [Report an issue](https://github.com/kevcltsai/visual-agent-map/issues) · [Changelog](CHANGELOG.md) · [AGPL-3.0-only](LICENSE)

Copyright © 2026 Kevin Tsai

---

## 繁體中文

### 在 Obsidian，用視覺化 AI 地圖探索問題

**從一個問題出發，看見各個部分，再追你想探索的線索。** 用 Obsidian 視覺化 AI 研究地圖探索分支，或到 Coffee Tables 聊出新角度；想留下的發現都能存成可編輯的 Markdown 筆記。

[**開始使用**](#開始使用) · [查看 0.10.0 正式版](https://github.com/kevcltsai/visual-agent-map/releases/tag/0.10.0)

### 看看畫面

![Obsidian 中的 Visual Agent Map 研究地圖範例，顯示相連的議題卡片](assets/screenshots/map-overview.png)

*Obsidian 中的研究地圖範例。*

### 兩種探索方式

- **視覺化 AI 研究地圖。** 把問題拆成議題，用 AI 深入一個分支；建議先看過，再決定是否保存。地圖與研究成果都是 Markdown。
- **Coffee Tables 對談。** 把模糊念頭帶來，聽模擬 AI 來賓交流。你可以旁聽、追問或接著聊；觀察者筆記留下值得再想的問題。

Coffee Tables **已包含在 0.10.0 正式版**。來賓是模擬角色，不是真實專家；對談內容不會自動查證。

### 開始使用

1. 到 **Obsidian 桌面版 → 設定 → 第三方外掛 → 瀏覽** 搜尋 **Visual Agent Map**，安裝並啟用。需要 Obsidian **1.13.7+**；已驗證環境為 macOS 與 Obsidian 1.13.7。
2. 先試內建範例，或建立自己的地圖。手動繪圖不需要 AI。要使用 AI 研究或 Coffee Tables，登入 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，再到 VAM 設定檢查 CLI。Claude Code 仍屬實驗性支援。

安裝與問題排除：[INSTALL.md](INSTALL.md) · [從 0.10.0 正式版手動安裝](https://github.com/kevcltsai/visual-agent-map/releases/tag/0.10.0)

### 你的筆記與隱私

地圖、研究筆記、Coffee Tables 對談和觀察者筆記都是 Vault 裡可閱讀的 Markdown。VAM 不含遙測，也不儲存 API key。AI 任務會透過本機 CLI 將相關內容傳送至 OpenAI 或 Anthropic；可能使用帳號額度或產生費用。AI 請求／回覆紀錄預設關閉。

<details>
<summary>本機存取與權限</summary>

CLI 繼承 Obsidian 的作業系統權限；唯讀或工具限制不等於 OS sandbox。VAM 可能讀取 Vault 的 Markdown 路徑來尋找工作區，也會探測 Vault 外的 CLI 路徑。選用的 AI 往返紀錄與暫存檔會保存在外掛資料中。VAM 不會自行安裝或更新 CLI。

</details>

#### 目前限制

僅支援桌面版，目前已驗證 macOS。Claude Code 的真實任務成功完成仍待驗證。大綱只搜尋目前地圖的議題名稱，不搜尋全文。地圖的復原／重做是暫存紀錄，切換地圖或關閉視圖後會清除。AI 回答品質取決於 CLI 與帳號。

### 支援與授權

[安裝指南](INSTALL.md) · [回報問題](https://github.com/kevcltsai/visual-agent-map/issues) · [版本紀錄](CHANGELOG.md) · [AGPL-3.0-only](LICENSE)

Copyright © 2026 Kevin Tsai
