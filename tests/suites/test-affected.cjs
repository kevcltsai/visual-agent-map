// Test selection (scripts/test-affected.mjs): which test files a change reaches, and every condition that must fall back to the full suite.
// Also the "only a full CI run counts" rule of scripts/find-green-ci-run.sh and .githooks/pre-push, and the dependency recording in tests/build.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');
const affected = () => import(pathToFileURL(path.join(root, 'scripts', 'test-affected.mjs')).href);
const integration = () => import(pathToFileURL(path.join(root, 'scripts', 'test-integration.mjs')).href);

/** A table over two tests: map-model reads map-model.ts and core/steps/ai-task/language.en.md; a spawning test is always run. */
async function table(extra = {}) {
  const { buildDeps } = await affected();
  return buildDeps({
    testFiles: ['tests/suites/map-model.cjs', 'tests/suites/spawner.cjs', 'tests/steps-x.cjs'],
    records: { 'tests/suites/map-model.cjs': ['map-model.ts', 'core/steps/ai-task/language.en.md'], 'tests/steps-x.cjs': ['ui/x.ts', 'README.md'] },
    scans: { 'tests/suites/map-model.cjs': { sources: [], prefixes: ['tests/snapshots/'], requires: [], reasons: [] }, 'tests/suites/spawner.cjs': { sources: [], prefixes: [], requires: [], reasons: ['spawns a child process'] }, ...extra },
    sha: 'a'.repeat(40), generatedAt: 'now'
  });
}
const files = ['tests/suites/map-model.cjs', 'tests/suites/spawner.cjs', 'tests/steps-x.cjs'];
async function pick(changed, options = {}) {
  const { selectTests } = await affected();
  return selectTests({ changed, deps: options.deps === undefined ? await table() : options.deps, testFiles: files, shaIsAncestor: options.shaIsAncestor ?? true });
}

