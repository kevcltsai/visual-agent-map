// Topic relations in Reference Links (relation references 01): a rebuild lists each relation at both ends, worded by
// direction, one line per wording, after Child topics and before Source topic, in the note's own label language.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./support.cjs');

const link = node => `[[${node.path.replace(/\.md$/, '')}]]`;
/** The Reference Links list of a note, one entry per line, without the leading "- ". */
const links = text => {
  const block = /## (?:Reference Links|關聯連結)\n\n([\s\S]*?)\n<!-- visual-agent-map:references:end -->/.exec(text);
  return block ? block[1].split('\n').map(line => line.replace(/^- /, '')) : [];
};
const frontmatterRefs = (repo, text) => {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)[1];
  return require('yaml').parse(block)['agent-map-references'] ?? [];
};

async function mapWith(titles, language = 'zh-TW') {
  const data = fixture(language);
  const mapPath = await data.repo.createMap('Relations');
  const map = await data.repo.readMap(mapPath);
  const nodes = [];
  for (const title of titles) {
    const node = await data.repo.createNote(title, 'model-a', map, mapPath, 'workspace');
    node.parentId = nodes.length ? nodes[0].id : null;
    map.nodes.push(node);
    nodes.push(node);
  }
  await data.repo.saveMap(mapPath, map);
  await data.repo.rebuildDerivedData();
  const relate = async relations => {
    const current = await data.repo.readMap(mapPath);
    if (relations.length) current.topicRelations = relations;
    else delete current.topicRelations;
    await data.repo.saveMap(mapPath, current);
    await data.repo.rebuildDerivedData();
  };
  const refs = node => links(data.contents.get(node.path));
  return { ...data, mapPath, map, nodes, relate, refs };
}

const KINDS = [
  ['supports', '支持', '被支持', 'Supports', 'Supported by'],
  ['contradicts', '反駁', '被反駁', 'Contradicts', 'Contradicted by'],
  ['verifies', '驗證', '被驗證', 'Verifies', 'Verified by'],
  ['derives_from', '推導自', '推導出', 'Derived from', 'Derives'],
  ['prerequisite', '是前置知識於', '前置知識', 'Prerequisite for', 'Prerequisites'],
  ['related', '相關', '相關', 'Related', 'Related']
];

test('R1: each of the six kinds is written at both ends with its own wording (zh-TW and English)', async () => {
  for (const language of ['zh-TW', 'en']) {
    for (const [kind, zhFrom, zhTo, enFrom, enTo] of KINDS) {
      const h = await mapWith(['Root', 'Alpha', 'Beta'], language);
      const [, a, b] = h.nodes;
      await h.relate([{ kind, from: a.id, to: b.id }]);
      const [from, to] = language === 'en' ? [enFrom, enTo] : [zhFrom, zhTo];
      const colon = language === 'en' ? ': ' : '：';
      assert.ok(h.refs(a).includes(`${from}${colon}${link(b)}`), `${language} ${kind} start end:\n${h.refs(a).join('\n')}`);
      assert.ok(h.refs(b).includes(`${to}${colon}${link(a)}`), `${language} ${kind} finish end:\n${h.refs(b).join('\n')}`);
      assert.deepEqual(
        frontmatterRefs(h.repo, h.contents.get(a.path)).filter(entry => entry.startsWith(from)),
        [`${from}${colon}${link(b)}`],
        'the frontmatter lists the same line'
      );
      assert.equal(h.refs(h.nodes[0]).some(line => line.includes(link(a)) && !/子議題|Child topics/.test(line)), false, 'an unrelated topic gets no relation line');
    }
  }
});

test('R2: several relations of one wording share one line, joined like Child topics; no line without one', async () => {
  const h = await mapWith(['Root', 'Hub', 'One', 'Two', 'Three']);
  const [, hub, one, two, three] = h.nodes;
  await h.relate([
    { kind: 'supports', from: hub.id, to: one.id, description: 'not written' },
    { kind: 'supports', from: hub.id, to: two.id },
    { kind: 'supports', from: three.id, to: hub.id }
  ]);
  const refs = h.refs(hub);
  assert.ok(refs.includes(`支持：${link(one)}、${link(two)}`), refs.join('\n'));
  assert.ok(refs.includes(`被支持：${link(three)}`), refs.join('\n'));
  for (const label of ['反駁', '被反駁', '驗證', '相關', '推導自', '前置知識'])
    assert.equal(refs.some(line => line.startsWith(`${label}：`)), false, `no ${label} line`);
  assert.doesNotMatch(h.contents.get(hub.path), /not written/, 'a relation description is not written');
  assert.equal(refs.filter(line => /^(?:支持|被支持)：/.test(line)).some(line => line.endsWith('無')), false, 'never a "none" relation line');
  assert.equal(h.refs(two).some(line => line.startsWith('支持：')), false, 'no start line at a finish-only end');
});

