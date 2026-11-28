const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, load, plain, obsidian } = require('../support.cjs');
test('reference batches include every selected Markdown source, deduplicate overlaps, split long files, and keep citations', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [
    { id: 'map-a', name: 'Map A', location: 'Maps/A/Map.md', documents: [{ key: 'same', path: 'Maps/A/one.md', content: 'A'.repeat(35_000) }, { key: 'external', path: '/Volumes/Refs/source.md', external: true, content: 'external evidence' }] },
    { id: 'folder', name: 'Folder', location: '/Volumes/Refs', documents: [{ key: 'same', path: 'Maps/A/one.md', content: 'duplicate' }, ...Array.from({ length: 100 }, (_, index) => ({ key: `note-${index}`, path: `Folder/note-${index}.md`, content: `unique-sentinel-${index}` }))] }
  ];
  const batches = api.referenceBatches(groups, 10_000, 12_000);
  const joined = batches.join('\n');
  assert.ok(batches.length > 1); assert.match(joined, /\[S1\] Vault Markdown; cite as an Obsidian wikilink: Maps\/A\/one\.md/);
  assert.match(joined, /\[S2\] external Markdown; cite the exact path as plain text: \/Volumes\/Refs\/source\.md/);
  assert.match(joined, /unique-sentinel-0/); assert.match(joined, /unique-sentinel-99/);
  assert.equal(joined.match(/duplicate/g), null);
  assert.match(joined, /part 1\/4/); assert.match(joined, /part 4\/4/);
  assert.match(api.referenceCatalog(groups), /\[S2\] External file \(plain path\): \/Volumes\/Refs\/source\.md/);
  const label = path => api.sourceFootnoteLabel(path);
  const one = label('Maps/A/one.md');
  assert.match(one, /^src-[0-9a-z]+$/);
  assert.equal(api.resolveDetailReferences('See [[source.md]]', groups), 'See External source: /Volumes/Refs/source.md');
  // Intentional contract change: [S#] becomes a numbered footnote plus one definition, not a long [[path]] link.
  assert.equal(api.resolveDetailReferences('Vault [S1], external [S2]', groups), 'Vault [^1], external [^2]\n\n[^1]: [[Maps/A/one.md|one]]%%vam-src:-:13c41861%%\n[^2]: External source: /Volumes/Refs/source.md\n');
  const namesake = [{ id: 'mixed', documents: [{ path: 'Vault/source.md', content: 'vault' }, { path: '/Volumes/Refs/source.md', external: true, content: 'external' }] }];
  assert.equal(api.resolveDetailReferences('Vault [S1], external [S2]', namesake), 'Vault [^1], external [^2]\n\n[^1]: [[Vault/source.md|source]]%%vam-src:-:2e33365d%%\n[^2]: External source: /Volumes/Refs/source.md\n');
  assert.equal(api.resolveDetailReferences('Ambiguous [[source.md]]', namesake), 'Ambiguous Source to confirm: source.md');
  assert.equal(api.resolveDetailReferences('Exact [[Vault/source.md]]', namesake), 'Exact [[Vault/source.md]]');
  assert.equal(api.resolveDetailReferences('Unknown [S3]', namesake), 'Unknown Source to confirm: [S3]');
  assert.equal(api.resolveDetailReferences('See [[same.md]]', [{ id: 'a', documents: [{ path: '/a/same.md', external: true, content: '' }, { path: '/b/same.md', external: true, content: '' }] }]), 'See Source to confirm: same.md');
});
test('reference batches: 129k characters of several files fit one batch; over 160k splits; one file over 150k is split into parts', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const docs = sizes => ({ id: 'g', name: 'g', location: 'l', documents: sizes.map((size, index) => ({ path: `n${index}.md`, content: 'a'.repeat(size) })) });
  const one = api.referenceBatches([docs([16_000, 16_000, 16_000, 16_000, 16_000, 16_000, 16_000, 17_000])]);
  assert.equal(one.length, 1); assert.match(one[0], /\[S8\]/);
  assert.equal(api.referenceBatches([docs([100_000, 100_000])]).length, 2);
  const parts = api.referenceBatches([docs([150_001])]).join('\n');
  assert.match(parts, /part 1\/2/); assert.match(parts, /part 2\/2/);
  assert.doesNotMatch(api.referenceBatches([docs([150_000])]).join('\n'), /part 1/);
});
test('source footnotes: numbered by first use, one definition per source, placed in the evidence section', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }, { path: 'Maps/B/two.md', content: '' }, { path: '/Volumes/Refs/x.md', external: true, content: '' }] }];
  const zh = '### 核心結論\n\n甲[S2]乙[S1]丙[S2]外部[S3]\n\n### 證據與來源\n\n- 文字證據\n\n### 取捨與限制\n\n限制';
  const out = api.resolveDetailReferences(zh, groups);
  assert.ok(out.includes('甲[^1]乙[^2]丙[^1]外部[^3]'));
  assert.ok(out.includes('- 文字證據\n\n[^1]: [[Maps/B/two.md|two]]%%vam-src:-:1aee8d83%%\n[^2]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n[^3]: External source: /Volumes/Refs/x.md\n\n### 取捨與限制'));
  assert.equal(out.split('[^1]:').length, 2);
  const en = api.resolveDetailReferences('### Core conclusions\n\nA[S2]\n\n### Evidence and sources\n\nnotes\n\n### Open questions\n\nq', groups);
  assert.ok(en.includes('notes\n\n[^1]: [[Maps/B/two.md|two]]%%vam-src:-:1aee8d83%%\n\n### Open questions'));
  // Absent evidence section: appended at the end.
  assert.equal(api.resolveDetailReferences('Body[S1]', groups), 'Body[^1]\n\n[^1]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n');
  // A definition the reply already wrote is reused, not duplicated; unused definitions are dropped.
  assert.equal(api.resolveDetailReferences('Body[S1]\n\n[^9]: [[Maps/Z/unused.md|unused]]', groups), 'Body[^1]\n\n[^1]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n');
  assert.equal(api.resolveDetailReferences('Body[^7]\n\n[^7]: [[Maps/A/one.md|one]]', groups), 'Body[^1]\n\n[^1]: [[Maps/A/one.md|one]]\n');
  // Summary: markers removed, no footnotes.
  assert.equal(api.resolveSummaryReferences('結論 [S1]。重點[S2] [S9] end', groups), '結論。重點 end');
  assert.equal(api.resolveSummaryReferences('See [[x.md]] [S1]', groups), 'See External source: /Volumes/Refs/x.md');
  // canonicalDetail keeps definitions inside the evidence section.
  const { canonicalDetail } = load('ai/result-utils.ts', { obsidian });
  const evidence = canonicalDetail(out, 'zh-TW').split('### 來源')[1].split('### 更新紀錄')[0];
  assert.ok(evidence.includes('[^1]:') && evidence.includes('[^2]:') && evidence.includes('[^3]:'));
  assert.ok(canonicalDetail(api.resolveDetailReferences('### Core conclusions\n\nA[S1]', groups), 'en').includes('### Sources\n\n[^1]: [[Maps/A/one.md|one]]'));
});
test('source footnotes survive reruns: numbers stay consistent, kept references get their definitions back, dead ones become a source to confirm', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }, { path: 'Maps/B/two.md', content: '' }] }];
  const previous = 'Old[^1] and[^2]\n\n[^1]: [[Maps/Old/gone.md|gone]]\n[^2]: [[Maps/A/one.md|one]]';
  // The reply keeps [^1] and [^2] without definitions and cites one.md again as [S1] and two.md as [S2].
  const rerun = api.resolveDetailReferences('New[S2] kept[^1] again[S1] same[^2]', groups, previous);
  assert.equal(rerun, 'New[^1] kept[^2] again[^3] same[^3]\n\n[^1]: [[Maps/B/two.md|two]]%%vam-src:-:1aee8d83%%\n[^2]: [[Maps/Old/gone.md|gone]]\n[^3]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n');
  // A reference after which a colon follows mid-line is still a reference.
  assert.equal(api.resolveDetailReferences('Fact[S1]: more', groups), 'Fact[^1]: more\n\n[^1]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n');
  // A source footnote nothing can restore becomes a source to confirm; a footnote VAM does not own stays as written.
  assert.equal(api.resolveDetailReferences('C[^src-dead000]', []), 'C Source to confirm: src-dead000');
  assert.equal(api.resolveDetailReferences('C[^4]', []), 'C[^4]');
  // The same note with and without a display name gets one number.
  assert.equal(api.resolveDetailReferences('A[^7] B[S1]\n\n[^7]: [[Maps/A/one.md]]', groups), 'A[^1] B[^1]\n\n[^1]: [[Maps/A/one.md]]\n');
  // Summary punctuation left by removed markers is tidied.
  assert.equal(api.resolveSummaryReferences('[S1] 開頭（[S2]）、see [S1], [S2].', groups), '開頭、see.');
  assert.equal(api.resolveSummaryReferences('結論（[S1]、[S2]）。', groups), '結論。');
  assert.equal(api.resolveSummaryReferences('依據 [S1]、[S2]。A [S1], B', groups), '依據。A, B');
  // Only marker runs are removed; ordinary brackets and punctuation stay as written.
  for (const text of ['Call foo() then bar()', 'Use .NET and a .gitignore file', 'smile :) ok', 'U.S. (e.g.) 3, 4.'])
    assert.equal(api.resolveSummaryReferences(text, groups), text);
});
test('canonicalDetail gathers source footnote definitions into the evidence section', () => {
  const { canonicalDetail } = load('ai/result-utils.ts', { obsidian });
  const out = canonicalDetail('### Core conclusions\n\nA[^1]\n\n### Update log\n\n- today\n[^1]: [[a.md|a]]', 'en');
  assert.ok(out.includes('### Sources\n\n[^1]: [[a.md|a]]\n\n### Update log'));
  assert.ok(out.includes('### Update log\n\n- today'));
  assert.equal(out.split('[^1]:').length, 2);
  const flat = canonicalDetail('Body[^1]\n\n[^1]: [[a.md|a]]', 'en');
  assert.ok(flat.startsWith('### Core conclusions\n\nBody[^1]\n\n### Background and mechanism'));
  assert.ok(flat.includes('### Sources\n\n[^1]: [[a.md|a]]'));
});
test('source footnotes leave code, links and the writer\'s own footnotes untouched', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const { canonicalDetail } = load('ai/result-utils.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }] }];
  const code = 'Match `/[^a-z]+/` here[S1].\n\n```js\nconst re = /[^0-9]/;\n[^x]: code line\n```\n\nSee [^foo](https://x.y) and ![^img](a.png).';
  const out = api.resolveDetailReferences(code, groups);
  assert.ok(out.startsWith('Match `/[^a-z]+/` here[^1].\n\n```js\nconst re = /[^0-9]/;\n[^x]: code line\n```\n\nSee [^foo](https://x.y) and ![^img](a.png).'));
  assert.ok(out.endsWith('[^1]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n'));
  // Without sources the resolver may still run (the detail contains "[^"); it must change nothing here.
  const plain = 'Use `[^x]` and\n\n```\n[^1]: not a footnote\n```';
  assert.equal(api.resolveDetailReferences(plain, []), plain);
  // The writer's own footnote keeps its label, text and continuation line; source numbers skip its number.
  const own = 'Claim[^1] and fact[S1].\n\n[^1]: My own note\n    continued here';
  assert.equal(api.resolveDetailReferences(own, groups), 'Claim[^1] and fact[^2].\n\n[^1]: My own note\n    continued here\n\n[^2]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n');
  // canonicalDetail never moves lines out of a code block.
  const canon = canonicalDetail('### Core conclusions\n\n```\n[^x]: [[a.md|a]]\n```', 'en');
  assert.ok(canon.includes('```\n[^x]: [[a.md|a]]\n```'));
  assert.ok(!canon.split('### Sources')[1].split('### ')[0].includes('[^x]'));
});
test('source footnotes never reuse the number of a footnote kept as written', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }, { path: 'Maps/B/two.md', content: '' }] }];
  // The reply kept the writer's [^2] but dropped its definition, and cites two new sources.
  const out = api.resolveDetailReferences('Claim[^2] fact[S1] other[S2]', groups, 'Claim[^2]\n\n[^2]: my own remark');
  assert.equal(out, 'Claim[^2] fact[^1] other[^3]\n\n[^1]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n[^3]: [[Maps/B/two.md|two]]%%vam-src:-:1aee8d83%%\n');
  assert.equal(api.resolveDetailReferences('Claim[^1] fact[S1]', groups), 'Claim[^1] fact[^2]\n\n[^2]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n');
  // A fence opened with an info string is not closed by another info-string line.
  const fenced = '```js\nx\n```js\ny\n```\n\nAfter[S1]';
  assert.equal(api.resolveDetailReferences(fenced, groups), '```js\nx\n```js\ny\n```\n\nAfter[^1]\n\n[^1]: [[Maps/A/one.md|one]]%%vam-src:-:1aee8d83%%\n');
  // The same note written with and without ".md" shares one number.
  assert.equal(api.resolveDetailReferences('A[^7] B[S1]\n\n[^7]: [[Maps/A/one]]', groups), 'A[^1] B[^1]\n\n[^1]: [[Maps/A/one]]\n');
});
test('source footnotes change nothing they do not own: a corpus round-trips unchanged and processing is idempotent', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }, { path: '/Volumes/Refs/x.md', external: true, content: '' }] }];
  const root = path.join(__dirname, '..', '..');
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.md')) files.push(full); } };
  for (const dir of ['samples', 'tests', 'experiences', 'core', 'ai']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  const corpus = [
    ...files.map(file => fs.readFileSync(file, 'utf8')),
    'Regex `/[^a-z]+/` and ``a`b [^1]`` stay.\n\n```js\nconst re = /[^0-9]/;\n[^x]: code\n```',
    'Mine[^1] and[^note]\n\n[^1]: My remark\n    more\n[^note]: Another\n\nLink [^foo](https://x.y) and ![^img](a.png)',
    '~~~\n[^1]: [[a.md|a]]\n~~~\n\n|a|b|\n|-|-|\n|[^x]|y|'
  ];
  for (const text of corpus) {
    if (/\[S\d+\]/.test(text)) continue;
    const once = api.resolveDetailReferences(text, []);
    const owned = text.split('\n').some(line => /^\[\^[^\]\s]+\]:\s*(\[\[[^\]]+\]\]\s*$|External source:|外部來源：)/.test(line) || /\[\^src-/.test(line));
    if (!owned) assert.equal(once.replace(/\n{2,}/g, '\n\n'), text.trimEnd().replace(/\n{2,}/g, '\n\n'), text.slice(0, 80));
    assert.equal(api.resolveDetailReferences(once, [], once), once, `idempotent: ${text.slice(0, 80)}`);
  }
  const cited = api.resolveDetailReferences('### Core conclusions\n\nA[S2] b[S1] c[S2]\n\n### Evidence and sources\n\nnotes', groups);
  assert.equal(api.resolveDetailReferences(cited, groups, cited), cited);
});
test('resolveDetailReferences: a copied footnote one note defines becomes that source; two notes defining it is ambiguous and removed; one note defining it becomes that source; code is untouched', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const docs = (...contents) => [{ id: 'g', name: 'g', location: '', documents: contents.map((content, i) => ({ path: `Notes/N${i}.md`, content })) }];
  const ambiguous = api.resolveDetailReferences('Claim[^1] ok', docs('a[^1]\n\n[^1]: x', 'b[^1]\n\n[^1]: y'));
  assert.doesNotMatch(ambiguous, /\[\^/);
  const single = api.resolveDetailReferences('Claim[^1] ok', docs('a[^1]\n\n[^1]: x', 'b'));
  assert.equal(single, 'Claim[^1] ok\n\n[^1]: [[Notes/N0.md|N0]]%%vam-src:-:2cdaacfa%%\n');
  const code = api.resolveDetailReferences('Claim `[^7]`\n\n```\n[^8]\n```', docs('plain'));
  assert.equal(code, 'Claim `[^7]`\n\n```\n[^8]\n```');
});
test('resolveDetailReferences: a child that uses [^1] without defining it is dropped; the writer\'s own earlier footnote is never re-pointed at a child', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const docs = (...contents) => [{ id: 'g', name: 'g', location: '', documents: contents.map((content, i) => ({ path: `Notes/N${i}.md`, content })) }];
  const undef = api.resolveDetailReferences('Claim[S1] copied[^1]', docs('child says[^1] with no definition'));
  assert.doesNotMatch(undef, /copied\[\^1\]/);
  const labels = [...undef.matchAll(/\[\^([^\]\s]+)\](?!:)/g)].map(m => m[1]), defs = new Set([...undef.matchAll(/^\[\^([^\]\s]+)\]:/gm)].map(m => m[1]));
  for (const label of labels) assert.ok(defs.has(label), `[^${label}] defined`);
  const previous = 'Claim[^2]\n\n[^2]: my own remark';
  assert.equal(api.resolveDetailReferences('Claim[^2]', docs('a[^2]\n\n[^2]: child'), previous), 'Claim[^2]');
  assert.equal(api.resolveDetailReferences('Claim[^2]', docs('a[^2]\n\n[^2]: x', 'b[^2]\n\n[^2]: y'), previous), 'Claim[^2]');
});

