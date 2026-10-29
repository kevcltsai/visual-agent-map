// 0.28 ticket 11: Mermaid diagrams inside VAM notes (.vam-mermaid-scope) reach WCAG 2.x AA in Obsidian's default light and dark themes.
// The SVGs under tests/fixtures/color/mermaid are real output of Obsidian 1.14.5's bundled mermaid (including its inline <style>), so the
// class structure is what users get. Headless Chrome loads styles.css with the real default token values and, in the dark theme, applies the
// filter Obsidian puts on mermaid svgs (VAM-restyled diagram types switch it off). Text is measured at its centre over every filled shape
// stacked beneath it; lines and bar borders over the page. Text needs 4.5, lines and borders need 3. Decorative gantt grid lines and
// axes are exempt, and the glyph strokes inside architecture icon tiles are measured against their tile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');

const tokens = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/color/obsidian-default-tokens.json'), 'utf8'));
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const DIAGRAMS = ['gitGraph', 'mindmap', 'gantt', 'xychart', 'architecture'];
const svgs = Object.fromEntries(DIAGRAMS.map(name => [name, fs.readFileSync(path.join(root, 'tests/fixtures/color/mermaid', `${name}.svg`), 'utf8')]));
// Obsidian's dark theme inverts mermaid svgs: `.theme-dark .mermaid svg { filter: invert(1) hue-rotate(180deg) saturate(1.25) }` (read from Obsidian 1.14.5).
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
.theme-dark .mermaid svg { filter: invert(1) hue-rotate(180deg) saturate(1.25); }
${styles}
body { margin: 0; width: 1000px; background: var(--background-primary); color: var(--text-normal); }
.mermaid { width: 900px; padding: 8px 0; }
</style></head><body>
${DIAGRAMS.map(name => `<div class="mermaid vam-mermaid-scope" data-diagram="${name}">${svgs[name]}</div>`).join('\n')}
</body></html>`;

const PROBE = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const parse = s => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const opChain = (el, stop) => { let a = 1; for (let n = el; n && n !== stop.parentNode; n = n.parentNode) if (n.nodeType === 1) a *= Number(getComputedStyle(n).opacity); return a; };
  const off = document.createElement('canvas'); off.width = off.height = 1; const oc = off.getContext('2d', { willReadFrequently: true });
  const cv2 = document.createElement('canvas'); cv2.width = cv2.height = 1; const c2 = cv2.getContext('2d', { willReadFrequently: true });
  // layers are painted inside the svg (and filtered with it), then drawn over the page colour
  const render = (page, layers, filter) => { oc.clearRect(0, 0, 1, 1); for (const [c, a] of layers) { oc.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; oc.fillRect(0, 0, 1, 1); }
    c2.filter = 'none'; c2.fillStyle = 'rgb(' + page[0] + ',' + page[1] + ',' + page[2] + ')'; c2.fillRect(0, 0, 1, 1); c2.filter = filter; c2.drawImage(off, 0, 0); c2.filter = 'none'; const d = c2.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
  const SHAPES = 'rect,path,polygon,circle,ellipse';
  const info = name => {
    const host = document.querySelector('[data-diagram="' + name + '"]'), svg = host.querySelector('svg');
    const page = parse(getComputedStyle(document.body).getPropertyValue('--background-primary')).slice(0, 3);
    let filter = 'none'; for (let n = svg; n && n !== host.parentElement; n = n.parentElement) { const f = getComputedStyle(n).filter; if (f !== 'none') filter = f; }
    return { host, svg, page, filter, shapes: [...svg.querySelectorAll(SHAPES)].filter(s => s.isPointInFill && !s.closest('defs,marker,clipPath,mask')) };
  };
  // filled shapes (in paint order) under a client point, as [rgb, alpha] layers
  const under = (d, px, py, skip) => {
    const layers = [];
    for (const s of d.shapes) {
      if (skip(s)) continue;
      const scs = getComputedStyle(s); if (scs.fill === 'none' || scs.display === 'none' || scs.visibility === 'hidden') continue;
      const m = s.getScreenCTM(); if (!m) continue;
      let hit = false; try { hit = s.isPointInFill(new DOMPoint(px, py).matrixTransform(m.inverse())); } catch { /* not hittable */ }
      if (!hit) continue;
      const sf = parse(scs.fill), a = sf[3] * Number(scs.fillOpacity) * opChain(s, d.svg);
      if (a > 0.01) layers.push([sf, a]);
    }
    return layers;
  };
  const texts = name => {
    const d = info(name), rows = [];
    for (const el of d.svg.querySelectorAll('text, tspan, foreignObject *')) {
      if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const isSvg = el instanceof SVGElement;
      const f = parse(isSvg ? cs.fill : cs.color), fa = (isSvg ? Number(cs.fillOpacity) : 1) * f[3] * opChain(el, d.svg);
      const layers = under(d, r.x + r.width / 2, r.y + r.height / 2, s => s.contains(el) || el.contains(s));
      if (!isSvg) for (let n = el; n && n.tagName !== 'foreignObject'; n = n.parentElement) { const b = parse(getComputedStyle(n).backgroundColor); if (b[3] > 0) { layers.push([b, b[3]]); break; } }
      if (isSvg && cs.paintOrder.startsWith('stroke') && cs.stroke !== 'none' && parseFloat(cs.strokeWidth) >= 1) { const h = parse(cs.stroke); layers.push([h, h[3] * Number(cs.strokeOpacity)]); }
      const bg = render(d.page, layers, d.filter), fg = render(d.page, [...layers, [f, fa]], d.filter);
      rows.push({ text: el.textContent.trim().slice(0, 24), cls: (el.getAttribute('class') || '') + ' < ' + (el.parentElement?.getAttribute('class') || ''), ratio: ratio(fg, bg) });
    }
    return rows;
  };
  // unfilled path / line strokes; strokes inside a nested icon svg are measured against the icon tile (a rect) beneath them, not the glyph's own white fills
  const strokes = name => {
    const d = info(name), rows = [];
    for (const s of d.svg.querySelectorAll('path, line, polyline')) {
      if (s.closest('defs,marker,clipPath,mask')) continue;
      const scs = getComputedStyle(s); if (scs.stroke === 'none' || scs.display === 'none' || scs.visibility === 'hidden') continue;
      if (scs.fill !== 'none' && parse(scs.fill)[3] * Number(scs.fillOpacity) > 0.01) continue;
      const r = s.getBoundingClientRect(); if (r.width < 1 && r.height < 1) continue;
      const sc = parse(scs.stroke), a = sc[3] * Number(scs.strokeOpacity) * opChain(s, d.svg);
      const icon = !!s.closest('svg svg');
      const layers = icon ? under(d, r.x + r.width / 2, r.y + r.height / 2, shape => shape.tagName !== 'rect') : [];
      rows.push({ cls: s.getAttribute('class') || (icon ? 'icon-glyph' : s.tagName), ratio: ratio(render(d.page, [...layers, [sc, a]], d.filter), render(d.page, layers, d.filter)), inGrid: !!s.closest('.grid') || (s.getAttribute('class') || '').includes('tick') });
    }
    return rows;
  };
  // filled shapes or stroked borders of the elements matching a selector, against the page
  const marks = (name, selector, kind) => {
    const d = info(name);
    return [...d.svg.querySelectorAll(selector)].map(s => {
      const scs = getComputedStyle(s), c = parse(kind === 'fill' ? scs.fill : scs.stroke), a = c[3] * Number(kind === 'fill' ? scs.fillOpacity : scs.strokeOpacity) * opChain(s, d.svg);
      return { cls: s.getAttribute('class') || s.tagName, ratio: ratio(render(d.page, [[c, a]], d.filter), d.page), color: kind === 'fill' ? scs.fill : scs.stroke, filter: d.filter };
    });
  };
  // hollow marks (cherry, merge centre, reverse cross, highlight centre) against the commit mark beneath them
  const glyphs = (name, selector, kind) => {
    const d = info(name), base = 'circle.commit:not(.commit-merge):not(.commit-cherry-pick), rect.commit-highlight-outer';
    return [...d.svg.querySelectorAll(selector)].map(el => {
      const scs = getComputedStyle(el), c = parse(kind === 'fill' ? scs.fill : scs.stroke), r = el.getBoundingClientRect();
      const layers = under(d, r.x + r.width / 2, r.y + r.height / 2, s => s === el || !s.matches(base));
      return { cls: el.getAttribute('class') || el.tagName, ratio: ratio(render(d.page, [...layers, [c, c[3]]], d.filter), render(d.page, layers, d.filter)) };
    });
  };
  const computed = (name, selector, prop) => (selector === 'svg' ? [info(name).svg] : [...info(name).svg.querySelectorAll(selector)]).map(s => ({ cls: s.getAttribute('class') || s.tagName, value: getComputedStyle(s)[prop] }));
  return { texts, strokes, marks, glyphs, computed };
})()`;

