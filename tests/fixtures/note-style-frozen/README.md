# note-style-frozen

Frozen test inputs. The 0.28.0 note style upgrade module (`ai/note-style-upgrade.ts`, deleted; source commit dd90ae7) was removed, and these files hold what it
produced for the tests, so the prompt snapshots and the related tests stay byte-identical. Do not regenerate them: there is
nothing left to regenerate from. A change in these files means a change in what the snapshots assert.

Source: produced once on commit dd90ae7 (note-style-recipe T3 P1, upgrade module still present) by a one-off script kept
outside the repo.

- `upgraded-selections.json`: `entries[sha256(style file text) + ":" + language]` -> `{ template: { id, body }, format: { id, body } }`.
  The input is each style file text `tests/prompt-snapshots.cjs` passes to `upgradedSelection`; the output is the sections zone
  (template body) and format rules zone (format body) of the template block `planNoteStyleUpgrade` wrote for it. 36 entries.
- `legacy-formats.json`
  - `legacyFormats[language + ":" + JSON of the preferences with keys sorted]` -> text of `legacyObsidianFormat(language, preferences)`
    for the parameters `steps-prompt-assembler.cjs` and `steps-template-charts.cjs` use (diagrams off, the rest on; 3 languages).
  - `chartStructureFiles[style id]` -> the structure file text `store.upgradeLegacy()` wrote for each old style in
    `steps-note-style-chart.cjs` (`style:Off`, `style:On`).

Tests that read these files throw when a key is missing; they never fall back to computing the value.