test('R3: relation lines come after Child topics and before Source topic, in kind order, start wording first', async () => {
  const h = await mapWith(['Root', 'Hub', 'S', 'C', 'V', 'D', 'P', 'R', 'In']);
  const [root, hub, s, c, v, d, p, r, into] = h.nodes;
  const source = h.contents.get(hub.path).replace('---\n', `---\nsource-notes:\n  - ${root.path}\n`);
  h.contents.set(hub.path, source);
  await h.relate([
    { kind: 'related', from: r.id, to: hub.id },
    { kind: 'prerequisite', from: p.id, to: hub.id },
    { kind: 'derives_from', from: hub.id, to: d.id },
    { kind: 'verifies', from: v.id, to: hub.id },
    { kind: 'contradicts', from: hub.id, to: c.id },
    { kind: 'supports', from: into.id, to: hub.id },
    { kind: 'supports', from: hub.id, to: s.id }
  ]);
  const relationLabels = ['支持', '被支持', '反駁', '被驗證', '推導自', '前置知識', '相關'];
  const labelsOf = lines => lines.map(line => line.split('：')[0]);
  assert.deepEqual(labelsOf(frontmatterRefs(h.repo, h.contents.get(hub.path))), ['所屬主題', '所屬心智圖', '母議題', '子議題', ...relationLabels]);
  assert.deepEqual(labelsOf(h.refs(hub)), ['所屬主題', '所屬心智圖', '母議題', ...relationLabels, '來源議題'], 'the body hides 子議題：無 as before');
});

test('R4: a relation whose other end has no note is skipped; an unassigned note gets no relation line', async () => {
  const h = await mapWith(['Root', 'Alpha', 'Beta', 'Gamma']);
  const [, a, b, g] = h.nodes;
  const current = await h.repo.readMap(h.mapPath);
  current.nodes.find(node => node.id === g.id).path = 'Agent Workspace/Mind Maps/Relations/Notes/Gone.md';
  current.topicRelations = [
    { kind: 'supports', from: a.id, to: g.id },
    { kind: 'verifies', from: g.id, to: b.id },
    { kind: 'contradicts', from: a.id, to: b.id }
  ];
  await h.repo.saveMap(h.mapPath, current);
  await h.repo.rebuildDerivedData();
  assert.deepEqual(h.refs(a).filter(line => /^(支持|反駁)：/.test(line)), [`反駁：${link(b)}`]);
  assert.equal(h.refs(b).some(line => line.startsWith('被驗證')), false, 'the end with a note skips a relation to a missing note');
  const unassigned = await mapWith(['Root', 'Alpha', 'Beta']);
  const [, ua, ub] = unassigned.nodes;
  await unassigned.relate([{ kind: 'supports', from: ua.id, to: ub.id }]);
  const parked = await unassigned.repo.readMap(unassigned.mapPath);
  parked.nodes = parked.nodes.filter(node => node.id !== ub.id);
  await unassigned.repo.saveMap(unassigned.mapPath, parked);
  const target = await unassigned.repo.moveUnique(ub.path, unassigned.repo.topicFolder(unassigned.mapPath, 'Unassigned'));
  await unassigned.repo.rebuildDerivedData();
  assert.doesNotMatch(unassigned.contents.get(target), /被支持|支持：/);
  assert.equal(unassigned.refs(ua).some(line => line.startsWith('支持：')), false, 'the active end drops a relation to an unassigned note');
});

test('R5: an old English-labelled note under a zh-TW interface gets English relation lines; its old lines stay as they were', async () => {
  const h = await mapWith(['Root', 'Alpha', 'Beta'], 'en');
  const [, a, b] = h.nodes;
  const before = h.refs(a);
  assert.match(before[0], /^Topic: /);
  h.repo.settings.language = 'zh-TW';
  await h.relate([{ kind: 'derives_from', from: a.id, to: b.id }]);
  const after = h.refs(a);
  assert.deepEqual(after.filter(line => !line.startsWith('Derived from')), before, 'the six existing lines are unchanged');
  assert.ok(after.includes(`Derived from: ${link(b)}`));
  assert.ok(h.refs(b).includes(`Derives: ${link(a)}`));
  assert.doesNotMatch(h.contents.get(a.path), /推導|所屬主題|關聯連結/);
});

test('R6: removing the last relation of a kind removes its line; a second rebuild changes nothing', async () => {
  const h = await mapWith(['Root', 'Alpha', 'Beta', 'Gamma']);
  const [, a, b, g] = h.nodes;
  const plain = h.contents.get(a.path);
  await h.relate([{ kind: 'contradicts', from: a.id, to: b.id }, { kind: 'contradicts', from: a.id, to: g.id }]);
  assert.ok(h.refs(a).includes(`反駁：${link(b)}、${link(g)}`));
  const twice = h.contents.get(a.path);
  await h.repo.rebuildDerivedData();
  assert.equal(h.contents.get(a.path), twice, 'a second rebuild changes nothing');
  await h.relate([{ kind: 'contradicts', from: a.id, to: g.id }]);
  assert.ok(h.refs(a).includes(`反駁：${link(g)}`));
  assert.ok(!h.refs(b).some(line => line.startsWith('被反駁')));
  await h.relate([]);
  assert.equal(h.contents.get(a.path), plain, 'with no relation left the note is byte for byte as before');
});
