# v0.5 extraction checklist

This is the Phase 2 baseline for the `main.ts` refactor. It records the existing
responsibilities before any implementation is moved. It is a planning/checkpoint
artifact only: it does not change runtime behaviour, persisted data, or the
release pipeline.

## Baseline

- Checkpoint: `ba5dcb1` (`v0.5`, following the `0.5.0` release checkpoint).
- Entry point: `main.ts`; 1,467 lines.
- Automated checks: `npm run lint` succeeds with 44 pre-existing warnings;
  `npm test` passes 50 tests; `npm run build` succeeds.
- Compatibility boundary: keep the Vault layout, Markdown/frontmatter, map JSON,
  node identifiers and positions, model/default/provider routing, CLI arguments,
  timeouts, sessions, and UI text/flows unchanged.

## Current responsibility map

| Current area in `main.ts` | Approx. lines | Extraction destination | Later phase |
| --- | ---: | --- | ---: |
| AI task types, prepared context and token helpers | 9-28 | `ai/types.ts`, `ai/context-builder.ts` | 3 |
| Detail/reference and Markdown-preview helpers | 42-121 | `ai/result-utils.ts`, `ui/preview-utils.ts` | 3 |
| Modal classes | 123-252 | `ui/modals/` | 6 |
| Map view state, rendering and interactions | 254-1008 | `ui/map-view.ts`; later `toolbar.ts`, `node-card.ts` only if needed | 7 |
| Map/topic lifecycle operations | 317-448, 455-540, 769-929 | `services/map-service.ts`, `topic-service.ts`, `migration-service.ts` | 8 |
| AI task orchestration and source/context assembly | 792-935, 988-1008 | `services/task-service.ts`, `ai/response-parser.ts` | 5 |
| Settings tab | 1011-1033 | `settings/settings-tab.ts` | 9 |
| Plugin lifecycle, registration and workspace wiring | 1035-1135 | remain in `main.ts` | 9 |
| ACP transport and Codex provider implementation | 1136-1385 | `ai/providers/acp-client.ts`, `codex-provider.ts` | 4 |
| Claude CLI provider implementation | 1387-1467 | `ai/providers/claude-provider.ts` | 4 |

## Guardrails for every extraction

1. Move one responsibility at a time and preserve function/class APIs first.
2. Keep `main.ts` as the esbuild entry point; do not start a repository-wide
   `src/` move in this work.
3. Use adapters when a dependency boundary needs to change; do not rewrite the
   underlying workflow merely to improve the architecture.
4. Run `npm run lint`, `npm test`, and `npm run build` at the end of each phase.
5. Commit each green phase separately. Revert to the prior checkpoint if a
   regression cannot be confined to the active phase.