test('external references: same relative file under two labels gets two footnote targets and two catalog lines, never merged', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [
    { id: 'external:docs', name: 'docs', location: 'docs', documents: [{ path: 'docs/x.md', key: 'external:docs/x.md', external: true, content: 'ALPHA' }] },
    { id: 'external:docs#2', name: 'docs#2', location: 'docs#2', documents: [{ path: 'docs#2/x.md', key: 'external:docs#2/x.md', external: true, content: 'BETA' }] },
    { id: 'folder:docs', name: 'docs', location: 'docs', documents: [{ path: 'docs/x.md', key: 'docs/x.md', content: 'VAULT' }] }
  ];
  const catalog = api.referenceCatalog(groups);
  assert.match(catalog, /\[S1\] External file \(plain path\): docs\/x\.md/); assert.match(catalog, /\[S2\] External file \(plain path\): docs#2\/x\.md/);
  assert.match(catalog, /\[S3\] Vault note \(wikilink\): docs\/x\.md/, 'a vault note with the same path is not swallowed by the external one');
  const detail = api.resolveDetailReferences('A [S1]. B [S2]. C [S3].\n\n### Sources\n', groups);
  assert.match(detail, /\[\^1\]: .*docs\/x\.md/); assert.match(detail, /\[\^2\]: .*docs#2\/x\.md/); assert.match(detail, /\[\^3\]: \[\[docs\/x\.md\|x\]\]/);
});

// V3.3 #05: a new source footnote keeps the note's node id and revision as `%%vam-src:<node-id|->:<rev8>%%`.
test('source identity: a new definition carries the node id and the body revision; a non-VAM note writes "-"; frontmatter and line endings do not change the revision', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const vam = '---\nagent-map-node: true\nnode-id: "3f2a9c1e-0b7d-4e21-9a55-1c2d3e4f5a6b"\n---\nBody text\n';
  const rev = api.sourceRevision(vam);
  assert.match(rev, /^[0-9a-f]{8}$/);
  assert.equal(api.sourceNodeId(vam), '3f2a9c1e-0b7d-4e21-9a55-1c2d3e4f5a6b');
  assert.equal(api.sourceNodeId('Body text\n'), undefined);
  assert.equal(api.sourceRevision('---\r\nnode-id: other\r\nupdated: 2026\r\n---\r\nBody text\r\n\r\n'), rev, 'CRLF, frontmatter and trailing blank lines are not part of the body');
  assert.notEqual(api.sourceRevision(vam.replace('Body text', 'Body text!')), rev);
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: vam }, { path: 'Notes/plain.md', content: 'Body text' }, { path: '/x/e.md', external: true, content: 'e' }] }];
  assert.equal(api.resolveDetailReferences('A[S1] B[S2] C[S3]', groups), `A[^1] B[^2] C[^3]\n\n[^1]: [[Maps/A/one.md|one]]%%vam-src:3f2a9c1e-0b7d-4e21-9a55-1c2d3e4f5a6b:${rev}%%\n[^2]: [[Notes/plain.md|plain]]%%vam-src:-:${rev}%%\n[^3]: External source: /x/e.md\n`);
  // A given nodeId/rev wins over the content; an id outside [A-Za-z0-9_-] is not written.
  assert.equal(api.resolveDetailReferences('A[S1]', [{ id: 'g', documents: [{ path: 'n.md', content: 'x', nodeId: 'id-1', rev: 'abcdef01' }] }]), 'A[^1]\n\n[^1]: [[n.md|n]]%%vam-src:id-1:abcdef01%%\n');
  assert.equal(api.resolveDetailReferences('A[S1]', [{ id: 'g', documents: [{ path: 'n.md', content: 'x', nodeId: 'a:b' }] }]), `A[^1]\n\n[^1]: [[n.md|n]]%%vam-src:-:${api.sourceRevision('x')}%%\n`);
});

