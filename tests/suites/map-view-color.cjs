// 0.28 ticket 10: the mind map screen inside the plugin (topics, edges, tags, toolbar, AI chat, dialog buttons) reaches WCAG 2.x AA
// in Obsidian's default light and dark themes. Headless Chrome loads styles.css with the real default token values
// (tests/fixtures/color/obsidian-default-tokens.json, measured in Obsidian 1.14.5) over a DOM built with the same classes view.ts creates.
// Opacity and translucent fills are blended in before the ratio is taken. Text needs 4.5, icons / edges / dots need 3.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, root, load } = require('../support.cjs');

const tokens = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/color/obsidian-default-tokens.json'), 'utf8'));
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

// Obsidian's native button surface is not among the exported tokens: the default theme uses these (obsidian.css: --interactive-normal / --interactive-hover),
// plus a deliberately harsher grey per theme that covers the lowest button fills measured in the real app.
const BUTTON_SURFACE = {
  light: { '--interactive-normal': '#ffffff', '--interactive-hover': '#fafafa', envelope: ['#e3e3e3'] },
  dark: { '--interactive-normal': '#363636', '--interactive-hover': '#3f3f3f', envelope: ['#3f3f3f'] }
};

const svg = '<svg class="svg-icon" viewBox="0 0 24 24" width="14" height="14"><path d="M4 12h16" stroke="currentColor"/></svg>';
const tag = (tier, label) => `<button class="vam-relevance-tag vam-relevance-tag-button" data-tier="${tier}"><span class="vam-relevance-icon">${svg}</span><span>${label}</span></button>`;
const card = (attrs, left, top, inner) => `<div class="vam-node" ${attrs} style="left:${left}px;top:${top}px">${inner}</div>`;
// hypothesis-evidence (V1.6 P13): every line kind x normal / related / dimmed / selected, plus the plain and the expanded label, the arrowheads and the gap line.
const RELATION_KINDS = ['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'];
const RELATION_STATES = [['normal', ''], ['related', ' is-related'], ['dimmed', ' is-dimmed'], ['selected', ' is-selected']];
const RELATION_FIXTURE = `<defs><marker id="m" viewBox="0 0 10 10" markerWidth="10" markerHeight="10"><path class="vam-relation-arrow" d="M 0 0 L 10 5 L 0 10 z"/></marker><marker id="mb" viewBox="0 0 14 10" markerWidth="14" markerHeight="10"><path class="vam-relation-arrow" d="M 0 0 L 10 5 L 0 10 z"/><path class="vam-relation-arrow-bar" d="M 12 0 L 12 10"/></marker></defs>${RELATION_KINDS.map((kind, row) => RELATION_STATES.map(([state, cls], col) => {
  const y = 200 + row * 20 + col * 130, d = `M0 ${y} L200 ${y}`;
  return `<path class="vam-relation vam-relation-${kind}${cls}" data-case="${kind}|${state}" d="${d}" marker-end="url(#${kind === 'contradicts' ? 'mb' : 'm'})"/>` + (kind === 'derives_from' ? `<path class="vam-relation-gap" data-gap="${state}" d="${d}"/>` : '');
}).join('')).join('')}<path class="vam-relation-hit" d="M0 170 L200 170"/><text class="vam-relation-label" x="100" y="190">Supports</text><text class="vam-relation-label is-expanded" x="300" y="190"><tspan x="300">Supports: A → B</tspan><tspan x="300" dy="1.3em">A note</tspan></text>`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
button { background: var(--interactive-normal); color: var(--text-normal); border: 0; font: inherit; }
button:hover { background: var(--interactive-hover); }
${styles}
body { margin: 0; width: 1200px; height: 800px; background: var(--background-primary); color: var(--text-normal); }
</style></head><body>
<div class="vam-toolbar"><button class="vam-map-switcher"><span class="vam-map-title">Map</span><span class="vam-map-switcher-icon">${svg}</span></button></div>
<div class="vam-workspace" style="height:620px">
<div class="vam-map-chat" style="width:300px;height:600px">
  <div class="vam-map-chat-suggest"><button class="vam-map-chat-suggestion" type="button">Add a missing branch</button></div>
  <div class="vam-map-chat-images-missing">image missing</div>
</div>
<div class="vam-viewport" style="height:600px">
  <div class="vam-stage">
    <svg class="vam-edges"><path class="vam-edge" data-parent-line d="M0 0 L200 0"/><path class="vam-edge vam-edge-aim" d="M0 -20 L200 -20"/><path class="vam-edge vam-edge-side" d="M0 20 L200 20"/><path class="vam-edge vam-edge-convergence" d="M0 40 L200 40"/>${RELATION_FIXTURE}</svg>
    ${card('data-relevance="core"', 20, 60, `<div class="vam-node-header">${tag('core', 'Core')}</div><div class="vam-node-tools" style="opacity:1;pointer-events:auto;transform:none"><button class="vam-node-tool vam-ai-explore">AI explore</button></div><h3 class="vam-card-title">Core topic</h3><p class="vam-card-summary">Summary</p>`)}
    ${card('data-relevance="side"', 340, 60, `<div class="vam-node-header">${tag('side', 'Skippable')}</div><h3 class="vam-card-title">Skippable topic</h3><p class="vam-card-summary">Summary of a skippable topic</p>`)}
    ${card('data-status="idea"', 20, 260, `<div class="vam-node-header"><span class="vam-status vam-status-idea">To research</span></div><h3 class="vam-card-title">Idea topic</h3><p class="vam-card-summary">Idea summary</p><p class="vam-card-summary is-preview">Preview summary</p><p class="vam-task-preview">Task preview text</p>`)}
    ${card('data-status="error"', 340, 260, `<div class="vam-node-header"><span class="vam-status vam-status-error">Error</span><span class="vam-status">Plain</span><span class="vam-status vam-status-completed">Done</span><span class="vam-status vam-status-running">Running</span><span class="vam-status vam-status-queued">Queued</span><span class="vam-status vam-research-slow">Slow</span></div><h3 class="vam-card-title">Failed topic</h3><p class="vam-card-error">Something failed</p>`)}
  </div>
  <div class="vam-canvas-overlay"><div class="vam-map-tools"><button class="is-active">Done selecting</button><button class="vam-relevance-goal">Prioritise by goal</button></div><div class="vam-view"><div class="vam-map-search"><input class="vam-map-search-input" type="search" aria-label="Search topics"><span class="vam-map-search-count">3/7</span><button class="vam-map-search-close" aria-label="Close search">x</button></div></div></div>
