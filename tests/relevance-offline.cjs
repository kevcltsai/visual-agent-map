const test = require('node:test');
const assert = require('node:assert/strict');
const tool = require('./tools/relevance-offline.cjs');

const MAP = [
  '---', 'visual-agent-map: true', '---', '', '# T', '', '```agent-map',
  JSON.stringify({ version: 1, title: 'T', nodes: [
    { id: 'a', path: 'n/a.md', parentId: null, x: 1 },
    { id: 'b', path: 'n/b.md', parentId: 'a' },
    { id: 'c', path: 'n/c.md', parentId: 'b' },
    { id: 'd', path: 'n/d.md', parentId: 'a' }
  ] }, null, 2),
  '```', ''
].join('\n');

test('parseMap reads nodes from the agent-map block', () => {
  const map = tool.parseMap(MAP);
  assert.equal(map.title, 'T');
  assert.deepEqual(map.nodes.map(n => [n.id, n.parentId]), [['a', null], ['b', 'a'], ['c', 'b'], ['d', 'a']]);
  assert.throws(() => tool.parseMap('no block'));
});

test('parseFrontmatter reads title summary status', () => {
  const fm = tool.parseFrontmatter('---\ntitle: Hello: world\nsummary: "quoted"\nstatus: idea\nlist:\n  - x\n---\nbody');
  assert.equal(fm.title, 'Hello: world');
  assert.equal(fm.summary, 'quoted');
  assert.equal(fm.status, 'idea');
  assert.deepEqual(tool.parseFrontmatter('no frontmatter'), {});
});

test('buildNodes orders parent before child with depth and clips summaries', () => {
  const nodes = tool.parseMap(MAP).nodes;
  const tree = tool.buildNodes(nodes, id => ({ title: id.toUpperCase(), summary: 'x'.repeat(300), status: 's' }));
  assert.deepEqual(tree.map(n => [n.id, n.depth, n.parentId]), [['a', 0, null], ['b', 1, 'a'], ['c', 2, 'b'], ['d', 1, 'a']]);
  assert.equal([...tree[0].summary].length, 240);
});

const TREE = [
  { id: 'a', title: 'A', depth: 0, parentId: null },
  { id: 'b', title: 'B', depth: 1, parentId: 'a' },
  { id: 'c', title: 'C | pipe', depth: 2, parentId: 'b' },
  { id: 'd', title: 'D', depth: 1, parentId: 'a' }
];
const reply = items => ({ goal: 'g', items });
const item = (id, tier) => ({ id, title: id, depth: 1, tier, reason: 'because' });

test('validateReply accepts exact id set and rejects missing, extra, duplicate, bad tier', () => {
  assert.doesNotThrow(() => tool.validateReply(reply([item('b', 'core'), item('c', 'side'), item('d', 'support')]), TREE));
  assert.throws(() => tool.validateReply(reply([item('b', 'core'), item('c', 'side')]), TREE), /1 missing/);
  assert.throws(() => tool.validateReply(reply([item('b', 'core'), item('c', 'side'), item('d', 'side'), item('x', 'side')]), TREE), /1 extra/);
  assert.throws(() => tool.validateReply(reply([item('a', 'core'), item('b', 'core'), item('c', 'side'), item('d', 'side')]), TREE), /extra/);
  assert.throws(() => tool.validateReply(reply([item('b', 'core'), item('b', 'core'), item('c', 'side')]), TREE), /duplicate/);
  assert.throws(() => tool.validateReply(reply([item('b', 'huge'), item('c', 'side'), item('d', 'side')]), TREE), /bad tier/);
  assert.throws(() => tool.validateReply({ items: [] }, TREE), /goal/);
});