test('source identity: old-format definitions read, re-research and canonicalize unchanged; the same source and revision re-run is byte-identical', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const { canonicalDetail, sourceFootnoteDefinition, withoutSourceIdentity } = load('ai/result-utils.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: 'one' }, { path: 'Maps/B/two.md', content: 'two' }] }];
  const fresh = `[[Maps/A/one.md|one]]%%vam-src:-:${api.sourceRevision('one')}%%`;
  assert.deepEqual(plain(sourceFootnoteDefinition(`[^1]: ${fresh}`)), { label: '1', target: fresh });
  assert.deepEqual(plain(sourceFootnoteDefinition('[^1]: [[Maps/A/one.md|one]]')), { label: '1', target: '[[Maps/A/one.md|one]]' });
  assert.equal(sourceFootnoteDefinition('[^1]: [[a]]%%vam-src:bad id:1%%'), null, 'a malformed comment is the writer\'s footnote');
  assert.equal(withoutSourceIdentity(fresh), '[[Maps/A/one.md|one]]');
  // Old detail, re-research keeps [^1] without re-citing it: the old definition comes back as written.
  const old = 'Old[^1] other[^2]\n\n[^1]: [[Maps/A/one.md|one]]\n[^2]: [[Maps/Gone/x.md|x]]';
  assert.equal(api.resolveDetailReferences('Kept[^1] new[S2]', groups, old), `Kept[^1] new[^2]\n\n[^1]: [[Maps/A/one.md|one]]\n[^2]: [[Maps/B/two.md|two]]%%vam-src:-:${api.sourceRevision('two')}%%\n`);
  // An old-format definition the reply carries is read as the same source as a fresh [S#] of that note: one number.
  assert.equal(api.resolveDetailReferences('A[^7] B[S1]\n\n[^7]: [[Maps/A/one.md|one]]', groups), 'A[^1] B[^1]\n\n[^1]: [[Maps/A/one.md|one]]\n');
  assert.equal(api.resolveDetailReferences(old, []), `${old}\n`, 'reading an old detail with no sources changes nothing');
  // Idempotent: same sources, same revision.
  const once = api.resolveDetailReferences('### Core conclusions\n\nA[S2] b[S1]\n\n### Evidence and sources\n\nnotes', groups);
  assert.equal(api.resolveDetailReferences(once, groups, once), once);
  assert.equal(api.resolveDetailReferences('### Core conclusions\n\nA[S2] b[S1]\n\n### Evidence and sources\n\nnotes', groups, once), once);
  assert.ok(canonicalDetail(once, 'en').includes(`### Sources\n\nnotes\n\n[^1]: [[Maps/B/two.md|two]]%%vam-src:-:${api.sourceRevision('two')}%%\n[^2]: ${fresh}`), 'the new format joins the sources section');
});

