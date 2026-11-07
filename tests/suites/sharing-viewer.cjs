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
const viewerDetail = load('experiences/sharing/viewer/detail.ts');
const topicLinks = load('topic-links.ts');
const dictionaries = load('experiences/sharing/share-viewer-dictionaries.ts');
const build = load('experiences/sharing/share-build.ts');
const cssTools = import(pathToFileURL(path.join(root, 'scripts', 'viewer-css.mjs')).href);

const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const payload = () => JSON.parse(read('tests/fixtures/sharing/viewer-payload.json'));
/** The folds the viewer used to apply on open ("expand to level 1"), now stored in the file: opening keeps the saved folds (owner-approved change, share-match-map). */
const levelOnePayload = () => {
  const data = payload();
  for (const id of ['heat', 'water', 'salt', 'maillard', 'amino']) data.nodes.find(node => node.id === id).collapsed = true;
  return data;
};
const writeLevelOne = directory => {
  const file = path.join(directory, 'level-one.json');
  fs.writeFileSync(file, JSON.stringify(levelOnePayload()));
  return file;
};
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
  assert.deepEqual(inputs, ['experiences/sharing/share-translate-compact.ts', 'experiences/sharing/share-translate-plan.ts', 'experiences/sharing/share-translate-segments.ts', 'experiences/sharing/share-viewer-ui.ts', 'experiences/sharing/viewer/cover-dom.ts', 'experiences/sharing/viewer/detail.ts', 'experiences/sharing/viewer/dom.ts', 'experiences/sharing/viewer/edge-path.ts', 'experiences/sharing/viewer/image-data.ts', 'experiences/sharing/viewer/index.ts', 'experiences/sharing/viewer/language.ts', 'experiences/sharing/viewer/main.ts', 'experiences/visual-map/canvas-items.ts', 'experiences/visual-map/cover-layout.ts', 'experiences/visual-map/image-ring.ts', 'experiences/visual-map/relation-geometry.ts', 'experiences/visual-map/tree-edge-rules.ts', 'experiences/visual-map/viewport-inset.ts', 'layouts/balanced.ts', 'layouts/compose.ts', 'layouts/fishbone.ts', 'layouts/radial.ts', 'layouts/timeline.ts', 'layouts/vertical.ts', 'map-graph.ts', 'map-layout-text.ts', 'map-layout.ts', 'topic-colors.ts', 'topic-markers.ts']);
  // share-match-map: the map's own pure layout, ring, line and cover geometry joined the bundle; the view itself (which binds to Obsidian) never does.
  assert.ok(!inputs.some(file => /obsidian|visual-map\/view\.ts|share-exporter|share-format\.ts/.test(file)), 'no Obsidian-bound module is in the viewer bundle');
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
  const sources = ['main.ts', 'detail.ts', 'edge-path.ts', 'index.ts', 'cover-dom.ts', 'image-data.ts'].map(name => read(`experiences/sharing/viewer/${name}`));
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
    for (const [key, value] of Object.entries(ui).flatMap(([k, v]) => k === 'markerNames' || k === 'colorNames' ? Object.entries(v).map(([id, name]) => [`${k}.${id}`, name]) : [[k, v]])) assert.ok(typeof value === 'string' && value.trim(), `${lang}.${key}`);
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
    for (const [key, value] of Object.entries(ui).flatMap(([k, v]) => k === 'markerNames' || k === 'colorNames' ? Object.entries(v).map(([id, name]) => [`${k}.${id}`, name]) : [[k, v]])) assert.ok(typeof value === 'string' && value.trim(), `${code}.${key}`);
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

/** Waits until the page of the current document is ready: fonts loaded (the viewer fits again after that) and two painted frames. It never waits longer than `capMs`, the fixed wait this replaced, so a page that never gets there is read after the same time as before. */
async function settled(send, capMs) {
  const ready = send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))', awaitPromise: true, returnByValue: true }).catch(() => {});
  let timer;
  await Promise.race([ready, new Promise(resolve => { timer = setTimeout(resolve, capMs); })]);
  clearTimeout(timer);
}

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
    const eventWaiters = new Map();
    socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); if (message.method) { for (const resolve of eventWaiters.get(message.method) ?? []) resolve(); eventWaiters.delete(message.method); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mine = ++id;
      pending.set(mine, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      socket.send(JSON.stringify({ id: mine, method, params }));
    });
    // A promise for the next time Chrome sends this event; ask for it before the call that causes the event, so it cannot be missed.
    send.waitEvent = method => new Promise(resolve => { eventWaiters.set(method, [...(eventWaiters.get(method) ?? []), resolve]); });
    await send('Page.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const loaded = new Promise(resolve => { const previous = socket.onmessage; socket.onmessage = event => { previous(event); if (JSON.parse(event.data).method === 'Page.loadEventFired') resolve(); }; });
    await send('Page.navigate', { url });
    await loaded;
    await settled(send, 1500);
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
    // One evaluate: the page DOM and the card boxes the tree lines were drawn from, read in the same task.
    const geometry = `(() => { const box = e => ({ left: e.offsetLeft, top: e.offsetTop, width: e.offsetWidth, height: e.offsetHeight }); return { html: document.documentElement.outerHTML, cards: Object.fromEntries([...document.querySelectorAll('.vam-node')].map(e => [e.dataset.nodeId, box(e)])), edges: [...document.querySelectorAll('.vam-edges .vam-edge')].map(e => e.getAttribute('d')) }; })()`;
    const page = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => (await send('Runtime.evaluate', { expression: geometry, returnByValue: true })).result.value);
    const dom = page.html;
    const clean = value => value.replace(/transform: translate\([^)]*\) scale\([^)]*\);/, 'transform: T;');
    // A line ends at offsetTop + offsetHeight / 2, and the card height follows the font (one wrapped line more or less per OS): the golden keeps the x of every line and the pixel y is checked against the cards below.
    const noLineY = value => value.replace(/(<path d=")([^"]*)(" class="vam-edge)/g, (_, a, d, c) => a + d.replace(/-?\d+(?:\.\d+)?/g, (n, i, all) => (all.slice(0, i).match(/-?\d+(?:\.\d+)?/g) ?? []).length % 2 ? 'Y' : n) + c);
    const app = dom.slice(dom.indexOf('<div id="vam-app"'), dom.indexOf('<script type="application/json" id="vam-ui">')).trimEnd() + '\n';
    assert.equal(noLineY(clean(app)), noLineY(clean(read('tests/fixtures/sharing/viewer-p1-app.html'))), 'cards, text and line x match the golden');
    const nodes = JSON.parse(read('tests/fixtures/sharing/viewer-payload.json')).nodes.filter(node => node.parentId);
    assert.equal(page.edges.length, nodes.length, 'one tree line per child topic');
    nodes.forEach((node, index) => {
      const parent = page.cards[node.parentId];
      const child = page.cards[node.id];
      const [x1, y1, , , , , x2, y2] = page.edges[index].match(/-?\d+(?:\.\d+)?/g).map(Number);
      const expected = [parent.left + parent.width, parent.top + parent.height / 2, child.left, child.top + child.height / 2];
      [x1, y1, x2, y2].forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= 0.5, `line ${node.parentId} > ${node.id} coordinate ${i}: ${value} vs ${expected[i]}`));
    });
    assert.match(dom, /<html lang="en">/);
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer fit: the first view and Show all include a free text block far from every topic (headless Chrome)', async t => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-fit-'));
  try {
    const data = payload();
    data.textNodes = [{ id: 'far', text: 'Far away note', x: 1200, y: 900 }];
    const source = path.join(directory, 'payload.json');
    fs.writeFileSync(source, JSON.stringify(data));
    const out = path.join(directory, 'fit.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', source], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const inside = () => evaluate(`(() => { const e = document.querySelector('.vam-text-node.is-free'); const v = document.querySelector('.vam-viewport').getBoundingClientRect(); if (!e) return null; const r = e.getBoundingClientRect(); return r.left >= v.left - 1 && r.top >= v.top - 1 && r.right <= v.right + 1 && r.bottom <= v.bottom + 1; })()`);
      await new Promise(resolve => setTimeout(resolve, 500));
      const first = await inside();
      await evaluate(`document.querySelector('.vam-viewport').dispatchEvent(new WheelEvent('wheel', { deltaY: -2000, clientX: 10, clientY: 10, cancelable: true }))`);
      const zoomed = await inside();
      await evaluate(`document.querySelector('button[aria-label="Show all"], button[title="Show all"]')?.click()`);
      await new Promise(resolve => setTimeout(resolve, 300));
      return { first, zoomed, again: await inside() };
    });
    assert.equal(report.first, true, 'the first view shows the free block');
    assert.equal(report.again, true, 'Show all brings the free block back into view');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer summaries: brackets are drawn from textContent and one SVG path equal to the plugin geometry, hostile text stays text (headless Chrome)', async t => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const geometry = load('experiences/visual-map/summary-bracket-geometry.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-summary-'));
  try {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const data = payload();
    data.summaries = [
      { id: 'sum1', parentId: 'root', members: ['heat', 'water'], side: 'right', text: evil },
      { id: 'sum2', parentId: 'root', members: ['nope'], side: 'right', text: 'dangling run' },
      { id: 'sum3', parentId: 'root', members: ['heat'], side: 'sideways', text: 'bad side' }
    ];
    const source = path.join(directory, 'payload.json');
    fs.writeFileSync(source, JSON.stringify(data));
    const out = path.join(directory, 'summary.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', source], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      await new Promise(resolve => setTimeout(resolve, 600));
      return evaluate(`(() => {
        const items = [...document.querySelectorAll('.vam-summary')];
        return {
          count: items.length,
          text: items[0]?.querySelector('.vam-summary-text')?.textContent,
          d: items[0]?.querySelector('path')?.getAttribute('d'),
          imgs: document.querySelectorAll('.vam-summary img, .vam-summary script').length,
          pwned: window.__pwned ?? null,
          tags: [...(items[0]?.querySelectorAll('*') ?? [])].map(e => e.tagName.toLowerCase()),
          rects: [...document.querySelectorAll('.vam-node')].map(c => ({ id: c.dataset.nodeId, x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }))
        };
      })()`);
    });
    assert.equal(report.count, 1, 'a dangling run and an unknown side draw nothing');
    assert.equal(report.text, evil);
    assert.equal(report.imgs, 0);
    assert.equal(report.pwned, null);
    assert.deepEqual(report.tags.sort(), ['div', 'path', 'svg']);
    // The brace follows the outer edge of heat, water and everything under them.
    const children = new Map(data.nodes.map(n => [n.id, data.nodes.filter(c => c.parentId === n.id).map(c => c.id)]));
    const below = id => [id, ...children.get(id).flatMap(below)];
    const ids = new Set(['heat', 'water'].flatMap(below));
    const rects = report.rects.filter(r => ids.has(r.id));
    const expected = geometry.bracketGeometry('right', rects, null);
    assert.equal(expected.ok, true);
    assert.equal(report.d, expected.path, 'the viewer copy of the brace shape equals the plugin geometry');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer summaries: the drawing code writes text with textContent and builds only div, svg and path', () => {
  const src = read('experiences/sharing/viewer/main.ts');
  const start = src.indexOf('function drawSummaries');
  const block = src.slice(start, src.indexOf('let edgeFrame'));
  assert.ok(start > 0 && block.includes('label.textContent = summary.text'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/.test(block));
});

