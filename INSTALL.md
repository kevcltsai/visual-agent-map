# Install Visual Agent Map

This guide takes you from installation to your first editable VAM map. VAM is currently verified on **Obsidian Desktop 1.13.7+ for macOS**.

## What you need

- Obsidian Desktop 1.13.7 or later.
- For AI tasks only: Codex CLI and a ChatGPT account signed in through it. ChatGPT Free can use Codex, with a smaller allowance than paid plans.

VAM does not require an API key. A standalone Codex CLI installation does not require npm; Node.js and npm are only needed when building VAM from source.

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
2. Select **Duplicate to my workspace** to start from the sample, or **Create empty mind map**. You can edit either map without Codex.
3. Changing VAM's interface language also changes the built-in sample. Existing maps and notes keep their original titles and writing.

## 3. Prepare Codex for AI

1. Install the [Codex CLI](https://developers.openai.com/codex/cli/).
2. In Terminal, run `codex` and sign in with your ChatGPT account.
3. Return to VAM. In the built-in sample, select **Check Codex**. You can also use **Settings → Visual Agent Map → Recheck**.
4. Continue with an AI task when VAM reports that Codex App Server is ready.

VAM never installs or updates Codex CLI for you.

Select the star on a topic card to open **Next step** and choose an AI task. Before the first task runs, VAM shows a one-time notice that AI tasks use your signed-in account's Codex allowance. Canceling does not dismiss the notice permanently.

You are ready when you can open an editable map and use the star on a topic card to choose a Codex task and model.

## If setup does not complete

- **Codex CLI not found:** enter its executable path in **Settings → Visual Agent Map → Codex CLI path**, then select **Recheck**.
- **Authentication failure:** run `codex` in Terminal and sign in again.
- **Workspace missing:** use **Find existing Workspace** or **Repair Agent Workspace** in VAM settings. Repair does not overwrite existing notes.
- **Need diagnostics:** run **Open Debug Log** from the Obsidian Command Palette. Runtime messages stay in memory. AI request and reply logging is off by default; if you enable it in VAM settings, recent exchanges are saved in the vault's plugin folder and can be cleared.

---

# 安裝 Visual Agent Map

本指南會帶你從安裝一路完成第一張可編輯的 VAM 心智圖。VAM 目前已驗證的環境是 **macOS 上的 Obsidian Desktop 1.13.7+**。

## 需要準備

- Obsidian Desktop 1.13.7 或更新版本。
- 僅執行 AI 任務時需要 Codex CLI，以及透過它登入的 ChatGPT 帳號。ChatGPT Free 可以使用 Codex，但額度比付費方案少。

VAM 不需要 API key。使用獨立版 Codex CLI 不需要 npm；只有從原始碼建置 VAM 才需要 Node.js 與 npm。

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

1. 先探索內建唯讀範例與五步導覽。全新安裝會依 Obsidian 語言顯示繁體中文或英文；其他 Obsidian 語言先顯示英文。
2. 選擇 **複製到我的工作區**，或選擇 **建立空白心智圖**。兩者都能在沒有 Codex 的情況下編輯。
3. 切換 VAM 介面語言也會更換內建唯讀範例。既有地圖與筆記的名稱及內容不會改變。

## 3. 為 AI 任務準備 Codex

1. 安裝 [Codex CLI](https://developers.openai.com/codex/cli/)。
2. 在 Terminal 執行 `codex`，並使用 ChatGPT 帳號登入。
3. 回到 VAM，在內建範例選擇 **檢查 Codex**；也可以到 **Settings → Visual Agent Map → 重新檢查**。
4. VAM 顯示 Codex App Server 已就緒後再執行 AI 任務。

VAM 不會自行安裝或更新 Codex CLI。

點議題卡片上的星星，開啟 **下一步** 並選擇 AI 任務。第一次任務執行前，VAM 會一次性提醒 AI 任務會使用登入帳號的 Codex 額度。若取消，下一次執行仍會顯示提醒。

當你能開啟可編輯的心智圖，並從議題卡片的星星選擇 Codex 任務與模型，就代表設定完成。

## 設定沒有完成時

- **找不到 Codex CLI：** 到 **Settings → Visual Agent Map → Codex CLI 路徑** 填入執行檔路徑，再選擇 **重新檢查**。
- **登入失敗：** 在 Terminal 執行 `codex` 並重新登入。
- **Workspace 遺失：** 在 VAM settings 使用 **找回既有 Workspace** 或 **修復 Agent Workspace**。修復不會覆寫既有筆記。
- **需要診斷資訊：** 從 Obsidian Command Palette 執行 **開啟偵錯日誌 (Open Debug Log)**。一般執行訊息只保存在記憶體；AI 請求與回覆紀錄預設關閉，若於 VAM 設定啟用，最近的往返紀錄會保存在 Vault 的外掛資料夾，且可清除。
