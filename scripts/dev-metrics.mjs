// Counts and durations only; local, best-effort, never changes a verification exit code.
import { appendFileSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateEvidence } from "./candidate-id.mjs";
const stages = new Set(["build-viewer", "typecheck", "bundle", "test-unit", "test-integration", "heavy-lock-wait", "owner-idle-wait", "install", "local-vault-test", "ci-reuse-install", "affected-verification", "generated-rebuild"]);
const hex = /^[0-9a-f]{64}$/;
const sha = /^[0-9a-f]{40}$/;
export function telemetryFile(env = process.env) {
  if (env.CI === "true" || env.NODE_TEST_CONTEXT || env.VAM_DEV_TELEMETRY === "0") return null;
  const file = env.VAM_DEV_TELEMETRY_FILE || join(homedir(), ".claude", "vam-telemetry", "dev-events.jsonl");
  return existsSync(dirname(file)) ? file : null;
}
export function recordDevEvent(stage, durationMs, outcome, details = {}, { env = process.env, now = () => new Date() } = {}) {
  if (!stages.has(stage) || !Number.isFinite(durationMs) || durationMs < 0 || !["ok", "error"].includes(outcome)) return false;
  let fd;
  try {
    const file = telemetryFile(env);
    if (!file) return false;
    const row = { version: 1, at: now().toISOString(), stage, durationMs: Math.round(durationMs), outcome };
    if (sha.test(details.commit || "")) row.commit = details.commit;
    if (hex.test(details.fingerprint || "")) row.fingerprint = details.fingerprint;
    if (/^\d+$/.test(details.runId || "")) row.runId = String(details.runId);
    if (["full", "files", "none"].includes(details.mode)) row.mode = details.mode;
    if (typeof details.isolatedSuites === "boolean") row.isolatedSuites = details.isolatedSuites;
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077)) return false;
    appendFileSync(fd, JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ } }
}
export function timedSync(stage, work, details = {}) {
  const start = performance.now();
  let outcome = "error";
  try { const result = work(); outcome = "ok"; return result; }
  finally { recordDevEvent(stage, performance.now() - start, outcome, details); }
}
export function matchingEvidence(file, identity) {
  if (!file || !identity) return [];
  try {
    return readFileSync(file, "utf8").split("\n").flatMap(line => {
      try {
        const row = JSON.parse(line);
        if (row.version !== 1 || row.outcome !== "ok" || row.stage !== "affected-verification" || row.commit !== identity.commit || row.fingerprint !== identity.fingerprint ||
            !["full", "files", "none"].includes(row.mode) || !Number.isFinite(row.durationMs) || row.durationMs < 0 ||
            typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at))) return [];
        return [{ at: row.at, stage: row.stage, mode: row.mode, durationMs: row.durationMs, isolatedSuites: row.isolatedSuites }];
      } catch { return []; }
    }).slice(-10);
  } catch { return []; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--evidence") throw new Error("Usage: node scripts/dev-metrics.mjs --evidence");
  const identity = candidateEvidence();
  process.stdout.write(JSON.stringify({ candidate: identity, evidence: matchingEvidence(telemetryFile(), identity), informationalOnly: true, note: "Local records are not permission to skip a gate; full CI and host/runtime evidence remain authoritative." }, null, 2) + "\n");
}