test('sharing viewer collapse: the fold button is always visible and works by mouse and keyboard, then pan and zoom still work (headless Chrome)', async t => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-fold-'));
  try {
    const out = path.join(directory, 'fold.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', writeLevelOne(directory)], { cwd: root });
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
    // Wait for the new document's load event first, so the readiness check below runs on the reloaded page and not on the old one.
    const loaded = send.waitEvent('Page.loadEventFired');
    await send('Page.reload');
    await Promise.race([loaded, new Promise(resolve => setTimeout(resolve, 1800))]);
    await settled(send, 1800);
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
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', writeLevelOne(directory)], { cwd: root });
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
  const markers = ['done', 'warning', 'star', 'priority-1', 'priority-2', 'priority-3', 'priority-4', 'priority-5', 'progress-0', 'progress-25', 'progress-50', 'progress-75', 'progress-100', 'flag-red', 'flag-yellow', 'flag-green', 'flag-blue', 'smile', 'neutral', 'sad', 'question'];
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
    data.nodes[0].markers = ['star', 'done', '<img src=x onerror="document.title=1">', 'Done', 'priority-2', 'future-x', 'flag-red', 'progress-50', '<b>x</b>'];
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
    assert.deepEqual(plain(report.card.map(m => m.text)), ['✓', '★', 'P2', '◑', '⚑R']);
    assert.ok(report.card.every(m => m.hidden === 'true'), 'symbols are aria-hidden');
    assert.match(report.label, /標記：完成、星號、優先 2、進度 50%、紅旗$/);
    assert.deepEqual(plain(report.row.map(m => m.text)), ['✓', '★', 'P2', '◑', '⚑R']);
    assert.ok(report.row.every(m => m.hidden === 'true'));
    assert.match(report.rowLabel, /標記：完成、星號、優先 2、進度 50%、紅旗$/);
    assert.equal(report.otherMarks, 0, 'a non-list value draws nothing');
    assert.ok(!/標記/.test(report.otherLabel ?? ''), 'no marker text without markers');
    assert.equal(report.images, 0, 'a hostile id is never turned into markup');
    assert.notEqual(report.title, '1');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer topic-color: colour text exists in every language, names and the "colour: {0}" label', () => {
  const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
  const everyUi = [...LANGUAGES.map(lang => text.shareViewerUiFor(lang)), ...Object.values(dictionaries.SHARE_VIEWER_UI_EXTRA)];
  assert.equal(everyUi.length, 6);
  for (const ui of everyUi) {
    assert.match(ui.colorLabel, /\{0\}/, `${ui.lang}.colorLabel`);
    assert.deepEqual(Object.keys(ui.colorNames).sort(), [...colors].sort(), ui.lang);
    for (const id of colors) assert.ok(ui.colorNames[id].trim(), `${ui.lang}.${id}`);
  }
  assert.equal(text.shareViewerUiFor('zh-TW').colorLabel, '顏色：{0}');
  assert.equal(text.shareViewerUiFor('zh-TW').colorNames.red, '紅色');
  assert.equal(text.shareViewerUiFor('en').colorNames.blue, 'Blue');
});

test('sharing viewer topic-color: a card carries data-topic-color and a named label, and a hostile or malformed value draws nothing (headless Chrome)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-topic-color-'));
  try {
    const data = payload();
    data.nodes[0].color = 'red';
    data.nodes[0].markers = ['done'];
    data.nodes[1].color = 'red; background:url(x)';
    data.nodes[2].color = 'Blue';
    data.nodes[3].color = ['green'];
    data.nodes[4].color = '<img src=x onerror="document.title=1">';
    const out = path.join(directory, 'color.html');
    fs.writeFileSync(out, html.renderShareHtml(data, text.shareViewerUiFor('zh-TW')));
    const ids = data.nodes.slice(0, 5).map(n => n.id);
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      return evaluate(`(() => {
        const card = id => document.querySelector('[data-node-id="' + id + '"]');
        return {
          cards: ${JSON.stringify(ids)}.map(id => ({ color: card(id)?.dataset.topicColor ?? null, label: card(id)?.getAttribute('aria-label') ?? null, style: card(id)?.getAttribute('style') })),
          images: document.querySelectorAll('img[src="x"]').length, title: document.title
        };
      })()`);
    });
    assert.equal(report.cards[0].color, 'red');
    assert.match(report.cards[0].label, /顏色：紅色/);
    assert.match(report.cards[0].label, /標記：完成/, 'colour and markers both stay in the name');
    for (const card of report.cards.slice(1)) {
      assert.equal(card.color, null, 'a value off the whitelist sets no attribute');
      assert.ok(!/顏色/.test(card.label ?? ''), 'no colour text without a colour');
      assert.ok(!/url\(x\)/.test(card.style ?? ''), 'a hostile value never reaches style');
    }
    assert.equal(report.images, 0);
    assert.notEqual(report.title, '1');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer topic-style: whitelisted tokens set data attributes, tampered tokens set none, and the shell has no url( (headless Chrome)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-topic-style-'));
  try {
    const data = payload();
    data.nodes[0].style = ['bold', 'text-large', 'border-thick'];
    data.nodes[1].style = ['BOLD', 'text-huge', '"><script>document.title=1</script>', 3, 'line-thick'];
    data.nodes[2].style = ['bold', 'LINE-THICK', 'line-thick"><x'];
    const out = path.join(directory, 'style.html');
    const shell = html.renderShareHtml(data, text.shareViewerUiFor('en'));
    assert.ok(!shell.includes('url('), 'the shell never contains url(');
    fs.writeFileSync(out, shell);
    const ids = data.nodes.slice(0, 3).map(n => n.id);
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      return evaluate(`(() => {
        const card = id => document.querySelector('[data-node-id="' + id + '"]');
        return { cards: ${JSON.stringify(ids)}.map(id => ({ bold: card(id)?.dataset.topicStyleBold ?? null, size: card(id)?.dataset.topicStyleSize ?? null, border: card(id)?.dataset.topicStyleBorder ?? null })),
          thick: document.querySelectorAll('.vam-edge[data-line-thick]').length, title: document.title };
      })()`);
    });
    assert.deepEqual(report.cards[0], { bold: 'true', size: 'large', border: 'thick' });
    assert.deepEqual(report.cards[1], { bold: null, size: null, border: null });
    assert.deepEqual(report.cards[2], { bold: 'true', size: null, border: null }, 'a lone string counts as one token');
    assert.equal(report.thick, 1, 'only the child with the exact line-thick token gets a thick line; tampered tokens get none');
    assert.notEqual(report.title, '1');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer topic-color contrast: card text on every colour meets WCAG AA in light and dark (headless Chrome; the colour rules come from styles.css)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-topic-color-contrast-'));
  try {
    const data = payload();
    ['red', 'orange', 'yellow', 'green', 'blue', 'purple'].forEach((color, i) => { data.nodes[i].color = color; });
    const out = path.join(directory, 'color.html');
    fs.writeFileSync(out, html.renderShareHtml(data, text.shareViewerUiFor('en')));
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 120000, async send => {
      const { evaluate, reload } = pageTools(send);
      const measure = async scheme => {
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await reload();
        const colored = await evaluate(`Array.from(document.querySelectorAll('.vam-node[data-topic-color]')).filter(e => e.getClientRects().length).map(e => e.dataset.topicColor)`);
        return { colored, ratios: await evaluate(CONTRAST_PROBE) };
      };
      return { light: await measure('light'), dark: await measure('dark') };
    });
    for (const scheme of ['light', 'dark']) {
      const { colored, ratios } = report[scheme];
      assert.ok(colored.length >= 3, `${scheme}: coloured cards are shown (${colored.join(',')})`);
      for (const name of ['cardTitle', 'cardSummary', 'collapse']) assert.ok(ratios[name] >= 4.5, `${scheme}: ${name} contrast ${ratios[name]} must be >= 4.5`);
    }
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

// topic-links P3: the viewer has its own http(s) check (no plugin import); it must agree with the plugin on the shared cases.
test('sharing viewer links: viewerLinkHref and normalizeTopicLink accept and refuse the same cases', () => {
  const cases = JSON.parse(read('tests/fixtures/topic-link-cases.json'));
  for (const bad of [...cases.rejected, 3, null, undefined, {}, [], ['https://example.com'], true]) {
    assert.equal(viewerDetail.viewerLinkHref(bad), null, `viewer refuses ${JSON.stringify(bad)?.slice(0, 40)}`);
    assert.equal(topicLinks.normalizeTopicLink(bad), null);
  }
  for (const [input, href] of cases.accepted) {
    assert.equal(viewerDetail.viewerLinkHref(input), href);
    assert.equal(topicLinks.normalizeTopicLink(input), href);
  }
  assert.deepEqual(plain(viewerDetail.viewerLinksOf(['javascript:x', 'https://a.example/p', 'HTTPS://A.example/p', 'https://b.example:81/'])), [{ href: 'https://a.example/p', host: 'a.example' }, { href: 'https://b.example:81/', host: 'b.example:81' }]);
  assert.deepEqual(plain(viewerDetail.viewerLinksOf('https://a.example/')), [], 'a non-list reads as nothing');
  assert.equal(viewerDetail.viewerLinksOf(Array.from({ length: 30 }, (_, i) => `https://e${i}.example/`)).length, 20);
});

