// The wiring check (scripts/check-test-wiring.mjs): a test file that no verify script runs is reported; wired files, globs and helpers are not.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');
const checker = () => import(pathToFileURL(path.join(root, 'scripts', 'check-test-wiring.mjs')).href);

const VAULT = 'export const parts = [{ name: "v", args: ["--test", "tests/test-vault.mjs"] }];';
function fixture(files, unitScript, integration = VAULT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-wiring-'));
  fs.mkdirSync(path.join(dir, 'tests')); fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': unitScript } }));
  fs.writeFileSync(path.join(dir, 'scripts', 'test-integration.mjs'), integration);
  for (const name of files) fs.writeFileSync(path.join(dir, 'tests', name), '');
  return dir;
}

test('test wiring: an unwired test file is reported, a wired one, a glob match, a support file and a helper are not', async () => {
  const { findUnwired } = await checker();
  const dir = fixture(['wired.cjs', 'steps-a.cjs', 'dummy-unwired.cjs', 'support-x.cjs', 'build.cjs', 'run.cjs', 'test-vault.mjs'], 'node --test tests/wired.cjs tests/steps-*.cjs');
  try { assert.deepEqual(await findUnwired(dir), ['dummy-unwired.cjs']); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('test wiring: a file mentioned only in a comment is not wired, in test:unit or in test-integration.mjs', async () => {
  const { findUnwired } = await checker();
  const commented = fixture(['a.cjs', 'b.cjs', 'test-vault.mjs'], 'node --test tests/a.cjs # tests/b.cjs');
  const dropped = fixture(['a.cjs', 'test-vault.mjs'], 'node --test tests/a.cjs', '// tests/test-vault.mjs was here\nexport const parts = [];');
  try {
    assert.deepEqual(await findUnwired(commented), ['b.cjs']);
    assert.deepEqual(await findUnwired(dropped), ['test-vault.mjs']);
  } finally { for (const dir of [commented, dropped]) fs.rmSync(dir, { recursive: true, force: true }); }
});

// test:aim must run every test of the AIM suites (tests/suites/aim-*.cjs) plus every top-level AIM test file; a dropped one is a silent gap.
// The expected names are the fixture tests/snapshots/aim-suite-tests.json. Regenerate it after adding or renaming an AIM suite test: UPDATE_AIM_SUITE_TESTS=1 node --test --test-name-pattern='test:aim runs' tests/run.cjs
const { spawnSync } = require('node:child_process');
const aimFixture = path.join(root, 'tests', 'snapshots', 'aim-suite-tests.json');
const aimCommands = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['test:aim'].split('&&').map(part => part.trim());
// Registers the suites named by the test:aim command in a child process with node:test replaced by a recorder, so nothing runs and only the registered names come back.
const recorder = "const Module = require('node:module'); const names = []; const load = Module._load; Module._load = function (request, ...rest) { if (request === 'node:test') return { test: name => { names.push(name); } }; return load.call(this, request, ...rest); }; require('./tests/run.cjs'); process.stdout.write(JSON.stringify(names));";
function aimSuiteTests(command) {
  const env = { ...process.env, VAM_SUITES: /VAM_SUITES=(\w+)/.exec(command)?.[1] ?? '' };
  const result = spawnSync(process.execPath, ['-e', recorder], { cwd: root, env, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function aimSelection() {
  const command = aimCommands().find(part => part.startsWith('VAM_SUITES=aim '));
  assert.ok(command && /\snode --test tests\/run\.cjs\s/.test(command), 'test:aim must run tests/run.cjs with VAM_SUITES=aim and no name pattern');
  assert.ok(!command.includes('--test-name-pattern'), 'the AIM suites run without a name pattern');
  const files = command.split(/\s+/).filter(word => /^tests\/[\w*.-]+\.cjs$/.test(word) && word !== 'tests/run.cjs');
  const patterns = files.map(file => new RegExp(`^${file.slice('tests/'.length).replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`));
  const topLevel = fs.readdirSync(path.join(root, 'tests')).filter(name => patterns.some(pattern => pattern.test(name))).sort();
  return { suiteTests: aimSuiteTests(command), topLevel };
}
test('test:aim runs every AIM suite test and every top-level AIM test file', () => {
  const { suiteTests, topLevel } = aimSelection();
  if (process.env.UPDATE_AIM_SUITE_TESTS) fs.writeFileSync(aimFixture, `${JSON.stringify(suiteTests, null, 2)}\n`);
  assert.deepEqual(suiteTests, JSON.parse(fs.readFileSync(aimFixture, 'utf8')), 'AIM suite tests selected by test:aim differ from tests/snapshots/aim-suite-tests.json');
  const wanted = fs.readdirSync(path.join(root, 'tests')).filter(name => /^(aim-|steps-aim-)[\w-]*\.cjs$/.test(name) || name === 'codex-parallel-runtime.cjs').sort();
  assert.deepEqual(topLevel, wanted, 'test:aim must name every top-level aim-*, steps-aim-* test file and codex-parallel-runtime.cjs');
});
