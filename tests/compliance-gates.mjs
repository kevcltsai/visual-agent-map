import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');

test('strict lint rejects deprecated and unsafe code with real configured rules', () => {
  const source = `import { App } from "obsidian";
function typed(value: string): void { console.debug(value); }
export function regression(app: App): string {
  const value = JSON.parse("{}");
  value();
  console.debug(value.member, app.workspace.activeLeaf);
  typed(value);
  return value;
}`;
  const result = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '--stdin', '--stdin-filename', 'main.ts', '--max-warnings=0', '--format', 'json'], { cwd: root, input: source, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const rules = new Set(JSON.parse(result.stdout).flatMap(file => file.messages.map(message => message.ruleId)));
  for (const rule of ['no-deprecated', 'no-unsafe-assignment', 'no-unsafe-call', 'no-unsafe-member-access', 'no-unsafe-argument', 'no-unsafe-return']) assert.ok(rules.has(`@typescript-eslint/${rule}`), `Missing ${rule}`);
});

test('artifact gate rejects invalid manifests, version drift and missing distribution files', async () => {
  const files = ['main.js', 'manifest.json', 'styles.css', 'README.md', 'README.zh-TW.md', 'INSTALL.md', 'LICENSE', 'response-schema.json', 'package.json', 'package-lock.json', 'versions.json'];
  const parent = mkdtempSync(join(tmpdir(), 'vam-compliance-'));
  let count = 0;
  // Each case gets its own directory (a copy-on-write clone where the file system has one, a plain copy otherwise; the case only ever writes to the copy), so the cases run side by side.
  const prepare = change => { const directory = join(parent, String(count++)); mkdirSync(directory); for (const file of files) copyFileSync(join(root, file), join(directory, file), constants.COPYFILE_FICLONE); change?.(directory); return directory; };
  const run = directory => new Promise(done => execFile(process.execPath, [join(root, 'scripts/check-artifacts.mjs')], { cwd: directory, encoding: 'utf8' }, (error, stdout, stderr) => done({ status: error ? error.code : 0, stderr })));
  const readJson = (directory, file) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
  const edit = (file, change) => directory => { const path = join(directory, file); const data = readJson(directory, file); change(data, directory); writeFileSync(path, JSON.stringify(data)); };
  const cases = [];
  for (const [field, value, message] of [['author', '', 'Invalid manifest field'], ['minAppVersion', 'latest', 'Invalid manifest minAppVersion'], ['isDesktopOnly', false, 'must be desktop-only'], ['version', '99.0.0', 'versions must match']]) {
    cases.push({ change: edit('manifest.json', manifest => { manifest[field] = value; }), message });
  }
  for (const [file, change, message] of [
    ['package-lock.json', lock => { lock.packages[''].version = '0.0.1'; }, 'package-lock.json and manifest.json versions must match'],
    ['package-lock.json', lock => { lock.version = '0.0.1'; }, 'package-lock.json and manifest.json versions must match'],
    ['versions.json', (versions, directory) => { const manifest = readJson(directory, 'manifest.json'); versions[manifest.version] = '0.0.1'; }, 'versions.json must map the current release to manifest.minAppVersion'],
    ['manifest.json', manifest => { manifest.minAppVersion = '0.0.1'; }, 'versions.json must map the current release to manifest.minAppVersion']
  ]) cases.push({ change: edit(file, change), message });
  for (const file of ['main.js', 'styles.css', 'manifest.json', 'LICENSE', 'README.md', 'README.zh-TW.md', 'INSTALL.md']) {
    cases.push({ change: directory => rmSync(join(directory, file)), message: file });
  }
  try {
    assert.equal((await run(prepare())).status, 0);
    const results = new Array(cases.length);
    let next = 0;
    const worker = async () => { while (next < cases.length) { const at = next++; results[at] = await run(prepare(cases[at].change)); } };
    await Promise.all(Array.from({ length: 4 }, worker));
    cases.forEach(({ message }, at) => { assert.notEqual(results[at].status, 0, message); assert.ok(results[at].stderr.includes(message), results[at].stderr); });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