test('sharing viewer links: linkRow builds anchors with rel/referrer, host as text, and nothing for tampered values', () => {
  const makeEl = tag => ({ tag, attrs: {}, children: [], className: '', textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); } });
  const doc = { createElement: makeEl };
  const ui = { linksLabel: 'Links: {0}', linkOpen: 'Open link: {0}' };
  assert.equal(viewerDetail.linkRow(doc, ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' \tjavascript:x', 'data:text/html,x', 3, null, 'https://u:p@h.example/', 'https://x.example/' + 'a'.repeat(2100)], ui), null);
  assert.equal(viewerDetail.linkRow(doc, undefined, ui), null);
  const row = viewerDetail.linkRow(doc, ['javascript:x', 'https://a.example/p?q=1', 'http://b.example:8080/'], ui);
  assert.equal(row.children.length, 2);
  const [first, second] = row.children;
  assert.equal(first.tag, 'a');
  assert.equal(first.attrs.href, 'https://a.example/p?q=1');
  assert.equal(first.attrs.target, '_blank');
  assert.equal(first.attrs.rel, 'noopener noreferrer');
  assert.equal(first.attrs.referrerpolicy, 'no-referrer');
  assert.equal(first.textContent, 'a.example');
  assert.equal(second.textContent, 'b.example:8080');
  assert.equal(row.attrs['aria-label'], 'Links: a.example, b.example:8080');
  assert.equal(first.attrs['aria-label'], 'Open link: a.example');
});

test('sharing viewer links: link text exists in every language and the viewer imports no new module', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'es']) {
    const ui = text.shareViewerUiFor(lang) ?? dictionaries.SHARE_VIEWER_UI_EXTRA[lang];
    assert.match(ui.linksLabel, /\{0\}/, `${lang}.linksLabel`);
    assert.match(ui.linkOpen, /\{0\}/, `${lang}.linkOpen`);
  }
  assert.equal(text.shareViewerUiFor('zh-TW').linksLabel, '網址：{0}');
  assert.equal(/from\s+["'][^"']*topic-links["']/.test(read('experiences/sharing/viewer/detail.ts') + read('experiences/sharing/viewer/main.ts')), false, 'the viewer sources do not import topic-links');
});

test('sharing viewer card-height: a short card keeps its title and loses the summary first, with a cover in between (headless Chrome, flex shrink order)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-card-height-'));
  try {
    const data = payload();
    data.nodes[0].height = 80;
    data.nodes[0].title = 'Short title';
    data.nodes[0].summary = 'A long summary that needs several lines of the card to be shown completely, one two three four five six seven eight nine ten eleven twelve.';
    const out = path.join(directory, 'height.html');
    fs.writeFileSync(out, html.renderShareHtml(data, text.shareViewerUiFor('en')));
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      return evaluate(`(() => {
        const card = document.querySelector('[data-node-id="${data.nodes[0].id}"]');
        const size = el => ({ h: el.offsetHeight, scroll: el.scrollHeight });
        const before = { title: size(card.querySelector('h3')), summary: size(card.querySelector('p')) };
        // The plugin draws a cover frame between title and summary; the viewer has none, so stand one in to check the order.
        const cover = document.createElement('div');
        cover.className = 'vam-card-cover';
        cover.style.height = '96px';
        card.querySelector('h3').after(cover);
        return { clipped: card.classList.contains('is-clipped'), cardHeight: card.offsetHeight, before, title: size(card.querySelector('h3')), summary: size(card.querySelector('p')), cover: size(cover), fade: getComputedStyle(card.querySelector('.vam-card-fade')).display, more: getComputedStyle(card.querySelector('.vam-card-more')).display };
      })()`);
    });
    assert.equal(report.clipped, true);
    assert.equal(report.cardHeight, 80);
    assert.equal(report.before.summary.h, 0, 'the summary is the first to shrink, down to nothing');
    console.log(JSON.stringify(report)); // At the 80px minimum the header and padding leave about one line, so the title may be partly cut, but it is the last thing to go.
    assert.ok(report.before.title.h > 0, 'the title is still visible');
    // A real cover frame is 96px: at 80px the header and the title leave no room for it, so the cover goes to nothing before the title gives up anything.
    assert.equal(report.cover.h, 0, 'the cover shrinks before the title');
    assert.ok(report.title.h > 0, 'the title is still visible with a cover present');
    assert.equal(report.summary.h, 0);
    assert.notEqual(report.fade, 'none');
    assert.notEqual(report.more, 'none');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('sharing viewer text-then-topic: topics after a text block hang from it, clear of it on open, fold and Auto layout (headless Chrome)', async t => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-after-'));
  try {
    const data = levelOnePayload();
    // heat has a text block with two topics after it (and a child of the first), plus its two ordinary children.
    const base = { x: 0, y: 0, collapsed: false, status: 'idea', summary: '' };
    // A second block on the same topic has no topic after it, but must not be left for the followers to land on.
    data.textNodes = [
      { id: 'lead', parentId: 'heat', text: 'A lead-in note that is fairly long for a block', x: 600, y: 80 },
      { id: 'aside', parentId: 'heat', text: 'An aside that follows no topic', x: 600, y: 140 }
    ];
    data.nodes.push(
      // Folded as saved (the viewer used to fold it by opening at level 1): the test opens it by hand.
      { ...base, id: 'after1', parentId: 'heat', afterTextId: 'lead', title: 'After one', collapsed: true },
      { ...base, id: 'after2', parentId: 'heat', afterTextId: 'lead', title: 'After two' },
      { ...base, id: 'after1kid', parentId: 'after1', title: 'After one child' },
      // A link to a block on another parent is ignored: this one stays an ordinary child of heat.
      { ...base, id: 'stray', parentId: 'heat', afterTextId: 'lead-on-water', title: 'Stray' }
    );
    const source = path.join(directory, 'payload.json');
    fs.writeFileSync(source, JSON.stringify(data));
    const out = path.join(directory, 'after.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', source], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const snapshot = `(() => {
        const box = e => ({ x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight });
        const cards = Object.fromEntries([...document.querySelectorAll('.vam-node')].map(c => [c.dataset.nodeId, box(c)]));
        const texts = [...document.querySelectorAll('.vam-text-node')].map(box);
        const rects = [...Object.entries(cards).map(([id, r]) => ({ id, ...r })), ...texts.map((r, i) => ({ id: 'text' + i, ...r }))];
        const hits = [];
        rects.forEach((a, i) => rects.slice(i + 1).forEach(b => { if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push(a.id + '/' + b.id); }));
        const edges = [...document.querySelectorAll('.vam-edge')].map(p => p.getAttribute('d'));
        return { cards, texts, hits, edges };
      })()`;
      await wait(600);
      await evaluate(`document.querySelector('[data-node-id="heat"] .vam-collapse-button')?.click()`);
      await wait(300);
      await evaluate(`document.querySelector('[data-node-id="after1"] .vam-collapse-button')?.click()`);
      await wait(300);
      const opened = await evaluate(snapshot);
      await evaluate(`document.querySelector('.vam-layout-button').click()`);
      await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === 'Auto layout')?.click()`);
      await wait(300);
      const auto = await evaluate(snapshot);
      await evaluate(`document.querySelector('[data-node-id="heat"] .vam-collapse-button')?.click()`);
      await wait(300);
      const folded = await evaluate(snapshot);
      return { opened, auto, folded };
    });
    for (const [name, shot] of [['open', report.opened], ['Auto layout', report.auto]]) {
      assert.equal(shot.texts.length, 2, `${name}: both blocks are drawn`);
      const text = shot.texts[0];
      assert.deepEqual(shot.hits, [], `${name}: nothing overlaps`);
      for (const id of ['after1', 'after2']) {
        assert.ok(shot.cards[id].x >= text.x + text.w, `${name}: ${id} sits after the block (x ${shot.cards[id].x} vs block end ${text.x + text.w})`);
        assert.ok(shot.edges.some(d => d.startsWith(`M ${text.x + text.w} `)), `${name}: a line leaves the block`);
      }
      assert.ok(shot.cards.after1kid.x > shot.cards.after1.x, `${name}: the child of a follower is further right`);
      assert.ok(Math.abs(shot.cards.stray.x - shot.cards.maillard.x) < 1, `${name}: the stray is in the column of heat's other children`);
    }
    assert.equal(report.folded.texts.length, 0, 'folding heat hides the block');
    assert.equal(report.folded.cards.after1, undefined, 'and the topics after it');
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

// ---- share-match-map P2: the viewer draws the map as it was saved (annotated pictures, anchors, covers, saved places and folds).
const imageData = load('experiences/sharing/viewer/image-data.ts');
const zlib = require('node:zlib');