test('source identity: compareCitation tells same, changed, relocated (found by id after a rename or move) and missing; a namesake at another path is never the source', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const note = body => `---\nnode-id: n-1\n---\n${body}`;
  const docs = [{ path: 'Maps/A/one.md', content: note('v1') }];
  const target = api.resolveDetailReferences('A[S1]', [{ id: 'g', documents: docs }]).split('[^1]: ')[1].trim();
  const status = (t, documents) => api.compareCitation(t, documents)?.status;
  assert.equal(status(target, docs), 'same');
  assert.equal(status(target, [{ path: 'Maps/A/one.md', content: note('v2') }]), 'changed');
  assert.equal(status(target, [{ path: 'Maps/A/one.md', content: '---\nnode-id: n-1\nupdated: x\n---\nv1' }]), 'same', 'a frontmatter edit is not a content change');
  const moved = api.compareCitation(target, [{ path: 'Archive/renamed.md', content: note('v1') }]);
  assert.equal(moved.status, 'relocated'); assert.equal(moved.document.path, 'Archive/renamed.md');
  assert.equal(status(target, [{ path: 'Maps/B/one.md', content: 'v1' }]), 'missing', 'same basename at another path, no id: not the source');
  assert.equal(status(target, [{ path: 'Maps/A/one.md', external: true, content: note('v1') }]), 'missing', 'an external file is never the vault note');
  assert.equal(status(target, []), 'missing');
  // Old format: no id or revision, so only the path tells.
  assert.equal(status('[[Maps/A/one.md|one]]', docs), 'same');
  assert.equal(status('[[Maps/A/one|one]]', docs), 'same');
  assert.equal(status('[[Maps/A/one.md|one]]', [{ path: 'X/one.md', content: note('v1') }]), 'missing');
  // A non-VAM note ("-") is found by path only.
  assert.equal(status('[[Notes/p.md|p]]%%vam-src:-:00000000%%', [{ path: 'Other/p.md', content: '' }]), 'missing');
  assert.equal(api.compareCitation('External source: /x/e.md', docs), null);
});

