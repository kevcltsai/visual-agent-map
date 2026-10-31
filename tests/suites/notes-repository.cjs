const assert = require('node:assert/strict');
const { nodeFsAdapter } = require('../support-fs-adapter.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, integrationTest, root, load, core, layout, node, map, plain, tree, TFolder, obsidian, DEFAULT_SETTINGS, fixture, topicNote } = require('../support.cjs');
integrationTest('editing note fields preserves latest AI detail and unrelated frontmatter', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo);
  contents.set(n.path, contents.get(n.path).replace('---\n', '---\ncustom: retain me\n'));
  await repo.updateNote(n.path, { detail: '## Nested heading\n\nAI result with $& and ```code```', newFindings: 'Fresh research', status: 'review' });
  await repo.updateNote(n.path, { title: '修改標題', model: 'model-b', modelSource: 'manual', reasoning: 'high', prompt: 'A task with $&' });
  const result = await repo.readNote(n.path);
  assert.equal(result.detail, '## Nested heading\n\nAI result with $& and ```code```'); assert.equal(result.prompt, 'A task with $&'); assert.equal(result.model, 'model-b'); assert.equal(result.status, 'completed');
  assert.equal(result.reasoning, 'high');
  assert.equal(result.newFindings, 'Fresh research');
  assert.match(contents.get(n.path), /## Working Findings\n\nFresh research/);
  assert.match(contents.get(n.path), /custom: retain me/);
});
integrationTest('local research mode persists; a missing or unrecognised research-mode reads as Quick, an explicit research stays Standard; a stored research-depth line is ignored on read and left as it is on write', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo);
  const original = await repo.readNote(n.path);
  assert.equal(original.researchMode, 'local', 'a missing research-mode reads as Quick');
  contents.set(n.path, contents.get(n.path).replace('---\n', '---\nresearch-mode: deep\n'));
  assert.equal((await repo.readNote(n.path)).researchMode, 'local', 'an unrecognised research-mode reads as Quick');
  contents.set(n.path, contents.get(n.path).replace('research-mode: deep\n', 'research-mode: research\n'));
  assert.equal((await repo.readNote(n.path)).researchMode, 'research', 'an explicit research stays Standard');
  contents.set(n.path, contents.get(n.path).replace('research-mode: research\n', ''));
  assert.equal('researchDepth' in original, false, 'the note has no depth any more');
  assert.equal(original.visualMode, 'auto');
  contents.set(n.path, contents.get(n.path).replace('---\n', '---\nresearch-depth: deep\n'));
  assert.equal('researchDepth' in (await repo.readNote(n.path)), false, 'research-depth is not read');
  await repo.updateNote(n.path, { researchMode: 'local', visualMode: 'off' });
  const updated = await repo.readNote(n.path);
  assert.equal(updated.researchMode, 'local');
  assert.equal(updated.visualMode, 'off');
  assert.match(contents.get(n.path), /research-depth: deep/, 'the old line is neither rewritten nor deleted');
  assert.match(contents.get(n.path), /research-mode: local/);
  await repo.updateNote(n.path, { researchDepth: 'fast' });
  assert.match(contents.get(n.path), /research-depth: deep/, 'a patch can no longer write the depth');
  await repo.updateNote(n.path, { researchMode: 'research' });
  assert.equal((await repo.readNote(n.path)).researchMode, 'research');
});
integrationTest('a new topic note stores research-mode only when its creator asks for it (Quick = local)', async () => {
  const { repo, contents } = fixture();
  const mapPath = await repo.createMap('Modes'), map = await repo.readMap(mapPath);
  const quick = await repo.createNote('Quick topic', 'model-a', map, mapPath, 'workspace', { researchMode: 'local' });
  const plain_ = await repo.createNote('Plain topic', 'model-a', map, mapPath, 'workspace');
  assert.match(contents.get(quick.path), /research-mode: local/);
  assert.doesNotMatch(contents.get(plain_.path), /research-mode/, 'integration, merge and sample notes write nothing');
  assert.equal((await repo.readNote(quick.path, map)).researchMode, 'local');
  assert.equal((await repo.readNote(plain_.path, map)).researchMode, 'local', 'missing = Quick (D-2026-10-273)');
  for (const key of ['research-depth']) assert.doesNotMatch(contents.get(quick.path) + contents.get(plain_.path), new RegExp(key));
});
integrationTest('current summary is editable in the Markdown body', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Editable summary');
  assert.match(contents.get(n.path), /## Current Summary\n\n尚未形成結論/);
  await repo.updateNote(n.path, { summary: 'AI conclusion that can be edited' });
  assert.match(contents.get(n.path), /summary: AI conclusion that can be edited/);
  assert.match(contents.get(n.path), /## Current Summary\n\nAI conclusion that can be edited/);
  contents.set(n.path, contents.get(n.path).replace('## Current Summary\n\nAI conclusion that can be edited', '## Current Summary\n\nUser-edited conclusion'));
  assert.equal((await repo.readNote(n.path)).summary, 'User-edited conclusion');
});
integrationTest('English notes use English preview, pending summary, and managed reference labels', async () => {
  const { repo, app, contents } = fixture('en');
  const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
  assert.match(contents.get(mapPath), /This file stores the mind map structure/);
  assert.doesNotMatch(contents.get(mapPath), /此檔案保存心智圖結構/);
  const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(note); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  let markdown = contents.get(note.path);
  assert.match(markdown, /## Current Summary\n\nNo conclusion yet/);
  assert.doesNotMatch(markdown, /\[!info\]- Preview|## Preview/, 'an empty (placeholder) Preview is not written');
  assert.match(markdown, /- Topic: \[\[/);
  assert.match(markdown, /- Mind map: \[\[/);
  assert.doesNotMatch(markdown, /尚未形成結論|## 預覽|所屬主題|所屬心智圖/);
  await repo.updateNote(note.path, { sourcePaths: ['Source.md'], detail: 'English detail' });
  markdown = contents.get(note.path);
  assert.match(markdown, /- Source topic: \[\[Source\]\]/);
  assert.equal((await repo.readNote(note.path)).preview, '');
  await repo.updateNote(note.path, { summary: 'English conclusion' });
  assert.equal((await repo.readNote(note.path)).preview, 'English conclusion');
  assert.match(contents.get(note.path), /> \[!info\]- Preview\n> English conclusion/);
  const copy = await repo.duplicateNote(note.path, map, mapPath);
  assert.match(copy.path, /Route copy\.md$/);
  assert.throws(() => repo.file('Missing.md'), /File not found/);
});
integrationTest('a language switch never relabels an existing note: writes and rebuilds keep its scaffolding language; new notes use the UI language', async () => {
  const { repo, app, contents } = fixture();
  const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
  const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(note); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  await repo.updateNote(note.path, { detail: 'Keep detail', sourcePaths: ['Source.md'] });
  const beforeSwitch = contents.get(note.path);
  repo.settings.language = 'en';
  assert.equal(contents.get(note.path), beforeSwitch);
  await repo.updateNote(note.path, { model: 'model-b' });
  let markdown = contents.get(note.path);
  assert.doesNotMatch(markdown, /\[!info\]- (預覽|Preview)/, 'an empty (placeholder) Preview is not written');
  assert.match(markdown, /## Current Summary\n\n尚未形成結論/);
  assert.match(markdown, /- 所屬主題：\[\[/);
  assert.match(markdown, /- 來源議題：\[\[Source\]\]/);
  assert.match(markdown, /Keep detail/);
  assert.doesNotMatch(markdown, /## Preview|No conclusion yet|- Topic:|Source topic/);
  await repo.updateNote(note.path, { preview: 'My own preview' });
  await repo.rebuildDerivedData();
  markdown = contents.get(note.path);
  assert.match(markdown, /> \[!info\]- 預覽\n> My own preview/);
  assert.match(markdown, /- 所屬主題：\[\[/);
  assert.doesNotMatch(markdown, /## Preview|\[!info\]- Preview|No conclusion yet|- Topic:/);
  assert.equal((await repo.readNote(note.path)).preview, 'My own preview');
  const fresh = await repo.createNote('Fresh', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(fresh); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  assert.doesNotMatch(contents.get(fresh.path), /預覽|尚未形成結論/, 'a new note uses the current UI language');
  assert.match(contents.get(fresh.path), /- Topic: \[\[/);
  const bare = 'Agent Workspace/Unfiled/Bare.md';
  await repo.folder('Agent Workspace/Unfiled');
  const bareContent = '---\nagent-map-node: true\nnode-id: bare\ntitle: Bare\n---\n# Bare\n';
  contents.set(bare, bareContent); await app.vault.create(bare, bareContent);
  await repo.rebuildDerivedData();
  assert.match(contents.get(bare), /## Current Summary\n\nNo conclusion yet/, 'a note with no derived labels uses the current UI language');
});
integrationTest('editing a note heading updates its card title and survives later note writes', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, '新的子議題');
  contents.set(n.path, contents.get(n.path).replace('# 新的子議題', '# 要如何推廣VAM'));
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
  await repo.updateNote(n.path, { summary: '新的摘要' });
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
  assert.match(contents.get(n.path), /title: 要如何推廣VAM/);
  assert.match(contents.get(n.path), /^# 要如何推廣VAM$/m);
  await repo.rebuildDerivedData();
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
});
integrationTest('visual references are stored inside the editable Detail section', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Outfit');
  await repo.updateNote(n.path, { visualReferences: '### Navy + Beige\n\n![Navy + Beige](https://example.com/outfit.jpg)\n\n來源：https://example.com/page\n配色：navy / beige' });
  let note = await repo.readNote(n.path);
  assert.equal(note.visualReferences, '');
  assert.match(note.detail, /\*\*Navy \+ Beige\*\*/);
  assert.doesNotMatch(note.detail, /### 視覺參考/);
  assert.doesNotMatch(contents.get(n.path), /## Visual References/);
  await repo.updateNote(n.path, { visualReferences: '' });
  note = await repo.readNote(n.path);
  assert.equal(note.visualReferences, '');
  assert.doesNotMatch(contents.get(n.path), /## Visual References/);
});
integrationTest('reference rebuild keeps a note edit made after the rebuild read the note', async () => {
  const { repo, contents, app } = fixture(); const n = await topicNote(repo);
  await repo.createMap('Map A', [n]);
  const process = app.vault.process;
  let edited = false;
  app.vault.process = async (file, change) => {
    if (file.path === n.path && !edited) {
      edited = true;
      contents.set(n.path, `${contents.get(n.path)}\n\nEdited while references were rebuilding`);
    }
    return process(file, change);
  };
  await repo.rebuildDerivedData();
  assert.equal(edited, true);
  assert.match(contents.get(n.path), /Edited while references were rebuilding/);
  assert.match(contents.get(n.path), /agent-map-references:/);
});
integrationTest('node presentation repair keeps a note edit made after the check', async () => {
  const { repo, contents, app } = fixture(); const n = await topicNote(repo);
  contents.set(n.path, contents.get(n.path).replace(/^cssclasses:\n(  - .*\n)+/m, ''));
  const process = app.vault.process;
  app.vault.process = async (file, change) => {
    contents.set(file.path, `${contents.get(file.path)}\n\nLate edit`);
    return process(file, change);
  };
  await repo.ensureNodePresentation();
  assert.match(contents.get(n.path), /Late edit/);
  assert.match(contents.get(n.path), /cssclasses:/);
});
integrationTest('managed references stay outside Detail and preserve user-authored content', async () => {
  const { repo, contents, app } = fixture(); const n = await topicNote(repo);
  const mapPath = await repo.createMap('Map A', [n]);
  await repo.rebuildDerivedData();
  let text = contents.get(n.path);
  assert.match(text, /visual-agent-map:references:start/);
  assert.match(text, /## Reference Links/);
  assert.match(text, /agent-map-references:/);
  assert.doesNotMatch((await repo.readNote(n.path)).detail, /關聯議題/);
  text = text.replace('<!-- visual-agent-map:detail:end -->', '<!-- visual-agent-map:detail:end -->\n\n## User notes\n\nUser content'); contents.set(n.path, text);
  await repo.updateNote(n.path, { detail: 'New detail' }); await repo.rebuildDerivedData();
  assert.match(contents.get(n.path), /User content/); assert.equal((await repo.readNote(n.path)).detail, 'New detail');
  assert.ok(app.vault.getAbstractFileByPath(mapPath));
});
integrationTest('a note cannot belong to two maps', async () => {
  const { repo } = fixture(); const n = await topicNote(repo, 'shared');
  await repo.createMap('One', [n]); await repo.createMap('Two', [n]);
  await assert.rejects(() => repo.rebuildDerivedData(), /同時出現在兩張心智圖/);
});
integrationTest('removing a node clears ownership and generated references while keeping the note', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'kept'); const mapPath = await repo.createMap('One', [n]);
  await repo.rebuildDerivedData(); const mapDoc = await repo.readMap(mapPath); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  assert.equal((await repo.readNote(n.path)).mapId, ''); assert.doesNotMatch(contents.get(n.path), /visual-agent-map:references:start/); assert.doesNotMatch(contents.get(n.path), /agent-map-references:/);
});
integrationTest('maps keep independent layout and preserve Markdown prose', async () => {
  const { repo, contents } = fixture(); const firstNode = await topicNote(repo, 'first', 'gpt-5.6-terra', 'map-a'); const secondNode = await topicNote(repo, 'second', 'gpt-5.6-terra', 'map-b');
  const first = await repo.createMap('One', [firstNode]), second = await repo.createMap('Two', [secondNode]);
  contents.set(first, contents.get(first) + '\nUser annotation\n');
  const changed = await repo.readMap(first); changed.nodes[0].x = 600; changed.title = 'Renamed'; await repo.saveMap(first, changed);
  assert.equal((await repo.readMap(second)).nodes[0].x, 80); assert.match(contents.get(first), /User annotation/); assert.match(contents.get(first), /# Renamed/);
});
integrationTest('large vaults: map discovery, unrelated renames and rebuilds read only VAM files', async () => {
  const { repo, app } = fixture();
  const path = await repo.createMap('Perf', []), map = await repo.readMap(path);
  const node = await repo.createNote('Tracked', 'a', map, path, 'workspace'); map.nodes.push(node); await repo.saveMap(path, map);
  for (let index = 0; index < 50; index++) await app.vault.create(`Personal/note-${index}.md`, `# Personal ${index}\n\nPlain text.`);
  const reads = [];
  for (const method of ['read', 'cachedRead']) { const original = app.vault[method].bind(app.vault); app.vault[method] = async file => { reads.push(file.path); return original(file); }; }
  assert.deepEqual(JSON.parse(JSON.stringify((await repo.mapFiles()).map(file => file.path))), [path]);
  await repo.replaceSourcePath('Personal/note-1.md', 'Personal/note-1 renamed.md');
  assert.equal(await repo.isMapNodePath('Personal/note-1.md'), false);
  assert.equal(await repo.isMapNodePath(node.path), true);
  await repo.rebuildDerivedData();
  assert.deepEqual(reads.filter(item => item.startsWith('Personal/')), [], 'no unrelated note was read');
  // Rename relevance is decided from the metadata cache alone.
  reads.length = 0;
  assert.equal(repo.renameAffectsVam(app.vault.getAbstractFileByPath('Personal/note-2.md'), 'Personal/old-2.md'), false);
  assert.equal(repo.renameAffectsVam(app.vault.getAbstractFileByPath(node.path), 'Elsewhere/tracked.md'), true, 'a VAM note is relevant');
  await repo.updateNote(node.path, { sourcePaths: ['Personal/old-3.md'] });
  assert.equal(repo.renameAffectsVam(app.vault.getAbstractFileByPath('Personal/note-3.md'), 'Personal/old-3.md'), true, 'a note cited by a VAM note is relevant');
  assert.deepEqual(reads, [], 'relevance checks read no file');
});
integrationTest('external rename reconciliation only follows a unique matching node-id', async () => {
  const { repo, app, contents } = fixture(); const n = await topicNote(repo, 'External rename');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', doc = { id: 'map-a', title: 'Map A', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(doc));
  const renamed = 'Agent Workspace/Topics/map-a/Notes/External rename moved.md';
  await app.fileManager.renameFile(app.vault.getAbstractFileByPath(n.path), renamed);
  assert.equal(await repo.reconcileMissingNodePaths(), 1);
  assert.equal((await repo.readMap(mapPath)).nodes[0].path, renamed);

  const second = fixture(); const other = await topicNote(second.repo, 'Ambiguous rename');
  const otherMap = 'Agent Workspace/Topics/map-a/Map.md', otherDoc = { id: 'map-a', title: 'Map A', version: 1, nodes: [other], viewport: { x: 0, y: 0, zoom: 1 } };
  await second.app.vault.create(otherMap, core.serializeMap(otherDoc));
  const firstCandidate = 'Agent Workspace/Topics/map-a/Notes/Ambiguous one.md', secondCandidate = 'Agent Workspace/Topics/map-a/Notes/Ambiguous two.md';
  await second.app.fileManager.renameFile(second.app.vault.getAbstractFileByPath(other.path), firstCandidate);
  await second.app.vault.create(secondCandidate, second.contents.get(firstCandidate));
  assert.equal(await second.repo.reconcileMissingNodePaths(), 0);
  assert.equal((await second.repo.readMap(otherMap)).nodes[0].path, other.path);
});
integrationTest('new topics contain Map, Notes, Unassigned and Archive', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Topic A');
  assert.equal(mapPath, 'Agent Workspace/Mind Maps/Topic A/Map.md');
  for (const name of ['Notes', 'Unassigned', 'Archive']) assert.ok(app.vault.getAbstractFileByPath(`Agent Workspace/Mind Maps/Topic A/${name}`) instanceof TFolder);
});
integrationTest('unassigned and archived notes keep topic ownership but leave the map', async () => {
  const { repo, contents } = fixture(), mapPath = await repo.createMap('Lifecycle'), mapDoc = await repo.readMap(mapPath);
  const n = await repo.createNote('Knowledge', 'a', mapDoc, mapPath, 'workspace'); mapDoc.nodes.push(n); await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  const unassigned = await repo.moveUnique(n.path, repo.topicFolder(mapPath, 'Unassigned')); await repo.setLifecycle(unassigned, mapDoc.id, '', 'unassigned'); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  let note = await repo.readNote(unassigned); assert.equal(note.topicId, mapDoc.id); assert.equal(note.mapId, ''); assert.equal(note.topicState, 'unassigned'); assert.match(contents.get(unassigned), /狀態：未歸類/);
  const archived = await repo.moveUnique(unassigned, repo.topicFolder(mapPath, 'Archive')); await repo.setLifecycle(archived, mapDoc.id, '', 'archived'); await repo.rebuildDerivedData();
  note = await repo.readNote(archived); assert.equal(note.topicState, 'archived'); assert.match(contents.get(archived), /狀態：已封存/);
});
integrationTest('a missing Map can be rebuilt from topic Notes as root nodes', async () => {
  const { repo } = fixture(), root = 'Agent Workspace/Topics/Broken', placeholder = { id: 'stable-topic', title: 'Broken', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(root); await repo.createNote('Recovered', 'a', placeholder, `${root}/Map.md`, 'workspace');
  const path = await repo.rebuildMissingMap(root), rebuilt = await repo.readMap(path); assert.equal(rebuilt.id, 'stable-topic'); assert.equal(rebuilt.nodes.length, 1); assert.equal(rebuilt.nodes[0].parentId, null);
});
integrationTest('replacing AI synthesis preserves 預覽', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Synthesis');
  await repo.updateNote(n.path, { detail: 'Old synthesis', preview: 'Keep this manually written note' });
  await repo.updateNote(n.path, { detail: 'New synthesis', prompt: '' });
  const result = await repo.readNote(n.path); assert.equal(result.detail, 'New synthesis'); assert.equal(result.preview, 'Keep this manually written note'); assert.equal(result.prompt, '');
});
integrationTest('text undo uses field patches and preserves AI details arriving in between', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Original', 'a');
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => {} });
  view.refreshCard = () => {}; view.updateHistoryButtons = () => {}; view.render = () => {};
  await view.noteChange(n, { title: 'Edited' }); await repo.updateNote(n.path, { detail: 'New AI answer' }); await view.travel(false);
  const note = await repo.readNote(n.path); assert.equal(note.title, 'Original'); assert.equal(note.detail, 'New AI answer');
});
integrationTest('generated child filenames are migrated to their topic titles and maps stay linked', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Filename migration'), mapDoc = await repo.readMap(mapPath);
  const child = await repo.createNote('新的子議題', 'a', mapDoc, mapPath, 'workspace');
  await repo.updateNote(child.path, { title: '清楚的子議題名稱' }); mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const count = await repo.normalizeGeneratedNoteFilenames(), updated = await repo.readMap(mapPath);
  assert.equal(count, 1); assert.match(updated.nodes[0].path, /清楚的子議題名稱\.md$/); assert.ok(app.vault.getAbstractFileByPath(updated.nodes[0].path));
});
integrationTest('map topic sources retain every selected summary and working finding', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'a'), second = await topicNote(repo, 'Recipe B', 'a');
  await repo.updateNote(first.path, { summary: 'Use more onion', newFindings: '### 暫存結論\n\nOnion adds sweetness.' });
  await repo.updateNote(second.path, { summary: 'Toast the buns' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  const group = await view.topicReferenceGroup([first, second]);
  assert.deepEqual(group.documents.map(document => document.path), [first.path, second.path]);
  assert.match(group.documents[0].content, /Use more onion/);
  assert.match(group.documents[0].content, /Onion adds sweetness/);
  assert.match(group.documents[1].content, /Toast the buns/);
});
integrationTest('legacy integrated source links resolve from short Obsidian links', async () => {
  const { repo, app } = fixture(), source = await topicNote(repo, 'Recipe A', 'a'), root = await topicNote(repo, 'Integrated Burger', 'a');
  await repo.updateNote(root.path, { detail: '### 整合來源（保存內容）\n\n- [[Recipe A]]' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  assert.deepEqual(plain(view.referenceSourcePaths(await repo.readNote(root.path), root.path)), [source.path]);
});
integrationTest('creating an integrated topic runs AI with full sources and keeps clickable source paths', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'model-a'), second = await topicNote(repo, 'Recipe B', 'model-a');
  await repo.updateNote(first.path, { summary: 'Saved onion note', newFindings: 'Caramelize slowly.' });
  await repo.updateNote(second.path, { summary: 'Saved bun note' });
  first.x = 80; first.y = 80; second.x = 420; second.y = 220;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { abortChartJobs: () => {}, addChartsAfterWrite: () => {}, repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, askModel: async context => {
    assert.equal(context.mode, 'synthesize'); const allSources = context.referenceGroups.flatMap(group => group.documents).map(document => document.content).join('\n'); assert.match(allSources, /Saved onion note/); assert.match(allSources, /Caramelize slowly/); assert.match(allSources, /Saved bun note/);
    return { summary: 'Integrated answer', detail: 'Integrated detail', suggestions: [] };
  } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.createIntegratedNode('Personal Burger', [first, second], 'Find the best approach', 'Use tables');
  const savedMap = await repo.readMap(mapPath); assert.equal(savedMap.nodes.length, 3);
  const integrated = await repo.readNote(savedMap.nodes[2].path);
  assert.match(integrated.detail, /### Core conclusions/);
  assert.deepEqual(integrated.sourcePaths, [first.path, second.path]);
  assert.equal(integrated.rules, '');
  assert.equal(integrated.status, 'completed');
});
integrationTest('failed multi-select integration creates no empty root or note', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'model-a'), second = await topicNote(repo, 'Recipe B', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, askModel: async () => { throw new Error('provider unavailable'); } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await assert.rejects(() => view.createIntegratedNode('Should not exist', [first, second], 'Combine', ''), /provider unavailable/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/Topics/map-a/Notes/Should not exist.md'), undefined);
});
integrationTest('saved integration is not offered for retry when derived-data refresh fails', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Source A'), second = await topicNote(repo, 'Source B');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { abortChartJobs: () => {}, addChartsAfterWrite: () => {}, repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { throw new Error('refresh unavailable'); }, askModel: async () => ({ summary: 'Combined', detail: 'Combined knowledge', suggestions: [] }) };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.focusNode = () => {};
  await view.createIntegratedNode('Combined', [first, second], 'Compare', '');
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal(view.integrationTask, null);
});
integrationTest('topic notes hide properties without removing existing css classes', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Styled', 'a');
  let content = contents.get(n.path); assert.match(content, /visual-agent-map-node/);
  content = content.replace('cssclasses:\n  - visual-agent-map-node', 'cssclasses:\n  - user-class'); contents.set(n.path, content);
  await repo.ensureNodePresentation(); content = contents.get(n.path); assert.match(content, /user-class/); assert.match(content, /visual-agent-map-node/);
});
integrationTest('deleted map restore refuses an occupied path without changing its contents', async () => {
  const { repo, app } = fixture(), path = await repo.createMap('Restoration conflict', []);
  const existing = await app.vault.read(repo.file(path));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo });
  view.deletedMap = { path, content: 'previous map contents', map: await repo.readMap(path), deleted: true };
  await assert.rejects(() => view.restoreDeletedMap());
  assert.equal(await app.vault.read(repo.file(path)), existing);
  assert.equal(view.deletedMap.deleted, true);
});
integrationTest('map structural undo restores deleted branch; redo removes it again', async () => {
  const { repo, app } = fixture(); const file = await repo.createMap('Undo', tree());
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => {} });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(m => { m.nodes = core.removeNodes(m.nodes, 'a', true); }); assert.equal((await repo.readMap(file)).nodes.length, 1);
  await view.travel(false); assert.equal((await repo.readMap(file)).nodes.length, 4);
  await view.travel(true); assert.equal((await repo.readMap(file)).nodes.length, 1);
});
integrationTest('layout-only map changes and AI note results do not rebuild derived data', async () => {
  const { repo, app } = fixture(), file = await repo.createMap('Layout', tree()); let rebuilds = 0;
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => { rebuilds++; } });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(map => { map.nodes[0].x = 120; map.viewport.zoom = 1.2; }); assert.equal(rebuilds, 0);
  await view.mapChange(map => { map.nodes[0].parentId = 'd'; }); assert.equal(rebuilds, 1);
});
integrationTest('full auto layout can be undone without changing parent links', async () => {
  const { repo, app } = fixture(), file = await repo.createMap('Arrange', tree());
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => assert.fail('layout should not rebuild ownership') });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  const before = plain(view.map.nodes);
  await view.mapChange(map => { map.nodes = layout.arrangeMap(map.nodes); }, false);
  const after = (await repo.readMap(file)).nodes;
  assert.notDeepEqual(plain(after), before);
  assert.deepEqual(Array.from(after, item => item.parentId), Array.from(before, item => item.parentId));
  await view.travel(false);
  assert.deepEqual(plain((await repo.readMap(file)).nodes), before);
});
integrationTest('legacy User Notes move to preview without losing either section or duplicating on save', async () => {
  const { repo, contents } = fixture(), n = await topicNote(repo, 'Legacy preview');
  await repo.updateNote(n.path, { preview: 'New preview' });
  contents.set(n.path, contents.get(n.path).replace('## Detail', '## User Notes\n\nLegacy text\n\n## Detail'));
  assert.equal((await repo.readNote(n.path)).preview, 'New preview\n\nLegacy text');
  await repo.updateNote(n.path, { summary: 'AI summary' });
  await repo.updateNote(n.path, { detail: 'AI detail' });
  assert.equal((await repo.readNote(n.path)).preview, 'New preview\n\nLegacy text');
  assert.doesNotMatch(contents.get(n.path), /## User Notes/);
  await repo.updateNote(n.path, { preview: '' });
  assert.equal((await repo.readNote(n.path)).preview, '');
});
integrationTest('first AI answer seeds summary and image in preview, later answers preserve it including an explicit clear', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Preview default');
  assert.equal((await repo.readNote(n.path)).preview, '', 'a new note has no Preview until the first answer');
  await repo.updateNote(n.path, { summary: '簡短結論', detail: '文字\n\n![相關圖片](https://example.com/image.jpg)' });
  assert.equal((await repo.readNote(n.path)).preview, '簡短結論\n\n![相關圖片](https://example.com/image.jpg)');
  await repo.updateNote(n.path, { summary: '第二次結論', detail: '新正文' });
  assert.match((await repo.readNote(n.path)).preview, /簡短結論/);
  await repo.updateNote(n.path, { preview: '' });
  await repo.updateNote(n.path, { summary: '第三次結論' });
  assert.equal((await repo.readNote(n.path)).preview, '');
});
integrationTest('AI answer cannot replace preview edited while task was running', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Manual preview');
  await repo.updateNote(n.path, { preview: '使用者的文字' });
  await repo.updateNote(n.path, { summary: 'AI 結論', detail: '![圖](https://example.com/image.jpg)' });
  assert.equal((await repo.readNote(n.path)).preview, '使用者的文字');
});
integrationTest('AI history refuses to undo over a later edit and retains the undo entry', async () => {
  const { repo, app } = fixture(), node = await topicNote(repo, 'Conflict guard');
  const before = await repo.readNote(node.path);
  await repo.updateNote(node.path, { summary: 'AI answer', detail: 'AI detail', status: 'completed' });
  const after = await repo.readNote(node.path);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo }); view.map = map([node]); view.render = () => {}; view.hydrate = async () => {};
  view.recordNoteWrite(node.path, before, after, ['summary', 'detail', 'status'], 'Research');
  await repo.updateNote(node.path, { detail: 'Manual follow-up' });
  await assert.rejects(() => view.travel(false));
  assert.equal((await repo.readNote(node.path)).detail, 'Manual follow-up');
  assert.equal(view.history.canUndo, true);
  await repo.updateNote(node.path, { detail: 'AI detail' });
  await view.travel(false);
  assert.equal((await repo.readNote(node.path)).summary, before.summary);
  assert.equal(view.history.canRedo, true);
});
integrationTest('images follow related text and inline images are not duplicated', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Inline images');
  const reference = '**配色建議**\n![配色](https://example.com/color.jpg)\n來源：https://example.com/source';
  await repo.updateNote(n.path, { summary: '結論', detail: '### 核心結論\n\n摘要\n\n### 關鍵知識\n\n配色建議：採用低彩度。\n\n另一項建議。\n\n### 證據與來源\n\n來源', visualReferences: reference });
  let detail = (await repo.readNote(n.path)).detail;
  assert.ok(detail.indexOf('![配色]') > detail.indexOf('配色建議：'));
  assert.ok(detail.indexOf('![配色]') < detail.indexOf('另一項建議'));
  assert.doesNotMatch(detail, /### 視覺參考/);
  await repo.updateNote(n.path, { visualReferences: reference });
  detail = (await repo.readNote(n.path)).detail;
  assert.equal((detail.match(/color.jpg/g) || []).length, 1);
  assert.match((await repo.readNote(n.path)).preview, /color.jpg/);
});
integrationTest('references in synthesized notes remain clickable after rebuilding, updates and source renames', async () => {
  const { repo, contents } = fixture(); const path = await repo.createMap('References', []), mapDoc = await repo.readMap(path);
  const first = await repo.createNote('Source A', 'a', mapDoc, path, 'workspace'), second = await repo.createNote('Source B', 'a', mapDoc, path, 'workspace');
  const integrated = await repo.createNote('Integrated', 'a', mapDoc, path, 'workspace'); mapDoc.nodes.push(first, second, integrated); await repo.saveMap(path, mapDoc);
  await repo.updateNote(integrated.path, {sourcePaths: [first.path, second.path], detail: 'Knowledge'});
  await repo.rebuildDerivedData(); await repo.updateNote(integrated.path, {summary: 'Updated'}); await repo.rebuildDerivedData();
  const text = contents.get(integrated.path);
  assert.match(text, /## Reference Links/);
  assert.ok(text.includes('[[' + first.path.replace(/\.md$/, '') + ']]'));
  assert.ok(text.includes('[[' + second.path.replace(/\.md$/, '') + ']]'));
  assert.equal((text.match(/## Reference Links/g) || []).length, 1);
  assert.equal((await repo.readNote(integrated.path)).detail, 'Knowledge');
  const renamed = await repo.renameNote(first.path, 'Source renamed'); await repo.rebuildDerivedData();
  assert.ok(contents.get(integrated.path).includes('[[' + renamed.replace(/\.md$/, '') + ']]'));
  assert.deepEqual((await repo.readNote(integrated.path)).sourcePaths, [renamed, second.path]);
  const moved = await repo.moveUnique(renamed, repo.topicFolder(path, 'Unassigned'));
  await repo.rebuildDerivedData();
  assert.ok(contents.get(integrated.path).includes('[[' + moved.replace(/\.md$/, '') + ']]'));
});
integrationTest('dragging synthesized roots persists coordinates and removal preserves notes with undo', async () => {
  const {repo,app} = fixture(), path = await repo.createMap('Root operations', []), mapDoc = await repo.readMap(path);
  const first = await repo.createNote('First','a',mapDoc,path,'workspace'), second=await repo.createNote('Second','a',mapDoc,path,'workspace'); mapDoc.nodes.push(first,second);await repo.saveMap(path,mapDoc);
  let pending=Promise.resolve();
  const plugin={abortChartJobs:()=>{},addChartsAfterWrite:()=>{},repo,settings:{...DEFAULT_SETTINGS},rebuildDerivedData:()=>repo.rebuildDerivedData(),askModel:async()=>({summary:'Merged',detail:'Knowledge',visualReferences:[],suggestions:[]}),mutate(work){pending=pending.then(work);return pending}};
  const {VisualAgentMapView}=load('main.ts',{obsidian},{requestAnimationFrame:run=>{run();return 1},cancelAnimationFrame(){}}); const view=new VisualAgentMapView({app},plugin);view.path=path;view.map=mapDoc;view.integrationMode=true;view.render=()=>{};view.focusNode=()=>{};view.drawEdges=()=>{};view.updateHistoryButtons=()=>{};
  await view.createIntegratedNode('Combined',[first,second],'Combine','');
  const root=view.map.nodes.find(n=>n.id!==first.id&&n.id!==second.id); assert.equal(root.parentId,null);assert.equal(view.integrationMode,false);
  const origin={x:root.x,y:root.y}; const events=new Map(),card={style:{},setPointerCapture(){},addEventListener(name,fn){events.set(name,fn)},removeEventListener(name){events.delete(name)}};
  view.enableDrag(card,root);events.get('pointerdown')({target:{closest(){return null}},button:0,clientX:10,clientY:10,pointerId:1});assert.equal(view.dragging,true);
  events.get('pointermove')({clientX:80,clientY:50});events.get('pointerup')({type:'pointerup'});await pending;
  const saved=(await repo.readMap(path)).nodes.find(n=>n.id===root.id); assert.equal(saved.x,origin.x+70);assert.equal(saved.y,origin.y+40);assert.equal(view.dragging,false);
  await view.removeToUnassigned(saved,false);assert.ok(!(await repo.readMap(path)).nodes.some(n=>n.id===root.id));assert.equal((await repo.collectionFiles(path,'Unassigned')).length,1);
  await view.travel(false);assert.ok((await repo.readMap(path)).nodes.some(n=>n.id===root.id));assert.ok(app.vault.getAbstractFileByPath(root.path));
});
integrationTest('switching the interface language preserves exact existing Markdown bytes', async () => {
  const { app, contents, repo } = fixture('zh-TW');
  const note = await topicNote(repo, '保留原文');
  const before = contents.get(note.path);
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.settings = repo.settings;
  plugin.repo = repo; plugin.saveData = async () => {}; plugin.views = () => [];
  plugin.refreshLocalizedEntrypoints = () => {}; plugin.settingTab = { update() {}, refreshAfterLanguageChange() {} };
  await plugin.changeLanguage('en');
  await plugin.changeLanguage('zh-TW');
  assert.equal(contents.get(note.path), before);
  assert.equal(await app.vault.read(app.vault.getAbstractFileByPath(note.path)), before);
});
integrationTest('Markdown reader accepts only Markdown and reads the full file without changing it', async () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const body = 'Full source sentinel\n'.repeat(1_000) /* 21_000 chars: past the 14_000 per-document batch size (ai/reference-materials.ts:52) */;
  const file = { extension: 'md', path: 'Maps/Source.md' };
  const result = await api.readMarkdownFile({ vault: { read: async selected => { assert.equal(selected, file); return body; } } }, file);
  assert.equal(result.path, file.path); assert.equal(result.content, body); assert.equal(result.external, undefined);
  await assert.rejects(api.readMarkdownFile({ vault: { read: async () => { throw new Error('should not read'); } } }, { extension: 'pdf', path: 'Source.pdf' }), /Only Markdown/);
});
integrationTest('legacy reference metadata is preserved but no longer copied when duplicating a map', async () => {
  const { repo } = fixture(); const note = await topicNote(repo, 'Reference owner', 'model');
  await repo.updateNote(note.path, { referencePaths: ['Evidence.pdf', 'Other.md'], detail: 'Keep all detail' });
  const preserved = await repo.readNote(note.path);
  assert.deepEqual(preserved.referencePaths, ['Evidence.pdf', 'Other.md']); assert.equal(preserved.detail, 'Keep all detail');
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(source, /referencePaths:\s*note\.referencePaths/);
});
integrationTest('persisted JSON validates all exchange fields and optional suggestion parent without rewriting input', async () => {
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-json-boundary-'));
  try {
    const file = path.join(directory, 'exchanges.json');
    const valid = { id: '1', startedAt: 'now', topic: 'Topic', mode: 'task', model: 'test', effort: 'low', request: 'prompt', response: 'answer', status: 'completed', error: '' };
    const invalid = Object.keys(valid).map(key => ({ ...valid, [key]: 12 }));
    const text = JSON.stringify([valid, ...invalid, { ...valid, status: 'unknown' }]); fs.writeFileSync(file, text);
    const errors = []; const log = new AiExchangeLog(nodeFsAdapter, file, error => errors.push(error)); await log.load();
    assert.equal(log.getEntries().length, 0); assert.equal(errors.length, 1);
    log.begin({ ...valid, id: 'new' }); await log.flush(); assert.equal(fs.readFileSync(file, 'utf8'), text);
    const proposals = path.join(directory, 'suggestions.json');
    fs.writeFileSync(proposals, JSON.stringify([['topic.md', [{ title: 'A', task: 'B', contribution: 'C' }, { title: 'A', task: 'B', contribution: 'C', parentTitle: 12 }]]]));
    const pending = new PendingSuggestions(nodeFsAdapter, proposals, error => errors.push(error)); await pending.load();
    assert.equal(pending.size, 0); const original = fs.readFileSync(proposals, 'utf8');
    pending.set('new.md', [{ title: 'New', task: '', contribution: '' }]); await assert.rejects(pending.flush());
    assert.equal(fs.readFileSync(proposals, 'utf8'), original);
    for (const Store of [AiExchangeLog, PendingSuggestions]) {
      const failures = []; const broken = new Store(nodeFsAdapter, file, error => failures.push(error));
      fs.writeFileSync(file, '{broken'); await broken.load(); assert.equal(failures.length, 1);
      fs.rmSync(file); const missing = new Store(nodeFsAdapter, file, error => failures.push(error)); await missing.load(); assert.equal(failures.length, 1);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

integrationTest('repository: titles differing only in case get distinct file names, existing files are untouched', async () => {
  const { repo, app } = fixture('en');
  const mapPath = await repo.createMap('Case map', []);
  const map = await repo.readMap(mapPath);
  const first = await repo.createNote('Apple', 'gpt-6-luna', map, mapPath, 'workspace');
  const second = await repo.createNote('apple', 'gpt-6-luna', map, mapPath, 'workspace');
  assert.notEqual(first.path.toLowerCase(), second.path.toLowerCase());
  assert.match(second.path, / 2\.md$/);
  assert.ok(app.vault.getAbstractFileByPath(first.path));
  assert.equal(first.path.endsWith('/Apple.md'), true);
});

integrationTest('topic remembers its content template and format issues in frontmatter', async () => {
  const { repo, app } = fixture('en');
  const map = { id: 'm', title: 'M', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = 'Agent Workspace/Topics/M/Map.md';
  await repo.ensureTopicFolders('Agent Workspace/Topics/M'); await app.vault.create(mapPath, core.serializeMap(map));
  const node = await repo.createNote('T', 'model-a', map, mapPath, 'workspace');
  assert.equal((await repo.readNote(node.path)).detailTemplateId, undefined);
  assert.deepEqual(plain((await repo.readNote(node.path)).detailFormatIssues), []);
  await repo.updateNote(node.path, { detailTemplateId: 't1', detailFormatIssues: ['Examples: need 3, got 2'] });
  let note = await repo.readNote(node.path);
  assert.equal(note.detailTemplateId, 't1'); assert.deepEqual(plain(note.detailFormatIssues), ['Examples: need 3, got 2']);
  const raw = await app.vault.read(app.vault.getAbstractFileByPath(node.path));
  assert.match(raw, /detail-template: "?t1"?/);
  await repo.updateNote(node.path, { detailTemplateId: '', detailFormatIssues: [] });
  note = await repo.readNote(node.path);
  assert.equal(note.detailTemplateId, undefined); assert.deepEqual(plain(note.detailFormatIssues), []);
  assert.doesNotMatch(await app.vault.read(app.vault.getAbstractFileByPath(node.path)), /detail-format-issues|detail-template/);
});
const { failureReason, LAST_ERROR_LIMIT } = load('repository.ts', { obsidian });
test('failureReason keeps the raw message, collapses whitespace and cuts it to the limit', () => {
  assert.equal(failureReason(new Error("You've hit\n your   usage limit ")), "You've hit your usage limit");
  assert.equal(failureReason('plain'), 'plain');
  const long = failureReason(new Error('y'.repeat(LAST_ERROR_LIMIT + 50)));
  assert.equal([...long].length, LAST_ERROR_LIMIT);
  assert.ok(long.endsWith('…'));
});
integrationTest('last-error is written for a failed topic, cleared by a completed write and kept by a status-only restore', async () => {
  const { repo, app } = fixture('en');
  const map = { id: 'm', title: 'M', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = 'Agent Workspace/Topics/M/Map.md';
  await repo.ensureTopicFolders('Agent Workspace/Topics/M'); await app.vault.create(mapPath, core.serializeMap(map));
  const node = await repo.createNote('T', 'model-a', map, mapPath, 'workspace');
  const raw = async () => app.vault.read(app.vault.getAbstractFileByPath(node.path));
  assert.equal((await repo.readNote(node.path)).lastError, '');
  await repo.updateNote(node.path, { status: 'error', lastError: "You've hit your usage limit" });
  assert.equal((await repo.readNote(node.path)).lastError, "You've hit your usage limit");
  assert.match(await raw(), /last-error:/);
  await repo.updateNote(node.path, { status: 'running' });
  await repo.updateNote(node.path, { status: 'error' });
  assert.equal((await repo.readNote(node.path)).lastError, "You've hit your usage limit", 'a status-only write (stopped run restoring its status) leaves the reason');
  await repo.updateNote(node.path, { status: 'completed' });
  assert.equal((await repo.readNote(node.path)).lastError, '');
  assert.doesNotMatch(await raw(), /last-error/, 'success clears the stored reason');
  await repo.updateNote(node.path, { status: 'error', lastError: 'again' });
  await repo.updateNote(node.path, { lastError: '' });
  assert.doesNotMatch(await raw(), /last-error/, 'an empty reason writes no key');
});
integrationTest('topic remembers its tone override in frontmatter `tone`; clearing removes it', async () => {
  const { repo, app } = fixture('en');
  const map = { id: 'm', title: 'M', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = 'Agent Workspace/Topics/M/Map.md';
  await repo.ensureTopicFolders('Agent Workspace/Topics/M'); await app.vault.create(mapPath, core.serializeMap(map));
  const node = await repo.createNote('T', 'model-a', map, mapPath, 'workspace');
  assert.equal((await repo.readNote(node.path)).toneId, undefined);
  await repo.updateNote(node.path, { toneId: 'magazine' });
  assert.equal((await repo.readNote(node.path)).toneId, 'magazine');
  assert.match(await app.vault.read(app.vault.getAbstractFileByPath(node.path)), /tone: "?magazine"?/);
  await repo.updateNote(node.path, { toneId: '' });
  assert.equal((await repo.readNote(node.path)).toneId, undefined);
  assert.doesNotMatch(await app.vault.read(app.vault.getAbstractFileByPath(node.path)), /^tone:/m);
});
integrationTest('visual reference without a related paragraph goes before the sources section (zh and en)', async () => {
  const { canonicalDetail } = load('ai/result-utils.ts');
  const reference = '**Pic**\n\n![Pic](https://x/y.png)\n\nSource: https://x';
  {
    const { repo } = fixture('en'); const n = await topicNote(repo, 'English picture');
    await repo.updateNote(n.path, { detail: canonicalDetail('### Key knowledge\n\nK', 'en'), visualReferences: reference });
    const detail = (await repo.readNote(n.path)).detail;
    assert.ok(detail.indexOf('**Pic**') > detail.indexOf('\nK\n'), 'after the knowledge text');
    assert.ok(detail.indexOf('**Pic**') < detail.indexOf('### Evidence and sources'), 'before the sources section');
  }
  {
    const { repo } = fixture(); const n = await topicNote(repo, '中文圖片');
    await repo.updateNote(n.path, { detail: canonicalDetail('### 關鍵知識\n\nK', 'zh-TW'), visualReferences: reference });
    const detail = (await repo.readNote(n.path)).detail;
    assert.ok(detail.indexOf('**Pic**') > detail.indexOf('\nK\n'));
    assert.ok(detail.indexOf('**Pic**') < detail.indexOf('### 證據與來源'));
  }
  {
    const { repo } = fixture('en'); const n = await topicNote(repo, 'No sources picture');
    const template = { id: 't1', name: 'T', sections: [{ id: 'a', name: 'A', description: '', role: 'none', aliases: [] }, { id: 'b', name: 'B', description: '', role: 'log', aliases: [] }] };
    await repo.updateNote(n.path, { detail: canonicalDetail('### A\n\nK', 'en', template), visualReferences: reference }, { detailTemplate: template });
    const detail = (await repo.readNote(n.path)).detail;
    assert.ok(detail.indexOf('**Pic**') > detail.indexOf('### B'), 'at the end');
    assert.match(detail, /Source: https:\/\/x$/);
  }
});
integrationTest('visual reference placement: a sources alias equal to another section name is not the sources heading', async () => {
  const { canonicalDetail } = load('ai/result-utils.ts');
  const reference = '**Pic**\n\n![Pic](https://x/y.png)\n\nSource: https://x';
  const { repo } = fixture('en'); const n = await topicNote(repo, 'Alias picture');
  const template = { id: 't1', name: 'T', sections: [
    { id: 'a', name: 'A', description: '', role: 'none', aliases: [] },
    { id: 'n', name: 'Notes', description: '', role: 'none', aliases: [] },
    { id: 'r', name: 'Refs', description: '', role: 'sources', aliases: ['Notes'] }] };
  await repo.updateNote(n.path, { detail: canonicalDetail('### A\n\nK\n\n### Notes\n\nN\n\n### Refs\n\nE', 'en', template), visualReferences: reference }, { detailTemplate: template });
  const detail = (await repo.readNote(n.path)).detail;
  assert.ok(detail.indexOf('**Pic**') > detail.indexOf('\nN\n'), 'after the Notes section text');
  assert.ok(detail.indexOf('**Pic**') < detail.indexOf('### Refs'), 'before the sources section');
});
integrationTest('legacy Visual References section moves into Detail before the Standard sources heading on rebuild (zh and en)', async () => {
  const { canonicalDetail } = load('ai/result-utils.ts');
  const legacy = '\n\n## Visual References\n\n**Pic**\n\n![Pic](https://x/y.png)\n\nSource: https://x\n';
  for (const [language, knowledge, sources] of [['zh-TW', '關鍵知識', '證據與來源'], ['en', 'Key knowledge', 'Evidence and sources']]) {
    const { repo, contents } = fixture(language); const n = await topicNote(repo, `Legacy ${language}`);
    await repo.updateNote(n.path, { detail: canonicalDetail(`### ${knowledge}\n\nK`, language) });
    contents.set(n.path, `${contents.get(n.path).trimEnd()}${legacy}`);
    await repo.rebuildDerivedData();
    const raw = contents.get(n.path);
    assert.doesNotMatch(raw, /## Visual References/, language);
    const detail = (await repo.readNote(n.path)).detail;
    const image = detail.indexOf('![Pic](https://x/y.png)');
    assert.ok(image > detail.indexOf(`### ${knowledge}\n\nK`), `${language}: after the key knowledge text\n${detail}`);
    assert.ok(image < detail.indexOf(`### ${sources}`), `${language}: before the sources heading\n${detail}`);
    assert.match(detail, new RegExp(`### ${knowledge}\\n\\nK\\n\\n\\*\\*Pic\\*\\*\\n\\n!\\[Pic\\]\\(https://x/y\\.png\\)\\n\\nSource: https://x\\n\\n### ${sources}`), language);
  }
});

// Merge topics: structure merge with a real repository fixture.
const mergeHarness = async ({ details = ['Alpha detail', '', 'Gamma detail'], parentModel = 'a', parentSource = 'workspace', shim = obsidian, origin, globals = {} } = {}) => {
  const {repo,app,contents} = fixture(), path = await repo.createMap('Merge ops', []), mapDoc = await repo.readMap(path);
  const names = ['Alpha', 'Beta', 'Gamma'], kids = {};
  const parent = await repo.createNote('Parent',parentModel,mapDoc,path,parentSource); mapDoc.nodes.push(parent);
  const sources = [];
  for (const [index, name] of names.entries()) {
    const n = await repo.createNote(name,'a',mapDoc,path,'workspace',{detail: details[index]}); n.parentId = parent.id; n.x = 400; n.y = 300 - index * 100; mapDoc.nodes.push(n); sources.push(n);
    if (origin && index === 0) await repo.updateNote(n.path, { thinkingOrigin: origin });
  }
  const kid = await repo.createNote('Alpha child','a',mapDoc,path,'workspace'); kid.parentId = sources[0].id; mapDoc.nodes.push(kid);
  await repo.saveMap(path, mapDoc);
  let pending=Promise.resolve();
  const plugin={repo,settings:{...DEFAULT_SETTINGS},rebuildDerivedData:()=>repo.rebuildDerivedData(),mutate(work){pending=pending.then(work);return pending},running:new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {},quickExpandPending:new Set(),activeTasks:new Map(),expansionBatches:new Map()};
  const {VisualAgentMapView}=load('main.ts',{obsidian:shim},{requestAnimationFrame:run=>{run();return 1},cancelAnimationFrame(){},...globals}); const view=new VisualAgentMapView({app},plugin);
  view.path=path;view.map=mapDoc;view.render=()=>{};view.focusNode=()=>{};view.drawEdges=()=>{};view.updateHistoryButtons=()=>{};
  await view.hydrate();
  const fm = file => { const text = contents.get(file) ?? ''; const get = key => text.match(new RegExp('^' + key + ': (.*)$', 'm'))?.[1]?.trim(); return { state: get('topic-state'), mapId: get('agent-map-id'), status: get('status') }; };
  const shape = async () => { const m = await repo.readMap(path); return { nodes: m.nodes.map(n => [n.id, n.path, n.parentId]), files: Object.fromEntries(m.nodes.map(n => [n.path, fm(n.path)])), unassigned: (await repo.collectionFiles(path,'Unassigned')).map(f => f.path).sort() }; };
  const merge = async title => { view.multiSelected = new Set(sources.map(n => n.id)); const sel = view.mergeCheck(); assert.equal(sel.ok, true); await view.mergeSelected(title, { path, mapId: mapDoc.id, sources: sel.sources.map(n => ({ id: n.id, path: n.path })) }); };
  return {repo,app,contents,path,mapDoc,parent,sources,kid,view,plugin,fm,shape,merge};
};
integrationTest('merging sibling topics builds the new note, moves sources to Unassigned and re-parents their children', async () => {
  const h = await mergeHarness(); const before = await h.shape(); const historyBefore = h.view.history.canUndo;
  const sourceIds = h.sources.map(n => n.id), sourcePaths = h.sources.map(n => n.path);
  await h.merge('Merged'); 
  const m = await h.repo.readMap(h.path); const merged = m.nodes.find(n => !sourceIds.includes(n.id) && n.id !== h.parent.id && n.id !== h.kid.id);
  assert.ok(merged); assert.equal(merged.parentId, h.parent.id); assert.ok(merged.path.includes('/Notes/'));
  // Reading order is Gamma (y=100), Beta (200), Alpha (300): the new card sits where Gamma was.
  assert.deepEqual([merged.x, merged.y], [400, 100]); assert.equal(m.nodes.findIndex(n => n.id === merged.id), 1);
  assert.equal(m.nodes.some(n => sourceIds.includes(n.id)), false);
  assert.equal(m.nodes.find(n => n.id === h.kid.id).parentId, merged.id);
  const note = await h.repo.readNote(merged.path);
  assert.equal(note.detail.trim(), '### Gamma\n\nGamma detail\n\n### Alpha\n\nAlpha detail'); assert.equal(h.fm(merged.path).status, 'completed');
  const unassigned = (await h.repo.collectionFiles(h.path,'Unassigned')).map(f => f.path);
  assert.equal(unassigned.length, 3);
  for (const file of unassigned) { assert.equal(h.fm(file).state, 'unassigned'); }
  assert.equal(note.sourcePaths.length, 3); assert.deepEqual([...note.sourcePaths].sort(), unassigned.slice().sort());
  assert.equal(sourcePaths.some(p => h.app.vault.getAbstractFileByPath(p)), false);
  assert.equal(h.view.selected, merged.id); assert.equal(h.view.integrationMode, false);
  assert.equal(h.view.history.undoEntry.label, 'Merge topics');
  assert.notEqual(historyBefore, undefined); assert.ok(before.nodes.length === 5);
});
integrationTest('merging empty topics gives an idea note with an empty Detail', async () => {
  const h = await mergeHarness({ details: ['', '', ''] });
  await h.merge('Blank merge');
  const merged = (await h.repo.readMap(h.path)).nodes.find(n => n.path.includes('Blank merge'));
  assert.equal(h.fm(merged.path).status, 'idea'); assert.equal((await h.repo.readNote(merged.path)).detail.trim(), '');
});
integrationTest('one undo restores the sources exactly; redo and a second undo repeat it', async () => {
  const h = await mergeHarness(); const original = await h.shape();
  await h.merge('Merged'); const merged = await h.shape();
  assert.notDeepEqual(merged.nodes, original.nodes);
  await h.view.travel(false); const undone = await h.shape();
  assert.deepEqual(undone.nodes, original.nodes, 'ids, original full paths and parents are back');
  for (const source of h.sources) assert.deepEqual(h.fm(source.path), { ...h.fm(source.path), state: 'active', mapId: h.mapDoc.id });
  assert.equal(undone.unassigned.length, 1, 'only the merged note waits in Unassigned');
  assert.equal(h.fm(undone.unassigned[0]).state, 'unassigned');
  assert.equal((await h.repo.readMap(h.path)).nodes.find(n => n.id === h.kid.id).parentId, h.sources[0].id);
  await h.view.travel(true); assert.deepEqual(await h.shape(), merged);
  await h.view.travel(false); assert.deepEqual(await h.shape(), undone);
  await h.view.travel(true); assert.deepEqual(await h.shape(), merged);
  assert.equal(h.view.history.canUndo, true); h.view.history.undo(); assert.equal(h.view.history.canUndo, false, 'the merge was exactly one history entry');
});
integrationTest('a failure while moving a source rolls the files, lifecycle and map back and parks the new note', async () => {
  const h = await mergeHarness(); const original = await h.shape(); const originalMap = JSON.stringify((await h.repo.readMap(h.path)).nodes);
  const move = h.repo.moveUnique.bind(h.repo); let calls = 0;
  h.repo.moveUnique = async (...args) => { calls++; if (calls === 2) throw new Error('disk full'); return move(...args); };
  await assert.rejects(() => h.merge('Merged'), /disk full/);
  h.repo.moveUnique = move;
  const after = await h.shape();
  assert.deepEqual(JSON.stringify((await h.repo.readMap(h.path)).nodes), originalMap);
  for (const source of h.sources) { assert.ok(h.app.vault.getAbstractFileByPath(source.path)); assert.equal(h.fm(source.path).state, 'active'); assert.equal(h.fm(source.path).mapId, h.mapDoc.id); }
  assert.equal(after.unassigned.length, 1, 'the new note is parked, not deleted');
  assert.equal(h.fm(after.unassigned[0]).state, 'unassigned');
  assert.equal(h.view.history.canUndo, false, 'no history entry after a failed merge');
  assert.deepEqual(after.nodes, original.nodes);
});
integrationTest('a failed saveMap during a merge also restores everything', async () => {
  const h = await mergeHarness(); const original = await h.shape();
  const save = h.repo.saveMap.bind(h.repo); let calls = 0;
  h.repo.saveMap = async (...args) => { calls++; if (calls === 1) throw new Error('map locked'); return save(...args); };
  await assert.rejects(() => h.merge('Merged'), /map locked/);
  h.repo.saveMap = save;
  const after = await h.shape(); assert.deepEqual(after.nodes, original.nodes);
  for (const source of h.sources) assert.equal(h.fm(source.path).state, 'active');
  assert.equal(after.unassigned.length, 1); assert.equal(h.view.history.canUndo, false);
});
integrationTest('merge is refused while a selected topic has an AI task running, and writes nothing', async () => {
  const h = await mergeHarness(); const original = await h.shape();
  h.plugin.running.add(h.sources[1].path);
  h.view.multiSelected = new Set(h.sources.map(n => n.id));
  assert.deepEqual(plain(h.view.mergeCheck()), { ok: false, reason: 'ui.merge_busy' });
  await h.view.mergeSelected('Merged', { path: h.path, mapId: h.mapDoc.id, sources: h.sources.map(n => ({ id: n.id, path: n.path })) });
  assert.deepEqual(await h.shape(), original); assert.equal(h.view.history.canUndo, false);
});
// Merge topics, AI merge: a stubbed model, a real repository, the real view code.
const aiMergeHarness = async (options = {}) => {
  const dom = require('../support-dom.cjs'), notices = [];
  const shim = { ...obsidian, Notice: dom.makeNotice(notices), Modal: dom.makeModal() };
  const h = await mergeHarness({ shim, globals: { createFragment: dom.createFragment }, ...options });
  h.repo.settings.cliModel = 'claude:sonnet'; h.plugin.settings.cliModel = 'claude:sonnet';
  let queue = Promise.resolve(); h.plugin.mutate = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  h.shim = shim; h.notices = notices; h.asks = []; h.usage = []; h.started = 0; h.failures = [];
  h.answer = async () => ({ summary: 'Merged one-liner', detail: '### Facts\n\nAlpha detail and Gamma detail', visualReferences: [], formatIssues: [], suggestions: [] });
  h.plugin.askModel = async (context, model, reasoning, signal) => { h.asks.push({ context, model, reasoning }); return h.answer(signal, context); };
  h.plugin.confirmAiUsage = async (model, run) => { h.usage.push(model); if (h.decline) return false; await run(); return true; };
  h.plugin.recordFailure = (label, error) => { h.failures.push(label); return `${label}: ${error.message}`; };
  h.files = () => [...h.contents.entries()].sort(([a], [b]) => a.localeCompare(b));
  h.snapshot = () => ({ id: h.mapDoc.id, parentId: h.parent.id, path: h.path, mapId: h.mapDoc.id, sources: h.sources.map(n => ({ id: n.id, path: n.path })) });
  h.begin = async (title = 'AI merged', signal = new AbortController().signal) => {
    h.view.multiSelected = new Set(h.sources.map(n => n.id));
    const check = h.view.mergeCheck(); assert.equal(check.ok, true);
    const snapshot = { path: h.path, mapId: h.mapDoc.id, parentId: check.parentId, sources: check.sources.map(n => ({ id: n.id, path: n.path })) };
    const began = await h.view.startMergeDraft(title, snapshot, () => { h.started++; }, signal);
    return { began, task: h.view.mergeTasks.get(h.path), snapshot };
  };
  h.untilSettled = async task => { await task.run; };
  // The merge is applied by the run itself (no draft step): these read what it left behind.
  h.mergedNode = async title => (await h.repo.readMap(h.path)).nodes.find(n => n.path.includes(title));
  h.undoNotice = () => shim.Notice.all.filter(n => n.actions.some(a => a.text === 'Undo')).at(-1);
  return h;
};
const abortable = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
integrationTest('AI merge: usage notice first, a locked "merging" task while the model runs, then the result is applied with no draft step (one history step, one Notice with Undo)', async () => {
  const h = await aiMergeHarness(); const original = await h.shape(); const files = h.files();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const answer = h.answer; h.answer = async (...args) => { await gate; return answer(...args); };
  const { began, task: live } = await h.begin();
  assert.equal(began, true);
  assert.equal(h.usage.length, 1); assert.equal(h.started, 1);
  assert.equal(live.state, 'running', 'running (with Stop) before the model answers');
  for (const source of h.sources) assert.equal(h.view.isMerging(source.id), true, 'every selected card is merging');
  for (const other of [h.parent, h.kid]) assert.equal(h.view.isMerging(other.id), false, 'other cards are not');
  assert.deepEqual(h.files(), files, 'nothing is written while the model runs'); assert.deepEqual(await h.shape(), original);
  release(); await h.untilSettled(live);
  assert.equal(h.view.mergeTasks.size, 0, 'the task is gone once the result is written');
  for (const source of h.sources) assert.equal(h.view.isMerging(source.id), false);
  const merged = await h.mergedNode('AI merged'); assert.ok(merged, 'the AI result was applied without any review');
  assert.equal((await h.repo.readNote(merged.path)).summary, 'Merged one-liner');
  assert.equal(h.view.history.undoEntry.label, 'Merge topics');
  assert.deepEqual(h.notices.filter(m => /Merged into/.test(m)), ['Merged into “AI merged”. You can undo.']);
  assert.equal(h.notices.some(m => /draft/i.test(m)), false, 'no “merge draft” Notice any more');
  assert.equal(h.view.reviewMergeDraft, undefined, 'no review step exists');
  // The Notice carries an Undo button while this is the newest step; pressing it undoes the merge.
  const notice = h.undoNotice(); assert.ok(notice);
  notice.actions.find(a => a.text === 'Undo').click(); await h.plugin.mutate(async () => {});
  assert.deepEqual((await h.shape()).nodes, original.nodes); assert.equal(h.view.history.canUndo, false);
});
integrationTest('AI merge: the Notice has no working Undo once another step came after the merge', async () => {
  const h = await aiMergeHarness(); const { task } = await h.begin(); await h.untilSettled(task);
  const merged = await h.mergedNode('AI merged'); const done = await h.shape();
  h.view.history.push({ label: 'Later step', undo: async () => {}, redo: async () => {} });
  h.undoNotice().actions.find(a => a.text === 'Undo').click(); await h.plugin.mutate(async () => {});
  assert.deepEqual(await h.shape(), done, 'a later step is not undone by the stale button'); assert.equal(h.view.history.undoEntry.label, 'Later step'); assert.ok(merged);
});
integrationTest('AI merge: the model sees the sources but no Thinking Origin, with the merge task and local synthesize settings', async () => {
  const h = await aiMergeHarness({ origin: 'SECRET-ORIGIN-TEXT' });
  // Integration still sends the Origin (the option defaults on).
  const group = await h.view.topicReferenceGroup(h.sources, 'strong');
  assert.match(JSON.stringify(group.documents), /SECRET-ORIGIN-TEXT/);
  assert.deepEqual(await h.view.topicReferenceGroup(h.sources, 'strong', { origin: true }), group);
  const { task } = await h.begin(); await h.untilSettled(task);
  const { context } = h.asks[0]; assert.equal(h.asks.length, 1);
  const text = JSON.stringify(context.referenceGroups);
  assert.match(text, /Alpha detail/); assert.match(text, /Gamma detail/); assert.doesNotMatch(text, /SECRET-ORIGIN-TEXT/);
  assert.equal(context.referenceGroups.length, 1); assert.equal(context.mode, 'merge'); assert.equal(context.researchMode, 'local'); assert.equal(context.visualMode, 'off'); assert.equal(context.referenceDelivery, 'direct');
  assert.equal(context.task, load('experiences/visual-map/steps/fragments.ts').mergeGoalTask(h.plugin.settings.language));
});
integrationTest('AI merge: the result is written through the structure merge in one history step (undo, redo, undo)', async () => {
  const h = await aiMergeHarness(); const original = await h.shape();
  const { task } = await h.begin('Merged by AI'); await h.untilSettled(task);
  const m = await h.repo.readMap(h.path); const sourceIds = h.sources.map(n => n.id);
  const merged = m.nodes.find(n => n.path.includes('Merged by AI')); assert.ok(merged);
  assert.equal(m.nodes.some(n => sourceIds.includes(n.id)), false); assert.equal(merged.parentId, h.parent.id);
  assert.equal(m.nodes.find(n => n.id === h.kid.id).parentId, merged.id);
  const note = await h.repo.readNote(merged.path);
  assert.equal(note.summary, 'Merged one-liner'); assert.match(note.detail, /Alpha detail and Gamma detail/); assert.equal(h.fm(merged.path).status, 'completed');
  assert.equal(note.modelSource, 'inherited'); assert.equal(note.model, 'claude:sonnet');
  const unassigned = (await h.repo.collectionFiles(h.path, 'Unassigned')).map(f => f.path);
  assert.equal(unassigned.length, 3); assert.deepEqual([...note.sourcePaths].sort(), unassigned.slice().sort());
  for (const file of unassigned) assert.equal(h.fm(file).state, 'unassigned');
  assert.equal(h.view.mergeTasks.size, 0, 'the task ends with the write'); assert.equal(h.view.history.undoEntry.label, 'Merge topics');
  const done = await h.shape();
  await h.view.travel(false); assert.deepEqual((await h.shape()).nodes, original.nodes);
  await h.view.travel(true); assert.deepEqual(await h.shape(), done);
  await h.view.travel(false); assert.deepEqual((await h.shape()).nodes, original.nodes);
  h.view.history.undo(); assert.equal(h.view.history.canUndo, false, 'exactly one history entry');
});
integrationTest('AI merge: the AI names the topic in the same single request; that name is what the note and card get', async () => {
  const h = await aiMergeHarness();
  h.answer = async () => ({ summary: 'S', detail: '### Facts\n\nAlpha detail', visualReferences: [], formatIssues: [], suggestions: [{ title: 'AI chosen name', task: '', contribution: '', parentTitle: '' }] });
  const { task } = await h.begin('Fallback title'); await h.untilSettled(task);
  assert.equal(h.asks.length, 1, 'no extra AI call for the name'); assert.notEqual(h.asks[0].context.title, 'Fallback title');
  assert.deepEqual(h.notices.filter(m => /Merged into/.test(m)), ['Merged into “AI chosen name”. You can undo.']);
  const m = await h.repo.readMap(h.path); const merged = m.nodes.find(n => n.path.includes('AI chosen name')); assert.ok(merged);
  assert.equal(m.nodes.some(n => n.path.includes('Fallback title')), false);
  assert.equal((await h.repo.readNote(merged.path)).title, 'AI chosen name');
  assert.match(h.contents.get(merged.path), /^# AI chosen name$/m);
});
// Merge content check: a program compares numbers, links and embeds with the sources; one repair request, then apply with a warning.
const checkedDetails = ['Alpha 42 units, see https://example.org/a', '', 'Gamma 7 units, see [[Notes/Other]]'];
const good = { summary: 'Merged one-liner', detail: '### Facts\n\nAlpha 42 units https://example.org/a and Gamma 7 units [[Notes/Other]]', visualReferences: [], formatIssues: [], suggestions: [] };
const lossy = { ...good, detail: '### Facts\n\nAlpha units and Gamma 7 units [[Notes/Other]] plus 99 invented' };
const warnings = h => h.notices.filter(m => /may be missing or changed/.test(m));
integrationTest('AI merge check: a faithful result is applied with one request and no warning', async () => {
  const h = await aiMergeHarness({ details: checkedDetails }); h.answer = async () => good;
  const { task } = await h.begin(); await h.untilSettled(task);
  assert.equal(h.asks.length, 1); assert.deepEqual(warnings(h), []); assert.ok(await h.mergedNode('AI merged'));
  assert.deepEqual(h.failures, []);
});
integrationTest('AI merge check: the log section of a custom template (renamed) is exempt, so a dated log line is no false positive', async () => {
  const h = await aiMergeHarness({ details: ['Alpha 42 units\n\n### 變更歷史\n- 2026-10-01：建立', '', 'Gamma 7 units'] });
  const original = h.view.mapDetailTemplate.bind(h.view);
  h.view.mapDetailTemplate = (...args) => { const template = original(...args); return { ...template, sections: template.sections.map(section => section.role === 'log' ? { ...section, name: '變更歷史', aliases: [] } : section) }; };
  h.answer = async () => ({ ...good, detail: 'Alpha 42 units Gamma 7 units\n\n### 變更歷史\n- 2026-10-20：合併 2 個議題' });
  const { task } = await h.begin(); await h.untilSettled(task);
  assert.equal(h.asks.length, 1); assert.deepEqual(warnings(h), []); assert.ok(await h.mergedNode('AI merged'));
});
integrationTest('AI merge check: a dropped number or link and an invented number trigger one repair request, which then applies cleanly', async () => {
  const h = await aiMergeHarness({ details: checkedDetails }); let calls = 0;
  h.answer = async () => (++calls === 1 ? lossy : good);
  const { task } = await h.begin(); await h.untilSettled(task);
  assert.equal(h.asks.length, 2, 'the merge plus exactly one repair');
  const repair = h.asks[1].context;
  assert.equal(repair.mode, 'merge'); assert.equal(repair.researchMode, 'local'); assert.equal(repair.visualMode, 'off'); assert.equal(repair.detail, lossy.detail); assert.equal(repair.referenceGroups.length, 1);
  assert.match(repair.task, /- 42\n/); assert.match(repair.task, /- https:\/\/example\.org\/a\n/); assert.match(repair.task, /- 99\n/); assert.doesNotMatch(repair.task, /- 7\n/);
  assert.deepEqual(warnings(h), []); assert.deepEqual(h.failures, []);
  const merged = await h.mergedNode('AI merged'); assert.match((await h.repo.readNote(merged.path)).detail, /Alpha 42 units/);
  assert.equal(h.view.history.undoEntry.label, 'Merge topics'); assert.deepEqual(h.notices.filter(m => /Merged into/.test(m)).length, 1);
});
// ---- Plan E W2: the merge request shows stage and unsaved preview under its own task key ----
const mergeProgress = async (options, ask) => {
  const h = await aiMergeHarness(options);
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  const store = new ResearchProgressStore(); h.plugin.researchProgress = store; h.store = store; h.key = `vam-task:merge:${h.path}`; h.atWrite = []; h.observers = [];
  const realMutate = h.plugin.mutate; h.plugin.mutate = work => { h.atWrite.push(store.get(h.key)); return realMutate(work); };
  h.plugin.askModel = async (context, model, reasoning, signal, onExchange, onAccepted, onWeb, observer) => { h.asks.push({ context, model, reasoning }); h.observers.push(observer); return ask({ h, signal, observer, store, call: h.asks.length }); };
  return h;
};
integrationTest('W2b merge: the request is observed, shows stage and preview under the merge key, writes nothing before success and ends the entry before the write', async () => {
  const seen = [];
  const h = await mergeProgress({}, async ({ h: harness, observer, store }) => {
    observer.onAttempt('m1', 1); observer.onStage('m1', 'writing'); observer.onPreview('m1', { summary: 'Unsaved merge summary' });
    seen.push({ entry: JSON.parse(JSON.stringify(store.get(harness.key))), files: harness.files() });
    return { summary: 'Merged one-liner', detail: '### Facts\n\nAlpha detail and Gamma detail', visualReferences: [], formatIssues: [], suggestions: [] };
  });
  const files = h.files();
  const { task } = await h.begin(); await h.untilSettled(task);
  assert.equal(h.asks.length, 1); assert.ok(h.observers[0], 'the merge request is observed');
  assert.equal(seen[0].entry.stage, 'writing'); assert.equal(seen[0].entry.preview.summary, 'Unsaved merge summary'); assert.deepEqual(seen[0].files, files, 'nothing is written while the preview shows');
  assert.equal(h.store.get(h.key), undefined, 'the entry is gone'); assert.equal(h.atWrite.length > 0 && h.atWrite.every(entry => entry === undefined), true, 'ended before the write');
  assert.ok(await h.mergedNode('AI merged'));
});
integrationTest('W2b merge: the repair request is a new attempt of the same entry (the first preview is gone) and the repair result is still used exactly as before', async () => {
  const states = [];
  const h = await mergeProgress({ details: checkedDetails }, async ({ h: harness, observer, store, call }) => {
    if (call === 1) { observer.onAttempt('m1', 1); observer.onPreview('m1', { summary: 'First draft preview' }); states.push(JSON.parse(JSON.stringify(store.get(harness.key)))); return lossy; }
    observer.onAttempt('m2', 2); states.push(JSON.parse(JSON.stringify(store.get(harness.key)))); return good;
  });
  const { task } = await h.begin(); await h.untilSettled(task);
  assert.equal(h.asks.length, 2, 'one merge and one repair, as before'); assert.ok(h.observers[0] && h.observers[1], 'both requests are observed');
  assert.equal(states[0].preview.summary, 'First draft preview');
  assert.equal(states[1].preview, undefined, 'the repair attempt starts clean'); assert.equal(states[1].stage, 'waiting');
  assert.equal(h.store.get(h.key), undefined);
  const merged = await h.mergedNode('AI merged'); assert.match((await h.repo.readNote(merged.path)).detail, /Alpha 42 units/);
});
integrationTest('W2b merge: Stop while a preview shows clears it and writes nothing; a failed request does the same', async () => {
  for (const scenario of ['stop', 'fail']) {
    const h = await mergeProgress({}, async ({ h: harness, observer }) => {
      observer.onAttempt('m1', 1); observer.onPreview('m1', { summary: 'Unsaved' });
      if (scenario === 'stop') { harness.view.stopMergeTask(harness.view.mergeTasks.get(harness.path)); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
      throw new Error('provider down');
    });
    const files = h.files(); const original = await h.shape();
    const { task } = await h.begin(); if (task) await h.untilSettled(task);
    assert.equal(h.store.get(h.key), undefined, `${scenario}: cleared`); assert.deepEqual(h.files(), files, `${scenario}: nothing written`); assert.deepEqual(await h.shape(), original);
  }
});
integrationTest('AI merge check: still failing after the repair applies anyway, with a warning Notice that has Undo and the tokens in the failure log', async () => {
  const h = await aiMergeHarness({ details: checkedDetails }); const original = await h.shape();
  h.answer = async () => lossy;
  const { task } = await h.begin(); await h.untilSettled(task);
  assert.equal(h.asks.length, 2, 'never a second repair');
  assert.ok(await h.mergedNode('AI merged'), 'not blocked: the merge is applied');
  assert.deepEqual(warnings(h), ['Merged into “AI merged”. You can undo. 3 item(s) of source content may be missing or changed in the merge.']);
  assert.deepEqual(h.failures, ['AI merge check: source content not preserved']);
  const notice = h.undoNotice(); assert.ok(notice, 'the warning Notice carries Undo');
  notice.actions.find(a => a.text === 'Undo').click(); await h.plugin.mutate(async () => {});
  assert.deepEqual((await h.shape()).nodes, original.nodes); assert.equal(h.view.history.canUndo, false);
});
integrationTest('AI merge check: a repair that fails or makes it worse keeps the first result and still applies', async () => {
  const worse = { ...lossy, detail: '### Facts\n\n1234 5678 only' };
  for (const second of ['throw', worse]) {
    const h = await aiMergeHarness({ details: checkedDetails }); let calls = 0;
    h.answer = async () => { if (++calls === 1) return lossy; if (second === 'throw') throw new Error('provider down'); return second; };
    const { task } = await h.begin(); await h.untilSettled(task);
    assert.equal(h.asks.length, 2); const merged = await h.mergedNode('AI merged'); assert.ok(merged);
    assert.match((await h.repo.readNote(merged.path)).detail, /99 invented/, 'the first result, not the worse repair');
    assert.equal(warnings(h).length, 1);
  }
});
integrationTest('AI merge check: Stop, closing the view or a source edit during the repair writes nothing', async () => {
  for (const scenario of ['stop', 'close', 'stale']) {
    const h = await aiMergeHarness({ details: checkedDetails }); const files = h.files(); const original = await h.shape(); let calls = 0, entered;
    const reached = new Promise(resolve => { entered = resolve; });
    h.answer = (signal) => {
      if (++calls === 1) return Promise.resolve(lossy);
      entered();
      if (scenario === 'stale') return h.repo.updateNote(h.sources[0].path, { detail: 'Changed during the repair' }).then(() => good);
      return abortable(signal);
    };
    const { task } = await h.begin(); await reached;
    if (scenario === 'stop') h.view.stopMergeTask(task);
    if (scenario === 'close') { h.view.closed = true; for (const t of h.view.mergeTasks.values()) t.controller.abort(); }
    await h.untilSettled(task);
    assert.equal(h.view.mergeTasks.size, 0, scenario); assert.equal(h.view.history.canUndo, false, scenario); assert.deepEqual((await h.shape()).nodes, original.nodes, scenario);
    if (scenario === 'stale') { assert.deepEqual(h.notices.filter(m => /nothing was merged/.test(m)), ['A source topic changed or left the map, so nothing was merged']); assert.notDeepEqual(h.files(), files); }
    else { assert.deepEqual(h.files(), files, scenario); assert.equal(h.notices.length, 0, scenario); }
    assert.equal(h.asks.length, 2, scenario);
  }
});
integrationTest('AI merge check, parent mode: the warning path applies directly and Undo restores the parent verbatim', async () => {
  const h = await aiMergeHarness({ details: checkedDetails }); await parentOf(h);
  const text = h.contents.get(h.parent.path); const original = await h.shape();
  h.answer = async () => ({ ...lossy, suggestions: [{ title: 'Parent', task: '', contribution: '', parentTitle: '' }] });
  const { task } = await parentBegin(h, 'Parent'); await h.untilSettled(task);
  assert.equal(h.asks.length, 2); assert.equal(warnings(h).length, 1); assert.match((await h.repo.readNote(h.parent.path)).detail, /99 invented/);
  await h.view.travel(false); assert.equal(h.contents.get(h.parent.path), text); assert.deepEqual(await h.shape(), original);
});
// Merge into a parent topic: the parent keeps its card; the selected direct subtopics are merged into its note.
const parentOf = async (h, withOrigin = true) => {
  await h.repo.updateNote(h.parent.path, { summary: 'Parent summary', detail: 'Parent detail', prompt: 'Parent prompt', ...(withOrigin ? { thinkingOrigin: 'PARENT-ORIGIN' } : {}) });
  h.parent.x = 100; h.parent.y = 250; await h.repo.saveMap(h.path, { ...h.mapDoc, nodes: h.mapDoc.nodes }); await h.view.hydrate();
  h.view.map = await h.repo.readMap(h.path); await h.repo.rebuildDerivedData(); await h.view.hydrate();
};
const parentSnapshot = (h, kids = [h.sources[0], h.sources[2]]) => {
  h.view.multiSelected = new Set([h.parent.id, ...kids.map(n => n.id)]);
  const check = h.view.mergeCheck(); assert.equal(check.ok, true); assert.equal(check.targetId, h.parent.id); assert.equal(check.sources[0].id, h.parent.id);
  return { path: h.path, mapId: h.mapDoc.id, parentId: check.parentId, targetId: check.targetId, sources: check.sources.map(n => ({ id: n.id, path: n.path })) };
};
const parentMerge = (h, title, kids) => h.view.mergeSelected(title, parentSnapshot(h, kids));
integrationTest('parent merge (structure): the parent keeps its card, id, path, place, Prompt and Origin; subtopics go to Unassigned and their children move up', async () => {
  const h = await mergeHarness({ origin: 'SECRET' }); await parentOf(h);
  const original = await h.shape(); const originalMap = (await h.repo.readMap(h.path)).nodes;
  const parentBefore = originalMap.find(n => n.id === h.parent.id);
  await parentMerge(h, 'Parent');
  const m = await h.repo.readMap(h.path); const parent = m.nodes.find(n => n.id === h.parent.id);
  assert.deepEqual([parent.path, parent.x, parent.y, parent.parentId, parent.collapsed], [parentBefore.path, parentBefore.x, parentBefore.y, parentBefore.parentId, parentBefore.collapsed]);
  assert.equal(m.nodes.some(n => n.id === h.sources[0].id || n.id === h.sources[2].id), false);
  assert.equal(m.nodes.find(n => n.id === h.sources[1].id).parentId, h.parent.id, 'the unselected subtopic is untouched');
  assert.equal(m.nodes.find(n => n.id === h.kid.id).parentId, h.parent.id, 'a selected subtopic’s child moves under the parent');
  const note = await h.repo.readNote(parent.path);
  assert.equal(note.detail.trim(), '### Parent\n\nParent detail\n\n### Gamma\n\nGamma detail\n\n### Alpha\n\nAlpha detail');
  assert.equal(note.summary, 'Parent summary'); assert.equal(note.prompt, 'Parent prompt'); assert.equal(note.thinkingOrigin, 'PARENT-ORIGIN'); assert.equal(note.title, 'Parent');
  const unassigned = (await h.repo.collectionFiles(h.path, 'Unassigned')).map(f => f.path);
  assert.equal(unassigned.length, 2); assert.deepEqual([...note.sourcePaths].sort(), unassigned.slice().sort());
  for (const file of unassigned) assert.equal(h.fm(file).state, 'unassigned');
  assert.equal(h.view.history.undoEntry.label, 'Merge topics'); assert.equal(h.view.selected, h.parent.id);
  assert.notDeepEqual((await h.shape()).nodes, original.nodes);
});
integrationTest('parent merge (structure): a new name changes only the title, never the path or id', async () => {
  const h = await mergeHarness(); await parentOf(h); const path = h.parent.path;
  await parentMerge(h, '  Renamed parent ');
  const parent = (await h.repo.readMap(h.path)).nodes.find(n => n.id === h.parent.id);
  assert.equal(parent.path, path); assert.equal((await h.repo.readNote(path)).title, 'Renamed parent'); assert.match(h.contents.get(path), /^# Renamed parent$/m);
});
integrationTest('parent merge: one undo restores the parent text byte for byte; redo and a second undo repeat it', async () => {
  const h = await mergeHarness(); await parentOf(h);
  const text = h.contents.get(h.parent.path); const original = await h.shape();
  await parentMerge(h, 'Renamed parent'); const merged = await h.shape(); const mergedText = h.contents.get(h.parent.path);
  assert.notEqual(mergedText, text);
  await h.view.travel(false);
  assert.equal(h.contents.get(h.parent.path), text, 'the parent file is exactly as before'); assert.deepEqual(await h.shape(), original);
  assert.equal((await h.repo.readMap(h.path)).nodes.find(n => n.id === h.kid.id).parentId, h.sources[0].id);
  for (const source of h.sources) assert.equal(h.fm(source.path).state, 'active');
  await h.view.travel(true); assert.deepEqual(await h.shape(), merged); assert.equal((await h.repo.readNote(h.parent.path)).title, 'Renamed parent');
  await h.view.travel(false); assert.equal(h.contents.get(h.parent.path), text); assert.deepEqual(await h.shape(), original);
  h.view.history.undo(); assert.equal(h.view.history.canUndo, false, 'the merge was exactly one history entry');
});
integrationTest('parent merge: undo and redo are refused, before any file moves, when the parent was edited since', async () => {
  const h = await mergeHarness(); await parentOf(h);
  await parentMerge(h, 'Parent'); const merged = await h.shape();
  await h.repo.updateNote(h.parent.path, { summary: 'Edited later' }); const editedText = h.contents.get(h.parent.path);
  await assert.rejects(() => h.view.travel(false), /merged topic was edited/);
  assert.deepEqual(await h.shape(), merged); assert.equal(h.contents.get(h.parent.path), editedText); assert.equal(h.view.history.canUndo, true, 'the entry is still undoable');
  await h.repo.updateNote(h.parent.path, { detail: 'Detail edited later' }); 
  await assert.rejects(() => h.view.travel(false), /merged topic was edited/);
  assert.deepEqual(await h.shape(), merged);
});
integrationTest('parent merge: redo is refused when the parent was edited after the undo', async () => {
  const h = await mergeHarness(); await parentOf(h);
  await parentMerge(h, 'Parent'); await h.view.travel(false); const undone = await h.shape();
  await h.repo.updateNote(h.parent.path, { summary: 'Edited after undo' });
  await assert.rejects(() => h.view.travel(true), /merged topic was edited/);
  assert.deepEqual(await h.shape(), undone); assert.equal((await h.repo.readNote(h.parent.path)).summary, 'Edited after undo');
});
integrationTest('parent merge: a failure while moving a subtopic puts the parent text, files and map back, with no history', async () => {
  const h = await mergeHarness(); await parentOf(h);
  const text = h.contents.get(h.parent.path); const original = await h.shape(); const originalMap = JSON.stringify((await h.repo.readMap(h.path)).nodes);
  const move = h.repo.moveUnique.bind(h.repo); let calls = 0;
  h.repo.moveUnique = async (...args) => { calls++; if (calls === 2) throw new Error('disk full'); return move(...args); };
  await assert.rejects(() => parentMerge(h, 'Renamed parent'), /disk full/);
  h.repo.moveUnique = move;
  assert.equal(h.contents.get(h.parent.path), text, 'the parent file is exactly as before'); assert.deepEqual(await h.shape(), original);
  assert.equal(JSON.stringify((await h.repo.readMap(h.path)).nodes), originalMap); assert.equal(h.view.history.canUndo, false);
  for (const source of h.sources) assert.equal(h.fm(source.path).state, 'active');
});
integrationTest('parent merge: a failed saveMap also restores the parent text and files', async () => {
  const h = await mergeHarness(); await parentOf(h);
  const text = h.contents.get(h.parent.path); const original = await h.shape();
  const save = h.repo.saveMap.bind(h.repo); let calls = 0;
  h.repo.saveMap = async (...args) => { calls++; if (calls === 1) throw new Error('map locked'); return save(...args); };
  await assert.rejects(() => parentMerge(h, 'Parent'), /map locked/);
  h.repo.saveMap = save;
  assert.equal(h.contents.get(h.parent.path), text); assert.deepEqual(await h.shape(), original); assert.equal(h.view.history.canUndo, false);
});
integrationTest('parent merge: busy on the parent or a subtopic is refused and writes nothing', async () => {
  const h = await mergeHarness(); await parentOf(h); const original = await h.shape(); const text = h.contents.get(h.parent.path);
  h.plugin.running.add(h.parent.path);
  h.view.multiSelected = new Set([h.parent.id, h.sources[0].id]);
  assert.deepEqual(plain(h.view.mergeCheck()), { ok: false, reason: 'ui.merge_busy' });
  await h.view.mergeSelected('Parent', { path: h.path, mapId: h.mapDoc.id, targetId: h.parent.id, sources: [h.parent, h.sources[0]].map(n => ({ id: n.id, path: n.path })) });
  assert.deepEqual(await h.shape(), original); assert.equal(h.contents.get(h.parent.path), text); assert.equal(h.view.history.canUndo, false);
});
// MapTransaction 04, Packet 2: both merge modes run through the transaction (undo/redo refuse stale, restore rebuild failures, keep the viewport).
const STALE = /can no longer be undone or redone/;
const ROLLBACK_FAILED = 'Merge failed and could not be fully undone. Check the Unassigned folder.';
const REFRESH_FAILED = 'Merged, but the view failed to refresh. Reopen the map.';
// A structure write that is not in history (the view's map is kept in step, so no conflict window opens).
const outsideWrite = async h => {
  const disk = await h.repo.readMap(h.path); disk.nodes.find(n => n.id === h.parent.id).collapsed = true;
  await h.repo.saveMap(h.path, disk); h.view.map = await h.repo.readMap(h.path);
};
integrationTest('V1: synthesis merge, then an unrelated structure write, then undo is refused (stale) and keeps that write', async () => {
  const h = await mergeHarness(); await h.merge('Merged'); await outsideWrite(h);
  const files = new Map(h.contents), mapText = h.contents.get(h.path);
  await assert.rejects(() => h.view.travel(false), STALE);
  assert.deepEqual(new Map(h.contents), files, 'no file changed'); assert.equal(h.contents.get(h.path), mapText);
  assert.equal((await h.repo.readMap(h.path)).nodes.find(n => n.id === h.parent.id).collapsed, true, 'the outside write survives');
  assert.equal(h.view.history.canUndo, true); assert.equal(h.view.history.canRedo, false, 'the history pointer is back');
});
integrationTest('V2: parent merge, then an unrelated structure write, then undo is refused (stale) and leaves the parent note as merged', async () => {
  const h = await mergeHarness(); await parentOf(h); await parentMerge(h, 'Renamed parent');
  const mergedText = h.contents.get(h.parent.path); await outsideWrite(h);
  const files = new Map(h.contents);
  await assert.rejects(() => h.view.travel(false), STALE);
  assert.equal(h.contents.get(h.parent.path), mergedText, 'the parent note is not rewritten'); assert.deepEqual(new Map(h.contents), files);
  assert.equal((await h.repo.readMap(h.path)).nodes.find(n => n.id === h.parent.id).collapsed, true);
  assert.equal(h.view.history.canUndo, true); assert.equal(h.view.history.canRedo, false);
});
integrationTest('V3: synthesis merge whose rebuild fails inside the commit is rolled back as a whole (new note parked, no history entry)', async () => {
  const h = await mergeHarness(); const original = await h.shape(); const mapText = h.contents.get(h.path);
  const rebuild = h.plugin.rebuildDerivedData; let calls = 0;
  h.plugin.rebuildDerivedData = async () => { if (++calls === 1) throw new Error('rebuild broke'); return rebuild(); };
  await assert.rejects(() => h.merge('Merged'), /rebuild broke/);
  const after = await h.shape();
  assert.deepEqual(after.nodes, original.nodes); assert.equal(h.contents.get(h.path), mapText);
  for (const source of h.sources) assert.equal(h.fm(source.path).state, 'active');
  assert.equal(after.unassigned.length, 1, 'the new note waits in Unassigned'); assert.equal(h.fm(after.unassigned[0]).state, 'unassigned');
  assert.equal(h.view.history.canUndo, false, 'no history entry');
});
integrationTest('V4a: synthesis merge whose view refresh (hydrate) fails keeps the merge and its history entry and shows the refresh Notice', async () => {
  const h = await aiMergeHarness(); h.view.hydrate = async () => { throw new Error('hydrate broke'); };
  await h.merge('Merged');
  assert.deepEqual(h.notices.filter(m => m === REFRESH_FAILED), [REFRESH_FAILED]);
  assert.equal(h.view.history.canUndo, true); assert.equal(h.view.history.undoEntry.label, 'Merge topics');
  const m = await h.repo.readMap(h.path); assert.equal(m.nodes.some(n => h.sources.some(s => s.id === n.id)), false, 'Map.md is the merged one');
});
integrationTest('V4b: parent merge whose view refresh (hydrate) fails keeps the merge and its history entry and shows the refresh Notice', async () => {
  const h = await aiMergeHarness(); await parentOf(h); h.view.hydrate = async () => { throw new Error('hydrate broke'); };
  await parentMerge(h, 'Parent');
  assert.deepEqual(h.notices.filter(m => m === REFRESH_FAILED), [REFRESH_FAILED]);
  assert.equal(h.view.history.canUndo, true);
  const m = await h.repo.readMap(h.path); assert.equal(m.nodes.some(n => n.id === h.sources[0].id), false, 'Map.md is the merged one');
  assert.match((await h.repo.readNote(h.parent.path)).detail, /Alpha detail/);
});
integrationTest('V5: a failed merge that cannot restore itself throws the rollback-failed AggregateError', async () => {
  const h = await mergeHarness();
  const moveUnique = h.repo.moveUnique.bind(h.repo), moveExact = h.repo.moveExact.bind(h.repo); let calls = 0;
  h.repo.moveUnique = async (...args) => { if (++calls === 2) throw new Error('disk full'); return moveUnique(...args); };
  h.repo.moveExact = async () => { throw new Error('restore blocked'); };
  const error = await h.merge('Merged').then(() => assert.fail('expected a rejection'), e => e);
  h.repo.moveUnique = moveUnique; h.repo.moveExact = moveExact;
  assert.equal(error.name, 'AggregateError'); assert.equal(error.message, ROLLBACK_FAILED); assert.equal(error.kind, 'rollback-failed');
  assert.match(String(error.errors[0]), /disk full/);
  assert.equal(h.view.history.canUndo, false);
});
integrationTest('V5b: a synthesis merge whose new note cannot be parked throws rollback-failed with the original error first', async () => {
  const h = await mergeHarness();
  const rebuild = h.plugin.rebuildDerivedData; let rebuilds = 0;
  h.plugin.rebuildDerivedData = async () => { if (++rebuilds === 1) throw new Error('rebuild broke'); return rebuild(); };
  const moveUnique = h.repo.moveUnique.bind(h.repo);
  h.repo.moveUnique = async (path, ...rest) => { if (path.includes('/Merged')) throw new Error('park blocked'); return moveUnique(path, ...rest); };
  const error = await h.merge('Merged').then(() => assert.fail('expected a rejection'), e => e);
  h.repo.moveUnique = moveUnique;
  assert.equal(error.name, 'AggregateError'); assert.equal(error.message, ROLLBACK_FAILED); assert.equal(error.kind, 'rollback-failed');
  assert.deepEqual(plain(error.errors.map(e => e.message)), ['rebuild broke', 'park blocked']);
  assert.equal(h.view.history.canUndo, false);
});
integrationTest('V5c: a merge whose rollback and parking both fail keeps one flat error list, the original error first', async () => {
  const h = await mergeHarness();
  const moveUnique = h.repo.moveUnique.bind(h.repo), moveExact = h.repo.moveExact.bind(h.repo); let calls = 0;
  h.repo.moveUnique = async (path, ...rest) => {
    if (path.includes('/Merged')) throw new Error('park blocked');
    if (++calls === 2) throw new Error('disk full');
    return moveUnique(path, ...rest);
  };
  h.repo.moveExact = async () => { throw new Error('restore blocked'); };
  const error = await h.merge('Merged').then(() => assert.fail('expected a rejection'), e => e);
  h.repo.moveUnique = moveUnique; h.repo.moveExact = moveExact;
  assert.equal(error.name, 'AggregateError'); assert.equal(error.message, ROLLBACK_FAILED); assert.equal(error.kind, 'rollback-failed');
  assert.match(String(error.errors[0]), /disk full/);
  assert.equal(error.errors.every(e => !(e instanceof AggregateError)), true, 'no nested AggregateError');
  assert.equal(error.errors.at(-1).message, 'park blocked');
});
integrationTest('V5d: undo and redo that cannot restore themselves are rewrapped as the rollback-failed AggregateError', async () => {
  const check = async (h, direction, label) => {
    const error = await h.view.travel(direction).then(() => assert.fail(`expected a rejection (${label})`), e => e);
    assert.equal(error.name, 'AggregateError'); assert.equal(error.message, ROLLBACK_FAILED); assert.equal(error.kind, 'rollback-failed');
    assert.match(error.errors[0].message, new RegExp(`${label} blocked`));
  };
  // Undo moves the sources back with moveExact: the 1st works, the 2nd fails, and putting the 1st back fails too.
  const undoing = await mergeHarness(); await undoing.merge('Merged');
  const moveExact = undoing.repo.moveExact.bind(undoing.repo); let exact = 0;
  undoing.repo.moveExact = async (...args) => { if (++exact >= 2) throw new Error(`undo blocked ${exact}`); return moveExact(...args); };
  await check(undoing, false, 'undo');
  // Redo moves the sources to their parking paths with moveExact too: same shape, in a merge that was undone first.
  const redoing = await mergeHarness(); await redoing.merge('Merged'); await redoing.view.travel(false);
  const redoMove = redoing.repo.moveExact.bind(redoing.repo); let again = 0;
  redoing.repo.moveExact = async (...args) => { if (++again >= 2) throw new Error(`redo blocked ${again}`); return redoMove(...args); };
  await check(redoing, true, 'redo');
});
integrationTest('V6: parent merge undo whose Map.md write fails puts the merged note and files back and keeps the entry undoable', async () => {
  const h = await mergeHarness(); await parentOf(h); const text = h.contents.get(h.parent.path); const original = await h.shape();
  await parentMerge(h, 'Renamed parent'); const merged = await h.shape(); const mergedText = h.contents.get(h.parent.path);
  const save = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = async () => { throw new Error('map locked'); };
  await assert.rejects(() => h.view.travel(false), /map locked/);
  h.repo.saveMap = save;
  assert.equal(h.contents.get(h.parent.path), mergedText, 'the parent note is the merged text again'); assert.deepEqual(await h.shape(), merged, 'subtopics wait in Unassigned');
  assert.equal(h.view.history.canUndo, true, 'the history pointer is back');
  await h.view.travel(false); assert.equal(h.contents.get(h.parent.path), text); assert.deepEqual(await h.shape(), original);
});
integrationTest('V7: synthesis merge, undo, the parked new note moved away outside, redo is refused (stale) and writes nothing', async () => {
  const h = await mergeHarness(); await h.merge('Merged'); await h.view.travel(false);
  const [parked] = (await h.shape()).unassigned;
  await h.repo.moveExact(parked, `${h.path.replace(/\/Map\.md$/, '')}/Notes/Elsewhere.md`);
  const files = new Map(h.contents);
  await assert.rejects(() => h.view.travel(true), STALE);
  assert.deepEqual(new Map(h.contents), files); assert.equal(h.view.history.canRedo, true, 'redo is still pending');
});
integrationTest('V8: undoing a merge clears the selection when the merged card leaves the map', async () => {
  const h = await mergeHarness(); await h.merge('Merged');
  const merged = (await h.repo.readMap(h.path)).nodes.find(n => n.path.includes('Merged')); assert.equal(h.view.selected, merged.id);
  await h.view.travel(false); assert.equal(h.view.selected, null);
});
integrationTest('V9: a viewport panned before undo (and redo) stays as panned', async () => {
  const h = await mergeHarness(); await h.merge('Merged');
  h.view.map.viewport = { x: 321, y: -45, zoom: 1.5 };
  await h.view.travel(false); assert.deepEqual(plain(h.view.map.viewport), { x: 321, y: -45, zoom: 1.5 });
  h.view.map.viewport = { x: 7, y: 8, zoom: 0.5 };
  await h.view.travel(true); assert.deepEqual(plain(h.view.map.viewport), { x: 7, y: 8, zoom: 0.5 });
});
integrationTest('V10: the conflict window keeps a file version that lacks the sources: nothing is merged, the new note is parked, no history', async () => {
  const h = await mergeHarness();
  const disk = await h.repo.readMap(h.path); disk.nodes = disk.nodes.filter(n => n.id !== h.sources[1].id); disk.title = 'Edited elsewhere';
  await h.repo.saveMap(h.path, disk);
  h.view.resolveMapConflict = async function () { this.map = await h.repo.readMap(h.path); this.history.clear(); return true; };
  await assert.rejects(() => h.merge('Merged'), /note is missing/);
  const after = await h.shape(); assert.deepEqual(after.nodes, disk.nodes.map(n => [n.id, n.path, n.parentId]));
  for (const source of h.sources) { assert.ok(h.app.vault.getAbstractFileByPath(source.path)); assert.equal(h.fm(source.path).state, 'active'); }
  assert.equal((await h.repo.readMap(h.path)).title, 'Edited elsewhere');
  assert.equal(after.unassigned.length, 1, 'the new note is parked'); assert.equal(h.view.history.canUndo, false);
});
integrationTest('V11: a guard refusal carries kind "guard" and the merged-topic message, on undo and on redo', async () => {
  const h = await mergeHarness(); await parentOf(h); await parentMerge(h, 'Parent');
  await h.repo.updateNote(h.parent.path, { summary: 'Edited later' });
  const refused = await h.view.travel(false).then(() => assert.fail('expected a rejection'), e => e);
  assert.equal(refused.kind, 'guard'); assert.match(refused.message, /merged topic was edited/); assert.equal(h.view.history.canUndo, true);
  await h.repo.updateNote(h.parent.path, { summary: 'Parent summary' });
  await h.view.travel(false); await h.repo.updateNote(h.parent.path, { summary: 'Edited after undo' });
  const redo = await h.view.travel(true).then(() => assert.fail('expected a rejection'), e => e);
  assert.equal(redo.kind, 'guard'); assert.match(redo.message, /merged topic was edited/); assert.equal(h.view.history.canRedo, true);
});
const parentBegin = async (h, title) => {
  const snapshot = parentSnapshot(h);
  const began = await h.view.startMergeDraft(title, snapshot, () => { h.started++; }, new AbortController().signal);
  return { began, task: h.view.mergeTasks.get(h.path), snapshot };
};
integrationTest('parent merge (AI): one request with the parent first and no Thinking Origin; the result replaces Summary and Detail only, applied directly; undo restores the text', async () => {
  const h = await aiMergeHarness({ origin: 'SECRET-ORIGIN-TEXT', parentModel: 'claude:haiku', parentSource: 'manual' }); await parentOf(h);
  const text = h.contents.get(h.parent.path); const original = await h.shape();
  h.answer = async () => ({ summary: 'Merged one-liner', detail: '### Facts\n\nParent detail and Gamma detail', visualReferences: [], formatIssues: [], suggestions: [{ title: 'Parent', task: '', contribution: '', parentTitle: '' }] });
  const { began, task } = await parentBegin(h, 'Parent'); assert.equal(began, true); await h.untilSettled(task);
  assert.equal(h.asks.length, 1); assert.equal(h.asks[0].model, 'claude:haiku', 'the parent topic’s own model'); assert.deepEqual(h.usage, ['claude:haiku']);
  const group = h.asks[0].context.referenceGroups[0]; assert.equal(group.documents[0].path, h.parent.path); assert.equal(group.documents.length, 3);
  assert.doesNotMatch(JSON.stringify(h.asks[0].context), /SECRET-ORIGIN-TEXT|PARENT-ORIGIN/); assert.match(JSON.stringify(group.documents[0]), /Parent detail/);
  assert.equal(task.targetId, h.parent.id); assert.equal(task.title, 'Parent');
  const note = await h.repo.readNote(h.parent.path);
  assert.equal(note.summary, 'Merged one-liner'); assert.match(note.detail, /Parent detail and Gamma detail/); assert.equal(note.title, 'Parent'); assert.equal(h.fm(h.parent.path).status, 'completed');
  assert.equal(note.prompt, 'Parent prompt', 'the parent’s own Prompt is kept'); assert.equal(note.thinkingOrigin, 'PARENT-ORIGIN'); assert.equal(note.model, 'claude:haiku');
  assert.equal(h.view.mergeTasks.size, 0); assert.equal((await h.repo.readMap(h.path)).nodes.find(n => n.id === h.parent.id).path, h.parent.path);
  assert.equal((await h.repo.collectionFiles(h.path, 'Unassigned')).length, 2);
  const done = await h.shape();
  await h.view.travel(false); assert.equal(h.contents.get(h.parent.path), text); assert.deepEqual(await h.shape(), original);
  await h.view.travel(true); assert.deepEqual(await h.shape(), done); assert.equal((await h.repo.readNote(h.parent.path)).summary, 'Merged one-liner');
  await h.view.travel(false); assert.equal(h.contents.get(h.parent.path), text);
});
integrationTest('parent merge (AI): the AI’s different name renames the parent’s title only, never its path or id', async () => {
  const h = await aiMergeHarness(); await parentOf(h); const path = h.parent.path;
  h.answer = async () => ({ summary: 'S', detail: '### Facts\n\nx', visualReferences: [], formatIssues: [], suggestions: [{ title: 'AI parent name', task: '', contribution: '', parentTitle: '' }] });
  const { task } = await parentBegin(h, 'Parent'); await h.untilSettled(task);
  assert.equal(task.title, 'AI parent name'); assert.equal(h.asks.length, 1);
  assert.equal((await h.repo.readMap(h.path)).nodes.find(n => n.id === h.parent.id).path, path);
  assert.equal((await h.repo.readNote(path)).title, 'AI parent name'); assert.match(h.contents.get(path), /^# AI parent name$/m);
  assert.deepEqual(h.notices.filter(m => /Merged into/.test(m)), ['Merged into “AI parent name”. You can undo.']);
});
integrationTest('parent merge (AI): editing the parent while the AI runs makes the result stale: nothing is written and the task is cleared', async () => {
  for (const edit of [h => h.repo.updateNote(h.parent.path, { detail: 'Edited during the run' }), h => h.repo.updateNote(h.sources[0].path, { detail: 'Child edited during the run' })]) {
    const h = await aiMergeHarness(); await parentOf(h); const before = h.files(); const original = await h.shape();
    let release; const gate = new Promise(resolve => { release = resolve; });
    h.answer = async () => { await gate; return { summary: 'S', detail: 'D', visualReferences: [], formatIssues: [], suggestions: [] }; };
    const { task } = await parentBegin(h, 'Parent'); await edit(h); const edited = h.files(); release(); await h.untilSettled(task);
    assert.equal(h.view.mergeTasks.size, 0, 'the task is cleared'); assert.ok(h.notices.includes('A source topic changed or left the map, so nothing was merged')); assert.deepEqual(h.files(), edited); assert.notDeepEqual(edited, before); assert.deepEqual((await h.shape()).nodes, original.nodes); assert.equal(h.view.history.canUndo, false);
  }
});
integrationTest('AI merge: a missing, blank or over-long AI name falls back to the first source title', async () => {
  for (const suggestions of [[], [{ title: '  ', task: '', contribution: '', parentTitle: '' }], [{ title: 'x'.repeat(200), task: '', contribution: '', parentTitle: '' }]]) {
    const h = await aiMergeHarness();
    h.answer = async () => ({ summary: 'S', detail: 'D', visualReferences: [], formatIssues: [], suggestions });
    const { task } = await h.begin('Fallback title'); await h.untilSettled(task);
    assert.equal(task.title, 'Fallback title');
    assert.ok((await h.repo.readMap(h.path)).nodes.some(n => n.path.includes('Fallback title')));
    assert.deepEqual(h.notices.filter(m => /Merged into/.test(m)), ['Merged into “Fallback title”. You can undo.']);
  }
});
integrationTest('AI merge model: the nearest manual parent model is used for the usage notice, the request and the new note; a workspace parent follows the workspace model', async () => {
  const manual = await aiMergeHarness({ parentModel: 'claude:haiku', parentSource: 'manual' });
  await manual.repo.updateNote(manual.parent.path, { reasoning: 'high' });
  const { task } = await manual.begin('M'); await manual.untilSettled(task);
  assert.deepEqual([manual.usage, manual.asks.map(a => a.model), task.model], [['claude:haiku'], ['claude:haiku'], 'claude:haiku']);
  assert.equal(manual.asks[0].reasoning, 'high', 'MS-04: the request carries the manual parent reasoning, not the current low');
  const merged = (await manual.repo.readMap(manual.path)).nodes.find(n => n.path.endsWith('M.md'));
  const note = await manual.repo.readNote(merged.path); assert.equal(note.model, 'claude:haiku'); assert.equal(note.modelSource, 'inherited');
  const workspace = await aiMergeHarness();
  const run = await workspace.begin('W'); await workspace.untilSettled(run.task);
  assert.deepEqual([workspace.usage, workspace.asks.map(a => a.model)], [['claude:sonnet'], ['claude:sonnet']]);
  assert.equal(workspace.asks[0].reasoning, 'low', 'MS-04: a workspace parent uses the current reasoning');
});
integrationTest('structure merge also takes the parent-resolved model (manual parent inherits, workspace parent stays workspace)', async () => {
  const h = await mergeHarness({ parentModel: 'claude:haiku', parentSource: 'manual' });
  await h.merge('Plain');
  const merged = (await h.repo.readMap(h.path)).nodes.find(n => n.path.includes('Plain'));
  const note = await h.repo.readNote(merged.path); assert.equal(note.model, 'claude:haiku'); assert.equal(note.modelSource, 'inherited');
  const w = await mergeHarness(); w.repo.settings.cliModel = 'claude:opus';
  await w.merge('Plain');
  const wm = await w.repo.readNote((await w.repo.readMap(w.path)).nodes.find(n => n.path.includes('Plain')).path);
  assert.equal(wm.model, 'claude:opus'); assert.equal(wm.modelSource, 'inherited');
});
integrationTest('AI merge: declining the usage notice, or closing before it is answered, starts nothing', async () => {
  const h = await aiMergeHarness(); const files = h.files(); h.decline = true;
  const out = await h.begin();
  assert.equal(out.began, false); assert.equal(h.started, 0); assert.equal(h.asks.length, 0); assert.equal(h.view.mergeTasks.size, 0); assert.deepEqual(h.files(), files);
  h.decline = false; const gone = new AbortController(); gone.abort();
  const closed = await h.begin('x', gone.signal);
  assert.equal(closed.began, false); assert.equal(h.asks.length, 0); assert.equal(h.view.mergeTasks.size, 0);
});
integrationTest('AI merge: Stop before or after the request, an AI failure and closing the view leave every file and the map untouched and clear the merging state', async () => {
  for (const scenario of ['stop', 'fail', 'close']) {
    const h = await aiMergeHarness(); const original = await h.shape(); const files = h.files();
    h.answer = signal => scenario === 'fail' ? Promise.reject(new Error('provider down')) : abortable(signal);
    const { task } = await h.begin();
    assert.equal(task.state, 'running');
    if (scenario === 'stop') h.view.stopMergeTask(task);
    if (scenario === 'close') { h.view.closed = true; for (const t of h.view.mergeTasks.values()) t.controller.abort(); }
    await h.untilSettled(task);
    assert.deepEqual(h.files(), files, scenario); assert.deepEqual(await h.shape(), original, scenario); assert.equal(h.view.history.canUndo, false, scenario);
    assert.equal(h.view.mergeTasks.size, 0, `${scenario}: the merging state is cleared`);
    for (const source of h.sources) assert.equal(h.view.isMerging(source.id), false, `${scenario}: cards are free again`);
    if (scenario === 'fail') { assert.deepEqual(h.failures, ['AI merge failed']); assert.ok(h.notices.some(m => /AI merge failed: provider down/.test(m))); }
    else assert.equal(h.notices.some(m => /Merged into|AI merge failed/.test(m)), false, `${scenario}: no Notice`);
  }
});
integrationTest('AI merge: a result that arrives after Stop is dropped (no task, no Notice, no write)', async () => {
  const h = await aiMergeHarness(); const files = h.files(); let release;
  h.answer = () => new Promise(resolve => { release = () => resolve({ summary: 'late', detail: 'late', visualReferences: [], formatIssues: [], suggestions: [] }); });
  const { task } = await h.begin(); await new Promise(r => setImmediate(r));
  h.view.stopMergeTask(task); release(); await h.untilSettled(task);
  assert.equal(h.view.mergeTasks.size, 0); assert.equal(task.state, 'running'); assert.equal(h.notices.length, 0); assert.deepEqual(h.files(), files);
});
integrationTest('AI merge: a source that changes while the model runs fails with the stale message, writes nothing and clears the task', async () => {
  const h = await aiMergeHarness(); const files = h.files();
  h.answer = async () => { await h.repo.updateNote(h.sources[0].path, { detail: 'Changed meanwhile' }); return { summary: 's', detail: 'd', visualReferences: [], formatIssues: [], suggestions: [] }; };
  const { task } = await h.begin(); await h.untilSettled(task);
  assert.equal(h.view.mergeTasks.size, 0); assert.deepEqual(h.notices.filter(m => /nothing was merged/.test(m)), ['A source topic changed or left the map, so nothing was merged']);
  assert.equal(h.notices.some(m => /Merged into/.test(m)), false);
  assert.equal(h.view.history.canUndo, false); assert.equal((await h.repo.readMap(h.path)).nodes.length, 5);
  assert.notDeepEqual(h.files(), files, 'only the test edit changed a file');
  for (const source of h.sources) assert.equal(h.view.isMerging(source.id), false);
});
integrationTest('AI merge: when the sources or the map change during the run (source removed, another map) nothing is written, the task is cleared and the stale Notice shows', async () => {
  const cases = {
    removed: async h => { h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.sources[1].id); },
    otherMap: async h => { h.view.map = { ...h.view.map, id: 'another-map' }; },
    otherMapPath: async h => { h.view.path = 'Agent Workspace/Topics/other/Map.md'; }
  };
  for (const [name, change] of Object.entries(cases)) {
    const h = await aiMergeHarness(); h.answer = async () => { await change(h); return { summary: 's', detail: 'd', visualReferences: [], formatIssues: [], suggestions: [] }; };
    const { task } = await h.begin(); const files = h.files(); const nodes = JSON.stringify(h.view.map.nodes);
    await h.untilSettled(task);
    assert.deepEqual(h.files(), files, `${name}: no file created or moved`); assert.equal(JSON.stringify(h.view.map.nodes), nodes, name);
    assert.equal(h.view.mergeTasks.size, 0, name); assert.equal(h.view.history.canUndo, false, name);
    assert.deepEqual(h.notices.filter(m => /nothing was merged/.test(m)), ['A source topic changed or left the map, so nothing was merged'], name);
    assert.equal((await h.repo.readMap(h.path)).nodes.length, 5, name);
  }
});
integrationTest('AI merge: a second Merge press while the merge runs only reports it; afterwards the cards can be merged again', async () => {
  const h = await aiMergeHarness(); let release;
  h.answer = () => new Promise(resolve => { release = () => resolve({ summary: 's', detail: 'd', visualReferences: [], formatIssues: [], suggestions: [] }); });
  const { task } = await h.begin(); await new Promise(r => setImmediate(r));
  h.view.multiSelected = new Set(h.sources.map(n => n.id));
  h.view.openMerge(); assert.deepEqual(h.notices.slice(-1), ['Merging; try again when it finishes'], 'the merge-specific Notice, not “AI running…”');
  assert.deepEqual(plain(h.view.mergeCheck()), { ok: false, reason: 'ui.merge_busy' }, 'the sources stay locked while it runs');
  release(); await h.untilSettled(task);
  assert.equal(h.view.mergeTasks.size, 0);
});
integrationTest('AI merge: a failure while moving a source rolls everything back, shows the error and leaves no task to retry', async () => {
  const h = await aiMergeHarness(); const original = await h.shape(); const nodes = JSON.stringify((await h.repo.readMap(h.path)).nodes);
  const move = h.repo.moveUnique.bind(h.repo); let calls = 0;
  h.repo.moveUnique = async (...args) => { calls++; if (calls === 2) throw new Error('disk full'); return move(...args); };
  const { task } = await h.begin(); await h.untilSettled(task);
  h.repo.moveUnique = move;
  const after = await h.shape();
  assert.equal(JSON.stringify((await h.repo.readMap(h.path)).nodes), nodes); assert.deepEqual(after.nodes, original.nodes);
  for (const source of h.sources) { assert.ok(h.app.vault.getAbstractFileByPath(source.path)); assert.equal(h.fm(source.path).state, 'active'); }
  assert.equal(after.unassigned.length, 1, 'the new note is parked, not deleted'); assert.equal(h.view.history.canUndo, false);
  assert.equal(h.view.mergeTasks.size, 0, 'no draft state is left to retry'); assert.deepEqual(h.failures, ['AI merge failed']); assert.ok(h.notices.some(m => /AI merge failed: disk full/.test(m)));
  assert.equal(h.notices.some(m => /Merged into/.test(m)), false);
  for (const source of h.sources) assert.equal(h.view.isMerging(source.id), false, 'the next merge is not blocked');
  const again = await h.begin('Second try'); await h.untilSettled(again.task);
  assert.equal((await h.repo.readMap(h.path)).nodes.some(n => h.sources.some(s => s.id === n.id)), false);
});
integrationTest('AI merge lock: while merging, delete, remove, move, copy and structure suggestions on the merging cards are refused with a Notice and write nothing; other cards are not affected', async () => {
  const h = await aiMergeHarness(); let release; const gate = new Promise(resolve => { release = resolve; });
  const answer = h.answer; h.answer = async (...args) => { await gate; return answer(...args); };
  const { task } = await h.begin(); const [alpha, beta, gamma] = h.sources;
  const locked = 'Merging; try again when it finishes';
  const state = async () => ({ files: h.files(), nodes: JSON.stringify((await h.repo.readMap(h.path)).nodes), undo: h.view.history.canUndo });
  const refused = async (label, run) => {
    const before = await state(); const count = h.notices.filter(m => m === locked).length;
    await run();
    assert.deepEqual(await state(), before, `${label}: nothing written`); assert.equal(h.notices.filter(m => m === locked).length, count + 1, `${label}: the Notice shows`);
  };
  await refused('remove one merging card', () => h.view.removeToUnassigned(alpha, false));
  await refused('remove a branch containing merging cards', () => h.view.removeToUnassigned(h.parent, true));
  await refused('adopt into a merging card', () => h.view.removeToUnassigned(h.kid, false, beta.id));
  h.view.multiSelected = new Set([beta.id]);
  await refused('remove selected', () => h.view.removeSelected());
  await refused('move one card', () => h.view.moveTopic(gamma, h.parent));
  await refused('move under a merging card', () => h.view.moveTopic(h.kid, gamma));
  await refused('move selected', () => h.view.moveSelected(h.parent));
  await refused('copy selected', () => h.view.copySelected(h.parent));
  h.view.multiSelected = new Set([h.kid.id]);
  await refused('move something under a merging card (multi)', () => h.view.moveSelected(alpha));
  for (const suggestion of [{ kind: 'move', targetId: alpha.id, newParentId: h.parent.id }, { kind: 'move', targetId: h.kid.id, newParentId: beta.id }, { kind: 'merge', targetId: h.kid.id, mergeIntoId: gamma.id }, { kind: 'reduce', targetId: beta.id }])
    await assert.rejects(() => h.view.applyStructureSuggestion(suggestion, '', () => null), /Merging; try again when it finishes/);
  const before = await state();
  // A card that is not part of the merge is unaffected, and so is the merge.
  h.view.multiSelected = new Set(); await h.view.moveTopic(h.kid, h.parent);
  assert.equal((await h.repo.readMap(h.path)).nodes.find(n => n.id === h.kid.id).parentId, h.parent.id);
  assert.notDeepEqual(await state(), before);
  release(); await h.untilSettled(task);
  assert.ok(await h.mergedNode('AI merged'));
  assert.equal(h.view.mergeTasks.size, 0);
  h.notices.length = 0; await h.view.removeToUnassigned(h.kid, false);
  assert.equal(h.notices.includes(locked), false, 'after the merge the lock is gone');
});
integrationTest('AI merge lock at the door: Delete, Remove selected, Move to, Copy to, structure suggestions, Apply parent, Merge again and Drag show the Notice at once and open no dialog', async () => {
  const h = await aiMergeHarness(); let release; const gate = new Promise(resolve => { release = resolve; });
  const answer = h.answer; h.answer = async (...args) => { await gate; return answer(...args); };
  let opened = 0; const open = h.shim.Modal.prototype.open; h.shim.Modal.prototype.open = function () { opened++; };
  const { task } = await h.begin(); const [alpha, beta] = h.sources; const locked = 'Merging; try again when it finishes';
  const seen = async (label, run) => { const count = h.notices.filter(m => m === locked).length; await run(); assert.equal(h.notices.filter(m => m === locked).length, count + 1, `${label}: Notice`); assert.equal(opened, 0, `${label}: no dialog`); };
  await seen('Delete (card)', () => h.view.confirmRemoveNode(alpha));
  await seen('Delete (a branch containing merging cards)', () => h.view.confirmRemoveNode(h.parent));
  h.view.multiSelected = new Set([beta.id]);
  await seen('Remove selected', () => h.view.confirmRemoveSelected());
  await seen('Move to', () => h.view.chooseSelectedParent(false));
  await seen('Copy to', () => h.view.chooseSelectedParent(true));
  await seen('Merge again', () => { h.view.multiSelected = new Set(h.sources.map(n => n.id)); h.view.openMerge(); });
  await assert.rejects(() => h.view.applyStructureSuggestion({ kind: 'reduce', targetId: alpha.id }, '', () => null), /Merging/);
  assert.equal(opened, 0, 'a structure suggestion opens no dialog'); assert.ok(h.notices.filter(m => m === locked).length > 6);
  // A card outside the merge still opens its delete dialog.
  await h.view.confirmRemoveNode(h.kid); assert.equal(opened, 1);
  h.shim.Modal.prototype.open = open; release(); await h.untilSettled(task);
});
integrationTest('AI merge: the completion Notice stays 15 s so its Undo can be used', async () => {
  const h = await aiMergeHarness(); const { task } = await h.begin(); await h.untilSettled(task);
  const notice = h.undoNotice(); assert.equal(notice.timeout, 15000);
});
integrationTest('AI merge lock: the shared check refuses only merging cards and shows one Notice', async () => {
  const h = await aiMergeHarness(); let release; const gate = new Promise(resolve => { release = resolve; });
  const answer = h.answer; h.answer = async (...args) => { await gate; return answer(...args); };
  const { task } = await h.begin(); const before = JSON.stringify((await h.repo.readMap(h.path)).nodes);
  const view = h.view; const unlocked = [h.sources[0].id, h.parent.id].filter(id => view.isMerging(id));
  assert.deepEqual(unlocked, [h.sources[0].id]);
  assert.equal(view.mergeUnlocked([h.sources[0].id, h.parent.id]), false); assert.equal(view.mergeUnlocked([h.kid.id, h.parent.id]), true);
  assert.equal(h.notices.filter(m => m === 'Merging; try again when it finishes').length, 1, 'only the refused check shows the Notice');
  assert.equal(JSON.stringify((await h.repo.readMap(h.path)).nodes), before);
  release(); await h.untilSettled(task);
});
async function modelTree(sources, stored = 'gpt-5.6-luna') {
  const { repo, app, contents } = fixture(); repo.settings.cliModel = 'claude:sonnet';
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a'); await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const nodes = [];
  for (const [index, [source, model]] of sources.entries()) {
    const created = await repo.createNote(`T${index}`, model ?? stored, mapDoc, mapPath, source);
    created.parentId = index ? nodes[index - 1].id : null; mapDoc.nodes.push(created); nodes.push(created);
  }
  await repo.saveMap(mapPath, mapDoc);
  return { repo, contents, nodes, mapDoc, mapPath };
}
integrationTest('a workspace topic runs on the current workspace model; the stored snapshot is never rewritten', async () => {
  const { repo, contents, nodes } = await modelTree([['workspace']]);
  const before = contents.get(nodes[0].path);
  const note = await repo.readNote(nodes[0].path);
  assert.equal(note.model, 'claude:sonnet'); assert.equal(note.modelSource, 'workspace');
  assert.match(before, /model: gpt-5\.6-luna/);
  assert.equal(contents.get(nodes[0].path), before);
  repo.settings.cliModel = 'claude:opus';
  assert.equal((await repo.readNote(nodes[0].path)).model, 'claude:opus');
});
integrationTest('an inherited topic uses the nearest manual ancestor model, otherwise the current workspace model', async () => {
  const withManual = await modelTree([['workspace'], ['manual', 'claude:haiku'], ['inherited'], ['inherited']]);
  assert.equal((await withManual.repo.readNote(withManual.nodes[3].path)).model, 'claude:haiku');
  assert.equal((await withManual.repo.readNote(withManual.nodes[2].path)).model, 'claude:haiku');
  assert.equal((await withManual.repo.readNote(withManual.nodes[1].path)).model, 'claude:haiku');
  assert.equal((await withManual.repo.readNote(withManual.nodes[0].path)).model, 'claude:sonnet');
  const none = await modelTree([['workspace'], ['inherited'], ['inherited']]);
  assert.equal((await none.repo.readNote(none.nodes[2].path)).model, 'claude:sonnet');
  const nested = await modelTree([['manual', 'claude:opus'], ['inherited'], ['manual', 'claude:haiku'], ['inherited']]);
  assert.equal((await nested.repo.readNote(nested.nodes[3].path)).model, 'claude:haiku');
  assert.equal((await nested.repo.readNote(nested.nodes[1].path)).model, 'claude:opus');
});
integrationTest('a manual topic keeps its stored model', async () => {
  const { repo, nodes } = await modelTree([['manual', 'gpt-5.6-luna']]);
  const note = await repo.readNote(nodes[0].path);
  assert.equal(note.model, 'gpt-5.6-luna'); assert.equal(note.modelSource, 'manual');
});
integrationTest('model resolution survives a parent cycle and a missing parent', async () => {
  const cycle = await modelTree([['inherited'], ['inherited']]);
  cycle.mapDoc.nodes[0].parentId = cycle.mapDoc.nodes[1].id;
  assert.equal((await cycle.repo.readNote(cycle.nodes[1].path, cycle.mapDoc)).model, 'claude:sonnet');
  const orphan = await modelTree([['inherited'], ['inherited']]);
  orphan.mapDoc.nodes[1].parentId = 'missing';
  assert.equal((await orphan.repo.readNote(orphan.nodes[1].path, orphan.mapDoc)).model, 'claude:sonnet');
});
integrationTest('relevance frontmatter reads when valid, is absent when missing or invalid, and survives note updates', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Graded');
  const original = contents.get(n.path);
  assert.equal((await repo.readNote(n.path)).relevance, undefined, 'missing: no relevance');
  const withKeys = (tier, reason) => original.replace('---\n', `---\nrelevance-tier: ${tier}\nrelevance-reason: ${reason}\n`);
  // A valid tier is a grade; a reason written by an older version is ignored (it is neither shown nor required).
  for (const tier of ['core', 'support', 'side']) {
    contents.set(n.path, withKeys(tier, '"Because: it matters"'));
    assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier });
    contents.set(n.path, original.replace('---\n', `---\nrelevance-tier: ${tier}\n`));
    assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier }, 'a tier alone is a grade');
    contents.set(n.path, withKeys(tier, '""'));
    assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier }, 'an empty old reason is ignored too');
  }
  for (const bad of [withKeys('huge', 'ok'), withKeys('[core]', 'ok'), original.replace('---\n', '---\nrelevance-reason: only a reason\n')]) {
    contents.set(n.path, bad);
    assert.equal((await repo.readNote(n.path)).relevance, undefined, 'invalid or incomplete: no relevance');
  }
  contents.set(n.path, withKeys('side', 'Skip it'));
  await repo.updateNote(n.path, { status: 'completed' });
  assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier: 'side' });
});
integrationTest('relevance goal reads from map file frontmatter and is absent when missing or blank', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Goal host');
  const original = contents.get(n.path);
  assert.equal(await repo.readRelevanceGoal(n.path), undefined);
  contents.set(n.path, original.replace('---\n', '---\nrelevance-goal: "Learn: the basics"\n'));
  assert.equal(await repo.readRelevanceGoal(n.path), 'Learn: the basics');
  contents.set(n.path, original.replace('---\n', '---\nrelevance-goal: "  "\n'));
  assert.equal(await repo.readRelevanceGoal(n.path), undefined);
  contents.set(n.path, original.replace('---\n', '---\nrelevance-goal: 5\n'));
  assert.equal(await repo.readRelevanceGoal(n.path), undefined);
});
// ---- Phase 3: relevance writers (frontmatter only; other keys, the body and `updated` stay as they were) ----
integrationTest('relevance writer sets, replaces and removes only its two keys; body and other frontmatter are untouched', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Graded');
  contents.set(n.path, contents.get(n.path).replace('---\n', '---\ncustom: retain me\nlist:\n  - one\n  - two\n'));
  const before = await repo.readNote(n.path);
  const bodyOf = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const keysOf = text => text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1].split('\n').filter(line => !/^relevance-/.test(line)).join('\n');
  const original = contents.get(n.path);
  await repo.writeRelevance(n.path, { tier: 'core' });
  const written = contents.get(n.path);
  assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier: 'core' });
  assert.doesNotMatch(written, /relevance-reason/, 'no reason key is written');
  assert.equal(bodyOf(written), bodyOf(original), 'body unchanged'); assert.equal(keysOf(written), keysOf(original), 'other keys unchanged');
  assert.equal((await repo.readNote(n.path)).updated, before.updated, '`updated` is not bumped');
  await repo.writeRelevance(n.path, { tier: 'side' });
  assert.equal(written.match(/relevance-tier/g).length, 1); assert.equal(contents.get(n.path).match(/relevance-tier/g).length, 1, 'replaced in place, not duplicated');
  assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier: 'side' });
  await repo.writeRelevance(n.path, null);
  assert.equal(contents.get(n.path), original, 'removing restores the file byte for byte');
  assert.equal((await repo.readNote(n.path)).relevance, undefined);
  // Every write removes the reason an older version left behind, for an AI grade and for a hand-set tier alike.
  contents.set(n.path, original.replace('---\n', '---\nrelevance-tier: core\nrelevance-reason: "Old reason"\n'));
  await repo.writeRelevance(n.path, { tier: 'support' });
  assert.doesNotMatch(contents.get(n.path), /relevance-reason|Old reason/);
  assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier: 'support' });
  contents.set(n.path, original.replace('---\n', '---\nrelevance-tier: core\nrelevance-reason: "Old reason"\n'));
  await repo.writeRelevance(n.path, { tier: 'core', manual: true });
  assert.doesNotMatch(contents.get(n.path), /relevance-reason|Old reason/);
  await repo.writeRelevance(n.path, null);
  assert.equal(contents.get(n.path), original);
});
integrationTest('relevance writer keeps CRLF files CRLF and drops a stale multi-line value of its own key', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Windows');
  contents.set(n.path, contents.get(n.path).replace(/\n/g, '\r\n').replace('---\r\n', '---\r\nrelevance-tier: core\r\nrelevance-reason: >-\r\n  folded old\r\n  value\r\n'));
  await repo.writeRelevance(n.path, { tier: 'support' });
  const text = contents.get(n.path);
  assert.equal(/[^\r]\n/.test(text.replace(/^[\s\S]*?$/, m => m)), false, 'no bare LF introduced');
  assert.doesNotMatch(text, /folded old/);
  assert.deepEqual(plain((await repo.readNote(n.path)).relevance), { tier: 'support' });
});
async function mapFile(language = 'en') {
  const { repo, app, contents } = fixture(language);
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const mapDoc = { id: 'map-a', title: 'Cooking', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  return { repo, contents, mapPath, mapDoc };
}
integrationTest('relevance goal writer sets the goal and appends one dated history entry only when the goal changes', async () => {
  const { repo, contents, mapPath } = await mapFile();
  const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const first = await repo.writeRelevanceGoal(mapPath, '  Cook a\n steak  ');
  assert.equal(first.changed, true); assert.deepEqual(plain(first.previous), {});
  assert.equal(await repo.readRelevanceGoal(mapPath), 'Cook a steak');
  assert.match(contents.get(mapPath), new RegExp(`relevance-goal-history:\\n  - "${date}: Cook a steak"`));
  const same = await repo.writeRelevanceGoal(mapPath, 'Cook a steak');
  assert.equal(same.changed, false, 'the same goal is not a new history entry');
  assert.equal(contents.get(mapPath).match(/relevance-goal-history/g).length, 1); assert.equal(contents.get(mapPath).match(/- "/g).length, 1);
  const second = await repo.writeRelevanceGoal(mapPath, 'Cook a steak for guests');
  assert.equal(second.changed, true);
  assert.equal(await repo.readRelevanceGoal(mapPath), 'Cook a steak for guests');
  assert.equal(contents.get(mapPath).match(/- "/g).length, 2, 'history only grows, oldest first');
  assert.match(contents.get(mapPath), /relevance-goal-history:\n  - "[\d-]+: Cook a steak"\n  - "[\d-]+: Cook a steak for guests"/);
  assert.equal(contents.get(mapPath).startsWith('---\nvisual-agent-map: true\n'), true);
  // Restoring the state it found puts the file back exactly (the goal undo).
  await repo.restoreRelevanceGoal(mapPath, second.previous);
  assert.equal(await repo.readRelevanceGoal(mapPath), 'Cook a steak'); assert.equal(contents.get(mapPath).match(/- "/g).length, 1);
  await repo.restoreRelevanceGoal(mapPath, first.previous);
  assert.equal(await repo.readRelevanceGoal(mapPath), undefined); assert.doesNotMatch(contents.get(mapPath), /relevance-goal/);
  await assert.rejects(repo.writeRelevanceGoal(mapPath, ' \n '), /goal/);
});
integrationTest('relevance goal keys survive every later map save (writeMapContent keeps the frontmatter)', async () => {
  const { repo, contents, mapPath } = await mapFile();
  await repo.writeRelevanceGoal(mapPath, 'Goal one'); await repo.writeRelevanceGoal(mapPath, 'Goal two');
  const map = await repo.readMap(mapPath); map.viewport = { x: 5, y: 6, zoom: 2 };
  await repo.saveMap(mapPath, map);
  await repo.updateMap(mapPath, doc => { doc.title = 'Cooking again'; });
  assert.equal(await repo.readRelevanceGoal(mapPath), 'Goal two');
  assert.equal(contents.get(mapPath).match(/- "/g).length, 2);
  assert.equal((await repo.readMap(mapPath)).title, 'Cooking again');
});
integrationTest('math repair rewrites note bodies only, skips changed notes, and is idempotent', async () => {
  const { repo, contents, files, app } = fixture();
  const { planMathRepair, applyMathRepair, repairNoteMath } = load('experiences/visual-map/math-repair.ts');
  const a = await topicNote(repo, 'A', 'model-a', 'map-a'); const b = await topicNote(repo, 'B', 'model-a', 'map-b'); const c = await topicNote(repo, 'C', 'model-a', 'map-c');
  const math = 'Energy \\(E=mc^2\\) and\n\\[\na+b\n\\]\n\n`\\(code\\)`\n\n```\n\\(fenced\\)\n```\n\n\\[text\\](url)\n';
  contents.set(a.path, contents.get(a.path) + '\n' + math);
  contents.set(b.path, contents.get(b.path) + '\n' + math);
  const fmOf = text => text.match(/^---\n[\s\S]*?\n---\n/)[0];
  const frontA = fmOf(contents.get(a.path)).replace('---\n', '---\nnote: \\(keep\\)\n');
  contents.set(a.path, contents.get(a.path).replace(fmOf(contents.get(a.path)), frontA));
  // A non-VAM file with math is not offered.
  files.set('Other/plain.md', Object.assign(new obsidian.TFile('Other/plain.md'), {})); contents.set('Other/plain.md', math);
  const topicFiles = await repo.markedFiles('agent-map-node');
  assert.equal(topicFiles.some(f => f.path === 'Other/plain.md'), false);
  const plan = await planMathRepair(app.vault, topicFiles);
  assert.equal(plan.items.length, 2); assert.ok(plan.examples.length <= 5);
  // Cancel: planning alone writes nothing.
  assert.equal(contents.get('Other/plain.md'), math); assert.ok(contents.get(a.path).includes('\\(E=mc^2\\)'));
  // b changes on disk between preview and write -> skipped.
  contents.set(b.path, contents.get(b.path) + '\nedited later\n');
  const beforeFront = fmOf(contents.get(a.path)); const beforeC = contents.get(c.path);
  const result = await applyMathRepair(app.vault, plan);
  assert.deepEqual(plain(result), { changed: 1, skipped: 1 });
  const after = contents.get(a.path);
  assert.equal(fmOf(after), beforeFront, 'frontmatter byte-identical');
  assert.ok(after.includes('Energy $E=mc^2$ and\n$$\na+b\n$$'));
  assert.ok(after.includes('`\\(code\\)`') && after.includes('```\n\\(fenced\\)\n```') && after.includes('\\[text\\](url)'));
  assert.ok(contents.get(b.path).includes('\\(E=mc^2\\)'), 'changed note untouched');
  assert.equal(contents.get(c.path), beforeC); assert.equal(contents.get('Other/plain.md'), math);
  // Idempotent: a second pass over the repaired note finds nothing, and the repair is a fixed point.
  assert.equal(repairNoteMath(after), after);
  const again = await planMathRepair(app.vault, [files.get(a.path)]);
  assert.equal(again.items.length, 0);
});
integrationTest('math repair keeps CRLF frontmatter byte-identical and handles notes without frontmatter', () => {
  const { repairNoteMath } = load('experiences/visual-map/math-repair.ts');
  const crlf = '---\r\ntitle: \\(x\\)\r\n---\r\nSee \\(a\\)\r\n';
  assert.equal(repairNoteMath(crlf), '---\r\ntitle: \\(x\\)\r\n---\r\nSee $a$\r\n');
  assert.equal(repairNoteMath('See \\(a\\)'), 'See $a$');
  assert.equal(repairNoteMath('No math here'), 'No math here');
});
integrationTest('math repair keeps a leading BOM and treats the frontmatter after it as frontmatter', () => {
  const { repairNoteMath } = load('experiences/visual-map/math-repair.ts');
  assert.equal(repairNoteMath('﻿---\ntitle: \\(x\\)\n---\nSee \\(a\\)\n'), '﻿---\ntitle: \\(x\\)\n---\nSee $a$\n');
});
integrationTest('math repair repairs a BOM note when read() drops the BOM but process() keeps it, and a second run finds nothing', async () => {
  const { repo, contents, files, app } = fixture();
  const { planMathRepair, applyMathRepair } = load('experiences/visual-map/math-repair.ts');
  const n = await topicNote(repo, 'Bom', 'model-a', 'map-bom');
  const text = contents.get(n.path) + '\nSee \\(a\\)\n';
  contents.set(n.path, '﻿' + text);
  const vault = { ...app.vault, read: async file => contents.get(file.path).replace(/^﻿/, '') };
  const plan = await planMathRepair(vault, [files.get(n.path)]);
  assert.equal(plan.items.length, 1);
  assert.deepEqual(plain(await applyMathRepair(vault, plan)), { changed: 1, skipped: 0 });
  const after = contents.get(n.path);
  assert.ok(after.startsWith('﻿---\n') && after.endsWith('See $a$\n'));
  assert.equal(after.match(/^﻿---\n[\s\S]*?\n---\n/)[0], ('﻿' + text).match(/^﻿---\n[\s\S]*?\n---\n/)[0]);
  assert.equal((await planMathRepair(vault, [files.get(n.path)])).items.length, 0);
});

// ---- Simplified Chinese interface (multilingual P3): notes only ever carry zh-TW or en fixed text, never "预览". ----
const vaultText = contents => [...contents.values()].join('\n');
const countOf = (text, pattern) => (text.match(pattern) ?? []).length;
const SIMPLIFIED_FIXED_TEXT = /预览|尚未形成结论|所属主题|来源议题|核心结论/;
integrationTest('a Simplified Chinese interface creates notes with Traditional fixed text and never writes 预览', async () => {
  const { repo, contents } = fixture('zh-CN');
  const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
  const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(note); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  await repo.updateNote(note.path, { summary: '简体结论', detail: '正文', sourcePaths: ['Source.md'] });
  await repo.rebuildDerivedData();
  const markdown = contents.get(note.path);
  assert.match(markdown, /> \[!info\]- 預覽\n> 简体结论/, 'the Preview section heading is the zh-TW one');
  assert.equal(countOf(markdown, /\[!info\]- 預覽/g), 1);
  assert.equal(countOf(markdown, /Preview/g), 0);
  assert.match(markdown, /- 所屬主題：\[\[/, 'relation labels are zh-TW');
  assert.doesNotMatch(vaultText(contents), SIMPLIFIED_FIXED_TEXT, 'no Simplified fixed text anywhere in the vault');
  assert.equal(countOf(vaultText(contents), /预览/g), 0, 'vault grep for 预览 finds nothing');
  const copy = await repo.duplicateNote(note.path, map, mapPath);
  assert.doesNotMatch(contents.get(copy.path), SIMPLIFIED_FIXED_TEXT);
  assert.equal((await repo.readNote(note.path)).preview, '简体结论');
});
integrationTest('switching the interface to Simplified Chinese keeps exactly one Preview section per note, in the note language', async () => {
  for (const [created, heading, other, summary] of [['zh-TW', '預覽', 'Preview', '繁體結論'], ['en', 'Preview', '預覽', 'English conclusion']]) {
    const { repo, contents } = fixture(created);
    const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
    const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
    map.nodes.push(note); await repo.saveMap(mapPath, map);
    await repo.updateNote(note.path, { summary });
    repo.settings.language = 'zh-CN';
    await repo.rebuildDerivedData();
    await repo.updateNote(note.path, { summary: `${summary} v2`, preview: `${summary} v2`, detail: 'More detail' });
    await repo.rebuildDerivedData();
    const markdown = contents.get(note.path);
    assert.equal(countOf(markdown, new RegExp(`\\[!info\\]- ${heading}`, 'g')), 1, `${created}: one ${heading}`);
    assert.equal(countOf(markdown, new RegExp(`${other}`, 'g')), 0, `${created}: no ${other}`);
    assert.equal(countOf(markdown, /预览/g), 0, `${created}: no 预览`);
    assert.equal((await repo.readNote(note.path)).preview, `${summary} v2`);
  }
});
integrationTest('switching the interface language never rewrites an existing note (content hash)', async () => {
  const crypto = require('node:crypto');
  const hashes = contents => Object.fromEntries([...contents].map(([file, text]) => [file, crypto.createHash('sha256').update(text).digest('hex')]));
  for (const created of ['zh-TW', 'en']) {
    const { repo, contents } = fixture(created);
    const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
    const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
    map.nodes.push(note); await repo.saveMap(mapPath, map);
    await repo.updateNote(note.path, { summary: 'Conclusion', detail: 'Detail', sourcePaths: ['Source.md'] });
    await repo.rebuildDerivedData();
    const before = hashes(contents);
    for (const next of ['zh-CN', 'en', 'zh-TW', 'zh-CN']) {
      repo.settings.language = next;
      assert.deepEqual(hashes(contents), before, `${created} -> ${next}: switching alone writes nothing`);
      await repo.rebuildDerivedData();
      assert.deepEqual(hashes(contents), before, `${created} -> ${next}: a rebuild after the switch keeps every note as it was`);
    }
  }
});
// ---- hypothesis-evidence: topic-kind and hypothesis-strength frontmatter ----
test('hypothesis-evidence: readTopicKind and readHypothesisStrength treat invalid values as ordinary topic / weak', () => {
  const { readTopicKind, readHypothesisStrength } = load('note-values.ts');
  assert.equal(readTopicKind({}), 'topic');
  for (const bad of ['Hypothesis', 'fact', '', 5, null, ['hypothesis']]) assert.equal(readTopicKind({ 'topic-kind': bad }), 'topic');
  assert.equal(readTopicKind({ 'topic-kind': 'hypothesis' }), 'hypothesis');
  assert.equal(readHypothesisStrength({ 'topic-kind': 'hypothesis' }), 'weak', 'missing strength is weak');
  for (const bad of ['huge', '', 2, null, ['strong']]) assert.equal(readHypothesisStrength({ 'topic-kind': 'hypothesis', 'hypothesis-strength': bad }), 'weak');
  for (const ok of ['weak', 'medium', 'strong']) assert.equal(readHypothesisStrength({ 'topic-kind': 'hypothesis', 'hypothesis-strength': ok }), ok);
  assert.equal(readHypothesisStrength({ 'hypothesis-strength': 'strong' }), undefined, 'a non-hypothesis ignores a strength');
  assert.equal(readHypothesisStrength({ 'topic-kind': 'bogus', 'hypothesis-strength': 'strong' }), undefined);
});
integrationTest('hypothesis-evidence: createNote writes the hypothesis keys only when asked, and readNote reads them back', async () => {
  const { repo, contents } = fixture(); const mapDoc = { ...map([]), id: 'map-a' };
  const plainNote = await repo.createNote('Fact', 'model-a', mapDoc, 'Map.md', 'workspace');
  assert.doesNotMatch(contents.get(plainNote.path), /topic-kind|hypothesis-strength/, 'an ordinary topic writes neither key');
  const read = await repo.readNote(plainNote.path); assert.equal(read.topicKind, undefined); assert.equal(read.hypothesisStrength, undefined);
  const h = await repo.createNote('Claim', 'model-a', mapDoc, 'Map.md', 'workspace', { hypothesis: true });
  assert.match(contents.get(h.path), /topic-kind: hypothesis/); assert.match(contents.get(h.path), /hypothesis-strength: weak/);
  const note = await repo.readNote(h.path); assert.equal(note.topicKind, 'hypothesis'); assert.equal(note.hypothesisStrength, 'weak');
});
integrationTest('hypothesis-evidence: writeHypothesisStrength changes only its key, keeps updated, and survives note updates', async () => {
  const { repo, contents } = fixture(); const mapDoc = { ...map([]), id: 'map-a' };
  const h = await repo.createNote('Claim', 'model-a', mapDoc, 'Map.md', 'workspace', { hypothesis: true });
  const before = contents.get(h.path); const updated = (await repo.readNote(h.path)).updated;
  await repo.writeHypothesisStrength(h.path, 'strong');
  const after = contents.get(h.path);
  assert.equal(after, before.replace('hypothesis-strength: weak', 'hypothesis-strength: "strong"'), 'only that line changes');
  assert.equal((await repo.readNote(h.path)).hypothesisStrength, 'strong'); assert.equal((await repo.readNote(h.path)).updated, updated);
  await repo.updateNote(h.path, { status: 'completed' });
  const kept = await repo.readNote(h.path); assert.equal(kept.topicKind, 'hypothesis'); assert.equal(kept.hypothesisStrength, 'strong');
  contents.set(h.path, after.replace('"strong"', 'bogus'));
  assert.equal((await repo.readNote(h.path)).hypothesisStrength, 'weak', 'an invalid stored strength reads as weak');
});
// ---- hypothesis-evidence (V1.6 P9): six topic kinds in notes ----
const HE_KINDS = ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion'];
test('hypothesis-evidence: readTopicKind reads the six kinds and treats fact / number / list as an ordinary topic', () => {
  const { readTopicKind, TOPIC_KINDS } = load('note-values.ts');
  assert.deepEqual([...TOPIC_KINDS], HE_KINDS);
  for (const kind of HE_KINDS) assert.equal(readTopicKind({ 'topic-kind': kind }), kind);
  for (const bad of ['fact', 'Action', 'topic ', 5, null, true, ['action'], {}]) assert.equal(readTopicKind({ 'topic-kind': bad }), 'topic');
  assert.equal(readTopicKind({}), 'topic');
});
test('hypothesis-evidence: hypothesis-strength maybe reads as weak, and only a hypothesis has a strength', () => {
  const { readHypothesisStrength } = load('note-values.ts');
  assert.equal(readHypothesisStrength({ 'topic-kind': 'hypothesis', 'hypothesis-strength': 'maybe' }), 'weak');
  for (const kind of ['topic', 'action', 'atomic', 'evidence', 'conclusion']) assert.equal(readHypothesisStrength({ 'topic-kind': kind, 'hypothesis-strength': 'strong' }), undefined, kind);
});
integrationTest('hypothesis-evidence: createNote writes topic-kind for each of the six kinds; only a hypothesis gets a strength', async () => {
  const { repo, contents } = fixture(); const mapDoc = { ...map([]), id: 'map-a' };
  for (const kind of HE_KINDS) {
    const n = await repo.createNote(`K ${kind}`, 'model-a', mapDoc, 'Map.md', 'workspace', { topicKind: kind });
    const text = contents.get(n.path);
    if (kind === 'topic') assert.doesNotMatch(text, /topic-kind|hypothesis-strength/, 'an ordinary topic writes neither key');
    else assert.match(text, new RegExp(`^topic-kind: ${kind}$`, 'm'));
    if (kind === 'hypothesis') assert.match(text, /^hypothesis-strength: weak$/m);
    else assert.doesNotMatch(text, /hypothesis-strength/, kind);
  }
});
integrationTest('hypothesis-evidence: readNote returns topicKind for the five non-ordinary kinds and strength only for a hypothesis', async () => {
  const { repo } = fixture(); const mapDoc = { ...map([]), id: 'map-a' };
  for (const kind of HE_KINDS) {
    const n = await repo.createNote(`R ${kind}`, 'model-a', mapDoc, 'Map.md', 'workspace', { topicKind: kind });
    const read = await repo.readNote(n.path);
    assert.equal(read.topicKind, kind === 'topic' ? undefined : kind, kind);
    assert.equal(read.hypothesisStrength, kind === 'hypothesis' ? 'weak' : undefined, kind);
  }
});
integrationTest('hypothesis-evidence: writeTopicKind to topic removes only the topic-kind line, every other byte and updated stay', async () => {
  const { repo, contents } = fixture(); const mapDoc = { ...map([]), id: 'map-a' };
  const n = await repo.createNote('Claim', 'model-a', mapDoc, 'Map.md', 'workspace', { topicKind: 'action' });
  const before = contents.get(n.path); const updated = (await repo.readNote(n.path)).updated;
  assert.match(before, /^topic-kind: action\n/m);
  await repo.writeTopicKind(n.path, 'topic');
  assert.equal(contents.get(n.path), before.replace('topic-kind: action\n', ''), 'only the topic-kind line is gone');
  assert.equal((await repo.readNote(n.path)).updated, updated);
  assert.equal((await repo.readNote(n.path)).topicKind, undefined);
});
integrationTest('hypothesis-evidence: writeTopicKind changes only its line; hypothesis -> evidence -> hypothesis keeps the strength in the file', async () => {
  const { repo, contents } = fixture(); const mapDoc = { ...map([]), id: 'map-a' };
  const n = await repo.createNote('Claim', 'model-a', mapDoc, 'Map.md', 'workspace', { topicKind: 'hypothesis' });
  await repo.writeHypothesisStrength(n.path, 'strong');
  const start = contents.get(n.path); const updated = (await repo.readNote(n.path)).updated;
  await repo.writeTopicKind(n.path, 'evidence');
  const mid = contents.get(n.path);
  assert.equal(mid.split('\n').filter(l => !/^topic-kind:/.test(l)).join('\n'), start.split('\n').filter(l => !/^topic-kind:/.test(l)).join('\n'), 'no other line differs');
  assert.match(mid, /hypothesis-strength: "?strong"?/);
  const asEvidence = await repo.readNote(n.path); assert.equal(asEvidence.topicKind, 'evidence'); assert.equal(asEvidence.hypothesisStrength, undefined);
  await repo.writeTopicKind(n.path, 'hypothesis');
  const back = await repo.readNote(n.path);
  assert.equal(back.topicKind, 'hypothesis'); assert.equal(back.hypothesisStrength, 'strong', 'the strength came back'); assert.equal(back.updated, updated);
  assert.equal(contents.get(n.path).replace('topic-kind: "hypothesis"', 'topic-kind: hypothesis'), start, 'back to the start, byte for byte (setFrontmatterKeys only adds quotes on the rewritten line)');
});
integrationTest('hypothesis-evidence: switching to a hypothesis without a strength line does not add one and reads weak', async () => {
  const { repo, contents } = fixture(); const mapDoc = { ...map([]), id: 'map-a' };
  const n = await repo.createNote('Claim', 'model-a', mapDoc, 'Map.md', 'workspace', { topicKind: 'atomic' });
  await repo.writeTopicKind(n.path, 'hypothesis');
  assert.doesNotMatch(contents.get(n.path), /hypothesis-strength/);
  assert.equal((await repo.readNote(n.path)).hypothesisStrength, 'weak');
});
