// Sharing translation T1 (Worker A): segments, placeholders, diagram labels, plan and cache, the AI step and the
// translation service with a fake runtime (0 live calls). No Obsidian needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, load, root, plain, obsidian } = require('../support.cjs');
const html = require('../support-html-dom.cjs');

const segments = load('experiences/sharing/share-translate-segments.ts');
const mermaid = load('experiences/sharing/share-translate-mermaid.ts');
const planModule = load('experiences/sharing/share-translate-plan.ts');
const format = load('experiences/sharing/share-format.ts');
const build = load('experiences/sharing/share-build.ts');
const scan = load('experiences/sharing/share-leak-scan.ts');
const languages = load('i18n/languages.ts');
const stepModule = load('core/steps/share-translate/step.ts');
const { ShareTranslateService, ShareTranslateError, buildShareTranslatePrompt, buildShareTranslateLabelsPrompt } = load('experiences/sharing/share-translate-service.ts', { obsidian });

const fixtureDir = path.join(root, 'tests', 'fixtures', 'sharing', 'translate');
const fixture = name => fs.readFileSync(path.join(fixtureDir, name), 'utf8');
const viewerPayload = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'sharing', 'viewer-payload.json'), 'utf8'));
const FIXTURES = ['rich.html', 'inline.html', 'code-diagram.html'];
const elementCount = el => el.children.reduce((sum, child) => sum + 1 + elementCount(child), 0);
const tagList = el => el.children.flatMap(child => [child.localName, ...tagList(child)]);
const tagged = text => `T:${text}`;

test('share translate: the translation languages are the six registry languages', () => {
  assert.deepEqual(plain(format.SHARE_TRANSLATION_LANGUAGES), ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'es']);
  const known = new Set([...languages.LANGUAGES.map(item => item.id), ...languages.OUTPUT_LANGUAGES.map(item => item.id)]);
  for (const id of format.SHARE_TRANSLATION_LANGUAGES) assert.ok(known.has(id), `${id} is a registry language`);
  assert.equal(format.isShareTranslationLanguage('fr'), false);
  assert.equal(format.isShareTranslationLanguage('ja'), true);
});

test('share translate segments: an unchanged translation puts every P1 fixture back byte for byte', () => {
  for (const name of FIXTURES) {
    const source = fixture(name);
    const root1 = html.parse(source);
    assert.equal(html.serialize(root1), source, `${name}: the test serializer matches the fixture`);
    const extraction = segments.extractSegments(root1);
    assert.ok(extraction.units.length >= 2, `${name}: has units`);
    const report = segments.applyTranslations(extraction, unit => unit.text);
    assert.equal(report.kept, 0, `${name}: nothing kept`);
    assert.equal(report.applied, extraction.units.length);
    assert.equal(html.serialize(root1), source, `${name}: round trip is byte-identical`);
  }
  // The hand-written viewer fixture uses self-closing svg tags; compare with the serializer's own normal form.
  const heat = viewerPayload.nodes.find(node => node.id === 'heat').detailHtml;
  const normal = html.serialize(html.parse(heat));
  const tree = html.parse(heat);
  segments.applyTranslations(segments.extractSegments(tree), unit => unit.text);
  assert.equal(html.serialize(tree), normal);
});

test('share translate segments: what is cut out, and what is never sent', () => {
  const rich = segments.extractSegments(html.parse(fixture('rich.html'))).units.map(unit => unit.text);
  assert.ok(rich.includes('Why heat matters'));
  assert.ok(rich.includes('Method') && rich.includes('Temp (C)') && rich.includes('Notes'), 'table cells are units');
  assert.ok(rich.includes('Tip') && rich.includes('Salt the water ⟦1⟧before⟦/1⟧ it boils.'), 'callout title and body');
  assert.ok(rich.includes('Dry heat') && rich.includes('Roasting and ⟦1⟧baking⟦/1⟧'), 'nested list: the outer item and the inner item are separate units');
  const paragraph = rich.find(text => text.startsWith('Heat changes'));
  assert.match(paragraph, /^Heat changes ⟦1\/⟧ and starches\. See ⟦2⟧an ⟦3⟧outside⟦\/3⟧ article⟦\/2⟧ or visit ⟦4\/⟧ for more\.$/, 'code and the web address are untouched atoms, the link and its strong are a nested pair');
  const inline = segments.extractSegments(html.parse(fixture('inline.html'))).units.map(unit => unit.text);
  assert.ok(inline.some(text => text.startsWith('Water boils') && text.includes('⟦1/⟧') && text.includes('Second line with')), 'br and kbd are atoms');
  assert.ok(!inline.some(text => /x\^2|\by\b/.test(text) && !/is a square/.test(text)), 'math text is never a unit by itself');
  assert.ok(inline.includes('⟦1/⟧ is a square, and ⟦2/⟧ is not.'), 'rendered math stays an atom inside the sentence');
  assert.ok(inline.some(text => text.includes('Boil the water first')), 'task list item text');
  assert.ok(inline.includes('gradient sample') && inline.includes('web picture'), 'image alt text is a unit');
  assert.ok(!inline.some(text => text.includes('#cooking') && !text.includes('Footnote')), 'a tag link is an atom');
  assert.ok(inline.some(text => text.startsWith('Footnote')), 'footnote reference stays inside its sentence');
  const code = segments.extractSegments(html.parse(fixture('code-diagram.html'))).units.map(unit => unit.text);
  assert.deepEqual(plain(code.filter(text => /const|console|hello/.test(text))), [], 'pre/code blocks are never sent');
  assert.ok(!code.some(text => text.includes('Start')), 'svg text is never sent');
  assert.ok(!code.some(text => text.includes('Diagram did not finish')), 'the exporter note is not translated');
  assert.ok(!code.includes('12'), 'a number alone has nothing to translate');
});

