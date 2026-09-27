import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('artifact gate rejects invalid manifests, version drift and missing distribution files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vam-compliance-'));
  const files = ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE', 'response-schema.json', 'package.json', 'package-lock.json', 'versions.json'];
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/check-artifacts.mjs')], { cwd: directory, encoding: 'utf8' });
  const reset = () => { for (const file of files) copyFileSync(join(root, file), join(directory, file)); };
  try {
    reset(); assert.equal(run().status, 0);
    for (const [field, value, message] of [['author', '', 'Invalid manifest field'], ['minAppVersion', 'latest', 'Invalid manifest minAppVersion'], ['isDesktopOnly', false, 'must be desktop-only'], ['version', '99.0.0', 'versions must match']]) {
      reset(); const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')); manifest[field] = value;
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
      const result = run(); assert.notEqual(result.status, 0); assert.ok(result.stderr.includes(message), result.stderr);
    }
    for (const file of ['main.js', 'styles.css', 'manifest.json', 'LICENSE', 'README.md']) {
      reset(); rmSync(join(directory, file)); const result = run(); assert.notEqual(result.status, 0); assert.ok(result.stderr.includes(file));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
