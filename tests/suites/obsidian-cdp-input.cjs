// Trusted input for the harness (scripts/obsidian-cdp.mjs): key-combo parsing, Input.dispatch* parameters and the CLI
// click-by-selector path. A fake `send` records the CDP calls, so no Obsidian window is needed.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');

const lib = () => import(pathToFileURL(path.join(root, 'scripts', 'obsidian-cdp.mjs')).href);
const recorder = () => { const calls = []; return { calls, send: async (method, params) => { calls.push({ method, params }); return {}; } }; };

test('parseKeyCombo rejects unknown key names instead of guessing', async () => {
  const { parseKeyCombo } = await lib();
  assert.throws(() => parseKeyCombo('Mod+Foo', 'linux'), /Unknown key/);
  assert.throws(() => parseKeyCombo('Hyper+a', 'darwin'), /Unknown/);
});

test('parseKeyCombo maps Mod to Ctrl on linux', async () => {
  const { parseKeyCombo } = await lib();
  assert.equal(parseKeyCombo('Mod+Enter', 'linux').modifiers, 2);
});

test('parseKeyCombo maps Mod to Meta on darwin', async () => {
  const { parseKeyCombo } = await lib();
  assert.equal(parseKeyCombo('Mod+Enter', 'darwin').modifiers, 4);
});

test('parseKeyCombo describes named, function and printable keys', async () => {
  const { parseKeyCombo } = await lib();
  assert.deepEqual(parseKeyCombo('Enter', 'darwin'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' });
  assert.deepEqual(parseKeyCombo('Escape', 'darwin'), { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0, text: '' });
  assert.deepEqual(parseKeyCombo('F2', 'darwin'), { key: 'F2', code: 'F2', windowsVirtualKeyCode: 113, modifiers: 0, text: '' });
  assert.deepEqual(parseKeyCombo('ArrowDown', 'darwin'), { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 0, text: '' });
  assert.deepEqual(parseKeyCombo('Shift+Alt+a', 'darwin'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 9, text: 'a' });
  assert.equal(parseKeyCombo('Mod+z', 'linux').text, '');
});

test('click sends a left mouse press and release at the point', async () => {
  const { createInput } = await lib();
  const { calls, send } = recorder();
  await createInput(send, 'darwin').click(10, 20);
  assert.deepEqual(calls, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 } }
  ]);
});

test('press sends rawKeyDown, char for Enter, then keyUp', async () => {
  const { createInput } = await lib();
  const { calls, send } = recorder();
  await createInput(send, 'darwin').press('Mod+Enter');
  assert.deepEqual(calls.map(call => call.params.type), ['rawKeyDown', 'char', 'keyUp']);
  assert.equal(calls[0].params.modifiers, 4);
  assert.equal(calls[0].params.windowsVirtualKeyCode, 13);
  const escape = recorder();
  await createInput(escape.send, 'darwin').press('Escape');
  assert.deepEqual(escape.calls.map(call => call.params.type), ['rawKeyDown', 'keyUp']);
});

test('clickSelector with no matching element throws and sends no mouse event', async () => {
  const { createInput, clickSelector } = await lib();
  const { calls, send } = recorder();
  const input = createInput(send, 'darwin');
  await assert.rejects(clickSelector({ evaluate: async () => null, click: input.click }, '.missing'), /\.missing/);
  assert.equal(calls.length, 0);
  await clickSelector({ evaluate: async () => ({ x: 5, y: 6 }), click: input.click }, '.found');
  assert.equal(calls[0].params.x, 5);
});

test('CLI click and key commands appear in the usage text', async () => {
  const { usage } = await lib();
  assert.match(usage, /click <selector>/);
  assert.match(usage, /key <combo>/);
});