test('share translate segments: a translation can only become text nodes and clones of the original elements', () => {
  const source = fixture('rich.html');
  const original = html.parse(source);
  const tree = html.parse(source);
  const extraction = segments.extractSegments(tree);
  const hostile = {
    'Why heat matters': '<script>alert(1)</script>Warum Hitze zaehlt',
    'Salt the water ⟦1⟧before⟦/1⟧ it boils.': 'Salz ⟦1⟧vorher⟦/1⟧ <a href="obsidian://open?vault=V">klick</a> [[Privat/Tagebuch]] /Users/me/Vault <img src=x onerror=alert(1)>',
    Tip: '<b>Tipp</b>'
  };
  const report = segments.applyTranslations(extraction, unit => hostile[unit.text] ?? unit.text);
  assert.equal(report.kept, 0);
  assert.deepEqual(plain(tagList(tree)), plain(tagList(original)), 'not one element was added or removed');
  const out = html.serialize(tree);
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;Warum'), 'markup in a reply is text');
  assert.ok(!out.includes('<script') && !out.includes('<a href="obsidian'), 'no script, no private link');
  assert.ok(out.includes('<strong>vorher</strong>'), 'a placeholder pair still wraps its words');
  assert.ok(out.includes('<code>proteins</code>'), 'untouched atoms stay');
  // The leak scan sees all of it, because the text is still in detailHtml.
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/me/Vault', mapFolder: 'Private Map' }, { nodes: [{ path: 'Private Map/Note.md' }] }, [{ model: 'claude-sonnet-4-5' }]);
  const categories = build.leakCategoriesInTranslation('de', { top: { title: 'T' }, nodes: { a: { title: 'x', summary: 'y', detailHtml: out } } }, forbidden);
  assert.ok(categories.includes('wikilink') && categories.includes('vault-path') && categories.includes('obsidian-url'), plain(categories));
  const modelHit = build.leakCategoriesInTranslation('de', { top: { title: 'T' }, nodes: { a: { title: 'x', summary: 'claude-sonnet-4-5', detailHtml: '<p>ok</p>' } } }, forbidden);
  assert.deepEqual(plain(modelHit), ['model-name']);
});

test('share translate segments: placeholder errors keep the original text and are counted', () => {
  const cases = {
    dropped: 'Salz vorher es kocht.',
    reordered: '⟦/1⟧vorher⟦1⟧ Salz',
    extra: 'Salz ⟦1⟧vorher⟦/1⟧ ⟦2/⟧',
    renumbered: 'Salz ⟦2⟧vorher⟦/2⟧',
    unclosed: 'Salz ⟦1⟧vorher',
    stray: 'Salz ⟦1⟧vorher⟦/1⟧ ⟦',
    atomAsPair: 'Salz ⟦1⟧vorher⟦/1⟧⟦7/⟧',
    blank: '   '
  };
  const source = '<p>Salt the water <strong>before</strong> it boils.</p>';
  for (const [name, bad] of Object.entries(cases)) {
    const tree = html.parse(source);
    const report = segments.applyTranslations(segments.extractSegments(tree), () => bad);
    assert.deepEqual(plain(report), { applied: 0, kept: 1 }, name);
    assert.equal(html.serialize(tree), source, `${name}: original kept`);
  }
  assert.equal(segments.placeholdersMatch('a ⟦1⟧b⟦/1⟧', 'x ⟦1⟧y⟦/1⟧'), true);
  const tree = html.parse(source);
  assert.deepEqual(plain(segments.applyTranslations(segments.extractSegments(tree), () => undefined)), { applied: 0, kept: 1 });
});

test('share translate segments: image alt text is translated and copies of images keep it; source text with brackets is left alone', () => {
  const tree = html.parse('<p><img src="vam-asset:image-1" alt="gradient sample"> Look at the <em>picture</em> above.</p><p>Literal ⟦ bracket</p>');
  const extraction = segments.extractSegments(tree);
  assert.equal(extraction.units.filter(unit => unit.kind === 'attribute').length, 1);
  assert.equal(extraction.units.some(unit => unit.text.includes('Literal')), false, 'a unit that already holds the bracket characters is not sent');
  segments.applyTranslations(extraction, unit => (unit.kind === 'attribute' ? 'Farbverlauf' : tagged(unit.text)));
  const out = html.serialize(tree);
  assert.ok(out.includes('alt="Farbverlauf"'), out);
  assert.ok(out.includes('<em>picture</em>') || out.includes('T:'), out);
});

