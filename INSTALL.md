# Install Visual Agent Map

This guide takes you from installation to your first editable VAM map. VAM is currently verified on **Obsidian Desktop 1.13.7+ for macOS**.

## What you need

- Obsidian Desktop 1.13.7 or later.
- For AI tasks only: install either the [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview), then sign in with its corresponding account. You may install both and choose a model per topic.

VAM does not require its own API key. Standalone CLI installations do not require npm; Node.js and npm are only needed when building VAM from source.

## 1. Install VAM

### From Obsidian Community plugins

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse**, search for **Visual Agent Map**, then select **Install**.
3. Select **Enable**.

### From a GitHub Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the same [Visual Agent Map release](https://github.com/kevcltsai/visual-agent-map/releases).
2. Place all three files in `<your-vault>/.obsidian/plugins/visual-agent-map/`.
3. Reload Obsidian, then enable **Visual Agent Map** under **Settings → Community plugins**.

Do not install files from the repository's `main` branch into a production vault.

## 2. Start your first map

1. Explore the built-in read-only sample and its five-step tour. A fresh install starts in English regardless of Obsidian's language. You can choose Traditional Chinese in VAM settings; that choice is saved across restarts.
2. Select **Duplicate to my workspace** to start from the sample, or **Create empty mind map**. You can edit either map without an AI service.
3. Changing VAM's interface language also changes the built-in sample. Existing maps and notes keep their original titles and writing.

## 3. Prepare an AI service

1. Install either the [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).
2. Open the CLI in Terminal and complete sign-in with the corresponding account.
3. Return to VAM and open **Settings → Visual Agent Map**. Check or set the installed CLI path and use **Check again**.
4. Select a topic's star, then choose an available provider model. The task keeps that provider for its full run; it will not switch providers automatically.

VAM never installs or updates either CLI for you. At least one provider must be installed; the other can remain unavailable.

Before a provider's first AI task, VAM shows a one-time notice that usage may count against that account's allowance. Canceling keeps the notice for next time.

You are ready when an available model appears in the topic task dialog and can complete a task.

Claude Code is experimental; successful live tasks remain unverified. CLI detection alone does not verify authentication, organization access or structured task completion. See the [current limitations](README.md#current-limitations).

## If setup does not complete

- **CLI not found:** enter its executable path in **Settings → Visual Agent Map**, then select **Check again** for that service.
- **Authentication failure:** run the selected CLI in Terminal and complete its sign-in flow.
- **Workspace missing:** use **Find existing Workspace** or **Repair Agent Workspace** in VAM settings. Repair does not overwrite existing notes.
- **Need diagnostics:** run **Open Debug Log** from the Obsidian Command Palette. Runtime messages stay in memory. AI request and reply logging is off by default; if you enable it in VAM settings, recent exchanges are saved in the vault's plugin folder and can be cleared.

---

# 安裝 Visual Agent Map

本指南會帶你從安裝一路完成第一張可編輯的 VAM 心智圖。VAM 目前已驗證的環境是 **macOS 上的 Obsidian Desktop 1.13.7+**。

## 需要準備

- Obsidian Desktop 1.13.7 或更新版本。
- 僅執行 AI 任務時需要安裝 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，並使用對應帳號登入。兩者都安裝時，可在每個議題選擇模型。

VAM 不需要專屬 API key。獨立 CLI 不需要 npm；只有從原始碼建置 VAM 才需要 Node.js 與 npm。

## 1. 安裝 VAM

### 從 Obsidian Community plugins 安裝

1. 在 Obsidian 開啟 **Settings → Community plugins**。
2. 選擇 **Browse**，搜尋 **Visual Agent Map**，再選擇 **Install**。
3. 選擇 **Enable**。

### 從 GitHub Release 安裝

1. 從同一個 [Visual Agent Map release](https://github.com/kevcltsai/visual-agent-map/releases) 下載 `main.js`、`manifest.json`、`styles.css`。
2. 把三個檔案放進 `<你的-vault>/.obsidian/plugins/visual-agent-map/`。
3. 重新載入 Obsidian，然後到 **Settings → Community plugins** 啟用 **Visual Agent Map**。

正式使用時，不要從 repository 的 `main` branch 安裝檔案。

## 2. 開始第一張心智圖

1. 先探索內建唯讀範例與五步導覽。全新安裝預設英文，與 Obsidian 語言無關；可在 VAM 設定選擇繁體中文，選擇會跨重啟保留。
2. 選擇 **複製到我的工作區**，或選擇 **建立空白心智圖**。沒有 AI 服務也能編輯。
3. 切換 VAM 介面語言也會更換內建唯讀範例。既有地圖與筆記的名稱及內容不會改變。

## 3. 為 AI 任務準備服務

1. 安裝 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)。
2. 在 Terminal 開啟安裝的 CLI，並依照流程使用對應帳號登入。
3. 回到 VAM，開啟 **Settings → Visual Agent Map**，確認該服務的 CLI 路徑並選擇 **重新檢查**。
4. 點議題卡片上的星星，從可用模型中選擇服務。任務執行期間固定使用這個服務，不會自動切換。

VAM 不會自行安裝或更新任一 CLI；至少需要一個服務，另一個可未安裝。

第一次使用各服務執行 AI 任務前，VAM 會提醒可能使用該登入帳號的額度。若取消，下一次使用該服務時仍會顯示提醒。

當議題任務視窗列出一個可用模型，且能完成任務，就代表設定完成。

Claude Code 目前屬實驗性支援，成功真實任務仍待驗證。偵測到 CLI 不代表登入、組織權限或結構化任務已通過。請參閱 [目前限制](README.md#目前限制)。

## 設定沒有完成時

- **找不到 CLI：** 到 **Settings → Visual Agent Map** 填入該服務的執行檔路徑，再選擇該服務的 **重新檢查**。
- **登入失敗：** 在 Terminal 執行所選 CLI 並完成登入。
- **Workspace 遺失：** 在 VAM settings 使用 **找回既有 Workspace** 或 **修復 Agent Workspace**。修復不會覆寫既有筆記。
- **需要診斷資訊：** 從 Obsidian Command Palette 執行 **開啟偵錯日誌 (Open Debug Log)**。一般執行訊息只保存在記憶體；AI 請求與回覆紀錄預設關閉，若於 VAM 設定啟用，最近的往返紀錄會保存在 Vault 的外掛資料夾，且可清除。
