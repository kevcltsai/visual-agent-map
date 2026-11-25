// Compare the existing offline engineering baseline, without provider calls or timing gates.
// Capture each clean revision: VAM_ENGINEERING_BASELINE=1 node --test tests/steps-engineering-baseline.cjs > /tmp/baseline.tap
// Use different output files for baseline and candidate, on the same machine and under similar load.
// Compare: node scripts/compare-engineering-baseline.mjs before.tap after.tap --same-machine
// Self-test: node scripts/compare-engineering-baseline.mjs --self-test
import { readFileSync } from 'node:fs';

function compare(before, after, sameMachine = false) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const index = report => {
    assert(report?.schema === 1 && report.evidence === 'offline-synthetic' && report.tokenEstimatesAreNotBilledUsage === true, 'Expected schema 1 offline estimate report');
    const env = report.environment;
    assert(env?.dirty === false && ['node', 'platform', 'arch', 'commit'].every(key => typeof env[key] === 'string' && env[key]), 'Expected clean committed full-run environment');
    const rows = new Map();
    for (const group of ['contexts', 'taskContexts', 'layouts']) {
      assert(Array.isArray(report[group]) && report[group].length > 0, `Missing ${group}`);
      for (const row of report[group]) {
        const id = group === 'layouts' ? row.nodes : row.id;
        const key = `${group}/${id}`;
        const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
        assert(id !== undefined && !rows.has(key) && hash(row.inputSha256), `Invalid or duplicate input: ${key}`);
        if (row.samples !== undefined) {
          assert(row.samples === 15 && hash(row.outputSha256) && Number.isFinite(row.p50Ms) && row.p50Ms >= 0 && Number.isFinite(row.p95Ms) && row.p95Ms >= row.p50Ms, `Invalid full-run timing: ${key}`);
        } else {
          assert(group === 'contexts' && ['en', 'zh', 'mixed', 'unicode'].includes(id), `Missing measurement: ${key}`);
        }
        rows.set(key, row);
      }
    }
    for (const key of ['contexts/en', 'contexts/zh', 'contexts/mixed', 'contexts/unicode', 'contexts/SZ1c', 'taskContexts/en-small', 'taskContexts/zh-large', 'layouts/64', 'layouts/256', 'layouts/1024']) {
      assert(rows.has(key), `Missing required fixture: ${key}`);
    }
    return rows;
  };
  const a = index(before), b = index(after);
  assert(a.size === b.size && [...a.keys()].every(key => b.has(key)), 'Fixture sets differ');
  const matchingEnvironment = ['node', 'platform', 'arch'].every(key => before.environment[key] === after.environment[key]);
  const timingEligible = Boolean(sameMachine && matchingEnvironment);
  const metrics = ['utf16Units', 'utf8Bytes', 'taskEstimate', 'chatEstimate', 'usageEstimate', 'sourceUnits', 'estimatedInputTokens', 'outlineSent', 'editableFiles'];
  const rows = [];
  for (const [key, old] of a) {
    const next = b.get(key);
    assert(old.inputSha256 === next.inputSha256, `Input changed: ${key}`);
    assert(old.samples === next.samples, `Sample counts differ: ${key}`);
    const deltas = {};
    for (const metric of metrics) {
      if (old[metric] === undefined && next[metric] === undefined) continue;
      assert(Number.isFinite(old[metric]) && Number.isFinite(next[metric]), `Missing/invalid ${metric}: ${key}`);
      deltas[metric] = { before: old[metric], after: next[metric], delta: next[metric] - old[metric] };
    }
    const changed = old.outputSha256 === undefined ? Object.values(deltas).some(item => item.delta !== 0) : old.outputSha256 !== next.outputSha256;
    const timing = timingEligible && !changed && old.samples !== undefined
      ? { p50Ms: { before: old.p50Ms, after: next.p50Ms }, p95Ms: { before: old.p95Ms, after: next.p95Ms } }
      : null;
    rows.push({ key, outputChanged: changed, deltas, timing });
  }
  return { schema: 1, evidence: 'offline-synthetic-comparison', baselineCommit: before.environment.commit, candidateCommit: after.environment.commit, matchingEnvironment, sameMachineAttested: sameMachine, timingEligible, actualProviderUsage: 'NOT RUN', nativeUi: 'NOT RUN', rows };
}