test('share translate mermaid: comments go, click and links are refused, labels are cut and put back safely', () => {
  const source = 'flowchart TD\n  %% secret note about /Users/me/Vault\n  A[Start here] --> B(Heat the pan)\n  B -->|yes| C{Hot enough?}\n  C -- no --> A %% trailing\n  A:::x\n  style A fill:#f9f\n  subgraph one [Group Title]\n  D["Quoted label"]\n  end';
  const prepared = mermaid.prepareMermaidTranslation(source);
  assert.equal(prepared.ok, true);
  assert.ok(!prepared.cleaned.includes('%%') && !prepared.cleaned.includes('secret') && !prepared.cleaned.includes('trailing'), prepared.cleaned);
  assert.deepEqual(plain(prepared.labels), ['Start here', 'Heat the pan', 'yes', 'Hot enough?', 'no', 'Group Title', 'Quoted label']);
  const out = prepared.rebuild(prepared.labels.map(label => `X-${label}`));
  assert.equal(out.applied, 7);
  assert.ok(out.source.includes('A[X-Start here] --> B(X-Heat the pan)') && out.source.includes('D["X-Quoted label"]') && out.source.includes('style A fill:#f9f'), out.source);
  // A label that would change the structure is refused; the label stays.
  const unsafe = prepared.rebuild(['ok]) --> Z[(', undefined, 'a|b', 'x"y', 'n;m', 'g#h', 'Q" --> evil["x']);
  assert.equal(unsafe.applied, 0, 'every one of these breaks the syntax');
  assert.equal(unsafe.source, prepared.cleaned);
  assert.equal(mermaid.isSafeMermaidLabel('Wärme (heiß)', false), false);
  assert.equal(mermaid.isSafeMermaidLabel('Wärme（heiß）', false), true);
  assert.equal(mermaid.isSafeMermaidLabel('Zeile<br/>zwei', false), true);
  assert.equal(mermaid.isSafeMermaidLabel('<img src=x onerror=alert(1)>', false), false);
  assert.equal(mermaid.isSafeMermaidLabel('javascript:alert(1)', true), false);
  for (const bad of ['Tom #amp; Jerry', 'Say #quot;hi#quot;', 'Code #35;1', 'R&D', 'a &lt; b', 'x &amp; y']) {
    assert.equal(mermaid.isSafeMermaidLabel(bad, false), false, bad);
    assert.equal(mermaid.isSafeMermaidLabel(bad, true), false, `${bad} (quoted)`);
  }
  assert.equal(mermaid.isSafeMermaidLabel('Link building', false), true, 'ordinary words that start like a keyword are fine');
  for (const bad of ['flowchart TD\n A --> B\n click A "https://evil.example"', 'graph LR\n A-->B\n click A call alert()', 'flowchart TD\n A[x]-->B\n click B href "https://e.example"', 'sequenceDiagram\n link A: Dashboard @ https://e.example', 'flowchart TD\n A["<a href=javascript:alert(1)>x</a>"]'])
    assert.deepEqual(plain(mermaid.prepareMermaidTranslation(bad)), { ok: false, reason: 'unsafe' }, bad);
  assert.deepEqual(plain(mermaid.prepareMermaidTranslation('flowchart TD\n  A --> B')), { ok: false, reason: 'no-labels' });
  assert.equal(mermaid.prepareMermaidTranslation('flowchart TD\n  1[2] --> 3[4]').reason, 'no-labels', 'labels without letters are not translated');
});

test('share translate mermaid: sequence, mindmap and pie diagrams contribute their labels', () => {
  const sequence = mermaid.prepareMermaidTranslation('sequenceDiagram\n  participant A as Alice\n  A->>B: Hello Bob\n  Note over A,B: A short note\n  loop Every minute\n  B-->>A: Great\n  end');
  assert.deepEqual(plain(sequence.labels), ['Alice', 'Hello Bob', 'A short note', 'Every minute', 'Great']);
  const mind = mermaid.prepareMermaidTranslation('mindmap\n  root((Cooking))\n    Heat\n      Dry heat\n    Water');
  assert.deepEqual(plain(mind.labels), ['Cooking', 'Heat', 'Dry heat', 'Water']);
  const pie = mermaid.prepareMermaidTranslation('pie title Pets\n  "Dogs" : 386\n  "Cats" : 85');
  assert.deepEqual(plain(pie.labels), ['Pets', 'Dogs', 'Cats']);
  assert.equal(mermaid.stripMermaidComments('%%{init: {"theme":"dark"}}%%\nflowchart TD\n  A["50%% sure"] --> B'), 'flowchart TD\n  A["50%% sure"] --> B', 'a %% inside quotes is text');
});

