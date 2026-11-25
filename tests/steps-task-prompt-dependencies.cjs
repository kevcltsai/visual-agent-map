const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');

test('task prompt assembly depends on policy, not its rendering facade', () => {
  const source = name => fs.readFileSync(path.join(root, 'core/steps/task', name + '.ts'), 'utf8');
  assert.doesNotMatch(source('assemble'), /from\s+["']\.\/render["']/);
  assert.doesNotMatch(source('prompt-policy'), /from\s+["']\.\/(?:render|assemble)["']/);
  const policy = load('core/steps/task/prompt-policy.ts');
  const render = load('core/steps/task/render.ts');
  const base = { mode: 'task', mapAiMode: 'quick', researchMode: 'local', researchDepth: 'normal' };
  for (const patch of [{}, { mode: 'synthesize' }, { mode: 'decompose' }, { countRepair: true }, { intermediateDetail: true }, { researchMode: 'research' }]) {
    const context = { ...base, ...patch };
    assert.equal(render.isQuickTask(context), policy.isQuickTask(context));
    assert.equal(render.readerFacingDetail(context), policy.readerFacingDetail(context));
    for (const language of ['en', 'zh-TW', 'zh-CN']) assert.equal(render.quickGuidance(context, language), policy.quickGuidance(context, language));
  }
});
