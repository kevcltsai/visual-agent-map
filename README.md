# Visual Agent Map

Turn complex questions into a visual research map while keeping every result in editable Markdown.

[English](#english) · [繁體中文](#繁體中文)

![Visual Agent Map overview](assets/screenshots/map-overview.png)

## English

Visual Agent Map is a desktop-only Obsidian plugin for breaking a broad question into connected topics, running focused AI research tasks, and preserving the results as ordinary Markdown notes.

The map shows the structure and current understanding at a glance. The underlying notes remain readable, editable, and portable even without the plugin.

### Highlights

- **Visual topic map** — create root topics and subtopics, drag nodes, collapse branches, zoom, and change parent relationships.
- **Focused topic workspace** — keep a concise current understanding, reusable AI rules, and the next task beside each node.
- **AI-assisted research** — research, compare, check risks, break down a topic, or synthesize findings from child topics.
- **Markdown-first storage** — each node is a normal Markdown note; the map structure is stored in `Map.md`.
- **Knowledge organization** — remove notes from the map without deleting them, then reclaim, archive, or move them later.
- **Safer editing** — session undo/redo, conflict handling, and migration previews help protect existing notes.
- **Local credentials** — the plugin uses locally signed-in Codex or Claude Code tools and does not store API keys.

![Topic workspace and Markdown detail](assets/screenshots/topic-workspace.png)

### How it works

1. Create a mind map for a research subject.
2. Add topics and subtopics to define the questions you want to answer.
3. Run a focused AI task from a topic.
4. Review the short summary on the map and the full result in its Markdown note.
5. Continue expanding or synthesize related findings into a new topic.

### Requirements

- Obsidian desktop `1.12.7` or later.
- A local Codex installation signed in to your account. Codex models use [`codex-acp`](https://github.com/agentclientprotocol/codex-acp), with Codex CLI as the fallback.
- Optional: a signed-in Claude Code CLI for `claude:*` models.
- These are the only supported AI execution backends: `codex-acp`, Codex CLI, and Claude Code CLI.
- Current version: `0.4.1`. It has been tested on macOS; other desktop platforms may require custom executable paths.

### Install

**With a coding agent:** copy the entire contents of [INSTALL.md](INSTALL.md) into an LLM or coding agent. It is written as an executable installation request for a clean environment.

**Manually:**

1. Download these three files from [`visual-agent-map/`](visual-agent-map/):
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Create `<your-vault>/.obsidian/plugins/visual-agent-map/`.
3. Put the three files in that folder.
4. Reload Obsidian, open **Settings → Community plugins**, and enable **Visual Agent Map**.
5. In the plugin settings, confirm the paths to `codex-acp`, Codex CLI, or Claude Code CLI for the providers you use.

Do not copy the whole repository into the Obsidian plugin folder and do not run `npm install` there. The repository already contains the built plugin.

### Quick start

1. Open **Visual Agent Map** from the Obsidian ribbon.
2. Select **+ Mind map** and name the research subject.
3. Select **+ Topic**, then add subtopics from the topic workspace.
4. Choose a next step to run an AI task.
5. Open the detail button on a node to read or edit the complete Markdown note.

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

Plugin-created maps and notes stay inside the vault. Back up the vault before testing any plugin that modifies files.

### Privacy and network access

- The plugin has no telemetry and does not store API keys.
- External AI tools start only after you run an AI task. The selected topic, relevant note content, instructions, and task are passed to the configured local CLI, which may communicate with OpenAI or Anthropic using your signed-in account.
- The plugin executes the configured `codex-acp`, Codex CLI, or Claude Code CLI binary outside the vault. Codex CLI fallback may create `response-schema.json` inside the plugin folder from a schema bundled in `main.js`.
- AI results can include remote image and source URLs. Opening notes that contain those images may contact the third-party image hosts.

### Build from source

Run `npm ci`, `npm run build`, and `npm test` from the repository root. The production bundle is written to `visual-agent-map/main.js`.

### Development

This project was developed with Codex.

### Current limitations

- Desktop only.
- Not yet distributed through the Obsidian community plugin catalog.
- Automatic layout, node search, multiple parents, and persistent task history are not included in this release.
- Undo/redo history lasts only for the current Obsidian session.

---

## 繁體中文

Visual Agent Map 是一個桌面版 Obsidian 外掛，用視覺化心智圖拆解複雜問題、執行聚焦的 AI 研究任務，並將結果保存在一般 Markdown 筆記中。

心智圖讓你快速看懂問題結構與目前結論；即使不使用外掛，底層筆記仍然可以直接閱讀、編輯及搬移。

### 主要功能

- **視覺化議題地圖**：建立根議題與子議題、拖曳節點、收合分支、縮放，以及調整母子關係。
- **議題工作台**：在每個節點旁管理目前理解、可重複使用的 AI 規則與下一步任務。
- **AI 輔助研究**：進行研究、比較、風險檢查、議題拆解，以及整合子議題發現。
- **Markdown 優先**：每個節點都是普通 Markdown 筆記，圖面結構保存在 `Map.md`。
- **知識整理**：從圖上移除筆記時不刪除內容，之後仍可認領、封存或移至其他主題。
- **安全編輯**：工作階段復原／重做、外部修改衝突處理與遷移預覽，降低破壞既有筆記的風險。
- **使用本機登入狀態**：透過本機已登入的 Codex 或 Claude Code 工具執行，不儲存 API key。

### 使用流程

1. 為研究主題建立一張心智圖。
2. 加入議題與子議題，定義想回答的問題。
3. 從任一議題執行聚焦的 AI 任務。
4. 在圖上查看短摘要，並在 Markdown 筆記閱讀完整結果。
5. 繼續展開研究，或把相關發現整合成新的議題。

### 系統需求

- Obsidian 桌面版 `1.12.7` 或更新版本。
- 已安裝並登入本機 Codex；Codex 模型主要透過 [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) 執行，失敗時改用 Codex CLI。
- 選用：使用 `claude:*` 模型時需要已登入的 Claude Code CLI。
- 目前只支援三種 AI 執行後端：`codex-acp`、Codex CLI、Claude Code CLI。
- 目前版本為 `0.4.1`，已在 macOS 驗證；其他桌面平台可能需要自行設定執行檔路徑。

### 安裝

**使用 coding agent：** 將 [INSTALL.md](INSTALL.md) 的完整內容貼給 LLM 或 coding agent。該檔案是一份可在乾淨環境執行的安裝需求。

**手動安裝：**

1. 從 [`visual-agent-map/`](visual-agent-map/) 下載三個檔案：`main.js`、`manifest.json`、`styles.css`。
2. 建立 `<你的-vault>/.obsidian/plugins/visual-agent-map/`。
3. 將三個檔案放入該資料夾。
4. 重新載入 Obsidian，在 **設定 → 第三方外掛** 啟用 **Visual Agent Map**。
5. 在外掛設定確認你所使用 provider 的 `codex-acp`、Codex CLI 或 Claude Code CLI 路徑。

不要把整個 repository 複製到 Obsidian 外掛資料夾，也不要在外掛資料夾執行 `npm install`；repository 已包含建置完成的外掛。

### 快速開始

1. 從 Obsidian 左側工具列開啟 **Visual Agent Map**。
2. 選擇 **＋ 心智圖**，輸入研究主題。
3. 選擇 **＋ 議題**，再從議題工作台新增子議題。
4. 選擇下一步並執行 AI 任務。
5. 點擊節點的詳情按鈕，閱讀或編輯完整 Markdown 筆記。

### 資料保存

外掛建立的心智圖與筆記都保存在 Vault 內的 `Agent Workspace/`。測試任何會修改檔案的外掛前，仍建議先備份 Vault。

### 隱私與網路連線

- 外掛不包含遙測，也不儲存 API key。
- 只有在你執行 AI 任務後，外掛才會啟動外部 AI 工具。選取的議題、相關筆記內容、指示與任務會傳給設定的本機 CLI；CLI 可能使用你的登入帳號與 OpenAI 或 Anthropic 通訊。
- 外掛會執行 Vault 外的 `codex-acp`、Codex CLI 或 Claude Code CLI。Codex CLI fallback 可能依照 `main.js` 內嵌的 schema，在外掛資料夾建立 `response-schema.json`。
- AI 結果可能包含遠端圖片與來源網址。開啟含有這些圖片的筆記時，可能會連線到第三方圖片主機。

### 從原始碼建置

在 repository 根目錄執行 `npm ci`、`npm run build` 與 `npm test`。正式 bundle 會輸出至 `visual-agent-map/main.js`。

### 開發說明

本專案使用 Codex 開發。

### 目前限制

- 僅支援桌面版。
- 尚未上架 Obsidian 第三方外掛目錄。
- 本版尚未包含自動排列、節點搜尋、多母議題及永久任務歷史。
- 復原／重做紀錄只保留在目前 Obsidian 工作階段。

## License

Copyright © 2026 Kevin Tsai.

This project is licensed under the GNU Affero General Public License
Version 3 (AGPL-3.0-only).

See the [LICENSE](LICENSE) file for details.
