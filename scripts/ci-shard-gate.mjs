// CI gate for the sharded full run: node scripts/ci-shard-gate.mjs <reportDir> --shards=<n>
// Every runner leaves one JSON record per finished part in VAM_CI_REPORT_DIR (scripts/test-integration.mjs). This script lists the whole run from the same
// unsharded `parts` that a local `npm test` uses and exits 1 unless the records cover that list exactly once, every part passed with a positive test count,
// and every runner 1..n reported both layers. It reads no node_modules, so the gate job needs no `npm ci`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parts as integrationParts, unitsOf } from "./test-integration.mjs";
import { parts as unitParts, runnable } from "./test-unit.mjs";

// The units a complete run must report, per layer: the unsharded parts, with the `node --test` glob expanded to files.
export const expectedUnits = () => ({
  unit: runnable(unitParts).flatMap(unitsOf),
  integration: integrationParts.flatMap(unitsOf),
});

const listJson = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? listJson(join(dir, entry.name)) : entry.name.endsWith(".json") ? [join(dir, entry.name)] : []));
export const readReports = dir => listJson(dir).sort().map(file => ({ file, ...JSON.parse(readFileSync(file, "utf8")) }));

// Returns { errors, perShard, total }; errors is empty when the run is complete and green.
export function checkReports(reports, shards, expected = expectedUnits()) {
  const errors = [];
  const perShard = Object.fromEntries(Array.from({ length: shards }, (_, i) => [i + 1, { unit: 0, integration: 0, seen: { unit: false, integration: false } }]));
  const seen = { unit: new Map(), integration: new Map() };
  for (const report of reports) {
    const where = `${report.layer}/${report.shard}/${report.part}`;
    if (!seen[report.layer]) { errors.push(`${where}: unknown layer`); continue; }
    const match = /^(\d+)\/(\d+)$/.exec(report.shard ?? "");
    const index = Number(match?.[1]);
    if (!match || Number(match[2]) !== shards || index < 1 || index > shards) { errors.push(`${where}: shard is not i/${shards}`); continue; }
    if (report.code !== 0) errors.push(`${where}: exit code ${report.code}`);
    if (!Number.isInteger(report.tests) || report.tests <= 0) errors.push(`${where}: tests is ${report.tests}, not a positive integer`);
    if (report.fail !== 0) errors.push(`${where}: fail is ${report.fail}, not 0`);
    for (const unit of report.units ?? []) seen[report.layer].set(unit, (seen[report.layer].get(unit) ?? 0) + 1);
    perShard[index].seen[report.layer] = true;
    if (Number.isInteger(report.tests)) perShard[index][report.layer] += report.tests;
  }
  for (const layer of ["unit", "integration"]) {
    const want = new Set(expected[layer]);
    for (const unit of want) {
      const count = seen[layer].get(unit) ?? 0;
      if (count === 0) errors.push(`${layer}: ${unit} was not run`);
      else if (count > 1) errors.push(`${layer}: ${unit} ran ${count} times`);
    }
    for (const unit of seen[layer].keys()) if (!want.has(unit)) errors.push(`${layer}: ${unit} is not in the part list`);
  }
  let total = 0;
  for (const [index, entry] of Object.entries(perShard)) {
    for (const layer of ["unit", "integration"]) if (!entry.seen[layer]) errors.push(`shard ${index}/${shards}: no ${layer} report`);
    total += entry.unit + entry.integration;
  }
  return { errors, perShard, total };
}

export function main(argv) {
  const dir = argv.find(arg => !arg.startsWith("--"));
  const shards = Number(argv.find(arg => arg.startsWith("--shards="))?.split("=")[1]);
  if (!dir || !Number.isInteger(shards) || shards < 1) { console.error("usage: ci-shard-gate.mjs <reportDir> --shards=<n>"); return 1; }
  const { errors, perShard, total } = checkReports(readReports(dir), shards);
  for (const [index, entry] of Object.entries(perShard)) process.stdout.write(`shard ${index}/${shards}: unit ${entry.unit}, integration ${entry.integration}, subtotal ${entry.unit + entry.integration}\n`);
  process.stdout.write(`total tests: ${total}\n`);
  if (errors.length) { console.error(`ci-shard-gate FAILED:\n${errors.map(line => `  ${line}`).join("\n")}`); return 1; }
  process.stdout.write("ci-shard-gate: every unit ran exactly once and passed.\n");
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
