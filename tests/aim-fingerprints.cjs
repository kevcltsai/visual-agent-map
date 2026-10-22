// Pinned fingerprint values for AIM checkpoint reuse (final delivery and the manual-flow source fingerprint).
// A saved checkpoint is reused only when these digests match, so any change to the hashed inputs (for example a reworded
// context label) silently invalidates every saved checkpoint. Expected values below were computed on the unchanged code and
// are hard-coded on purpose: they must never be regenerated to make a refactor pass.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('./build.cjs');
const { fixture, answer, phaseOf, AimManualFlow } = require('./support-aim-fixture.cjs');

const moduleValue = { exports: {} };
vm.runInNewContext(buildSync({ entryPoints: ['experiences/aim/final-delivery.ts'] }).outputFiles[0].text, { module: moduleValue, exports: moduleValue.exports, require });
const { buildFinalDelivery } = moduleValue.exports;
const review = (decision, extra = {}) => ({ summary: 'Candidate', detail: `<!-- aim-review ${JSON.stringify({ decision, ...extra })} -->\nCandidate`, suggestions: [], visualReferences: [] });
const digest = /^[0-9a-f]{64}$/;

test('final delivery base, research, section and draft fingerprints keep their pinned values (with evidence)', async () => {
  const outputs = {
    'delivery-outline': answer('Outline', '<!-- aim-delivery-outline {"sections":[{"heading":"Plan","purpose":"Deliver the goal","searchTask":"Find examples","evidenceIds":["e1"]},{"heading":"Limits","purpose":"State limits","searchTask":""}]} -->'),
    'delivery-research': answer('Evidence', '<!-- aim-delivery-research {"status":"searched"} -->\nhttps://example.org/r'),
    'delivery-writing': answer('Draft', 'Full draft https://example.org/r'),
    'delivery-acceptance': answer('Accepted', '<!-- aim-review {"decision":"conclude","rationale":"Complete","stopReason":"Ready"} -->')
  };
  let saved;
  await buildFinalDelivery({ title: 'Goal G', rules: 'Rule R', detail: 'Conditions C', outputLanguage: 'en' }, async context => outputs[phaseOf(context)], {
    knownConditions: '{"goal":"Goal G","conditions":{"weight":"1kg"}}',
    evidence: [{ id: 'e1', hash: 'hash-e1', detail: 'Evidence one' }, { id: 'e2', hash: 'hash-e2', detail: 'Evidence two' }],
    onCheckpoint: checkpoint => { saved = JSON.parse(JSON.stringify(checkpoint)); }
  });
  const sectionFingerprints = Object.values(saved.sections).map(section => section.fingerprint);
  const actual = { base: saved.baseFingerprint, research: saved.researchFingerprint, draft: saved.draftFingerprint, sections: sectionFingerprints };
  assert.deepEqual(actual, {
    base: 'c9a44089145ded52f4a8dced50e42b5224579dbd0a244d935076a1b7e6c89917',
    research: '52c87b5d2bf0b360dd87bbe26785f350bddd7c192ebe51f82b264791cab275fb',
    draft: 'fd965feabbca8a613289a15e9ee6cb82a380599f8a9c8f522c72965bd0c31257',
    sections: ['fd965feabbca8a613289a15e9ee6cb82a380599f8a9c8f522c72965bd0c31257']
  });
});

