# AI Markdown Pipeline Performance Plan

Baseline: GitHub `main` at `9602046c47817a2a20c43f2c8642932fdf76172b` (0.7.1).

## Goals and measurements

- A confirmed 3–7 child batch persists every child but calls `rebuildDerivedData()` once.
- Users can explicitly run a full derived-data rebuild from Settings or the command palette.
- Later AI controls reduce avoidable searches and context/output size without silently lowering answer quality.
- Record task duration, model time, input/output tokens when available, source count, visual-search count, and rebuild duration before comparing phases.

## Phase 1 — low risk (this branch)

1. Defer derived-data rebuild while confirmed child proposals are created. Keep per-child persistence and undo history; rebuild once after the batch, including partial-success cleanup.
2. Add **Settings → Refresh VAM data → Full rebuild** and keep the existing command ID for compatibility. The action rescans maps/notes, rebuilds references and derived metadata, then refreshes open VAM views.
3. Add regression tests for one rebuild per batch, persisted child content, the Settings entry, and view refresh after a full rebuild.

Success gate: lint, TypeScript check, tests, and production build all pass.

## Phase 2 — explicit workload controls

### Research depth

Add a workspace default with an optional per-run override:

| Mode | Intended behavior |
| --- | --- |
| Fast | Existing note context first; at most 1 search and 2 primary sources; low reasoning; stop when the answer is sufficient. |
| Normal | Default; at most 3 searches and 5 primary sources; low reasoning for ordinary tasks and high reasoning for synthesis. |
| Deep | User-selected only; broader iterative research, up to 8 searches and 12 primary sources; high reasoning and an explicit completeness pass. |

Pass the selected mode as structured task policy rather than prose scattered across prompts. Show the effective mode in the confirmation UI and task log. Limits are ceilings, not quotas.

### Visual references

Add a workspace default with a per-run override:

- **Auto** (default): request images only when they materially help a visual decision, place, product, UI, style, or physical object.
- **On**: require visual-reference search and structured visual results.
- **Off**: prohibit image search and return no visual-reference payload.

Keep this independent from research depth so Deep does not imply image search. Test policy serialization, defaults/migration, and prompt behavior for all nine combinations.

## Phase 3 — long Markdown context trimming

Introduce a deterministic context budget before changing output format:

1. Always include title, task, rules, current summary, and ancestor summaries.
2. Include full Detail below a measured size threshold.
3. Above the threshold, include section headings, a stable summary, and task-relevant sections selected by heading/keyword match.
4. Preserve source links and recent working findings; log omitted section names and sizes for debugging.

Evaluate with long-note fixtures for answer retention, token reduction, and deterministic section selection. Provide an escape hatch to include the full note for a single run.

## Phase 4 — section-level updates

Change the AI response from a full replacement document to validated operations such as `replaceSection`, `appendSection`, and `setSummary`. Apply operations against a version/hash of the source note so concurrent edits fail safely instead of being overwritten.

Roll out behind an opt-in flag, retain full-document fallback, and test heading collisions, missing sections, user edits during a run, malformed operations, source-link preservation, and round-trip Markdown stability. Promote to default only after representative notes show materially lower output tokens with no content-loss regressions.

## Risks and safeguards

- Deferred rebuild can leave partial batches after a mid-batch failure. Per-child map persistence is retained and the finalizer rebuilds any successfully created children.
- Full rebuild rewrites managed derived blocks. Tests must continue proving user-authored Detail and unrelated frontmatter survive.
- Search ceilings may reduce coverage. Make the effective mode visible and keep Deep explicit.
- Context trimming and section patches have the highest content-loss risk, so they are deliberately separated from Phase 1 and require fixture-based evaluation plus fallback paths.
