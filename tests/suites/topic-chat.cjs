// Topic chat window (P1a): the component alone, driven through a fake host.
const assert = require('node:assert/strict');
const { test, load } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { element, find, findAll, byLabel } = dom;

const { TopicChatWindow } = load('experiences/visual-map/topic-chat.ts');
const { t } = load('i18n.ts');
const hasClass = (item, name) => dom.hasCls(item, name);

function fixture({ anchor, submit } = {}) {
  const doc = { activeElement: null };
  const root = element('div'); root.root = doc; root.ownerDocument = doc;
  const session = { turns: [], mode: 'quick', running: false, draftKind: null, draftText: '' };
  const watchers = [];
  const calls = { submit: [], close: 0, modes: [], opener: 0 };
  const host = {
    topicTitle: () => 'Premise',
    anchor: anchor ?? (() => null),
    session: () => session,
    subscribe: fn => { watchers.push(fn); return () => { watchers.splice(watchers.indexOf(fn), 1); }; },
    setMode: mode => { calls.modes.push(mode); session.mode = mode; watchers.slice().forEach(fn => fn()); },
    setDraft: (kind, text) => { session.draftKind = kind; session.draftText = text; },
    submit: async (kind, text) => { calls.submit.push([kind, text]); return submit ? submit(kind, text) : true; },
    close: () => { calls.close++; }
  };
  const opener = { focus: () => { calls.opener++; } };
  const win = new TopicChatWindow(host, opener, root);
  win.mount(root);
  const input = find(win.el, i => i.tag === 'textarea');
  const action = kind => find(win.el, i => i.tag === 'button' && i.text === t(`ui.topic_chat_${kind}`));
  const send = () => byLabel(win.el, t('ui.topic_chat_send'));
  const type = text => { input.value = text; input.input(); };
  const press = (key, extra = {}) => { let prevented = false; input.keydown({ key, preventDefault() { prevented = true; }, ...extra }); return prevented; };
  const refresh = () => watchers.slice().forEach(fn => fn());
  return { win, root, session, calls, input, action, send, type, press, refresh, watchers, doc };
}
const ghost = f => f.input.attrs.placeholder;

test('topic chat is a labelled dialog and the focus goes to the input', () => {
  const f = fixture();
  assert.equal(f.win.el.attrs.role, 'dialog');
  assert.equal(f.win.el.attrs['aria-label'], t('ui.topic_chat_label_0', 'Premise'));
  assert.equal(f.doc.activeElement, f.input);
});

test('topic chat counterexample 2: grey text that was not adopted cannot be sent, Tab adopts it, typing overwrites it', async () => {
  const f = fixture();
  assert.equal(f.send().disabled, true, 'nothing chosen yet');
  f.action('expand').click();
  assert.equal(f.input.value, '');
  assert.equal(ghost(f), t('ui.topic_chat_suggest_expand'));
  assert.equal(f.send().disabled, true);
  assert.equal(f.press('Enter'), true);
  f.send().click();
  await dom.tick();
  assert.deepEqual(f.calls.submit, [], 'the runner was not called');
  assert.equal(f.press('Tab'), true, 'Tab is taken over while a grey suggestion shows');
  assert.equal(f.input.value, t('ui.topic_chat_suggest_expand'));
  assert.equal(f.send().disabled, false);
  f.send().click();
  await dom.tick();
  assert.deepEqual(f.calls.submit, [['expand', t('ui.topic_chat_suggest_expand')]]);
  assert.equal(f.input.value, '', 'a started run clears the input');
  // Typing over the grey text: the typed text is what is sent.
  f.action('research').click();
  f.type('only the risks');
  assert.equal(f.send().disabled, false);
  assert.equal(f.press('Enter'), true);
  await dom.tick();
  assert.deepEqual(f.calls.submit[1], ['research', 'only the risks']);
});

test('topic chat Tab is native when there is no grey text, and free typing without a button cannot be sent', async () => {
  const f = fixture();
  assert.equal(f.press('Tab'), false);
  f.type('a free question');
  assert.equal(f.send().disabled, true);
  f.press('Enter');
  await dom.tick();
  assert.deepEqual(f.calls.submit, []);
  f.action('research').click();
  f.type('typed');
  assert.equal(f.press('Tab'), false, 'with typed text Tab stays native');
});

test('topic chat has three equal buttons without a suggested mark', () => {
  const f = fixture();
  const buttons = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-action'));
  assert.deepEqual(buttons.map(b => b.text), [t('ui.topic_chat_research'), t('ui.topic_chat_expand'), t('ui.topic_chat_synthesize')]);
  assert.ok(buttons.every(b => b.attrs['aria-pressed'] === 'false' && b.children.length === 0 && !hasClass(b, 'is-active')));
  assert.equal(findAll(f.win.el, i => /suggested|建議/i.test(i.text)).length, 0);
  f.action('synthesize').click();
  assert.deepEqual(buttons.map(b => b.attrs['aria-pressed']), ['false', 'false', 'true']);
});