test('final delivery base, research and draft fingerprints keep their pinned values (legacy outline, no evidence, default conditions)', async () => {
  const outputs = {
    'delivery-outline': answer('Outline', '<!-- aim-delivery-outline {"sections":[{"heading":"Steps","purpose":"Execute","searchTask":"Find examples"}]} -->'),
    'delivery-research': answer('Evidence', '<!-- aim-delivery-research {"status":"searched"} -->\nhttps://example.org/docs'),
    'delivery-writing': answer('Draft', 'Full draft with steps and sources'),
    'delivery-acceptance': answer('Accepted', '<!-- aim-review {"decision":"conclude","rationale":"Complete","stopReason":"Ready"} -->')
  };
  let saved;
  await buildFinalDelivery({ title: 'Goal', rules: '', detail: 'Conditions and prior reports', outputLanguage: 'zh-TW' }, async context => outputs[phaseOf(context)], {
    onCheckpoint: checkpoint => { saved = JSON.parse(JSON.stringify(checkpoint)); }
  });
  assert.deepEqual({ base: saved.baseFingerprint, research: saved.researchFingerprint, draft: saved.draftFingerprint }, {
    base: 'aa4edb56c625b84c097b877d2fc75ddeba34a6efb249afc984d31ddf026febf0',
    research: 'f384b275a0fd3004cd9ea3b3fd910ea2721b1ab214dd83a85b2bf10a5c099b1b',
    draft: '28a86e8546dac91929dd8d296f8a4a7cd48e577221117791caaf94a2fae799bc'
  });
});

test('manual-flow sourceFingerprint and the delivery checkpoint digests it carries keep their pinned values', async () => {
  const subject = fixture({ depth: 1 });
  const stamped = subject.getMap(); stamped.aim.contentLanguage = 'en'; await subject.repository.saveMap('Map.md', stamped); // a 0.24-shaped map: its stored note language keeps the pinned language
  const ask = async context => {
    const phase = phaseOf(context);
    if (phase === 'subtopic-research') return answer('Method found', 'Research status: search completed\nEvidence https://example.org/a');
    if (phase === 'report-review') return review('conclude', { rationale: 'Supported.', stopReason: 'Enough.' });
    if (phase === 'delivery-outline') return answer('Outline', '<!-- aim-delivery-outline {"sections":[{"heading":"Plan","purpose":"Goal","searchTask":"Find examples"}]} -->');
    if (phase === 'delivery-research') return answer('Evidence', '<!-- aim-delivery-research {"status":"searched"} -->\nhttps://example.org/r');
    if (phase === 'delivery-writing') return answer('Draft', 'Full draft https://example.org/r');
    if (phase === 'delivery-acceptance') throw new Error('STOP_AT_ACCEPTANCE');
    throw new Error(`Unexpected phase ${phase}`);
  };
  let next = 0;
  const flow = new AimManualFlow(subject.repository, subject.store, ask, () => `flow-${++next}`);
  await assert.rejects(flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_ACCEPTANCE/);
  const recovery = subject.getMap().aim.branches.find(branch => branch.id === 'current').deliveryRecovery;
  assert.equal(recovery.phase, 'delivery-acceptance');
  const checkpoint = recovery.checkpoint;
  assert.deepEqual({
    sourceFingerprint: recovery.fingerprint,
    base: checkpoint.baseFingerprint,
    research: checkpoint.researchFingerprint,
    draft: checkpoint.draftFingerprint,
    sections: Object.values(checkpoint.sections ?? {}).map(section => section.fingerprint),
    evidenceHashes: recovery.evidence.map(item => item.hash)
  }, {
    sourceFingerprint: '9f181bcf95f241e542585455ed60185fb7328b067d96e72fecd6004841c1a02a',
    base: '7e0e988ee144b4afae2c9e543e4b7836f90f818e61b11da0a8ede93d6566b5b0',
    research: '3ea4a46319fafcbd05599d7d710d318acea7f656f6467ef89883caa19ecd8d0e',
    draft: '5152e575e2c92be6a318ac36e412611399786c54e1a04e65d76a3fe8a2801ccb',
    sections: ['5152e575e2c92be6a318ac36e412611399786c54e1a04e65d76a3fe8a2801ccb'],
    evidenceHashes: ['a1c37d7b0728d0dce538eca697426181cf7cea210169c6e6c04d843bf0410dee']
  });
  for (const value of [recovery.fingerprint, checkpoint.baseFingerprint]) assert.match(value, digest);
});