/** A real PNG of the given size and colour as a data URI (no file, no network). */
function pngDataUri(width, height, [r, g, b]) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([head, Buffer.from(type), body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
const NODE_BASE = { collapsed: false, status: 'idea', summary: '' };
/** A map with a picture in the middle, three topics in a ring around it (saved places), and a folded topic whose children carry stale places on top of it. */
function ringPayload() {
  const data = payload();
  data.assets = { chart: pngDataUri(4, 3, [200, 120, 80]) };
  data.nodes = [
    { ...NODE_BASE, id: 't1', parentId: null, x: 60, y: 420, title: 'Left cut', collapsed: true },
    { ...NODE_BASE, id: 't2', parentId: null, x: 1000, y: 420, title: 'Right cut' },
    { ...NODE_BASE, id: 't3', parentId: null, x: 640, y: 60, title: 'Top cut' },
    { ...NODE_BASE, id: 'c1', parentId: 't1', x: 60, y: 420, title: 'Child one' },
    { ...NODE_BASE, id: 'c2', parentId: 't1', x: 60, y: 420, title: 'Child two' }
  ];
  data.images = [
    {
      id: 'img1', x: 500, y: 400, w: 400, h: 300, asset: 'chart', note: 'Beef chart',
      anchors: [{ id: 'a1', x: 0.2, y: 0.5 }, { id: 'a2', x: 0.8, y: 0.5 }, { id: 'a3', x: 0.5, y: 0.1 }, { id: 'a4', x: 0.5, y: 0.9, note: 'Fat <b>x</b>' }],
      links: [{ anchor: 'a1', topic: 't1', ring: true }, { anchor: 'a2', topic: 't2', ring: true }, { anchor: 'a3', topic: 't3', ring: true }]
    }
  ];
  return data;
}
const pageOf = async (directory, data, name = 'page') => {
  const out = path.join(directory, `${name}.html`);
  fs.writeFileSync(out, html.renderShareHtml(data, text.shareViewerUiFor('en')));
  return pathToFileURL(out).href;
};
const withChrome = async (t, prefix, run) => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    await run(chrome, directory);
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
};
/** In-page: every drawn card and picture as a box, and the pairs that overlap. */
const BOXES = `(() => {
  const box = e => ({ x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight });
  const cards = Object.fromEntries([...document.querySelectorAll('.vam-node')].map(c => [c.dataset.nodeId, box(c)]));
  const pictures = Object.fromEntries([...document.querySelectorAll('.vam-canvas-image')].map(c => [c.dataset.itemId, box(c)]));
  const rects = [...Object.entries(cards), ...Object.entries(pictures)].map(([id, r]) => ({ id, ...r }));
  const hits = [];
  rects.forEach((a, i) => rects.slice(i + 1).forEach(b => { if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push(a.id + '/' + b.id); }));
  return { cards, pictures, hits };
})()`;

test('sharing viewer images: image-data keeps only what a viewer may draw (assets, frame, size, position, anchors, links)', () => {
  const good = pngDataUri(2, 1, [1, 2, 3]);
  const assets = { ok: good, web: 'https://example.com/x.png', script: 'javascript:alert(1)', text: 'data:text/html,<b>x</b>', number: 5 };
  assert.equal(imageData.assetSource(assets, 'ok'), good);
  for (const key of ['web', 'script', 'text', 'number', 'absent', '__proto__', 'toString', null, 7]) assert.equal(imageData.assetSource(assets, key), undefined, String(key));
  // Cover: asset must be a data:image entry; a look that is not valid becomes the default look (frame -> whole picture).
  assert.equal(imageData.readCover({ asset: 'web' }, assets), undefined);
  assert.equal(imageData.readCover(null, assets), undefined);
  assert.deepEqual(plain(imageData.readCover({ asset: 'ok' }, assets)), { asset: 'ok', src: good, frame: null, size: 1, position: 'top' });
  assert.deepEqual(plain(imageData.readCover({ asset: 'ok', frame: [0.1, 0.2, 0.5, 0.6], size: 0.5, position: 'left' }, assets)), { asset: 'ok', src: good, frame: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }, size: 0.5, position: 'left' });
  for (const frame of [[2, 2, 5, 5], [0, 0, 0, 1], [0.6, 0, 0.6, 1], [-0.1, 0, 0.5, 0.5], [0, 0, 1], ['0', 0, 1, 1], [null, 0, 1, 1], [NaN, 0, 1, 1], 'x', {}]) assert.equal(imageData.readCover({ asset: 'ok', frame }, assets).frame, null, JSON.stringify(frame));
  for (const size of [0.1, 1.5, NaN, '0.5', null]) assert.equal(imageData.readCover({ asset: 'ok', size }, assets).size, 1, String(size));
  for (const position of ['top', 'weird', 5, null]) assert.equal(imageData.readCover({ asset: 'ok', position }, assets).position, 'top', String(position));
  // Images: bad numbers drop the picture or the anchor, positions are clamped, links need both ends.
  const topics = new Set(['t1', 't2']);
  const read = raw => plain(imageData.readImages(raw, topics, assets));
  assert.deepEqual(read(undefined), []);
  assert.deepEqual(read({}), []);
  const base = { id: 'p', x: 1, y: 2, w: 100, h: 50, anchors: [] };
  assert.equal(read([{ ...base, x: null }, { ...base, w: 0 }, { ...base, h: -5 }, { ...base, y: '2' }, { ...base, id: '' }, { ...base, x: 1e9 }, null, 'x']).length, 0);
  assert.equal(read([base, base]).length, 1, 'a repeated id is drawn once');
  const [image] = read([{ ...base, asset: 'web', note: '  <img src=x onerror=1>\n two ', anchors: [
    { id: 'a1', x: 0.25, y: 0.75, note: 'N' }, { id: 'a2', x: 5, y: -3 }, { id: 'a3', x: null, y: 0.5 }, { id: 'a4', x: 'x', y: 1 }, { id: 'a1', x: 0.1, y: 0.1 }, { id: '', x: 0, y: 0 }
  ], links: [
    { anchor: 'a1', topic: 't1', ring: true }, { anchor: 'a1', topic: 't1' }, { anchor: 'a2', topic: 'gone' }, { anchor: 'gone', topic: 't2' }, { anchor: 'a3', topic: 't2' }, { anchor: 'a2', topic: 't2', ring: 'yes' }, 'x'
  ] }]);
  assert.equal(image.src, undefined, 'a web address is not a picture');
  assert.equal(image.note, '<img src=x onerror=1> two', 'the note stays a plain string');
  assert.deepEqual(image.anchors.map(a => [a.id, a.x, a.y, a.linked]), [['a1', 0.25, 0.75, true], ['a2', 1, 0, true]]);
  assert.deepEqual(image.links, [{ anchor: 'a1', topic: 't1', ring: true }, { anchor: 'a2', topic: 't2', ring: false }]);
});

test('sharing viewer images: only the picture, bar and anchor rules of the map are taken from .vam-view; the viewer stylesheet lets a press pan', async () => {
  const tools = await cssTools;
  const styles = read('styles.css');
  const rules = tools.extractViewerRules(styles).flatMap(item => item.rules);
  const viewRules = rules.filter(rule => /^(?:\.theme-dark\s+)?\.vam-view\b/.test(rule));
  assert.ok(viewRules.length >= 10, 'the annotated image, bar and anchor rules are in');
  for (const rule of viewRules) assert.match(rule, /^(?:\.theme-dark\s+)?\.vam-view\s+\.(?:vam-canvas-image|vam-annotated|vam-anchor)/, `an unrelated .vam-view rule was taken: ${rule.slice(0, 80)}`);
  for (const start of ['.vam-view .vam-canvas-image.is-annotated {', '.vam-view .vam-annotated-bar {', '.vam-view .vam-anchor {', '.vam-view .vam-anchor.is-linked {']) assert.ok(viewRules.some(rule => rule.startsWith(start)), `${start} must be taken`);
  // No rule that begins with another .vam-view descendant (placing mode, crosshair of the editor) is taken, and every card rule is still the same text.
  assert.ok(!rules.some(rule => /\.vam-view\s+\.is-placing/.test(rule)));
  const css = read('experiences/sharing/viewer/viewer.css');
  assert.match(css, /\.vam-view \.vam-canvas-image \{[^}]*cursor: inherit/);
  assert.match(css, /\.vam-view \.vam-canvas-image img \{ pointer-events: none/);
  assert.equal(bundle.SHARE_VIEWER_CSS.includes('vam-anchor-line'), true);
});

test('sharing viewer images: new interface text exists in every language and the line rules are shared with the map view', () => {
  for (const lang of ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'es']) {
    const ui = text.shareViewerUiFor(lang) ?? dictionaries.SHARE_VIEWER_UI_EXTRA[lang];
    const extra = dictionaries.SHARE_VIEWER_UI_EXTRA[lang] ?? ui;
    for (const source of [ui, extra]) {
      for (const key of ['annotatedImage', 'annotatedAnchors', 'anchorNamed', 'anchorUnnamed']) assert.ok(typeof source[key] === 'string' && source[key].trim(), `${lang}.${key}`);
      assert.match(source.annotatedAnchors, /\{0\}/, `${lang}.annotatedAnchors`);
      assert.match(source.anchorNamed, /\{0\}/, `${lang}.anchorNamed`);
    }
  }
  assert.equal(text.shareViewerUiFor('zh-TW').annotatedImage, '標註圖');
  // The tree-line rules (direction per branch, line kind, depth) live in one module that the map view imports, so the two cannot drift.
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /from "\.\/tree-edge-rules"/);
  for (const name of ['branchDirectionResolver', 'lineKind', 'depthOf']) {
    assert.equal(new RegExp(`^function ${name}\\b`, 'm').test(view), false, `${name} is no longer defined in view.ts`);
    assert.match(read('experiences/visual-map/tree-edge-rules.ts'), new RegExp(`export function ${name}\\b`));
  }
});

test('sharing viewer images: a file with no pictures, covers or layout draws none of them (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-noimg-', async (chrome, directory) => {
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, payload()), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      return evaluate(`({ images: document.querySelectorAll('.vam-canvas-image').length, layer: document.querySelectorAll('.vam-canvas-items').length, covers: document.querySelectorAll('.vam-card-cover, .vam-card-side').length, lines: document.querySelectorAll('.vam-anchor-line').length, anchors: document.querySelectorAll('.vam-anchor').length, stage: document.querySelector('.vam-stage').className })`);
    });
    assert.deepEqual(report, { images: 0, layer: 0, covers: 0, lines: 0, anchors: 0, stage: 'vam-stage vam-view' });
  });
});

