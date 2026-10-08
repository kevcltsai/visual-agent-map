const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
function load(entry) {
  const code = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
  const loaded = { exports: {} };
  new Function('module', 'exports', code)(loaded, loaded.exports);
  return loaded.exports;
}

const { createSession } = load('experiences/coffee-tables/types.ts');
const { observerOnlyPrompt } = load('experiences/coffee-tables/prompts.ts');
const { observerSourceAuditPrompt, parseObserverSourceAuditResponse } = load('experiences/coffee-tables/observer-source-audit.ts');

test('observer refresh requires one proposition per cited bullet in English and Traditional Chinese', () => {
  for (const language of ['en', 'zh-TW']) {
    const prompt = observerOnlyPrompt(createSession('Fictional family discussion', 'fixture-model', 'low', language));
    assert.match(prompt, /coffee-insight:new/);
    assert.match(prompt, /source-id:turn-001/);
    if (language === 'en') {
      assert.match(prompt, /one central claim and its single line of reasoning/);
      assert.match(prompt, /never put a new-item marker on a separate preceding line/);
      assert.match(prompt, /fewest IDs that directly support the item/);
      assert.match(prompt, /separate materially different reasons or conditions into different bullets/);
      assert.match(prompt, /directly support that bullet's claim, reason and conditions/);
      assert.match(prompt, /every insight must be its own line beginning with `- `/);
      assert.match(prompt, /only when the dialogue contains claims or reasons that are actually incompatible/);
      assert.match(prompt, /each distinct, source-supported reason or condition and represent it at least once/);
      assert.match(prompt, /A question is also a claim: every person, condition, reason or consequence it introduces must have direct source support/);
      assert.match(prompt, /if a part has no supporting source, remove that part or narrow the question/);
      assert.doesNotMatch(prompt, /at least \d+ insights per category|produce exactly \d+ insights/i);
    } else {
      assert.match(prompt, /一個項目只表達一個中心主張及其同一條理由鏈/);
      assert.match(prompt, /不得把新項目的標記單獨放在上一行/);
      assert.match(prompt, /直接支持該項主張、理由及條件所需的最少 ID/);
      assert.match(prompt, /不同理由或條件分成不同項目/);
      assert.match(prompt, /該項所附來源 ID 對應的原始發言直接支持/);
      assert.match(prompt, /即使該類只有一項也不可改成段落/);
      assert.match(prompt, /主張或理由確實互不相容時才列入「核心分歧」/);
      assert.match(prompt, /每個有獨立理由或成立條件、且有來源支持的重點至少記錄一次/);
      assert.match(prompt, /問題也是主張：若問題引入人物、成立條件、原因或後果，每一部分都必須有直接支持它的來源/);
      assert.match(prompt, /若某部分沒有來源，就刪除該部分或縮窄問題/);
      assert.doesNotMatch(prompt, /每類至少\s*\d+\s*個洞見|每類恰好\s*\d+\s*個洞見/);
    }
  }
});

test('fixed provenance oracle detects the saved cross-turn question missing its child-voice source', () => {
  // This human-labelled fixture oracle is not a production semantic checker.
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/coffee-observer-source-mismatch.json'), 'utf8'));
  const rawItem = fixture.rawProviderResponse.split(/\r?\n/).find(line => line.includes(fixture.failingItem));
  assert.ok(rawItem, `failing item remains frozen from candidate ${fixture.candidateMainSha256}`);
  const citedSourceIds = [...rawItem.matchAll(/<!--\s*source-id:([^>]+?)\s*-->/g)].flatMap(([, ids]) => ids.split(/[\s,]+/).filter(Boolean));
  assert.deepEqual(citedSourceIds, fixture.citedSourceIds);
  assert.equal(fixture.sourceOracle.familyTimeAndCareConditions.sourceId, 'turn-005');
  assert.equal(fixture.sourceOracle.childVoiceAndExpression.sourceId, 'turn-003');
  const requiredByClause = fixture.requiredSourceIdsByClause;
  const missing = Object.entries(requiredByClause).filter(([, ids]) => !ids.every(id => citedSourceIds.includes(id))).map(([clause]) => clause);
  assert.deepEqual(missing, ['childVoiceAndExpression']);

  const correctedSourceIds = ['turn-003', 'turn-005'];
  const correctedMissing = Object.entries(requiredByClause).filter(([, ids]) => !ids.every(id => correctedSourceIds.includes(id))).map(([clause]) => clause);
  assert.deepEqual(correctedMissing, []);
});

test('observer source audit sees only attached excerpts and requires exact one-time verdicts', () => {
  const items = [
    { id: 'direction-a', category: 'directions', summary: 'Compare how families include children in rules and account for shift work.', detail: '', sources: ['Families with time to negotiate can more easily set rules together; shift work and care pressure affect how they do it.'], mergedIds: [] },
  ];
  const prompt = observerSourceAuditPrompt(items, 'en');
  assert.match(prompt, /only that item's attached citedSourceExcerpts/);
  assert.match(prompt, /Families with time to negotiate/);
  assert.doesNotMatch(prompt, /children cannot participate in setting rules/);
  assert.match(prompt, /do not borrow from another item, uncited dialogue/i);

  assert.deepEqual(parseObserverSourceAuditResponse(JSON.stringify({ reviews: [{ id: 'direction-a', verdict: 'unsupported', reason: 'The excerpt covers family constraints, not child participation.' }] }), ['direction-a']), [
    { id: 'direction-a', verdict: 'unsupported', reason: 'The excerpt covers family constraints, not child participation.' },
  ]);
  for (const malformed of [
    { reviews: [] },
    { reviews: [{ id: 'direction-a', verdict: 'supported', reason: 'ok' }, { id: 'direction-a', verdict: 'supported', reason: 'duplicate' }] },
    { reviews: [{ id: 'other', verdict: 'supported', reason: 'wrong id' }] },
    { reviews: [{ id: 'direction-a', verdict: 'invalid', reason: 'bad verdict' }] },
    { reviews: [{ id: 'direction-a', verdict: 'uncertain', reason: '' }] },
  ]) assert.throws(() => parseObserverSourceAuditResponse(JSON.stringify(malformed), ['direction-a']));
});