test('share translate plan: batches, hash, estimate and the three-map session cache', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), text: 'x'.repeat(2500) }));
  const batches = planModule.planBatches(items, planModule.TRANSLATE_BATCH_CHARS);
  assert.deepEqual(plain(batches.map(batch => batch.length)), [2, 2, 2, 2, 2]);
  assert.deepEqual(plain(planModule.planBatches([{ id: '1', text: 'y'.repeat(9000) }, { id: '2', text: 'a' }], 6000).map(batch => batch.length)), [1, 1], 'an oversize item goes alone');
  assert.deepEqual(plain(planModule.planBatches([], 6000)), []);
  assert.equal(planModule.segmentHash('abc'), planModule.segmentHash('abc'));
  assert.notEqual(planModule.segmentHash('abc'), planModule.segmentHash('abd'));
  // 料理的科學 2: about 62k characters of body text, a map's titles and summaries, and a few diagrams.
  const calls = planModule.estimateCallsFromWorkload({ bodyChars: 62000, fieldChars: 11000, labelChars: 2500 });
  assert.ok(calls >= 11 && calls <= 15, `one more language is about 13 calls, got ${calls}`);
  assert.equal(planModule.estimateCallsFromWorkload({ bodyChars: 0, fieldChars: 0, labelChars: 0 }), 0);
  assert.equal(planModule.estimateMinutes(0), 0);
  assert.equal(planModule.estimateMinutes(11), 3, 'live run: 11 calls, 3 at a time, took 204 s');
  assert.equal(planModule.estimateMinutes(13), Math.round((13 / 3) * planModule.TRANSLATE_SECONDS_PER_CALL / 60) || 1);
  assert.equal(planModule.isIncomplete(1, 10), false);
  assert.equal(planModule.isIncomplete(2, 10), true);
  const cache = new planModule.ShareTranslationCache();
  cache.set('m1', 'ja', 'model-a', 'h', 'one');
  assert.equal(cache.get('m1', 'ja', 'model-a', 'h'), 'one');
  assert.equal(cache.get('m1', 'ja', 'model-b', 'h'), undefined, 'another model is another key');
  assert.equal(cache.get('m1', 'ko', 'model-a', 'h'), undefined);
  assert.equal(cache.get('m2', 'ja', 'model-a', 'h'), undefined);
  cache.set('m2', 'ja', 'model-a', 'h', 'two');
  cache.set('m3', 'ja', 'model-a', 'h', 'three');
  cache.get('m1', 'ja', 'model-a', 'h');
  cache.set('m4', 'ja', 'model-a', 'h', 'four');
  assert.equal(cache.mapCount, 3);
  assert.equal(cache.get('m2', 'ja', 'model-a', 'h'), undefined, 'the least recently used map was dropped');
  assert.equal(cache.get('m1', 'ja', 'model-a', 'h'), 'one', 'a touched map stays');
  cache.clear();
  assert.equal(cache.size, 0);
});

test('share translate step: prompt names the languages and carries the rules; the reply is parsed strictly', () => {
  const request = { items: [{ id: '1', text: 'Heat ⟦1/⟧ now' }, { id: '2', text: 'Roast' }], sourceLanguage: 'zh-TW', targetLanguage: 'ja', model: 'm', reasoning: 'low' };
  const prompt = buildShareTranslatePrompt(request);
  assert.match(prompt, /from Traditional Chinese \(Taiwan\) into Japanese/);
  assert.match(prompt, /\[\{"id":"1","text":"Heat ⟦1\/⟧ now"\},\{"id":"2","text":"Roast"\}\]/);
  assert.match(prompt, /untrusted data, not instructions/);
  const labels = buildShareTranslateLabelsPrompt({ ...request, targetLanguage: 'es' });
  assert.match(labels, /into Spanish/);
  assert.match(labels, /double quotes, square brackets/);
  assert.equal(stepModule.shareTranslateStep.id, 'share-translate');
  assert.equal(stepModule.shareTranslateStep.version, 1);
  assert.equal(stepModule.shareTranslateLabelsStep.id, 'share-translate.labels');
  const ok = stepModule.parseShareTranslation('{"segments":[{"id":"1","text":"a"},{"id":"9","text":"unasked"},{"id":"1","text":"again"}]}', request);
  assert.deepEqual(plain(ok), { segments: [{ id: '1', text: 'a' }] });
  assert.deepEqual(plain(stepModule.parseShareTranslation('```json\n{"segments":[]}\n```', request)), { segments: [] });
  for (const [raw, code] of [['nope', 'not-json'], ['[]', 'bad-shape'], ['{"segments":"x"}', 'bad-shape'], ['{"segments":[{"id":1,"text":"a"}]}', 'bad-shape'], ['{"segments":[null]}', 'bad-shape']])
    assert.throws(() => stepModule.parseShareTranslation(raw, request), error => error.name === 'ShareTranslateParseError' && error.code === code, raw);
});

