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
  assert.equal(api.resolveDetailReferences('Vault [S1], external [S2]', groups), 'Vault [^1], external [^2]\n\n[^1]: [[Maps/A/one.md|one]]\n[^2]: External source: /Volumes/Refs/source.md\n');
  const namesake = [{ id: 'mixed', documents: [{ path: 'Vault/source.md', content: 'vault' }, { path: '/Volumes/Refs/source.md', external: true, content: 'external' }] }];
  assert.equal(api.resolveDetailReferences('Vault [S1], external [S2]', namesake), 'Vault [^1], external [^2]\n\n[^1]: [[Vault/source.md|source]]\n[^2]: External source: /Volumes/Refs/source.md\n');
  assert.equal(api.resolveDetailReferences('Ambiguous [[source.md]]', namesake), 'Ambiguous Source to confirm: source.md');
  assert.equal(api.resolveDetailReferences('Exact [[Vault/source.md]]', namesake), 'Exact [[Vault/source.md]]');
  assert.equal(api.resolveDetailReferences('Unknown [S3]', namesake), 'Unknown Source to confirm: [S3]');
  assert.equal(api.resolveDetailReferences('See [[same.md]]', [{ id: 'a', documents: [{ path: '/a/same.md', external: true, content: '' }, { path: '/b/same.md', external: true, content: '' }] }]), 'See Source to confirm: same.md');
});
test('source footnotes: numbered by first use, one definition per source, placed in the evidence section', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }, { path: 'Maps/B/two.md', content: '' }, { path: '/Volumes/Refs/x.md', external: true, content: '' }] }];
  const zh = '### 核心結論\n\n甲[S2]乙[S1]丙[S2]外部[S3]\n\n### 證據與來源\n\n- 文字證據\n\n### 取捨與限制\n\n限制';
  const out = api.resolveDetailReferences(zh, groups);
  assert.ok(out.includes('甲[^1]乙[^2]丙[^1]外部[^3]'));
  assert.ok(out.includes('- 文字證據\n\n[^1]: [[Maps/B/two.md|two]]\n[^2]: [[Maps/A/one.md|one]]\n[^3]: External source: /Volumes/Refs/x.md\n\n### 取捨與限制'));
  assert.equal(out.split('[^1]:').length, 2);
  const en = api.resolveDetailReferences('### Core conclusions\n\nA[S2]\n\n### Evidence and sources\n\nnotes\n\n### Open questions\n\nq', groups);
  assert.ok(en.includes('notes\n\n[^1]: [[Maps/B/two.md|two]]\n\n### Open questions'));
  // Absent evidence section: appended at the end.
  assert.equal(api.resolveDetailReferences('Body[S1]', groups), 'Body[^1]\n\n[^1]: [[Maps/A/one.md|one]]\n');
  // A definition the reply already wrote is reused, not duplicated; unused definitions are dropped.
  assert.equal(api.resolveDetailReferences('Body[S1]\n\n[^9]: [[Maps/Z/unused.md|unused]]', groups), 'Body[^1]\n\n[^1]: [[Maps/A/one.md|one]]\n');
  assert.equal(api.resolveDetailReferences('Body[^7]\n\n[^7]: [[Maps/A/one.md|one]]', groups), 'Body[^1]\n\n[^1]: [[Maps/A/one.md|one]]\n');
  // Summary: markers removed, no footnotes.
  assert.equal(api.resolveSummaryReferences('結論 [S1]。重點[S2] [S9] end', groups), '結論。重點 end');
  assert.equal(api.resolveSummaryReferences('See [[x.md]] [S1]', groups), 'See External source: /Volumes/Refs/x.md');
  // canonicalDetail keeps definitions inside the evidence section.
  const { canonicalDetail } = load('main.ts', { obsidian });
  const evidence = canonicalDetail(out, 'zh-TW').split('### 證據與來源')[1].split('### 取捨與限制')[0];
  assert.ok(evidence.includes('[^1]:') && evidence.includes('[^2]:') && evidence.includes('[^3]:'));
  assert.ok(canonicalDetail(api.resolveDetailReferences('### Core conclusions\n\nA[S1]', groups), 'en').includes('### Evidence and sources\n\n[^1]: [[Maps/A/one.md|one]]'));
});
test('reference picker keeps source groups compact, collapsible and task-local', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'styles.css'), 'utf8');
  assert.match(css, /\.vam-reference-picker \.vam-reference-feedback \.is-hidden\s*\{\s*display:\s*none;\s*\}/);
  const element = (tag, options = {}) => ({ tag, cls: options.cls ?? '', text: options.text ?? '', children: [], dataset: {}, listeners: {},
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value = {}) { const child = element(name, value); Object.assign(child, value); Object.assign(child, value.attr ?? {}); this.children.push(child); return child; },
    createSpan(value = {}) { const child = element('span', value); this.children.push(child); return child; },
    addEventListener(name, handler) { this.listeners[name] = handler; }, setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass(name) { this.cls = this.cls.split(' ').filter(item => item !== name).join(' '); }, empty() { this.children = []; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  class Modal { constructor() { this.titleEl = element('h2'); this.contentEl = element('div'); } open() {} close() {} }
  const { ReferencePicker } = load('ui/reference-picker.ts', { obsidian: { ...obsidian, Modal, setIcon: (parent, name) => { const icon = element('svg'); icon.iconName = name; parent.children.push(icon); } } });
  const root = element('root');
  const picker = new ReferencePicker({ vault: { adapter: {} } }, root, async () => [], async () => [], 'current', 'Current topic and parent are included');
  // The picker no longer carries a web or image choice: that belongs to the AI mode.
  assert.equal(picker.selection, undefined); assert.equal(picker.setNetworkDefault, undefined);
  const area = root.children[0];
  assert.ok(find(area, child => child.cls.includes('vam-reference-cancel')).cls.includes('is-hidden'));
  assert.ok(find(area, child => child.cls.includes('vam-reference-error-acknowledge')).cls.includes('is-hidden'));
  assert.deepEqual(area.children.filter(child => child.cls.includes('vam-reference-section')).map(child => child.cls), [
    'vam-reference-section vam-reference-local-section'
  ]);
  assert.equal(find(area, child => child.tag === 'input' && child.type === 'checkbox'), undefined, 'no web or image checkbox');
  assert.ok(find(area, child => child.tag === 'strong' && !!child.text));
  const actionRow = find(area, child => child.cls === 'vam-reference-actions');
  assert.equal(actionRow.children.filter(child => child.tag === 'button').length, 3);
  assert.deepEqual(actionRow.children.filter(child => child.tag === 'button').map(button => button.children[0].children[0].iconName), ['brain-circuit', 'folder-open', 'file-text']);
  picker.groups = [{ id: 'map', name: 'Travel map', location: 'Maps/Travel/Map.md', documents: [{ path: 'Maps/Travel/Notes/Train.md', content: 'rail' }] }];
  picker.refresh();
  const details = find(area, child => child.tag === 'details');
  assert.equal(details.open, undefined);
  assert.equal(find(details, child => child.tag === 'ul'), undefined);
  const groupRow = find(area, child => child.cls === 'vam-reference-group-row');
  const remove = find(area, child => child.cls === 'vam-reference-remove');
  assert.equal(groupRow.children.includes(remove), true);
  assert.equal(find(find(details, child => child.tag === 'summary'), child => child.tag === 'button'), undefined);
  details.open = true; details.listeners.toggle();
  assert.equal(find(details, child => child.tag === 'li').text, 'Maps/Travel/Notes/Train.md');
  remove.listeners.click({ preventDefault() {} });
  assert.deepEqual(Object.keys(await picker.ready()), ['groups'], 'ready() hands over the source groups only');
  assert.equal((await picker.ready()).groups.length, 0);
  assert.ok(find(area, child => child.cls.includes('vam-reference-cancel')).cls.includes('is-hidden'));
  const input = (path, content) => ({name: path.split('/').at(-1), webkitRelativePath: path, text: async () => content});
  const archived = input('Vault/Topic/Archive/old.md', '---\nagent-map-node: true\ntopic-state: archived\n---\nOld');
  const ordinary = input('Vault/Archive/ordinary.md', 'Ordinary archive');
  const active = input('Archive/Topics/Archive/Notes/active.md', '---\nagent-map-node: true\ntopic-state: active\n---\nCurrent');
  picker.addFolder([archived, ordinary, active]);
  let chosen = await picker.ready();
  assert.deepEqual(plain(chosen.groups.flatMap(group => group.documents).map(doc => doc.path)), [ordinary.webkitRelativePath, active.webkitRelativePath]);
  assert.ok(find(area, child => child.text.includes('Excluded 1')));
  picker.addFiles([archived]); chosen = await picker.ready();
  assert.equal(chosen.groups.flatMap(group => group.documents).length, 3);
  assert.ok(chosen.groups.flatMap(group => group.documents).some(doc => doc.content.endsWith('Old')));
});
test('source footnotes survive reruns: numbers stay consistent, kept references get their definitions back, dead ones become a source to confirm', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }, { path: 'Maps/B/two.md', content: '' }] }];
  const previous = 'Old[^1] and[^2]\n\n[^1]: [[Maps/Old/gone.md|gone]]\n[^2]: [[Maps/A/one.md|one]]';
  // The reply keeps [^1] and [^2] without definitions and cites one.md again as [S1] and two.md as [S2].
  const rerun = api.resolveDetailReferences('New[S2] kept[^1] again[S1] same[^2]', groups, previous);
  assert.equal(rerun, 'New[^1] kept[^2] again[^3] same[^3]\n\n[^1]: [[Maps/B/two.md|two]]\n[^2]: [[Maps/Old/gone.md|gone]]\n[^3]: [[Maps/A/one.md|one]]\n');
  // A reference after which a colon follows mid-line is still a reference.
  assert.equal(api.resolveDetailReferences('Fact[S1]: more', groups), 'Fact[^1]: more\n\n[^1]: [[Maps/A/one.md|one]]\n');
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
  const { canonicalDetail } = load('main.ts', { obsidian });
  const out = canonicalDetail('### Core conclusions\n\nA[^1]\n\n### Update log\n\n- today\n[^1]: [[a.md|a]]', 'en');
  assert.ok(out.includes('### Evidence and sources\n\n[^1]: [[a.md|a]]\n\n### Tradeoffs and limitations'));
  assert.ok(out.includes('### Update log\n\n- today'));
  assert.equal(out.split('[^1]:').length, 2);
  const flat = canonicalDetail('Body[^1]\n\n[^1]: [[a.md|a]]', 'en');
  assert.ok(flat.startsWith('### Core conclusions\n\nBody[^1]\n\n### Key knowledge'));
  assert.ok(flat.includes('### Evidence and sources\n\n[^1]: [[a.md|a]]'));
});
test('source footnotes leave code, links and the writer\'s own footnotes untouched', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const { canonicalDetail } = load('main.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }] }];
  const code = 'Match `/[^a-z]+/` here[S1].\n\n```js\nconst re = /[^0-9]/;\n[^x]: code line\n```\n\nSee [^foo](https://x.y) and ![^img](a.png).';
  const out = api.resolveDetailReferences(code, groups);
  assert.ok(out.startsWith('Match `/[^a-z]+/` here[^1].\n\n```js\nconst re = /[^0-9]/;\n[^x]: code line\n```\n\nSee [^foo](https://x.y) and ![^img](a.png).'));
  assert.ok(out.endsWith('[^1]: [[Maps/A/one.md|one]]\n'));
  // Without sources the resolver may still run (the detail contains "[^"); it must change nothing here.
  const plain = 'Use `[^x]` and\n\n```\n[^1]: not a footnote\n```';
  assert.equal(api.resolveDetailReferences(plain, []), plain);
  // The writer's own footnote keeps its label, text and continuation line; source numbers skip its number.
  const own = 'Claim[^1] and fact[S1].\n\n[^1]: My own note\n    continued here';
  assert.equal(api.resolveDetailReferences(own, groups), 'Claim[^1] and fact[^2].\n\n[^1]: My own note\n    continued here\n\n[^2]: [[Maps/A/one.md|one]]\n');
  // canonicalDetail never moves lines out of a code block.
  const canon = canonicalDetail('### Core conclusions\n\n```\n[^x]: [[a.md|a]]\n```', 'en');
  assert.ok(canon.includes('```\n[^x]: [[a.md|a]]\n```'));
  assert.ok(!canon.split('### Evidence and sources')[1].split('### ')[0].includes('[^x]'));
});
test('source footnotes never reuse the number of a footnote kept as written', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [{ id: 'g', documents: [{ path: 'Maps/A/one.md', content: '' }, { path: 'Maps/B/two.md', content: '' }] }];
  // The reply kept the writer's [^2] but dropped its definition, and cites two new sources.
  const out = api.resolveDetailReferences('Claim[^2] fact[S1] other[S2]', groups, 'Claim[^2]\n\n[^2]: my own remark');
  assert.equal(out, 'Claim[^2] fact[^1] other[^3]\n\n[^1]: [[Maps/A/one.md|one]]\n[^3]: [[Maps/B/two.md|two]]\n');
  assert.equal(api.resolveDetailReferences('Claim[^1] fact[S1]', groups), 'Claim[^1] fact[^2]\n\n[^2]: [[Maps/A/one.md|one]]\n');
  // A fence opened with an info string is not closed by another info-string line.
  const fenced = '```js\nx\n```js\ny\n```\n\nAfter[S1]';
  assert.equal(api.resolveDetailReferences(fenced, groups), '```js\nx\n```js\ny\n```\n\nAfter[^1]\n\n[^1]: [[Maps/A/one.md|one]]\n');
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
  assert.equal(single, 'Claim[^1] ok\n\n[^1]: [[Notes/N0.md|N0]]\n');
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
