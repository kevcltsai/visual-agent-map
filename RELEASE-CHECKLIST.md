# Visual Agent Map v0.4.0 Release Checklist

## 交付內容

這個資料夾是給一般使用者安裝的交付版，不包含開發依賴。

需要複製到 Obsidian 的外掛檔案只有：

- `visual-agent-map/main.js`
- `visual-agent-map/manifest.json`
- `visual-agent-map/styles.css`
- `visual-agent-map/response-schema.json`

文件：

- `README.md`
- `INSTALL.md`
- `PRODUCT-CONCEPT.md`
- `spec/`
- `visual-agent-map/README.md`

## 已驗證

- `npm run build` 通過。
- `npm test` 通過，40/40。
- 文件已統一為 v0.4.0 / v0.4b 可交付版本。
- `spec/` 已簡化為 4 份：system overview、flow and interaction、data model、key rules。
- 安裝說明已改為 `codex-acp` 優先；`codex exec` 只作 Advanced fallback。
- AI 視覺參考已改為寫入 `Detail` 內的「視覺參考」段落，不再建立獨立 `Visual References` 區塊。
- Hover 預覽只讀取 `Current Summary` 與 `User Notes`，最多顯示 4 張 Markdown 圖片與第一個 Markdown 表格。

## 使用前提醒

- 使用者需要桌面版 Obsidian。
- 使用 Codex 模型前，需先在本機完成 Codex / `codex-acp` 登入。
- 使用 Claude 模型前，需先完成 Claude Code CLI 登入。
- 外掛不保存 API key。