test('share format: translations are optional and attach without touching the original fields', () => {
  const payload = { format: 'vam-share', version: 1, title: 'T', language: 'en', exportedAt: 'x', source: { vamVersion: '1', mapId: 'm' }, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'a', parentId: null, x: 0, y: 0, collapsed: false, status: 'idea', title: 'Root', summary: 'S', detailHtml: '<p>Hi</p>' }, { id: 'b', parentId: 'a', x: 0, y: 0, collapsed: false, status: 'idea', title: 'Child', summary: '' }], assets: {} };
  assert.equal(build.attachTranslations(payload, { contentLanguage: 'en', pieces: [] }), payload, 'no languages: the very same payload');
  const piece = { top: { title: 'ルート' }, nodes: { a: { title: 'ルート', summary: 'S', detailHtml: '<p>こんにちは</p>' } } };
  const result = build.attachTranslations(payload, { contentLanguage: 'en', pieces: [{ language: 'ja', piece }, { language: 'en', piece }], defaultLanguage: 'ja' });
  assert.deepEqual(plain(result.languages), ['en', 'ja']);
  assert.equal(result.contentLanguage, 'en');
  assert.equal(result.defaultLanguage, 'ja');
  assert.deepEqual(plain(result.translations), { ja: { title: 'ルート' } });
  assert.deepEqual(plain(result.nodes[0].translations.ja), piece.nodes.a);
  assert.equal(result.nodes[0].detailHtml, '<p>Hi</p>', 'the original is untouched');
  assert.equal('translations' in result.nodes[1], false, 'a node with no translation has no field');
  assert.equal('defaultLanguage' in build.attachTranslations(payload, { contentLanguage: 'en', pieces: [{ language: 'ja', piece }], defaultLanguage: 'ko' }), false, 'a default the file does not carry is dropped');
  assert.equal(payload.nodes[0].translations, undefined, 'the input payload is not mutated');
});

// ---- the service with a fake runtime ----
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeRunner({ transform = tagged, delay = 0, fail = () => false, onCall } = {}) {
  const state = { calls: [], inFlight: 0, maxInFlight: 0 };
  const run = async (request, signal, prepared) => {
    if (signal.aborted) throw new ShareTranslateError('stopped', 'stopped');
    const index = state.calls.length;
    state.calls.push({ request, prompt: prepared.prompt, stepId: prepared.step.id });
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      onCall?.(index, request);
      if (delay) await sleep(delay);
      if (signal.aborted) throw new ShareTranslateError('stopped', 'stopped');
      if (fail(index, request)) throw new Error(`call ${index} failed`);
      return JSON.stringify({ segments: request.items.map(item => ({ id: item.id, text: transform(item.text, item) })) });
    } finally {
      state.inFlight--;
    }
  };
  return { run, state };
}
const manyNodes = (count, size = 500) => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, title: `Topic ${i}`, summary: `Summary of topic ${i}`, detailHtml: `<p>${`Paragraph ${i} `.repeat(Math.ceil(size / 12)).slice(0, size)}</p>` }));
const baseSource = (nodes, extra = {}) => ({ mapId: 'map-1', title: 'My map', goal: 'Learn it', sourceLanguage: 'en', nodes, ...extra });
const baseOptions = (extra = {}) => ({ dom: html.makeDom(), signal: new AbortController().signal, cache: new planModule.ShareTranslationCache(), model: 'claude:sonnet', reasoning: 'low', forbidden: [], ...extra });

test('share translate service: translates every field and paragraph, at most 3 calls at once', async () => {
  const { run, state } = fakeRunner({ delay: 5 });
  const service = new ShareTranslateService(run);
  const source = baseSource(manyNodes(30));
  const options = baseOptions();
  const progress = [];
  const result = await service.translate(source, ['ja'], { ...options, onProgress: item => progress.push(item) });
  const ja = result.languages[0];
  assert.equal(ja.status, 'complete');
  assert.equal(ja.failedSegments, 0);
  assert.equal(ja.nodes.n0.title, 'T:Topic 0');
  assert.equal(ja.nodes.n3.summary, 'T:Summary of topic 3');
  assert.ok(ja.nodes.n7.detailHtml.startsWith('<p>T:Paragraph 7'), ja.nodes.n7.detailHtml.slice(0, 40));
  assert.equal(ja.top.title, 'T:My map');
  assert.equal(ja.top.goal, 'T:Learn it');
  assert.ok(state.maxInFlight <= 3 && state.maxInFlight >= 2, `parallelism ${state.maxInFlight}`);
  assert.equal(result.calls, state.calls.length);
  assert.equal(ja.calls, state.calls.length);
  assert.ok(state.calls.length >= 4, `body in several batches plus one field batch: ${state.calls.length}`);
  for (const call of state.calls) {
    assert.equal(call.request.targetLanguage, 'ja');
    assert.equal(call.request.sourceLanguage, 'en');
    assert.equal(call.request.model, 'claude:sonnet');
    assert.ok(call.request.items.reduce((sum, item) => sum + item.text.length, 0) <= 12000 + 1);
  }
  const last = progress.at(-1);
  assert.equal(last.phase, 'assemble');
  assert.equal(last.batchDone, last.batchTotal);
  assert.equal(last.languageIndex, 1);
  assert.equal(last.languageCount, 1);
  // The same call count is what the estimate announces beforehand.
  const estimate = service.estimate(source, ['ja'], baseOptions());
  assert.equal(estimate.calls, state.calls.length);
  assert.ok(estimate.minutes >= 1);
});

