# Visual Agent Map

Turn complex questions into a visual research map while keeping every result in editable Markdown.

[English](#english) · [繁體中文](#繁體中文)

![Visual Agent Map overview](assets/screenshots/map-overview.png)

## English

Visual Agent Map is a desktop-only Obsidian plugin for breaking a broad question into connected topics, running focused Codex tasks, and preserving the results as ordinary Markdown notes. The map shows structure and current understanding at a glance; notes remain readable, editable, and portable without the plugin.

This project is developed with [OpenAI Codex](https://openai.com/codex/) as a coding collaborator. Product direction, design decisions, validation, and releases are managed by the maintainer.

### Highlights

- **Visual topic map** — create topics and subtopics, drag nodes, collapse branches, zoom, and change parent relationships.
- **Topic card actions** — open a topic's Markdown note from its card, start an AI task with the star, or edit structure and links with the gear.
- **Three AI paths** — research one topic, preview suggested subtopics, or review a synthesis draft before saving.
- **Markdown-first storage** — each topic is a normal Markdown note; the map structure is stored in `Map.md`.
- **Knowledge organization** — remove notes from a map without deleting them; reclaim, archive, or move them later.
- **Safer editing** — previewed migration, conflict handling, and session undo/redo protect existing work.
- **Built-in sample** — explore a read-only Taiwan travel map, then duplicate it into an editable workspace.
- **Debug log** — inspect runtime diagnostics; optionally record AI requests and replies in the vault's plugin data.
- **Local credentials** — uses locally signed-in Codex tools and never stores API keys.

### How it works

1. Create a mind map for a research subject.
2. Add topics and subtopics to define the questions to answer.
3. Choose and confirm a focused Codex task.
4. Review the summary on the map and the full Markdown detail.
5. Continue research or synthesize related findings into a new topic.

Research and map expansion use web-enabled Codex tasks. Synthesis uses direct child topics and any Markdown notes selected for that run; it does not request web search. Fast, Normal and Deep set research depth separately from Codex reasoning effort. While a node task is running, **Stop research** interrupts its Codex turn and preserves the existing note.

### What's new in 0.9.2

- Editing the main Markdown heading of a topic note now updates the title on its map card.

See [CHANGELOG.md](CHANGELOG.md) for the complete version history.

### Requirements

- Obsidian desktop `1.13.7` or later (the verified compatibility baseline for this release).
- A local [Codex CLI](https://developers.openai.com/codex/cli/) installation signed in with ChatGPT. ChatGPT Free is supported with a smaller Codex allowance. Visual Agent Map does not require an API key; npm is only needed to build from source.
- Desktop only. Current release: `0.9.2`.

### Install

Install **Visual Agent Map** from Obsidian's Community plugins browser. For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub Release](https://github.com/kevcltsai/visual-agent-map/releases); do not install from a branch.

1. Create `<your-vault>/.obsidian/plugins/visual-agent-map/`.
2. Place the three release assets in that folder, preserving an existing `data.json`.
3. Reload Obsidian and enable **Visual Agent Map** under **Settings → Community plugins**.
4. Confirm the Codex CLI path and App Server status in plugin settings.

Do not copy the repository or run `npm install` inside the plugin directory. Follow [INSTALL.md](INSTALL.md) for the complete first-use journey.

### Vault data

```text
Agent Workspace/
├── Topics/
│   └── <topic>/
│       ├── Map.md
│       ├── Notes/
│       ├── Unassigned/
│       └── Archive/
└── Inbox/
```

Plugin-created content stays in the vault. A fresh installation creates the empty workspace structure and opens the read-only built-in sample; uninstalling the plugin does not delete workspace content.

### Privacy and network access

- No telemetry and no stored API keys.
- Before the first AI task, VAM shows a one-time notice that the task uses the signed-in account's Codex allowance. Relevant topic content, instructions, the task, and excerpts from sources selected for that run are then sent to the locally signed-in Codex tool.
- AI request and reply logging is off by default. When enabled, recent exchanges are saved in the vault's plugin folder for inspection and can be cleared.
- The plugin starts `codex app-server` outside the vault with read-only sandboxing and no command or file-change approvals; it never installs or updates Codex CLI.
- Remote images in Markdown follow Obsidian's ordinary image-loading behavior.

### Current limitations

- Desktop only; available through the Obsidian Community Plugin catalog.
- No node search, multiple parents, or persistent task history.
- Undo/redo lasts for the current Obsidian session.

### Build from source

Run `npm ci`, `npm run build`, and `npm test` at the repository root. The production assets are `main.js`, `manifest.json`, and `styles.css`.

---

## 繁體中文

Visual Agent Map 是桌面版 Obsidian 外掛：用視覺化心智圖拆解複雜問題、執行聚焦的 Codex 任務，並將所有結果保存為一般 Markdown 筆記。

心智圖讓你快速掌握研究結構與目前結論；即使不使用外掛，底層筆記仍可直接閱讀、編輯與搬移。

本專案使用 [OpenAI Codex](https://openai.com/codex/) 協助開發；產品方向、設計決策、驗證與發布由維護者負責。

### 主要功能

- **視覺化議題地圖**：建立議題與子議題、拖曳節點、收合分支、縮放，以及調整母子關係。
- **議題卡片操作**：點卡片開啟 Markdown 筆記，以星星啟動 AI 任務，或用齒輪編輯結構與連結。
- **三種 AI 路徑**：研究單一議題、預覽子議題建議，或檢查整合草稿再儲存。
- **Markdown 優先**：每個節點都是普通 Markdown 筆記，圖面結構保存在 `Map.md`。
- **知識整理**：從圖上移除筆記不會刪除內容，之後仍可認領、封存或移至其他主題。
- **安全編輯**：遷移預覽、衝突處理與工作階段復原／重做，降低影響既有資料的風險。
- **內建範例**：可瀏覽唯讀的台灣旅遊心智圖，再複製成自己的可編輯版本。
- **偵錯日誌**：可查看執行記錄；啟用後也可在 Vault 的外掛資料中記錄 AI 請求與回覆。
- **使用本機登入狀態**：使用本機已登入的 Codex 工具，不儲存 API key。

### 使用方式

1. 為研究主題建立一張心智圖。
2. 新增議題與子議題，定義需要回答的問題。
3. 選擇並確認一項聚焦的 Codex 任務。
4. 在心智圖查看摘要，在 Markdown 筆記閱讀完整內容。
5. 繼續研究，或將相關發現整合成新的議題。

研究與展開地圖使用可搜尋網頁的 Codex 任務。整合發現使用直屬子議題和本次選取的 Markdown 筆記，不要求網頁搜尋。快速／標準／深入研究深度與 Codex 推理等級分開設定。節點任務執行中可按「停止研究」，保留原筆記。

### 0.9.2 更新內容

- 修改議題筆記的 Markdown 主標題後，心智圖上的卡片標題會同步更新。

完整版本紀錄請見 [CHANGELOG.md](CHANGELOG.md)。

### 系統需求

- Obsidian 桌面版 `1.13.7` 或更新版本（本版本實際驗證的相容性基線）。
- 已在本機安裝 [Codex CLI](https://developers.openai.com/codex/cli/) 並以 ChatGPT 登入。ChatGPT Free 可以使用，但 Codex 額度較少。Visual Agent Map 不需要 API key；只有從原始碼建置才需要 npm。
- 僅支援桌面版。目前版本：`0.9.2`。

### 安裝

請先從 Obsidian 的第三方外掛瀏覽器安裝 **Visual Agent Map**。若要手動安裝，請從同一個 [GitHub Release](https://github.com/kevcltsai/visual-agent-map/releases) 下載 `main.js`、`manifest.json`、`styles.css`；不要使用 branch 檔案。

1. 建立 `<你的-vault>/.obsidian/plugins/visual-agent-map/`。
2. 放入三個 release assets，並保留既有的 `data.json`。
3. 重新載入 Obsidian，在 **設定 → 第三方外掛** 啟用 **Visual Agent Map**。
4. 在外掛設定確認 Codex CLI 路徑與 App Server 狀態。

不要把整個 repository 複製到外掛資料夾，也不要在該資料夾執行 `npm install`。完整首次使用旅程請見 [INSTALL.md](INSTALL.md)。

### Vault 資料

```text
Agent Workspace/
├── Topics/
│   └── <topic>/
│       ├── Map.md
│       ├── Notes/
│       ├── Unassigned/
│       └── Archive/
└── Inbox/
```

外掛建立的資料保存在 Vault 的 `Agent Workspace/`。全新安裝只建立空的基本結構並開啟唯讀內建範例；卸載外掛不會刪除 Workspace 內容。

### 隱私與網路存取

- 不含 telemetry，也不儲存 API key。
- 第一次執行 AI 任務前，VAM 會一次性提醒該任務會使用登入帳號的 Codex 額度，之後才會把相關議題內容、指令、任務與本次選取來源的摘錄交給本機已登入的 Codex 工具。
- AI 請求與回覆紀錄預設關閉；啟用後，最近的往返紀錄保存在 Vault 的外掛資料夾，可查看與清除。
- 外掛會在 Vault 外以唯讀 sandbox、禁止 command／file-change approval 的設定啟動 `codex app-server`，但不會自行安裝或更新 Codex CLI。
- Markdown 的遠端圖片會依 Obsidian 一般行為連線至對應圖片來源。

### 目前限制

- 僅支援桌面版，已上架 Obsidian Community Plugin catalog。
- 尚未包含節點搜尋、多母議題與永久任務歷史。
- 復原／重做只保留在目前 Obsidian 工作階段。

### 從原始碼建置

在 repository 根目錄執行 `npm ci`、`npm run build` 與 `npm test`。正式產物為 `main.js`、`manifest.json`、`styles.css`。

## License

Copyright © 2026 Kevin Tsai.

This project is licensed under the GNU Affero General Public License Version 3 (AGPL-3.0-only). See [LICENSE](LICENSE).
