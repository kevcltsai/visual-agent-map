# Changelog

## [0.9.6] - 2026-09-26

### Added

- Added bilingual first-use guidance and an official read-only Sample that follows the VAM interface language. New installs use Traditional Chinese when Obsidian is set to `zh-TW` and English otherwise; an existing VAM language choice is preserved.
- Added the ability to duplicate the Sample, create an empty mind map, and edit maps without Codex. Codex setup guidance now appears when starting an AI task.
- Added an isolated Obsidian CLI runtime test that verifies the prepared build, canonical test Vault, plugin initialization, Sample, commands, and runtime errors before UI acceptance.

### Changed

- Updated installation guidance and the README in English and Traditional Chinese for the no-Codex manual workflow.
- Switching maps now closes only a VAM-opened detail note from the previous map and clears Obsidian's cached Outline state.

## [0.9.5] - 2026-09-25

### Added

- Added task-only additional instructions and data-source controls to research, map expansion, and synthesis. Tasks can use web search, optional image references, other maps in the current vault, and selected Markdown files or folders; selected local sources are processed in batches and cited in results.
- Added exact-size starter-map expansion controls, including zero children per parent to stop after the first level and a 15-subtopic limit.

### Changed

- Standardized interface and AI task text on complete English and Traditional Chinese translation catalogs. New AI content follows the interface language by default; changing languages updates only known VAM-managed Detail headings in existing topic notes.
- Made task instructions and source selections apply only to the current run; they are not saved to a topic or inherited.
- Reworked the disposable test-vault harness to update one canonical vault safely, preserve its data during artifact refreshes, and verify installed artifacts.

### Fixed

- Improved cancellation and failure handling for reading and processing selected Markdown sources so incomplete material is not silently treated as complete.
- Clarified starter-map level counts and disabled the children-per-topic setting when creating a single level.

## [0.9.4] - 2026-09-23

### Added

- Added an automatically opened topic outline in the left sidebar, following the map hierarchy with search and direct note navigation.

### Fixed

- English sample notes now show English Preview headings.
- New AI tasks use the selected interface language by default across research, map expansion, and synthesis. English-generated note scaffolding, pending summaries, reference labels, and relevant error messages now use English.
- Switching interface language does not translate or rewrite existing note content.

## [0.9.3] - 2026-09-22

### Changed

- AI tasks now time out after 3 minutes. VAM attempts to interrupt an overdue Codex turn to avoid continued background resource use, does not apply an incomplete result, and explains the reason in the task error.

## [0.9.2] - 2026-09-22

### Fixed

- Editing a topic note's Markdown `#` heading now updates its map card title. Later note writes and data rebuilds keep that title.

## [0.9.1] - 2026-09-22

### Added

- Added Fast, Normal, and Deep research depth independently of Codex reasoning effort.
- Added guided subtopic suggestions with confirmation, and quick maps with an exact first-layer count and children per parent. Requests above 15 topics show an immediate error; incomplete or uneven AI trees cannot change the map.
- Added optional shallow research after creating children, reviewable synthesis drafts, and selected Markdown notes as additional synthesis sources.
- Added branch and whole-map auto layout, topic batch actions, and opt-in AI request and reply logging in the debug log.

### Changed

- Topic cards now open their Markdown note directly; the star opens Research, Expand Map, and Synthesize in one window, while the gear opens structure and links.
- Research and expansion use web-enabled Codex tasks without a web-search control. Synthesis uses local child topics and selected Markdown notes without a web-search control.
- The plus button beside a node creates a manual child. AI expansion considers existing children to avoid duplicate proposals.

## [0.9.0] - 2026-09-22

Withdrawn prerelease. Its feature descriptions are superseded by 0.9.1.

## [0.8.1] - 2026-09-21

### Fixed

- Replaced the VAM Properties visibility override with a more specific selector that does not require `!important`.
- Made tag releases idempotent by updating assets when the GitHub Release already exists.

## [0.8.0] - 2026-09-21

### Added

- Added a user-triggered full VAM data rebuild in Settings and the Command Palette.
- Added workspace and per-topic Codex reasoning-level controls.

