Install the current public release of Visual Agent Map into my Obsidian desktop vault from https://github.com/kevcltsai/visual-agent-map.

Complete the installation end to end:

1. If I have not provided the absolute path to my Obsidian vault, ask for that path before changing files. Never guess the vault path.
2. Verify that the vault exists and contains a `.obsidian` directory. Stop and explain the problem if either check fails.
3. Use `<vault>/.obsidian/plugins/visual-agent-map/` as the plugin directory.
4. If the plugin directory already exists, preserve its `data.json`. Never delete or overwrite the vault's `Agent Workspace/` folder.
5. Download the `main` branch versions of these three files into the plugin directory, replacing older copies only after the downloads succeed:
   - `visual-agent-map/main.js`
   - `visual-agent-map/manifest.json`
   - `visual-agent-map/styles.css`
6. Do not clone the whole repository into the plugin directory, do not copy internal project documents, and do not run `npm install` in the vault.
7. Verify that Node.js and the Codex CLI are installed and that Codex is signed in. If `codex-acp` is missing, install the current package with `npm install -g @agentclientprotocol/codex-acp@latest`, then locate the resulting executable.
8. Tell me the exact `codex-acp` path I should enter in Visual Agent Map settings. If I ask to use `claude:*` models, also verify Claude Code CLI login and provide its executable path; otherwise do not install Claude Code.
9. Ask me to reload Obsidian and enable Visual Agent Map under Community plugins. Do not change Obsidian's restricted-mode or security settings without my confirmation.
10. Verify the three installed plugin files, confirm that any existing `data.json` and `Agent Workspace/` were preserved, and report every command run plus the final paths. If a step fails, stop and report the error instead of claiming success.
