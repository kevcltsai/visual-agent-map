// The workflow YAML check (scripts/check-workflows.mjs): an unparsable workflow file is reported; valid files and a missing directory pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');
const checker = () => import(pathToFileURL(path.join(root, 'scripts', 'check-workflows.mjs')).href);

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-workflows-'));
  if (files) {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.github', 'workflows', name), text);
  }
  return dir;
}
const VALID = 'name: ok\non: push\nrun-name: "CI: ${{ github.ref_name }}"\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';

test('check workflows: an unquoted colon in run-name is reported with the file name', async () => {
  const { checkWorkflows } = await checker();
  const dir = fixture({ 'bad.yml': 'name: x\non: push\nrun-name: CI: ${{ github.ref_name }}\njobs: {}\n', 'good.yml': VALID });
  try {
    const { errors } = checkWorkflows(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^bad\.yml: /);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('check workflows: valid files (yml and yaml) pass', async () => {
  const { checkWorkflows } = await checker();
  const dir = fixture({ 'a.yml': VALID, 'b.yaml': VALID });
  try { assert.deepEqual(checkWorkflows(dir), { checked: 2, missing: false, errors: [] }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('check workflows: a file that is not a mapping is reported', async () => {
  const { checkWorkflows } = await checker();
  const dir = fixture({ 'empty.yml': '', 'list.yml': '- a\n- b\n' });
  try { assert.deepEqual(checkWorkflows(dir).errors.map(line => line.split(':')[0]), ['empty.yml', 'list.yml']); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('check workflows: a missing .github/workflows directory passes and says so', async () => {
  const { checkWorkflows } = await checker();
  const dir = fixture(null);
  try { assert.deepEqual(checkWorkflows(dir), { checked: 0, missing: true, errors: [] }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('check workflows: the repository workflows parse', async () => {
  const { checkWorkflows } = await checker();
  assert.deepEqual(checkWorkflows(root).errors, []);
});