test('AIM checkpoint fingerprints do not change when the interface language changes (content language is stored per map)', async () => {
  const run = async uiLanguage => {
    const subject = fixture({ depth: 1 });
    subject.repository.settings.language = uiLanguage;
      const stamped = subject.getMap(); stamped.aim.contentLanguage = 'en'; await subject.repository.saveMap('Map.md', stamped); // a 0.24-shaped map: its stored note language keeps the pinned language
    const ask = async context => {
      const phase = phaseOf(context);
      assert.equal(context.outputLanguage, 'en');
      if (phase === 'subtopic-research') return answer('Method found', 'Research status: search completed\nEvidence https://example.org/a');
      if (phase === 'report-review') return review('conclude', { rationale: 'Supported.', stopReason: 'Enough.' });
      if (phase === 'delivery-outline') return answer('Outline', '<!-- aim-delivery-outline {"sections":[{"heading":"Plan","purpose":"Goal","searchTask":"Find examples"}]} -->');
      if (phase === 'delivery-research') return answer('Evidence', '<!-- aim-delivery-research {"status":"searched"} -->\nhttps://example.org/r');
      if (phase === 'delivery-writing') return answer('Draft', 'Full draft https://example.org/r');
      if (phase === 'delivery-acceptance') throw new Error('STOP_AT_ACCEPTANCE');
      throw new Error(`Unexpected phase ${phase}`);
    };
    let next = 0;
    const flow = new AimManualFlow(subject.repository, subject.store, ask, () => `flow-${++next}`);
    await assert.rejects(flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_ACCEPTANCE/);
    const recovery = subject.getMap().aim.branches.find(branch => branch.id === 'current').deliveryRecovery;
    return { source: recovery.fingerprint, base: recovery.checkpoint.baseFingerprint, research: recovery.checkpoint.researchFingerprint, draft: recovery.checkpoint.draftFingerprint };
  };
  assert.deepEqual(await run('zh-TW'), await run('en'));
});

test('AIM stored content language keeps outputLanguage and delivery fingerprints stable across an interface switch for a signal-less title', async () => {
  const run = async uiLanguage => {
    const subject = fixture({ depth: 1 });
    subject.repository.settings.language = uiLanguage;
    const stored = subject.getMap(); stored.title = '🍜'; stored.aim.contentLanguage = 'zh-TW';
    await subject.repository.saveMap('Map.md', stored);
    const languages = new Set();
    const ask = async context => {
      languages.add(context.outputLanguage);
      const phase = phaseOf(context);
      if (phase === 'subtopic-research') return answer('Method found', 'Research status: search completed\nEvidence https://example.org/a');
      if (phase === 'report-review') return review('conclude', { rationale: 'Supported.', stopReason: 'Enough.' });
      if (phase === 'delivery-outline') return answer('Outline', '<!-- aim-delivery-outline {"sections":[{"heading":"Plan","purpose":"Goal","searchTask":"Find examples"}]} -->');
      if (phase === 'delivery-research') return answer('Evidence', '<!-- aim-delivery-research {"status":"searched"} -->\nhttps://example.org/r');
      if (phase === 'delivery-writing') return answer('Draft', 'Full draft https://example.org/r');
      if (phase === 'delivery-acceptance') throw new Error('STOP_AT_ACCEPTANCE');
      throw new Error(`Unexpected phase ${phase}`);
    };
    let next = 0;
    const flow = new AimManualFlow(subject.repository, subject.store, ask, () => `flow-${++next}`);
    await assert.rejects(flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'), /STOP_AT_ACCEPTANCE/);
    const recovery = subject.getMap().aim.branches.find(branch => branch.id === 'current').deliveryRecovery;
    return { languages: [...languages], source: recovery.fingerprint, base: recovery.checkpoint.baseFingerprint, research: recovery.checkpoint.researchFingerprint };
  };
  const zh = await run('zh-TW'), en = await run('en');
  assert.deepEqual(zh.languages, ['zh-TW']);
  assert.deepEqual(zh, en);
});