test('extractJson strips a code fence', () => {
  assert.deepEqual(tool.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(tool.extractJson('{"a":2}'), { a: 2 });
});

test('agreement, kappa and confusion', () => {
  const same = [['core', 'core'], ['side', 'side'], ['support', 'support']];
  assert.equal(tool.agreement(same), 1);
  assert.equal(tool.cohenKappa(same), 1);
  const all = [['core', 'core'], ['core', 'core']];
  assert.equal(tool.cohenKappa(all), 1);
  // classic 2x2-like example: po = 0.7, pe = 0.5 -> kappa 0.4
  const pairs = [];
  for (let i = 0; i < 20; i += 1) pairs.push(['core', 'core']);
  for (let i = 0; i < 15; i += 1) pairs.push(['side', 'side']);
  for (let i = 0; i < 10; i += 1) pairs.push(['core', 'side']);
  for (let i = 0; i < 5; i += 1) pairs.push(['side', 'core']);
  assert.ok(Math.abs(tool.agreement(pairs) - 0.7) < 1e-9);
  assert.ok(Math.abs(tool.cohenKappa(pairs) - 0.4) < 1e-9);
  assert.deepEqual(tool.confusion(pairs), [[20, 0, 10], [0, 0, 0], [5, 0, 15]]);
  const disjoint = [['core', 'side'], ['side', 'core']];
  assert.ok(tool.cohenKappa(disjoint) < 0);
});

test('stability compares two runs by id', () => {
  const a = [item('b', 'core'), item('c', 'side'), item('d', 'support')];
  const b = [item('b', 'core'), item('c', 'support'), item('d', 'support')];
  const s = tool.stability(a, b);
  assert.equal(s.n, 3);
  assert.ok(Math.abs(s.agreement - 2 / 3) < 1e-9);
});

test('parseTier accepts english, chinese and numbers', () => {
  assert.equal(tool.parseTier(' Core '), 'core');
  assert.equal(tool.parseTier('必學'), 'core');
  assert.equal(tool.parseTier('需要時學'), 'support');
  assert.equal(tool.parseTier('3'), 'side');
  assert.equal(tool.parseTier('maybe'), null);
});

test('labels.md round-trips, honours depth limit and pipes, and compare reads owner edits', () => {
  const items = [item('b', 'core'), item('c', 'side'), item('d', 'support')];
  const md = tool.renderLabels({ title: 'T', goal: 'my goal', items, tree: TREE, labelDepth: 2 });
  assert.match(md, /　C \\\| pipe/);
  let parsed = tool.parseLabels(md);
  assert.equal(parsed.goal, 'my goal');
  assert.deepEqual(parsed.rows.map(r => [r.id, r.ai, r.owner]), [['b', 'core', null], ['c', 'side', null], ['d', 'support', null]]);
  assert.equal(parsed.rows[1].title, 'C | pipe');

  const shallow = tool.parseLabels(tool.renderLabels({ title: 'T', goal: 'g', items, tree: TREE, labelDepth: 1 }));
  assert.deepEqual(shallow.rows.map(r => r.id), ['b', 'd']);

  const filled = md
    .replace('| b | B | core | because | |', '| b | B | core | because | core |')
    .replace(/(\| c \| .*\| side \| because \|) \|/, '$1 必學 |')
    .replace('目標（可改寫，改了就以你的為準）: my goal', '目標（可改寫，改了就以你的為準）: new goal');
  parsed = tool.parseLabels(filled);
  assert.equal(parsed.goal, 'new goal');
  const result = tool.compareLabels(parsed);
  assert.equal(result.labeled, 2);
  assert.equal(result.changed.length, 1);
  assert.equal(result.promotedSide, 1);
  assert.equal(result.agreement, 0.5);
  assert.equal(result.signal, 'ok');
  assert.match(tool.renderCompare({ title: 'T', goal: 'new goal', result }), /Cohen's kappa/);
});

test('compare flags rubber-stamp and useless', () => {
  const row = (ai, owner) => ({ id: 'x', title: 't', ai, reason: 'r', owner, ownerRaw: owner || '' });
  const same = Array.from({ length: 20 }, () => row('core', 'core'));
  assert.equal(tool.compareLabels({ goal: '', rows: same }).signal, 'rubber-stamp');
  const diff = Array.from({ length: 20 }, () => row('core', 'side'));
  assert.equal(tool.compareLabels({ goal: '', rows: diff }).signal, 'useless');
  assert.equal(tool.compareLabels({ goal: '', rows: [row('core', null)] }).signal, 'no-labels');
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-apply-'));
  const mapDir = path.join(vault, 'Maps', 'M');
  fs.mkdirSync(path.join(mapDir, 'Notes'), { recursive: true });
  const nodes = [
    { id: 'a', path: 'Maps/M/Notes/a.md', parentId: null, x: 0, y: 0 },
    { id: 'b', path: 'Maps/M/Notes/b.md', parentId: 'a', x: 0, y: 0 }
  ];
  fs.writeFileSync(path.join(mapDir, 'Map.md'), `---\nvisual-agent-map: true\n---\n\n# M\n\n\`\`\`agent-map\n${JSON.stringify({ version: 1, id: 'm', title: 'M', nodes })}\n\`\`\`\n`);
  fs.writeFileSync(path.join(vault, nodes[0].path), '---\ntitle: A\n---\nroot body\n');
  fs.writeFileSync(path.join(vault, nodes[1].path), '---\ntitle: "B: x"\nrelevance-tier: core\nrelevance-reason: old\nsummary: keep me\nlist:\n  - one\n---\n# B\n\nbody\n');
  return { vault, mapDir };
}
const record = { goal: 'Learn: "basics"', items: [{ id: 'b', tier: 'side', reason: 'Skip: not on the path | really' }] };

test('setFrontmatterKeys replaces only the given keys and keeps everything else', () => {
  const out = tool.setFrontmatterKeys('---\ntitle: T\nrelevance-reason: old\nrelevance-tier: core\nlist:\n  - x\n---\nbody\n', { 'relevance-tier': 'side', 'relevance-reason': 'r' });
  assert.equal(out, '---\ntitle: T\nlist:\n  - x\nrelevance-tier: "side"\nrelevance-reason: "r"\n---\nbody\n');
  assert.equal(tool.setFrontmatterKeys('body\n', { a: 'b' }), '---\na: "b"\n---\nbody\n');
  assert.equal(tool.setFrontmatterKeys(tool.setFrontmatterKeys('---\nt: 1\n---\nx', { a: 'b' }), { a: 'b' }), '---\nt: 1\na: "b"\n---\nx');
});

test('applyRun writes tier, reason and goal, touches only those keys, and reads back through parseFrontmatter', () => {
  const { vault, mapDir } = makeVault();
  assert.equal(tool.applyRun({ vault, mapDir, record }), 2);
  const note = fs.readFileSync(path.join(vault, 'Maps/M/Notes/b.md'), 'utf8');
  const fm = tool.parseFrontmatter(note);
  assert.equal(fm['relevance-tier'], 'side');
  assert.equal(JSON.parse(note.match(/^relevance-reason: (.*)$/m)[1]), 'Skip: not on the path | really');
  assert.equal(fm.summary, 'keep me');
  assert.equal(fm.title, 'B: x');
  assert.match(note, /list:\n {2}- one\n/);
  assert.match(note, /\n---\n# B\n\nbody\n$/);
  assert.equal(fs.readFileSync(path.join(vault, 'Maps/M/Notes/a.md'), 'utf8'), '---\ntitle: A\n---\nroot body\n', 'root is not graded');
  const mapText = fs.readFileSync(path.join(mapDir, 'Map.md'), 'utf8');
  assert.equal(JSON.parse(mapText.match(/^relevance-goal: (.*)$/m)[1]), 'Learn: "basics"');
  assert.match(mapText, /visual-agent-map: true/);
  assert.equal(tool.parseMap(mapText).nodes.length, 2);
});

test('applyRun is idempotent and rejects ids that are not in the map', () => {
  const { vault, mapDir } = makeVault();
  tool.applyRun({ vault, mapDir, record });
  const once = fs.readFileSync(path.join(vault, 'Maps/M/Notes/b.md'), 'utf8');
  tool.applyRun({ vault, mapDir, record });
  assert.equal(fs.readFileSync(path.join(vault, 'Maps/M/Notes/b.md'), 'utf8'), once);
  assert.throws(() => tool.applyRun({ vault, mapDir, record: { goal: 'g', items: [{ id: 'zz', tier: 'core', reason: 'r' }] } }), /not in Map.md/);
});

test('apply refuses the live test vault and anything under it', () => {
  assert.throws(() => tool.assertWritable('/private/tmp/vam-e2e-current'), /refusing/);
  assert.throws(() => tool.assertWritable('/private/tmp/vam-e2e-current/Agent Workspace/Mind Maps/x'), /refusing/);
  assert.doesNotThrow(() => tool.assertWritable('/private/tmp/vam-e2e-relevance'));
  assert.doesNotThrow(() => tool.assertWritable('/private/tmp/vam-e2e-current-other'));
  const { mapDir } = makeVault();
  assert.throws(() => tool.applyRun({ vault: '/private/tmp/vam-e2e-current', mapDir, record }), /refusing/);
});

// ---- Phase 4: prompt v2, hierarchy, sibling metrics, A/B gates, owner review ---------------------------------

const TREE2 = [
  { id: 'r', title: 'Root', summary: '', status: '', depth: 0, parentId: null },
  { id: 'a', title: 'A', summary: '', status: '', depth: 1, parentId: 'r' },
  { id: 'a1', title: 'A1', summary: '', status: '', depth: 2, parentId: 'a' },
  { id: 'a2', title: 'A2', summary: '', status: '', depth: 2, parentId: 'a' },
  { id: 'a3', title: 'A3', summary: '', status: '', depth: 2, parentId: 'a' },
  { id: 'b', title: 'B', summary: '', status: '', depth: 1, parentId: 'r' }
];
const it2 = (id, tier) => ({ id, title: id, depth: 1, tier, reason: 'r' });

test('hierarchyViolations flags a child above its graded parent and ignores top-level parents', () => {
  const ok = [it2('a', 'support'), it2('a1', 'support'), it2('a2', 'side'), it2('a3', 'support'), it2('b', 'core')];
  assert.deepEqual(tool.hierarchyViolations(ok, TREE2), []);
  const bad = [it2('a', 'support'), it2('a1', 'core'), it2('a2', 'side'), it2('a3', 'support'), it2('b', 'side')];
  const v = tool.hierarchyViolations(bad, TREE2);
  assert.deepEqual(v.map(x => [x.child, x.childTier, x.parent, x.parentTier]), [['a1', 'core', 'a', 'support']]);
  const underSide = [it2('a', 'side'), it2('a1', 'support'), it2('a2', 'side'), it2('a3', 'side'), it2('b', 'core')];
  assert.deepEqual(tool.hierarchyViolations(underSide, TREE2).map(x => x.child), ['a1']);
  // a top-level card (depth 1, parent is the ungraded root) is never a violation, whatever its tier
  assert.deepEqual(tool.hierarchyViolations([it2('a', 'core'), it2('b', 'core')], TREE2.slice(0, 2).concat(TREE2[5])), []);
});

test('siblingGroups and siblingMetrics count groups, core share and all-core groups of 3+', () => {
  const items = [it2('a', 'core'), it2('a1', 'core'), it2('a2', 'core'), it2('a3', 'core'), it2('b', 'support')];
  const groups = tool.siblingGroups(items, TREE2);
  assert.deepEqual(groups.map(g => [g.parentTitle, g.size, g.core, g.allCore]), [['Root', 2, 1, false], ['A', 3, 3, true]]);
  const m = tool.siblingMetrics(groups);
  assert.equal(m.groups, 2);
  assert.ok(Math.abs(m.meanCoreShare - 0.75) < 1e-9);
  assert.equal(m.allCoreGroups3, 1);
  assert.deepEqual(m.allCoreTitles, ['A']);
  assert.equal(tool.siblingMetrics([]).meanCoreShare, 0);
});

test('validateReply tags a failure class and never loosens', () => {
  const cls = fn => {
    try {
      fn();
    } catch (error) {
      return error.failureClass;
    }
    return null;
  };
  assert.equal(cls(() => tool.validateReply(reply([item('b', 'core'), item('c', 'side')]), TREE)), 'id-mismatch');
  assert.equal(cls(() => tool.validateReply(reply([item('b', 'huge'), item('c', 'side'), item('d', 'side')]), TREE)), 'bad-tier');
  assert.equal(cls(() => tool.validateReply(reply([item('b', 'core'), item('b', 'core'), item('c', 'side')]), TREE)), 'duplicate');
  assert.equal(cls(() => tool.validateReply(reply([{ ...item('b', 'core'), reason: ' ' }, item('c', 'side'), item('d', 'side')]), TREE)), 'empty-reason');
  assert.equal(tool.classifyFailure(new SyntaxError('x')), 'json');
  assert.equal(tool.classifyFailure(new Error('x')), 'call');
});

test('normalizeLevel and normalizeContext', () => {
  assert.equal(tool.normalizeLevel('beginner'), 'beginner');
  assert.equal(tool.normalizeLevel(undefined), null);
  assert.throws(() => tool.normalizeLevel('expert'), /--level/);
  assert.equal(tool.normalizeContext('  a \n b '), 'a b');
  assert.equal(tool.normalizeContext(''), null);
  assert.equal([...tool.normalizeContext('x'.repeat(300))].length, 200);
});

test('buildPrompt v1 has no level or context; v2 carries goal, level and context as JSON and null when absent', () => {
  const v1 = tool.buildPrompt({ version: 'v1', goal: 'learn {{NODES}}', level: 'beginner', context: 'c', tree: TREE2 });
  assert.match(v1, /Learner goal: learn \{\{NODES\}\}/, 'a goal that looks like a placeholder is not re-expanded');
  assert.doesNotMatch(v1, /Learner level/);
  const v2 = tool.buildPrompt({ version: 'v2', goal: 'say "hi"', level: 'beginner', context: '半天日照', tree: TREE2 });
  assert.match(v2, /Learner goal \(JSON string\): "say \\"hi\\""/);
  assert.match(v2, /Learner level .*: "beginner"/);
  assert.match(v2, /Learner context \(JSON string, or null\): "半天日照"/);
  assert.match(v2, /"id":"c3"/, 'v2 speaks position ids');
  assert.doesNotMatch(v2, /"id":"a1"/);
  assert.match(v1, /"id":"a1"/, 'v1 keeps real ids');
  const none = tool.buildPrompt({ version: 'v2', goal: 'g', level: null, context: null, tree: TREE2 });
  assert.match(none, /Learner level .*: null\n/);
  assert.match(none, /Learner context \(JSON string, or null\): null\n/);
  assert.doesNotMatch(none, /\{\{[A-Z]+\}\}/);
  assert.throws(() => tool.buildPrompt({ version: 'v9', goal: 'g', tree: TREE2 }), /--prompt/);
});

test('v2 prompt carries the exact rules from the plan', () => {
  const text = fs.readFileSync(path.join(__dirname, 'tools', 'relevance-offline', 'prompt.md'), 'utf8');
  for (const rule of [
    'Core is the smallest set of cards that together reach the goal.',
    'Siblings compete.',
    'A card never ranks above its parent: under a "support" parent every child is "support" or "side"; under a "side" parent every child is "side".',
    'Do not aim for a fixed number or share of any tier; the goal decides.'
  ])
    assert.ok(text.includes(rule), rule);
});

test('estimateTokens counts ASCII at a quarter and other characters at one', () => {
  assert.equal(tool.estimateTokens('abcdefgh'), 2);
  assert.equal(tool.estimateTokens('中文'), 2);
  assert.equal(tool.estimateTokens('abcd中'), 2);
});

function fakeArm(map, arm, { dists, agreement, kappa, firstViolations, accepted = 2, allCore = 0, siblingShare = 0.5, tokens = 1000, graded = 100 }) {
  const perRun = dists.map((d, i) => ({
    dist: d,
    share: { core: d.core / graded, support: d.support / graded, side: d.side / graded },
    sibling: { groups: 5, meanCoreShare: siblingShare, allCoreGroups3: allCore, allCoreTitles: [] },
    violations: 0,
    firstAttempt: { ok: true, failureClass: null, violations: Array.from({ length: firstViolations[i] }, () => ({})) }
  }));
  return {
    slug: `${map}-${arm}`, graded, accepted, requested: 2, perRun,
    stability: { agreement, kappa, n: graded, confusion: [] },
    meanCoreShare: perRun.reduce((s, p) => s + p.share.core, 0) / perRun.length,
    meanSideShare: 0, meanSiblingShare: siblingShare, meanAllCore3: allCore,
    firstAttemptViolations: firstViolations, failureClasses: [], promptTokens: tokens, usage: [], inputHash: 'h', promptVersion: 'v'
  };
}

function goodStats() {
  const mk = (map, v1core, v2core, graded, v1all, v2all) => ({
    v1: fakeArm(map, 'v1', { dists: [{ core: v1core, support: 20, side: 5 }, { core: v1core, support: 20, side: 5 }], agreement: 0.8, kappa: 0.7, firstViolations: [2, 3], allCore: v1all, graded }),
    v2: fakeArm(map, 'v2', { dists: [{ core: v2core, support: 30, side: 10 }, { core: v2core, support: 30, side: 10 }], agreement: 0.78, kappa: 0.65, firstViolations: [0, 0], allCore: v2all, graded, tokens: 20000 })
  });
  return { herbs: mk('herbs', 8, 5, 15, 0, 0), grammar: mk('grammar', 65, 40, 90, 15, 4), cooking: mk('cooking', 50, 40, 100, 3, 1) };
}

test('evaluateGates passes a good v2 and names the failing gate otherwise', () => {
  const gates = tool.evaluateGates(goodStats());
  assert.deepEqual(gates.map(g => [g.id, g.pass]), [['P1', true], ['P2', true], ['P3', true], ['P4', true], ['P5', true]]);

  let s = goodStats();
  s.grammar.v2.firstAttemptViolations = [1, 0];
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P1').pass, false);

  s = goodStats();
  s.cooking.v2.stability = { agreement: 0.7, kappa: 0.65, n: 100, confusion: [] };
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P2').pass, false);
  s = goodStats();
  s.cooking.v2.stability = { agreement: 0.78, kappa: 0.55, n: 100, confusion: [] };
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P2').pass, false);

  s = goodStats();
  s.grammar.v2 = fakeArm('grammar', 'v2', { dists: [{ core: 60, support: 25, side: 5 }, { core: 60, support: 25, side: 5 }], agreement: 0.8, kappa: 0.7, firstViolations: [0, 0], allCore: 4, graded: 90 });
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P3').pass, false, 'core share not 10 points lower');
  s = goodStats();
  s.cooking.v2.meanAllCore3 = 3;
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P3').pass, false, 'all-core groups not fewer');
  s = goodStats();
  s.cooking.v1.meanAllCore3 = 0;
  s.cooking.v2.meanAllCore3 = 0;
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P3').pass, true, 'both zero is fine');

  s = goodStats();
  s.herbs.v2.perRun[1].dist.side = 0;
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P4').pass, false);
  s = goodStats();
  s.cooking.v2.perRun[0].share.side = 0.04;
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P4').pass, false);

  s = goodStats();
  s.cooking.v2.promptTokens = 32000;
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P5').pass, false);
  s = goodStats();
  s.herbs.v2.accepted = 1;
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P1').pass, false);
});

test('herbs gets a wider agreement tolerance than the larger maps', () => {
  const s = goodStats();
  s.herbs.v1.stability = { agreement: 0.8, kappa: 0.7, n: 15, confusion: [] };
  s.herbs.v2.stability = { agreement: 0.735, kappa: 0.7, n: 15, confusion: [] };
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P2').pass, true);
  s.cooking.v2.stability = { agreement: 0.745, kappa: 0.7, n: 100, confusion: [] };
  assert.equal(tool.evaluateGates(s).find(g => g.id === 'P2').pass, false);
});

test('renderAb lists gates and per-arm numbers', () => {
  const md = tool.renderAb(goodStats(), tool.evaluateGates(goodStats()));
  assert.match(md, /\| P1 \| PASS \|/);
  assert.match(md, /ALL PASS/);
  assert.match(md, /#### grammar-v2/);
  assert.deepEqual(tool.armOf('cooking-v2-nolevel'), { map: 'cooking', arm: 'v2-nolevel' });
  assert.deepEqual(tool.armOf('herbs-v1'), { map: 'herbs', arm: 'v1' });
});

test('pickReviewCards prefers differing cards, is seeded and tops up', () => {
  const v1 = [it2('x1', 'core'), it2('x2', 'core'), it2('x3', 'core'), it2('x4', 'core')];
  const v2 = [it2('x1', 'core'), it2('x2', 'support'), it2('x3', 'core'), it2('x4', 'side')];
  const picked = tool.pickReviewCards(v1, v2, 3, 7);
  assert.equal(picked.length, 3);
  assert.deepEqual(new Set(picked.slice(0, 2)), new Set(['x2', 'x4']));
  assert.deepEqual(tool.pickReviewCards(v1, v2, 3, 7), picked);
  assert.equal(tool.pickReviewCards(v1, v2, 10, 7).length, 4);
  const r1 = tool.mulberry32(5);
  const r2 = tool.mulberry32(5);
  assert.equal(r1(), r2());
});

function writeArm(out, slug, summary, items) {
  const dir = path.join(out, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ runsRequested: 1, ...summary }));
  fs.writeFileSync(path.join(dir, 'run-1.json'), JSON.stringify({ items }));
}

test('owner review is blind, keyed, and compare reads the owner answers back', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-review-'));
  const mk = (tiers, prefix) => tiers.map((tier, i) => ({ id: `${prefix}${i}`, title: `T${i} | x`, depth: 1, tier, reason: `reason ${tier}` }));
  const herbs1 = mk(['core', 'core', 'support', 'side'], 'h');
  const herbs2 = mk(['core', 'support', 'support', 'side'], 'h');
  writeArm(out, 'herbs-v1', { goal: 'herb goal', level: null, context: null }, herbs1);
  writeArm(out, 'herbs-v2', { goal: 'herb goal', level: 'beginner', context: '半天日照' }, herbs2);
  const many = prefix => Array.from({ length: 12 }, (_, i) => ({ id: `${prefix}${i}`, title: `Card ${i}`, depth: 1, tier: i % 2 ? 'core' : 'support', reason: `why ${i}` }));
  const alt = prefix => many(prefix).map((x, i) => (i < 5 ? { ...x, tier: x.tier === 'core' ? 'side' : 'core' } : x));
  for (const m of ['grammar', 'cooking']) {
    writeArm(out, `${m}-v1`, { goal: `${m} goal`, level: null, context: null }, many(m));
    writeArm(out, `${m}-v2`, { goal: `${m} goal`, level: 'intermediate', context: null }, alt(m));
  }
  tool.writeOwnerReview(out);
  const md = fs.readFileSync(path.join(out, 'owner-review.md'), 'utf8');
  assert.doesNotMatch(md, /v1|v2/, 'arms are not named in the owner document');
  const key = JSON.parse(fs.readFileSync(path.join(out, 'owner-review-key.json'), 'utf8'));
  assert.equal(key.B.grammar.length, 8);
  assert.equal(key.B.cooking.length, 8);
  assert.ok(key.B.grammar.some(e => e.a === 'v1') && key.B.grammar.some(e => e.a === 'v2'), 'assignment is mixed');
  // herbs table has no AI tiers at all
  const herbsSection = md.slice(md.indexOf('## A.'), md.indexOf('## B.'));
  assert.doesNotMatch(herbsSection.split('\n').filter(l => l.startsWith('| h')).join('\n'), /core|support|side/);

  // fill in the answers: herbs = the v2 tiers; B: always pick the v2 side
  let filled = md;
  herbs2.forEach(h => {
    filled = filled.replace(new RegExp(`(\\| ${h.id} \\| [^\\n]*\\|) \\|`), `$1 ${h.tier} |`);
  });
  const lines = filled.split('\n').map(line => {
    const cells = line.startsWith('|') ? line.split('|').map(c => c.trim()) : null;
    if (!cells) return line;
    for (const m of ['grammar', 'cooking']) {
      const entry = key.B[m].find(e => e.id === cells[1]);
      if (entry) return line.replace(/\| \|$/, `| ${entry.a === 'v2' ? '甲' : '乙'} |`);
    }
    return line;
  });
  const armTiers = {
    'herbs-v1': new Map(herbs1.map(i => [i.id, i.tier])),
    'herbs-v2': new Map(herbs2.map(i => [i.id, i.tier]))
  };
  const result = tool.compareReview(lines.join('\n'), key, armTiers);
  assert.equal(result.A.labeled, 4);
  assert.equal(result.A.arms['herbs-v2'].agreement, 1);
  assert.equal(result.A.arms['herbs-v1'].agreement, 0.75);
  assert.deepEqual(result.B.grammar, { v1: 0, v2: 8, both: 0, neither: 0, blank: 0, invalid: 0 });
  assert.equal(result.B.cooking.v2, 8);
});

test('applyRun writes level and context to Map.md when the run has them, and nothing when absent', () => {
  const { vault, mapDir } = makeVault();
  tool.applyRun({ vault, mapDir, record: { ...record, level: 'beginner', context: '陽台只有半天日照' } });
  const text = fs.readFileSync(path.join(mapDir, 'Map.md'), 'utf8');
  assert.equal(JSON.parse(text.match(/^relevance-level: (.*)$/m)[1]), 'beginner');
  assert.equal(JSON.parse(text.match(/^relevance-context: (.*)$/m)[1]), '陽台只有半天日照');
  const second = makeVault();
  tool.applyRun({ vault: second.vault, mapDir: second.mapDir, record: { ...record, level: 'expert' } });
  const plain = fs.readFileSync(path.join(second.mapDir, 'Map.md'), 'utf8');
  assert.doesNotMatch(plain, /relevance-level|relevance-context/);
});

// ---- one repair round under --hierarchy=reject (mirrors the plugin) ------------------------------------------------
const L2 = { r: 'c1', a: 'c2', a1: 'c3', a2: 'c4', a3: 'c5', b: 'c6' };
const shortIt = (id, tier) => ({ ...it2(id, tier), id: L2[id] ?? id });
function replyOf(tiers) {
  const items = Object.entries(tiers).map(([id, tier]) => shortIt(id, tier));
  return { text: JSON.stringify({ goal: 'g', items }), usage: { out: 1 }, cost: 0.5 };
}
const BAD = { a: 'side', a1: 'core', a2: 'side', a3: 'side', b: 'core' };
const FIXED = { a: 'core', a1: 'core', a2: 'side', a3: 'side', b: 'core' };
const classifyWith = (replies, hierarchy = 'reject') => {
  const prompts = [];
  const call = prompt => { prompts.push(prompt); const next = replies[prompts.length - 1]; if (next instanceof Error) throw next; return next; };
  const args = { version: 'v2', goal: 'g', level: null, context: null, tree: TREE2, model: 'm', hierarchy, call };
  return { prompts, run: () => tool.classify(args) };
};

test('repair: a violation-only first reply gets one repair prompt with every pair; a valid repair is accepted and recorded', () => {
  const fx = classifyWith([replyOf(BAD), replyOf(FIXED)]);
  const out = fx.run();
  assert.equal(fx.prompts.length, 2);
  assert.ok(fx.prompts[1].includes(tool.buildPrompt({ version: 'v2', goal: 'g', level: null, context: null, tree: TREE2 })), 'original prompt included');
  assert.ok(fx.prompts[1].includes(JSON.stringify([{ childId: 'c3', childTier: 'core', parentId: 'c2', parentTier: 'side', ancestors: [{ id: 'c2', tier: 'side' }, { id: 'c1', tier: null }] }])), 'the pair speaks position ids and carries the ancestor chain');
  assert.deepEqual(out.value.items.map(i => i.id), ['a', 'a1', 'a2', 'a3', 'b'], 'the accepted result carries real ids');
  assert.deepEqual(out.value.items.map(i => i.tier), ['core', 'core', 'side', 'side', 'core']);
  assert.equal(out.repair.attempted, true); assert.equal(out.repair.ok, true); assert.equal(out.repair.firstViolations, 1);
  assert.equal(out.violations.length, 0); assert.equal(out.firstViolationList.length, 1); assert.equal(out.cost, 1);
  assert.doesNotMatch(fx.prompts[1], /\{\{[A-Z_]+\}\}/);
});

test('repair: a malformed repair fails the attempt as hierarchy at once; a repair that still violates gets ONE more round, then fails', () => {
  for (const second of [{ text: 'nope' }, replyOf({ a: 'core', a1: 'core' })]) {
    const fx = classifyWith([replyOf(BAD), second, replyOf(FIXED)]);
    assert.throws(() => fx.run(), error => error.failureClass === 'hierarchy' && error.repair.attempted === true && error.repair.ok === false && error.violations.length === 1);
    assert.equal(fx.prompts.length, 2);
  }
  const twice = classifyWith([replyOf(BAD), replyOf(BAD), replyOf(BAD), replyOf(FIXED)]);
  assert.throws(() => twice.run(), error => error.failureClass === 'hierarchy' && error.repair.rounds === 2 && error.repair.ok === false);
  assert.equal(twice.prompts.length, 3, 'first request plus at most two repair rounds');
});

// Chain: r -> a -> a1; round one raises a1's parent... here a stays side while a1 is core; the model raises `a` only if
// its ancestors allow it. Tree has no grandparent below the top level, so use a deeper tree.
const TREE3 = [
  { id: 'r', title: 'Root', summary: '', status: '', depth: 0, parentId: null },
  { id: 'g', title: 'Grand', summary: '', status: '', depth: 1, parentId: 'r' },
  { id: 'p', title: 'P', summary: '', status: '', depth: 2, parentId: 'g' },
  { id: 'c', title: 'C', summary: '', status: '', depth: 3, parentId: 'p' }
];
const L3 = { r: 'c1', g: 'c2', p: 'c3', c: 'c4' };
const replyOf3 = tiers => ({ text: JSON.stringify({ goal: 'g', items: Object.entries(tiers).map(([id, tier]) => ({ id: L3[id], title: id, depth: 1, tier, reason: 'r' })) }) });
test('repair: round two repairs the latest reply with its own violations and the full ancestor chain', () => {
  const prompts = [];
  const replies = [replyOf3({ g: 'support', p: 'support', c: 'core' }), replyOf3({ g: 'support', p: 'core', c: 'core' }), replyOf3({ g: 'core', p: 'core', c: 'core' })];
  const call = prompt => { prompts.push(prompt); return replies[prompts.length - 1]; };
  const out = tool.classify({ version: 'v2', goal: 'g', level: null, context: null, tree: TREE3, model: 'm', hierarchy: 'reject', call });
  assert.equal(prompts.length, 3); assert.equal(out.repair.rounds, 2); assert.equal(out.repair.ok, true);
  assert.ok(prompts[1].includes('"ancestors":[{"id":"c3","tier":"support"},{"id":"c2","tier":"support"},{"id":"c1","tier":null}]'));
  assert.ok(prompts[2].includes(JSON.stringify([{ childId: 'c3', childTier: 'core', parentId: 'c2', parentTier: 'support', ancestors: [{ id: 'c2', tier: 'support' }, { id: 'c1', tier: null }] }])));
  assert.ok(!prompts[2].includes('"childId":"c4"'), 'round two carries only the violations of the round-one reply');
});

test('repair: a non-hierarchy failure of the first reply, a clean reply, and --hierarchy=count make no repair call', () => {
  const missing = classifyWith([{ text: JSON.stringify({ goal: 'g', items: [shortIt('a', 'core')] }) }, replyOf(FIXED)]);
  assert.throws(() => missing.run(), error => error.failureClass === 'id-mismatch');
  assert.equal(missing.prompts.length, 1);
  const clean = classifyWith([replyOf(FIXED)]);
  assert.equal(clean.run().repair, null); assert.equal(clean.prompts.length, 1);
  const count = classifyWith([replyOf(BAD)], 'count');
  assert.equal(count.run().violations.length, 1); assert.equal(count.prompts.length, 1);
});

test('short ids: the repair prompt carries no real id; a real id, an unknown label or a duplicated label in a reply is refused', () => {
  const fx = classifyWith([replyOf(BAD), replyOf(FIXED)]);
  fx.run();
  assert.doesNotMatch(fx.prompts[1].split('Previous reply')[1], /"id":"(?:a|a1|a2|a3|b)"/);
  const refused = items => classifyWith([{ text: JSON.stringify({ goal: 'g', items }) }]);
  const base = Object.entries(FIXED).map(([id, tier]) => shortIt(id, tier));
  for (const items of [
    base.map(i => (i.id === 'c2' ? { ...i, id: 'a' } : i)),                  // a real id instead of its label
    [...base, shortIt('ghost', 'core')],                                    // unknown label
    base.map(i => (i.id === 'c3' ? { ...i, id: 'c4' } : i)),                 // c4 twice, c3 missing
    base.map(i => (i.id === 'c3' ? { ...i, id: 'c1' } : i))                  // top-level label
  ]) assert.throws(() => refused(items).run(), error => ['id-mismatch', 'duplicate'].includes(error.failureClass));
});

test('command line parsing and the output-location guard exist and work', () => {
  assert.deepEqual(tool.parseArgs(['--out=/x/y=z', '--review', 'ignored', '--runs=2']), { out: '/x/y=z', review: true, runs: '2' });
  assert.throws(() => tool.assertOutsideRepo(require('node:path').resolve(__dirname, '..', 'tests')), /must not be inside/);
  assert.doesNotThrow(() => tool.assertOutsideRepo(require('node:os').tmpdir()));
});

// ---- product prompt source, simulated pins and recalibration metrics (no AI) ----

const PT = (id, parentId, depth) => ({ id, title: id.toUpperCase(), summary: `${id} summary`, status: 'idea', parentId, depth });
const PIN_TREE = [
  PT('r', null, 0), PT('a', 'r', 1), PT('a1', 'a', 2), PT('a2', 'a', 2), PT('b', 'r', 1), PT('b1', 'b', 2), PT('b2', 'b', 2),
  PT('s', null, 0), PT('s1', 's', 1), PT('s11', 's1', 2), PT('s2', 's', 1)
];
const items = map => Object.entries(map).map(([id, tier]) => ({ id, tier, reason: 'x' }));
const PIN_BASE = items({ a: 'core', a1: 'core', a2: 'side', b: 'support', b1: 'side', b2: 'support', s1: 'core', s11: 'support', s2: 'side' });

test('product prompt source renders exactly what the product step renders (scope all), has no repair round, legacy stays reachable', () => {
  const { load } = require('./support-replay.cjs');
  const { goalRecommendStep } = load('core/steps/goal-recommend/step.ts');
  for (const language of ['zh-TW', 'en']) {
    const args = { goal: 'Cook a steak', level: 'beginner', context: '半天日照', tree: PIN_TREE, language };
    const expected = goalRecommendStep.render({ goal: args.goal, context: args.context, nodes: PIN_TREE, language, model: 'm', reasoning: 'low', scope: 'all' });
    assert.equal(tool.buildPrompt({ version: 'product', ...args }), expected, 'the level is not part of the product prompt');
    assert.equal(tool.buildPrompt({ version: 'product', ...args, level: null, context: null }), goalRecommendStep.render({ goal: args.goal, nodes: PIN_TREE, language, model: 'm', reasoning: 'low', scope: 'all' }));
  }
  assert.throws(() => tool.buildRepairPrompt({ prompt: 'p', value: { items: [] }, violations: [], tree: PIN_TREE, version: 'product' }), /no repair round/);
  assert.match(tool.buildPrompt({ version: 'v2', goal: 'g', level: null, context: null, tree: PIN_TREE }), /"goal"/);
  assert.match(tool.promptHash('product'), /^[0-9a-f]{12}$/);
  assert.notEqual(tool.promptHash('product'), tool.promptHash('v2'));
});

test('classify records duration_ms and sums it over a repair round (v2)', () => {
  const fx = classifyWith([{ ...replyOf(BAD), durationMs: 100 }, { ...replyOf(FIXED), durationMs: 200 }]);
  assert.equal(fx.run().durationMs, 300);
});

test('classify with the product prompt accepts a goal-less reply, records duration_ms, and never sends a repair round (a violation is only counted)', () => {
  const ok = { items: PIN_BASE.map(i => ({ id: tool.positionLabels(PIN_TREE).toShort.get(i.id), tier: i.tier, reason: 'r' })), suggestions: [] };
  const bad = { items: ok.items.map(i => (i.id === 'c3' ? { ...i, tier: 'core' } : i.id === 'c2' ? { ...i, tier: 'side' } : i)), suggestions: [] };
  const calls = [];
  const out = tool.classify({ version: 'product', goal: 'g', level: null, context: null, tree: PIN_TREE, model: 'm', hierarchy: 'reject', call: p => { calls.push(p); return { text: JSON.stringify(bad), usage: null, cost: null, durationMs: 100 }; } });
  assert.equal(calls.length, 1, 'no repair request even under --hierarchy=reject');
  assert.equal(out.durationMs, 100);
  assert.equal(out.repair, null);
  assert.equal(out.violations.length, 1);
});

test('selectPins: P/D/PD follow the design rules and P stays outside D\'s subtree', () => {
  const r = tool.selectPins(PIN_TREE, PIN_BASE);
  assert.deepEqual(r.scenarios.D.map(p => [p.id, p.tier]), [['a', 'side']]);
  assert.deepEqual(r.scenarios.P.map(p => [p.id, p.from, p.tier]), [['b1', 'side', 'core']], 'a2 is the first side card but sits inside D\'s subtree');
  assert.deepEqual(r.scenarios.PD.map(p => p.id), ['b1', 'a']);
  assert.equal(r.pRule, 'side-with-sibling');
  assert.deepEqual(r.skipped, {});
});

test('selectPins: P falls back to the first support leaf, skips impossible scenarios and records why', () => {
  const noSide = items({ a: 'core', a1: 'core', a2: 'support', b: 'support', b1: 'support', b2: 'support', s1: 'core', s11: 'support', s2: 'support' });
  const r = tool.selectPins(PIN_TREE, noSide);
  assert.equal(r.pRule, 'support-leaf');
  assert.deepEqual(r.scenarios.P.map(p => p.id), ['b1'], 'a2 is inside D (a), so the next support leaf b1');
  const none = tool.selectPins(PIN_TREE, items({ a: 'support', a1: 'support', a2: 'side', b: 'support', b1: 'side', b2: 'side', s1: 'support', s11: 'side', s2: 'side' }));
  assert.equal(none.scenarios.D, undefined);
  assert.ok(none.skipped.D && none.skipped.PD);
  assert.deepEqual(none.scenarios.P.map(p => p.id), ['a2'], 'with no D, nothing is excluded: a2 (parent a, non-top-level, has a sibling)');
  const flat = tool.selectPins([PT('r', null, 0), PT('x', 'r', 1), PT('y', 'r', 1)], items({ x: 'core', y: 'core' }));
  assert.deepEqual(Object.keys(flat.scenarios), []);
  assert.deepEqual(Object.keys(flat.skipped).sort(), ['D', 'P', 'PD']);
});

test('neighbourhood: ancestors, descendants and siblings of a pin, never the pin itself', () => {
  assert.deepEqual([...tool.neighbourhood(PIN_TREE, new Set(['b1']))].sort(), ['b', 'b2', 'r']);
  assert.deepEqual([...tool.neighbourhood(PIN_TREE, new Set(['a']))].sort(), ['a1', 'a2', 'b', 'r']);
  assert.deepEqual([...tool.neighbourhood(PIN_TREE, new Set(['s1']))].sort(), ['s', 's11', 's2']);
});

test('metrics: G1 pinned-overwritten, G3 unrelated change rate, G5 agreement and G7 change rate ignore pins', () => {
  const pins = [{ id: 'b1', tier: 'core' }, { id: 'a', tier: 'side' }];
  const merged = items({ a: 'side', a1: 'side', a2: 'side', b: 'core', b1: 'core', b2: 'support', s1: 'core', s11: 'support', s2: 'side' });
  assert.equal(tool.pinnedOverwritten(merged, pins), 0);
  assert.equal(tool.pinnedOverwritten(items({ a: 'core', b1: 'core' }), pins), 1);
  assert.equal(tool.pinnedOverwritten(items({ b1: 'core' }), pins), 1, 'a missing pinned card counts as overwritten');
  // Unrelated = graded, not pinned, not near a pin: s1, s11, s2. Nothing there changed.
  assert.deepEqual(tool.unrelatedChangeRate(PIN_TREE, pins, PIN_BASE, merged), { total: 3, changed: 0, rate: 0 });
  const drifted = items({ a: 'side', a1: 'side', a2: 'side', b: 'core', b1: 'core', b2: 'support', s1: 'support', s11: 'support', s2: 'side' });
  assert.deepEqual(tool.unrelatedChangeRate(PIN_TREE, pins, PIN_BASE, drifted), { total: 3, changed: 1, rate: 1 / 3 });
  assert.deepEqual(tool.unrelatedChangeRate(PIN_TREE, [], [], []), { total: 0, changed: 0, rate: null });
  const other = items({ a: 'core', a1: 'core', a2: 'side', b: 'support', b1: 'side', b2: 'side', s1: 'core', s11: 'support', s2: 'side' });
  assert.deepEqual(tool.nonPinnedAgreement(merged, other, ['a', 'b1']), { n: 7, agreement: 4 / 7 });
  assert.deepEqual(tool.nonPinnedChangeRate(merged, other, ['a', 'b1']), { n: 7, changed: 3, rate: 3 / 7 });
  assert.deepEqual(tool.nonPinnedChangeRate(merged, merged, []), { n: 9, changed: 0, rate: 0 });
  assert.equal(tool.nonPinnedAgreement([], [], []).agreement, null);
});