</div>
</div>
<div class="modal vam-next-modal" style="background:var(--background-primary);width:400px"><div class="modal-content"><div class="vam-next-actions"><button class="vam-discard">Remove from map</button></div><div class="vam-share-note vam-share-warning">3 images could not be read</div><div class="vam-share-note vam-share-error">Share failed</div><div class="vam-share-error">Save failed</div>
<div class="vam-proposal is-stale"><span class="vam-proposal-kind vam-proposal-kind-remove">Remove</span><span class="vam-proposal-kind vam-proposal-kind-add">Add</span><span class="vam-proposal-kind vam-proposal-kind-move">Move</span><span class="vam-proposal-kind vam-proposal-kind-merge">Merge</span><p class="vam-structure-note">Out of date</p></div>
<div class="vam-outline-error">Outline error</div><button class="vam-outline-link">Pick a file</button><span class="vam-danger-text">Danger</span><div class="vam-template-issue">Template issue</div>
<div class="vam-field-head"><button class="vam-field-link">Learn more</button></div><div class="vam-quick-limits"><p class="vam-hint is-error">Limit error</p></div></div></div>
<div id="chat-secondary"><div class="vam-map-chat"><div class="vam-map-chat-msg is-error"><span class="vam-map-chat-text">Chat error</span><div class="vam-map-chat-line is-failed">Failed line</div><div class="vam-map-chat-plan-warning">Plan warning</div><div class="vam-map-chat-plan-group is-danger"><span class="vam-map-chat-plan-group-title">Danger group</span></div><span class="vam-map-chat-count-failed">2 failed</span><div class="vam-map-chat-images-state is-inserted">Inserted</div><button class="vam-map-chat-lines-toggle">Show lines</button><button class="vam-map-chat-more">More</button></div></div></div>
<div id="chat-user"><div class="vam-map-chat"><div class="vam-map-chat-msg is-user is-error"><span class="vam-map-chat-text">Chat error</span><div class="vam-map-chat-line is-failed">Failed line</div><div class="vam-map-chat-plan-warning">Plan warning</div><div class="vam-map-chat-plan-group is-danger"><span class="vam-map-chat-plan-group-title">Danger group</span></div><span class="vam-map-chat-count-failed">2 failed</span><div class="vam-map-chat-images-state is-inserted">Inserted</div><button class="vam-map-chat-lines-toggle">Show lines</button><button class="vam-map-chat-more">More</button></div></div></div>
<div class="vam-node" style="position:static;width:200px"><button class="vam-add-child" style="opacity:1">+</button></div>
</body></html>`;

// [name, selector, kind, need, options]. kind: color (text colour), stroke (SVG stroke), fill (SVG fill), border (card frame), dot (::before fill), ring (::before border).
const CASES = [
  ['edge', '.vam-edge[data-parent-line]', 'stroke', 3],
  ['edge-aim', '.vam-edge-aim', 'stroke', 3],
  ['edge-skippable', '.vam-edge.vam-edge-side', 'stroke', 3],
  ['edge-convergence', '.vam-edge-convergence', 'stroke', 3],
  ...RELATION_KINDS.flatMap(kind => RELATION_STATES.map(([state, cls]) => [`line-${kind}-${state}`, `.vam-relation-${kind}${cls.replace(/ /g, '.')}:not(${['.is-related', '.is-dimmed', '.is-selected'].filter(c => !cls.includes(c.slice(1))).join('):not(')})`, 'stroke', ['normal', 'related'].includes(state) ? 4.5 : 3])),
  ['relation-label', '.vam-relation-label:not(.is-expanded)', 'fill', 4.5],
  ['relation-label-expanded', '.vam-relation-label.is-expanded', 'fill', 4.5],
  ['relation-arrow', '.vam-relation-arrow', 'fill', 3],
  ['relation-arrow-bar', '.vam-relation-arrow-bar', 'stroke', 3],
  ['skippable-title', '.vam-node[data-relevance="side"] .vam-card-title', 'color', 4.5],
  ['skippable-summary', '.vam-node[data-relevance="side"] .vam-card-summary', 'color', 4.5],
  ['skippable-tag-text', '.vam-node[data-relevance="side"] .vam-relevance-tag span:last-child', 'color', 4.5],
  ['skippable-tag-icon', '.vam-node[data-relevance="side"] .vam-relevance-icon svg', 'color', 3],
  ['core-tag', '.vam-node[data-relevance="core"] .vam-relevance-tag span:last-child', 'color', 4.5],
  ['idea-label', '.vam-status-idea', 'color', 4.5],
  ['idea-ring', '.vam-status-idea', 'ring', 3],
  ['status-dot', '.vam-status:not([class*="vam-status-"])', 'dot', 3],
  ['idea-summary', '.vam-node[data-status="idea"] .vam-card-summary:not(.is-preview)', 'color', 4.5],
  ['preview-summary', '.vam-card-summary.is-preview', 'color', 4.5],
  ['task-preview', '.vam-task-preview', 'color', 4.5],
  ['error-label', '.vam-status-error', 'color', 4.5],
  ['error-dot', '.vam-status-error', 'dot', 3],
  ['card-error', '.vam-card-error', 'color', 4.5],
  ['discard', '.vam-discard', 'color', 4.5, { buttonEnvelope: true }],
  ['share-warning', '.vam-share-note.vam-share-warning', 'color', 4.5],
  ['switcher-icon', '.vam-map-switcher-icon svg', 'color', 3],
  ['ai-explore', '.vam-ai-explore', 'color', 4.5, { buttonEnvelope: true }],
  ['ai-explore-hover', '.vam-ai-explore', 'color', 4.5, { buttonEnvelope: true, hover: true }],
  ['chat-suggestion', '.vam-map-chat-suggestion', 'color', 4.5],
  ['chat-suggestion-hover', '.vam-map-chat-suggestion', 'color', 4.5, { hover: true }],
  ['chat-images-missing', '.vam-map-chat-images-missing', 'color', 4.5],
  ['tools-done-selecting', '.vam-map-tools button.is-active', 'color', 4.5],
  ['tools-done-selecting-hover', '.vam-map-tools button.is-active', 'color', 4.5, { hover: true }],
  ['tools-by-goal', '.vam-map-tools .vam-relevance-goal', 'color', 4.5],
  ['map-search-count', '.vam-map-search-count', 'color', 4.5],
  ['map-search-close', '.vam-map-search-close', 'color', 4.5],
  ['running-label', '.vam-status-running', 'color', 4.5],
  ['queued-label', '.vam-status-queued', 'color', 4.5],
  ['dot-completed', '.vam-status-completed', 'dot', 3],
  ['dot-running', '.vam-status-running', 'dot', 3],
  ['dot-queued', '.vam-status-queued', 'ring', 3],
  ['share-error-note', '.vam-share-note.vam-share-error', 'color', 4.5],
  ['share-error', '.vam-share-error:not(.vam-share-note)', 'color', 4.5],
  ['structure-stale-note', '.vam-proposal.is-stale .vam-structure-note', 'color', 4.5],
  ['structure-kind-add', '.vam-proposal-kind-add', 'color', 4.5],
  ['structure-kind-move', '.vam-proposal-kind-move', 'color', 4.5],
  ['structure-kind-merge', '.vam-proposal-kind-merge', 'color', 4.5],
  ['research-slow', '.vam-research-slow', 'color', 4.5],
  ['structure-kind-remove', '.vam-proposal-kind-remove', 'color', 4.5],
  ['outline-error', '.vam-outline-error', 'color', 4.5],
  ['outline-link', '.vam-outline-link', 'color', 4.5, { buttonEnvelope: true }],
  ['outline-link-hover', '.vam-outline-link', 'color', 4.5, { hover: true }],
  ['danger-text', '.vam-danger-text', 'color', 4.5],
  ['template-issue', '.vam-template-issue', 'color', 4.5],
  ['field-link', '.vam-field-link', 'color', 4.5, { buttonEnvelope: true }],
  ['quick-limits-error', '.vam-quick-limits > .vam-hint.is-error', 'color', 4.5],
  ['add-child-hover', '.vam-add-child', 'color', 4.5, { hover: true }],
  ...['#chat-secondary', '#chat-user'].flatMap(scope => [
    ['chat-error-text', '.vam-map-chat-msg.is-error .vam-map-chat-text', 'color', 4.5],
    ['chat-line-failed', '.vam-map-chat-line.is-failed', 'color', 4.5],
    ['chat-plan-warning', '.vam-map-chat-plan-warning', 'color', 4.5],
    ['chat-danger-title', '.vam-map-chat-plan-group.is-danger .vam-map-chat-plan-group-title', 'color', 4.5],
    ['chat-count-failed', '.vam-map-chat-count-failed', 'color', 4.5],
    ['chat-images-inserted', '.vam-map-chat-images-state.is-inserted', 'color', 4.5],
    ['chat-lines-toggle', '.vam-map-chat-lines-toggle', 'color', 4.5, { buttonEnvelope: true }],
    ['chat-more', '.vam-map-chat-more', 'color', 4.5, { buttonEnvelope: true }]
  ].map(([name, selector, kind, need, options]) => [`${name} @${scope.slice(6)}`, `${scope} ${selector}`, kind, need, options]))
];

// Runs in the page: blends opacity and translucent fills from the root down to the element, then returns the WCAG ratio (smallest over the given fills).
const PROBE = `(() => {
  const cx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = text => {
    const read = base => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = base; cx.fillStyle = text; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data]; };
    const a = read('#000000'), b = read('#ffffff');
    if (a.join() !== b.join()) throw new Error('unparsed colour: ' + text);
    return [a[0], a[1], a[2], a[3] / 255];
  };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat([a + under[3] * (1 - a)]); };
  const mix = (backdrop, inner, opacity) => [0, 1, 2].map(i => backdrop[i] * (1 - opacity) + inner[i] * opacity).concat([1]);
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  const resolveFill = css => { const probe = document.createElement('div'); probe.style.background = css; document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return rgba(value); };
  return (selector, kind, fills) => {
    const target = document.querySelector(selector);
    if (!target) return null;
    const chain = []; for (let node = target; node; node = node.parentElement) chain.unshift(node);
    const style = node => getComputedStyle(node);
    const foreground = () => {
      if (kind === 'color') return rgba(style(target).color);
      if (kind === 'stroke') return rgba(style(target).stroke);
      if (kind === 'fill') return rgba(style(target).fill);
      if (kind === 'border') return rgba(style(target).borderTopColor);
      if (kind === 'dot') return rgba(getComputedStyle(target, '::before').backgroundColor);
      return rgba(getComputedStyle(target, '::before').borderTopColor);
    };
    const fg = foreground();
    // pixel(i, backdrop) = what shows at the text for the chain from element i inward, given what shows behind element i.
    const pixel = (i, backdrop, ink) => {
      const node = chain[i], s = style(node), opacity = Number(s.opacity);
      let inner = backdrop;
      const own = i === chain.length - 1 && fills ? fills : null;
      const bg = rgba(s.backgroundColor);
      if (own) inner = over(own, inner); else if (bg[3] > 0) inner = over(bg, inner);
      const result = i === chain.length - 1 ? (ink ? over(ink, inner) : inner) : pixel(i + 1, inner, ink);
      return mix(backdrop, result, opacity);
    };
    const page = rgba(getComputedStyle(document.documentElement).backgroundColor);
    const base = page[3] > 0 ? page : [255, 255, 255, 1];
    const fillList = fills ? fills.map(resolveFill) : [null];
    return Math.min(...fillList.map(fill => { fills = fill; const shown = pixel(0, base, fg), behind = pixel(0, base, null); return ratio(shown, behind); }));
  };
})()`;

function findChrome() {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  return candidates.find(file => fs.existsSync(file));
}

/** Starts headless Chrome over CDP, runs `drive(send)` against `url`, and always ends the whole process group. */
async function withChrome(chrome, directory, url, drive, timeoutMs = 90000) {
  const profile = path.join(directory, 'profile');
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--use-mock-keychain', '--password-store=basic', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', detached: true });
  let timer; let stopped = false; let exitInfo = null;
  child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Chrome run timed out after ${timeoutMs} ms`)), timeoutMs); });
  const work = async () => {
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
    let id = 0; const pending = new Map();
    socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mine = ++id;
      pending.set(mine, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      socket.send(JSON.stringify({ id: mine, method, params }));
    });
    await send('Page.enable');
    const loaded = new Promise(resolve => { const previous = socket.onmessage; socket.onmessage = event => { previous(event); if (JSON.parse(event.data).method === 'Page.loadEventFired') resolve(); }; });
    await send('Page.navigate', { url });
    await loaded;
    try { return await drive(send); } finally { socket.close(); }
  };
  try {
    const running = work();
    running.catch(() => {});
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer); stopped = true;
    const exited = exitInfo ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    await exited;
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp profile: ${error.message}`); }
  }
}

test('map view colour: topics, edges, tags, toolbar, AI chat and dialog buttons meet WCAG AA in the default light and dark themes (headless Chrome, opacity and translucent fills blended in)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-map-colour-'));
  try {
    const file = path.join(directory, 'map.html');
    fs.writeFileSync(file, PAGE);
    const report = await withChrome(chrome, directory, pathToFileURL(file).href, async send => {
      const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page error');
        return result.result.value;
      };
      await send('DOM.enable'); await send('CSS.enable');
      const hoverOn = async (selector, on) => {
        const { root: doc } = await send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector });
        await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: on ? ['hover'] : [] });
        await new Promise(resolve => setTimeout(resolve, 150));
      };
      const out = {};
      for (const scheme of ['light', 'dark']) {
        const surface = BUTTON_SURFACE[scheme];
        const vars = { ...tokens[scheme], '--interactive-normal': surface['--interactive-normal'], '--interactive-hover': surface['--interactive-hover'] };
        await evaluate(`(() => { document.body.className = ${JSON.stringify(`theme-${scheme}`)}; document.body.removeAttribute('style'); for (const [k, v] of Object.entries(${JSON.stringify(vars)})) document.body.style.setProperty(k, v); })()`);
        await new Promise(resolve => setTimeout(resolve, 200));
        await evaluate(`window.probe = ${PROBE}`);
        const rows = {};
        for (const [name, selector, kind, need, options = {}] of CASES) {
          if (options.hover) await hoverOn(selector, true);
          // Buttons sit on Obsidian's own fill; the case passes only if it passes on every plausible fill.
          const fills = options.buttonEnvelope ? ['var(--interactive-normal)', 'var(--interactive-hover)', ...surface.envelope] : null;
          rows[name] = { need, ratio: await evaluate(`window.probe(${JSON.stringify(selector)}, ${JSON.stringify(kind)}, ${JSON.stringify(fills)})`) };
          if (options.hover) await hoverOn(selector, false);
        }
        const details = await evaluate(`(() => {
          const side = document.querySelector('.vam-node[data-relevance="side"]'), core = document.querySelector('.vam-node[data-relevance="core"]');
          const edge = document.querySelector('.vam-edge:not(.vam-edge-side):not(.vam-edge-convergence)'), edgeSide = document.querySelector('.vam-edge-side');
          const rel = (kind, state = ':not(.is-related):not(.is-dimmed):not(.is-selected)') => getComputedStyle(document.querySelector('.vam-relation-' + kind + state)), convergence = document.querySelector('.vam-edge-convergence');
          const gap = getComputedStyle(document.querySelector('.vam-relation-gap')), dash = kind => rel(kind).strokeDasharray.replace(/px|,/g, '');
          return { hitPointer: getComputedStyle(document.querySelector('.vam-relation-hit')).pointerEvents, hitStroke: getComputedStyle(document.querySelector('.vam-relation-hit')).stroke, labelPointer: getComputedStyle(document.querySelector('.vam-relation-label')).pointerEvents, labelDisplay: getComputedStyle(document.querySelector('.vam-relation-label')).display, labelVisibility: getComputedStyle(document.querySelector('.vam-relation-label')).visibility,
            dashes: { supports: dash('supports'), contradicts: dash('contradicts'), verifies: dash('verifies'), derives_from: dash('derives_from'), related: dash('related'), prerequisite: dash('prerequisite') }, widths: Object.fromEntries(['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'].map(kind => [kind, rel(kind).strokeWidth])), selectedWidths: { supports: rel('supports', '.is-selected').strokeWidth, derives_from: rel('derives_from', '.is-selected').strokeWidth }, verifiesCap: rel('verifies').strokeLinecap, pointers: ['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'].map(kind => rel(kind).pointerEvents), gapStroke: gap.stroke, gapWidth: gap.strokeWidth, gapPointer: gap.pointerEvents, canvas: getComputedStyle(document.body).backgroundColor,
            convergenceDash: getComputedStyle(convergence).strokeDasharray, edgeDash: getComputedStyle(edge).strokeDasharray, edgesPointer: getComputedStyle(document.querySelector('.vam-edges')).pointerEvents,
            coreWidth: getComputedStyle(core).borderTopWidth,
            sideBorder: getComputedStyle(side).borderTopStyle, sideOpacity: getComputedStyle(side).opacity, sideTag: !!side.querySelector('.vam-relevance-tag'), coreBorder: getComputedStyle(core).borderTopStyle,
            edgeStroke: getComputedStyle(edge).stroke, sideStroke: getComputedStyle(edgeSide).stroke, edgeSideOpacity: getComputedStyle(edgeSide).opacity, sideBorderColor: getComputedStyle(side).borderTopColor };
        })()`);
        details.parentWidth = await evaluate(`getComputedStyle(document.querySelector('.vam-edge[data-parent-line]')).strokeWidth`);
        details.aimEdgeWidth = await evaluate(`getComputedStyle(document.querySelector('.vam-edge-aim')).strokeWidth`);
        details.aimEdgeStroke = await evaluate(`getComputedStyle(document.querySelector('.vam-edge-aim')).stroke`);
        details.accent = await evaluate(`(() => { const p = document.createElement('i'); p.style.color = 'var(--interactive-accent)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
        // Hover / selection of a skippable topic must not change its look beyond the border colour (no opacity jump).
        await hoverOn('.vam-node[data-relevance="side"]', true);
        details.sideHoverOpacity = await evaluate(`getComputedStyle(document.querySelector('.vam-node[data-relevance="side"]')).opacity`);
        details.sideHoverBorder = await evaluate(`getComputedStyle(document.querySelector('.vam-node[data-relevance="side"]')).borderTopStyle`);
        await hoverOn('.vam-node[data-relevance="side"]', false);
        await evaluate(`document.querySelector('.vam-node[data-relevance="side"]').classList.add('is-selected')`);
        details.sideSelectedOpacity = await evaluate(`getComputedStyle(document.querySelector('.vam-node[data-relevance="side"]')).opacity`);
        details.sideSelectedBorder = await evaluate(`getComputedStyle(document.querySelector('.vam-node[data-relevance="side"]')).borderTopStyle`);
        await evaluate(`document.querySelector('.vam-node[data-relevance="side"]').classList.remove('is-selected')`);
        out[scheme] = { rows, details };
      }
      return out;
    });
    for (const scheme of ['light', 'dark']) {
      const { rows } = report[scheme];
      console.log(`map view contrast ${scheme}:\n${Object.entries(rows).map(([name, row]) => `  ${name.padEnd(30)} ${row.ratio === null ? 'missing' : row.ratio.toFixed(2)}  (need ${row.need || 'info'})`).join('\n')}`);
    }
    for (const scheme of ['light', 'dark']) {
      const { rows, details } = report[scheme];
      for (const [name, row] of Object.entries(rows)) {
        assert.notEqual(row.ratio, null, `${scheme}: ${name} exists in the fixture DOM`);
        if (row.need) assert.ok(row.ratio >= row.need, `${scheme}: ${name} contrast ${row.ratio.toFixed(2)} must be >= ${row.need}`);
      }
      // hypothesis-evidence (decision 35 A1/A2): the mind map's parent line is thin, at least 3:1, and clearly lighter than every semantic line.
      const parent = rows['edge'].ratio, lightestSemantic = Math.min(...Object.entries(rows).filter(([name]) => /^line-.*-(normal|related)$/.test(name)).map(([, row]) => row.ratio));
      assert.ok(parent >= 3, `${scheme}: parent line ${parent.toFixed(2)} must be >= 3`);
      assert.ok(parent < lightestSemantic - 1, `${scheme}: parent line ${parent.toFixed(2)} must be lighter than the lightest semantic line ${lightestSemantic.toFixed(2)}`);
      assert.equal(details.parentWidth, '1.5px', `${scheme}: the parent line is 1.5px`); assert.equal(details.aimEdgeWidth, '2px', `${scheme}: an edge without data-parent-line (AIM, sample, viewer) keeps the 2px accent line`); assert.equal(details.aimEdgeStroke, details.accent, `${scheme}: and its accent colour`);
      console.log(`parent line ${scheme}: ${parent.toFixed(2)}:1, lightest semantic line ${lightestSemantic.toFixed(2)}:1`);
      // Counterexamples: the cues that replace the fade stay visible and stable.
      // hypothesis-evidence: the new line types stay distinguishable without colour (dash pattern) and leave the old ones alone. The hypothesis frame is now a shape outline, measured with every other type in the kind matrix test below.
      const d = details.dashes;
      assert.equal(d.supports, 'none', `${scheme}: supports is solid`); assert.equal(d.contradicts, '8 4', `${scheme}: contradicts is dashed 8 4`); assert.equal(d.verifies, '1 5', `${scheme}: verifies is dotted 1 5`);
      assert.equal(d.derives_from, 'none', `${scheme}: derives from is a solid double line`); assert.equal(d.related, 'none', `${scheme}: related is solid`); assert.equal(d.prerequisite, '10 4 2 4', `${scheme}: prerequisite is long-short`);
      assert.equal(details.verifiesCap, 'round', `${scheme}: the dots are round`);
      assert.equal(new Set(Object.values(d)).size, 4, `${scheme}: the patterns tell contradicts, verifies and prerequisite apart from the solid kinds and each other`);
      assert.notEqual(d.contradicts, details.convergenceDash.replace(/px|,/g, ''), `${scheme}: contradicts differs from the AIM 5 5 convergence dashes`);
      assert.deepEqual(details.widths, { supports: '1.75px', contradicts: '1.75px', verifies: '1.75px', derives_from: '4.5px', related: '1.25px', prerequisite: '1.75px' }, `${scheme}: line widths`); // decision 35 A2: 2px / 5px became 1.75px / 4.5px
      assert.deepEqual(details.selectedWidths, { supports: '2.75px', derives_from: '5.5px' }, `${scheme}: a selected line is 1px heavier`); // decision 35 A2
      assert.equal(details.gapWidth, '1.5px', `${scheme}: the inner line of a double line is 1.5px`); assert.equal(details.gapStroke, details.canvas, `${scheme}: and in the canvas colour`); assert.equal(details.gapPointer, 'none');
      assert.deepEqual(details.pointers, Array(6).fill('none'), `${scheme}: no line takes pointer events`);
      assert.notEqual(details.labelDisplay, 'none', `${scheme}: a label is shown by default`); assert.equal(details.labelVisibility, 'visible');
      assert.equal(details.hitPointer, 'stroke', `${scheme}: the wide hit path takes pointer events on its stroke`);
      assert.equal(details.labelPointer, 'none', `${scheme}: the relation name takes no pointer events`);
      assert.equal(details.edgeDash, 'none', `${scheme}: the parent-child line stays solid`);
      assert.equal(details.edgesPointer, 'none', `${scheme}: the edge layer keeps pointer-events none`);
      assert.equal(details.coreWidth, '1px', `${scheme}: an ordinary topic keeps the 1px frame`);
      assert.equal(details.sideBorder, 'dashed', `${scheme}: a skippable topic keeps a dashed frame`);
      assert.notEqual(details.coreBorder, 'dashed', `${scheme}: only skippable topics get the dashed frame`);
      assert.equal(details.sideTag, true, `${scheme}: a skippable topic keeps its tag`);
      assert.equal(details.sideOpacity, '1', `${scheme}: a skippable topic is not faded`);
      assert.equal(details.edgeSideOpacity, '1', `${scheme}: a skippable edge is not faded`);
      assert.notEqual(details.sideStroke, details.edgeStroke, `${scheme}: a skippable edge keeps a colour different from a normal edge`);
      assert.equal(details.sideHoverOpacity, '1', `${scheme}: hover does not change a skippable topic's opacity`);
      assert.equal(details.sideSelectedOpacity, '1', `${scheme}: selection does not change a skippable topic's opacity`);
      assert.equal(details.sideHoverBorder, 'dashed', `${scheme}: hover keeps the dashed frame (no jump)`);
      assert.equal(details.sideSelectedBorder, 'dashed', `${scheme}: selection keeps the dashed frame (no jump)`);
    }
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

