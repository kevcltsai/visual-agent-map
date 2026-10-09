const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['ai/runtime/codex-app-server.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
function fixture(autoInitialize = true) {
  const children = []; const requests = []; let threadCounter = 0;
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.send = message => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
    child.stdin = { write: line => {
      const message = JSON.parse(line); requests.push(message);
      const respond = result => process.nextTick(() => child.send({ id: message.id, result }));
      if (message.method === 'initialize' && autoInitialize) respond({});
      if (message.method === 'thread/start') respond({ thread: { id: `thread-${++threadCounter}` } });
      if (message.method === 'turn/start') respond({ turn: { id: `turn-${message.params.threadId}` } });
      if (message.method === 'thread/unsubscribe' || message.method === 'turn/interrupt') respond({});
    } };
    children.push(child); return child;
  };
  const moduleValue = { exports: {} };
  vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, require: name => name === 'node:child_process' ? { spawn } : require(name), window: { setTimeout, clearTimeout } });
  const runtime = new moduleValue.exports.CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  return { runtime, children, requests };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('a stopped initializer cannot fail or kill a replacement process', async () => {
  const { runtime, children, requests } = fixture(false);
  const old = runtime.start();
  const rejected = assert.rejects(old, /stopped|停止/i);
  runtime.stop();
  const replacement = runtime.start();
  const initialize = requests.filter(request => request.method === 'initialize').at(-1);
  children[1].send({ id: initialize.id, result: {} });
  await rejected;
  await replacement;
  assert.equal(children.length, 2);
  assert.equal(children[1].killed, false);
  await runtime.start();
  assert.equal(children.length, 2);
  runtime.stop();
});
test('two simultaneous turns share initialization and cancelling one preserves the other', async () => {
  const { runtime, children, requests } = fixture();
  const firstController = new AbortController();
  const first = runtime.runTask('first', 'model', 'low', null, { signal: firstController.signal });
  const firstRejected = assert.rejects(first, error => error.name === 'AbortError');
  const second = runtime.runTask('second', 'model', 'low', null);
  for (let attempt = 0; attempt < 10 && requests.filter(request => request.method === 'turn/start').length < 2; attempt++) await tick();
  assert.equal(children.length, 1);
  assert.equal(requests.filter(request => request.method === 'initialize').length, 1);
  const turns = requests.filter(request => request.method === 'turn/start');
  assert.equal(turns.length, 2);
  firstController.abort();
  const siblingThread = turns.find(turn => turn.params.input[0].text === 'second').params.threadId;
  children[0].send({ method: 'item/completed', params: { threadId: siblingThread, item: { id: 'message', type: 'agentMessage', text: 'Sibling response preserved' } } });
  children[0].send({ method: 'turn/completed', params: { threadId: siblingThread, turn: { status: 'completed' } } });
  await firstRejected;
  assert.equal(await second, 'Sibling response preserved');
  const interrupts = requests.filter(request => request.method === 'turn/interrupt');
  assert.equal(interrupts.length, 1);
  assert.notEqual(interrupts[0].params.threadId, siblingThread);
  assert.equal(requests.filter(request => request.method === 'thread/unsubscribe').length, 2);
  runtime.stop();
});
