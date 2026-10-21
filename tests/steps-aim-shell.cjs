// S3 lane A: the AIM prompt shell lives in core/steps/aim as Markdown fragments (zh and en); the phase task text stays
// with the AIM experience. Snapshots (prompt-snapshots.cjs) pin the rendered text; these tests pin the file layout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');

const directory = path.join(root, 'core', 'steps', 'aim');
const shell = fs.readFileSync(path.join(directory, 'shell.ts'), 'utf8');
const names = folder => fs.readdirSync(path.join(directory, folder)).filter(name => name.endsWith('.md'));

test('every AIM shell fragment and phase rule has a zh and an en file, both non-empty and used by shell.ts', () => {
  for (const folder of ['.', 'phase']) {
    const files = names(folder);
    assert.ok(files.length > 0);
    for (const file of files) {
      const base = file.replace(/\.(zh|en)\.md$/, '');
      assert.notEqual(base, file, `${folder}/${file} must be named <name>.zh.md or <name>.en.md`);
      for (const language of ['zh', 'en']) {
        const body = fs.readFileSync(path.join(directory, folder, `${base}.${language}.md`), 'utf8');
        assert.ok(body.trim().length > 0 && body.endsWith('\n') && !body.endsWith('\n\n'), `${folder}/${base}.${language}.md: one text line ending in one newline`);
      }
      const reference = folder === '.' ? `"./${file}"` : `"./phase/${file}"`;
      assert.ok(shell.includes(reference), `${reference} is not imported by shell.ts`);
    }
  }
});

test('the phase rules are exactly the 14 AIM phases that have rules; evidence-reuse-audit has none', () => {
  const phases = [...new Set(names('phase').map(file => file.replace(/\.(zh|en)\.md$/, '')))].sort();
  assert.equal(phases.length, 14);
  assert.ok(!phases.includes('evidence-reuse-audit'));
  const { buildAimPrompt } = load('ai/aim-prompt.ts');
  const base = { title: 'T', summary: 'S', rules: '', detail: '', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  for (const phase of phases) for (const [language, locale] of [['zh', 'zh-TW'], ['en', 'en']]) {
    const rule = fs.readFileSync(path.join(directory, 'phase', `${phase}.${language}.md`), 'utf8').trimEnd();
    assert.ok(buildAimPrompt({ ...base, task: `<!-- aim-phase: ${phase} -->\nGo` }, locale).includes(rule), `${phase} ${language} rule is in the prompt`);
  }
  const reuse = buildAimPrompt({ ...base, task: '<!-- aim-phase: evidence-reuse-audit -->\nGo' }, 'en');
  const plain = buildAimPrompt({ ...base, task: 'Go' }, 'en');
  assert.equal(reuse.split('\n\n').length, plain.split('\n\n').length, 'no phase rule block for a phase without a rule');
});

test('ai/aim-prompt.ts keeps its public names and re-exports the shell', () => {
  const viaAi = load('ai/aim-prompt.ts'), viaShell = load('core/steps/aim/shell.ts');
  const context = { title: 'T', summary: 'S', rules: '', detail: '', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'research', researchDepth: 'fast', visualMode: 'off', task: '<!-- aim-phase: report-review -->\nGo' };
  assert.equal(typeof viaAi.buildAimPrompt, 'function');
  for (const language of ['zh', 'en']) assert.equal(viaAi.buildAimPrompt(context, language), viaShell.buildAimPrompt(context, language));
  assert.equal(viaAi.aimPhase('x <!-- aim-phase: delivery-outline --> y'), 'delivery-outline');
  assert.equal(viaAi.aimPhase('no marker'), undefined);
});

test('the AIM shell does not import experiences', () => {
  assert.doesNotMatch(shell, /experiences\//);
});