// ---- hypothesis-evidence (V1.6 P11): six topic types x seven research states x both themes ----
// The shape cards are built from the real topic-kind-shape.ts (so the outline, fold and classes are the ones view.ts draws), then measured in headless Chrome.
const KIND_STATES = [
  ['completed', 'data-status="completed"', ''],
  ['idea', 'data-status="idea"', ''],
  ['idea+side', 'data-status="idea" data-relevance="side"', ''],
  ['running', 'data-status="running"', ''],
  ['queued', 'data-status="queued"', ''],
  ['error', 'data-status="error"', ''],
  ['selected', 'data-status="completed"', ' is-selected']
];
const KIND_IDS = ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion'];
function shapeMarkup(kind) {
  const { renderShapeBackground } = load('experiences/visual-map/topic-kind-shape.ts', {}, {
    createSvg: tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } })
  });
  let drawn = '';
  const html = el => `<${el.tag}${el.classes.length ? ` class="${el.classes.join(' ')}"` : ''}${Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${el.children.map(html).join('')}</${el.tag}>`;
  renderShapeBackground({ appendChild(el) { drawn = html(el); } }, kind);
  return drawn;
}
const KIND_PAGE = () => `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
body { margin: 0; width: 2400px; height: 1400px; background: var(--background-primary); color: var(--text-normal); }
.vam-node { width: 280px; }
</style></head><body><div class="vam-viewport" style="width:2400px;height:1400px"><div class="vam-stage">${KIND_IDS.map((kind, row) => KIND_STATES.map(([state, attrs, extra], col) => {
  const kindAttr = kind === 'topic' ? '' : ` data-topic-kind="${kind}"`;
  // decision 35 B1: every typed card carries the tag (a hypothesis with its strength, the others with the type name).
  const tagHtml = kind === 'hypothesis' ? '<span class="vam-hypothesis-tag" data-strength="weak">Hypothesis · Weak</span>' : kind === 'topic' ? '' : `<span class="vam-hypothesis-tag vam-kind-tag">${kind}</span>`;
  return `<div class="vam-node${extra}"${kindAttr} ${attrs} data-case="${kind}|${state}" style="left:${20 + col * 330}px;top:${20 + row * 220}px;padding:28px 40px">${shapeMarkup(kind)}<div class="vam-node-header">${tagHtml}</div><h3 class="vam-card-title" title="Title">Title of the topic</h3><p class="vam-card-summary">A short summary of the topic.</p></div>`;
}).join('')).join('')}</div></div></body></html>`;
const KIND_PROBE = `(() => {
  const cx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = text => { const read = base => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = base; cx.fillStyle = text; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data]; }; const a = read('#000000'), b = read('#ffffff'); if (a.join() !== b.join()) throw new Error('unparsed colour: ' + text); return [a[0], a[1], a[2], a[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat([1]); };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  const canvas = over(rgba(getComputedStyle(document.querySelector('.vam-viewport')).backgroundColor), [255, 255, 255, 1]);
  const rows = {};
  for (const card of document.querySelectorAll('[data-case]')) {
    const [kind, state] = card.dataset.case.split('|');
    const outline = card.querySelector('.vam-kind-outline'), style = getComputedStyle(card);
    const cardBg = rgba(style.backgroundColor);
    const fill = outline ? over(rgba(getComputedStyle(outline).fill), canvas) : over(cardBg, canvas);
    const row = { text: Math.min(ratio(over(rgba(getComputedStyle(card.querySelector('.vam-card-title')).color), fill), fill), ratio(over(rgba(getComputedStyle(card.querySelector('.vam-card-summary')).color), fill), fill)) };
    const tag = card.querySelector('.vam-hypothesis-tag');
    if (tag) row.tag = ratio(over(rgba(getComputedStyle(tag).color), fill), fill);
    if (kind !== 'topic') {
      const line = over(rgba(outline ? getComputedStyle(outline).stroke : style.borderTopColor), fill);
      row.outline = Math.min(ratio(line, fill), ratio(line, canvas));
      row.cardFrame = outline ? { border: style.borderTopColor, bg: style.backgroundColor, shadow: style.boxShadow, outline: style.outlineStyle, width: getComputedStyle(outline).strokeWidth, dash: getComputedStyle(outline).strokeDasharray } : null;
    }
    rows[card.dataset.case] = row;
  }
  return rows;
})()`;

