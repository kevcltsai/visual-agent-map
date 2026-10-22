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
  assert.deepEqual(inputs, ['experiences/sharing/share-viewer-ui.ts', 'experiences/sharing/viewer/detail.ts', 'experiences/sharing/viewer/edge-path.ts', 'experiences/sharing/viewer/index.ts', 'experiences/sharing/viewer/main.ts', 'experiences/visual-map/viewport-inset.ts', 'map-graph.ts', 'map-layout.ts']);
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