test('sharing viewer images: opening keeps every saved place and fold, draws the picture and anchors where the map does, and expanding does not stack cards (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-ring-', async (chrome, directory) => {
    const data = ringPayload();
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, data), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const result = {};
      await wait(500);
      result.opened = await evaluate(BOXES);
      result.t1 = await evaluate(`document.querySelector('[data-node-id="t1"]').getAttribute('aria-expanded')`);
      result.picture = await evaluate(`(() => { const el = document.querySelector('.vam-canvas-image'); const v = document.querySelector('.vam-viewport').getBoundingClientRect(); const r = el.getBoundingClientRect(); const bar = el.querySelector('.vam-annotated-bar').getBoundingClientRect(); const img = el.querySelector('img'); return { classes: el.className, role: el.getAttribute('role'), label: el.getAttribute('aria-label'), pill: el.querySelector('.vam-annotated-pill').textContent, note: el.querySelector('.vam-annotated-note').textContent, count: el.querySelector('.vam-annotated-count').textContent, src: img?.src.slice(0, 22), missing: el.classList.contains('is-missing'), inView: r.left >= v.left - 1 && r.right <= v.right + 1 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1, barInView: bar.top >= v.top - 1, overStage: !!el.closest('.vam-stage.vam-view'), layerZ: getComputedStyle(el.parentElement).zIndex }; })()`);
      result.anchors = await evaluate(`[...document.querySelectorAll('.vam-anchor')].map(a => ({ id: a.dataset.anchorId, left: a.style.left, top: a.style.top, linked: a.classList.contains('is-linked'), label: a.getAttribute('aria-label'), tip: a.querySelector('.vam-anchor-tip-note')?.textContent ?? null, tipChildren: a.querySelector('.vam-anchor-tip-note')?.children.length ?? null, tag: a.tagName }))`);
      result.lines = await evaluate(`[...document.querySelectorAll('.vam-anchor-line')].map(p => p.getAttribute('d'))`);
      // A press on the picture pans the canvas (it is not an obstacle); a press on an anchor does not; the picture never moves.
      const centre = await evaluate(`(() => { const r = document.querySelector('.vam-canvas-image').getBoundingClientRect(); return { x: r.left + r.width * 0.35, y: r.top + r.height * 0.3 }; })()`);
      const drag = async from => {
        const before = await evaluate('document.querySelector(".vam-stage").style.transform');
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + 40, y: from.y + 25, button: 'left' });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x + 40, y: from.y + 25, button: 'left', clickCount: 1 });
        return (await evaluate('document.querySelector(".vam-stage").style.transform')) !== before;
      };
      result.panFromPicture = await drag(centre);
      result.pictureAfterPan = await evaluate(`(() => { const e = document.querySelector('.vam-canvas-image'); return [e.offsetLeft, e.offsetTop]; })()`);
      const dot = await evaluate(`(() => { const r = document.querySelector('.vam-anchor[data-anchor-id="a4"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      result.panFromAnchor = await drag(dot);
      // Expand the folded topic: the arrangement of the map runs; nothing lands on anything else.
      await evaluate(`document.querySelector('[data-node-id="t1"] .vam-collapse-button').click()`);
      await wait(400);
      result.expanded = await evaluate(BOXES);
      result.lineCountAfter = await evaluate(`document.querySelectorAll('.vam-anchor-line').length`);
      return result;
    });
    // Opening: nothing was arranged or folded; offsetLeft/Top are the saved x/y.
    for (const node of data.nodes.filter(node => !['c1', 'c2'].includes(node.id))) assert.deepEqual(plain({ x: report.opened.cards[node.id].x, y: report.opened.cards[node.id].y }), { x: node.x, y: node.y }, `${node.id} stays where it was saved`);
    assert.deepEqual(Object.keys(report.opened.cards).sort(), ['t1', 't2', 't3'], 'the folded topic keeps its children hidden');
    assert.equal(report.t1, 'false', 'the saved fold is kept (no expand-to-level-1)');
    assert.deepEqual(plain({ x: report.opened.pictures.img1.x, y: report.opened.pictures.img1.y, w: report.opened.pictures.img1.w, h: report.opened.pictures.img1.h }), { x: 500, y: 400, w: 400, h: 300 });
    assert.equal(report.picture.classes, 'vam-canvas-image is-annotated');
    assert.equal(report.picture.role, 'group');
    assert.equal(report.picture.label, 'Annotated image: Beef chart');
    assert.deepEqual([report.picture.pill, report.picture.note, report.picture.count], ['Annotated image', 'Beef chart', '4 anchors']);
    assert.equal(report.picture.src, 'data:image/png;base64,', 'the picture comes from assets');
    assert.equal(report.picture.missing, false);
    assert.equal(report.picture.inView, true, 'the first view includes the picture');
    assert.equal(report.picture.barInView, true, 'and the bar above it');
    assert.equal(report.picture.overStage, true);
    assert.equal(report.picture.layerZ, '-1', 'the picture paints behind the cards');
    assert.deepEqual(report.anchors.map(a => [a.id, a.left, a.top, a.linked, a.tag]), [['a1', '20%', '50%', true, 'BUTTON'], ['a2', '80%', '50%', true, 'BUTTON'], ['a3', '50%', '10%', true, 'BUTTON'], ['a4', '50%', '90%', false, 'BUTTON']]);
    assert.equal(report.anchors[3].tip, 'Fat <b>x</b>', 'an anchor note is shown as text');
    assert.equal(report.anchors[3].tipChildren, 0, 'and creates no element');
    assert.equal(report.anchors[3].label, 'Anchor: Fat <b>x</b>');
    assert.equal(report.anchors[0].label, 'Anchor (no note)');
    // A line per link, straight into the middle of the card's edge that faces the picture (ring card), starting on the picture.
    assert.equal(report.lines.length, 3);
    const edgeOf = (id, side) => { const c = report.opened.cards[id]; return side === 'right' ? [c.x + c.w, c.y + c.h / 2] : side === 'left' ? [c.x, c.y + c.h / 2] : [c.x + c.w / 2, c.y + c.h]; };
    const wanted = [edgeOf('t1', 'right'), edgeOf('t2', 'left'), edgeOf('t3', 'bottom')];
    report.lines.forEach((d, index) => {
      const m = d.match(/^M (\S+) (\S+) L (\S+) (\S+)$/);
      assert.ok(m, `a straight line: ${d}`);
      assert.deepEqual([Number(m[3]), Number(m[4])], wanted[index], `line ${index} ends on the facing edge`);
      const img = report.opened.pictures.img1;
      assert.ok(Number(m[1]) >= img.x - 1 && Number(m[1]) <= img.x + img.w + 1 && Number(m[2]) >= img.y - 1 && Number(m[2]) <= img.y + img.h + 1, `line ${index} starts on the picture`);
    });
    assert.equal(report.panFromPicture, true, 'a press on the picture pans the canvas');
    assert.deepEqual(report.pictureAfterPan, [500, 400], 'the picture cannot be dragged');
    assert.equal(report.panFromAnchor, false, 'a press on an anchor does not pan');
    // Expanding: the children are there, and no card stands on another card or on the picture.
    assert.deepEqual(Object.keys(report.expanded.cards).sort(), ['c1', 'c2', 't1', 't2', 't3']);
    assert.deepEqual(report.expanded.hits, [], 'expanding does not stack cards');
    assert.equal(report.lineCountAfter, 3);
  });
});

test('sharing viewer layout: the map\'s direction decides the tree lines and "Auto layout", and opening does not arrange (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-direction-', async (chrome, directory) => {
    const data = payload();
    data.layout = { direction: 'down', spacing: 'compact' };
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, data), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await wait(500);
      const result = {};
      result.opened = await evaluate(`(() => { const r = ${BOXES}; return { cards: r.cards, edges: [...document.querySelectorAll('.vam-edge')].map(p => p.getAttribute('d')) }; })()`);
      await evaluate(`document.querySelector('.vam-layout-button').click()`);
      await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === 'Auto layout')?.click()`);
      await wait(300);
      result.auto = await evaluate(`(() => { const r = ${BOXES}; return { cards: r.cards, hits: r.hits, edges: [...document.querySelectorAll('.vam-edge')].map(p => p.getAttribute('d')) }; })()`);
      return result;
    });
    for (const node of data.nodes) assert.deepEqual(plain({ x: report.opened.cards[node.id].x, y: report.opened.cards[node.id].y }), { x: node.x, y: node.y }, `${node.id} is where it was saved`);
    // The first line runs from the bottom edge of the root to the top edge of its child (a "down" map), not the right-to-left curve of a "right" map.
    const root = report.opened.cards.root, heat = report.opened.cards.heat;
    assert.ok(report.opened.edges[0].startsWith(`M ${root.x + root.w / 2} ${root.y + root.h} `), report.opened.edges[0]);
    assert.ok(report.opened.edges[0].endsWith(`${heat.x + heat.w / 2} ${heat.y}`), report.opened.edges[0]);
    // Auto layout puts every child below its parent and nothing on anything else.
    for (const node of data.nodes.filter(node => node.parentId)) {
      const parent = report.auto.cards[node.parentId], child = report.auto.cards[node.id];
      assert.ok(child.y >= parent.y + parent.h, `${node.id} is below ${node.parentId} after Auto layout`);
    }
    assert.deepEqual(report.auto.hits, []);
    const rootAfter = report.auto.cards.root, heatAfter = report.auto.cards.heat;
    assert.ok(report.auto.edges[0].startsWith(`M ${rootAfter.x + rootAfter.w / 2} ${rootAfter.y + rootAfter.h} `));
    assert.ok(report.auto.edges[0].endsWith(`${heatAfter.x + heatAfter.w / 2} ${heatAfter.y}`));
  });
});

test('sharing viewer images: a picture that is not in the file is a grey placeholder with the note, hostile pictures, notes and numbers draw nothing unsafe (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-hostile-', async (chrome, directory) => {
    const data = payload();
    data.assets = { web: 'https://evil.example/x.png', js: 'javascript:window.__pwn=1', ok: pngDataUri(4, 3, [10, 20, 30]) };
    data.nodes = data.nodes.slice(0, 3);
    data.images = [
      { id: 'hostile', x: 300, y: 600, w: 300, h: 200, asset: 'web', note: '<img src=x onerror="window.__pwn=1"> secret/Vault/Path.png', anchors: [
        { id: 'in', x: 0.5, y: 0.5, note: '<script>window.__pwn=1</script>' }, { id: 'far', x: 5, y: -3 }, { id: 'nan', x: null, y: 0.5 }, { id: 'str', x: '0.2', y: 0.2 }
      ], links: [{ anchor: 'in', topic: 'heat' }, { anchor: 'in', topic: 'no-such-topic' }, { anchor: 'no-such-anchor', topic: 'heat' }, { anchor: 'nan', topic: 'heat' }] },
      { id: 'absent', x: 700, y: 600, w: 200, h: 100, asset: 'missing-key', anchors: [] },
      { id: 'proto', x: 1000, y: 600, w: 200, h: 100, asset: '__proto__', note: 'Proto', anchors: [] },
      { id: 'script', x: 1300, y: 600, w: 200, h: 100, asset: 'js', anchors: [] },
      { id: 'noasset', x: 1600, y: 600, w: 200, h: 100, note: 'Not included', anchors: [{ id: 'z', x: 0.1, y: 0.1 }] },
      { id: 'badbox', x: null, y: 0, w: 100, h: 100, asset: 'ok', anchors: [] }
    ];
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, data), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      await new Promise(resolve => setTimeout(resolve, 500));
      return evaluate(`({
        pictures: [...document.querySelectorAll('.vam-canvas-image')].map(e => ({ id: e.dataset.itemId, missing: e.classList.contains('is-missing'), img: e.querySelectorAll('img').length, name: e.querySelector('.vam-canvas-image-name')?.textContent ?? null, kids: [...e.querySelectorAll('*')].map(k => k.tagName.toLowerCase()).filter(tag => !['div', 'span', 'button', 'svg', 'path', 'circle'].includes(tag)) })),
        hostileAnchors: [...document.querySelectorAll('[data-item-id="hostile"] .vam-anchor')].map(a => [a.dataset.anchorId, a.style.left, a.style.top, a.querySelector('.vam-anchor-tip-note')?.textContent ?? null]),
        lines: document.querySelectorAll('.vam-anchor-line').length,
        injected: [typeof window.__pwn, document.querySelectorAll('script').length, document.querySelectorAll('.vam-canvas-items img, .vam-canvas-items script').length],
        requested: performance.getEntriesByType('resource').map(e => e.name).filter(name => /evil\.example/.test(name)),
        offsets: [...document.querySelectorAll('.vam-canvas-image')].map(e => [e.dataset.itemId, e.offsetLeft, e.offsetTop])
      })`);
    });
    assert.deepEqual(report.pictures.map(p => p.id), ['hostile', 'absent', 'proto', 'script', 'noasset'], 'the picture with a non-number place is dropped');
    for (const picture of report.pictures) {
      assert.equal(picture.missing, true, `${picture.id} is a placeholder`);
      assert.equal(picture.img, 0, `${picture.id} loads no image`);
      assert.deepEqual(picture.kids, [], `${picture.id} holds no unexpected element`);
    }
    const names = Object.fromEntries(report.pictures.map(p => [p.id, p.name]));
    assert.equal(names.hostile, '<img src=x onerror="window.__pwn=1"> secret/Vault/Path.png', 'the note is shown as text, exactly');
    assert.equal(names.absent, '[image not included]', 'no note: the "image not included" text, never a file name');
    assert.equal(names.proto, 'Proto');
    assert.equal(names.script, '[image not included]');
    assert.equal(names.noasset, 'Not included');
    assert.deepEqual(report.hostileAnchors, [['in', '50%', '50%', '<script>window.__pwn=1</script>'], ['far', '100%', '0%', null]], 'out-of-range numbers are clamped, non-numbers dropped, notes are text');
    assert.equal(report.lines, 1, 'only the link whose anchor and topic both exist is drawn');
    assert.deepEqual(report.injected, ['undefined', 3, 0], 'nothing ran, and the page has only its own three script blocks');
    assert.deepEqual(report.requested, [], 'a web address in assets is never requested');
    assert.deepEqual(report.offsets.slice(0, 2), [['hostile', 300, 600], ['absent', 700, 600]]);
  });
});

