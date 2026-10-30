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
