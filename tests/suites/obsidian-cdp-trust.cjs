// The harness trust step (scripts/obsidian-cdp.mjs trustExpression + assertTrusted). It runs against a fake Obsidian
// window in a vm context: the trust prompt is a Modal whose close pops one keymap scope, as Obsidian's Modal does.
// Removing only the prompt's DOM used to leave that Escape scope on top of the window stack, which blocked the view's ⌘Z.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');

const lib = () => import(pathToFileURL(path.join(root, 'scripts', 'obsidian-cdp.mjs')).href);

// A window in Restricted Mode (unless `enabled`), with one trust prompt per entry of `prompts`. A prompt's cancel button
// closes it and pops its scope when `closes` is true; when false the click does nothing, like a prompt that never closes.
function fakeWindow({ enabled = false, prompts = [{ closes: true }], plugins = ['visual-agent-map'] } = {}) {
  const stack = { prevScopes: ['app-scope'] };
  const modals = [];
  for (const prompt of prompts) {
    stack.prevScopes.push(`modal-scope-${modals.length}`);
    const modal = {
      querySelector: selector => selector === 'button.mod-cancel' ? {
        click() {
          if (!prompt.closes) return;
          modals.splice(modals.indexOf(modal), 1);
          stack.prevScopes.pop();
        }
      } : null,
      remove() { modals.splice(modals.indexOf(modal), 1); }
    };
    modals.push(modal);
  }
  let pluginsOn = enabled;
  const enabledPlugins = new Set(enabled ? plugins : []);
  const app = {
    keymap: { getWindowStack: () => stack },
    plugins: {
      isEnabled: () => pluginsOn,
      async setEnable(value) { pluginsOn = value; },
      enabledPlugins,
      async enablePluginAndSave(id) { enabledPlugins.add(id); }
    },
    vault: { configDir: '.obsidian', adapter: { read: async () => JSON.stringify(plugins) } }
  };
  const document = { querySelectorAll: selector => selector === '.modal-container.mod-confirmation' ? [...modals] : [] };
  return { context: vm.createContext({ app, document, activeWindow: {}, JSON, Promise }), stack, modals };
}

test('trust closes the Restricted Mode prompt through its cancel button so its keymap scope is popped', async () => {
  const { trustExpression, assertTrusted } = await lib();
  const win = fakeWindow();
  const result = await vm.runInContext(trustExpression, win.context);
  assert.deepEqual({ ...result, enabled: [...result.enabled] }, { enabled: ['visual-agent-map'], prompts: 0, scopesBefore: 2, scopesAfter: 1, leakedScopes: 0 });
  assert.deepEqual(win.stack.prevScopes, ['app-scope']);
  assert.equal(assertTrusted(result), result);
});

test('trust reports a prompt that stays open and its scope, and assertTrusted refuses that result', async () => {
  const { trustExpression, assertTrusted } = await lib();
  const win = fakeWindow({ prompts: [{ closes: false }] });
  const result = await vm.runInContext(trustExpression, win.context);
  assert.equal(result.prompts, 1);
  assert.equal(result.leakedScopes, 1);
  assert.throws(() => assertTrusted(result), /left 1 prompt\(s\) and 1 keymap scope\(s\) behind/);
});

test('assertTrusted refuses a result whose prompt is gone but whose scope stayed (the old DOM-only removal)', async () => {
  const { assertTrusted } = await lib();
  assert.throws(() => assertTrusted({ enabled: ['visual-agent-map'], prompts: 0, scopesBefore: 2, scopesAfter: 2, leakedScopes: 1 }), /0 prompt\(s\) and 1 keymap scope\(s\) behind/);
});

test('trust on a vault that already left Restricted Mode touches no prompt and leaks nothing', async () => {
  const { trustExpression, assertTrusted } = await lib();
  const win = fakeWindow({ enabled: true, prompts: [] });
  const result = await vm.runInContext(trustExpression, win.context);
  assert.equal(result.leakedScopes, 0);
  assert.equal(result.prompts, 0);
  assert.equal(assertTrusted(result), result);
});
