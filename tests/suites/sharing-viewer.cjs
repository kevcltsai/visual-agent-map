// Sharing P1 (Worker B): the share viewer, its stylesheet, and the pure HTML assembly. No Obsidian and no browser needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, load, root, plain } = require('../support.cjs');
const { buildSync } = require('../build.cjs');

const html = load('experiences/sharing/share-html.ts');
const bundle = load('experiences/sharing/viewer-bundle.generated.ts');
const text = load('experiences/sharing/share-viewer-text.ts');
const uiModule = load('experiences/sharing/share-viewer-ui.ts');
const scan = load('experiences/sharing/share-leak-scan.ts');
const edge = load('experiences/sharing/viewer/edge-path.ts');
const { parseMap } = load('map-model.ts');
const language = load('experiences/sharing/viewer/language.ts');
const dictionaries = load('experiences/sharing/share-viewer-dictionaries.ts');
const build = load('experiences/sharing/share-build.ts');
const cssTools = import(pathToFileURL(path.join(root, 'scripts', 'viewer-css.mjs')).href);

const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const payload = () => JSON.parse(read('tests/fixtures/sharing/viewer-payload.json'));
const LANGUAGES = ['en', 'zh-TW', 'zh-CN'];
const INSTALL_URL = 'https://github.com/kevcltsai/visual-agent-map?ref=share';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const forbiddenFor = () => {
  const map = parseMap(read('tests/fixtures/sharing/Map.md'));
  return scan.forbiddenStringsFor({ vaultPath: '/Users/someone/Vault One', vaultName: 'Vault One', mapFolder: 'Private Vault Folder/Share Map' }, map, [{ model: 'claude:sonnet-secret' }, { model: 'gpt-5.5' }]);
};

test('sharing viewer: stylesheet rules are copied from styles.css unchanged and the generated file is current', async () => {
  const tools = await cssTools;
  const styles = read('styles.css');
  const rules = tools.extractViewerRules(styles);
  const known = tools.allRuleTexts(styles);
  assert.ok(rules.length > 40, 'the extraction keeps the card, canvas and panel rules');
  for (const item of rules) for (const rule of item.rules) assert.ok(known.has(rule), `not a rule of styles.css: ${rule.slice(0, 80)}`);
  const wanted = ['.vam-node {', '.vam-node:hover {', '.vam-node.is-selected {', '.vam-edge {', '.vam-edge.vam-edge-side {', '.vam-relevance-tag[data-tier="core"] {', '.vam-status {', '.vam-card-title {', '.vam-card-summary {', '.vam-inspector {', '.vam-toolbar {', '.vam-zoom {', '.vam-viewport {', '.vam-stage {', '.vam-map-tools, .vam-zoom-controls {'];
  const flat = rules.flatMap(item => item.rules);
  for (const start of wanted) assert.ok(flat.some(rule => rule.startsWith(start)), `${start} must be taken from styles.css`);
  // The rules appear in the shipped stylesheet byte for byte.
  for (const rule of flat) assert.ok(bundle.SHARE_VIEWER_CSS.includes(rule), `missing in the viewer stylesheet: ${rule.slice(0, 80)}`);
  assert.equal(bundle.SHARE_VIEWER_CSS, tools.composeViewerCss(read('experiences/sharing/viewer/viewer.css'), styles), 'run npm run build: viewer-bundle.generated.ts is stale');
  // Rules about fields the viewer must not carry are not extracted.
  assert.doesNotMatch(bundle.SHARE_VIEWER_CSS, /data-aim-kind="|vam-aim|marquee|relevance-goal/);
});

test('sharing viewer: every CSS variable the stylesheet uses is defined', () => {
  const css = bundle.SHARE_VIEWER_CSS;
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(match => match[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]));
  const missing = [...used].filter(name => !defined.has(name));
  assert.deepEqual(missing, []);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /\.theme-dark \.vam-node/);
});

test('sharing viewer: the edge curve is the plugin\'s edgePathData', () => {
  const view = read('experiences/visual-map/view.ts');
  const plugin = view.match(/function edgePathData\([^)]*\): string \{([\s\S]*?)\n\}/)[1].trim();
  const copy = read('experiences/sharing/viewer/edge-path.ts').match(/function edgePathData\([^)]*\): string \{([\s\S]*?)\n\}/)[1].trim();
  assert.equal(copy, plugin);
  const original = new Function(`return function (x1, y1, x2, y2) {${plugin.replace(/: number/g, '')}}`)();
  for (const [x1, y1, x2, y2] of [[0, 0, 360, 100], [280, 40, 300, 40], [500, 20, 80, 400], [10.5, 2.25, 700, -90]]) assert.equal(edge.edgePathData(x1, y1, x2, y2), original(x1, y1, x2, y2));
});

test('sharing viewer: the bundle is built from the plugin\'s own layout and nothing from Obsidian', () => {
  const result = buildSync({ entryPoints: [path.join(root, 'experiences/sharing/viewer/index.ts')], platform: 'browser', format: 'iife', metafile: true, external: [] });
  const inputs = Object.keys(result.metafile.inputs).map(file => path.relative(root, path.resolve(process.cwd(), file)).split(path.sep).join('/')).sort();
  assert.deepEqual(inputs, ['experiences/sharing/share-translate-compact.ts', 'experiences/sharing/share-translate-plan.ts', 'experiences/sharing/share-translate-segments.ts', 'experiences/sharing/share-viewer-ui.ts', 'experiences/sharing/viewer/detail.ts', 'experiences/sharing/viewer/dom.ts', 'experiences/sharing/viewer/edge-path.ts', 'experiences/sharing/viewer/index.ts', 'experiences/sharing/viewer/language.ts', 'experiences/sharing/viewer/main.ts', 'experiences/visual-map/viewport-inset.ts', 'map-graph.ts', 'map-layout.ts', 'topic-markers.ts']);
  const graph = load('map-graph.ts');
  const model = load('map-model.ts');
  const node = { id: 'a', path: 'a', parentId: 'p', x: 0, y: 0, collapsed: false, aimKind: 'answer', aimConvergesFromNodeIds: ['p', 'q'] };
  assert.deepEqual(plain(graph.parentIdsForNode(node)), plain(model.parentIdsForNode(node)));
  assert.deepEqual(plain(graph.parentIdsForNode(node)), ['p', 'q']);
  const nodes = [{ id: 'r', parentId: null, path: 'r', x: 0, y: 0, collapsed: false }, { id: 'k', parentId: 'r', path: 'k', x: 0, y: 0, collapsed: false }, { id: 'g', parentId: 'k', path: 'g', x: 0, y: 0, collapsed: false }];
  const viaGraph = plain(graph.visibleNodes(plain(nodes)).map(n => n.id));
  assert.deepEqual(viaGraph, plain(model.visibleNodes(plain(nodes)).map(n => n.id)));
  const a = plain(nodes), b = plain(nodes);
  graph.applyCollapseLevel(a, 1);
  model.applyCollapseLevel(b, 1);
  assert.deepEqual(a, b);
  assert.equal(a[1].collapsed, true);
});