test('source identity: two notes with one basename at different paths get two numbers; a bare name for them stays a source to confirm', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/same.md', content: 'a' }, { path: 'Maps/B/same.md', content: 'b' }] }];
  const out = api.resolveDetailReferences('A[S1] B[S2] C[[same]]', groups);
  assert.equal(out, `A[^1] B[^2] C${'Source to confirm: same'}\n\n[^1]: [[Maps/A/same.md|same]]%%vam-src:-:${api.sourceRevision('a')}%%\n[^2]: [[Maps/B/same.md|same]]%%vam-src:-:${api.sourceRevision('b')}%%\n`);
});

// V3.3 #05-x: every path that hands a note to a research as a reference document gives its footnote the source's path, node id and revision.
test('source identity (chat attachment): a note dropped on the chat is cited with its node id and the revision of the file', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const { chatResearchReferenceGroups } = load('experiences/visual-map/chat-research-sources.ts', { obsidian });
  const file = '---\nagent-map-node: true\nnode-id: rd-old\n---\nOld research body\n';
  const groups = chatResearchReferenceGroups({ files: [{ path: 'Notes/rd-old.md', content: file }], activeFile: null, snippets: [] });
  assert.equal(api.resolveDetailReferences('Claim[S1]', groups), `Claim[^1]\n\n[^1]: [[Notes/rd-old.md|rd-old]]%%vam-src:rd-old:${api.sourceRevision(file)}%%\n`);
});