test('hypothesis-evidence: six topic types x seven research states keep text >= 4.5:1 and the shape outline >= 3:1 in the light and dark themes', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-kind-colour-'));
  try {
    const file = path.join(directory, 'kinds.html');
    fs.writeFileSync(file, KIND_PAGE());
    const report = await withChrome(chrome, directory, pathToFileURL(file).href, async send => {
      const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page error');
        return result.result.value;
      };
      const out = {};
      for (const scheme of ['light', 'dark']) {
        await evaluate(`(() => { document.body.className = ${JSON.stringify(`theme-${scheme}`)}; document.body.removeAttribute('style'); document.body.style.cssText = 'margin:0;width:2400px;height:1400px;background:var(--background-primary);color:var(--text-normal)'; for (const [k, v] of Object.entries(${JSON.stringify(tokens[scheme])})) document.body.style.setProperty(k, v); })()`);
        await new Promise(resolve => setTimeout(resolve, 200));
        out[scheme] = await evaluate(KIND_PROBE);
      }
      return out;
    });
    let lowestText = Infinity, lowestOutline = Infinity, lowestTag = Infinity, lowestAt = {};
    for (const scheme of ['light', 'dark']) {
      const rows = report[scheme];
      assert.equal(Object.keys(rows).length, KIND_IDS.length * KIND_STATES.length, `${scheme}: every type x state case is in the fixture`);
      for (const [name, row] of Object.entries(rows)) {
        assert.ok(row.text >= 4.5, `${scheme} ${name}: title / summary ${row.text.toFixed(2)} must be >= 4.5`);
        if (row.text < lowestText) { lowestText = row.text; lowestAt.text = `${scheme} ${name}`; }
        if (row.tag !== undefined) { assert.ok(row.tag >= 4.5, `${scheme} ${name}: hypothesis tag ${row.tag.toFixed(2)} must be >= 4.5`); if (row.tag < lowestTag) { lowestTag = row.tag; lowestAt.tag = `${scheme} ${name}`; } }
        if (row.outline !== undefined) {
          assert.ok(row.outline >= 3, `${scheme} ${name}: outline ${row.outline.toFixed(2)} must be >= 3 (against the fill and the canvas)`);
          if (row.outline < lowestOutline) { lowestOutline = row.outline; lowestAt.outline = `${scheme} ${name}`; }
        }
        const [kind, state] = name.split('|');
        assert.equal(row.tag !== undefined, kind !== 'topic', `${scheme} ${name}: every typed card has a kind tag, an ordinary topic has none`);
        if (row.cardFrame) {
          // The four SVG types hide the card's own frame and shadow; selected is heavier, a skippable one is dashed, the others are solid.
          assert.equal(row.cardFrame.shadow, 'none', `${scheme} ${name}: no card shadow behind a shape`);
          assert.match(row.cardFrame.bg, /rgba\(0, 0, 0, 0\)|transparent/, `${scheme} ${name}: no card fill behind a shape`);
          assert.equal(row.cardFrame.width, state === 'selected' ? '3px' : '2px', `${scheme} ${name}: outline weight`);
          assert.equal(row.cardFrame.dash !== 'none', state === 'idea+side', `${scheme} ${name}: only a skippable topic is dashed`);
          if (state === 'selected') assert.equal(row.cardFrame.outline, 'none', `${scheme} ${name}: no rectangular selection outline around a shape`);
        }
        assert.ok(KIND_IDS.includes(kind));
      }
    }
    console.log(`kind matrix (6 types x 7 states x 2 themes): lowest text ${lowestText.toFixed(2)} (${lowestAt.text}), lowest hypothesis tag ${lowestTag.toFixed(2)} (${lowestAt.tag}), lowest outline ${lowestOutline.toFixed(2)} (${lowestAt.outline})`);
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

// ---- hypothesis-evidence (V1.6 P13): the colour fixture keeps covering every line state ----
test('hypothesis-evidence: the colour matrix measures six line kinds x normal / related / dimmed / selected at >= 3:1 and both label forms at >= 4.5:1', () => {
  const lines = CASES.filter(([name]) => name.startsWith('line-'));
  assert.equal(lines.length, 24);
  for (const kind of RELATION_KINDS) for (const [state] of RELATION_STATES) {
    const row = lines.find(([name]) => name === `line-${kind}-${state}`);
    assert.ok(row, `${kind} ${state} is measured`); assert.equal(row[3], ['normal', 'related'].includes(state) ? 4.5 : 3); // decision 35 A2: the resting and related states of a semantic line need 4.5, up from 3
    assert.match(PAGE, new RegExp(`data-case="${kind}\\|${state}"`), `${kind} ${state} is in the fixture DOM`);
  }
  for (const name of ['relation-label', 'relation-label-expanded']) assert.equal(CASES.find(([n]) => n === name)[3], 4.5, name);
  assert.ok(CASES.some(([n, , , need]) => n === 'relation-arrow' && need === 3) && CASES.some(([n]) => n === 'relation-arrow-bar'));
  assert.match(PAGE, /vam-relation-gap/, 'the double line gap is in the fixture');
});

// ---- topic colour (ticket 37 P2b): six colours x six types x light / dark ----
// Same cards as the kind matrix, with `data-topic-color`. Text >= 4.5 on the tinted fill; the 4px stripe >= 3 against the card fill and the canvas.
const COLOR_IDS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];
const COLOR_STATES = KIND_STATES;
const COLOR_PAGE = () => `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
body { margin: 0; width: 1200px; height: 9000px; background: var(--background-primary); color: var(--text-normal); }
.vam-node { width: 280px; }
</style></head><body><div class="vam-viewport" style="width:2400px;height:9000px"><div class="vam-stage">${COLOR_IDS.flatMap((color, c) => KIND_IDS.map((kind, row) => COLOR_STATES.map(([state, attrs, extra], col) => {
  const kindAttr = kind === 'topic' ? '' : ` data-topic-kind="${kind}"`;
  const tagHtml = kind === 'hypothesis' ? '<span class="vam-hypothesis-tag" data-strength="weak">Hypothesis · Weak</span>' : kind === 'topic' ? '' : `<span class="vam-hypothesis-tag vam-kind-tag">${kind}</span>`;
  return `<div class="vam-node${extra}"${kindAttr} data-topic-color="${color}" ${attrs} data-case="${kind}|${state}|${color}" style="left:${20 + col * 330}px;top:${20 + (c * KIND_IDS.length + row) * 220}px;padding:28px 40px">${shapeMarkup(kind)}<div class="vam-node-header">${tagHtml}</div><h3 class="vam-card-title" title="Title">Title of the topic</h3><p class="vam-card-summary">A short summary of the topic.</p></div>`;
})).flat()).join('')}</div></div></body></html>`;
const COLOR_PROBE = `(() => {
  const cx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = text => { const read = base => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = base; cx.fillStyle = text; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data]; }; const a = read('#000000'), b = read('#ffffff'); if (a.join() !== b.join()) throw new Error('unparsed colour: ' + text); return [a[0], a[1], a[2], a[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + under[i] * (1 - a)).concat([1]); };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  const canvas = over(rgba(getComputedStyle(document.querySelector('.vam-viewport')).backgroundColor), [255, 255, 255, 1]);
  const rows = {};
  for (const card of document.querySelectorAll('[data-case]')) {
    const outline = card.querySelector('.vam-kind-outline'), style = getComputedStyle(card);
    const fill = outline ? over(rgba(getComputedStyle(outline).fill), canvas) : over(rgba(style.backgroundColor), canvas);
    const text = el => ratio(over(rgba(getComputedStyle(el).color), fill), fill);
    const row = { text: Math.min(text(card.querySelector('.vam-card-title')), text(card.querySelector('.vam-card-summary'))), plain: fill.join() === canvas.join() };
    const tag = card.querySelector('.vam-hypothesis-tag');
    if (tag) row.tag = text(tag);
    const stripe = getComputedStyle(card, '::before');
    row.stripeShown = stripe.content !== 'none' && stripe.width === '4px';
    if (row.stripeShown) { const bar = over(rgba(stripe.backgroundColor), fill); row.stripe = Math.min(ratio(bar, fill), ratio(bar, canvas)); }
    rows[card.dataset.case] = row;
  }
  return rows;
})()`;