function readReport(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  if (!/^# fail 0\s*$/m.test(trimmed) || /^not ok\b/m.test(trimmed)) throw new Error('Expected successful node --test TAP output');
  const candidates = trimmed.split(/\r?\n/).filter(line => /^#\s+\{"schema":1,"evidence":"offline-synthetic"/.test(line));
  if (candidates.length !== 1) throw new Error('Expected exactly one baseline diagnostic');
  return JSON.parse(candidates[0].replace(/^#\s+/, ''));
}

function selfTest() {
  const check = (condition, label) => { if (!condition) throw new Error(`Self-test failed: ${label}`); };
  const rejects = (fn, pattern) => { let caught; try { fn(); } catch (error) { caught = error; } check(caught && pattern.test(caught.message), String(pattern)); };
  const hash = 'a'.repeat(64), out = 'b'.repeat(64);
  const measured = { inputSha256: hash, outputSha256: out, samples: 15, p50Ms: 10, p95Ms: 20 };
  const base = { schema: 1, evidence: 'offline-synthetic', tokenEstimatesAreNotBilledUsage: true, environment: { node: 'v22', platform: 'linux', arch: 'x64', commit: 'before', dirty: false },
    contexts: [...['en', 'zh', 'mixed', 'unicode'].map(id => ({ id, inputSha256: hash, taskEstimate: 100 })), { id: 'SZ1c', ...measured, chatEstimate: 100 }],
    taskContexts: ['en-small', 'zh-large'].map(id => ({ id, ...measured, estimatedInputTokens: 100 })),
    layouts: [64, 256, 1024].map(nodes => ({ nodes, ...measured })) };
  const next = () => { const report = JSON.parse(JSON.stringify(base)); report.environment.commit = 'after'; return report; };
  let candidate = next();
  candidate.contexts[4].p50Ms = 5;
  check(compare(base, candidate, true).rows[4].timing.p50Ms.after === 5, 'matching output timing');
  check(compare(base, candidate).rows.every(row => row.timing === null), 'machine attestation required');
  candidate.environment.node = 'v23';
  check(!compare(base, candidate, true).timingEligible, 'environment mismatch');
  candidate = next(); candidate.contexts[4].outputSha256 = 'c'.repeat(64); candidate.contexts[4].chatEstimate = 80;
  const change = compare(base, candidate, true).rows[4];
  check(change.outputChanged && change.timing === null && change.deltas.chatEstimate.delta === -20, 'changed output requires review');
  candidate = next(); candidate.contexts[4].inputSha256 = 'c'.repeat(64);
  rejects(() => compare(base, candidate), /Input changed/);
  candidate = next(); candidate.layouts.pop();
  rejects(() => compare(base, candidate), /Missing required fixture/);
  candidate = next(); candidate.environment.dirty = true;
  rejects(() => compare(base, candidate), /clean committed/);
  candidate = next(); candidate.layouts[0].samples = 1;
  rejects(() => compare(base, candidate), /Invalid full-run/);
  candidate = next(); candidate.contexts.push(candidate.contexts[0]);
  rejects(() => compare(base, candidate), /duplicate/);
  const json = JSON.stringify(base);
  check(readReport(json).environment.commit === 'before', 'JSON report');
  check(readReport(`# ${json}\n# fail 0\n`).environment.commit === 'before', 'TAP report');
  rejects(() => readReport(`# ${json}\n# fail 1\n`), /successful/);
  rejects(() => readReport(`# ${json}\n# ${json}\n# fail 0\n`), /exactly one/);
  return 13;
}

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--self-test') {
    process.stdout.write(`Self-tests passed: ${selfTest()}\n`);
  } else {
    const sameMachine = args.includes('--same-machine');
    const paths = args.filter(arg => arg !== '--same-machine');
    if (paths.length !== 2 || paths.some(path => path.startsWith('--'))) throw new Error('Usage: node scripts/compare-engineering-baseline.mjs before.tap after.tap [--same-machine]');
    const result = compare(readReport(readFileSync(paths[0], 'utf8')), readReport(readFileSync(paths[1], 'utf8')), sameMachine);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