test('source identity: a self-written "[S1]: [[note]]" definition (no .md) leaves one definition, VAM\'s with the identity, and the label stays one', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const path = 'Agent Workspace/Topics/Research Demo/Notes/rd-old';
  const file = '---\nagent-map-node: true\nnode-id: rd-old\n---\nOld research body\n';
  const groups = [{ id: 'g', documents: [{ path: `${path}.md`, content: file }] }];
  const identity = `[[${path}.md|rd-old]]%%vam-src:rd-old:${api.sourceRevision(file)}%%`;
  // The sample's shape: four writer footnotes, [S1] used in the body, a table and a callout, and the model's own definition line for [S1].
  const reply = `### Evidence\nOlder lab note about 20 adults.[[${path}]] [S1]\n\n| claim | source |\n|---|---|\n| small study | [S1] |\n\n> Spindle evidence is thin.[S1]\n\n### Sources\n\n[^1]: https://a.example\n[^2]: https://b.example\n[^3]: https://c.example\n[^4]: https://d.example\n\n[S1]: [[${path}]]\n`;
  const out = api.resolveDetailReferences(reply, groups);
  assert.equal(out, `### Evidence\nOlder lab note about 20 adults.[[${path}]] [^5]\n\n| claim | source |\n|---|---|\n| small study | [^5] |\n\n> Spindle evidence is thin.[^5]\n\n### Sources\n\n[^1]: https://a.example\n[^2]: https://b.example\n[^3]: https://c.example\n[^4]: https://d.example\n\n[^5]: ${identity}`);
  assert.equal(out.match(/^\[\^5\]:/gm).length, 1, 'one definition for the label');
  assert.equal(api.resolveDetailReferences(out, groups, out), out, 'the same source and revision re-run is byte-identical');
  // An ordinary line that merely starts with the marker keeps its text.
  assert.ok(api.resolveDetailReferences('[S1]: says the lab note\n', groups).includes('says the lab note'));
  // The same self-written definition with trailing words, in a list item or in a quote is dropped too.
  for (const line of [`[S1]: [[${path}]] — the lab note`, `- [S1]: [[${path}]]`, `> [S1]: [[${path}]]`])
    assert.equal(api.resolveDetailReferences(`Claim[S1]\n\n${line}\n`, groups), `Claim[^1]\n\n[^1]: ${identity}\n`, line);
});