test('topic-color: six colours x six types x light / dark keep text >= 4.5:1 on the tinted fill and the stripe >= 3:1 against the fill and the canvas', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-topic-color-'));
  try {
    const file = path.join(directory, 'colors.html');
    fs.writeFileSync(file, COLOR_PAGE());
    const report = await withChrome(chrome, directory, pathToFileURL(file).href, async send => {
      const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page error');
        return result.result.value;
      };
      const out = {};
      for (const scheme of ['light', 'dark']) {
        await evaluate(`(() => { document.body.className = ${JSON.stringify(`theme-${scheme}`)}; document.body.removeAttribute('style'); document.body.style.cssText = 'margin:0;width:2400px;height:9000px;background:var(--background-primary);color:var(--text-normal)'; for (const [k, v] of Object.entries(${JSON.stringify(tokens[scheme])})) document.body.style.setProperty(k, v); })()`);
        await new Promise(resolve => setTimeout(resolve, 200));
        out[scheme] = await evaluate(COLOR_PROBE);
      }
      return out;
    });
    let lowestText = Infinity, lowestStripe = Infinity, lowestTag = Infinity, at = {};
    for (const scheme of ['light', 'dark']) {
      const rows = report[scheme];
      assert.equal(Object.keys(rows).length, COLOR_IDS.length * KIND_IDS.length * COLOR_STATES.length, `${scheme}: every colour x type x state case is in the fixture`);
      for (const [name, row] of Object.entries(rows)) {
        assert.equal(row.plain, false, `${scheme} ${name}: the colour tints the fill`);
        assert.ok(row.text >= 4.5, `${scheme} ${name}: title / summary ${row.text.toFixed(2)} must be >= 4.5`);
        assert.ok(row.stripeShown, `${scheme} ${name}: the 4px stripe is drawn`);
        assert.ok(row.stripe >= 3, `${scheme} ${name}: stripe ${row.stripe?.toFixed(2)} must be >= 3`);
        if (row.tag !== undefined) assert.ok(row.tag >= 4.5, `${scheme} ${name}: type tag ${row.tag.toFixed(2)} must be >= 4.5`);
        if (row.text < lowestText) { lowestText = row.text; at.text = `${scheme} ${name}`; }
        if (row.stripe < lowestStripe) { lowestStripe = row.stripe; at.stripe = `${scheme} ${name}`; }
        if (row.tag !== undefined && row.tag < lowestTag) { lowestTag = row.tag; at.tag = `${scheme} ${name}`; }
      }
    }
    console.log(`topic-color matrix (6 colours x 6 types x ${COLOR_STATES.length} states x 2 themes): lowest text ${lowestText.toFixed(2)} (${at.text}), lowest type tag ${lowestTag.toFixed(2)} (${at.tag}), lowest stripe ${lowestStripe.toFixed(2)} (${at.stripe})`);
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});

