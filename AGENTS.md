# Repository Agent Rules

This repository follows the external Visual Agent Map agent workflow specification when it is available.

Local invariants that apply even when that specification is not loaded:

- Preserve unrelated behavior. Do not broaden scope silently.
- Treat `main` as the behavior reference during refactors.
- Prefer small, reviewable internal moves inside one PR over behavior rewrites.
- Run the existing build, lint, unit, integration and artifact gates for changed architecture.
- When blocked or uncertain, escalate analysis before applying speculative fixes.
- Experiences must communicate through shared contracts/services, not by importing each other's private view internals.
- Heavy resources (AI runtime, vault-wide indexing, background listeners) belong in shared core unless an experience has a documented reason to own one.
- Finish architecture work with a consistency pass for duplication, conflicts, dead compatibility code and avoidable token/context cost.
