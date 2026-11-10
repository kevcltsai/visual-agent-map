# Legacy AIM map fixtures

These are fixed vault files of old AIM maps. `tests/suites/legacy-aim-map.cjs` loads them into a test vault exactly as written. They were made once on 2026-11-10 by the AIM code of 0.33 (`createAimMap`, `AimRunStore`). The steps were the same ones the old `aim-hidden` suite ran before every test. They are frozen so that the legacy-map tests keep working after the AIM engine is deleted.

Do not regenerate these files and do not edit them by hand. They stand for maps that users already have on disk.

Each directory holds vault paths:

| Directory | Map | Shape |
|---|---|---|
| `old-aim-map` | `Agent Workspace/AIM/Old AIM map/Map.md` | A topic, two `research` nodes and a `conclusion` that converges on both. The aim block has no branches. |
| `interrupted` | `Agent Workspace/AIM/Interrupted/Map.md` | A topic and a plain question note. |
| `running-attempt` | same | `interrupted` with an answer branch whose attempt was left `running`. |
| `pending-commit` | same | `interrupted` with a running attempt and a result draft whose Note (`Pending result.md`) was written. The map save was then interrupted. |
| `drafts` | same | `interrupted` with a synthetic `questionDraft`, `creationId` and `rootDraft`. |