test('share translate service: pressing again with nothing changed makes 0 calls; another model or language translates again', async () => {
  const { run, state } = fakeRunner();
  const service = new ShareTranslateService(run);
  const source = baseSource(manyNodes(8));
  const cache = new planModule.ShareTranslationCache();
  const first = await service.translate(source, ['en', 'ja'].slice(1), baseOptions({ cache }));
  const firstCalls = state.calls.length;
  assert.ok(firstCalls > 0);
  assert.equal(service.estimate(source, ['ja'], baseOptions({ cache })).calls, 0, 'the estimate knows the cache');
  const again = await service.translate(source, ['ja'], baseOptions({ cache }));
  assert.equal(state.calls.length, firstCalls, '0 new calls');
  assert.equal(again.calls, 0);
  assert.ok(again.cacheHits > 0);
  assert.deepEqual(plain(again.languages[0].nodes), plain(first.languages[0].nodes));
  await service.translate(source, ['ja'], baseOptions({ cache, model: 'claude:opus' }));
  assert.ok(state.calls.length > firstCalls, 'a new model is a new key');
  const before = state.calls.length;
  await service.translate(source, ['ko'], baseOptions({ cache }));
  assert.ok(state.calls.length > before, 'a new language is new work');
});

test('share translate service: cancelling stops new calls, writes nothing, and keeps what finished for the next run', async () => {
  const controller = new AbortController();
  const { run, state } = fakeRunner({ delay: 10, onCall: index => { if (index === 3) controller.abort(); } });
  const service = new ShareTranslateService(run);
  const source = baseSource(manyNodes(40));
  const cache = new planModule.ShareTranslationCache();
  await assert.rejects(service.translate(source, ['ja'], baseOptions({ cache, signal: controller.signal })), error => error instanceof ShareTranslateError && error.code === 'stopped');
  const afterAbort = state.calls.length;
  await sleep(40);
  assert.equal(state.calls.length, afterAbort, 'no new call after the abort');
  assert.ok(afterAbort < service.estimate(source, ['ja'], baseOptions()).calls, 'it stopped early');
  const remaining = service.estimate(source, ['ja'], baseOptions({ cache })).calls;
  assert.ok(remaining > 0 && remaining < service.estimate(source, ['ja'], baseOptions()).calls, `only the rest is left: ${remaining}`);
  const resumed = fakeRunner();
  const result = await new ShareTranslateService(resumed.run).translate(source, ['ja'], baseOptions({ cache }));
  assert.equal(resumed.state.calls.length, remaining, 'a second run translates only what is missing');
  assert.equal(result.languages[0].status, 'complete');
  // Already aborted before it starts: not a single call.
  const none = fakeRunner();
  const dead = new AbortController();
  dead.abort();
  await assert.rejects(new ShareTranslateService(none.run).translate(source, ['ja'], baseOptions({ signal: dead.signal })), error => error.code === 'stopped');
  assert.equal(none.state.calls.length, 0);
});

test('share translate service: a failed batch is sent once more; what still fails stays in the original language', async () => {
  const flaky = fakeRunner({ fail: index => index === 0 });
  const retried = await new ShareTranslateService(flaky.run).translate(baseSource(manyNodes(3)), ['es'], baseOptions());
  assert.equal(retried.languages[0].status, 'complete');
  assert.equal(flaky.state.calls.filter(call => call.prompt === flaky.state.calls[0].prompt).length, 2, 'the same batch went out twice');
  assert.equal(retried.languages[0].firstError, 'call 0 failed');

  // Items the model leaves out are retried once, alone; then they stay in the original.
  const dropping = fakeRunner({ transform: (text, item) => (text.startsWith('Paragraph 1') ? null : tagged(text)) });
  const run = async (request, signal, prepared) => {
    const raw = JSON.parse(await dropping.run(request, signal, prepared));
    raw.segments = raw.segments.filter(segment => segment.text !== 'T:null' && segment.text !== null);
    return JSON.stringify(raw);
  };
  const partial = await new ShareTranslateService(run).translate(baseSource(manyNodes(3)), ['es'], baseOptions());
  const result = partial.languages[0];
  assert.ok(result.failedSegments >= 1);
  assert.ok(result.nodes.n1.detailHtml.includes('Paragraph 1'), 'the failed paragraph is still the original');

  // More than 10% failing marks the language incomplete; all failing marks it failed.
  let count = 0;
  const mostly = fakeRunner({ fail: () => count++ % 1 === 0 });
  const failed = await new ShareTranslateService(mostly.run).translate(baseSource(manyNodes(3)), ['ko'], baseOptions());
  assert.equal(failed.languages[0].status, 'failed');
  assert.equal(failed.languages[0].nodes.n0.title, 'Topic 0', 'a failed language still carries the original text, never a half answer');
  const some = fakeRunner({ transform: (text, item) => (Number(item.id) % 2 ? tagged(text) : null) });
  const run2 = async (request, signal, prepared) => {
    const out = JSON.parse(await some.run(request, signal, prepared));
    out.segments = out.segments.filter(segment => segment.text !== null && segment.text !== 'T:null');
    return JSON.stringify(out);
  };
  const half = await new ShareTranslateService(run2).translate(baseSource(manyNodes(6)), ['ko'], baseOptions());
  assert.equal(half.languages[0].status, 'incomplete');
  assert.ok(half.languages[0].failedSegments / half.languages[0].totalSegments > 0.1);
});