test('sharing viewer images: covers follow the map card (position, mask window, size), a bad look becomes the whole picture, an undecodable picture is dropped (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-cover-', async (chrome, directory) => {
    const data = payload();
    data.assets = { wide: pngDataUri(8, 4, [200, 50, 50]), tall: pngDataUri(2, 6, [50, 50, 200]), web: 'https://evil.example/x.png', broken: 'data:image/png;base64,AAAA' };
    const sum = 'A summary line';
    const ratio = value => Number(String(value).split('/')[0]);
    data.nodes = [
      { ...NODE_BASE, id: 'top', parentId: null, x: 80, y: 80, title: 'Top', summary: sum, cover: { asset: 'wide' } },
      { ...NODE_BASE, id: 'bottom', parentId: null, x: 440, y: 80, title: 'Bottom', summary: sum, cover: { asset: 'wide', position: 'bottom' } },
      { ...NODE_BASE, id: 'left', parentId: null, x: 800, y: 80, title: 'Left', summary: sum, cover: { asset: 'wide', position: 'left', size: 0.5 } },
      { ...NODE_BASE, id: 'right', parentId: null, x: 1160, y: 80, title: 'Right', summary: sum, cover: { asset: 'wide', position: 'right' } },
      { ...NODE_BASE, id: 'framed', parentId: null, x: 80, y: 500, title: 'Framed', summary: sum, cover: { asset: 'tall', frame: [0.5, 0, 0.5, 0.5] } },
      { ...NODE_BASE, id: 'badframe', parentId: null, x: 440, y: 500, title: 'Bad frame', summary: sum, cover: { asset: 'wide', frame: [2, 2, 5, 5], size: 7, position: 'diagonal' } },
      { ...NODE_BASE, id: 'web', parentId: null, x: 800, y: 500, title: 'Web', summary: sum, cover: { asset: 'web' } },
      { ...NODE_BASE, id: 'broken', parentId: null, x: 1160, y: 500, title: 'Broken', summary: sum, cover: { asset: 'broken', position: 'left' } },
      { ...NODE_BASE, id: 'plain', parentId: null, x: 1520, y: 500, title: 'Plain', summary: sum }
    ];
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, data), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      await new Promise(resolve => setTimeout(resolve, 800));
      return evaluate(`Object.fromEntries([...document.querySelectorAll('.vam-node')].map(card => {
        const frame = card.querySelector('.vam-card-cover'), win = card.querySelector('.vam-card-cover-window'), row = card.querySelector('.vam-card-side');
        const order = [...card.children].map(c => c.classList.contains('vam-card-cover') ? 'cover' : c.classList.contains('vam-card-side') ? 'side' : c.tagName === 'H3' ? 'title' : c.tagName === 'P' ? 'summary' : null).filter(Boolean);
        return [card.dataset.nodeId, {
          order, cls: card.className, frame: frame ? { cls: frame.className, aspect: frame.style.aspectRatio, width: frame.style.width, img: !!frame.querySelector('img') } : null,
          window: win ? { left: win.style.left, width: win.style.width, aspect: win.style.aspectRatio, img: ['width', 'height', 'left', 'top'].map(k => win.querySelector('img').style[k]) } : null,
          side: row ? [...row.children].map(c => c.className) : null, sideText: row ? [...row.querySelector('.vam-card-side-text').children].map(c => c.tagName) : null,
          rect: card.getBoundingClientRect().height > 0
        }];
      }))`);
    });
    assert.deepEqual(report.top.order, ['cover', 'title', 'summary']);
    assert.equal(report.top.frame.cls, 'vam-card-cover is-sized');
    assert.equal(ratio(report.top.frame.aspect), 2, 'the box takes the picture\'s shape (8 x 4)');
    assert.equal(report.top.window, null);
    assert.deepEqual(report.bottom.order, ['title', 'summary', 'cover']);
    assert.match(report.bottom.cls, /has-cover-bottom/);
    assert.deepEqual(report.left.order, ['side']);
    assert.match(report.left.cls, /has-cover-left/);
    assert.deepEqual(report.left.side, ['vam-card-cover is-sized', 'vam-card-side-text']);
    assert.deepEqual(report.left.sideText, ['H3', 'P']);
    assert.equal(report.left.frame.width, '50%', 'size 0.5 is the picture column width');
    assert.match(report.right.cls, /has-cover-right/);
    assert.deepEqual(report.right.side, ['vam-card-cover is-sized', 'vam-card-side-text']);
    // A mask: the picture sits in a window; the window and the picture are placed by percentages of the frame (same numbers as the map).
    assert.match(report.framed.frame.cls, /is-framed/);
    assert.deepEqual({ ...report.framed.window, aspect: undefined }, { left: '50%', width: '50%', aspect: undefined, img: ['200%', '200%', '-100%', '0%'] });
    assert.ok(Math.abs(ratio(report.framed.window.aspect) - 0.5 / (0.5 * 3)) < 1e-3, 'the window is as tall as the masked region of a 2 x 6 picture');
    // A look that does not hold up is the whole picture, at full size, on top.
    assert.deepEqual(report.badframe.order, ['cover', 'title', 'summary']);
    assert.doesNotMatch(report.badframe.frame.cls, /is-framed|is-resized/);
    assert.equal(report.badframe.window, null);
    // Not a data:image picture: no cover; a picture that cannot be decoded is taken out again, side row and class included.
    assert.equal(report.web.frame, null);
    assert.deepEqual(report.web.order, ['title', 'summary']);
    assert.equal(report.broken.frame, null);
    assert.deepEqual(report.broken.order, ['title', 'summary']);
    assert.doesNotMatch(report.broken.cls, /has-cover/);
    assert.equal(report.plain.frame, null);
  });
});


// ---- share-match-map F1: a ring keeps the sizes the map measured, so fold changes and Auto layout land where the map puts them.
const ringFixture = () => {
  const layoutText = load('map-layout-text.ts');
  const format = load('experiences/sharing/share-format.ts');
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  // What the map measured for each ring card (header, tag and relation rows make it taller than the viewer's card).
  const mapHeight = { a: 425, b: 353, c: 380, d: 425, e: 340, f: 410, g: 353, h: 425 };
  const heightOf = id => mapHeight[id] ?? 340;
  const nodes = [];
  ids.forEach((id, index) => {
    nodes.push({ id, path: `${id}.md`, parentId: null, x: index * 300, y: -900, collapsed: true });
    nodes.push({ id: `${id}1`, path: `${id}1.md`, parentId: id, x: index * 300 + 400, y: -900, collapsed: false });
    nodes.push({ id: `${id}2`, path: `${id}2.md`, parentId: id, x: index * 300 + 400, y: -700, collapsed: false });
  });
  const anchors = ids.map((id, index) => ({ id: `an${id}`, at: { kind: 'image-2d', x: (index + 0.5) / ids.length, y: 0.2 + (0.6 * ((index * 3) % 8)) / 8 } }));
  const items = [{ id: 'img', kind: 'annotated-image', path: 'img.png', x: 0, y: 0, w: 720, h: 540, anchors, relations: ids.map(id => ({ kind: 'related', from: `an${id}`, to: id, ring: true })) }];
  // The saved map is the map's own arrangement of the ring with its sizes.
  const saved = layoutText.solveRings(nodes, items, heightOf, undefined, { direction: 'right' });
  const map = { version: 1, id: 'ring-map', title: 'Ring map', nodes: saved.nodes, canvasItems: saved.items, viewport: { x: 0, y: 0, zoom: 1 } };
  const options = ringHeights => ({ includeDetail: false, includeImages: false, language: 'en', vamVersion: '1', exportedAt: '2026-11-07T00:00:00.000Z', ...(ringHeights ? { ringHeights } : {}) });
  const ringHeights = Object.fromEntries(ids.map(id => [id, mapHeight[id]]));
  // The map's answer to the same action: the whole arrangement again (toggleCollapsed and arrangeAll).
  const mapAfter = toggled => {
    const copy = JSON.parse(JSON.stringify(map.nodes));
    if (toggled) copy.find(node => node.id === toggled).collapsed = false;
    return layoutText.arrangeMapWithRings(copy, map.canvasItems, undefined, heightOf, { direction: 'right' }, {}).nodes;
  };
  return { ids, map, saved, format, options, ringHeights, mapAfter };
};

test('sharing viewer ring: the payload carries the map\'s card height for ring members only, and a map without a ring is unchanged', () => {
  const { ids, map, format, options, ringHeights } = ringFixture();
  const withHeights = format.buildSharePayload(map, {}, options(ringHeights));
  for (const node of withHeights.nodes) assert.equal(node.ringHeight, ids.includes(node.id) ? ringHeights[node.id] : undefined, node.id);
  const without = format.buildSharePayload(map, {}, options());
  assert.ok(without.nodes.every(node => !('ringHeight' in node)), 'no heights given: no key written');
  const plain = { ...map, canvasItems: undefined };
  delete plain.canvasItems;
  assert.equal(format.serializeShareJson(format.buildSharePayload(plain, {}, options())), format.serializeShareJson(format.buildSharePayload(plain, {}, options({}))));
  const bad = format.buildSharePayload(map, {}, options({ a: Number.NaN, b: -3, c: 1e9, d: 400.4 }));
  assert.deepEqual(bad.nodes.filter(node => 'ringHeight' in node).map(node => [node.id, node.ringHeight]), [['d', 400]]);
});

