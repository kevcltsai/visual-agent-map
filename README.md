# Visual Agent Map

### Visual AI research for Obsidian

**Turn complex questions into a visual research map. Explore each branch with Codex. Keep every result as editable Markdown.**

[**Install Visual Agent Map**](#install)

![Visual Agent Map — visual AI research map in Obsidian](assets/screenshots/map-overview.png)

**See the whole question.** Break a broad topic into connected ideas you can navigate at a glance.

**Research one branch at a time.** Run focused Codex tasks from the map, preview suggested subtopics, and review synthesis drafts before saving.

**Keep what you learn.** Each topic is a normal Markdown note in your Obsidian vault, readable and editable without the plugin.

**Uses your local ChatGPT Codex login. No separate API key required.**

## How it works

1. Create a map for a question and add topics or ask Codex to suggest subtopics.
2. Choose a topic and confirm a focused research task.
3. Read the summary on the map and the full result in its Markdown note.
4. Follow the next question or synthesize related findings.

Research and map expansion use web-enabled Codex tasks. Synthesis uses direct child topics and notes selected for that run without requesting web search. Tasks may consume your signed-in account's Codex allowance.

## Install

In **Obsidian Desktop → Settings → Community plugins → Browse**, search for **Visual Agent Map** and install it.

**Requirements:** Obsidian Desktop `1.13.7` or later and a locally installed [Codex CLI](https://developers.openai.com/codex/cli/) signed in with ChatGPT. ChatGPT Free is supported with a smaller Codex allowance. This is a desktop-only plugin; npm is needed only to build from source. Current version: **0.9.5**.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub Release](https://github.com/kevcltsai/visual-agent-map/releases), place them in `<your-vault>/.obsidian/plugins/visual-agent-map/`, and preserve any existing `data.json`. Reload Obsidian, enable the plugin, then confirm the Codex CLI path and App Server status in its settings. Do not install files from a branch, copy the repository into the plugin folder, or run `npm install` there. See [INSTALL.md](INSTALL.md) for first-use steps.

## Your notes and privacy

The plugin stores its workspace under `Agent Workspace/` in your vault. Map structure lives in `Map.md`; topic content stays in ordinary Markdown notes. A fresh install creates an empty workspace and opens a read-only sample. Uninstalling the plugin does not delete your notes.

- No telemetry or stored API keys.
- Before the first AI task, the plugin explains that it uses your Codex allowance. Relevant topic content, task instructions, and excerpts from sources selected for that run are sent to the locally signed-in Codex tool.
- AI request and reply logging is off by default. If enabled, recent exchanges are saved in the vault's plugin data and can be cleared.
- The plugin starts `codex app-server` outside the vault in a read-only sandbox without command or file-change approvals. It does not install or update Codex CLI. Remote Markdown images follow Obsidian's normal image-loading behavior.

## Current limitations

Desktop only. There is no node search, multiple parents, or persistent task history. Undo and redo last for the current Obsidian session. A running node task can be stopped while preserving its existing note; after three minutes, the plugin attempts to interrupt it and does not apply incomplete results.

See the [changelog](CHANGELOG.md) for version history and [setup instructions](INSTALL.md) for more detail. This project is developed with [OpenAI Codex](https://openai.com/codex/) as a coding collaborator; the maintainer manages product direction, validation, and releases.

[繁體中文](README.zh-TW.md)

## License

Copyright © 2026 Kevin Tsai. Licensed under [AGPL-3.0-only](LICENSE).
