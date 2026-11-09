// Which Obsidian window connectCdp drives (scripts/obsidian-cdp.mjs). One Obsidian process can hold windows for several
// vaults, so the command must reach the requested vault's window or nothing. Fake DevTools windows run each expression
// against their own `app`, so a test sees which window a command really changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');

const lib = () => import(pathToFileURL(path.join(root, 'scripts', 'obsidian-cdp.mjs')).href);
const vaultWindow = basePath => ({ app: { vault: { adapter: { basePath } } }, methods: [] });

// Runs `body` with a real port file for a fresh vault and the given fake windows, in /json/list order.
async function withDevTools(makeWindows, body) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-cdp-target-'));
  fs.mkdirSync(path.join(vault, '.vam-app'));
  fs.writeFileSync(path.join(vault, '.vam-app', 'DevToolsActivePort'), '9222\n/devtools/browser/x\n');
  const windows = makeWindows(fs.realpathSync(vault));
  const { fetch, WebSocket } = globalThis;
  globalThis.fetch = async () => ({ json: async () => windows.map((_, index) => ({ type: 'page', url: 'app://obsidian.md/index.html', webSocketDebuggerUrl: `ws://fake/${index}` })) });
  globalThis.WebSocket = class {
    constructor(url) { this.window = windows[Number(url.split('/').pop())]; queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      this.window.methods.push(method);
      const value = method === 'Runtime.evaluate' ? vm.runInNewContext(params.expression, { app: this.window.app }) : undefined;
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result: { result: { value } } }) }));
    }
    close() {}
  };
  try { await body(vault, windows); }
  finally {
    Object.assign(globalThis, { fetch, WebSocket });
    fs.rmSync(vault, { recursive: true, force: true });
  }
}

test('connectCdp drives the requested vault even when another vault owns the first window', async () => {
  const { connectCdp } = await lib();
  await withDevTools(vault => [vaultWindow('/Users/someone/iCloud/Personal'), vaultWindow(vault)], async (vault, [other, intended]) => {
    const cdp = await connectCdp(vault);
    assert.equal(await cdp.evaluate('app.touched = true; app.vault.adapter.basePath'), fs.realpathSync(vault));
    cdp.close();
    assert.equal(intended.app.touched, true);
    assert.equal(other.app.touched, undefined);
    assert.ok(!other.methods.includes('Runtime.enable'), 'the other vault only answers which vault it has open');
  });
});

test('connectCdp fails and runs nothing when no window has the requested vault open', async () => {
  const { connectCdp } = await lib();
  await withDevTools(() => [vaultWindow('/Users/someone/iCloud/Personal'), { app: undefined, methods: [] }], async (vault, windows) => {
    await assert.rejects(connectCdp(vault), error => {
      assert.match(error.message, /No Obsidian window for/);
      assert.ok(error.message.includes(fs.realpathSync(vault)), 'names the requested vault');
      assert.ok(error.message.includes('/Users/someone/iCloud/Personal'), 'names the vault that is open instead');
      return true;
    });
    assert.equal(windows[0].app.touched, undefined);
    for (const window of windows) assert.ok(!window.methods.includes('Runtime.enable'));
  });
});