test('sharing viewer ring: expanding a ring root and Auto layout land the ring where the map puts it (headless Chrome)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const { ids, map, format, options, ringHeights, mapAfter } = ringFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-ring-'));
  try {
    const payloadFile = path.join(directory, 'ring.json');
    fs.writeFileSync(payloadFile, JSON.stringify(format.buildSharePayload(map, {}, options(ringHeights))));
    const out = path.join(directory, 'ring.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', payloadFile], { cwd: root });
    const report = await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const page = pageTools(send);
      const ringCards = () => page.evaluate(`Object.fromEntries(${JSON.stringify(ids)}.map(id => { const c = document.querySelector('[data-node-id="' + id + '"]'); return [id, c && [c.offsetLeft, c.offsetTop]]; }))`);
      const result = {};
      result.opened = await ringCards();
      await page.click('[data-node-id="a"] .vam-collapse-button');
      await settled(send, 400);
      result.expanded = await ringCards();
      result.childrenShown = await page.evaluate(`['a1', 'a2'].map(id => !!document.querySelector('[data-node-id="' + id + '"]'))`);
      // Auto layout from the menu, on the state the map would have after the same fold change.
      await page.click('.vam-layout-button');
      await page.evaluate(`Array.from(document.querySelectorAll('.vam-layout-menu button')).at(-1).click()`);
      await settled(send, 400);
      result.autoLaid = await ringCards();
      return result;
    });
    const positions = list => Object.fromEntries(ids.map(id => [id, (() => { const node = list.find(item => item.id === id); return [node.x, node.y]; })()]));
    assert.deepEqual(report.opened, positions(map.nodes), 'opening keeps the saved places');
    assert.deepEqual(report.childrenShown, [true, true]);
    assert.deepEqual(report.expanded, positions(mapAfter('a')), 'after expanding one root every ring card stays where the map leaves it');
    assert.deepEqual(report.autoLaid, positions(mapAfter('a')), 'Auto layout lands the ring where the map does');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


// ---- share-match-map F4: the real sample (a 12-card ring whose covers made the map's cards 425 / 414 / 353 / 500 tall, while the share saw 271 / 263 placeholders).
const RING_ROOT = 'd0fb8c71-6a06-4695-8259-a0f4699bf9d9';
const ringSample = ringHeightOverride => {
  const data = JSON.parse(read('tests/fixtures/sharing/viewer-ring-sample.json'));
  if (ringHeightOverride) for (const node of data.nodes) if (node.ringHeight) node.ringHeight = ringHeightOverride;
  return data;
};
/** Opens the sample, expands the first root, and reports where everything is: the numbers the acceptance (decision #8) is judged on. */
const runRingSample = async (data, drive) => {
  const chrome = findChrome();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-ringsample-'));
  try {
    const payloadFile = path.join(directory, 'ring.json');
    fs.writeFileSync(payloadFile, JSON.stringify(data));
    const out = path.join(directory, 'ring.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en', '--payload', payloadFile], { cwd: root });
    return await dumpDomLight(chrome, directory, pathToFileURL(out).href, 60000, async send => {
      const page = pageTools(send);
      const snapshot = () => page.evaluate(`(() => {
        const cards = Array.from(document.querySelectorAll('.vam-node')).map(c => ({ id: c.dataset.nodeId, x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }));
        const img = document.querySelector('.vam-canvas-image');
        const image = img && { x: img.offsetLeft, y: img.offsetTop, w: img.offsetWidth, h: img.offsetHeight };
        const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        let stacked = 0, overImage = 0;
        cards.forEach((a, i) => { if (image && hit(a, image)) overImage++; for (let j = i + 1; j < cards.length; j++) if (hit(a, cards[j])) stacked++; });
        return { cards, stacked, overImage };
      })()`);
      return drive({ page, snapshot, send });
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
const ringShape = (cards, ringIds, image) => {
  const members = cards.filter(card => ringIds.includes(card.id));
  const top = members.filter(c => c.y + c.h <= image.y).length, bottom = members.filter(c => c.y >= image.y + image.h).length;
  const left = members.filter(c => c.x + c.w <= image.x && c.y + c.h > image.y && c.y < image.y + image.h).length;
  const right = members.filter(c => c.x >= image.x + image.w && c.y + c.h > image.y && c.y < image.y + image.h).length;
  return [top, left, right, bottom].join('/');
};
const driveRingSample = async ({ page, snapshot, send }) => {
  const result = {};
  result.opened = await snapshot();
  result.image = await page.evaluate(`(() => { const i = document.querySelector('.vam-canvas-image'); return { x: i.offsetLeft, y: i.offsetTop, w: i.offsetWidth, h: i.offsetHeight }; })()`);
  await page.click(`[data-node-id="${RING_ROOT}"] .vam-collapse-button`);
  await settled(send, 600);
  result.expanded = await snapshot();
  await page.click('.vam-layout-button');
  await page.evaluate(`Array.from(document.querySelectorAll('.vam-layout-menu button')).find(b => /level 1/.test(b.textContent)).click()`);
  await settled(send, 600);
  result.level1 = await snapshot();
  return result;
};

/** The map's own answer for the same action, computed outside the viewer: arrange first with the heights of what is drawn now (a ring card keeps the map's height; a card not drawn yet gets the median), as toggleCollapsed -> arrangeAll does. */
const mapAnswer = (data, drawn, mutate) => {
  const layoutText = load('map-layout-text.ts');
  const layout = load('map-layout.ts');
  const graph = load('map-graph.ts');
  const ringOf = new Map(data.nodes.filter(node => node.ringHeight).map(node => [node.id, node.ringHeight]));
  const nodes = data.nodes.map(({ id, parentId, x, y, collapsed }) => ({ id, path: `${id}.md`, parentId: parentId ?? null, x, y, collapsed: !!collapsed }));
  for (const node of drawn.cards) Object.assign(nodes.find(each => each.id === node.id), { x: node.x, y: node.y });
  mutate(nodes, graph);
  const heights = new Map(drawn.cards.map(card => [card.id, ringOf.get(card.id) ?? card.h]));
  const median = layout.medianHeight([...heights.values()]);
  const image = data.images[0];
  const items = [{ id: image.id, kind: 'annotated-image', path: image.id, x: image.x, y: image.y, w: image.w, h: image.h,
    anchors: image.anchors.map(a => ({ id: a.id, at: { kind: 'image-2d', x: a.x, y: a.y } })),
    relations: image.links.map(link => ({ kind: 'related', from: link.anchor, to: link.topic, ring: true })) }];
  const out = layoutText.arrangeMapWithRings(nodes, items, undefined, id => heights.get(id) ?? median, { direction: 'right' }, {});
  return { positions: new Map(out.nodes.map(node => [node.id, [node.x, node.y]])), median };
};
const near = (actual, expected, limit, label) => assert.ok(Math.abs(actual - expected) <= limit, `${label}: ${actual} vs ${expected}`);

const assertRingSample = (data, report) => {
  const ringIds = data.nodes.filter(node => node.ringHeight).map(node => node.id);
  const at = (shot, id) => shot.cards.find(card => card.id === id);
  // The fixture is the real sample: the viewer's cards are as tall as the export's (403-ish, not the 271 placeholder).
  assert.ok(ringIds.every(id => at(report.opened, id).h >= 340), 'ring cards are drawn tall');
  // Opening keeps the saved places; expanding one root keeps every ring card where it is and the ring in its shape.
  for (const id of ringIds) {
    const was = data.nodes.find(node => node.id === id);
    assert.deepEqual([at(report.opened, id).x, at(report.opened, id).y], [was.x, was.y], `opened ${id}`);
    assert.deepEqual([at(report.expanded, id).x, at(report.expanded, id).y], [was.x, was.y], `expanded ${id} did not move`);
  }
  assert.equal(ringShape(report.expanded.cards, ringIds, report.image), '5/1/1/5');
  assert.equal(report.expanded.stacked, 0, 'no cards stacked after expanding');
  assert.equal(report.expanded.overImage, 0, 'no card over the centre image');
  assert.equal(report.level1.stacked, 0, 'no cards stacked at level 1');
  assert.equal(report.level1.overImage, 0);
  // The child row of the expanded root sits where the map puts it (the real sample: -908).
  const expected = mapAnswer(data, report.opened, nodes => { nodes.find(node => node.id === RING_ROOT).collapsed = false; });
  const children = data.nodes.filter(node => node.parentId === RING_ROOT).map(node => node.id);
  for (const id of children) {
    assert.equal(at(report.expanded, id).y, -908, `child row y of ${id}`);
    near(at(report.expanded, id).x, expected.positions.get(id)[0], 1, `child x ${id}`);
    near(at(report.expanded, id).y, expected.positions.get(id)[1], 1, `child y ${id}`);
  }
  // Level 1: cards not drawn before are laid out with the median of the drawn cards (map order), not their real height.
  const level1 = mapAnswer(data, report.expanded, (nodes, graph) => graph.applyCollapseLevel(nodes, 1));
  for (const card of report.level1.cards) {
    if (at(report.expanded, card.id) || card.id === undefined) continue;
    const want = level1.positions.get(card.id);
    near(card.x, want[0], 1, `level 1 x ${card.id}`);
    near(card.y, want[1], 1, `level 1 y ${card.id}`);
  }
};

test('sharing viewer ring (real sample): expanding keeps the ring, the shape and the child row; level 1 uses the median row gap (headless Chrome)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const data = ringSample();
  assert.deepEqual([...new Set(data.nodes.map(node => node.ringHeight).filter(Boolean))].sort(), [353, 414, 425, 500]);
  assertRingSample(data, await runRingSample(data, driveRingSample));
});

test('sharing viewer ring (real sample): with the placeholder heights (271) the same checks fail (headless Chrome)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const data = ringSample(271);
  const report = await runRingSample(data, driveRingSample);
  assert.throws(() => assertRingSample(data, report), /expanded .* did not move/, 'a ring solved at 271 moves the ring');
});

// ---- share-match-map R1/R2/R3 (reviewer round 1): the first fold click, the covers that load after it, and the text blocks.
/** A folded topic `a` (and a sibling) whose three children carry tall covers: the covers are drawn, and sized, only after the first expand. */
function coverFoldPayload() {
  const data = payload();
  data.assets = { tall: pngDataUri(2, 6, [50, 50, 200]), tall2: pngDataUri(2, 6, [200, 50, 50]), tall3: pngDataUri(2, 6, [50, 200, 50]) };
  data.nodes = [
    { ...NODE_BASE, id: 'r', parentId: null, x: 0, y: 0, title: 'Root' },
    { ...NODE_BASE, id: 'a', parentId: 'r', x: 320, y: 0, title: 'A', collapsed: true },
    { ...NODE_BASE, id: 'b', parentId: 'r', x: 320, y: 200, title: 'B' },
    { ...NODE_BASE, id: 'a1', parentId: 'a', x: 640, y: 0, title: 'A1', cover: { asset: 'tall' } },
    { ...NODE_BASE, id: 'a2', parentId: 'a', x: 640, y: 0, title: 'A2', cover: { asset: 'tall2' } },
    { ...NODE_BASE, id: 'a3', parentId: 'a', x: 640, y: 0, title: 'A3', cover: { asset: 'tall3' } }
  ];
  return data;
}
const OVERLAPS = `(() => {
  const box = e => ({ x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight });
  const rects = [...document.querySelectorAll('.vam-node, .vam-text-node')].map((e, i) => ({ id: e.dataset.nodeId || 'text' + i, ...box(e) }));
  const hits = [];
  rects.forEach((a, i) => rects.slice(i + 1).forEach(b => { if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hits.push(a.id + '/' + b.id); }));
  return { hits, rects, stage: document.querySelector('.vam-stage').style.transform };
})()`;

// One synchronous evaluate: act, then take the snapshot in the same task, so a fast machine cannot run the cover load in between (the load is a later task).
const ACT_THEN_SNAPSHOT = (action, ids) => `(() => { ${action}
  const rect = id => { const b = document.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
  const covers = [...document.querySelectorAll('.vam-card-cover')];
  return { transform: document.querySelector('.vam-stage').style.transform, rects: Object.fromEntries(${JSON.stringify(ids)}.map(id => [id, rect(id)])), covers: covers.length, sized: covers.filter(c => c.classList.contains('is-sized')).length };
})()`;
const scaleOf = transform => /scale\(([^)]*)\)/.exec(transform)?.[1];