test('test-affected: a source change selects the tests that use it plus the always-run tests, with the reason for each', async () => {
  const result = await pick(['map-model.ts']);
  assert.equal(result.mode, 'files');
  assert.deepEqual(result.files, ['tests/suites/map-model.cjs', 'tests/suites/spawner.cjs']);
  assert.ok(result.reasons.includes('tests/suites/map-model.cjs: uses map-model.ts'));
  assert.ok(result.reasons.some(reason => reason.startsWith('tests/suites/spawner.cjs: always runs: spawns a child process')));
});
test('test-affected: a changed test file runs itself; a file under a read directory selects its reader', async () => {
  assert.deepEqual((await pick(['tests/steps-x.cjs'])).files, ['tests/steps-x.cjs', 'tests/suites/spawner.cjs']);
  assert.deepEqual((await pick(['tests/snapshots/new.json'])).files, ['tests/suites/map-model.cjs', 'tests/suites/spawner.cjs']);
});
test('test-affected: every infrastructure, tooling and configuration change runs the full suite', async () => {
  for (const file of ['tests/support.cjs', 'tests/support-dom.cjs', 'tests/build.cjs', 'tests/run.cjs', 'tests/tools/aim-node.cjs', 'tests/fixtures/color/a.json', 'scripts/test-unit.mjs', 'package.json', 'package-lock.json', 'esbuild.config.mjs', 'tsconfig.json', 'tsconfig.build.json', '.github/workflows/ci.yml', '.githooks/pre-push']) {
    const result = await pick(['map-model.ts', file]);
    assert.equal(result.mode, 'full', file);
    assert.match(result.reasons[0], new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
test('test-affected: a changed file the table does not know runs the full suite, also next to known files', async () => {
  const result = await pick(['map-model.ts', 'ui/brand-new.ts']);
  assert.equal(result.mode, 'full');
  assert.match(result.reasons[0], /ui\/brand-new\.ts is not in the dependency table/);
});
test('test-affected: a missing table, a table whose commit is not an ancestor of the base, and no changed file run the full suite', async () => {
  assert.match((await pick(['map-model.ts'], { deps: null })).reasons[0], /missing or unreadable/);
  assert.equal((await pick(['map-model.ts'], { deps: null })).mode, 'full');
  const stale = await pick(['map-model.ts'], { shaIsAncestor: false });
  assert.equal(stale.mode, 'full');
  assert.match(stale.reasons[0], /not an ancestor/);
  assert.equal((await pick([])).mode, 'full');
});
test('test-affected: an unreadable table, a script error and a bad base run the full suite', async () => {
  const { parseDeps, plan } = await affected();
  for (const text of ['', '{', '{"version":1}', '{"version":2,"sha":"abcdef1","paths":[],"tests":{}}', '{"version":1,"sha":"not a sha","paths":[],"tests":{}}']) assert.throws(() => parseDeps(text), undefined, text);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-affected-'));
  try {
    const result = plan(empty, 'origin/main'); // not a git repository: the git call throws
    assert.equal(result.mode, 'full');
    assert.match(result.reasons[0], /test-affected failed/);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
test('test-affected: a documentation-only change runs no tests, but product Markdown and documents a test reads count as code', async () => {
  for (const changed of [['docs/x.md'], ['README.md', 'CHANGELOG.md', 'INSTALL.md', 'README.zh-TW.md', 'docs/a/b.md']]) {
    const result = await pick(changed.filter(file => file !== 'README.md'));
    assert.deepEqual([result.mode, result.files], ['none', []], changed.join());
  }
  const prompt = await pick(['core/steps/ai-task/language.en.md']);
  assert.equal(prompt.mode, 'files');
  assert.ok(prompt.files.includes('tests/suites/map-model.cjs'));
  const unlisted = await pick(['core/steps/other-step/language.en.md']);
  assert.equal(unlisted.mode, 'full');
  assert.equal((await pick(['README.md'])).files.includes('tests/steps-x.cjs'), true); // a test reads README.md in this table
  assert.deepEqual((await pick(['docs/x.md', 'map-model.ts'])).files, ['tests/suites/map-model.cjs', 'tests/suites/spawner.cjs']);
});
test('test-affected: a test missing from the table is run, a deleted test is not', async () => {
  const { selectTests } = await affected();
  const result = selectTests({ changed: ['map-model.ts'], deps: await table(), testFiles: [...files, 'tests/suites/newer.cjs'], shaIsAncestor: true });
  assert.ok(result.files.includes('tests/suites/newer.cjs'));
  const without = selectTests({ changed: ['map-model.ts'], deps: await table(), testFiles: files.slice(1) });
  assert.ok(!without.files.includes('tests/suites/map-model.cjs'));
});

test('test-affected: the static scan lists literal paths and helpers, and marks spawning, direct esbuild and run-time paths as always run', async () => {
  const { scanTestFile } = await affected();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-scan-'));
  try {
    fs.mkdirSync(path.join(dir, 'tests/suites'), { recursive: true }); fs.mkdirSync(path.join(dir, 'core/steps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'core/a.ts'), ''); fs.writeFileSync(path.join(dir, 'core/steps/s.md'), ''); fs.writeFileSync(path.join(dir, 'tests/support.cjs'), '');
    const scan = text => scanTestFile(dir, 'tests/suites/t.cjs', text);
    const literal = scan("const { x } = require('../support.cjs'); const fs = require('fs'); const path = require('path'); const root = path.resolve(__dirname, '..', '..');\nfs.readFileSync(path.join(root, 'core', 'a.ts'), 'utf8'); fs.readdirSync(path.join(root, 'core/steps'));");
    assert.deepEqual([literal.sources, literal.prefixes, literal.requires, literal.reasons], [['core/a.ts', 'tests/support.cjs'], ['core/steps/'], ['tests/support.cjs'], []]);
    assert.match(scan("require('node:child_process').spawnSync('x')").reasons[0], /spawns/);
    assert.match(scan("const esbuild = require('esbuild');").reasons[0], /esbuild/);
    assert.match(scan("fs.readFileSync(path.join(root, name))").reasons[0], /run time/);
    assert.match(scan("fs.readFileSync(`${root}/${name}`)").reasons[0], /run time/);
    assert.match(scan("fs.readFileSync(path.join(__dirname, '..', file))").reasons[0], /run time/);
    // A path finished at run time under a literal directory is covered by that directory; a bare variable has its repo paths in the literals.
    assert.deepEqual([scan("fs.readFileSync(path.join(root, 'core', 'steps', name, 'x.md'))").prefixes, scan("fs.readFileSync(path.join(root, 'core', 'steps', name, 'x.md'))").reasons], [['core/steps/'], []]);
    assert.deepEqual(scan("fs.readFileSync(`${root}/core/steps/${name}`)").prefixes, ['core/steps/']);
    assert.deepEqual(scan("const f = pick(); fs.readFileSync(f)").reasons, []);
    assert.deepEqual(scan("X ??= load('ai/a.ts').X; if (!Y) Y = load(\"core/b.ts\"); const Z = load('c.ts');").cachedLoads, ['ai/a.ts', 'core/b.ts']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('test-affected: the static scan marks a bare-variable read in a repo-aware test as always run, and keeps paths hidden by quotes, calls and absent files', async () => {
  const { scanTestFile } = await affected();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-scan-'));
  try {
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true }); fs.mkdirSync(path.join(dir, 'core'), { recursive: true }); fs.mkdirSync(path.join(dir, 'experiences/x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'core/ai-calls.ts'), '');
    const scan = text => scanTestFile(dir, 'tests/t.cjs', text);
    // A walker that gets its directory from a parameter, in a test that refers to the repo root.
    assert.match(scan("const root = process.cwd(); function walk(directory) { return fs.readdirSync(directory); } walk(root);").reasons.join(), /variable path/);
    assert.deepEqual(scan("const out = os.tmpdir(); fs.readdirSync(out);").reasons, []); // no repo reference: a scratch directory
    // A backtick in a comment pairs with a later one and swallows the quoted path; the plain path scan still finds it.
    const swallowed = scan("// uses `x\nconst f = `${a}`; const s = sources['core/ai-calls.ts']; // end `");
    assert.deepEqual(swallowed.sources, ['core/ai-calls.ts']);
    // A directory built by join and handed to a function, not to an fs call.
    assert.deepEqual(scan("const root = process.cwd(); visit(path.join(root, 'experiences', 'x'));").prefixes, ['experiences/x/']);
    // A path the test asserts to be absent still counts.
    assert.deepEqual(scan("const root = process.cwd(); assert.equal(fs.existsSync(path.join(root, 'experiences', 'x', 'gone.ts')), false);").sources, ['experiences/x/gone.ts']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('test-affected: a changed suite runs every suite, because the suites of a shard share one process', async () => {
  const { selectTests } = await affected();
  const deps = await table();
  const all = ['tests/suites/map-model.cjs', 'tests/suites/spawner.cjs', 'tests/suites/other.cjs', 'tests/steps-x.cjs'];
  const result = selectTests({ changed: ['tests/suites/other.cjs'], deps, testFiles: all });
  assert.deepEqual(result.files, ['tests/suites/map-model.cjs', 'tests/suites/other.cjs', 'tests/suites/spawner.cjs']);
  assert.deepEqual(selectTests({ changed: ['tests/steps-x.cjs'], deps, testFiles: all }).files, ['tests/steps-x.cjs', 'tests/suites/other.cjs', 'tests/suites/spawner.cjs']); // other.cjs: not in the table
});
test('test-affected: a rename lists both paths, and a table older or newer than HEAD adds every file that differs from its commit', async () => {
  const { changedFiles, plan, buildDeps } = await affected();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-git-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  try {
    fs.mkdirSync(path.join(dir, 'core'), { recursive: true }); fs.mkdirSync(path.join(dir, 'tests/suites'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'core/old-name.ts'), 'export const a = 1;\n'.repeat(20)); fs.writeFileSync(path.join(dir, 'core/other.ts'), 'x\n'); fs.writeFileSync(path.join(dir, 'tests/suites/s.cjs'), '');
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'one');
    const tableSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'branch'); git('mv', 'core/old-name.ts', 'core/new-name.ts'); git('commit', '-q', '-m', 'rename');
    assert.deepEqual(changedFiles(dir, 'main').sort(), ['core/new-name.ts', 'core/old-name.ts']);
    // The table was made at a commit before main gained core/other.ts's new import: that file differs from the table's commit even though the branch did not touch it.
    git('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'core/other.ts'), 'import "./x";\n'); git('commit', '-q', '-am', 'main moves on');
    git('checkout', '-q', 'branch'); fs.writeFileSync(path.join(dir, 'core/new-name.ts'), 'export const b = 2;\n'); git('commit', '-q', '-am', 'edit');
    const upToMain = git('rev-parse', 'main');
    assert.ok(!changedFiles(dir, 'main').includes('core/other.ts')); // a plain three-dot diff misses it
    assert.ok(changedFiles(dir, 'main', upToMain).includes('core/other.ts')); // HEAD lacks main's newer commit: it differs from a table made at main
    assert.ok(changedFiles(dir, 'main', tableSha).includes('core/new-name.ts'));
    const deps = buildDeps({ testFiles: ['tests/suites/s.cjs'], records: { 'tests/suites/s.cjs': ['core/other.ts'] }, scans: {}, sha: tableSha });
    fs.writeFileSync(path.join(dir, 'deps.json'), JSON.stringify(deps));
    process.env.VAM_TEST_DEPS_FILE = path.join(dir, 'deps.json');
    try {
      const result = plan(dir, 'main');
      assert.equal(result.mode, 'full'); // core/new-name.ts is not in the table, and neither is the suite directory's reader
    } finally { delete process.env.VAM_TEST_DEPS_FILE; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('test-affected: tests/build.cjs records the sources of every bundle for the calling test file, cache hits included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-deps-'));
  try {
    const script = path.join(root, 'tests', `affected-probe-${process.pid}.cjs`);
    fs.writeFileSync(script, "const { buildSync } = require('./build.cjs'); const o = { entryPoints: ['map-model.ts'], external: ['obsidian'] }; buildSync(o); buildSync(o);");
    try {
      const run = spawnSync(process.execPath, [script], { cwd: root, env: { ...process.env, VAM_TEST_DEPS_DIR: dir }, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
    } finally { fs.rmSync(script, { force: true }); }
    const [record] = fs.readdirSync(dir).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    assert.ok(record.callers[`tests/affected-probe-${process.pid}.cjs`].includes('map-model.ts'));
    assert.ok(record.bundles['map-model.ts'].includes('map-model.ts'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('test-affected: without VAM_TEST_DEPS_DIR nothing is recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-deps-'));
  try {
    const run = spawnSync(process.execPath, ['-e', "require('./tests/build.cjs').buildSync({ entryPoints: ['map-model.ts'], external: ['obsidian'] })"], { cwd: root, env: { ...process.env, VAM_TEST_DEPS_DIR: '' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('test-affected: VAM_AFFECTED_TESTS keeps the listed node --test files, drops a part left with none, and leaves run.cjs parts', async () => {
  const { applyAffected } = await integration();
  const parts = [{ name: 'run', args: ['tests/run.cjs', '--layer=unit'] }, { name: 'files', args: ['--test', 'tests/a.cjs', 'tests/b.cjs'] }, { name: 'vault', args: ['--test', 'tests/test-vault.mjs'] }];
  assert.equal(applyAffected(parts, {}), parts);
  assert.deepEqual(applyAffected(parts, { VAM_AFFECTED_TESTS: 'tests/b.cjs,tests/suites/x.cjs' }).map(part => part.args), [['tests/run.cjs', '--layer=unit'], ['--test', 'tests/b.cjs']]);
  assert.deepEqual(applyAffected(parts, { VAM_AFFECTED_TESTS: 'tests/suites/x.cjs' }).map(part => part.name), ['run']);
});

// A fake gh answers `gh run list` with the given tab-separated rows (id, head sha, run name, optional conclusion; default success).
// Like the real listing, it returns nothing when `--status` is passed: the status filter lags behind finished workflow_dispatch runs.
function fakeGh(rows, exit = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-gh-'));
  const bin = path.join(dir, 'gh');
  fs.writeFileSync(path.join(dir, 'rows.tsv'), rows.map(row => (row.length < 4 ? [...row, 'success'] : row).join('\t')).join('\n'));
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do [ "$a" = --status ] && exit 0; done\ncat "${path.join(dir, 'rows.tsv')}"\nexit ${exit}\n`, { mode: 0o755 });
  return { dir, bin };
}
const SHA = 'f'.repeat(40);
const green = (rows, sha = SHA, exit = 0) => {
  const gh = fakeGh(rows, exit);
  try { return spawnSync('sh', ['scripts/find-green-ci-run.sh', sha], { cwd: root, env: { ...process.env, GH_BIN: gh.bin }, encoding: 'utf8' }); } finally { fs.rmSync(gh.dir, { recursive: true, force: true }); }
};
test('find-green-ci-run: a green affected run is never returned; a full run is, whatever else is listed', () => {
  const affectedOnly = green([['101', SHA, 'CI affected: fix a thing']]);
  assert.equal(affectedOnly.status, 1);
  assert.equal(affectedOnly.stdout, '');
  const both = green([['101', SHA, 'CI affected: x'], ['100', SHA, 'CI full: x']]);
  assert.deepEqual([both.status, both.stdout.trim()], [0, '100']);
  assert.equal(green([['99', SHA, 'fix: an old run named after its commit']]).status, 1);
  assert.equal(green([['100', 'e'.repeat(40), 'CI full: other commit']]).status, 1);
  assert.equal(green([['100', SHA, 'CI full: x']], SHA, 1).status, 1);
  assert.equal(green([]).status, 1);
  // Regression: the `--status success` filter hid finished runs for over an hour, so the script must not pass it and must read conclusion itself.
  const unfiltered = green([['100', SHA, 'CI full: dispatch', 'success']]);
  assert.deepEqual([unfiltered.status, unfiltered.stdout.trim()], [0, '100']);
  assert.equal(green([['100', SHA, 'CI full: x', 'failure']]).status, 1);
  assert.equal(green([['100', SHA, 'CI affected: x', 'success']]).status, 1);
  assert.equal(green([['100', 'e'.repeat(40), 'CI full: x', 'success']]).status, 1);
});
test('pre-push: a push to main with only an affected green run still runs the full verify; a full green run skips it; a feature branch runs verify:push', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-hook-'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\necho "npm $*"\n', { mode: 0o755 });
  const hook = (rows, ref) => {
    const gh = fakeGh(rows);
    try { return spawnSync('sh', ['.githooks/pre-push'], { cwd: root, input: `refs/heads/x ${head} ${ref} 0000\n`, env: { ...process.env, GH_BIN: gh.bin, PATH: `${dir}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8' }); } finally { fs.rmSync(gh.dir, { recursive: true, force: true }); }
  };
  try {
    assert.match(hook([['7', head, 'CI affected: x']], 'refs/heads/main').stdout, /npm run verify\b(?!:)/);
    assert.match(hook([['7', head, 'CI affected: x']], 'refs/tags/v1').stdout, /npm run verify\b(?!:)/);
    const reused = hook([['7', head, 'CI full: x']], 'refs/heads/main');
    assert.match(reused.stdout, /green CI run 7/);
    assert.doesNotMatch(reused.stdout, /npm run verify/);
    assert.match(hook([], 'refs/heads/feature').stdout, /npm run verify:push/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
