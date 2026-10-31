import test from "node:test";
import assert from "node:assert/strict";
import { changelogSection } from "../scripts/changelog-section.mjs";

const log = "# Changelog\n\n## [Unreleased]\n\n## [0.28.0] - 2026-11-01\n\n### Added\n- a\n\n## [0.28.01] - x\n\n- wrong\n\n## [0.27.0] - y\n\n- last\n";

test("returns the section body without heading or leading blank lines", () => {
  assert.equal(changelogSection(log, "0.28.0"), "### Added\n- a");
});
test("returns the last section in the file", () => {
  assert.equal(changelogSection(log, "0.27.0"), "- last");
});
test("missing version throws", () => {
  assert.throws(() => changelogSection(log, "9.9.9"), /no section for 9\.9\.9/);
});
test("empty section throws", () => {
  assert.throws(() => changelogSection(log, "Unreleased"), /empty/);
});
test("0.28.0 does not match 0.28.01 or a dot wildcard", () => {
  assert.equal(changelogSection(log, "0.28.01"), "- wrong");
  assert.throws(() => changelogSection(log, "0x28.0"), /no section/);
  assert.throws(() => changelogSection("## [0.28.01]\n\n- x\n", "0.28.0"), /no section/);
});