test('share translate service: a placeholder the model breaks is not used, not cached, and counted', async () => {
  const source = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: '<p>Salt the water <strong>before</strong> it boils.</p><p>Plain second paragraph here.</p>' }]);
  const { run } = fakeRunner({ transform: text => (text.includes('⟦') ? 'Salz vorher es kocht.' : tagged(text)) });
  const cache = new planModule.ShareTranslationCache();
  const result = (await new ShareTranslateService(run).translate(source, ['es'], baseOptions({ cache }))).languages[0];
  assert.equal(result.failedSegments, 1);
  assert.equal(result.nodes.a.detailHtml, '<p>Salt the water <strong>before</strong> it boils.</p><p>T:Plain second paragraph here.</p>');
  assert.equal(cache.get('map-1', 'es', 'claude:sonnet', planModule.segmentHash('Salt the water ⟦1⟧before⟦/1⟧ it boils.')), undefined);
});

test('share translate service: every language runs the gates; a vault path, model name or wikilink in a translation blocks the whole language', async () => {
  const forbidden = scan.forbiddenStringsFor({ vaultPath: '/Users/me/Vault', mapFolder: 'Private Map' }, { nodes: [{ path: 'Private Map/Note.md' }] }, [{ model: 'claude-sonnet-4-5' }]);
  const source = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: '<p>Hello world, nice day.</p>' }, { id: 'b', title: 'B', summary: 'S2' }]);
  for (const [label, leak, category] of [['path', 'see /Users/me/Vault/x', 'vault-path'], ['model', 'made by claude-sonnet-4-5', 'model-name'], ['link', 'see [[Private Note]]', 'wikilink'], ['folder', 'in Private Map today', 'map-folder'], ['url', 'open obsidian://open', 'obsidian-url']]) {
    const { run } = fakeRunner({ transform: text => (text === 'Hello world, nice day.' ? leak : tagged(text)) });
    const result = await new ShareTranslateService(run).translate(source, ['ja', 'ko'], baseOptions({ forbidden }));
    assert.equal(result.languages[0].status, 'blocked', label);
    assert.ok(result.languages[0].leakCategories.includes(category), `${label}: ${result.languages[0].leakCategories}`);
    assert.equal(result.languages[0].nodes, undefined, 'nothing of a blocked language travels on');
    assert.equal(result.languages[0].top, undefined);
    assert.equal(result.languages[1].status, 'blocked', 'the other language is gated on its own and the same text is blocked too');
  }
  // The same service lets an honest translation of the same map through.
  const { run } = fakeRunner();
  const ok = await new ShareTranslateService(run).translate(source, ['ja'], baseOptions({ forbidden }));
  assert.equal(ok.languages[0].status, 'complete');
  // A leak in a title or summary field is found too.
  const titleLeak = fakeRunner({ transform: text => (text === 'S2' ? '/Users/me/Vault' : tagged(text)) });
  const t = await new ShareTranslateService(titleLeak.run).translate(source, ['ja'], baseOptions({ forbidden }));
  assert.equal(t.languages[0].status, 'blocked');
});

test('share translate service: hostile replies become text, the cleaned tree gains no element and no link', async () => {
  const source = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: fixture('rich.html') }]);
  const { run } = fakeRunner({ transform: text => (text.includes('⟦') ? text.replace(/[^⟦⟧\/\d]+/g, m => (m.trim() ? '<script>x</script><a href="obsidian://x">q</a> ' : m)) : `<a href="obsidian://x">${text}</a>`) });
  const forbidden = scan.forbiddenStringsFor({ mapFolder: 'Private Map' }, { nodes: [] });
  const result = (await new ShareTranslateService(run).translate(source, ['ja'], baseOptions())).languages[0];
  const out = result.nodes.a.detailHtml;
  assert.ok(!/<script|<a href="obsidian/.test(out), out.slice(0, 300));
  const original = html.parse(fixture('rich.html'));
  assert.deepEqual(plain(tagList(html.parse(out)).sort()), plain(tagList(original).sort()), 'same elements as the original, none more');
  const gated = (await new ShareTranslateService(run).translate(source, ['ja'], baseOptions({ forbidden }))).languages[0];
  assert.equal(gated.status, 'blocked', 'and the visible text still carries the obsidian:// address, so the gate blocks the language');
  assert.ok(gated.leakCategories.includes('obsidian-url'));
});