test('sharing viewer fold R1: the first expand of covered children ends with no overlap once the covers load, and opening does not move cards (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-r1-', async (chrome, directory) => {
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, coverFoldPayload()), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await wait(1000);
      const open = await evaluate(OVERLAPS);
      const sync = await evaluate(`(() => { document.querySelector('[data-node-id="a"] .vam-collapse-button').click(); return ${OVERLAPS}; })()`);
      await wait(1500);
      const settled = await evaluate(OVERLAPS);
      const sized = await evaluate(`[...document.querySelectorAll('.vam-card-cover')].map(c => c.classList.contains('is-sized'))`);
      return { open, sync, settled, sized };
    });
    const at = (shot, id) => shot.rects.find(r => r.id === id);
    assert.deepEqual([at(report.open, 'b').x, at(report.open, 'b').y, at(report.open, 'a').x, at(report.open, 'a').y], [320, 200, 320, 0], 'opening keeps the saved places');
    assert.equal(report.sized.length, 3);
    assert.ok(report.sized.every(Boolean), 'the covers are sized');
    assert.deepEqual(report.settled.hits, [], 'R1: nothing overlaps after the covers are sized');
  });
});

test('sharing viewer fold R3: after the reader folds or unfolds, a cover load does not fit the view away (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-r3-', async (chrome, directory) => {
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, coverFoldPayload()), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await wait(1000);
      const before = await evaluate(ACT_THEN_SNAPSHOT('', ['a']));
      const sync = await evaluate(ACT_THEN_SNAPSHOT(`document.querySelector('[data-node-id="a"] .vam-collapse-button').click();`, ['a']));
      await wait(1500);
      return { before, sync, settled: await evaluate(ACT_THEN_SNAPSHOT('', ['a'])) };
    });
    assert.equal(report.sync.covers, 3, 'the click drew the three covers');
    assert.equal(report.sync.sized, 0, 'the snapshot is taken before any cover is sized, so the later load is what is tested');
    assert.equal(report.settled.sized, 3, 'the covers are sized afterwards');
    // The view may be shifted to keep the clicked card in place (R2-F1), but never refitted: a fit changes the scale.
    assert.equal(scaleOf(report.sync.transform), scaleOf(report.before.transform), 'the fold itself does not change the scale');
    assert.equal(scaleOf(report.settled.transform), scaleOf(report.sync.transform), 'a cover load does not change the scale (no fit)');
    const moved = Math.max(Math.abs(report.sync.rects.a.left - report.settled.rects.a.left), Math.abs(report.sync.rects.a.top - report.settled.rects.a.top));
    assert.ok(moved <= 1, `the clicked card keeps its place on screen: ${JSON.stringify(report)}`);
  });
});

test('sharing viewer fold R2: the first click on a folded topic with text blocks leaves no overlap (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-r2-', async (chrome, directory) => {
    const data = levelOnePayload();
    data.textNodes = [
      { id: 'lead', parentId: 'heat', text: 'A lead-in note that is fairly long for a block', x: 600, y: 80 },
      { id: 'aside', parentId: 'heat', text: 'An aside that follows no topic', x: 600, y: 140 }
    ];
    data.nodes.push(
      { ...NODE_BASE, id: 'after1', parentId: 'heat', afterTextId: 'lead', title: 'After one' },
      { ...NODE_BASE, id: 'after2', parentId: 'heat', afterTextId: 'lead', title: 'After two' }
    );
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, data), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      await new Promise(resolve => setTimeout(resolve, 600));
      await evaluate(`document.querySelector('[data-node-id="heat"] .vam-collapse-button').click()`);
      return evaluate(OVERLAPS);
    });
    assert.equal(report.rects.filter(r => r.id.startsWith('text')).length, 2, 'both blocks are drawn');
    assert.deepEqual(report.hits, [], 'nothing overlaps right after the first click');
    const block = report.rects.find(r => r.id.startsWith('text'));
    for (const id of ['after1', 'after2']) assert.ok(report.rects.find(r => r.id === id).x >= block.x + block.w, `${id} sits after the block`);
  });
});

// ---- share-match-map R2-F1/F2/F3 (reviewer round 2): a cover that loads after the reader's action keeps their place, "show all" lasts, opening still does not arrange.
const SCREEN_RECT = id => `(() => { const b = document.querySelector('[data-node-id="${id}"]').getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; })()`;
const MENU_ITEM = index => `document.querySelector('.vam-layout-button').click(); [...document.querySelectorAll('[role="menuitem"]')][${index}].click();`;
const drift = (a, b) => Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top));

test('sharing viewer fold R2-F1: the clicked card and the selected card keep their place on screen when the covers load (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-f1-', async (chrome, directory) => {
    const run = async script => dumpDomLight(chrome, directory, await pageOf(directory, coverFoldPayload()), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await wait(1000);
      return script(evaluate, wait);
    });
    const clicked = await run(async (evaluate, wait) => {
      const sync = await evaluate(`(() => { document.querySelector('[data-node-id="a"] .vam-collapse-button').click(); return ${SCREEN_RECT('a')}; })()`);
      await wait(1500);
      return { sync, settled: await evaluate(SCREEN_RECT('a')), sized: await evaluate(`[...document.querySelectorAll('.vam-card-cover')].every(c => c.classList.contains('is-sized'))`) };
    });
    assert.ok(clicked.sized, 'the covers are sized');
    assert.ok(drift(clicked.sync, clicked.settled) <= 1, `the clicked card stays put: ${JSON.stringify(clicked)}`);
    const selected = await run(async (evaluate, wait) => {
      const sync = await evaluate(`(() => { document.querySelector('[data-node-id="a"]').click(); [...document.querySelectorAll('.vam-subtopics button')].find(b => /A3/.test(b.textContent)).click(); return ${SCREEN_RECT('a3')}; })()`);
      await wait(1500);
      return { sync, settled: await evaluate(SCREEN_RECT('a3')), sel: await evaluate(`document.querySelector('.vam-node.is-selected')?.dataset.nodeId`) };
    });
    assert.equal(selected.sel, 'a3');
    assert.ok(drift(selected.sync, selected.settled) <= 1, `the selected card stays put: ${JSON.stringify(selected)}`);
  });
});

test('sharing viewer fold R2-F2: "Expand all" and "Level 3" still show every card after the covers load (headless Chrome; one card unfolded stays with R3)', async t => {
  await withChrome(t, 'vam-share-f2-', async (chrome, directory) => {
    for (const [label, item] of [['expand all', 1], ['level 3', 4]]) {
      const report = await dumpDomLight(chrome, directory, await pageOf(directory, coverFoldPayload(), label.replace(' ', '-')), 60000, async send => {
        const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
        await new Promise(resolve => setTimeout(resolve, 1000));
        await evaluate(MENU_ITEM(item));
        await new Promise(resolve => setTimeout(resolve, 1500));
        return evaluate(`(() => { const v = document.querySelector('.vam-viewport').getBoundingClientRect(); return { sized: [...document.querySelectorAll('.vam-card-cover')].every(c => c.classList.contains('is-sized')), cards: [...document.querySelectorAll('.vam-node')].map(c => { const b = c.getBoundingClientRect(); return { id: c.dataset.nodeId, inside: b.left >= v.left - 1 && b.top >= v.top - 1 && b.right <= v.right + 1 && b.bottom <= v.bottom + 1 }; }) }; })()`);
      });
      assert.ok(report.sized, `${label}: covers sized`);
      assert.equal(report.cards.length, 6, `${label}: every card is drawn`);
      assert.deepEqual(report.cards.filter(c => !c.inside).map(c => c.id), [], `${label}: every card is inside the viewport`);
    }
  });
});

test('sharing viewer fold R2-F3: opening a file whose expanded covered cards overlap does not arrange them when the covers load (headless Chrome)', async t => {
  await withChrome(t, 'vam-share-f3-', async (chrome, directory) => {
    const data = coverFoldPayload();
    data.nodes.find(n => n.id === 'a').collapsed = false;
    const report = await dumpDomLight(chrome, directory, await pageOf(directory, data), 60000, async send => {
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await wait(300);
      const first = await evaluate(OVERLAPS);
      await wait(1500);
      return { first, settled: await evaluate(OVERLAPS), sized: await evaluate(`[...document.querySelectorAll('.vam-card-cover')].every(c => c.classList.contains('is-sized'))`) };
    });
    assert.ok(report.sized, 'the covers are sized');
    const places = shot => JSON.stringify(shot.rects.map(r => [r.id, r.x, r.y]));
    assert.ok(report.settled.hits.length > 0, 'the saved places overlap, so there is something an arrangement would move');
    assert.equal(places(report.settled), places(report.first), 'no card moved when the covers loaded');
  });
});
