Install a selected public Visual Agent Map GitHub Release into my Obsidian desktop vault from https://github.com/kevcltsai/visual-agent-map/releases. Do not use files from the `main` branch as a production installation source.

Complete the installation end to end:

1. If I have not provided the absolute path to my Obsidian vault, ask for that path before changing files. Never guess the vault path.
2. Verify that the vault exists and contains a `.obsidian` directory. Stop and explain the problem if either check fails.
3. Use `<vault>/.obsidian/plugins/visual-agent-map/` as the plugin directory.
4. If the plugin directory already exists, preserve its `data.json`. Never delete or overwrite the vault's `Agent Workspace/` folder.
5. Select one GitHub Release version and download its three release assets into the plugin directory, replacing older copies only after all downloads succeed:
   - `main.js`
   - `manifest.json`
   - `styles.css`
   Use the assets attached to that exact release tag, not raw GitHub file URLs.
6. Do not clone the whole repository into the plugin directory, do not copy internal project documents, and do not run `npm install` in the vault.
7. Verify that Node.js and the Codex CLI are installed and that Codex is signed in with ChatGPT. Do not install or update Codex CLI without asking first.
8. Tell me the resolved Codex CLI path and App Server status shown in Visual Agent Map settings. Visual Agent Map supports Codex models only.
9. Ask me to reload Obsidian and enable Visual Agent Map under Community plugins. Do not change Obsidian's restricted-mode or security settings without my confirmation.
10. Verify the three installed plugin files, confirm that any existing `data.json` and `Agent Workspace/` were preserved, and report every command run plus the final paths. If a step fails, stop and report the error instead of claiming success.