test('topic-color: the menu swatches and the stripe colours come from the six whitelisted ids only, and no rule reads a frontmatter value', () => {
  for (const id of COLOR_IDS) {
    assert.match(styles, new RegExp(`\\.vam-node\\[data-topic-color="${id}"\\]`), `${id} card rule`);
    assert.match(styles, new RegExp(`\\[data-topic-color-swatch="${id}"\\]`), `${id} swatch rule`);
  }
  assert.doesNotMatch(styles, /data-topic-color\s*[~|^$*]=/, 'only exact whitelisted ids are matched');
  const swatchRules = styles.split('\n').filter(l => /data-topic-color-swatch/.test(l));
  assert.ok(swatchRules.every(l => /^\.vam-topic-modal /.test(l)), 'menu swatch rules start with .vam-topic-modal so the share viewer does not collect them');
});

test('topic-color: the share viewer defines all six colour tokens, light and dark, with the values of the Obsidian defaults, so a shared card tints like the plugin card', () => {
  const css = fs.readFileSync(path.join(root, 'experiences/sharing/viewer/viewer.css'), 'utf8');
  const dark = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(dark > 0);
  for (const [scheme, block] of [['light', css.slice(0, dark)], ['dark', css.slice(dark)]])
    for (const id of COLOR_IDS) {
      const found = block.match(new RegExp(`--color-${id}:\\s*([^;]+);`));
      assert.ok(found, `${scheme} --color-${id} is defined`);
      assert.equal(found[1].trim(), tokens[scheme][`--color-${id}`], `${scheme} --color-${id} equals the Obsidian default`);
    }
});
