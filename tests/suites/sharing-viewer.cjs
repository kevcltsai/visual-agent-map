// Sharing P1 (Worker B): the share viewer, its stylesheet, and the pure HTML assembly. No Obsidian and no browser needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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
  assert.deepEqual(inputs, ['experiences/sharing/share-viewer-ui.ts', 'experiences/sharing/viewer/detail.ts', 'experiences/sharing/viewer/edge-path.ts', 'experiences/sharing/viewer/index.ts', 'experiences/sharing/viewer/language.ts', 'experiences/sharing/viewer/main.ts', 'experiences/visual-map/viewport-inset.ts', 'map-graph.ts', 'map-layout.ts']);
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
  assert.match(main, /storageGet\(LANGUAGE_KEY\)/);
  assert.match(main, /storageSet\(LANGUAGE_KEY, code\)/);
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
    for (const [key, value] of Object.entries(ui)) assert.ok(typeof value === 'string' && value.trim(), `${lang}.${key}`);
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

test('sharing viewer language: interface text for ja, ko and es is complete and marked as not native-reviewed', () => {
  const english = text.shareViewerUiFor('en');
  for (const code of ['ja', 'ko', 'es']) {
    const ui = dictionaries.SHARE_VIEWER_UI_EXTRA[code];
    assert.equal(ui.lang, code);
    assert.deepEqual(Object.keys(ui).sort(), Object.keys(english).sort(), code);
    for (const [key, value] of Object.entries(ui)) assert.ok(typeof value === 'string' && value.trim(), `${code}.${key}`);
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

test('sharing viewer language: a plain file shows exactly the P1 page (same DOM in headless Chrome)', () => {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  const chrome = candidates.find(file => fs.existsSync(file));
  if (!chrome) return; // The page DOM is also compared by the viewer's own manual check; this layer needs a browser.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-share-p1-'));
  try {
    const out = path.join(directory, 'p1.html');
    execFileSync(process.execPath, [path.join(root, 'scripts', 'make-share-demo.mjs'), '--out', out, '--lang', 'en'], { cwd: root });
    const dom = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${path.join(directory, 'profile')}`, '--window-size=1280,800', '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(out).href], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
    const clean = value => value.replace(/transform: translate\([^)]*\) scale\([^)]*\);/, 'transform: T;');
    const app = dom.slice(dom.indexOf('<div id="vam-app"'), dom.indexOf('<script type="application/json" id="vam-ui">')).trimEnd() + '\n';
    assert.equal(clean(app), clean(read('tests/fixtures/sharing/viewer-p1-app.html')));
    assert.match(dom, /<html lang="en">/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
