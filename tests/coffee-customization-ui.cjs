const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');

function load(entry, overrides = {}) {
  const code = buildSync({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['obsidian', 'node:*'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: name => overrides[name] || require(name),
    console,
    crypto: require('node:crypto').webcrypto,
    AbortController,
    TextDecoder,
    process,
    window: { setTimeout, clearTimeout },
  });
  return module.exports;
}

function element(tag, options = {}) {
  return {
    tag,
    text: options.text ?? '',
    value: options.value ?? '',
    attrs: options.attr ?? {},
    cls: options.cls ?? '',
    children: [],
    disabled: false,
    createEl(name, childOptions) {
      const child = element(name, childOptions);
      this.children.push(child);
      return child;
    },
    createDiv(value) {
      return this.createEl('div', typeof value === 'string' ? { cls: value } : value);
    },
    createSpan(value) {
      return this.createEl('span', value);
    },
    querySelectorAll(selector) {
      const result = [];
      const visit = node => {
        for (const child of node.children) {
          const matches = selector.startsWith('.')
            ? child.cls.split(' ').includes(selector.slice(1))
            : child.tag === selector;
          if (matches) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    },
    addEventListener(name, handler) { this[name] = handler; },
    addClass() {},
    setText(value) { this.text = value; },
    empty() { this.children = []; },
  };
}

class Modal {
  constructor() {
    this.modalEl = element('modal');
    this.contentEl = element('content');
    this.didClose = false;
  }
  close() { this.didClose = true; this.onClose?.(); }
}

const notices = [];
const obsidian = { Modal, Notice: class { constructor(message) { notices.push(message); } } };
const { CoffeeCustomizationModal } = load('experiences/coffee-tables/customization-ui.ts', { obsidian });
const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
const { createSession } = load('experiences/coffee-tables/types.ts');
const customization = load('experiences/coffee-tables/customization.ts');
const prompts = load('experiences/coffee-tables/prompts.ts');

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

function button(modal, label) {
  const found = find(modal.contentEl, item => item.tag === 'button' && item.text === label);
  assert.ok(found, `expected button: ${label}`);
  return found;
}

function textareas(modal) {
  return modal.contentEl.querySelectorAll('textarea');
}

async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for customization action');
}

test('Coffee prompt resets preserve merge settings and Apply saves only this table', async () => {
  notices.length = 0;
  const session = createSession('桌聊主題', 'test-model', 'low', 'zh-TW');
  session.guests.stylePrompt = '既有聊天室風格';
  session.guests.customization = {
    ...customization.defaultCustomization('zh-TW'),
    observerPrompt: '既有觀察者偏好',
    mergeLevel: 'compact',
  };
  let saves = 0, runtimeCalls = 0;
  const engine = new CoffeeEngine(session, async () => { runtimeCalls++; return ''; }, async () => { saves++; });
  const modal = new CoffeeCustomizationModal({}, engine, async () => {}, () => {}, async work => work());
  modal.onOpen();

  const [style, observerPrompt] = textareas(modal);
  assert.equal(style.value, '既有聊天室風格');
  assert.equal(observerPrompt.value, '既有觀察者偏好');
  button(modal, '還原聊天預設').onclick();
  button(modal, '還原整理與收斂 Prompt').onclick();
  assert.equal(style.value, prompts.cleanChatStyle(prompts.BUILTIN_COFFEE_STYLE_PROMPT));
  assert.equal(observerPrompt.value, customization.defaultCustomization('zh-TW').observerPrompt);

  button(modal, '套用此聊天室').onclick();
  await until(() => modal.didClose);
  assert.equal(runtimeCalls, 0);
  assert.equal(saves, 1);
  assert.equal(engine.session.guests.stylePrompt, prompts.cleanChatStyle(prompts.BUILTIN_COFFEE_STYLE_PROMPT));
  assert.deepEqual(JSON.parse(JSON.stringify(engine.session.guests.customization)), { ...JSON.parse(JSON.stringify(customization.defaultCustomization('zh-TW'))), mergeLevel: 'compact' });
  assert.deepEqual(notices, ['聊天室設定已保存。']);
});

test('Coffee one-time Preview uses unsaved observer settings without saving chat settings', async () => {
  notices.length = 0;
  const session = createSession('桌聊主題', 'test-model', 'low', 'zh-TW');
  session.status = 'completed';
  session.guests.stylePrompt = '已保存的聊天室風格';
  session.guests.customization = customization.defaultCustomization('zh-TW');
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 原有觀點仍有不同理由與條件。<!-- coffee-insight:v1:id=insight-a -->'];
  const savedCustomization = JSON.parse(JSON.stringify(customization.normalizeCustomization(session.guests.customization, 'zh-TW')));
  const response = JSON.stringify({ proposals: [{ sourceIds: ['insight-a'], summary: '整理後的不同觀點。', detail: '保留各自理由與條件。', category: 'disagreements' }] });
  let saves = 0, prompt = '', confirmations = 0, reviewed = 0;
  const engine = new CoffeeEngine(session, async request => { prompt = request.prompt; return response; }, async () => { saves++; });
  const modal = new CoffeeCustomizationModal({}, engine, async () => {}, () => { reviewed++; }, async work => { confirmations++; await work(); });
  modal.onOpen();

  const [style, observerPrompt] = textareas(modal);
  style.value = '未保存的聊天室風格';
  observerPrompt.value = '這次預覽請明確保留未知條件。';
  button(modal, '只用這次：預覽收斂').onclick();
  await until(() => modal.didClose);

  assert.equal(confirmations, 1);
  assert.equal(reviewed, 1);
  assert.ok(saves >= 1, 'the generated preview is persisted for review');
  assert.match(prompt, /這次預覽請明確保留未知條件/);
  assert.doesNotMatch(prompt, /未保存的聊天室風格/);
  assert.equal(engine.session.guests.stylePrompt, '已保存的聊天室風格');
  assert.deepEqual(JSON.parse(JSON.stringify(customization.normalizeCustomization(engine.session.guests.customization, 'zh-TW'))), savedCustomization);
  assert.equal(engine.session.convergenceDraft.customization.observerPrompt, '這次預覽請明確保留未知條件。');
  assert.deepEqual(notices, []);
});

test('Coffee Default for new tables saves settings without changing the open table', async () => {
  const session = createSession('桌聊主題', 'test-model', 'low', 'zh-TW');
  session.guests.stylePrompt = '此桌原本的風格';
  const savedStyle = session.guests.stylePrompt;
  const savedCustomization = JSON.parse(JSON.stringify(customization.normalizeCustomization(session.guests.customization, 'zh-TW')));
  const engine = new CoffeeEngine(session, async () => '', async () => {});
  let defaultValue;
  const modal = new CoffeeCustomizationModal({}, engine, async (style, value) => { defaultValue = { style, value }; }, () => {}, async work => work());
  modal.onOpen();
  const [style, observerPrompt] = textareas(modal);
  style.value = '新聊天室預設風格';
  observerPrompt.value = '新桌保留未解條件。';
  button(modal, '設為新聊天室預設').onclick();
  await until(() => !!defaultValue);

  assert.equal(defaultValue.style, '新聊天室預設風格');
  assert.equal(defaultValue.value.observerPrompt, '新桌保留未解條件。');
  assert.equal(engine.session.guests.stylePrompt, savedStyle);
  assert.deepEqual(JSON.parse(JSON.stringify(customization.normalizeCustomization(engine.session.guests.customization, 'zh-TW'))), savedCustomization);
  assert.equal(modal.didClose, false);
});

test('Coffee Test consumes all unsaved prompt drafts in one request without saving table or defaults', async () => {
  const session = createSession('Fictional evening access', 'test-model', 'low', 'en');
  session.guests.stylePrompt = 'saved chat instructions';
  session.guests.customization = customization.defaultCustomization('en');
  const before = JSON.stringify(session);
  let calls = 0, saves = 0, defaults = 0, request;
  const engine = new CoffeeEngine(session, async value => { calls++; request = value; return 'single settings test response'; }, async () => { saves++; });
  const modal = new CoffeeCustomizationModal({}, engine, async () => { defaults++; }, () => {}, async work => work());
  modal.onOpen();
  const [style, observer, convergence] = textareas(modal);
  style.value = 'UNSAVED chat draft marker'; observer.value = 'UNSAVED observer draft marker'; convergence.value = 'UNSAVED convergence draft marker';
  button(modal, 'Test').onclick();
  const result = find(modal.contentEl, item => item.attrs['aria-label'] === 'Settings test result');
  await until(() => result.value === 'single settings test response');
  assert.equal(calls, 1); assert.equal(saves, 0); assert.equal(defaults, 0);
  for (const marker of [style.value, observer.value, convergence.value]) assert.ok(request.prompt.includes(marker));
  assert.equal(request.session.guests.stylePrompt, style.value);
  assert.equal(request.session.guests.customization.observerPrompt, observer.value);
  assert.equal(request.session.model, 'test-model'); assert.equal(request.session.reasoning, session.reasoning);
  assert.equal(JSON.stringify(engine.session), before); assert.equal(modal.didClose, false);
});

test('Coffee Reset prompts preserves non-prompt settings and only persists on table Apply', async () => {
  const session = createSession('Fictional evening access', 'test-model', 'low', 'en');
  session.guests.stylePrompt = 'saved custom chat';
  session.guests.customization = { ...customization.defaultCustomization('en'), observerPrompt: 'saved custom observer', convergencePrompt: 'saved custom convergence', mergeLevel: 'compact', detailLevel: 'brief', preserve: ['sources', 'conditions'] };
  const before = JSON.stringify(session); let saves = 0, defaults = 0, calls = 0;
  const engine = new CoffeeEngine(session, async () => { calls++; return ''; }, async () => { saves++; });
  const modal = new CoffeeCustomizationModal({}, engine, async () => { defaults++; }, () => {}, async work => work()); modal.onOpen();
  button(modal, 'Reset prompts').onclick();
  const [style, observer, convergence] = textareas(modal);
  assert.equal(style.value, prompts.cleanChatStyle(prompts.BUILTIN_COFFEE_STYLE_PROMPT_EN));
  assert.equal(observer.value, customization.defaultCustomization('en').observerPrompt);
  assert.equal(convergence.value, customization.defaultCustomization('en').convergencePrompt);
  assert.equal(JSON.stringify(engine.session), before); assert.equal(saves, 0); assert.equal(defaults, 0);
  button(modal, 'Apply to this table').onclick(); await until(() => modal.didClose);
  assert.equal(saves, 1); assert.equal(defaults, 0); assert.equal(calls, 0);
  assert.equal(engine.session.guests.stylePrompt, style.value);
  assert.equal(engine.session.guests.customization.mergeLevel, 'compact');
  assert.equal(engine.session.guests.customization.detailLevel, 'brief');
  assert.deepEqual(Array.from(engine.session.guests.customization.preserve).sort(), ['conditions', 'sources']);
});

test('Coffee settings Test failure and cancellation never save, retry, or adopt a late response', async () => {
  const session = createSession('Fictional evening access', 'test-model', 'low', 'en'); const before = JSON.stringify(session);
  let calls = 0, saves = 0;
  const failed = new CoffeeEngine(session, async () => { calls++; throw Error('provider failure'); }, async () => { saves++; });
  await assert.rejects(failed.testCustomization('draft chat', customization.defaultCustomization('en')), /provider failure/);
  assert.equal(calls, 1); assert.equal(saves, 0); assert.equal(JSON.stringify(failed.session), before);
  let resolve, request;
  const cancelled = new CoffeeEngine(session, value => { request = value; calls++; return new Promise(done => { resolve = done; }); }, async () => { saves++; });
  const pending = cancelled.testCustomization('draft chat', customization.defaultCustomization('en'));
  await assert.rejects(cancelled.setCustomization('other edit', customization.defaultCustomization('en')), /Wait/);
  cancelled.cancelRecommendations(); assert.equal(request.signal.aborted, true); resolve('late response');
  await assert.rejects(pending, /cancelled/); assert.equal(calls, 2); assert.equal(saves, 0); assert.equal(JSON.stringify(cancelled.session), before);
});