function findChrome() {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  return candidates.find(file => fs.existsSync(file));
}

/** Starts headless Chrome over CDP, runs `drive(send)` against `url`, and always ends the whole process group. */
async function withChrome(chrome, directory, url, drive, timeoutMs = 90000) {
  const profile = path.join(directory, 'profile');
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', detached: true });
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


const lowest = (rows, key = 'cls') => { const out = {}; for (const row of rows) if (!(row[key] in out) || row.ratio < out[row[key]]) out[row[key]] = row.ratio; return out; };
const branchIndex = cls => Number(/(?:^| )(?:arrow|label|commit)(\d+)(?: |$)/.exec(cls)?.[1] ?? -1);

test('mermaid colour: gitGraph, mindmap, gantt and xychart in VAM notes reach WCAG AA in the default light and dark themes (headless Chrome, Obsidian dark filter applied)', async t => {
  const chrome = findChrome();
  if (!chrome) return t.skip('no Chrome found (set CHROME_BIN)');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-mermaid-colour-'));
  try {
    const file = path.join(directory, 'mermaid.html');
    fs.writeFileSync(file, PAGE);
    const report = await withChrome(chrome, directory, pathToFileURL(file).href, async send => {
      const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'page error');
        return result.result.value;
      };
      const out = {};
      for (const scheme of ['light', 'dark']) {
        await evaluate(`(() => { document.body.className = ${JSON.stringify(`theme-${scheme}`)}; document.body.removeAttribute('style'); for (const [k, v] of Object.entries(${JSON.stringify(tokens[scheme])})) document.body.style.setProperty(k, v); })()`);
        await new Promise(resolve => setTimeout(resolve, 200));
        await evaluate(`window.probe = ${PROBE}`);
        const call = (fn, ...args) => evaluate(`window.probe.${fn}(${args.map(a => JSON.stringify(a)).join(', ')})`);
        const result = { texts: {}, strokes: {} };
        for (const name of DIAGRAMS) { result.texts[name] = await call('texts', name); result.strokes[name] = await call('strokes', name); }
        result.commitDots = await call('marks', 'gitGraph', 'circle.commit:not(.commit-merge):not(.commit-cherry-pick)', 'fill');
        result.highlightOuter = [...await call('marks', 'gitGraph', 'rect.commit-highlight-outer', 'fill'), ...await call('marks', 'gitGraph', 'rect.commit-highlight-outer', 'stroke')];
        result.hollow = [...await call('glyphs', 'gitGraph', 'circle.commit-cherry-pick, circle.commit-merge, rect.commit-highlight-inner', 'fill'), ...await call('glyphs', 'gitGraph', 'line.commit-cherry-pick, path.commit-reverse', 'stroke')];
        result.ganttBorders = await call('marks', 'gantt', 'rect.task', 'stroke');
        result.ganttFills = await call('computed', 'gantt', 'rect.task', 'fill');
        result.mindmapEdges = await call('computed', 'mindmap', 'path.edge', 'stroke');
        result.arrowColors = await call('computed', 'gitGraph', 'path.arrow', 'stroke');
        result.labelFills = await call('computed', 'gitGraph', 'rect.branchLabelBkg', 'fill');
        result.filters = {};
        for (const name of ['gitGraph', 'mindmap', 'gantt', 'xychart']) result.filters[name] = (await call('computed', name, 'svg', 'filter'))[0].value;
        out[scheme] = result;
      }
      return out;
    });
    const rowsOut = [];
    for (const scheme of ['light', 'dark']) {
      const r = report[scheme];
      for (const name of DIAGRAMS) {
        const texts = lowest(r.texts[name]), strokes = lowest(r.strokes[name].filter(row => !row.inGrid));
        rowsOut.push(`${scheme} ${name.padEnd(12)} text min ${Math.min(...Object.values(texts)).toFixed(2)}  line min ${Object.keys(strokes).length ? Math.min(...Object.values(strokes)).toFixed(2) : '-'}`);
      }
      const arrows = lowest(r.strokes.gitGraph.filter(row => row.cls.includes('arrow')));
      rowsOut.push(`${scheme} gitGraph arrows ${Object.entries(arrows).map(([k, v]) => `${k.replace('arrow ', '')}=${v.toFixed(2)}`).join(' ')}`);
      rowsOut.push(`${scheme} highlight frame min ${Math.min(...r.highlightOuter.map(m => m.ratio)).toFixed(2)}; cut-outs min ${Math.min(...r.hollow.map(m => m.ratio)).toFixed(2)}`);
      rowsOut.push(`${scheme} commit dots min ${Math.min(...r.commitDots.map(m => m.ratio)).toFixed(2)}; gantt borders ${Object.entries(lowest(r.ganttBorders)).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')}`);
    }
    console.log(`mermaid contrast:\n  ${rowsOut.join('\n  ')}`);

    for (const scheme of ['light', 'dark']) {
      const r = report[scheme];
      // Text in every fixture diagram: 4.5.
      for (const name of DIAGRAMS) for (const row of r.texts[name]) assert.ok(row.ratio >= 4.5, `${scheme}: ${name} text "${row.text}" (${row.cls}) contrast ${row.ratio.toFixed(2)} must be >= 4.5`);
      // Lines that carry structure: 3. Gantt grid lines and axes are decorative.
      for (const name of DIAGRAMS) for (const row of r.strokes[name]) {
        if (row.inGrid) continue;
        assert.ok(row.ratio >= 3, `${scheme}: ${name} line ${row.cls} contrast ${row.ratio.toFixed(2)} must be >= 3`);
      }
      // gitGraph: eight branches, commit dots, every arrow, labels (text above covers branch and commit labels).
      assert.equal(new Set(r.arrowColors.map(row => branchIndex(row.cls))).size >= 8, true, 'fixture has all eight branch arrows');
      for (const m of r.commitDots) assert.ok(m.ratio >= 3, `${scheme}: commit dot ${m.cls} contrast ${m.ratio.toFixed(2)} must be >= 3`);
      assert.ok(r.commitDots.length >= 9, 'fixture has the commit dots');
      assert.equal(r.highlightOuter.length, 2, 'fixture has a HIGHLIGHT frame');
      for (const m of r.highlightOuter) assert.ok(m.ratio >= 3, `${scheme}: HIGHLIGHT frame ${m.color} contrast ${m.ratio.toFixed(2)} must be >= 3`);
      assert.equal(r.hollow.length, 7, 'fixture has the cherry-pick, merge, REVERSE and HIGHLIGHT cut-outs');
      for (const m of r.hollow) assert.ok(m.ratio >= 3, `${scheme}: cut-out ${m.cls} contrast ${m.ratio.toFixed(2)} against its commit mark must be >= 3`);
      // gantt: done bar border 3 (also doneCrit).
      const done = r.ganttBorders.filter(m => /done/.test(m.cls));
      assert.ok(done.length >= 2, 'fixture has done bars');
      for (const m of r.ganttBorders) assert.ok(m.ratio >= 3, `${scheme}: gantt bar border ${m.cls} contrast ${m.ratio.toFixed(2)} must be >= 3`);

      // Counterexamples: the cues that tell things apart survive the recolouring.
      const arrowByBranch = new Map(r.arrowColors.map(row => [branchIndex(row.cls), row.value]));
      for (let i = 0; i < 7; i++) assert.notEqual(arrowByBranch.get(i), arrowByBranch.get(i + 1), `${scheme}: gitGraph branch ${i} and ${i + 1} keep different line colours`);
      const labelByBranch = new Map(r.labelFills.map(row => [branchIndex(row.cls), row.value]));
      for (let i = 0; i < 7; i++) assert.notEqual(labelByBranch.get(i), labelByBranch.get(i + 1), `${scheme}: gitGraph branch labels ${i} and ${i + 1} keep different fills`);
      const sectionEdges = new Map(r.mindmapEdges.map(row => [Number(/section-edge-(\d+)/.exec(row.cls)[1]), row.value]));
      for (let i = 0; i < 6; i++) assert.notEqual(sectionEdges.get(i), sectionEdges.get(i + 1), `${scheme}: mindmap sections ${i} and ${i + 1} keep different edge colours`);
      assert.ok(sectionEdges.size >= 11, 'fixture has the sixteen-section mindmap');
      const fillOf = re => r.ganttFills.find(row => re.test(row.cls) && !/crit/.test(row.cls))?.value;
      const doneFill = fillOf(/done/), plainFill = r.ganttFills.find(row => !/done|active|crit/.test(row.cls))?.value;
      assert.ok(doneFill && plainFill, 'fixture has done and plain bars');
      assert.notEqual(doneFill, plainFill, `${scheme}: gantt done and not-started bars keep different fills`);
      // VAM-restyled diagram types do not keep Obsidian's dark inversion.
      for (const [name, filter] of Object.entries(r.filters)) assert.equal(filter, 'none', `${scheme}: ${name} filter is off`);
    }
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { console.warn(`could not remove temp directory: ${error.message}`); }
  }
});