test('share translate service: diagrams are translated through the injected renderer; a failure keeps the original drawing', async () => {
  const source = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: fixture('code-diagram.html'), diagrams: [{ svgIndex: 0, source: 'flowchart TD\n  %% private note\n  A[Start here] --> B[Heat the pan]' }] }]);
  const sources = [];
  const drawn = svgText => html.parse(svgText).children[0];
  const renderMermaid = async text => { sources.push(text); return drawn('<svg id="m2" viewBox="0 0 10 10"><text>translated drawing</text></svg>'); };
  const { run, state } = fakeRunner({ transform: text => `L:${text}` });
  const result = (await new ShareTranslateService(run).translate(source, ['ja'], baseOptions({ renderMermaid }))).languages[0];
  assert.deepEqual(plain(sources), ['flowchart TD\n  A[L:Start here] --> B[L:Heat the pan]'], 'comment lines are gone before the source is drawn');
  assert.ok(result.nodes.a.detailHtml.includes('translated drawing') && !result.nodes.a.detailHtml.includes('<text class="t"'), 'the new drawing replaced the old one');
  assert.equal(result.diagramsKept, 0);
  assert.ok(state.calls.some(call => call.stepId === 'share-translate.labels'), 'labels use the labels step');
  for (const failing of [async () => null, async () => { throw new Error('mermaid failed'); }, async () => html.parse('<div>not an svg</div>').children[0]]) {
    const again = fakeRunner({ transform: text => `L:${text}` });
    const kept = (await new ShareTranslateService(again.run).translate(source, ['ja'], baseOptions({ renderMermaid: failing }))).languages[0];
    assert.ok(kept.nodes.a.detailHtml.includes('<text class="t" x="14" y="33">Start</text>'), 'the original drawing stays');
    assert.equal(kept.diagramsKept, 1);
    assert.equal(kept.status, 'complete');
  }
  // A drawn diagram whose source was not captured cannot be redrawn: it stays as it is and counts as kept (DP8).
  const unsourced = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: fixture('code-diagram.html'), diagramsUnsourced: 1 }]);
  const noSource = (await new ShareTranslateService(fakeRunner().run).translate(unsourced, ['ja'], baseOptions({ renderMermaid: async () => null }))).languages[0];
  assert.equal(noSource.diagramsKept, 1);
  assert.ok(noSource.nodes.a.detailHtml.includes('<text class="t" x="14" y="33">Start</text>'), 'the original drawing stays');
  // click statements: never translated, never drawn.
  const hostile = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: fixture('code-diagram.html'), diagrams: [{ svgIndex: 0, source: 'flowchart TD\n  A[Start here] --> B[Heat]\n  click A "https://evil.example"' }] }]);
  const calledWith = [];
  const none = fakeRunner();
  const out = (await new ShareTranslateService(none.run).translate(hostile, ['ja'], baseOptions({ renderMermaid: async text => { calledWith.push(text); return null; } }))).languages[0];
  assert.deepEqual(plain(calledWith), []);
  assert.equal(out.diagramsKept, 1);
  assert.ok(!none.state.calls.some(call => call.stepId === 'share-translate.labels'), 'no label of an unsafe diagram is sent');
  // Without a renderer diagrams are simply not part of the work.
  const noRender = fakeRunner();
  await new ShareTranslateService(noRender.run).translate(source, ['ja'], baseOptions());
  assert.ok(!noRender.state.calls.some(call => call.stepId === 'share-translate.labels'));
});

test('share translate service: a map with no note content translates only the short fields, and an empty language list does nothing', async () => {
  const { run, state } = fakeRunner();
  const service = new ShareTranslateService(run);
  const result = await service.translate(baseSource([{ id: 'a', title: 'A', summary: 'S' }, { id: 'b', title: 'B', summary: '' }]), ['ja'], baseOptions());
  assert.equal(state.calls.length, 1);
  assert.equal(result.languages[0].nodes.a.detailHtml, undefined);
  assert.equal(result.languages[0].nodes.b.summary, '');
  assert.deepEqual(plain((await service.translate(baseSource([]), [], baseOptions())).languages), []);
  assert.equal(state.calls.length, 1);
});

test('share translate service: a note that still carries a local link blocks the language, and the sanitizer runs on every translated note', async () => {
  const linked = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: '<p>See <a href="Diary/secret.md">my diary</a> today.</p>' }]);
  const { run } = fakeRunner();
  const blocked = (await new ShareTranslateService(run).translate(linked, ['ja'], baseOptions())).languages[0];
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(plain(blocked.leakCategories), ['wikilink']);
  assert.equal(blocked.nodes, undefined);
  const seen = [];
  const dom = html.makeDom({ sanitize: root => { seen.push(html.serialize(root)); } });
  const clean = baseSource([{ id: 'a', title: 'A', summary: 'S', detailHtml: '<p>Hello <a href="https://example.org">there</a> friend.</p>' }]);
  const ok = (await new ShareTranslateService(run).translate(clean, ['ja', 'ko'], baseOptions({ dom }))).languages;
  assert.equal(ok.length, 2);
  assert.equal(seen.length, 2, 'the sanitizer ran once per language and note');
  assert.ok(seen[0].includes('T:Hello <a href="https://example.org">there</a> friend.'), seen[0]);
});
