# Install Visual Agent Map

This guide takes you from installation to your first editable VAM map. VAM is requires **Obsidian Desktop 1.13.7 or later**; the tested environment is **macOS with Obsidian 1.13.7**.

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

1. Explore the built-in read-only sample and its five-step tour. A fresh install starts in English regardless of Obsidian's language. You can choose Traditional Chinese or Simplified Chinese in VAM settings; that choice is saved across restarts. The Simplified Chinese interface uses the Traditional Chinese sample.
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

CLI detection alone does not verify authentication, organization access or structured task completion. See [Known limitations](#known-limitations).

## If setup does not complete

- **CLI not found:** enter its executable path in **Settings → Visual Agent Map**, then select **Check again** for that service.
- **Authentication failure:** run the selected CLI in Terminal and complete its sign-in flow.
- **Workspace missing:** use **Find existing Workspace** or **Repair Agent Workspace** in VAM settings. Repair does not overwrite existing notes.
- **Need diagnostics:** run **Open Debug Log** from the Obsidian Command Palette. Runtime messages stay in memory. AI request and reply logging is off by default; if you enable it in VAM settings, recent exchanges are saved in the vault's plugin folder and can be cleared.

## Data and permissions

AI actions for selected Markdown text produce editable drafts. You explicitly accept a draft before it changes a note. **Translate image** writes a translated copy into the note once you choose **Replace image** or **Add new image**; it requires Codex, sends the image data when you run it, and keeps the original image file. To stop the automatic selection button and image button, turn off **Show “Use AI on selection” automatically** in settings; the **Use AI on selection** command still works.

VAM has no telemetry and does not store API keys. AI tasks send relevant content, including research context, selected background files, or guest profiles, through your local CLI to OpenAI or Anthropic. Your provider allowance or charges may apply. AI request/reply logging is off by default; enabled logs may contain private note content.

The CLI inherits Obsidian's OS permissions; read-only or tool restrictions are not an OS sandbox. VAM may read vault Markdown paths to find its workspace and probe CLI paths outside the vault. Optional AI exchange logs and temporary files are stored in plugin data. Copy actions write requested text to the clipboard; VAM does not read clipboard contents or install/update your CLI.

## Known limitations

Desktop only; macOS with Obsidian 1.14.4 is the verified environment for AIM. Windows and Linux remain unverified.

AIM searches the web and provides source links, but finding a source does not prove its claims are true. AI judgments, unavailable sources, and account limits can leave research incomplete. Check important claims against the original sources.

Researching several topics at once uses more of your provider allowance, and a busy model can make some topics fail; retry them, for example with another model. A content template that requires an item count can send one extra AI request to fix the count.

Images found by AI web search may not be free to reuse; check each source page. Outline search covers titles in the current map, not full text. Map undo/redo is temporary and clears when you switch maps or close the view.

New mind maps are created in `Mind Maps/` and new AIM maps in `AIM/` inside your workspace folder (both names can be changed in settings, which renames the existing folder and closes the Settings window while it runs; Obsidian may ask about links for each map). Existing maps in `Topics/` keep working where they are; VAM never moves them on its own. To move them, run the command "Organize workspace folders", which shows a preview first and restores everything if a step fails. The Inbox is no longer managed: notes in an existing `Inbox/` folder are left untouched. When "Organize workspace folders" leaves the legacy `Topics/` folder or the `Inbox/` folder completely empty, it moves that empty folder to the trash (following your Obsidian trash setting); a folder that still contains anything is never touched. Maps saved with the pre-0.4 structure (outside these folders) can still be opened and viewed, but cannot be renamed, edited structurally, or organized. If Obsidian is closed or VAM is disabled while a move is running, some maps may be left in their new folder with outdated links inside VAM; run "Refresh VAM data" (it repairs those paths first) or start "Organize workspace folders" again.

Coffee Tables stores what it needs to continue a conversation in the hidden `Coffee Tables/.sessions` folder. Obsidian Sync skips hidden folders, so on other devices you can read synced conversations but not continue them; continue them on the device where they started.

---

# 安裝 Visual Agent Map

本指南會帶你從安裝一路完成第一張可編輯的 VAM 心智圖。VAM 需要 **Obsidian Desktop 1.13.7 或更新版本**；實際驗證環境為 **macOS 上的 Obsidian 1.13.7**。

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

1. 先探索內建唯讀範例與五步導覽。全新安裝預設英文，與 Obsidian 語言無關；可在 VAM 設定選擇繁體中文或簡體中文，選擇會跨重啟保留。簡體中文介面使用繁體中文版範例。
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

偵測到 CLI 不代表登入、組織權限或結構化任務已通過。請參閱 [已知限制](#已知限制)。

## 設定沒有完成時

- **找不到 CLI：** 到 **Settings → Visual Agent Map** 填入該服務的執行檔路徑，再選擇該服務的 **重新檢查**。
- **登入失敗：** 在 Terminal 執行所選 CLI 並完成登入。
- **Workspace 遺失：** 在 VAM settings 使用 **找回既有 Workspace** 或 **修復 Agent Workspace**。修復不會覆寫既有筆記。
- **需要診斷資訊：** 從 Obsidian Command Palette 執行 **開啟偵錯日誌 (Open Debug Log)**。一般執行訊息只保存在記憶體；AI 請求與回覆紀錄預設關閉，若於 VAM 設定啟用，最近的往返紀錄會保存在 Vault 的外掛資料夾，且可清除。

## 資料與權限

選取 Markdown 文字的 AI 操作會產生可編輯草稿，你必須明確接受草稿，才會改動筆記。「生成翻譯圖片」在你選擇「取代原圖」或「新增一張」後，會把翻譯版圖片寫入筆記；它需要 Codex，執行時才傳送圖片資料，原始圖片檔保持不變。若不想在選取文字或點選圖片時自動出現 AI 按鈕，可在設定關閉「自動顯示『用 AI 處理選取文字』」；「用 AI 處理選取文字」命令仍可使用。

VAM 不含遙測，也不儲存 API key。AI 任務會透過本機 CLI 將相關內容，包括研究脈絡、選取的背景檔或來賓設定，傳送至 OpenAI 或 Anthropic，可能使用帳號額度或產生費用。AI 請求／回覆紀錄預設關閉；啟用後的紀錄可能包含私人筆記。

CLI 繼承 Obsidian 的作業系統權限；唯讀或工具限制不等於 OS sandbox。VAM 可能讀取 Vault 的 Markdown 路徑來尋找工作區，也會探測 Vault 外的 CLI 路徑。選用的 AI 往返紀錄與暫存檔會保存在外掛資料中。複製操作只將指定文字寫入剪貼簿；VAM 不讀取剪貼簿內容，也不會自行安裝或更新 CLI。

## 已知限制

僅支援桌面版；AIM 已驗證環境為 macOS 與 Obsidian 1.14.4。Windows 與 Linux 尚未驗證。

AIM 會搜尋網路並提供來源連結，但找到來源不代表內容已證實。AI 判斷、無法存取的來源與帳號額度，都可能讓研究未能完成。重要主張請回到原始來源核對。

同時研究多個議題會用掉較多額度，模型忙碌時部分議題可能失敗，可以重試，例如換一個模型。內容模板設定了項目數時，可能多送一次 AI 請求來修正數量。

AI 從網路找到的圖片不一定能自由使用，請查看各自的來源頁。大綱只搜尋目前地圖的議題名稱，不搜尋全文。地圖的復原／重做是暫存紀錄，切換地圖或關閉視圖後會清除。

新的心智圖會建立在工作區資料夾內的 `Mind Maps/`，新的 AIM 會建立在 `AIM/`（資料夾名稱可在設定中修改，會一併重新命名既有資料夾，執行時設定視窗會關閉，Obsidian 可能會逐份詢問連結處理方式）。`Topics/` 內既有的地圖維持原位、照常可用；VAM 不會自行搬動它們。要搬移請執行「整理工作區資料夾」指令，它會先顯示預覽，任一步失敗會還原全部。收件匣（Inbox）不再由 VAM 管理：既有 `Inbox/` 內的筆記原封不動。當「整理工作區資料夾」讓舊的 `Topics/` 或 `Inbox/` 資料夾完全清空時，會把該空資料夾移到垃圾桶（依你的 Obsidian 垃圾桶設定）；仍有任何內容的資料夾絕不會被動到。以 0.4 前舊結構儲存的地圖（不在上述資料夾內）仍可開啟與檢視，但不能改名、不能修改結構，也不會被整理。若搬移進行中關閉了 Obsidian 或停用了 VAM，部分地圖可能已在新資料夾但 VAM 內的路徑尚未更新；請執行「重新整理 VAM 資料」（會先修復這些路徑），或再次執行「整理工作區資料夾」。

Coffee Tables 把接續對談所需的資料存在隱藏資料夾 `Coffee Tables/.sessions`。Obsidian Sync 不同步隱藏資料夾，因此在其他裝置上可以閱讀同步過去的對談，但無法接著聊；請回到開始對談的裝置繼續。
