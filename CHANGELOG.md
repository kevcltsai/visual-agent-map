# Changelog

## [0.5.2] - 2026-09-18

### Changed

- 開啟與載入外掛不再靜默修改既有 Topic Note；補齊筆記顯示 class 改為明確的手動 command。
- Obsidian command IDs 移除 plugin ID；既有快捷鍵可能需要重新設定。
- Codex ACP fallback 說明改為僅限 prompt 前的 transport error。
- 正式 provider 範圍改為 Codex-only；移除 Claude Code 設定與路由。舊 `claude:*` model 會在本機提示改選 Codex model，不會啟動外部 provider 或改寫筆記。
- Onboarding 可從 Command Palette 重新開啟；建立空白／範例心智圖失敗時不標記完成、不刪除可能已寫入資料，直接保留重試入口。
- 現行 private system spec 集中於 `docs/spec/`；v0.5.0 product concept 移入歷史資料。

### Validation

- 58 automated tests、lint、typecheck、production build 與 release-asset check 通過。
- 在獨立 Obsidian vault 完成 onboarding、Codex task、decompose、synthesize、branch remove／undo 與既有筆記保留驗證。