test('topic chat mode switch sets aria-pressed and a polite one-line note for the current choice only', () => {
  const f = fixture();
  const group = find(f.win.el, i => i.attrs.role === 'group');
  assert.equal(group.attrs['aria-label'], t('ui.ai_mode'));
  const [quick, standard] = findAll(group, i => i.tag === 'button');
  assert.deepEqual([quick.text, standard.text], [t('ui.quick'), t('ui.standard')]);
  assert.deepEqual([quick.attrs['aria-pressed'], standard.attrs['aria-pressed']], ['true', 'false']);
  const note = find(f.win.el, i => i.attrs['aria-live'] === 'polite');
  assert.equal(note.text, t('ui.topic_chat_mode_quick_hint'));
  standard.click();
  assert.deepEqual(f.calls.modes, ['standard']);
  assert.deepEqual([quick.attrs['aria-pressed'], standard.attrs['aria-pressed']], ['false', 'true']);
  assert.equal(note.text, t('ui.topic_chat_mode_standard_hint'));
});

test('topic chat Escape closes and gives the focus back to the opener', () => {
  const f = fixture();
  f.win.el.fire('keydown', { key: 'Escape' });
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.opener, 1);
});

test('topic chat keeps the input when the send is declined', async () => {
  const f = fixture({ submit: () => false });
  f.action('research').click();
  f.press('Tab');
  f.send().click();
  await dom.tick();
  assert.equal(f.calls.submit.length, 1);
  assert.equal(f.input.value, t('ui.topic_chat_suggest_research'));
  assert.equal(f.session.draftKind, 'research');
  assert.equal(f.send().disabled, false, 'the user can try again');
});

test('topic chat while running: shows the running line and disables the buttons and send', () => {
  const f = fixture();
  f.action('research').click();
  f.press('Tab');
  f.session.running = true;
  f.refresh();
  assert.ok(findAll(f.win.el, i => i.text === t('ui.topic_chat_running')).length === 1);
  assert.ok(['research', 'expand', 'synthesize'].every(k => f.action(k).disabled));
  assert.equal(f.send().disabled, true);
  assert.equal(f.press('Enter'), true);
  assert.deepEqual(f.calls.submit, []);
  const modes = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-mode'));
  assert.ok(modes.every(b => b.disabled));
});

test('topic chat lists turns as plain text', () => {
  const f = fixture();
  f.session.turns = [{ role: 'user', kind: 'expand', text: '<b>x</b> **y**' }, { role: 'ai', text: 'done' }];
  f.refresh();
  const texts = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-text'));
  assert.deepEqual(texts.map(i => i.text), ['<b>x</b> **y**', 'done']);
  assert.ok(texts.every(i => i.children.length === 0));
  assert.ok(findAll(f.win.el, i => i.text === t('ui.topic_chat_you_0', t('ui.topic_chat_expand'))).length === 1);
});

test('topic chat reposition: right when it fits, left when not, bottom on a narrow area, and missing geometry is tolerated', () => {
  const rects = {};
  const f = fixture({ anchor: () => rects.value });
  rects.value = null;
  f.win.reposition();
  rects.value = { card: { left: 100, top: 50, right: 270, bottom: 120 }, area: { left: 0, top: 0, right: 1000, bottom: 600 } };
  f.win.reposition();
  assert.equal(f.win.el.style.left, '278px');
  assert.equal(f.win.el.style.top, '50px');
  rects.value = { card: { left: 700, top: 50, right: 870, bottom: 120 }, area: { left: 0, top: 0, right: 1000, bottom: 600 } };
  f.win.reposition();
  assert.equal(f.win.el.style.left, '352px');
  rects.value = { card: { left: 10, top: 50, right: 100, bottom: 120 }, area: { left: 0, top: 0, right: 300, bottom: 600 } };
  f.win.reposition();
  assert.ok(hasClass(f.win.el, 'is-bottom'));
  rects.value = { card: { left: 100, top: 50, right: 270, bottom: 120 }, area: { left: 0, top: 0, right: 1000, bottom: 600 } };
  f.win.reposition();
  assert.ok(!hasClass(f.win.el, 'is-bottom'));
});

test('topic chat destroy releases every listener and the host subscription', () => {
  const f = fixture();
  const all = findAll(f.win.el, () => true);
  f.win.destroy();
  assert.equal(f.watchers.length, 0);
  assert.ok(all.every(el => Object.values(el.listeners).every(list => list.length === 0)));
  assert.equal(f.root.children.includes(f.win.el), false);
});
