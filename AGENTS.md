# Public repository rules

This repository is public and is intended for people evaluating or installing Visual Agent Map.

- Never commit internal product specifications, product-concept documents, release checklists, private roadmaps, or working notes.
- Keep `PRODUCT-CONCEPT*.md`, `RELEASE-CHECKLIST*.md`, and the root `spec/` directory untracked.
- Write the root `README.md` for first-time users. Keep the English and Traditional Chinese sections aligned, and include product purpose, major features, screenshots, requirements, installation, quick start, and current limitations.
- Keep `INSTALL.md` as one copy-paste request that an LLM or coding agent can execute in a clean environment. Do not add release notes, architecture notes, or human-facing explanations to that file.
- Never commit personal filesystem paths, credentials, API keys, tokens, Vault contents, or user research notes.
- The public release folder must contain only the built Obsidian plugin files required at runtime: `main.js`, `manifest.json`, `styles.css`, and `response-schema.json`.
- Before publishing, run `git diff --check`, scan tracked files for personal paths or secrets, validate `manifest.json`, and confirm that README links resolve.
