# Visual Agent Map v0.4.0 安裝

## 一次安裝到位

不論目標 Vault 是第一次安裝或已有舊版，都直接安裝 v0.4.0，不需要依序安裝任何中間版本。

1. 保留 Vault 內既有的 `Agent Workspace/`。如果已安裝舊版，先把 `.obsidian/plugins/visual-agent-map/data.json` 暫存到外掛資料夾外。
2. 刪除舊的 `.obsidian/plugins/visual-agent-map/`，再建立同名空資料夾。這一步會一併排除舊開發版可能留下的 `node_modules`、TypeScript 原始碼及測試檔案。
3. 從交付資料夾將下列四個 v0.4.0 執行檔複製到新的 `.obsidian/plugins/visual-agent-map/`：

   - `visual-agent-map/main.js`
   - `visual-agent-map/manifest.json`
   - `visual-agent-map/styles.css`
   - `visual-agent-map/response-schema.json`

4. 若先前已有 `data.json`，將它放回 `.obsidian/plugins/visual-agent-map/`。
5. 重新載入 Obsidian，或先停用再啟用 Visual Agent Map。
6. 在外掛設定確認 AI 執行路徑：
   - `Codex ACP 路徑`：預設 `/opt/homebrew/bin/codex-acp`，用於 `gpt-*` / Codex 模型，也是主要執行方式。
   - `Claude Code CLI 路徑`：只有選 `claude:sonnet`、`claude:opus` 或 `claude:fable` 時需要。
   - `Codex CLI fallback 路徑`：位於 Advanced，只有 `codex-acp` 失敗時才會使用。
7. 確認本機已登入對應工具。若只使用 Codex / ChatGPT 帳號 quota，請先在本機完成 Codex 登入；若要使用 Claude 模型，請先完成 Claude Code 登入。

完成後即可直接使用 v0.4.0。外掛只支援桌面版，不保存 API key。

安裝完成的外掛資料夾只需上述四個執行檔，以及 Obsidian 儲存設定時建立的 `data.json`。不要把整個 `visual-agent-map/` 開發資料夾複製進 `.obsidian/plugins/`，也不要在外掛安裝目錄執行 `npm install`；兩者都可能把不需要的開發依賴帶入 Vault。

## 既有資料一次轉換

若 Vault 仍使用全域 `Agent Workspace/Maps/` 與 `Agent Workspace/Nodes/`，開啟任一舊心智圖並點「整理舊資料」。確認預覽中的主題數、圖內筆記數與孤兒筆記數後，按「確認整理」即可一次轉換全部舊資料。載入外掛與查看預覽不會搬移檔案；轉換任一步驟失敗時，外掛會回復本次已搬移的檔案。

轉換後，每張舊心智圖會直接成為 `Agent Workspace/Topics/<主題>/` 下的獨立主題，內含 `Map.md`、`Notes/`、`Unassigned/` 與 `Archive/`。圖內筆記進入該主題的 `Notes/`；無法判斷所屬主題的孤兒筆記進入全域 `Agent Workspace/Inbox/`，由使用者後續認領。

新建主題會直接使用相同結構。請勿手動同時搬移外掛正在轉換的檔案，以免路徑與 Map 內容不一致。

## 讓 LLM 直接跑的最小設定

若要把這份外掛交給其他人，對方只需要：

1. 使用桌面版 Obsidian。
2. 安裝上述四個外掛檔案。
3. 在本機安裝並登入 `codex-acp` 所屬的 Codex 工具。
4. 在外掛設定確認 `Codex ACP 路徑` 指向可執行檔。
5. 保持 `工作區預設 Model` 為 `gpt-5.6-luna`，或改成對方帳號可用的模型。

外掛不要求使用者輸入 OpenAI API key；它會使用本機 Codex / Claude Code 已登入的狀態。Model 候選清單會優先由 `codex-acp` 回報補入；若無法取得，仍可在「Model 選單」手動填入逗號分隔的模型 ID。

## 開發與驗證

在 `visual-agent-map/` 執行：

```sh
npm install
npm run build
npm test
```

建置輸出為 `main.js`。Model 候選清單由使用者設定，外掛不假設所有帳號可用相同模型。