test('sharing viewer: the shell loads nothing from the network and holds no external reference', () => {
  for (const lang of LANGUAGES) {
    const shell = html.renderShareShell(text.shareViewerUiFor(lang));
    const urls = [...shell.matchAll(/https?:\/\/[^\s"'<>)\\]*/g)].map(match => match[0]);
    assert.deepEqual([...new Set(urls)].sort(), [INSTALL_URL, SVG_NAMESPACE].sort());
    assert.doesNotMatch(shell, /<script[^>]*\ssrc=/i);
    assert.doesNotMatch(shell, /<link\b/i);
    assert.doesNotMatch(shell, /@import/i);
    assert.doesNotMatch(shell, /url\(\s*["']?(?!data:)/i, 'no url() in the stylesheet except data URIs');
    assert.doesNotMatch(shell, /\ssrc=["']https?:|\shref=["']https?:/i);
    assert.equal((shell.match(/<script\b/g) ?? []).length, 3);
    assert.match(shell, /http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:;/);
  }
  assert.ok(bundle.SHARE_VIEWER_JS.includes(INSTALL_URL));
  assert.equal(INSTALL_URL, 'https://github.com/kevcltsai/visual-agent-map?ref=share');
  assert.ok(!/Open in VAM|在 VAM 開啟/.test(bundle.SHARE_VIEWER_JS + bundle.SHARE_VIEWER_CSS), 'P1 has no open-in-VAM');
});

test('sharing viewer: the viewer program has no eval and writes titles and summaries with textContent only', () => {
  const sources = ['main.ts', 'detail.ts', 'edge-path.ts', 'index.ts'].map(name => read(`experiences/sharing/viewer/${name}`));
  const js = bundle.SHARE_VIEWER_JS;
  for (const source of [...sources, js]) {
    assert.doesNotMatch(source, /\beval\s*\(/);
    assert.doesNotMatch(source, /new\s+Function\b|\bFunction\s*\(/);
    assert.doesNotMatch(source, /document\.write|insertAdjacentHTML|\.outerHTML|\.innerHTML|setTimeout\(\s*["'`]/);
  }
  assert.match(sources[0], /\.textContent = text/);
  // Storage is only touched inside try/catch.
  const main = sources[0];
  assert.equal((main.match(/localStorage/g) ?? []).length, 2);
  assert.match(main, /storageGet\(languageStorageKey\)/);
  assert.match(main, /storageSet\(languageStorageKey, code\)/);
  for (const name of ['storageGet', 'storageSet']) assert.match(main, new RegExp(`function ${name}[\\s\\S]*?try \\{[\\s\\S]*?localStorage[\\s\\S]*?catch`));
  assert.match(main, /vam-share-panel-width/);
});

test('sharing viewer: the shell and the viewer program hit no forbidden string, so only the payload needs a field scan', () => {
  const forbidden = forbiddenFor();
  for (const lang of LANGUAGES) {
    const shell = html.renderShareShell(text.shareViewerUiFor(lang));
    assert.deepEqual(plain(scan.scanForLeaks(shell, forbidden)), [], `${lang} shell`);
  }
  assert.deepEqual(plain(scan.scanForLeaks(bundle.SHARE_VIEWER_JS, forbidden)), []);
  assert.deepEqual(plain(scan.scanForLeaks(bundle.SHARE_VIEWER_CSS, forbidden)), []);
  for (const name of scan.INTERNAL_FIELD_NAMES) {
    assert.equal(bundle.SHARE_VIEWER_JS.includes(name), false, name);
    assert.equal(bundle.SHARE_VIEWER_CSS.includes(name), false, name);
  }
  for (const needle of ['[[', 'app://', 'obsidian://', 'file://', 'content-language']) {
    assert.equal(bundle.SHARE_VIEWER_JS.includes(needle), false, `JS ${needle}`);
    assert.equal(bundle.SHARE_VIEWER_CSS.includes(needle), false, `CSS ${needle}`);
  }
});

test('sharing viewer: the final-file gate is payload scan plus shell scan, and the demo payload passes it', () => {
  const data = payload();
  const forbidden = forbiddenFor();
  assert.deepEqual(plain(scan.scanPayloadForLeaks(data, forbidden)), []);
  const ui = text.shareViewerUiFor('en');
  assert.deepEqual(plain(scan.scanForLeaks(html.renderShareShell(ui), forbidden)), []);
  // A whole-file scan would wrongly block the demo's code sample (`[[1,[2]]]`): that is why the payload is scanned per field.
  const whole = html.renderShareHtml(data, ui);
  assert.ok(scan.scanForLeaks(whole, forbidden).every(hit => hit.category === 'wikilink'));
  data.nodes[0].summary = 'see [[Private]]';
  assert.ok(scan.scanPayloadForLeaks(data, forbidden).some(hit => hit.category === 'wikilink'));
});

test('sharing viewer: renderShareHtml output parses back to the payload and survives hostile content', () => {
  const data = payload();
  const ui = text.shareViewerUiFor('zh-TW');
  const output = html.renderShareHtml(data, ui);
  assert.deepEqual(plain(html.parseShareHtml(output)), plain(data));
  assert.match(output, /^<!doctype html>\n<html lang="zh-TW">/);
  assert.match(output, /<title>Cooking science \(demo\)<\/title>/);
  data.title = '</title><script>alert(1)</script> & "q"';
  data.nodes[0].detailHtml = '</script><script>alert(2)</script><!-- x --> ';
  data.nodes[0].summary = '</SCRIPT>';
  const hostile = html.renderShareHtml(data, ui);
  assert.equal((hostile.match(/<script\b/gi) ?? []).length, 3, 'only the file\'s own three script blocks');
  assert.equal((hostile.match(/<\/script>/gi) ?? []).length, 3);
  assert.deepEqual(plain(html.parseShareHtml(hostile)), plain(data));
  assert.match(hostile, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;q&quot;<\/title>/);
  const uiBlock = /<script type="application\/json" id="vam-ui">([\s\S]*?)<\/script>/.exec(output)[1];
  assert.deepEqual(plain(JSON.parse(uiBlock)), plain(ui));
  assert.equal(html.parseShareHtml('<p>nothing</p>'), undefined);
});

test('sharing viewer: interface text exists in all three languages and the English fallback matches the dictionary', () => {
  assert.deepEqual(plain(text.shareViewerUiFor('en')), plain(uiModule.SHARE_VIEWER_UI_DEFAULT));
  const english = text.shareViewerUiFor('en');
  for (const lang of LANGUAGES) {
    const ui = text.shareViewerUiFor(lang);
    assert.equal(ui.lang, lang);
    assert.deepEqual(Object.keys(ui).sort(), Object.keys(english).sort());
    for (const [key, value] of Object.entries(ui).flatMap(([k, v]) => k === 'markerNames' ? Object.entries(v).map(([id, name]) => [`${k}.${id}`, name]) : [[k, v]])) assert.ok(typeof value === 'string' && value.trim(), `${lang}.${key}`);
    for (const key of ['goal', 'expandToLevel', 'zoomReset', 'expandCount', 'imageSource']) assert.match(ui[key], /\{0\}/, `${lang}.${key}`);
    assert.ok(!/\{[1-9]\}/.test(JSON.stringify(ui)));
  }
  for (const lang of ['zh-TW', 'zh-CN']) for (const key of ['install', 'madeWithVam', 'readOnly', 'tierCore', 'topicDetails']) assert.notEqual(text.shareViewerUiFor(lang)[key], english[key], `${lang}.${key} is translated`);
  assert.equal(text.shareViewerUiFor('zh-TW').install, '安裝 VAM');
  assert.equal(text.shareViewerUiFor('zh-CN').madeWithVam, '由 VAM 制作');
});

test('sharing viewer: the demo tool writes the same file renderShareHtml produces', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-demo-'));
  try {
    const out = path.join(directory, 'demo.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'zh-CN'], { cwd: root });
    const written = fs.readFileSync(out, 'utf8');
    const data = payload();
    data.language = 'zh-CN';
    assert.equal(written, html.renderShareHtml(data, text.shareViewerUiFor('zh-CN')));
    assert.match(written, /<html lang="zh-CN">/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sharing viewer: the demo payload covers table, callout, SVG, data-URL image and a web image', () => {
  const data = payload();
  const rich = data.nodes.find(node => node.detailHtml?.includes('<table'));
  assert.ok(rich.detailHtml.includes('callout') && rich.detailHtml.includes('<svg') && rich.detailHtml.includes('vam-asset:image-1') && rich.detailHtml.includes('https://example.org/pic.jpg'));
  assert.match(data.assets['image-1'], /^data:image\/png;base64,/);
  assert.ok(data.nodes.some(node => node.tier === 'side') && data.nodes.some(node => node.manual) && data.nodes.some(node => node.status === 'idea'));
  const depth = id => { let d = 0; for (let n = data.nodes.find(x => x.id === id); n.parentId; n = data.nodes.find(x => x.id === n.parentId)) d++; return d; };
  assert.ok(Math.max(...data.nodes.map(node => depth(node.id))) >= 4, 'deep enough to test "expand to level N"');
});

test('sharing viewer: a web image gets a visible, localized source line with the original link', () => {
  const detail = load('experiences/sharing/viewer/detail.ts');
  for (const lang of LANGUAGES) {
    const ui = text.shareViewerUiFor(lang);
    assert.match(ui.imageSource, /\{0\}/, `${lang}.imageSource`);
    const [before, host, after] = detail.imageSourceParts('https://example.org/a/pic.jpg?x=1', ui);
    assert.equal(host, 'example.org');
    assert.equal(before + '{0}' + after, ui.imageSource);
  }
  assert.deepEqual(plain(detail.imageSourceParts('https://example.org/p.jpg', text.shareViewerUiFor('zh-TW'))), ['來源：', 'example.org', '']);
  assert.equal(detail.imageSourceParts('not a url', text.shareViewerUiFor('en'))[1], 'not a url');
  const js = bundle.SHARE_VIEWER_JS;
  assert.ok(js.includes('vam-image-source') && js.includes('noopener noreferrer'), 'the generated viewer builds the source line');
  assert.ok(bundle.SHARE_VIEWER_CSS.includes('.vam-sample-detail .vam-image-source'));
});

test('sharing viewer: at phone width the side panel covers the whole workspace and the map is not squeezed', () => {
  const css = bundle.SHARE_VIEWER_CSS;
  assert.match(css, /@media \(max-width: 600px\) \{ \.vam-workspace\.has-inspector > \.vam-canvas-overlay \{ right: 0; \} \.vam-inspector \{ width: 100%;/);
  assert.ok(css.indexOf('.vam-workspace.has-inspector > .vam-canvas-overlay { right: 0; }') > css.indexOf('.vam-workspace.has-inspector > .vam-canvas-overlay { right: 300px; }'), 'the narrow rule comes later and wins');
});

test('sharing viewer O-4: at phone width the panel heading (with Close) is sticky so it stays reachable', () => {
  const css = bundle.SHARE_VIEWER_CSS;
  const rule = css.match(/@media \(max-width: 600px\) \{ \.vam-inspector-heading \{([^}]*)\}/);
  assert.ok(rule, 'narrow sticky heading rule exists');
  assert.match(rule[1], /position: sticky/);
  assert.match(rule[1], /top: 0/);
  assert.match(rule[1], /background: var\(--background-primary\)/);
});

// ---- Sharing translation T1 (W-B): the viewer's language choice, menu text and the unchanged P1 page.
const pick = (languages, input = {}) => language.pickShareLanguage({ languages, browser: [], ...input });

test('sharing viewer language: order is stored, then defaultLanguage, then the browser, then the original', () => {
  const langs = ['fr', 'en', 'ja', 'zh-TW'];
  assert.equal(pick(langs), 'fr');
  assert.equal(pick(langs, { browser: ['de-DE', 'en-US'] }), 'en');
  assert.equal(pick(langs, { browser: ['ja'], defaultLanguage: 'zh-TW' }), 'zh-TW');
  assert.equal(pick(langs, { browser: ['en'], defaultLanguage: 'ja', stored: 'zh-TW' }), 'zh-TW');
  assert.equal(pick(langs, { browser: ['en'], defaultLanguage: 'ja', stored: 'ko' }), 'ja', 'a stored language the file lacks is ignored');
  assert.equal(pick(langs, { browser: ['en'], defaultLanguage: 'ko' }), 'en', 'a default the file lacks is ignored');
  assert.equal(pick(langs, { browser: ['de', 'it'] }), 'fr', 'nothing matches: the original');
  assert.equal(pick(langs, { stored: null, defaultLanguage: undefined, browser: [] }), 'fr');
  assert.equal(pick(['de', 'en'], { defaultLanguage: 'en', browser: ['de'] }), 'en', 'defaultLanguage beats the browser');
});

test('sharing viewer language: Chinese variants and region tags map the way the plan says', () => {
  const both = ['en', 'zh-TW', 'zh-CN'];
  for (const tag of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-TW', 'zh-hant-hk', 'zh_TW']) assert.equal(language.matchBrowserLanguage(tag, both), 'zh-TW', tag);
  for (const tag of ['zh-Hans', 'zh-CN', 'zh-SG', 'zh', 'zh-Hans-CN', 'ZH']) assert.equal(language.matchBrowserLanguage(tag, both), 'zh-CN', tag);
  assert.equal(language.matchBrowserLanguage('zh-CN', ['en', 'zh-TW']), undefined, 'no Simplified in the file: no match, the next browser language is tried');
  assert.equal(pick(['en', 'zh-TW'], { browser: ['zh-CN', 'zh-TW'] }), 'zh-TW');
  assert.equal(language.matchBrowserLanguage('en-US', both), 'en');
  assert.equal(language.matchBrowserLanguage('ja-JP', ['fr', 'ja']), 'ja');
  // A region tag falls back to its main language code; an exact tag the file carries wins first.
  assert.equal(language.matchBrowserLanguage('pt-BR', ['fr', 'pt']), 'pt');
  assert.equal(language.matchBrowserLanguage('pt-PT', ['fr', 'pt-BR']), 'pt-BR');
  assert.equal(language.matchBrowserLanguage('pt-BR', ['pt', 'pt-BR']), 'pt-BR');
  assert.equal(language.matchBrowserLanguage('pt-BR', ['fr', 'es']), undefined);
  assert.equal(language.matchBrowserLanguage('', both), undefined);
  assert.equal(language.matchBrowserLanguage(undefined, both), undefined);
});

test('sharing viewer language: a throwing localStorage never stops the viewer from choosing a language', () => {
  const main = read('experiences/sharing/viewer/main.ts');
  // storageGet returns null on any error, and pickShareLanguage treats null/undefined stored as "no choice yet".
  assert.match(main, /function storageGet[\s\S]*?try \{[\s\S]*?catch \{\s*return null;/);
  assert.equal(pick(['fr', 'en'], { stored: null, browser: ['en'] }), 'en');
  assert.equal(pick(['fr', 'en'], { stored: undefined, browser: ['en'] }), 'en');
  // The navigator read is guarded too.
  assert.match(main, /try \{\s*browser = Array\.from\(window\.navigator\.languages/);
});

test('sharing viewer language: the remembered choice is per file; the old global key is never read; no map id remembers nothing', () => {
  assert.equal(language.shareLanguageKey('map-a'), 'vam-share-language:map-a');
  assert.notEqual(language.shareLanguageKey('map-a'), language.shareLanguageKey('map-b'));
  assert.equal(language.shareLanguageKey(undefined), undefined);
  assert.equal(language.shareLanguageKey(''), undefined);
  assert.equal(language.shareLanguageKey(42), undefined);
  const main = read('experiences/sharing/viewer/main.ts');
  assert.ok(!/["'`]vam-share-language["'`]/.test(main), 'the old global key is not referenced');
  assert.match(main, /stored: languageStorageKey \? storageGet\(languageStorageKey\) : null/);
  assert.match(main, /if \(languageStorageKey\) storageSet\(languageStorageKey, code\)/);
  // A stored choice for another file is simply not looked up; storage that throws still falls through to defaultLanguage.
  assert.equal(pick(['fr', 'en'], { stored: null, defaultLanguage: 'en', browser: ['fr'] }), 'en');
});

test('sharing viewer language: interface text for ja, ko and es is complete and marked as not native-reviewed', () => {
  const english = text.shareViewerUiFor('en');
  for (const code of ['ja', 'ko', 'es']) {
    const ui = dictionaries.SHARE_VIEWER_UI_EXTRA[code];
    assert.equal(ui.lang, code);
    assert.deepEqual(Object.keys(ui).sort(), Object.keys(english).sort(), code);
    for (const [key, value] of Object.entries(ui).flatMap(([k, v]) => k === 'markerNames' ? Object.entries(v).map(([id, name]) => [`${k}.${id}`, name]) : [[k, v]])) assert.ok(typeof value === 'string' && value.trim(), `${code}.${key}`);
    for (const key of ['goal', 'expandToLevel', 'zoomReset', 'expandCount', 'imageSource', 'aiTranslated']) assert.match(ui[key], /\{0\}/, `${code}.${key}`);
    assert.ok(!/\{[1-9]\}/.test(JSON.stringify(ui)));
  }
  assert.match(read('experiences/sharing/share-viewer-dictionaries.ts'), /NOT[\s*]+native-reviewed/);
  // The three new strings exist in the plugin dictionaries for every interface language.
  for (const lang of LANGUAGES) {
    const ui = text.shareViewerUiFor(lang);
    assert.ok(ui.language && ui.aiTranslated.includes('{0}') && ui.imageTextUntranslated, lang);
  }
});

test('sharing viewer language: a translated file carries the interface text of each of its languages, a plain file nothing extra', () => {
  const data = payload();
  const ui = text.shareViewerUiFor('en');
  const plainOutput = html.renderShareHtml(data, ui);
  const plainBlock = JSON.parse(/<script type="application\/json" id="vam-ui">([\s\S]*?)<\/script>/.exec(plainOutput)[1]);
  assert.deepEqual(Object.keys(plainBlock).sort(), Object.keys(ui).sort(), 'no extra fields without translations');
  assert.match(plainOutput, /^<!doctype html>\n<html lang="en">/);
  const pieces = ['en', 'ja', 'ko', 'es', 'zh-TW'].map(lang => ({ language: lang, piece: { top: { title: `T ${lang}` }, nodes: {} } }));
  const translated = build.attachTranslations(data, { contentLanguage: 'fr', pieces, defaultLanguage: 'ja' });
  const output = html.renderShareHtml(translated, ui);
  assert.match(output, /<html lang="fr">/, '<html lang> is the content language');
  assert.equal((output.match(/<script\b/g) ?? []).length, 3);
  const block = JSON.parse(/<script type="application\/json" id="vam-ui">([\s\S]*?)<\/script>/.exec(output)[1]);
  assert.deepEqual(Object.keys(block.uiByLanguage).sort(), ['en', 'es', 'fr', 'ja', 'ko', 'zh-TW']);
  assert.equal(block.uiByLanguage.ja.install, dictionaries.SHARE_VIEWER_UI_EXTRA.ja.install);
  assert.equal(block.uiByLanguage.fr.install, ui.install, 'a language outside the six shows English interface text');
  assert.equal(block.languageNames.ja, '日本語');
  assert.equal(block.languageNames['zh-TW'], '繁體中文');
  assert.equal(block.languageNames.en, 'English');
  assert.equal(block.languageNames.fr, 'Français');
  assert.equal(block.install, ui.install, 'the plain fields are unchanged');
  assert.deepEqual(plain(html.parseShareHtml(output)), plain(translated));
  // The leak gate scans the same text.
  const forbidden = forbiddenFor();
  assert.deepEqual(plain(scan.scanForLeaks(html.renderShareShell(ui, translated.languages), forbidden)), []);
  assert.ok(html.renderShareShell(ui, translated.languages).includes('"uiByLanguage"'));
});

/** Runs headless Chrome over CDP with the colour scheme pinned to light, so the DOM does not depend on the OS appearance. */
async function dumpDomLight(chrome, directory, url, timeoutMs = 60000, drive = undefined) {
  const profile = path.join(directory, 'profile');
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore', detached: true }); // own process group, so cleanup can end Chrome's helper processes too
  let timer;
  let stopped = false;
  let exitInfo = null;
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`dumpDomLight timed out after ${timeoutMs} ms`)), timeoutMs); });
  const work = async () => {
    // Chrome picks a free port itself (port 0) and writes it to DevToolsActivePort; wait for that within the overall timeout.
    let target;
    while (!target && !stopped) {
      if (exitInfo) throw new Error(`Chrome exited before its debugging endpoint was up (code ${exitInfo.code}, signal ${exitInfo.signal})`);
      try {
        const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
        if (port > 0) target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page');
      } catch { /* not up yet */ }
      if (!target) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(target, 'Chrome debugging endpoint is up');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mine = ++id;
      pending.set(mine, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      socket.send(JSON.stringify({ id: mine, method, params }));
    });
    await send('Page.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const loaded = new Promise(resolve => { const previous = socket.onmessage; socket.onmessage = event => { previous(event); if (JSON.parse(event.data).method === 'Page.loadEventFired') resolve(); }; });
    await send('Page.navigate', { url });
    await loaded;
    await new Promise(resolve => setTimeout(resolve, 1500));
    // `drive(send)` lets a test operate the page (real mouse and key events) and returns its own result instead of the DOM dump.
    if (drive) {
      try { return await drive(send); } finally { socket.close(); }
    }
    const result = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
    socket.close();
    return result.result.value;
  };
  try {
    const running = work();
    running.catch(() => {}); // after a timeout the killed Chrome makes it reject; that is already reported
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
    stopped = true;
    const exited = exitInfo ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    // Chrome's crashpad/renderer helpers keep writing to the profile after the main process dies: end the whole group.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    await exited;
    // Removing the temp profile is not tested behaviour: a leftover temp directory must not fail the test.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`dumpDomLight: could not remove temp profile: ${error.message}`); }
  }
}

test('sharing viewer language: a plain file shows exactly the P1 page (same DOM in headless Chrome, light scheme pinned)', async t => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)'); // The page DOM is also compared by the viewer's own manual check; this layer needs a browser.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-p1-'));
  try {
    const out = path.join(directory, 'p1.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en'], { cwd: root });
    const dom = await dumpDomLight(chrome, directory, pathToFileURL(out).href);
    const clean = value => value.replace(/transform: translate\([^)]*\) scale\([^)]*\);/, 'transform: T;');
    const app = dom.slice(dom.indexOf('<div id="vam-app"'), dom.indexOf('<script type="application/json" id="vam-ui">')).trimEnd() + '\n';
    assert.equal(clean(app), clean(read('tests/fixtures/sharing/viewer-p1-app.html')));
    assert.match(dom, /<html lang="en">/);
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer collapse: the fold button is always visible and works by mouse and keyboard, then pan and zoom still work (headless Chrome)', async t => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-fold-'));
  try {
    const out = path.join(directory, 'fold.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en'], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const nodes = () => evaluate('document.querySelectorAll(".vam-node").length');
      const state = id => evaluate(`(() => { const c = document.querySelector('[data-node-id="${id}"]'); return c && { expanded: c.getAttribute('aria-expanded'), button: c.querySelector('.vam-collapse-button')?.textContent ?? null }; })()`);
      const click = async selector => {
        const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      };
      const key = async (name, code) => {
        await send('Input.dispatchKeyEvent', { type: name === 'Enter' ? 'keyDown' : 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code, ...(name === 'Enter' ? { text: '\r' } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
      };
      const focusCard = id => evaluate(`document.querySelector('[data-node-id="${id}"]').focus()`);
      const stamp = id => evaluate(`document.querySelector('[data-node-id="${id}"]').__stamp = 1`);
      const stamped = id => evaluate(`document.querySelector('[data-node-id="${id}"]')?.__stamp === 1`);
      const transformOf = () => evaluate('document.querySelector(".vam-stage").style.transform');
      const result = {};
      const LEFT = 37, RIGHT = 39;
      result.start = await nodes();
      result.rootButton = await evaluate(`(() => { const b = document.querySelector('[data-node-id="root"] .vam-collapse-button'); return { inHeader: !!b.closest('.vam-node-header'), inTools: !!b.closest('.vam-node-tools'), opacity: getComputedStyle(b).opacity, label: b.getAttribute('aria-label'), title: b.title, text: b.textContent }; })()`);
      // Mouse: collapse hides the children and does not open the side panel; the next click brings them back and keeps focus on the button.
      await click('[data-node-id="root"] .vam-collapse-button');
      result.mouseCollapsed = { nodes: await nodes(), root: await state('root'), inspectorHidden: await evaluate('document.querySelector(".vam-inspector").hidden') };
      result.mouseCollapsedLabel = await evaluate(`document.querySelector('[data-node-id="root"] .vam-collapse-button').getAttribute('aria-label')`);
      await click('[data-node-id="root"] .vam-collapse-button');
      result.mouseExpanded = { nodes: await nodes(), root: await state('root'), inspectorHidden: await evaluate('document.querySelector(".vam-inspector").hidden'), focusOnButton: await evaluate(`document.activeElement === document.querySelector('[data-node-id="root"] .vam-collapse-button')`) };
      // Keyboard on the card: ArrowLeft folds, a second ArrowLeft does nothing, ArrowRight unfolds.
      await focusCard('root');
      await key('ArrowLeft', LEFT);
      result.keyCollapsed = { nodes: await nodes(), root: await state('root') };
      await stamp('root');
      await key('ArrowLeft', LEFT);
      result.keyCollapsedAgain = { nodes: await nodes(), root: await state('root'), same: await stamped('root') };
      await key('ArrowRight', RIGHT);
      result.keyExpanded = { nodes: await nodes(), root: await state('root') };
      // A card with no sub-topics: both arrows do nothing and there is no fold button.
      await focusCard('heat');
      await key('ArrowRight', RIGHT);
      result.heatOpened = await nodes();
      const leaf = await evaluate(`(() => { const c = Array.from(document.querySelectorAll('.vam-node')).find(card => !card.hasAttribute('aria-expanded')); return c && c.dataset.nodeId; })()`);
      result.leaf = leaf;
      await stamp(leaf);
      await focusCard(leaf);
      await key('ArrowLeft', LEFT);
      await key('ArrowRight', RIGHT);
      result.leafAfter = { nodes: await nodes(), same: await stamped(leaf), buttons: await evaluate(`document.querySelectorAll('[data-node-id="${leaf}"] .vam-collapse-button').length`) };
      // Keyboard on the button itself: it is a native button, so Enter folds it and focus comes back to the new button.
      await evaluate(`document.querySelector('[data-node-id="root"] .vam-collapse-button').focus()`);
      await key('Enter', 13);
      result.enterCollapsed = { nodes: await nodes(), root: await state('root'), focusOnButton: await evaluate(`document.activeElement === document.querySelector('[data-node-id="root"] .vam-collapse-button')`) };
      // With the map folded, zoom and pan still move the stage.
      const before = await transformOf();
      await click('.vam-zoom-controls button[aria-label="Zoom in"]');
      result.zoomed = (await transformOf()) !== before;
      const beforePan = await transformOf();
      const area = await evaluate(`(() => { const r = document.querySelector('.vam-viewport').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.bottom - 120 }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...area });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...area, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: area.x + 60, y: area.y - 40, button: 'left' });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: area.x + 60, y: area.y - 40, button: 'left', clickCount: 1 });
      result.panned = (await transformOf()) !== beforePan;
      return result;
    });
    assert.equal(report.start, 4);
    assert.deepEqual(report.rootButton, { inHeader: true, inTools: false, opacity: '1', label: 'Collapse', title: 'Collapse', text: 'Collapse' }, 'the open card shows its fold button in the header without hover or focus');
    assert.deepEqual(report.mouseCollapsed, { nodes: 1, root: { expanded: 'false', button: 'Expand 11' }, inspectorHidden: true });
    assert.equal(report.mouseCollapsedLabel, 'Expand 11');
    assert.deepEqual(report.mouseExpanded, { nodes: 4, root: { expanded: 'true', button: 'Collapse' }, inspectorHidden: true, focusOnButton: true });
    assert.deepEqual(report.keyCollapsed, { nodes: 1, root: { expanded: 'false', button: 'Expand 11' } });
    assert.deepEqual(report.keyCollapsedAgain, { nodes: 1, root: { expanded: 'false', button: 'Expand 11' }, same: true }, 'ArrowLeft on a folded card changes nothing');
    assert.deepEqual(report.keyExpanded, { nodes: 4, root: { expanded: 'true', button: 'Collapse' } });
    assert.ok(report.heatOpened > 4, 'ArrowRight opens a folded card');
    assert.ok(report.leaf, 'the demo has a card without sub-topics');
    assert.deepEqual(report.leafAfter, { nodes: report.heatOpened, same: true, buttons: 0 }, 'arrows on a card without sub-topics do nothing');
    assert.deepEqual(report.enterCollapsed, { nodes: 1, root: { expanded: 'false', button: 'Expand 11' }, focusOnButton: true });
    assert.equal(report.zoomed, true, 'zoom works after folding');
    assert.equal(report.panned, true, 'dragging empty space pans after folding');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

// ---- 0.28 ticket 05: the share viewer's left-hand outline.
test('sharing viewer outline: the interface text exists in every language and the viewer keeps its rules (textContent only, one storage key)', () => {
  assert.equal(text.shareViewerUiFor('en').outline, 'Outline');
  assert.equal(text.shareViewerUiFor('zh-TW').outline, '大綱');
  assert.equal(text.shareViewerUiFor('zh-CN').outline, '大纲');
  assert.equal(dictionaries.SHARE_VIEWER_UI_EXTRA.ja.outline, 'アウトライン');
  assert.equal(dictionaries.SHARE_VIEWER_UI_EXTRA.ko.outline, '개요');
  assert.equal(dictionaries.SHARE_VIEWER_UI_EXTRA.es.outline, 'Esquema');
  assert.equal(uiModule.SHARE_VIEWER_UI_DEFAULT.outline, 'Outline');
  const main = read('experiences/sharing/viewer/main.ts');
  assert.match(main, /vam-share-outline-open/);
  assert.equal((main.match(/localStorage/g) ?? []).length, 2, 'storage is still only touched inside storageGet and storageSet');
  assert.match(main, /storageGet\(OUTLINE_OPEN_KEY\)/);
  assert.doesNotMatch(main, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(main, /ui\.outline/);
  const css = bundle.SHARE_VIEWER_CSS;
  assert.match(css, /\.vam-outline \{[^}]*width: 260px/);
  assert.match(css, /@media \(max-width: 600px\) \{[^@]*\.vam-outline \{[^}]*min\(85vw, 320px\)/);
  assert.doesNotMatch(bundle.SHARE_VIEWER_JS, /<\/script|<!--/);
  assert.ok(bundle.SHARE_VIEWER_JS.includes('vam-outline-title'), 'the generated viewer builds the outline');
});

function findChrome() {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  return candidates.find(file => fs.existsSync(file));
}

/** Page helpers for the outline tests: evaluate, real mouse clicks, real key events, a reload that keeps the emulation. */
function pageTools(send) {
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const centerOf = selector => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async selector => {
    const point = await centerOf(selector);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const CODES = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13, Escape: 27 };
  const key = async name => {
    await send('Input.dispatchKeyEvent', { type: name === 'Enter' ? 'keyDown' : 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: CODES[name], ...(name === 'Enter' ? { text: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: CODES[name] });
  };
  const reload = async () => {
    await send('Page.reload');
    await new Promise(resolve => setTimeout(resolve, 1800));
  };
  const row = id => `.vam-outline [data-outline-id="${id}"]`;
  const focusedRow = () => evaluate(`document.activeElement?.closest('.vam-outline [role="treeitem"]')?.dataset.outlineId ?? null`);
  const visibleRows = () => evaluate(`Array.from(document.querySelectorAll('.vam-outline [role="treeitem"]')).filter(r => r.getClientRects().length).map(r => r.dataset.outlineId)`);
  const cardCount = () => evaluate('document.querySelectorAll(".vam-node").length');
  const transformOf = () => evaluate('document.querySelector(".vam-stage").style.transform');
  const current = () => evaluate(`Array.from(document.querySelectorAll('.vam-outline [aria-current]')).map(r => r.dataset.outlineId)`);
  const panelHidden = () => evaluate('document.querySelector(".vam-inspector").hidden');
  return { evaluate, click, key, reload, row, focusedRow, visibleRows, cardCount, transformOf, current, panelHidden };
}

function depthsOf(data) {
  const parent = new Map(data.nodes.map(node => [node.id, node.parentId]));
  const depth = id => (parent.get(id) ? 1 + depth(parent.get(id)) : 1);
  return Object.fromEntries(data.nodes.map(node => [node.id, depth(node.id)]));
}

const TOGGLE = '.vam-toolbar button[aria-controls]';

test('sharing viewer outline: the tree mirrors the map, folds on its own, jumps to a topic, is keyboard operable and does not disturb pan and zoom (headless Chrome, desktop)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-outline-'));
  try {
    const out = path.join(directory, 'outline.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en'], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 90000, async send => {
      const { evaluate, click, key, reload, row, focusedRow, visibleRows, cardCount, transformOf, current, panelHidden } = pageTools(send);
      const result = {};
      result.items = await evaluate(`Array.from(document.querySelectorAll('.vam-outline [role="treeitem"]')).map(r => [r.dataset.outlineId, Number(r.getAttribute('aria-level')), r.getAttribute('aria-expanded'), r.querySelector('.vam-outline-title')?.textContent, r.querySelector('.vam-outline-title')?.title])`);
      result.structure = await evaluate(`(() => { const n = document.querySelector('nav.vam-outline'); const b = document.querySelector('${TOGGLE}'); return { role: n.querySelector('[role="tree"]') ? 'tree' : null, label: n.getAttribute('aria-label'), hidden: n.hidden, width: n.getBoundingClientRect().width, toggleFirst: document.querySelector('.vam-toolbar').firstElementChild === b, toggleLabel: b.getAttribute('aria-label'), toggleTitle: b.title, expanded: b.getAttribute('aria-expanded'), controls: b.getAttribute('aria-controls') === n.id && !!n.id, tabbable: n.querySelectorAll('[role="treeitem"][tabindex="0"]').length }; })()`);
      result.layout = await evaluate(`(() => { const o = document.querySelector('.vam-outline').getBoundingClientRect(); const v = document.querySelector('.vam-viewport').getBoundingClientRect(); const ov = document.querySelector('.vam-canvas-overlay').getBoundingClientRect(); const g = document.querySelector('.vam-map-tools').getBoundingClientRect(); const h = document.querySelector('.vam-canvas-hint').getBoundingClientRect(); return { viewportLeft: v.left, outlineRight: o.right, overlayLeft: ov.left, goalLeft: g.left, hintLeft: h.left }; })()`);
      result.visibleAtStart = (await visibleRows()).length;
      result.cardsAtStart = await cardCount();
      // The arrow folds only the outline.
      await click(`${row('heat')} .vam-outline-twist`);
      result.folded = { rows: await visibleRows(), cards: await cardCount(), expanded: await evaluate(`document.querySelector('${row('heat')}').getAttribute('aria-expanded')`) };
      await click(`${row('heat')} .vam-outline-twist`);
      result.unfolded = { rows: (await visibleRows()).length, cards: await cardCount() };
      // A grandchild under a map-collapsed ancestor: the cards open, the card is selected, focused and on screen, and the panel stays shut.
      await click(`${row('deep')} .vam-outline-title`);
      result.jump = await evaluate(`(() => { const c = document.querySelector('[data-node-id="deep"]'); if (!c) return null; const r = c.getBoundingClientRect(); const v = document.querySelector('.vam-viewport').getBoundingClientRect(); const o = document.querySelector('.vam-outline').getBoundingClientRect(); return { selected: c.classList.contains('is-selected'), ariaSelected: c.getAttribute('aria-selected'), focused: document.activeElement === c, centerInside: r.left + r.width / 2 > v.left && r.left + r.width / 2 < v.right && r.top + r.height / 2 > v.top && r.top + r.height / 2 < v.bottom, clearOfOutline: r.left + r.width / 2 > o.right, cards: document.querySelectorAll('.vam-node').length, ancestorOpen: ['heat', 'maillard', 'amino'].map(id => document.querySelector('[data-node-id="' + id + '"]')?.getAttribute('aria-expanded')) }; })()`);
      result.jumpPanelHidden = await panelHidden();
      result.jumpCurrent = await current();
      // With the panel open, a jump shows the topic in it; a card click, the panel's sub-topic list and Escape all keep the outline in step.
      await evaluate(`document.querySelector('[data-node-id="root"]').click()`);
      result.afterCardClick = { panelHidden: await panelHidden(), current: await current() };
      await click(`${row('water')} .vam-outline-title`);
      result.jumpWithPanel = { panelHidden: await panelHidden(), heading: await evaluate('document.querySelector(".vam-inspector h3")?.textContent'), current: await current() };
      await evaluate(`Array.from(document.querySelectorAll('.vam-subtopics button')).find(b => b.textContent === 'Evaporation').click()`);
      result.afterSubtopic = await current();
      await key('Escape');
      result.afterEscape = { panelHidden: await panelHidden(), current: await current() };
      // Keyboard (roving tabindex).
      await evaluate(`document.querySelector('${row('root')}').focus()`);
      const walk = [];
      const expandedNow = () => evaluate(`document.activeElement.getAttribute('aria-expanded')`);
      await key('ArrowDown'); walk.push(await focusedRow());
      await key('ArrowRight'); walk.push(await focusedRow());
      await key('ArrowRight'); walk.push(await focusedRow());
      await key('ArrowRight'); walk.push(await focusedRow());
      await key('ArrowLeft'); walk.push(await focusedRow()); // a topic without sub-topics: to the parent
      await key('ArrowLeft'); walk.push(await expandedNow()); // an open parent: fold
      await key('ArrowLeft'); walk.push(await focusedRow()); // a folded one: to its parent
      await key('ArrowLeft'); walk.push(await expandedNow());
      await key('ArrowDown'); walk.push(await focusedRow());
      await key('ArrowUp'); walk.push(await focusedRow());
      await key('End'); walk.push(await focusedRow());
      await key('Home'); walk.push(await focusedRow());
      result.walk = walk;
      result.roving = await evaluate(`Array.from(document.querySelectorAll('.vam-outline [role="treeitem"][tabindex="0"]')).map(r => r.dataset.outlineId)`);
      await evaluate(`document.querySelector('${row('s1')}').focus()`);
      await key('Enter');
      result.enter = await evaluate(`(() => { const c = document.querySelector('[data-node-id="s1"]'); return c && { selected: c.classList.contains('is-selected'), focused: document.activeElement === c }; })()`);
      // Pan and zoom are untouched while the outline is open; scrolling over the outline does not zoom the map.
      const before = await transformOf();
      await click('.vam-zoom-controls button[aria-label="Zoom in"]');
      result.zoomed = (await transformOf()) !== before;
      const beforePan = await transformOf();
      const area = await evaluate(`(() => { const r = document.querySelector('.vam-viewport').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.bottom - 120 }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...area });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...area, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: area.x + 60, y: area.y - 40, button: 'left' });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: area.x + 60, y: area.y - 40, button: 'left', clickCount: 1 });
      result.panned = (await transformOf()) !== beforePan;
      const beforeWheel = await transformOf();
      const onOutline = await evaluate(`(() => { const r = document.querySelector('.vam-outline').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...onOutline, deltaX: 0, deltaY: -120, modifiers: 2 });
      result.wheelOnOutline = (await transformOf()) === beforeWheel;
      // Closing it gives the canvas the whole width and the choice is remembered; opening again brings it back.
      await click(TOGGLE);
      result.closed = await evaluate(`(() => ({ hidden: document.querySelector('.vam-outline').hidden, expanded: document.querySelector('${TOGGLE}').getAttribute('aria-expanded'), sameWidth: document.querySelector('.vam-viewport').getBoundingClientRect().width === document.querySelector('.vam-workspace').getBoundingClientRect().width, overlayLeft: document.querySelector('.vam-canvas-overlay').getBoundingClientRect().left, stored: window.localStorage.getItem('vam-share-outline-open') }))()`);
      await reload();
      result.closedAfterReload = await evaluate(`document.querySelector('.vam-outline').hidden`);
      await click(TOGGLE);
      result.reopened = await evaluate(`({ hidden: document.querySelector('.vam-outline').hidden, stored: window.localStorage.getItem('vam-share-outline-open') })`);
      return result;
    });
    const data = payload();
    const depth = depthsOf(data);
    assert.deepEqual(report.items.map(item => item[0]), ['root', 'heat', 'maillard', 'amino', 'deep', 'sugars', 'caramel', 'water', 'a1', 'a2', 'salt', 's1'], 'one row per topic, depth-first');
    for (const [id, level, expanded, title, tip] of report.items) {
      const node = data.nodes.find(item => item.id === id);
      assert.equal(level, depth[id], `aria-level of ${id}`);
      assert.equal(title, node.title);
      assert.equal(tip, node.title, 'the title attribute holds the full title');
      const hasKids = data.nodes.some(item => item.parentId === id);
      assert.equal(expanded, hasKids ? 'true' : null, `aria-expanded of ${id}: only a topic with sub-topics has it, and the outline starts fully open`);
    }
    assert.deepEqual(report.structure, { role: 'tree', label: 'Outline', hidden: false, width: 260, toggleFirst: true, toggleLabel: 'Outline', toggleTitle: 'Outline', expanded: 'true', controls: true, tabbable: 1 });
    assert.equal(report.layout.viewportLeft, report.layout.outlineRight, 'the map sits beside the outline, not under it');
    assert.equal(report.layout.overlayLeft, report.layout.outlineRight, 'the goal, hint and zoom bar make way for the outline');
    assert.ok(report.layout.goalLeft > report.layout.outlineRight && report.layout.hintLeft > report.layout.outlineRight);
    assert.equal(report.visibleAtStart, 12);
    assert.equal(report.cardsAtStart, 4);
    assert.deepEqual(report.folded.rows, ['root', 'heat', 'water', 'a1', 'a2', 'salt', 's1']);
    assert.equal(report.folded.expanded, 'false');
    assert.equal(report.folded.cards, 4, 'folding the outline does not fold the map');
    assert.deepEqual(report.unfolded, { rows: 12, cards: 4 });
    assert.deepEqual(plain(report.jump), { selected: true, ariaSelected: 'true', focused: true, centerInside: true, clearOfOutline: true, cards: report.jump.cards, ancestorOpen: ['true', 'true', 'true'] });
    assert.ok(report.jump.cards > 4, 'the collapsed ancestors opened');
    assert.equal(report.jumpPanelHidden, true, 'a jump with the panel shut does not open it');
    assert.deepEqual(report.jumpCurrent, ['deep']);
    assert.deepEqual(report.afterCardClick, { panelHidden: false, current: ['root'] });
    assert.deepEqual(report.jumpWithPanel, { panelHidden: false, heading: 'Water in food', current: ['water'] });
    assert.deepEqual(report.afterSubtopic, ['a2']);
    assert.deepEqual(report.afterEscape, { panelHidden: true, current: [] });
    assert.deepEqual(report.walk, ['heat', 'maillard', 'amino', 'deep', 'amino', 'false', 'maillard', 'false', 'caramel', 'maillard', 's1', 'root']);
    assert.equal(report.roving.length, 1, 'one tab stop');
    assert.deepEqual(report.enter, { selected: true, focused: true });
    assert.equal(report.zoomed, true, 'zoom works with the outline open');
    assert.equal(report.panned, true, 'dragging empty space pans with the outline open');
    assert.equal(report.wheelOnOutline, true, 'scrolling the outline does not zoom the map');
    assert.deepEqual(report.closed, { hidden: true, expanded: 'false', sameWidth: true, overlayLeft: 0, stored: '0' });
    assert.equal(report.closedAfterReload, true, 'the closed state is remembered');
    assert.deepEqual(report.reopened, { hidden: false, stored: '1' });
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer outline: at phone width it starts shut, opens as a drawer over the map, closes after a jump and on Escape, and remembers nothing (headless Chrome, 390x800)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-outline-narrow-'));
  try {
    const out = path.join(directory, 'narrow.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en'], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 90000, async send => {
      const { evaluate, click, key, reload, row } = pageTools(send);
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: false });
      await reload();
      const state = () => evaluate(`(() => { const n = document.querySelector('.vam-outline'); const r = n.getBoundingClientRect(); const v = document.querySelector('.vam-viewport').getBoundingClientRect(); return { hidden: n.hidden, expanded: document.querySelector('${TOGGLE}').getAttribute('aria-expanded'), drawerWidth: n.hidden ? 0 : r.width, position: getComputedStyle(n).position, shadow: getComputedStyle(n).boxShadow !== 'none', canvasFull: v.width === document.querySelector('.vam-workspace').getBoundingClientRect().width, stored: window.localStorage.getItem('vam-share-outline-open') }; })()`);
      const result = { initial: await state() };
      await click(TOGGLE);
      result.opened = await state();
      await click(`${row('maillard')} .vam-outline-title`);
      result.afterJump = await state();
      result.focus = await evaluate(`document.activeElement === document.querySelector('[data-node-id="maillard"]')`);
      result.selected = await evaluate(`document.querySelector('[data-node-id="maillard"]').classList.contains('is-selected')`);
      await click(TOGGLE);
      await key('Escape');
      result.afterEscape = await state();
      result.focusOnToggle = await evaluate(`document.activeElement === document.querySelector('${TOGGLE}')`);
      await click(TOGGLE);
      result.reopened = await state();
      return result;
    });
    assert.deepEqual(report.initial, { hidden: true, expanded: 'false', drawerWidth: 0, position: 'absolute', shadow: true, canvasFull: true, stored: null });
    assert.deepEqual(report.opened, { hidden: false, expanded: 'true', drawerWidth: 320, position: 'absolute', shadow: true, canvasFull: true, stored: null });
    assert.deepEqual(report.afterJump, { hidden: true, expanded: 'false', drawerWidth: 0, position: 'absolute', shadow: true, canvasFull: true, stored: null });
    assert.equal(report.focus, true, 'the card gets focus after the drawer closes');
    assert.equal(report.selected, true);
    assert.equal(report.afterEscape.hidden, true);
    assert.equal(report.focusOnToggle, true, 'Escape returns focus to the toggle');
    assert.equal(report.reopened.stored, null, 'phone width never writes the remembered state');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer outline: a hostile title stays literal text, a throwing localStorage still shows the outline, and a language switch keeps the outline folds (headless Chrome)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-outline-hostile-'));
  try {
    const hostile = '<img src=x onerror=alert(1)>';
    const data = payload();
    data.nodes.find(node => node.id === 's1').title = hostile;
    const payloadFile = path.join(directory, 'payload.json');
    fs.writeFileSync(payloadFile, JSON.stringify(data));
    const out = path.join(directory, 'hostile.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', payloadFile, '--translate', 'ja', '--content-language', 'en', '--default-language', 'en'], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 90000, async send => {
      const { evaluate, click, row, visibleRows } = pageTools(send);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errors = []; window.addEventListener('error', e => window.__errors.push(String(e.message))); Storage.prototype.getItem = function () { throw new Error('blocked'); }; Storage.prototype.setItem = function () { throw new Error('blocked'); };` });
      await send('Page.reload');
      await new Promise(resolve => setTimeout(resolve, 1800));
      const result = {};
      result.shown = { hidden: await evaluate(`document.querySelector('.vam-outline').hidden`), rows: (await visibleRows()).length, errors: await evaluate('window.__errors') };
      result.hostile = await evaluate(`(() => { const t = document.querySelector('${row('s1')} .vam-outline-title'); return { text: t.textContent, images: document.querySelectorAll('.vam-outline img').length, children: t.children.length }; })()`);
      await click(`${row('heat')} .vam-outline-twist`);
      await evaluate(`(() => { const s = document.querySelector('.vam-language'); s.value = 'ja'; s.dispatchEvent(new Event('change')); })()`);
      await new Promise(resolve => setTimeout(resolve, 300));
      result.switched = await evaluate(`({ heat: document.querySelector('${row('heat')} .vam-outline-title').textContent, folded: document.querySelector('${row('heat')}').getAttribute('aria-expanded'), rows: Array.from(document.querySelectorAll('.vam-outline [role="treeitem"]')).filter(r => r.getClientRects().length).length, label: document.querySelector('.vam-outline').getAttribute('aria-label'), errors: window.__errors })`);
      return result;
    });
    assert.deepEqual(report.shown, { hidden: false, rows: 12, errors: [] });
    assert.deepEqual(report.hostile, { text: hostile, images: 0, children: 0 });
    assert.equal(report.switched.heat, '[ja] Heat and food');
    assert.equal(report.switched.folded, 'false', 'the fold survives the language switch');
    assert.equal(report.switched.rows, 7);
    assert.equal(report.switched.label, 'アウトライン', 'the outline label follows the language');
    assert.deepEqual(report.switched.errors, []);
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer language: switching goes through the same text and detail paths as the original', () => {
  const main = read('experiences/sharing/viewer/main.ts');
  // A translated note's detailHtml reaches fillDetail (DOMParser clean-up) exactly like the original's, and every text is set with textContent.
  assert.match(main, /fillDetail\(doc, detail, item\.detailHtml, assets, ui\)/);
  assert.match(main, /detailHtml: isText\(translation\.detailHtml\) \? translation\.detailHtml : item\.detailHtml/);
  assert.doesNotMatch(main, /innerHTML|insertAdjacentHTML/);
  assert.match(main, /doc\.documentElement\.lang = code/);
  assert.match(main, /languageSelect\.setAttribute\("aria-label", ui\.language\)/);
});

/** In-page WCAG contrast: text colour against the background actually behind it, with every ancestor's opacity and translucent background blended in. */
const CONTRAST_PROBE = `(() => {
  const parse = value => {
    let m = value.match(/^rgba?\\(([^)]+)\\)$/);
    if (m) { const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = value.match(/^color\\(srgb ([^)]+)\\)$/);
    if (m) { const p = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    throw new Error('unparsed colour ' + value);
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const mix = (o, inner, outer) => ({ r: o * inner.r + (1 - o) * outer.r, g: o * inner.g + (1 - o) * outer.g, b: o * inner.b + (1 - o) * outer.b, a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const contrast = (el, colour) => {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.unshift(e);
    const backdrop = [];
    const inner = [];
    let below = { r: 255, g: 255, b: 255, a: 1 };
    chain.forEach((e, i) => {
      const style = getComputedStyle(e);
      backdrop[i] = below;
      inner[i] = over(parse(style.backgroundColor), below);
      below = mix(Number(style.opacity), inner[i], below);
    });
    const lift = start => { let x = start; for (let i = chain.length - 1; i >= 0; i--) x = mix(Number(getComputedStyle(chain[i]).opacity), x, backdrop[i]); return x; };
    const last = chain.length - 1;
    const text = lift(over(parse(colour ?? getComputedStyle(el).color), inner[last]));
    const bg = lift(inner[last]);
    return ratio(text, bg);
  };
  const shown = selector => Array.from(document.querySelectorAll(selector)).filter(e => e.getClientRects().length);
  const worst = (selector, colourOf) => { const els = shown(selector); if (!els.length) return null; return Math.round(Math.min(...els.map(e => contrast(e, colourOf?.(e)))) * 100) / 100; };
  const out = {};
  const text = {
    outlineItem: '.vam-outline-item:not([aria-current="true"]) .vam-outline-title',
    outlineCurrent: '.vam-outline-item[aria-current="true"] .vam-outline-title',
    shared: '.vam-shared',
    madeWith: '.vam-made-with',
    cardTitle: '.vam-node:not([data-relevance="side"]) .vam-card-title',
    cardSummary: '.vam-node:not([data-relevance="side"]) .vam-card-summary',
    collapse: '.vam-node:not([data-relevance="side"]) .vam-collapse-button',
    sideTitle: '.vam-node[data-relevance="side"] .vam-card-title',
    sideSummary: '.vam-node[data-relevance="side"] .vam-card-summary',
    sideCollapse: '.vam-node[data-relevance="side"] .vam-collapse-button',
    sideTag: '.vam-node[data-relevance="side"] .vam-relevance-tag',
    idea: '.vam-status-idea',
    hint: '.vam-canvas-hint',
    zoom: '.vam-zoom',
    goal: '.vam-goal-text'
  };
  for (const [name, selector] of Object.entries(text)) out[name] = worst(selector);
  out.twist = worst('.vam-outline-twist');
  out.ideaCircle = worst('.vam-status-idea', e => getComputedStyle(e, '::before').borderTopColor);
  return out;
})()`;

test('sharing viewer colour: every text and icon in the outline, toolbar, cards and tags meets WCAG AA in both light and dark (headless Chrome, opacity and translucent fills blended in)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-colour-'));
  try {
    const out = path.join(directory, 'colour.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en'], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 120000, async send => {
      const { evaluate, click, reload, row } = pageTools(send);
      const measure = async scheme => {
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await reload();
        await click(`${row('heat')} .vam-outline-title`);
        await new Promise(resolve => setTimeout(resolve, 300));
        const ratios = await evaluate(CONTRAST_PROBE);
        const details = await evaluate(`(() => {
          const side = document.querySelector('.vam-node[data-relevance="side"]');
          const current = document.querySelector('.vam-outline-item[aria-current="true"]');
          const plain = document.querySelector('.vam-outline-item:not([aria-current="true"])');
          return {
            scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
            sideBorder: getComputedStyle(side).borderTopStyle, sideOpacity: getComputedStyle(side).opacity, sideTag: !!side.querySelector('.vam-relevance-tag'),
            currentShadow: getComputedStyle(current).boxShadow, currentBg: getComputedStyle(current).backgroundColor, plainBg: getComputedStyle(plain).backgroundColor, currentWeight: getComputedStyle(current).fontWeight
          };
        })()`);
        return { ratios, details };
      };
      return { light: await measure('light'), dark: await measure('dark') };
    });
    for (const scheme of ['light', 'dark']) {
      const { ratios, details } = report[scheme];
      assert.equal(details.scheme, scheme, 'the emulated scheme took effect');
      console.log(`contrast ${scheme}: ${JSON.stringify(ratios)}`);
      for (const [name, value] of Object.entries(ratios)) {
        assert.notEqual(value, null, `${scheme}: ${name} exists in the demo`);
        const need = name === 'twist' || name === 'ideaCircle' ? 3 : 4.5;
        assert.ok(value >= need, `${scheme}: ${name} contrast ${value} must be >= ${need}`);
      }
      // Counterexamples: the cues that replace the fade stay visible.
      assert.equal(details.sideBorder, 'dashed', `${scheme}: a side topic keeps its dashed frame`);
      assert.equal(details.sideTag, true, `${scheme}: a side topic keeps its tag`);
      assert.equal(details.sideOpacity, '1', `${scheme}: a side topic is not faded in the viewer`);
      assert.notEqual(details.currentShadow, 'none', `${scheme}: the current outline row keeps its inset bar`);
      assert.notEqual(details.currentBg, details.plainBg, `${scheme}: the current outline row keeps its own fill`);
      assert.equal(details.currentWeight, '600', `${scheme}: the current outline row is bold`);
    }
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer: marker text exists in every language, names and the "markers: {0}" label', () => {
  const markers = ['done', 'warning', 'star', 'priority-1', 'priority-2', 'priority-3'];
  const everyUi = [...LANGUAGES.map(lang => text.shareViewerUiFor(lang)), ...Object.values(dictionaries.SHARE_VIEWER_UI_EXTRA)];
  assert.equal(everyUi.length, 6);
  for (const ui of everyUi) {
    assert.match(ui.markerLabel, /\{0\}/, `${ui.lang}.markerLabel`);
    assert.deepEqual(Object.keys(ui.markerNames).sort(), [...markers].sort(), ui.lang);
    for (const id of markers) assert.ok(ui.markerNames[id].trim(), `${ui.lang}.${id}`);
  }
  assert.equal(text.shareViewerUiFor('zh-TW').markerLabel, '標記：{0}');
  assert.equal(text.shareViewerUiFor('zh-TW').markerNames.done, '完成');
  assert.equal(text.shareViewerUiFor('en').markerNames.star, 'Star');
});

test('sharing viewer markers: cards and outline show aria-hidden symbols and a named label, and a hostile id draws nothing (headless Chrome)', async t => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-markers-'));
  try {
    const data = payload();
    data.nodes[0].markers = ['star', 'done', '<img src=x onerror="document.title=1">', 'Done', 'priority-2', 'future-x'];
    data.nodes[1].markers = 'done';
    const out = path.join(directory, 'markers.html');
    fs.writeFileSync(out, html.renderShareHtml(data, text.shareViewerUiFor('zh-TW')));
    const rootId = data.nodes[0].id;
    const secondId = data.nodes[1].id;
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      return evaluate(`(() => {
        const card = document.querySelector('[data-node-id=${JSON.stringify(rootId)}]');
        const other = document.querySelector('[data-node-id=${JSON.stringify(secondId)}]');
        const row = document.querySelector('[data-outline-id=${JSON.stringify(rootId)}]');
        const marks = el => [...el.querySelectorAll('.vam-marker')].map(m => ({ text: m.textContent, hidden: m.getAttribute('aria-hidden'), tag: m.tagName }));
        return { card: marks(card), label: card.getAttribute('aria-label'), otherMarks: other ? other.querySelectorAll('.vam-marker').length : -1, otherLabel: other && other.getAttribute('aria-label'), row: marks(row), rowLabel: row.getAttribute('aria-label'), images: document.querySelectorAll('img[src="x"]').length, title: document.title };
      })()`);
    });
    assert.deepEqual(plain(report.card.map(m => m.text)), ['✓', '★', 'P2']);
    assert.ok(report.card.every(m => m.hidden === 'true'), 'symbols are aria-hidden');
    assert.match(report.label, /標記：完成、星號、優先 2$/);
    assert.deepEqual(plain(report.row.map(m => m.text)), ['✓', '★', 'P2']);
    assert.ok(report.row.every(m => m.hidden === 'true'));
    assert.match(report.rowLabel, /標記：完成、星號、優先 2$/);
    assert.equal(report.otherMarks, 0, 'a non-list value draws nothing');
    assert.ok(!/標記/.test(report.otherLabel ?? ''), 'no marker text without markers');
    assert.equal(report.images, 0, 'a hostile id is never turned into markup');
    assert.notEqual(report.title, '1');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});