### Changed

- Creating a confirmed batch of child topics now rebuilds derived data only once.
- VAM note Properties are hidden in reading and Live Preview while their YAML metadata remains intact.

## [0.7.1] - 2026-09-20

### Fixed

- Codex launch now adds the resolved executable directory to the child PATH, so npm/nvm installations can find their sibling Node executable when Obsidian starts without the terminal environment.

## [0.7.0] - 2026-09-20

This release improves the complete first-use journey, from installation and Codex setup to the first editable map and first AI task.

### Changed

- Rebuilt the installation guide around the full path from Community plugins or GitHub Release to the first editable map.
- The built-in sample now shows Codex readiness as the next onboarding step and unlocks duplicate or empty-map creation when ready.
- When Codex CLI is missing, VAM now opens an in-product setup guide with the official install link, ChatGPT sign-in steps, requirements clarification, and a recheck action.
- The first real AI task now shows a one-time notice that it uses the signed-in account's Codex allowance; canceling keeps the notice pending.

## [0.6.2] - 2026-09-20

### Changed

- Replaced the separate ACP transport and CLI fallback with the Codex CLI App Server protocol.
- New workspaces default to the lowest-cost configured product model, `gpt-5.6-luna`, with low reasoning; available models are discovered from the signed-in Codex installation.

### Fixed

- App Server tasks now unsubscribe ephemeral threads, decline unsupported interactive requests instead of hanging, and ignore stale child-process events after restart.
- Resolved the remaining Obsidian review warnings for destructive buttons and over-broad CSS overrides.

## [0.6.1] - 2026-09-19

### Fixed

- Aligned the English and Traditional Chinese README so both languages publish the same usage, requirements, installation, data, privacy, limitations, and build information.
- Replaced the unverified Obsidian `1.7.2` compatibility claim with the verified `1.13.7` baseline across README, manifest, and version metadata.
- Added release checks that reject README language drift and inconsistent public version or compatibility metadata.

## [0.6.0] - 2026-09-19

### Added

- Added a bilingual, built-in Taiwan travel sample that demonstrates both subtopic exploration and synthesis into a new journey root.
- Added a short, repeatable sample tour and one-click duplication into a normal editable workspace map.
- Rebuilt the sample from canonical Map/Note Markdown, expanded it to 12 nodes, and added five bundled images plus Preview image/table examples.
- Added explicit Agent Workspace recovery in the empty state, settings, and Command Palette.
- Added read-only discovery and user-confirmed reconnection for custom VAM workspaces after reinstall.
- Added an in-memory debug log with a Command Palette viewer, timestamped levels, refresh, copy, and clear actions; ACP initialization, malformed responses, and AI task failures are now captured explicitly.
- Added reproducible onboarding, normal-use, and reinstall test-vault profiles with SHA-256 workspace integrity verification.

### Changed

- Fresh installs now create only the empty `Agent Workspace/Topics` and `Agent Workspace/Inbox` structure, then open the read-only sample without running AI or writing sample files to the Vault.
- Existing installations never silently recreate a manually removed Agent Workspace; repair only restores missing base folders and never overwrites content.
- New installs no longer assume the Apple Silicon Homebrew path for `codex-acp`; macOS discovery now covers Homebrew, local npm prefixes, Volta, fnm, nvm, and the inherited PATH.
- ACP responses may include brief progress prose before the structured result; VAM now extracts and validates the final complete JSON object instead of failing the task on that prefix.
- Settings now shows the resolved Codex ACP status and provides an explicit recheck action; VAM never installs or updates system dependencies automatically.
- The Codex CLI fallback schema is embedded in `main.js`, so standard three-file Community Plugin installations no longer depend on an extra release asset.

### Validation

- Built-in sample schema, bilingual content, duplicate identity isolation, workspace repair, replacement onboarding contract, and debug-log behavior are covered by automated tests.

## [0.5.3] - 2026-09-18

### Changed

- Restored the public GitHub README as a product landing page with clear installation, requirements, privacy, limitations, and bilingual guidance.

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
