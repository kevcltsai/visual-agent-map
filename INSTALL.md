# Install Visual Agent Map

This guide takes you from installation to your first editable VAM map. VAM requires **Obsidian Desktop 1.13.7 or later**; the tested environment is **macOS with Obsidian 1.13.7**.

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
4. Select a topic's star, then choose an available provider model (Claude models include Haiku). A topic pinned to one model can return to the workspace or upper-topic model with **Follow default**. The task keeps that provider for its full run; it will not switch providers automatically.

VAM never installs or updates either CLI for you. At least one provider must be installed; the other can remain unavailable.

Before a provider's first AI task, VAM shows a one-time notice that usage may count against that account's allowance. Canceling keeps the notice for next time.

You are ready when an available model appears in the topic task dialog and can complete a task.

CLI detection alone does not verify authentication, organization access or structured task completion. See [Known limitations](#known-limitations).

## Talk to your map

A map has an AI chat window on its left side (open or close it from the map view, or run **Toggle the map AI chat**; assign a shortcut in Obsidian's hotkey settings if you want one). Use it to ask about the map or to change it in plain language: build a map from one sentence, edit and move topics, run Quick or Standard research, expand, integrate, find pictures for a topic, or edit notes you point it to. Large requests (more than 15 actions, deleting a branch, research on 10 or more topics, a new map) appear as a plan that does nothing until you choose **Apply**. Changes the chat applies from a reply cannot be undone. **Save the chat as a note** writes the conversation to `Chats/` in the map's folder.

Research and expansion have two AI modes. **Quick** answers from the model's knowledge and your sources without the web. **Standard** searches the web and may add images. Use Standard once the structure is settled or when the topic is new or obscure.

## Share a map

Open a mind map and choose **Share this map** (command or button). VAM saves one HTML file that opens in any browser, even offline (images that link to the web need a connection); you choose where it is saved. The dialog lets you leave out full notes or images, and AI can add translated versions (needs Codex or Claude Code). Before saving, VAM checks the file for private information such as your vault's location or `[[note links]]`, and saves nothing if it finds any. **Copy the GitHub publishing instructions** only copies text for you to paste into your own Claude Code or Codex. See [Known limitations](#known-limitations) for what is not shared.

## If setup does not complete

- **CLI not found:** enter its executable path in **Settings → Visual Agent Map**, then select **Check again** for that service.
- **Authentication failure:** run the selected CLI in Terminal and complete its sign-in flow.
- **Workspace missing:** use **Find existing Workspace** or **Repair Agent Workspace** in VAM settings. Repair does not overwrite existing notes.
- **Need diagnostics:** run **Open Debug Log** from the Obsidian Command Palette. Runtime messages stay in memory. AI request and reply logging is off by default; if you enable it in VAM settings, recent exchanges are saved in the vault's plugin folder and can be cleared.

## Data and permissions

AI actions for selected Markdown text produce editable drafts. You explicitly accept a draft before it changes a note. **Translate image** writes a translated copy into the note once you choose **Replace image** or **Add new image**; it requires Codex, sends the image data when you run it, and keeps the original image file. To stop the automatic selection button and image button, turn off **Show “Use AI on selection” automatically** in settings; the **Use AI on selection** command still works.

VAM has no telemetry and does not store API keys. AI tasks send relevant content, including research context, selected background files, or guest profiles, through your local CLI to OpenAI or Anthropic. The map AI chat also sends the map outline, the titles of your other maps, the cards you select or reference, the note open beside the map in full (shown as a chip you can remove), notes and text you drop in, and the last few messages; the chat can edit those notes and create new Markdown notes in your vault, but not inside the Obsidian settings folder. Your provider allowance or charges may apply. AI request/reply logging is off by default; enabled logs may contain private note content.

The CLI inherits Obsidian's OS permissions; read-only or tool restrictions are not an OS sandbox. VAM runs the CLI program you installed, and when you use AIM, Standard research or picture search that program searches the web for you (Quick mode does not). Thumbnails of picture candidates are loaded from their websites. VAM may read vault Markdown paths to find its workspace and probe CLI paths outside the vault. Share files are written only where you choose in the save window; VAM never uploads them. Optional AI exchange logs and temporary files are stored in plugin data. Copy actions write requested text to the clipboard; VAM does not read clipboard contents or install/update your CLI.

## Known limitations

Desktop only; macOS with Obsidian 1.14.4 is the verified environment for AIM. Windows and Linux remain unverified.

AIM searches the web and provides source links, but finding a source does not prove its claims are true. AI judgments, unavailable sources, and account limits can leave research incomplete. Check important claims against the original sources.

Researching several topics at once uses more of your provider allowance, and a busy model can make some topics fail; retry them, for example with another model. A content template that requires an item count can send one extra AI request to fix the count.

Images found by AI web search may not be free to reuse; check each source page. Outline search covers titles in the current map, not full text. Map undo/redo is temporary and clears when you switch maps or close the view.

New mind maps are created in `Mind Maps/` and new AIM maps in `AIM/` inside your workspace folder (both names can be changed in settings, which renames the existing folder and closes the Settings window while it runs; Obsidian may ask about links for each map). Existing maps in `Topics/` keep working where they are; VAM never moves them on its own. To move them, run the command "Organize workspace folders", which shows a preview first and restores everything if a step fails. The Inbox is no longer managed: notes in an existing `Inbox/` folder are left untouched. When "Organize workspace folders" leaves the legacy `Topics/` folder or the `Inbox/` folder completely empty, it moves that empty folder to the trash (following your Obsidian trash setting); a folder that still contains anything is never touched. Maps saved with the pre-0.4 structure (outside these folders) can still be opened and viewed, but cannot be renamed, edited structurally, or organized. If Obsidian is closed or VAM is disabled while a move is running, some maps may be left in their new folder with outdated links inside VAM; run "Refresh VAM data" (it repairs those paths first) or start "Organize workspace folders" again.

Map AI chat: tested live with Claude only; Codex was not tested live in the chat. A picture you inserted and one that could not load look alike, and the result line for a picture search says it started even if the search later finds nothing. Changes the chat applies from a reply cannot be undone. English and Simplified Chinese chat screens, pop-out windows and Windows or Linux were not checked.

Share files: AIM research maps and the built-in sample cannot be shared yet, and web images are not embedded: they keep their original address and are shown only when the reader is online. Translations are made by AI and their quality is not checked by a native speaker. iOS cannot open a local HTML file, so view a shared file on a phone through a web address such as GitHub Pages. Opening a share file from a local file on desktop Safari was not tested.

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
4. 點議題卡片上的星星，從可用模型中選擇服務（Claude 模型包含 Haiku）。釘選在某個模型的議題，可用「跟隨預設」回到工作區或上層議題的模型。任務執行期間固定使用這個服務，不會自動切換。

VAM 不會自行安裝或更新任一 CLI；至少需要一個服務，另一個可未安裝。

第一次使用各服務執行 AI 任務前，VAM 會提醒可能使用該登入帳號的額度。若取消，下一次使用該服務時仍會顯示提醒。

當議題任務視窗列出一個可用模型，且能完成任務，就代表設定完成。

偵測到 CLI 不代表登入、組織權限或結構化任務已通過。請參閱 [已知限制](#已知限制)。

## 對地圖說話

地圖左側有 AI 對話視窗（可在地圖視圖開關，或執行「開關心智圖 AI 對話」指令；想用快捷鍵請到 Obsidian 的快捷鍵設定自行指定）。可以用一般的話提問或修改地圖：一句話建出整張地圖、編輯與移動議題、執行快速或標準研究、展開、整合、為議題找圖，或修改你指定的筆記。較大的要求（超過 15 個動作、刪除整個分支、對 10 個以上議題研究、新建地圖）會先列成計畫，按「套用」前不會有任何改變。對話依回覆套用的變更無法復原。「把對話存成筆記」會把對話寫到地圖資料夾下的 `Chats/`。

研究與展開有兩種 AI 模式。**快速**只用模型的知識與你提供的資料來源、不上網；**標準**會上網搜尋，並可配圖。架構穩定後、或題目較新較冷門時，用標準。

## 分享地圖

開啟心智圖後，選擇 **Share this map**（分享這張地圖，指令或按鈕皆可）。VAM 會存成一個 HTML 檔，可在任何瀏覽器開啟（也能離線；連到網路的圖片需要連線），存放位置由你選擇。對話框可選擇不含完整筆記或圖片，也可用 AI 加上翻譯版本（需要 Codex 或 Claude Code）。存檔前 VAM 會檢查檔案是否含有私人資訊，例如 vault 的位置或 `[[筆記連結]]`；若有就不會存檔。**複製發佈到 GitHub 的指令**只會複製文字，讓你貼到自己的 Claude Code 或 Codex。哪些內容不會分享，請見 [已知限制](#已知限制)。

## 設定沒有完成時

- **找不到 CLI：** 到 **Settings → Visual Agent Map** 填入該服務的執行檔路徑，再選擇該服務的 **重新檢查**。
- **登入失敗：** 在 Terminal 執行所選 CLI 並完成登入。
- **Workspace 遺失：** 在 VAM settings 使用 **找回既有 Workspace** 或 **修復 Agent Workspace**。修復不會覆寫既有筆記。
- **需要診斷資訊：** 從 Obsidian Command Palette 執行 **開啟偵錯日誌 (Open Debug Log)**。一般執行訊息只保存在記憶體；AI 請求與回覆紀錄預設關閉，若於 VAM 設定啟用，最近的往返紀錄會保存在 Vault 的外掛資料夾，且可清除。

## 資料與權限

選取 Markdown 文字的 AI 操作會產生可編輯草稿，你必須明確接受草稿，才會改動筆記。「生成翻譯圖片」在你選擇「取代原圖」或「新增一張」後，會把翻譯版圖片寫入筆記；它需要 Codex，執行時才傳送圖片資料，原始圖片檔保持不變。若不想在選取文字或點選圖片時自動出現 AI 按鈕，可在設定關閉「自動顯示『用 AI 處理選取文字』」；「用 AI 處理選取文字」命令仍可使用。

VAM 不含遙測，也不儲存 API key。AI 任務會透過本機 CLI 將相關內容，包括研究脈絡、選取的背景檔或來賓設定，傳送至 OpenAI 或 Anthropic，可能使用帳號額度或產生費用。地圖 AI 對話另外會送出地圖大綱、你其他地圖的標題、你選取或加入參考的議題、地圖旁開著的整篇筆記（以可移除的標籤顯示）、你拖入的筆記與文字，以及最近幾則訊息；對話可以修改這些筆記，也能在 vault 新增 Markdown 筆記，但不會寫進 Obsidian 設定資料夾。AI 請求／回覆紀錄預設關閉；啟用後的紀錄可能包含私人筆記。

CLI 繼承 Obsidian 的作業系統權限；唯讀或工具限制不等於 OS sandbox。VAM 會執行你安裝的 CLI 程式；使用 AIM、標準研究或找圖時，該程式會代你上網搜尋（快速模式不會）。找圖候選的縮圖會直接從各網站載入。分享檔只會寫到你在存檔視窗選的位置，VAM 不會上傳。VAM 可能讀取 Vault 的 Markdown 路徑來尋找工作區，也會探測 Vault 外的 CLI 路徑。選用的 AI 往返紀錄與暫存檔會保存在外掛資料中。複製操作只將指定文字寫入剪貼簿；VAM 不讀取剪貼簿內容，也不會自行安裝或更新 CLI。

## 已知限制

僅支援桌面版；AIM 已驗證環境為 macOS 與 Obsidian 1.14.4。Windows 與 Linux 尚未驗證。

AIM 會搜尋網路並提供來源連結，但找到來源不代表內容已證實。AI 判斷、無法存取的來源與帳號額度，都可能讓研究未能完成。重要主張請回到原始來源核對。

同時研究多個議題會用掉較多額度，模型忙碌時部分議題可能失敗，可以重試，例如換一個模型。內容模板設定了項目數時，可能多送一次 AI 請求來修正數量。

AI 從網路找到的圖片不一定能自由使用，請查看各自的來源頁。大綱只搜尋目前地圖的議題名稱，不搜尋全文。地圖的復原／重做是暫存紀錄，切換地圖或關閉視圖後會清除。

新的心智圖會建立在工作區資料夾內的 `Mind Maps/`，新的 AIM 會建立在 `AIM/`（資料夾名稱可在設定中修改，會一併重新命名既有資料夾，執行時設定視窗會關閉，Obsidian 可能會逐份詢問連結處理方式）。`Topics/` 內既有的地圖維持原位、照常可用；VAM 不會自行搬動它們。要搬移請執行「整理工作區資料夾」指令，它會先顯示預覽，任一步失敗會還原全部。收件匣（Inbox）不再由 VAM 管理：既有 `Inbox/` 內的筆記原封不動。當「整理工作區資料夾」讓舊的 `Topics/` 或 `Inbox/` 資料夾完全清空時，會把該空資料夾移到垃圾桶（依你的 Obsidian 垃圾桶設定）；仍有任何內容的資料夾絕不會被動到。以 0.4 前舊結構儲存的地圖（不在上述資料夾內）仍可開啟與檢視，但不能改名、不能修改結構，也不會被整理。若搬移進行中關閉了 Obsidian 或停用了 VAM，部分地圖可能已在新資料夾但 VAM 內的路徑尚未更新；請執行「重新整理 VAM 資料」（會先修復這些路徑），或再次執行「整理工作區資料夾」。

地圖 AI 對話：只用 Claude 做過實機測試，Codex 未在對話中實機測試。已插入的圖與無法載入的圖看起來一樣，找圖的結果列即使之後找不到圖也會寫「已開始」。對話依回覆套用的變更無法復原。對話在英文與簡體中文畫面、彈出視窗、Windows 與 Linux 未檢查。

分享檔：AIM 研究地圖與內建範例目前不能分享，網路圖片不會內嵌，保留原網址，讀者連線時才顯示；翻譯由 AI 產生，品質未經母語者檢查。iOS 無法開啟本機 HTML 檔，手機請透過網址（例如 GitHub Pages）檢視；桌面 Safari 開啟本機分享檔尚未測試。

Coffee Tables 把接續對談所需的資料存在隱藏資料夾 `Coffee Tables/.sessions`。Obsidian Sync 不同步隱藏資料夾，因此在其他裝置上可以閱讀同步過去的對談，但無法接著聊；請回到開始對談的裝置繼續。
