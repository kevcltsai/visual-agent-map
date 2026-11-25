// Two gaps in the start card chat with the chief editor (2026-11-25): the language follows the book, and the 60 s timeout.
// Unit level on a stand-in DOM; the real Obsidian look is UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const MAP = 'Agent Workspace/Topics/map-bk1/Map.md';
const timers = { hold: false, held: [] };
class OptionStub { constructor(text, value) { const o = dom.element('option', { text }); o.optionValue = value; o.value = value; o.disabled = false; return o; } }
const bundle = loadSource(`
export { default as Plugin } from "./main";
export { BookStartModal, BOOK_EDIT_TIMEOUT_MS } from "./experiences/visual-map/book-pipeline-start-modal";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Option: OptionStub, window: { setTimeout: (fn, ms) => (ms === bundle.BOOK_EDIT_TIMEOUT_MS && timers.hold ? (timers.held.push(fn), 99) : setTimeout(fn, ms)), clearTimeout, setInterval, clearInterval } });

test('chat language: the request follows the book (plugin language en), not the Chinese owner message', async () => {
  const prompts = [];
  const run = async language => {
    const self = { settings: { ...support.DEFAULT_SETTINGS, language }, aiCalls: { run: async prepared => { prompts.push(JSON.stringify(prepared)); return { reply: 'ok', changes: {} }; } }, currentModelChoice: () => ({ reasoning: 'low' }) };
    await bundle.Plugin.prototype.editBookSettings.call(self, { mapPath: MAP, model: 'claude:opus', message: '讓語氣更活潑一點', settings: {}, turns: [] }, new AbortController().signal);
    return prompts.at(-1);
  };
  const en = await run('en');
  assert.match(en, /Write in English/, 'the English instruction is sent although the owner wrote Chinese');
  const zh = await run('zh-TW');
  assert.doesNotMatch(zh, /Write in English/, 'control: a Chinese book gets no English instruction');
});

test('chat timeout: the 60 s timer aborts the call, adds exactly one failure line and leaves the fields as they were', async () => {
  bundle.setUiLanguage('zh-TW');
  const byCls = (modal, cls) => dom.findAll(modal.modalEl, i => (i.cls ?? '').split(/\s+/).includes(cls));
  const seen = [];
  const never = new Promise(() => {});
  const modal = new bundle.BookStartModal({}, {
    cards: 3, trialCards: 1, models: { plan: 'a', write: 'b', images: 'c', proof: 'd' }, modelChoice: { options: () => ['a'], label: x => x, onChange() {} },
    settings: { goal: '原本的目標' }, onStart() {},
    editSettings: (request, signal) => { seen.push(signal); return never; }
  });
  modal.open(); modal.setSuggestions(null);
  const goal = dom.findAll(modal.modalEl, i => i.tag === 'textarea').find(f => f.value === '原本的目標');
  const input = dom.findAll(modal.modalEl, i => i.tag === 'input' && i.attrs.id === 'vam-book-chat-input')[0];
  const send = dom.findAll(modal.modalEl, i => i.tag === 'button' && (i.cls ?? '').includes('vam-book-chat-send'))[0];
  timers.hold = true; timers.held.length = 0;
  try {
    input.value = '改一下'; input.fire('input'); send.click(); await dom.tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].aborted, false, 'still waiting before the timer fires');
    assert.equal(timers.held.length, 1, 'exactly the 60 s timer was held');
    timers.held[0]();
    await dom.tick(); await dom.tick();
    assert.equal(seen[0].aborted, true);
    assert.equal(byCls(modal, 'vam-book-chat-failed').length, 1);
    assert.equal(goal.value, '原本的目標', 'the fields are unchanged');
    assert.equal(byCls(modal, 'vam-book-start-edited').length, 0);
  } finally { timers.hold = false; modal.close(); }
});
