// Topic chat window (P1a): the component alone, driven through a fake host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, plain, DEFAULT_SETTINGS, fixture: repoFixture, withExpansionCoordinator, until, deferred, obsidian } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { element, find, findAll, byLabel, tick } = dom;

const { TopicChatWindow } = load('experiences/visual-map/topic-chat.ts', { obsidian });
const { t } = load('i18n.ts');
const hasClass = (item, name) => dom.hasCls(item, name);

function fixture({ anchor, submit, steer, stoppable } = {}) {
  const docListeners = {};
  const doc = { activeElement: null, listeners: docListeners,
    addEventListener(name, fn) { (docListeners[name] ??= []).push(fn); },
    removeEventListener(name, fn) { docListeners[name] = (docListeners[name] ?? []).filter(f => f !== fn); } };
  const root = element('div'); root.root = doc; root.ownerDocument = doc;
  const session = { turns: [], mode: 'quick', running: false, draftKind: null, draftText: '' };
  const watchers = [];
  const calls = { submit: [], steer: [], stop: 0, close: 0, modes: [], opener: 0 };
  const host = {
    topicTitle: () => 'Premise',
    anchor: anchor ?? (() => null),
    session: () => session,
    subscribe: fn => { watchers.push(fn); return () => { watchers.splice(watchers.indexOf(fn), 1); }; },
    setMode: mode => { calls.modes.push(mode); session.mode = mode; watchers.slice().forEach(fn => fn()); },
    setDraft: (kind, text) => { session.draftKind = kind; session.draftText = text; },
    submit: async (kind, text) => { calls.submit.push([kind, text]); return submit ? submit(kind, text) : true; },
    steer: text => { calls.steer.push(text); return steer ? steer(text) : true; },
    canStop: () => (stoppable ? stoppable() : true),
    stop: () => { calls.stop++; },
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
  const toggle = () => find(win.el, i => hasClass(i, 'vam-topic-chat-mode-toggle'));
  const menu = () => find(win.el, i => hasClass(i, 'vam-topic-chat-mode-menu'));
  const options = () => findAll(win.el, i => hasClass(i, 'vam-topic-chat-mode'));
  const outside = target => (docListeners.mousedown ?? []).slice().forEach(fn => fn({ target }));
  return { win, root, session, calls, input, action, send, type, press, refresh, watchers, doc, toggle, menu, options, outside };
}
const ghost = f => f.input.attrs.placeholder;

test('topic chat is a labelled dialog and the focus goes to the input', () => {
  const f = fixture();
  assert.equal(f.win.el.attrs.role, 'dialog');
  const label = find(f.win.el, i => i.attrs?.id && i.attrs.id === f.win.el.attrs['aria-labelledby']);
  assert.equal(label?.text, t('ui.topic_chat_label_0', 'Premise'));
  assert.equal(f.input.attrs['aria-labelledby'], f.win.el.attrs['aria-labelledby'], 'the input has the same label');
  assert.ok(hasClass(label, 'vam-sr-only'));
  assert.equal(f.win.el.attrs['aria-label'], undefined, 'no aria-label: Obsidian would show it as a tooltip over the hint line');
  assert.equal(f.input.attrs['aria-label'], undefined);
  assert.ok(byLabel(f.win.el, t('ui.topic_chat_close')) && byLabel(f.win.el, t('ui.topic_chat_send')), 'icon buttons keep their aria-label');
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

test('topic chat Tab is native when there is no grey text; typing without a button is an ask, empty text is never sent', async () => {
  const f = fixture();
  assert.equal(f.press('Tab'), false);
  f.type('   ');
  assert.equal(f.send().disabled, true, 'blank text cannot be sent');
  f.press('Enter');
  await dom.tick();
  assert.deepEqual(f.calls.submit, []);
  f.type('a free question');
  assert.equal(f.send().disabled, false);
  f.press('Enter');
  await dom.tick();
  assert.deepEqual(f.calls.submit, [['ask', 'a free question']]);
  assert.equal(f.input.value, '', 'a started ask clears the input');
  f.action('research').click();
  f.type('typed');
  assert.equal(f.press('Tab'), false, 'with typed text Tab stays native');
});

test('topic chat shows an AI answer to a question through the markdown whitelist and the question as plain text', () => {
  const f = fixture();
  f.session.turns = [{ role: 'user', kind: 'ask', text: '<b>why</b>' }, { role: 'ai', text: '**yes** <script>x</script>', markdown: true }];
  f.refresh();
  const texts = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-text'));
  assert.equal(texts[0].text, '<b>why</b>'); assert.equal(texts[0].children.length, 0);
  assert.ok(texts[1].children.length > 0, 'rendered by renderChatMarkdown');
  assert.equal(findAll(texts[1], i => i.tag === 'script').length, 0);
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

test('topic chat mode picker: an icon button opens a menu; picking sets the mode, closes the menu and updates the note', () => {
  const f = fixture();
  const toggle = f.toggle(), menu = f.menu();
  assert.equal(toggle.attrs['aria-haspopup'], 'menu');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(toggle.text, '', 'icon only');
  assert.equal(toggle.iconName, 'zap');
  assert.equal(toggle.attrs['aria-label'], t('ui.topic_chat_mode_button_0', t('ui.quick')));
  assert.equal(menu.attrs.role, 'menu');
  assert.equal(menu.attrs['aria-label'], t('ui.ai_mode'));
  assert.equal(menu.hidden, true);
  const [quick, standard] = f.options();
  assert.deepEqual([quick.attrs.role, standard.attrs.role], ['menuitemradio', 'menuitemradio']);
  assert.deepEqual([quick.attrs['aria-checked'], standard.attrs['aria-checked']], ['true', 'false']);
  assert.deepEqual(f.options().map(b => findAll(b, i => i.tag === 'span' && i.text).map(i => i.text)), [[t('ui.quick')], [t('ui.standard')]]);
  const note = find(f.win.el, i => i.attrs['aria-live'] === 'polite');
  assert.equal(note.text, t('ui.topic_chat_mode_quick_hint'));
  toggle.click();
  assert.equal(menu.hidden, false);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.notEqual(f.doc.activeElement, quick, 'a mouse click does not move the focus into the menu');
  standard.click();
  assert.deepEqual(f.calls.modes, ['standard']);
  assert.equal(menu.hidden, true);
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(f.doc.activeElement, toggle, 'the focus returns to the trigger');
  assert.equal(toggle.iconName, 'globe');
  assert.equal(toggle.attrs['aria-label'], t('ui.topic_chat_mode_button_0', t('ui.standard')));
  assert.deepEqual([quick.attrs['aria-checked'], standard.attrs['aria-checked']], ['false', 'true']);
  assert.equal(note.text, t('ui.topic_chat_mode_standard_hint'));
  toggle.click(); toggle.click();
  assert.equal(menu.hidden, true, 'the trigger toggles the menu');
});

test('topic chat mode picker keyboard: Enter/Space (detail 0) and arrows open on the current option, arrows cycle', () => {
  const f = fixture();
  const [quick, standard] = f.options();
  f.toggle().fire('click', { detail: 0 });
  assert.equal(f.menu().hidden, false);
  assert.equal(f.doc.activeElement, quick, 'the focus goes to the current option');
  f.menu().fire('keydown', { key: 'ArrowDown', target: quick });
  assert.equal(f.doc.activeElement, standard);
  f.menu().fire('keydown', { key: 'ArrowDown', target: standard });
  assert.equal(f.doc.activeElement, quick, 'wraps around');
  f.menu().fire('keydown', { key: 'ArrowUp', target: quick });
  assert.equal(f.doc.activeElement, standard, 'wraps backwards');
  f.session.mode = 'standard'; f.refresh();
  f.menu().hidden = true;
  f.toggle().fire('keydown', { key: 'ArrowUp' });
  assert.equal(f.menu().hidden, false);
  assert.equal(f.doc.activeElement, standard);
});

test('topic chat counterexample 1: Escape with the mode menu open only closes the menu; the next Escape closes the window', () => {
  const f = fixture();
  f.toggle().click();
  let stopped = false;
  f.win.el.fire('keydown', { key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(f.menu().hidden, true);
  assert.equal(f.calls.close, 0);
  assert.equal(f.calls.opener, 0);
  assert.equal(stopped, true);
  assert.equal(f.doc.activeElement, f.toggle());
  f.win.el.fire('keydown', { key: 'Escape' });
  assert.equal(f.calls.close, 1);
});

test('topic chat mode menu closes on a click outside (document) and when the focus leaves the picker', () => {
  const f = fixture();
  f.toggle().click();
  f.outside(f.options()[0]);
  assert.equal(f.menu().hidden, false, 'a press inside the picker keeps it open');
  f.outside(f.input);
  assert.equal(f.menu().hidden, true);
  f.toggle().click();
  f.win.el.fire('keydown', { key: 'x' });
  f.menu().parent.fire('focusout', { relatedTarget: f.input });
  assert.equal(f.menu().hidden, true, 'focus left the picker');
  f.toggle().click();
  f.menu().parent.fire('focusout', { relatedTarget: f.options()[1] });
  assert.equal(f.menu().hidden, false, 'focus moving inside the picker keeps it open');
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
  // Text in the box is an addition to the running task (A1), but never a new run, a task button or a mode change.
  assert.equal(f.send().disabled, false);
  f.type('');
  assert.equal(f.send().disabled, true, 'an empty box has nothing to add');
  assert.equal(f.press('Enter'), true);
  assert.deepEqual(f.calls.submit, []);
  assert.deepEqual(f.calls.steer, []);
  assert.ok(['research', 'expand', 'synthesize'].every(k => f.action(k).disabled));
  assert.ok(f.options().every(b => b.disabled));
  assert.equal(f.toggle().disabled, true);
});

test('topic chat steer A1/A2: while running a typed text enables send, Enter adds it, the box clears and the hint and placeholder change', () => {
  const f = fixture();
  f.session.running = true; f.refresh();
  const hint = () => find(f.win.el, i => hasClass(i, 'vam-topic-chat-mode-hint')).text;
  assert.equal(f.send().disabled, true);
  assert.equal(ghost(f), t('ui.map_chat_steer_placeholder'));
  assert.equal(hint(), t('ui.topic_chat_mode_quick_hint'), 'an empty box keeps the mode hint');
  f.type('add the code');
  assert.equal(f.send().disabled, false);
  assert.equal(hint(), t('ui.map_chat_steer_hint'));
  assert.equal(f.press('Enter'), true);
  assert.deepEqual(f.calls.steer, ['add the code']);
  assert.deepEqual(f.calls.submit, [], 'not a new run');
  assert.equal(f.input.value, ''); assert.equal(f.session.draftText, '');
  assert.equal(hint(), t('ui.topic_chat_mode_quick_hint'));
  f.type('more'); f.send().click();
  assert.deepEqual(f.calls.steer, ['add the code', 'more']);
  assert.ok(['research', 'expand', 'synthesize'].every(k => f.action(k).disabled));
  assert.equal(f.toggle().disabled, true);
});

test('topic chat steer: a refused addition stays in the box; a not running window still asks', async () => {
  const f = fixture({ steer: () => false });
  f.session.running = true; f.refresh();
  f.type('too late'); f.press('Enter');
  assert.deepEqual(f.calls.steer, ['too late']); assert.equal(f.input.value, 'too late'); assert.equal(f.session.draftText, 'too late');
  f.session.running = false; f.refresh();
  f.press('Enter'); await tick();
  assert.deepEqual(f.calls.submit, [['ask', 'too late']]); assert.equal(f.calls.steer.length, 1, 'idle goes through submit, not steer');
  assert.equal(ghost(f), t('ui.topic_chat_placeholder'));
});

test('topic chat steer A3: steer bubbles sit under their turn in typed order, live or queued, as plain text; setInputText writes the box', () => {
  const f = fixture();
  f.session.turns = [
    { role: 'user', kind: 'research', text: 'dig', steers: [{ text: 'first', state: 'live' }, { text: '<b>second</b>', state: 'queued' }] },
    { role: 'ai', text: 'done' }
  ];
  f.session.running = true; f.refresh();
  const bubbles = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-steer'));
  assert.equal(bubbles.length, 2);
  assert.equal(hasClass(bubbles[0], 'is-queued'), false); assert.equal(hasClass(bubbles[1], 'is-queued'), true);
  const tags = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-steer-tag')).map(i => i.text);
  assert.deepEqual(tags, [t('ui.map_chat_steer_tag_live'), t('ui.map_chat_steer_tag_queued')]);
  const texts = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-steer-text')).map(i => i.text);
  assert.deepEqual(texts, ['first', '<b>second</b>']);
  const rows = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-msg') || hasClass(i, 'vam-topic-chat-steer'));
  assert.ok(hasClass(rows[0], 'vam-topic-chat-msg') && hasClass(rows[1], 'vam-topic-chat-steer') && hasClass(rows[2], 'vam-topic-chat-steer') && hasClass(rows[3], 'vam-topic-chat-msg'));
  f.refresh(); assert.equal(f.input.value, '', 'a repaint never writes the box');
  f.win.setInputText('back'); assert.equal(f.input.value, 'back'); assert.equal(f.send().disabled, false);
});

test('topic chat counterexample 2b: when a run starts the open mode menu closes, the trigger is disabled and no mode is set', () => {
  const f = fixture();
  f.toggle().click();
  assert.equal(f.menu().hidden, false);
  f.session.running = true; f.refresh();
  assert.equal(f.menu().hidden, true);
  assert.equal(f.toggle().attrs['aria-expanded'], 'false');
  assert.equal(f.toggle().disabled, true);
  f.toggle().fire('click', { detail: 0 });
  assert.equal(f.menu().hidden, true, 'a disabled trigger cannot reopen it');
  f.options()[1].fire('click');
  assert.deepEqual(f.calls.modes, []);
});

test('topic chat counterexample 3: refresh with the mode menu open keeps it open, on the same option elements, without moving the focus', () => {
  const f = fixture();
  const before = f.options();
  f.toggle().fire('click', { detail: 0 });
  const focused = f.doc.activeElement;
  f.session.mode = 'standard'; f.refresh(); f.refresh();
  assert.equal(f.menu().hidden, false);
  assert.equal(f.doc.activeElement, focused);
  const after = f.options();
  assert.equal(after.length, 2);
  assert.ok(after.every((b, i) => b === before[i]), 'same elements');
  assert.equal(after[1].attrs['aria-checked'], 'true');
});

test('topic chat send button is an Enter icon without text; the keyboard still sends on Enter, not Shift+Enter or while composing', async () => {
  const f = fixture();
  assert.equal(f.send().iconName, 'corner-down-left');
  assert.equal(f.send().text, '');
  f.type('hello');
  assert.equal(f.press('Enter', { shiftKey: true }), false);
  assert.equal(f.press('Enter', { isComposing: true }), false);
  assert.deepEqual(f.calls.submit, []);
  assert.equal(f.press('Enter'), true);
  await dom.tick();
  assert.deepEqual(f.calls.submit, [['ask', 'hello']]);
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

test('topic chat side placement stops above the zoom/layout controls and ignores controls it does not share columns with', () => {
  const rects = {};
  const f = fixture({ anchor: () => rects.value });
  const area = { left: 0, top: 0, right: 1000, bottom: 800 };
  const controls = { left: 600, top: 750, right: 990, bottom: 790 };
  Object.defineProperty(f.win.el, 'offsetHeight', { value: 300, configurable: true });
  Object.defineProperty(f.win.el, 'offsetWidth', { value: 340, configurable: true });
  rects.value = { card: { left: 700, top: 700, right: 870, bottom: 760 }, area, controls };
  f.win.reposition();
  assert.equal(f.win.el.style.left, '352px');
  assert.equal(f.win.el.style.top, '442px', 'bottom edge sits 8px above the controls (750-8-300)');
  rects.value = { card: { left: 100, top: 700, right: 270, bottom: 760 }, area, controls: { ...controls, left: 700 } };
  f.win.reposition();
  assert.equal(f.win.el.style.top, '500px', 'controls in other columns do not push it up (800-300)');
});

test('topic chat window stays inside the canvas: a window taller than the space is capped (the log shrinks), side and bottom placement alike', () => {
  const rects = {};
  const f = fixture({ anchor: () => rects.value });
  const area = { left: 0, top: 0, right: 1000, bottom: 800 };
  Object.defineProperty(f.win.el, 'offsetHeight', { value: 1032, configurable: true });
  Object.defineProperty(f.win.el, 'offsetWidth', { value: 340, configurable: true });
  rects.value = { card: { left: 100, top: 300, right: 270, bottom: 360 }, area };
  f.win.reposition();
  assert.equal(f.win.el.style.top, '0px'); assert.equal(f.win.el.style['--vam-topic-chat-max'], '800px', 'cannot be taller than the canvas');
  rects.value = { card: { left: 100, top: 300, right: 270, bottom: 360 }, area, controls: { left: 0, top: 740, right: 990, bottom: 790 } };
  f.win.reposition();
  assert.equal(f.win.el.style['--vam-topic-chat-max'], '732px', 'stops 8px above the controls');
  rects.value = { card: { left: 10, top: 50, right: 100, bottom: 120 }, area: { left: 0, top: 0, right: 300, bottom: 600 } };
  f.win.reposition();
  assert.ok(hasClass(f.win.el, 'is-bottom')); assert.equal(f.win.el.style['--vam-topic-chat-max'], '584px', 'bottom placement keeps its 8px margins');
});

test('topic chat places the window again and scrolls the log to the newest turn whenever the session changes', () => {
  let anchors = 0;
  const f = fixture({ anchor: () => { anchors++; return { card: { left: 100, top: 50, right: 270, bottom: 120 }, area: { left: 0, top: 0, right: 1000, bottom: 600 } }; } });
  const log = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-log'))[0];
  Object.defineProperty(log, 'scrollHeight', { value: 5000, configurable: true });
  log.scrollTop = 0;
  const before = anchors;
  f.session.turns = [{ role: 'user', kind: 'ask', text: 'q' }, { role: 'ai', text: 'a' }];
  f.refresh();
  assert.ok(anchors > before, 'content changed, so the window is placed again');
  assert.equal(log.scrollTop, 5000);
});

test('topic chat mount after a repaint (window taken out and put back) scrolls the log to the end; a mount that moves nothing leaves the scroll where the reader put it', () => {
  const f = fixture();
  const log = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-log'))[0];
  Object.defineProperty(log, 'scrollHeight', { value: 5000, configurable: true });
  log.scrollTop = 120;
  f.win.mount(f.root, false);
  assert.equal(log.scrollTop, 120, 'still in the parent: nothing moved, nothing scrolled');
  f.win.el.remove(); log.scrollTop = 0;
  f.win.mount(f.root, false);
  assert.equal(log.scrollTop, 5000, 're-attached: the browser reset the scroll, so it goes back to the newest turn');
});

test('topic chat lifts its overlay above the controls overlay while mounted and drops it on destroy (class + CSS string check)', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.has-topic-chat\.vam-canvas-overlay\s*\{[^}]*z-index:\s*5/);
  const f = fixture();
  assert.ok(hasClass(f.root, 'has-topic-chat'));
  f.win.destroy();
  assert.ok(!hasClass(f.root, 'has-topic-chat'));
});

test('topic chat send key is accent-filled when it can send, with a selector that outweighs the app button rule', () => {
  const lines = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').split('\n');
  // Obsidian's `button:not(.clickable-icon)` is (0,1,1) and sets the grey fill; a bare class is (0,1,0) and loses to it.
  const ready = lines.find(line => line.startsWith('.vam-topic-chat-foot button.vam-topic-chat-send:not(:disabled) {')) ?? '';
  assert.match(ready, /background: var\(--interactive-accent\)/);
  assert.match(ready, /color: var\(--text-on-accent\)/);
  const base = lines.find(line => line.startsWith('.vam-topic-chat-send {')) ?? '';
  assert.doesNotMatch(base, /background|[; ]color:/, 'a disabled key keeps the grey fill');
});

test('topic chat counterexample 5: the grey text shows with no Tab label on screen, and Tab still adopts it', () => {
  const f = fixture();
  f.action('expand').click();
  assert.equal(findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-tab')).length, 0);
  assert.equal(findAll(f.win.el, i => /Tab/.test(i.text)).length, 0, 'no Tab label anywhere');
  const ghostEl = find(f.win.el, i => hasClass(i, 'vam-topic-chat-ghost'));
  const text = find(ghostEl, i => hasClass(i, 'vam-topic-chat-ph'));
  assert.equal(text.text, t('ui.topic_chat_suggest_expand'));
  assert.equal(ghostEl.hidden, false);
  assert.ok(find(f.win.el, i => hasClass(i, 'vam-topic-chat-composer')).children.includes(ghostEl));
  assert.equal(f.press('Tab'), true);
  assert.equal(f.input.value, t('ui.topic_chat_suggest_expand'));
  assert.equal(ghostEl.hidden, true, 'adopted: the grey line goes away');
});

test('topic chat destroy releases every listener and the host subscription', () => {
  const f = fixture();
  const all = findAll(f.win.el, () => true);
  f.win.destroy();
  assert.equal(f.watchers.length, 0);
  assert.ok(all.every(el => Object.values(el.listeners).every(list => list.length === 0)));
  assert.ok(Object.values(f.doc.listeners).every(list => list.length === 0), 'counterexample 4: the document listener is removed too');
  assert.equal(f.root.children.includes(f.win.el), false);
});


// ---- the view: entries, submit, background -------------------------------------------------------------------------

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const outlineApi = load('experiences/visual-map/outline-import.ts', { obsidian });
const { chatSynthesisOptions } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, MarkdownView: class {} } });
class MarkdownView {}

function page() {
  const doc = { activeElement: null };
  const rootEl = element('div'); rootEl.root = doc; rootEl.ownerDocument = doc;
  return { doc, root: rootEl };
}

/** A trimmed copy of the map-chat harness: the real view and repository, a fake render() that repaints the overlay like render() does. */
async function harness() {
  const { repo, app, files } = repoFixture('en');
  app.vault.configDir = '.obsidian';
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'claude:sonnet' };
  repo.settings = settings;
  const mapDoc = { id: 'map-a', title: 'Sleep map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const ids = {};
  const add = async (key, title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', 'Sleep'); await add('a', 'Body', 'root'); await add('b', 'Mind', 'root'); await add('c', 'REM', 'a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [];
  const control = { usageAsks: 0, decline: false, nested: 0, depth: 0, modals: [] };
  let queue = Promise.resolve();
  const ctx = {};
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), views: () => [], logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), closeStaleDetails() {}, releaseOutline() {}, syncOutline() {}, setOutlineActive() {},
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), detailsShown: () => false, activeTasks: new Map(), quickExpandPending: new Set(), recordFailure: error => String(error?.message ?? error),
    mutate(work) {
      control.depth > 0 && control.nested++;
      const result = queue.then(async () => { control.depth++; try { await work(); await ctx.view?.hydrate(); } finally { control.depth--; } });
      queue = result.catch(() => {});
      return result;
    },
    saveSettings: async () => {}, modelLabel: model => String(model),
    aiReadyForModel: async () => true,
    confirmAiUsage: async (model, run) => { control.usageAsks++; if (control.decline) return false; await run(); return true; },
    manifest: { version: '9.9.9' }
  });
  app.workspace = { getLeavesOfType: () => [], getActiveViewOfType: () => null, requestSaveLayout() {}, on() { return {}; } };
  const Notice = dom.makeNotice(notices);
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, MarkdownView, Notice, Modal: class { constructor(a) { this.app = a; } open() { control.modals.push(this); } close() {} }, Component: class { load() {} unload() {} } } }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {}, createFragment: dom.createFragment, CSS: { escape: v => String(v) } });
  const view = new VisualAgentMapView({ app }, plugin);
  ctx.view = view;
  const p = page();
  Object.assign(view, { path: MAP, contentEl: p.root, focusNode() {}, fit() {}, closed: false });
  view.map = await repo.readMap(MAP);
  const reload = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.hydrate = reload;
  let overlay = null;
  // What render() does around the topic chat window: take it out first, put it into the new overlay last.
  const repaint = () => {
    const held = view.detachTopicChat();
    p.root.empty(); overlay = p.root.createDiv('vam-canvas-overlay'); overlay.ownerDocument = p.doc;
    view.remountTopicChat(held);
  };
  view.render = () => { repaint(); };
  await reload(); repaint();
  const h = {
    repo, files, app, view, plugin, ids, control, notices, Notice, page: p, repaint, overlay: () => overlay,
    node: key => view.map.nodes.find(n => n.id === ids[key]),
    saved: async () => (await repo.readMap(MAP)).nodes,
    entry: key => view.topicChatSessions.get(ids[key]),
    // Everything below the root's direct subtopics goes (in memory): these tests are about a subtree one level deep, which has no depth card.
    flatten: () => { view.map.nodes = view.map.nodes.filter(n => !n.parentId || n.parentId === ids.root); },
    host: key => view.topicChatHost(h.entry(key) ?? (view.openTopicChat(h.node(key)), h.entry(key))),
    win: () => view.topicChatOpen?.win,
    texts: () => findAll(h.win().el, () => true).map(i => i.text).join('|')
  };
  return h;
}
const outlineOf = markdown => ({ markdown, nodes: outlineApi.parseOutline(markdown).nodes });
const waitFor = async predicate => { for (let i = 0; i < 800; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('condition not reached'); };
const finished = h => waitFor(() => h.plugin.running.size === 0 && h.plugin.activeTasks.size === 0 && !h.entry('a').session.running);
// Subtopics that count as researched, so a synthesis goes straight to the integration.
const researched = async h => { const load0 = h.view.hydrate; h.view.hydrate = async () => { await load0(); for (const note of h.view.notes.values()) note.status = 'completed'; }; await h.view.hydrate(); };
const stubResearch = h => {
  const calls = [];
  h.view.runAgent = async (node, done, failed, request, accepted) => {
    const call = { node, request, done, failed, gate: deferred() };
    calls.push(call); accepted?.();
    return { finished: call.gate.promise };
  };
  h.view.detailTemplateFor = async () => undefined;
  return calls;
};

integrationTest('topic chat counterexample 7: openTopicChat does not open while notes load, in presentation or on a locked topic', async () => {
  const h = await harness();
  h.view.noteLoad = {}; h.view.openTopicChat(h.node('a')); assert.equal(h.win(), undefined, 'notes loading');
  h.view.noteLoad = null; h.view.presentation = {}; h.view.openTopicChat(h.node('a')); assert.equal(h.win(), undefined, 'presentation');
  h.view.presentation = null;
  h.view.notes.get(h.ids.a).aiLocked = true; h.view.openTopicChat(h.node('a'));
  assert.equal(h.win(), undefined, 'AI lock'); assert.equal(h.notices.at(-1), t('ui.ai_locked_notice'));
  h.view.notes.get(h.ids.a).aiLocked = false; h.view.openTopicChat(h.node('a'));
  assert.ok(h.win(), 'a plain topic opens'); assert.ok(find(h.overlay(), i => hasClass(i, 'vam-topic-chat')), 'in the canvas overlay');
});

integrationTest('topic chat counterexample 7: the card menu and the command offer AI explore and open the topic chat', async () => {
  const item = () => { const it = { setTitle(title) { it.title = title; return it; }, setIcon() { return it; }, setSection() { return it; }, setDisabled() { return it; }, onClick(fn) { it.fn = fn; return it; } }; return it; };
  const menuOf = (h) => { const items = []; return { items, menu: { addItem(cb) { const it = item(); cb(it); items.push(it); return this; }, addSeparator() { return this; } } }; };
  const h = await harness();
  const m = menuOf(h); h.view.addCardMenuActions(m.menu, h.node('a'));
  const entry = m.items.find(i => i.title === t('ui.ai_explore'));
  assert.ok(entry, 'the plain map has the menu entry'); entry.fn();
  assert.equal(h.view.topicChatOpen?.entry.nodeId, h.ids.a, 'the right-click entry opens the topic chat');
  h.view.closeTopicChatWindow();
  h.view.selection.setSelected(h.ids.b);
  assert.equal(h.view.mapCommand('ai-explore', false), true);
  assert.equal(h.view.topicChatOpen?.entry.nodeId, h.ids.b, 'the command opens the topic chat');
});

integrationTest('topic chat entries: the empty suggestion panel and the card tool open the topic chat; no entry opens the old dialog', async () => {
  const h = await harness();
  const panel = element('div'); panel.root = h.page.doc;
  h.view.renderPendingProposals(panel, h.node('c'), h.view.notes.get(h.ids.c), () => {});
  const open = find(panel, i => i.tag === 'button' && i.text === t('ui.ai_explore')); assert.ok(open, 'the empty panel has the button');
  const before = h.view.topicChatOpen; assert.equal(before?.entry.nodeId, undefined, 'no window before the click'); open.click();
  assert.equal(h.view.topicChatOpen?.entry.nodeId, h.ids.c, 'the panel button opens the topic chat');
  // The card tool is built by renderNode, which needs the full page; its source is checked instead (the tester sees the real button).
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const sites = [...source.matchAll(/t\("ui\.ai_explore"\)/g)].map(m => source.slice(m.index, m.index + 170));
  assert.ok(sites.length >= 3); assert.ok(sites.every(site => site.includes('openTopicChat') && !/NextStep|Modal/.test(site)), sites.join('\n'));
});

integrationTest('topic chat opens one window at a time: opening B closes A, A keeps its conversation, a repaint keeps the window and its draft', async () => {
  const h = await harness();
  const a = h.host('a'); a.setDraft('expand', 'my draft');
  const first = h.win(); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a);
  h.repaint(); assert.equal(h.win(), first); assert.ok(h.overlay().children.includes(first.el), 'put into the new overlay');
  assert.equal(h.entry('a').session.draftText, 'my draft');
  h.view.openTopicChat(h.node('b'));
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.b); assert.equal(h.overlay().children.filter(i => hasClass(i, 'vam-topic-chat')).length, 1);
  assert.equal(h.entry('a').session.draftText, 'my draft', 'A kept its draft');
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.b); h.repaint();
  assert.equal(h.win(), undefined, 'the window closes when its topic is gone');
  h.view.openTopicChat(h.node('a')); await h.view.onClose();
  assert.equal(h.win(), undefined); assert.equal(h.view.topicChatSessions.size, 0, 'view close releases the sessions');
});

integrationTest('topic chat counterexample 1: Standard integration is not Local (web search on), Quick is Local; the sidebar integration stays Local', async () => {
  const h = await harness(); h.flatten(); const seen = []; await researched(h);
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { seen.push({ id: node.id, options, direction, observer }); accepted(); };
  const host = h.host('root');
  host.setMode('standard');
  assert.equal(await host.submit('synthesize', 'Integrate sleep'), true);
  host.setMode('quick');
  await waitFor(() => !h.entry('root').session.running);
  assert.equal(await host.submit('synthesize', 'Again'), true);
  await waitFor(() => seen.length === 2 && !h.entry('root').session.running);
  assert.equal(seen[0].options.researchMode, 'research'); assert.equal(seen[1].options.researchMode, 'local');
  assert.equal(seen[0].direction, 'Integrate sleep');
  assert.equal(seen[0].options.visualMode, 'off'); assert.equal(seen[0].options.researchDepth, 'normal'); assert.deepEqual(plain(seen[0].options.referenceGroups), []);
  assert.equal(h.view.map.aiMode, undefined, 'an integration does not remember the mode on the map (only research and expand do)');
  assert.equal(chatSynthesisOptions({ outputLanguage: 'en' }).researchMode, 'local', 'the sidebar integration is still Quick');
  // The task service turns the Standard value into a web search, Quick into none.
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const [mode, web] of [['research', true], ['local', false]]) {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    let call; plugin.claudeCli = () => ({ runTask: async (...args) => { call = args; return JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] }); } });
    await plugin.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'x', ancestors: '', mode: 'synthesize', researchMode: mode, researchDepth: 'normal', visualMode: 'off' }, 'claude:sonnet', 'low');
    assert.equal(call[4].webSearch, web, mode);
  }
});

integrationTest('topic chat integration: a written result reaches the window even though the observer says closed; a topic without subtopics answers at once without a usage question', async () => {
  const h = await harness(); h.flatten(); await researched(h);
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { accepted(); observer.onWritten(); };
  const host = h.host('root');
  await host.submit('synthesize', 'x'); await waitFor(() => !h.entry('root').session.running);
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_synthesis_done_0', 2));
  const asks = h.control.usageAsks;
  const leaf = h.host('b');
  assert.equal(await leaf.submit('synthesize', 'x'), true);
  assert.equal(h.control.usageAsks, asks, 'no usage question');
  assert.equal(h.entry('b').session.turns.at(-1).text, t('ui.topic_chat_no_children'));
});

integrationTest('topic chat counterexample 4: expand makes the subtopics at once - no dialog, no proposal step, one undo step, one sentence with the titles', async () => {
  const h = await harness();
  h.view.proposeChildren = () => assert.fail('the guided proposal path is not used'); h.view.openChildSuggestions = () => assert.fail('no review window');
  h.plugin.outlineGeneration = { generate: async () => outlineOf('# Body\n## Light\n## Noise\n## Heat') };
  await h.view.aiModeMemory().rememberAiMode('quick'); // an unchanged mode adds no undo step of its own
  const before = (await h.saved()).length; const steps = h.view.history.past.length;
  const host = h.host('a');
  assert.equal(await host.submit('expand', 'split by cause'), true);
  await finished(h).catch(e => { throw new Error(e.message + JSON.stringify([h.notices, h.entry('a').session, [...h.plugin.running]])); });
  const created = (await h.saved()).length - before;
  assert.equal(created, 3, 'created directly');
  assert.equal(h.control.modals.length, 0, 'no modal');
  assert.equal(h.view.history.past.length, steps + 1, 'one undo step');
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_expand_done_0_1', 3, ['Light', 'Noise', 'Heat'].join(t('ui.list_separator'))));
  assert.equal(h.entry('a').session.turns[0].kind, 'expand');
  await h.plugin.mutate(() => h.view.travel(false));
  assert.equal((await h.saved()).length, before, 'one undo removes all of them');
});

integrationTest('topic chat counterexample 5: closing the window does not stop the task; the result lands in the conversation and a Notice tells it; reopening shows it', async () => {
  const h = await harness(); const gate = deferred(); let signal;
  h.plugin.outlineGeneration = { generate: async (_r, s) => { signal = s; await gate.promise; return outlineOf('# Body\n## Light'); } };
  const host = h.host('a');
  await host.submit('expand', 'x');
  await waitFor(() => signal);
  host.close(); assert.equal(h.win(), undefined, 'closed');
  assert.equal(signal.aborted, false, 'closing does not abort'); assert.equal(h.entry('a').session.running, true);
  gate.resolve(); await finished(h);
  const sentence = t('ui.topic_chat_expand_done_0_1', 1, 'Light');
  assert.equal(h.entry('a').session.turns.at(-1).text, sentence);
  assert.ok(h.notices.includes(sentence), 'the Notice tells the result');
  h.view.openTopicChat(h.node('a')); assert.ok(h.texts().includes(sentence), 'visible after reopening');
});

integrationTest('topic chat research: Quick is local without charts, Standard searches the web; a result with the window closed goes through the usual completed Notice; stop says stopped', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const host = h.host('a');
  host.setMode('standard'); await host.submit('research', 'dig deeper');
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].request.researchMode, 'research'); assert.equal(calls[0].request.addCharts, true); assert.match(calls[0].request.task, /dig deeper$/);
  host.close();
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.ok(h.notices.some(n => n.includes('Body')), 'completed Notice: ' + h.notices.join('|'));
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'));
  h.view.openTopicChat(h.node('a')); host.setMode('quick'); await host.submit('research', 'again');
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].request.researchMode, 'local'); assert.equal(calls[1].request.addCharts, false);
  calls[1].failed(t('ui.research_stopped_existing_content_was_preserved')); calls[1].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_stopped'));
  // A Quick result that lacks knowledge, with the window closed, also offers the Standard run; a Standard one does not.
  h.view.openTopicChat(h.node('a')); host.setMode('standard'); await host.submit('research', 'std gap');
  await waitFor(() => calls.length === 3); host.close();
  calls[2].done({ summary: 'S', detail: 'Note: model knowledge is insufficient here.' }); calls[2].gate.resolve(); await finished(h);
  assert.ok(!h.Notice.all.flatMap(n => n.actions ?? []).some(b => b.text === t('ui.rerun_standard')), 'Standard gap does not offer the Standard run');
  h.view.openTopicChat(h.node('a')); host.setMode('quick'); await host.submit('research', 'third');
  await waitFor(() => calls.length === 4); host.close();
  calls[3].done({ summary: 'S', detail: 'Note: model knowledge is insufficient here.' }); calls[3].gate.resolve(); await finished(h);
  assert.ok(h.Notice.all.flatMap(n => n.actions ?? []).some(b => b.text === t('ui.rerun_standard')), 'Quick gap offers the Standard run');
});

integrationTest('topic chat busy topic: submit is refused with a Notice and nothing starts', async () => {
  const h = await harness(); const calls = stubResearch(h);
  h.plugin.quickExpandPending.add(h.node('a').path);
  assert.equal(await h.host('a').submit('research', 'x'), false);
  h.plugin.quickExpandPending.clear(); h.view.startingTasks.set(h.node('a').path, new AbortController());
  assert.equal(await h.host('a').submit('research', 'x'), false);
  h.view.startingTasks.clear(); h.view.synthesisTasks.set(h.node('a').path, { state: 'running' });
  assert.equal(await h.host('a').submit('research', 'x'), false);
  assert.equal(calls.length, 0); assert.equal(h.control.usageAsks, 0); assert.equal(h.notices.at(-1), t('ui.ai_running_ai'));
});

integrationTest('topic chat counterexample 8: a declined usage question starts nothing and the typed text stays in the window', async () => {
  const h = await harness(); const calls = stubResearch(h); let generated = 0; let synthesized = 0;
  h.plugin.outlineGeneration = { generate: async () => { generated++; return outlineOf('# Body\n## X'); } };
  h.view.startSynthesis = async () => { synthesized++; };
  h.control.decline = true;
  const host = h.host('a');
  for (const kind of ['research', 'expand', 'synthesize']) assert.equal(await host.submit(kind, 'go'), false, kind);
  assert.deepEqual([calls.length, generated, synthesized], [0, 0, 0]);
  assert.equal(h.entry('a').session.running, false); assert.equal(h.entry('a').session.turns.length, 0);
  assert.equal(h.plugin.running.size, 0); assert.equal(h.plugin.activeTasks.size, 0);
  // Through the real window: the text and the pressed button stay.
  const win = h.win(); const input = find(win.el, i => i.tag === 'textarea');
  find(win.el, i => i.tag === 'button' && i.text === t('ui.topic_chat_research')).click();
  input.value = 'dig deeper'; input.input();
  byLabel(win.el, t('ui.topic_chat_send')).click(); await tick(); await tick();
  assert.equal(input.value, 'dig deeper'); assert.equal(h.entry('a').session.draftKind, 'research');
  assert.equal(calls.length, 0);
});

// ---- P2: records on disk --------------------------------------------------------------------------------------------

const records = load('core/topic-chat-records.ts');
const chatRecords = load('core/map-chat-records.ts');
const vaultFiles = h => [...h.files.values()].filter(f => f instanceof obsidian.TFile);
const topicPath = (h, key, id) => `${h.repo.topicRoot(MAP)}/Chats/topics/${id ?? h.ids[key]}.jsonl`;
const topicText = async (h, key, id) => { const p = topicPath(h, key, id); return (await h.repo.app.vault.adapter.exists(p)) ? h.repo.app.vault.adapter.read(p) : null; };
const topicLines = async (h, key, id) => { await h.view.topicChatRecords?.idle(); const text = await topicText(h, key, id); return text === null ? null : text.split('\n').filter(Boolean).map(l => JSON.parse(l)); };
const settled = h => waitFor(() => h.plugin.running.size === 0 && h.plugin.activeTasks.size === 0 && !h.view.topicChatSessions.get(h.ids.a)?.session.running);

test('topic chat record format: path whitelist, cut last line, broken lines, unknown version, pairing', () => {
  assert.equal(records.isSafeTopicNodeId('abc_DEF-1'), true);
  for (const bad of ['', 'a/b', '..', '../x', 'a.b', 'x'.repeat(65), 'a b', 7, null]) assert.equal(records.isSafeTopicNodeId(bad), false, String(bad));
  assert.equal(records.topicChatPath('Agent Workspace/Topics/m', 'n1'), 'Agent Workspace/Topics/m/Chats/topics/n1.jsonl');
  assert.throws(() => records.topicChatPath('Agent Workspace/Topics/m', '../n1'));
  assert.throws(() => records.topicChatPath('../m', 'n1'));
  const turn = { type: 'turn', id: 't1', at: '2026-11-08T00:00:00.000Z', kind: 'research', mode: 'quick', message: 'hi' };
  const result = { type: 'result', id: 't1', at: '2026-11-08T00:00:01.000Z', status: 'done', text: 'ok' };
  const text = records.serializeTopicChatLine(turn) + records.serializeTopicChatLine(result);
  assert.deepEqual(Object.keys(JSON.parse(text.split('\n')[0]))[0], 'v');
  // A cut last line and a broken line are skipped; the rest is read.
  const damaged = text + 'not json\n' + '{"v":1,"type":"turn","id":"x","at":"a","kind":"bogus","mode":"quick","message":"m"}\n' + '{"v":1,"type":"result","id":"t2","at":"a","sta';
  const parsed = records.parseTopicChat(damaged);
  assert.equal(parsed.lines.length, 2); assert.equal(parsed.skipped, 3); assert.equal(parsed.cleanEnd, false); assert.equal(parsed.unrecoverable, false);
  assert.equal(records.parseTopicChat(text).cleanEnd, true);
  assert.equal(records.parseTopicChat(text + '{"v":2,"type":"turn"}\n').unrecoverable, true);
  const restored = records.restoreTopicChat(parsed.lines.concat([{ ...turn, id: 't3' }, { ...result, id: 'orphan' }]));
  assert.deepEqual(plain(restored.map(r => [r.id, r.result?.text ?? null])), [['t1', 'ok'], ['t3', null]]);
});

integrationTest('topic chat counterexample 5 (reload): the conversation is saved and comes back after the sessions are gone', async () => {
  const h = await harness(); h.view.plugin.settings.mapChatRecords = false; // saved whatever the sidebar switch says
  h.plugin.outlineGeneration = { generate: async () => outlineOf('# Body\n## Light') };
  const host = h.host('a'); await host.submit('expand', 'split by cause'); await finished(h);
  const lines = await topicLines(h, 'a');
  assert.deepEqual(plain(lines.map(l => [l.v, l.type])), [[1, 'turn'], [1, 'result']]);
  assert.equal(lines[0].kind, 'expand'); assert.equal(lines[0].mode, 'quick'); assert.equal(lines[0].message, 'split by cause');
  assert.equal(lines[1].id, lines[0].id); assert.equal(lines[1].status, 'done');
  assert.equal(lines[1].text, t('ui.topic_chat_expand_done_0_1', 1, 'Light'));
  assert.ok(!JSON.stringify(lines).includes('prompt'), 'no prompt or context stored');
  // Reload: a new session for the same topic reads the file back.
  h.view.closeTopicChatWindow(); h.view.topicChatSessions.clear();
  h.view.openTopicChat(h.node('a'));
  await waitFor(() => h.entry('a').session.turns.length === 2);
  assert.deepEqual(plain(h.entry('a').session.turns.map(x => [x.role, x.text])), [['user', 'split by cause'], ['ai', t('ui.topic_chat_expand_done_0_1', 1, 'Light')]]);
  assert.ok(h.texts().includes('split by cause'), 'the window shows it');
});

integrationTest('topic chat counterexample 6: the sidebar switch count and delete leave Chats/topics alone; the sidebar record has no topic chat turn', async () => {
  const { turnMapChatRecordsOff } = load('ui/modals/map-chat-records-off-modal.ts', { obsidian });
  const h = await harness(); const calls = stubResearch(h);
  await h.host('a').submit('research', 'dig'); await waitFor(() => calls.length === 1);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal((await topicLines(h, 'a')).length, 2);
  const file = topicPath(h, 'a');
  assert.equal(chatRecords.isRecordFilePath(file), false); assert.equal(records.isTopicChatFilePath(file), true);
  assert.equal(chatRecords.isRecordFilePath(`${h.repo.topicRoot(MAP)}/Chats/records/20261108-000000-abcdef.jsonl`), true);
  assert.equal(records.isTopicChatFilePath(`${h.repo.topicRoot(MAP)}/Chats/records/20261108-000000-abcdef.jsonl`), false);
  assert.deepEqual(chatRecords.recordFilesIn(vaultFiles(h)).map(f => f.path), []);
  let asked = 0; const trashed = [];
  const app = { vault: Object.assign(Object.create(h.repo.app.vault), { getFiles: () => vaultFiles(h) }), fileManager: { trashFile: async f => { trashed.push(f.path); } } };
  const res = await turnMapChatRecordsOff({ app, writers: [], ask: async () => { asked++; return true; } });
  assert.deepEqual([res.deleted, res.failed, asked, trashed.length], [0, 0, 0, 0], 'nothing counted, nothing deleted');
  assert.ok(await topicText(h, 'a'), 'the topic chat file is still there');
  assert.equal(h.view.chatRecords, null, 'the sidebar writer was never made by a topic chat');
});

integrationTest('topic chat counterexample 9: a node id with a slash or dots writes no file, the conversation stays in memory', async () => {
  for (const bad of ['../evil', 'a/b', '..']) {
    const h = await harness(); const calls = stubResearch(h);
    const target = h.node('a'); h.view.openTopicChat(target);
    const entry = h.entry('a'); entry.nodeId = bad; // the id the records are keyed by
    const went = await h.view.submitTopicChat(entry, target, 'research', 'x'); assert.equal(went, true, JSON.stringify(h.notices)); await waitFor(() => calls.length === 1);
    calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
    await waitFor(() => !entry.session.running);
    await h.view.topicChatRecords.idle();
    assert.equal(entry.session.turns.length, 2, 'kept in memory');
    const stray = [...h.files.keys()].filter(p => p.includes('/Chats/'));
    assert.deepEqual(plain(stray), [], bad);
  }
});

integrationTest('topic chat late result: a view that closed meanwhile is not written to (no sentence in the session, no result line), and reopening says the result is unknown', async () => {
  const h = await harness(); const gate = deferred();
  h.plugin.outlineGeneration = { generate: async () => { await gate.promise; return outlineOf('# Body\n## Light'); } };
  const host = h.host('a'); await host.submit('expand', 'x');
  const turns = h.entry('a').session.turns.length;
  h.view.closed = true; gate.resolve();
  await waitFor(() => h.plugin.running.size === 0 && !h.entry('a').session.running);
  assert.equal(h.entry('a').session.turns.length, turns, 'no sentence written after the view closed');
  assert.deepEqual(plain((await topicLines(h, 'a')).map(l => l.type)), ['turn'], 'the turn is saved, the result is not');
  h.view.closed = false; h.view.closeTopicChatWindow(); h.view.topicChatSessions.clear(); h.view.openTopicChat(h.node('a'));
  await waitFor(() => h.entry('a').session.turns.length === 2);
  assert.deepEqual(plain(h.entry('a').session.turns.map(x => x.text)), ['x', t('ui.topic_chat_result_unknown')]);
});

integrationTest('topic chat record writer: a cut file gets a line break first, another schema version is never written, a failure notices once, a disposed writer writes nothing', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const p = topicPath(h, 'a'); await h.repo.ensureTopicFolders?.(h.repo.topicRoot(MAP));
  await h.repo.app.vault.createFolder(`${h.repo.topicRoot(MAP)}/Chats`).catch(() => {}); await h.repo.app.vault.createFolder(`${h.repo.topicRoot(MAP)}/Chats/topics`).catch(() => {});
  const cut = records.serializeTopicChatLine({ type: 'turn', id: 'old', at: 'a', kind: 'research', mode: 'quick', message: 'older' }) + '{"v":1,"type":"res';
  await h.repo.app.vault.create(p, cut);
  await h.host('a').submit('research', 'new'); await waitFor(() => calls.length === 1);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  await h.view.topicChatWriter().idle(); const parsed = records.parseTopicChat(await topicText(h, 'a'));
  assert.deepEqual(plain(parsed.lines.map(l => [l.type, l.id === 'old' ? 'old' : 'new'])), [['turn', 'old'], ['turn', 'new'], ['result', 'new']]);
  // Unknown version: untouched.
  const h2 = await harness(); const calls2 = stubResearch(h2);
  await h2.repo.app.vault.createFolder(`${h2.repo.topicRoot(MAP)}/Chats`).catch(() => {}); await h2.repo.app.vault.createFolder(`${h2.repo.topicRoot(MAP)}/Chats/topics`).catch(() => {});
  const future = '{"v":2,"type":"turn","x":1}\n'; await h2.repo.app.vault.create(topicPath(h2, 'a'), future);
  await h2.host('a').submit('research', 'new'); await waitFor(() => calls2.length === 1);
  calls2[0].done({ summary: 'S', detail: 'D' }); calls2[0].gate.resolve(); await finished(h2); await h2.view.topicChatWriter().idle();
  assert.equal(await topicText(h2, 'a'), future, 'not overwritten, not appended to');
  assert.equal(h2.entry('a').session.turns.length, 2, 'the chat itself goes on');
  // Failure: one Notice for several writes.
  const h3 = await harness(); const calls3 = stubResearch(h3);
  h3.repo.app.vault.create = async () => { throw new Error('disk busy'); };
  await h3.host('a').submit('research', 'z'); await waitFor(() => calls3.length === 1);
  calls3[0].done({ summary: 'S', detail: 'D' }); calls3[0].gate.resolve(); await finished(h3); await h3.view.topicChatWriter().idle();
  assert.equal(h3.notices.filter(n => n === t('ui.topic_chat_record_failed')).length, 1);
  // Closed or disposed writers take no line.
  const h4 = await harness(); const w = h4.view.topicChatWriter(); w.dispose();
  w.write(h4.repo.topicRoot(MAP), 'abc', { type: 'turn', id: 'q', at: 'a', kind: 'research', mode: 'quick', message: 'm' }); await w.idle();
  assert.equal(await topicText(h4, null, 'abc'), null);
});

integrationTest('topic chat synthesize researches only idea or error subtopics first (same mode), then integrates; the sentence says so', async () => {
  const h = await harness(); h.flatten(); const calls = stubResearch(h); const seen = [];
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { seen.push(node.id); accepted(); observer.onWritten(); };
  const statuses = { a: 'completed', b: 'error' }; const load0 = h.view.hydrate;
  h.view.hydrate = async () => { await load0(); for (const [k, v] of Object.entries(statuses)) h.view.notes.get(h.ids[k]).status = v; };
  await h.view.hydrate();
  const host = h.host('root'); host.setMode('standard');
  await host.submit('synthesize', 'all'); await waitFor(() => calls.length === 1);
  assert.equal(calls[0].node.id, h.ids.b, 'only the unresearched subtopic'); assert.equal(calls[0].request.researchMode, 'research');
  assert.equal(seen.length, 0, 'integration waits for the research');
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
  await waitFor(() => !h.entry('root').session.running);
  assert.deepEqual(seen, [h.ids.root]);
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_synthesis_researched_first_0_1', 1, 2));
  assert.equal(h.view.selection.selectedId ?? null, null, 'selection untouched');
  // Nothing to research: straight to the integration with the plain sentence.
  statuses.b = 'completed'; await h.view.hydrate(); calls.length = 0;
  await host.submit('synthesize', 'again'); await waitFor(() => !h.entry('root').session.running && seen.length === 2);
  assert.equal(calls.length, 0); assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_synthesis_done_0', 2));
});

integrationTest('topic chat synthesize: when every subtopic research fails the integration does not start and one sentence says so', async () => {
  const h = await harness(); h.flatten(); const calls = stubResearch(h); let synthesized = 0;
  h.view.startSynthesis = async () => { synthesized++; };
  const host = h.host('root');
  await host.submit('synthesize', 'all');
  for (let i = 0; i < 2; i++) { await waitFor(() => calls.length === i + 1); calls[i].failed('boom'); calls[i].gate.resolve(); }
  await waitFor(() => !h.entry('root').session.running);
  assert.equal(synthesized, 0);
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_failed_0', t('ui.topic_chat_failed_children')));
  assert.equal((await topicLines(h, 'root')).at(-1).status, 'failed');
});

// ---- P3: a free question (map-chat step, subtree context, subtree-only writes) ----------------------------------------
const ACT = {
  runMap: (action, nodeIds, extra = {}) => ({ kind: 'run_map_action', action, nodeIds, title: '', goal: '', direction: '', mode: '', images: false, ...extra })
};
const mockChat = (h, make) => {
  h.requests = [];
  h.plugin.mapChat = { chat: async (request, signal) => { h.requests.push(request); return typeof make === 'function' ? make(request, signal) : make; } };
};
const answer = (actions, reply = 'ok') => ({ reply, actions, rejected: [], remaining: '' });
const snapshot = async h => {
  const out = new Map();
  for (const [p, file] of h.files) if (file.extension === 'md') out.set(p, await h.app.vault.read(file));
  return out;
};
const changedPaths = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p));

integrationTest('topic chat ask: the request carries only the subtree, no mapNeedsName or emptyMap, and the record round-trips as kind ask', async () => {
  const h = await harness(); mockChat(h, answer([], 'The **body** sleeps.'));
  const host = h.host('a');
  assert.equal(await host.submit('ask', 'what is here?'), true);
  await finished(h);
  const context = JSON.parse(h.requests[0].context.json);
  const raw = h.requests[0].context.json;
  assert.deepEqual(Array.from(h.requests[0].context.nodeIds).sort(), [h.ids.a, h.ids.c].sort(), 'only the topic and what is under it');
  assert.ok(!raw.includes('Mind'), 'siblings are not sent');
  assert.ok(!('mapNeedsName' in context) && !('emptyMap' in context));
  assert.equal(h.requests[0].message, 'what is here?');
  const last = h.entry('a').session.turns;
  assert.deepEqual([last[0].kind, last[1].text, last[1].markdown], ['ask', 'The **body** sleeps.', true]);
  const lines = await topicLines(h, 'a');
  assert.deepEqual([lines[0].kind, lines[1].status, lines[1].text], ['ask', 'done', 'The **body** sleeps.']);
  // The side panel keeps nothing of it.
  assert.equal(h.view.chatLastRecord ?? null, null);
  const { restoreTopicChat } = load('core/topic-chat-records.ts');
  const turns = restoreTopicChat(lines);
  assert.equal(turns[0].kind, 'ask'); assert.equal(turns[0].result.text, 'The **body** sleeps.');
  h.view.closeTopicChatWindow(); h.view.topicChatSessions.clear(); h.view.openTopicChat(h.node('a'));
  await waitFor(() => h.entry('a')?.session.turns.length === 2);
  assert.deepEqual([h.entry('a').session.turns[0].kind, h.entry('a').session.turns[1].markdown], ['ask', true]);
});

integrationTest('topic chat counterexample 3: a reply that reaches outside the subtree is refused item by item; the notes and the map outside stay byte for byte, the item inside is applied', async () => {
  const h = await harness(); const bNote = h.node('b').path;
  mockChat(h, answer([
    { kind: 'rename_topic', nodeId: h.ids.b, title: 'Sibling renamed' },
    { kind: 'add_child', parentId: h.ids.root, title: 'Under the parent', summary: '' },
    { kind: 'add_child', parentId: '', title: 'A new root', summary: '' },
    { kind: 'move_topic', nodeId: h.ids.c, newParentId: h.ids.b },
    { kind: 'add_relation', fromId: h.ids.c, toId: h.ids.b, relationKind: 'related' },
    { kind: 'delete_topic', nodeId: h.ids.a, branch: true },
    { kind: 'create_map', title: 'Another map' },
    { kind: 'open_map', title: 'Sleep map' },
    { kind: 'rename_map', title: 'New name' },
    ACT.runMap('expand', [h.ids.b]),
    { kind: 'edit_md_file', path: bNote, find: 'Mind', replace: 'Hacked' },
    { kind: 'rename_topic', nodeId: h.ids.c, title: 'REM stage' }
  ], 'Done.'));
  const before = await snapshot(h); const mapBefore = (await h.saved()).map(n => ({ id: n.id, parentId: n.parentId, path: n.path }));
  const host = h.host('a');
  assert.equal(await host.submit('ask', 'rewrite everything'), true);
  await finished(h);
  const after = await snapshot(h);
  const changed = changedPaths(before, after).filter(p => !p.includes('/Chats/'));
  assert.ok(changed.every(p => p === h.node('c').path || p.endsWith('/Map.md')), 'only the note inside changed: ' + changed.join(', '));
  assert.ok(changed.includes(h.node('c').path), 'the inside item was applied');
  assert.equal(after.get(bNote), before.get(bNote), 'the sibling note is byte for byte the same');
  assert.equal(after.get(h.node('root').path), before.get(h.node('root').path));
  assert.equal(after.get(h.node('a').path), before.get(h.node('a').path));
  const mapAfter = (await h.saved()).map(n => ({ id: n.id, parentId: n.parentId, path: n.path }));
  assert.deepEqual(mapAfter, mapBefore, 'no card added, moved or removed');
  assert.equal((await h.repo.readNote(h.node('c').path)).title, 'REM stage');
  assert.equal((await h.repo.readNote(bNote)).title, 'Mind');
  assert.equal(h.view.map.title, 'Sleep map');
  const sentence = h.entry('a').session.turns.at(-1).text;
  assert.ok(sentence.includes('Done.') && sentence.includes(t('ui.topic_chat_out_of_scope')), sentence);
});

integrationTest('topic chat ask: a non-root topic can be renamed and re-summarised by its own free question (its real parent is the baseline, not null)', async () => {
  const h = await harness();
  mockChat(h, answer([{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Body renamed' }, { kind: 'update_summary', nodeId: h.ids.a, summary: 'New summary' }], 'Renamed.'));
  await h.host('a').submit('ask', 'rename this'); await finished(h);
  const note = await h.repo.readNote(h.node('a').path);
  assert.equal(note.title, 'Body renamed'); assert.equal(note.summary, 'New summary');
  const sentence = h.entry('a').session.turns.at(-1).text;
  assert.ok(!sentence.includes(t('ui.map_chat_skip_topic_changed')), sentence);
  assert.ok(!h.requests[0].context.json.includes(h.ids.root), 'the parent topic is still not shown to the model');
});

integrationTest('topic chat ask: ignored and refused actions are not problems - only the reply and one out-of-scope sentence, status done; a real skip of an allowed action still shows', async () => {
  const count = (text, part) => text.split(part).length - 1;
  const h = await harness();
  mockChat(h, answer([{ kind: 'rename_topic', nodeId: h.ids.c, title: 'REM one' }, { kind: 'auto_layout' }], 'Reply only.'));
  await h.host('a').submit('ask', 'x'); await finished(h);
  assert.equal((await h.repo.readNote(h.node('c').path)).title, 'REM one');
  assert.equal(h.entry('a').session.turns.at(-1).text, 'Reply only.');
  assert.equal((await topicLines(h, 'a')).at(-1).status, 'done');
  mockChat(h, answer([{ kind: 'rename_topic', nodeId: h.ids.c, title: 'REM two' }, { kind: 'rename_topic', nodeId: h.ids.b, title: 'Out' }], 'Reply.'));
  await h.host('a').submit('ask', 'y'); await finished(h);
  const text = h.entry('a').session.turns.at(-1).text;
  assert.equal(count(text, t('ui.topic_chat_out_of_scope')), 1, text);
  assert.equal((await topicLines(h, 'a')).at(-1).status, 'done');
  const h2 = await harness();
  mockChat(h2, request => { h2.view.map.nodes.find(x => x.id === h2.ids.a).parentId = h2.ids.b; return answer([{ kind: 'rename_topic', nodeId: h2.ids.a, title: 'Late' }, { kind: 'auto_layout' }], 'Reply.'); });
  await h2.host('a').submit('ask', 'z'); await finished(h2);
  assert.ok(h2.entry('a').session.turns.at(-1).text.includes(t('ui.map_chat_skip_topic_changed')));
  assert.equal((await topicLines(h2, 'a')).at(-1).status, 'failed');
});

integrationTest('topic chat ask: a topic moved to another parent after sending is still refused as changed', async () => {
  const h = await harness();
  mockChat(h, request => { const n = h.view.map.nodes.find(x => x.id === h.ids.a); n.parentId = h.ids.b; return answer([{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Late' }], 'Renamed.'); });
  await h.host('a').submit('ask', 'rename this'); await finished(h);
  assert.notEqual((await h.repo.readNote(h.node('a').path)).title, 'Late');
  assert.ok(h.entry('a').session.turns.at(-1).text.includes(t('ui.map_chat_skip_topic_changed')), h.entry('a').session.turns.at(-1).text);
});

integrationTest('topic chat ask: inside the subtree a new card and a relation are written; a reply that needs a plan is not applied and says so in one sentence', async () => {
  const h = await harness();
  mockChat(h, answer([{ kind: 'add_child', parentId: h.ids.a, title: 'Light', summary: 'S', ref: 'n1' }, { kind: 'add_relation', fromId: 'new:n1', toId: h.ids.c, relationKind: 'related' }], 'Added.'));
  const before = (await h.saved()).length;
  await h.host('a').submit('ask', 'add light'); await finished(h);
  const nodes = await h.saved();
  assert.equal(nodes.length, before + 1); assert.equal(nodes.find(n => n.path !== undefined && n.parentId === h.ids.a && n.id !== h.ids.c)?.parentId, h.ids.a);
  assert.ok(!h.entry('a').session.turns.at(-1).text.includes(t('ui.topic_chat_out_of_scope')), 'nothing was refused');
  // Too big: a new card for every one of 16 actions needs the plan screen; nothing is written.
  mockChat(h, answer(Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.a, title: 'X' + i, summary: '' })), 'Lots.'));
  const count = (await h.saved()).length;
  await h.host('a').submit('ask', 'lots'); await finished(h);
  assert.equal((await h.saved()).length, count, 'not applied');
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_too_big'));
});

integrationTest('topic chat ask: a run action in the subtree goes to the topic chat runner, one outside never runs', async () => {
  const h = await harness(); const calls = stubResearch(h);
  mockChat(h, answer([ACT.runMap('research_standard', [h.ids.a], { direction: 'focus' }), ACT.runMap('research_standard', [h.ids.b])], 'Researching.'));
  await h.host('a').submit('ask', 'research it');
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].node.id, h.ids.a); assert.match(calls[0].request.task, /focus$/);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
  await finished(h);
  assert.equal(calls.length, 1, 'the sibling was not researched');
  assert.ok(h.entry('a').session.turns.at(-1).text.includes(t('ui.topic_chat_out_of_scope')));
});

integrationTest('topic chat ask: a declined usage question sends nothing; stop says stopped and writes nothing', async () => {
  const h = await harness(); mockChat(h, answer([]));
  h.control.decline = true;
  assert.equal(await h.host('a').submit('ask', 'hi'), false);
  assert.equal(h.requests.length, 0); assert.equal(h.entry('a').session.turns.length, 0);
  h.control.decline = false; const gate = deferred(); let signal;
  mockChat(h, async (_r, s) => { signal = s; await gate.promise; if (s.aborted) throw new Error('aborted'); return answer([{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Late' }]); });
  await h.host('a').submit('ask', 'slow'); await waitFor(() => signal);
  h.view.startingTasks.get(h.node('a').path).abort(); gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_stopped'));
  assert.equal((await h.repo.readNote(h.node('a').path)).title, 'Body');
});

integrationTest('topic chat synthesize: aborting while the unresearched subtopics are researched does not start the integration', async () => {
  const h = await harness(); h.flatten(); const calls = stubResearch(h); let synthesized = 0;
  h.view.startSynthesis = async () => { synthesized++; };
  await h.host('root').submit('synthesize', 'all');
  await waitFor(() => calls.length === 1);
  h.view.startingTasks.get(h.node('root').path).abort();
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
  await finished(h).catch(() => {}); await waitFor(() => !h.entry('root').session.running);
  assert.equal(synthesized, 0, 'no integration after the stop');
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_stopped'));
});

integrationTest('topic chat integration: the integration is written into the parent topic and the Undo button of its Notice puts the old content back', async () => {
  const h = await harness(); await researched(h);
  const rootNote = h.node('root');
  await h.repo.updateNote(rootNote.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  await h.view.hydrate();
  const before = await h.repo.readNote(rootNote.path);
  let call = 0;
  h.plugin.abortChartJobs = () => {}; h.plugin.addChartsAfterWrite = () => {};
  h.plugin.askModel = async (_context, _model, _reasoning, _signal, _onExchange, onAccepted) => {
    onAccepted?.(); call++;
    return call === 1 ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] }
      : { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] };
  };
  const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  const fail = message => assert.fail(message);
  await h.view.startSynthesis(h.node('root'), options, null, fail, () => {});
  await h.view.startSynthesis(h.node('root'), options, 'Find shared constraints', fail, () => {});
  assert.equal((await h.repo.readNote(rootNote.path)).summary, 'Draft summary', 'the result is written into the parent');
  const undo = h.Notice.all.flatMap(n => n.actions).find(b => b.text === t('ui.undo'));
  assert.ok(undo, 'the done Notice has an Undo button');
  undo.click();
  await waitFor(() => h.view.history.canRedo);
  assert.deepEqual(plain(await h.repo.readNote(rootNote.path)), plain(before), 'Undo restores the parent verbatim');
});

integrationTest('topic chat Escape gives the focus back: to the button that opened it, else to the topic card, never the page body', async () => {
  const h = await harness();
  const focused = [];
  const card = key => ({ focus: () => focused.push('card:' + key) });
  h.view.cardEls = new Map([[h.ids.a, card('a')], [h.ids.b, card('b')], [h.ids.c, card('c')]]);
  const escape = () => h.win().el.fire('keydown', { key: 'Escape' });
  // Button entry: the empty suggestion panel's AI explore button gets the focus back.
  const panel = element('div'); panel.root = h.page.doc;
  h.view.renderPendingProposals(panel, h.node('c'), h.view.notes.get(h.ids.c), () => {});
  const open = find(panel, i => i.tag === 'button' && i.text === t('ui.ai_explore'));
  open.focus = () => focused.push('button'); open.click(); escape();
  assert.deepEqual(plain(focused), ['button'], 'the button entry returns to its button');
  // The button was removed by a repaint meanwhile: the card of the same topic takes the focus.
  focused.length = 0; h.view.closeTopicChatWindow();
  open.click(); open.isConnected = false; escape();
  assert.deepEqual(plain(focused), ['card:c'], 'a removed opener falls back to the topic card');
  // No-button entries (right-click menu, command): the card of the topic.
  focused.length = 0; h.view.closeTopicChatWindow();
  h.view.selection.setSelected(h.ids.b);
  assert.equal(h.view.mapCommand('ai-explore', false), true); escape();
  assert.deepEqual(plain(focused), ['card:b'], 'the command entry returns to the card');
  focused.length = 0; h.view.closeTopicChatWindow();
  const items = []; const menu = { addItem(cb) { const it = { setTitle(x) { it.title = x; return it; }, setIcon() { return it; }, setSection() { return it; }, setDisabled() { return it; }, onClick(fn) { it.fn = fn; return it; } }; cb(it); items.push(it); return this; }, addSeparator() { return this; } };
  h.view.addCardMenuActions(menu, h.node('a')); items.find(i => i.title === t('ui.ai_explore')).fn(); escape();
  assert.deepEqual(plain(focused), ['card:a'], 'the right-click entry returns to the card');
});

// ---- Review round 1 ---------------------------------------------------------------------------------------------------

const RENAMED = 'Agent Workspace/Topics/map-b/Map.md';
const lineTexts = async (h, root, id) => { await h.view.topicChatRecords?.idle(); const p = `${root}/Chats/topics/${id}.jsonl`; return (await h.repo.app.vault.adapter.exists(p)) ? (await h.repo.app.vault.adapter.read(p)).split('\n').filter(Boolean).map(l => JSON.parse(l)) : null; };

integrationTest('topic chat B1: after a map rename or Organize the next turn is written into the new folder and the old folder is not made again; a task running through the rename still tells its result', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const oldRoot = h.repo.topicRoot(MAP), newRoot = h.repo.topicRoot(RENAMED);
  assert.notEqual(oldRoot, newRoot);
  h.view.openTopicChat(h.node('a')); // the entry is made on the old path
  await h.repo.ensureTopicFolders('Agent Workspace/Topics/map-b'); // the renamed map file (same content)
  await h.app.vault.create(RENAMED, await h.app.vault.read(h.app.vault.getAbstractFileByPath(MAP)));
  h.view.relocate(new Map([[MAP, RENAMED]]));
  const went = await h.host('a').submit('research', 'after the rename'); assert.equal(went, true, JSON.stringify(h.notices)); await waitFor(() => calls.length === 1);
  // The rename happens again in the middle of the task: the result still lands in the conversation.
  h.view.relocate(new Map([[RENAMED, MAP]]));
  h.view.relocate(new Map([[MAP, RENAMED]]));
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'), 'the result sentence is not dropped');
  const lines = await lineTexts(h, newRoot, h.ids.a);
  assert.deepEqual(plain(lines.map(l => l.type)), ['turn', 'result']);
  assert.equal(lines[0].message, 'after the rename');
  assert.equal(await lineTexts(h, oldRoot, h.ids.a), null, 'the old folder has no record file');
  assert.ok(![...h.files.keys()].some(p => p.startsWith(`${oldRoot}/Chats`)), 'the old folder was not made again');
});

integrationTest('topic chat B1: a rename in the middle of a task keeps the result sentence (the task is bound to the map, not to its path)', async () => {
  const h = await harness(); const calls = stubResearch(h);
  await h.host('a').submit('research', 'x'); await waitFor(() => calls.length === 1);
  await h.repo.ensureTopicFolders('Agent Workspace/Topics/map-b');
  await h.app.vault.create(RENAMED, await h.app.vault.read(h.app.vault.getAbstractFileByPath(MAP)));
  h.view.relocate(new Map([[MAP, RENAMED]]));
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'));
  const lines = await lineTexts(h, h.repo.topicRoot(RENAMED), h.ids.a);
  assert.deepEqual(plain(lines.map(l => l.type)), ['result'], 'the result goes to the folder the map has now');
});

integrationTest('topic chat B2: the map remembers aiMode only after the usage question is confirmed, and only for research and expand', async () => {
  const h = await harness(); const calls = stubResearch(h);
  h.plugin.outlineGeneration = { generate: async () => outlineOf('# Body\n## Light') };
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { accepted(); observer.onWritten(); };
  mockChat(h, answer([], 'hi')); await researched(h);
  assert.equal(h.view.map.aiMode, undefined);
  const host = h.host('a'); host.setMode('standard');
  h.control.decline = true;
  for (const kind of ['research', 'expand']) assert.equal(await host.submit(kind, 'go'), false, kind);
  assert.equal(h.view.map.aiMode, undefined, 'a declined question writes nothing');
  assert.equal((await h.saved()).length, 4); assert.equal((await core.parseMap(await h.app.vault.read(h.app.vault.getAbstractFileByPath(MAP)))).aiMode, undefined, 'nor on disk');
  h.control.decline = false;
  const root = h.host('root'); root.setMode('standard');
  await root.submit('synthesize', 'all'); await waitFor(() => !h.entry('root').session.running);
  await host.submit('ask', 'hi'); await finished(h);
  assert.equal(h.view.map.aiMode, undefined, 'an integration and a free question do not remember the mode');
  await host.submit('research', 'go'); await waitFor(() => calls.length === 1);
  assert.equal(h.view.map.aiMode, 'standard', 'a confirmed research remembers it');
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  host.setMode('quick'); await host.submit('expand', 'split'); await finished(h);
  assert.equal(h.view.map.aiMode, 'quick', 'a confirmed expand remembers it');
});

integrationTest('topic chat B3: the parent topic edited while the integration was made keeps the edit, leaves no history or Undo, and one failure sentence is told', async () => {
  const h = await harness(); h.flatten(); await researched(h);
  const rootNote = h.node('root');
  await h.repo.updateNote(rootNote.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  await h.view.hydrate();
  h.plugin.abortChartJobs = () => {}; h.plugin.addChartsAfterWrite = () => {};
  h.plugin.askModel = async (_context, _model, _reasoning, _signal, _onExchange, onAccepted) => {
    onAccepted?.();
    await h.repo.updateNote(rootNote.path, { summary: 'Edited meanwhile' });
    return { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] };
  };
  const host = h.host('root'); const historyBefore = h.view.history.canUndo;
  await host.submit('synthesize', 'Integrate'); await waitFor(() => !h.entry('root').session.running);
  const after = await h.repo.readNote(rootNote.path);
  assert.deepEqual([after.summary, after.detail], ['Edited meanwhile', 'Existing knowledge'], 'the edit stays, nothing of the integration is written');
  assert.equal(h.view.history.canUndo, historyBefore, 'no history entry'); assert.equal(h.view.history.canRedo, false);
  assert.equal(h.Notice.all.flatMap(n => n.actions ?? []).some(b => b.text === t('ui.undo')), false, 'no Undo button');
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_failed_0', t('log.child_integration_failed')));
  assert.equal((await topicLines(h, 'root')).at(-1).status, 'failed');
});

integrationTest('topic chat M1: starting a presentation closes the small window (a running task keeps going) and nothing can be sent during it', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const host = h.host('a'); await host.submit('research', 'x'); await waitFor(() => calls.length === 1);
  assert.ok(h.win(), 'the window is open');
  h.view.canPresent = () => true; h.view.presentationOrder = () => [h.ids.a]; h.view.startPresentation();
  assert.ok(h.view.presentation, 'the presentation started');
  assert.equal(h.view.topicChatOpen, null, 'the window was closed');
  assert.equal(h.entry('a').session.running, true, 'the task goes on');
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'));
  const asks = h.control.usageAsks;
  assert.equal(await h.view.submitTopicChat(h.entry('a'), h.node('a'), 'research', 'again'), false, 'no send while presenting');
  assert.equal(h.control.usageAsks, asks); assert.equal(calls.length, 1);
});

integrationTest('topic chat M2: a run action on a card this reply made (new:<ref>) researches that card', async () => {
  const h = await harness(); const calls = stubResearch(h);
  mockChat(h, answer([{ kind: 'add_child', parentId: h.ids.a, title: 'Light', summary: 'S', ref: 'n1' }, ACT.runMap('research_standard', ['new:n1'])], 'Added and researching.'));
  await h.host('a').submit('ask', 'add light and research it');
  await waitFor(() => calls.length === 1);
  assert.equal((await h.repo.readNote(calls[0].node.path)).title, 'Light'); assert.notEqual(calls[0].node.id, h.ids.a);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  // A reference that was never made is skipped, not turned into the topic itself.
  mockChat(h, answer([ACT.runMap('research_standard', ['new:nope'])], 'Researching.'));
  await h.host('a').submit('ask', 'research a ghost'); await finished(h);
  assert.equal(calls.length, 1, 'nothing ran for a card that was never made');
});

integrationTest('topic chat M3: a failed or skipped action is shown with the AI sentence and the record says failed', async () => {
  const h = await harness(); const calls = stubResearch(h);
  mockChat(h, answer([ACT.runMap('research_standard', [h.ids.a])], 'All done!'));
  await h.host('a').submit('ask', 'research it'); await waitFor(() => calls.length === 1);
  calls[0].failed('model unavailable'); calls[0].gate.resolve(); await finished(h);
  const text = h.entry('a').session.turns.at(-1).text;
  assert.ok(text.includes('All done!'), 'the AI sentence stays'); assert.ok(text.includes('model unavailable'), 'the failure is shown with it');
  assert.match(text, /^All done!\n\n.*Failed:.*model unavailable/s);
  assert.equal((await topicLines(h, 'a')).at(-1).status, 'failed');
  // Everything went well: only the AI sentence, status done.
  mockChat(h, answer([{ kind: 'add_child', parentId: h.ids.b, title: 'Calm', summary: 'S' }], 'Added.'));
  await h.host('b').submit('ask', 'rename'); await waitFor(() => !h.entry('b').session.running);
  assert.equal(h.entry('b').session.turns.at(-1).text, 'Added.'); assert.equal((await topicLines(h, 'b')).at(-1).status, 'done');
});

test('topic chat send: a started send clears the draft even when the window was destroyed meanwhile; a declined one keeps it', async () => {
  const gate = deferred();
  const f = fixture({ submit: () => gate.promise });
  f.type('moving on'); f.session.draftText = 'moving on';
  f.send().click(); await tick();
  f.win.destroy(); gate.resolve(true); await tick(); await tick();
  assert.equal(f.session.draftText, '', 'the sent text is not left as a draft');
  const gate2 = deferred();
  const g = fixture({ submit: () => gate2.promise });
  g.type('keep me'); g.session.draftText = 'keep me';
  g.send().click(); await tick();
  g.win.destroy(); gate2.resolve(false); await tick(); await tick();
  assert.equal(g.session.draftText, 'keep me', 'declined: the draft stays');
});

// Card click switching: onCardClick is the body of the card click listener.
const clickOf = (extra = {}) => ({ target: { closest: () => null }, metaKey: false, ctrlKey: false, ...extra });
async function switching() {
  const h = await harness();
  const edits = [];
  h.view.openCardTextEditor = (...args) => { edits.push(args); };
  h.view.cardEls = new Map();
  const click = (key, extra) => h.view.onCardClick(clickOf(extra), {}, h.node(key));
  return { h, edits, click };
}

integrationTest('topic chat switch: a click on another card moves the window; the old topic keeps its running task and draft; no card text editor', async () => {
  const { h, edits, click } = await switching(); const calls = stubResearch(h);
  const hostA = h.host('a'); hostA.setMode('quick'); hostA.setDraft('research', 'draft A');
  await hostA.submit('research', 'go'); await waitFor(() => calls.length === 1);
  hostA.setDraft('ask', 'unsent A');
  const winA = h.win();
  click('b');
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.b); assert.notEqual(h.win(), winA);
  assert.equal(h.entry('a').session.running, true); assert.equal(h.entry('a').session.draftText, 'unsent A');
  assert.equal(edits.length, 0, 'the switching click does not open the card text editor');
  // Task completes while the window shows B: Notice, B's window untouched.
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.ok(h.notices.some(n => n.includes('Body')), 'Notice for A: ' + h.notices.join('|'));
  assert.ok(!h.texts().includes(t('ui.topic_chat_research_done')), 'B shows nothing of A');
  click('a');
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a);
  assert.equal(h.entry('a').session.draftText, 'unsent A'); assert.ok(h.texts().includes(t('ui.topic_chat_research_done')));
});

integrationTest('topic chat switch: running A shows running again after switching back', async () => {
  const { h, click } = await switching(); const calls = stubResearch(h);
  const hostA = h.host('a'); await hostA.submit('research', 'go'); await waitFor(() => calls.length === 1);
  click('b'); click('a');
  assert.equal(h.entry('a').session.running, true);
  assert.equal(find(h.win().el, i => i.tag === 'button' && i.text === t('ui.topic_chat_research')).disabled, true, 'buttons disabled while running');
  calls[0].gate.resolve(); calls[0].done({ summary: 'S', detail: 'D' }); await finished(h);
});

integrationTest('topic chat switch: nothing moves with the window closed, in multi-select, with Cmd/Ctrl, on a locked card, on the same card; the editor opens when nothing switched', async () => {
  const { h, edits, click } = await switching();
  click('b'); assert.equal(h.win(), undefined, 'window closed: no opening'); assert.equal(edits.length, 1, 'editor as before');
  h.view.openTopicChat(h.node('a')); const winA = h.win();
  click('a'); assert.equal(h.win(), winA, 'same card: same window object'); assert.equal(edits.length, 2);
  click('b', { metaKey: true }); click('b', { ctrlKey: true }); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a);
  click('b', { target: { closest: () => ({}) } }); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, 'button click');
  h.view.suppressClickUntil = Date.now() + 10000; click('b'); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, 'drag');
  h.view.suppressClickUntil = 0;
  const before = h.notices.length; h.view.notes.get(h.ids.b).aiLocked = true; click('b');
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, 'locked'); assert.equal(h.notices.length, before, 'no Notice'); assert.equal(edits.length, 3);
  h.view.notes.get(h.ids.b).aiLocked = false;
  h.view.selection.mode = true; click('b');
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, 'multi-select'); h.view.selection.mode = false;
  click('b'); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.b, 'a plain click moves it');
});

integrationTest('topic chat switch: keyboard selection (selectMapNode) never switches', async () => {
  const { h } = await switching();
  h.view.openTopicChat(h.node('a')); h.view.selectMapNode(h.node('b'));
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a);
});

integrationTest('topic chat switch: a second submit of one entry during the first await is refused and starts nothing', async () => {
  const h = await harness(); const calls = stubResearch(h); const gate = deferred();
  h.plugin.confirmAiUsage = async (_m, run) => { await gate.promise; await run(); return true; };
  const host = h.host('a');
  const first = host.submit('research', 'one'); const second = await host.submit('research', 'two');
  assert.equal(second, false); gate.resolve(); assert.equal(await first, true);
  await waitFor(() => calls.length === 1); assert.equal(calls.length, 1);
  calls[0].gate.resolve(); calls[0].done({ summary: 'S', detail: 'D' }); await finished(h);
  assert.equal(h.entry('a').submitting, false, 'the flag is released');
});

// Real wiring: a card drawn by renderNode, pressed with pointer events that enableDrag listens to.
const withClosest = el => { el.closest = sel => { const parts = sel.split(',').map(x => x.trim()); for (let n = el; n; n = n.parent) if (parts.some(x => x.startsWith('.') ? hasClass(n, x.slice(1)) : n.tag === x)) return n; return null; }; return el; };
async function pointing() {
  const h = await harness();
  const edits = [];
  h.view.openCardTextEditor = (...args) => { edits.push(args); return false; };
  h.view.stageEl = h.page.root.createDiv('vam-stage');
  Object.assign(h.page.doc, { addEventListener() {}, removeEventListener() {} });
  h.view.labelCard = () => {}; // display-only text; the fake DOM has no textContent setter
  for (const key of ['a', 'b']) h.view.renderNode(h.node(key));
  const press = (key, { dx = 0, target, clickOnly, ...mods } = {}) => {
    const card = h.view.cardEls.get(h.ids[key]);
    Object.assign(card, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
    const at = withClosest(target ?? card);
    if (clickOnly) { card.fire('click', { target: at, ...mods }); return; } // a press on a field or button ends at pointerdown, only the click reaches the card
    card.fire('pointerdown', { target: at, button: 0, clientX: 10, clientY: 10, ...mods });
    if (dx) card.fire('pointermove', { target: at, button: 0, buttons: 1, clientX: 10 + dx, clientY: 10, ...mods });
    card.fire('pointerup', { target: at, button: 0, clientX: 10 + dx, clientY: 10, ...mods });
    card.fire('click', { target: at, ...mods });
  };
  return { h, edits, press };
}
integrationTest('topic chat switch (real pointer path): a single press on another card moves the window and skips the editor', async () => {
  const { h, edits, press } = await pointing();
  h.view.openTopicChat(h.node('a'));
  press('b');
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.b); assert.equal(edits.length, 0);
  press('a'); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, 'back to a');
  h.view.selectMapNode(h.node('b')); assert.equal(h.view.selection.state.selected, h.ids.b, 'b is selected while the window is on a');
  const before = edits.length; press('b');
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.b, 'an already selected card switches too'); assert.equal(edits.length, before, 'no editor');
  const win = h.win(); const seen = edits.length; press('b'); assert.equal(h.win(), win, 'same card: same window'); assert.equal(edits.length, seen + 1, 'editor opens when nothing switched');
});
integrationTest('topic chat switch (real pointer path): window closed, drag, Cmd/Ctrl and editor fields do not switch', async () => {
  const { h, edits, press } = await pointing();
  press('b'); assert.equal(h.win(), undefined); assert.equal(edits.length, 1, 'closed window: editor as before');
  h.view.openTopicChat(h.node('a'));
  const seen = edits.length; press('b', { dx: 60 }); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, 'drag'); assert.equal(edits.length, seen, 'a drag is not a click');
  press('b', { metaKey: true }); press('b', { ctrlKey: true }); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, 'Cmd/Ctrl');
  for (const [tag, cls] of [['input', 'vam-card-title-input'], ['textarea', 'vam-card-summary-input'], ['button', '']]) {
    const field = element(tag, { cls }); h.view.cardEls.get(h.ids.b).appendChild?.(field); field.parent = h.view.cardEls.get(h.ids.b); withClosest(field);
    h.view.suppressClickUntil = 0;
    press('b', { target: field, clickOnly: true }); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a, cls || tag); if (tag !== 'button') assert.equal(edits.at(-1)?.[0].target, field, 'the real editor gets the field as target and ignores it');
  }
});

// ---- steer state machine (P2): pure class, no DOM ----
const { TopicChatSteers } = load('experiences/visual-map/topic-chat-steer.ts');
const states = s => plain(s.entries.map(e => e.state));
const handlerLog = () => { const log = { sent: [], gates: [] }; log.send = text => { log.sent.push(text); let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); const g = { promise, resolve, reject }; log.gates.push(g); return g.promise; }; return log; };

test('steer state: pending until a handler binds, then delivered in typed order, one at a time', async () => {
  const s = new TopicChatSteers(); const log = handlerLog();
  s.add('a'); s.add('b');
  assert.deepEqual(states(s), ['pending', 'pending']); assert.deepEqual(log.sent, []);
  s.bind(log.send);
  assert.deepEqual(states(s), ['sending', 'sending']);
  await tick(); assert.deepEqual(log.sent, ['a'], 'b waits for a');
  log.gates[0].resolve(); await tick(); await tick();
  assert.deepEqual(log.sent, ['a', 'b']); log.gates[1].resolve();
  await s.close();
  assert.deepEqual(states(s), ['delivered', 'delivered']); assert.deepEqual(plain(s.delivered()), ['a', 'b']);
  assert.deepEqual(plain(s.views().map(v => v.state)), ['live', 'live']);
});

test('steer state: a handler that rejects leaves the addition queued, the next still goes in', async () => {
  const s = new TopicChatSteers(); const sent = [];
  s.bind(async text => { sent.push(text); if (text === 'late') throw new Error('turn ended'); });
  s.add('late'); s.add('ok');
  await s.close();
  assert.deepEqual(sent, ['late', 'ok']); assert.deepEqual(states(s), ['queued', 'delivered']);
  assert.deepEqual(plain(s.takeQueued()), ['late']); assert.deepEqual(plain(s.takeQueued()), [], 'taken once');
  assert.deepEqual(plain(s.entries.map(e => e.text)), ['ok'], 'delivered stays');
});

test('steer state: an answer from an older attempt (gen fence) changes nothing', async () => {
  const s = new TopicChatSteers(); const old = handlerLog(); const fresh = handlerLog();
  s.bind(old.send); s.add('x'); await tick();
  assert.deepEqual(states(s), ['sending']);
  s.bind(null); s.bind(fresh.send); await tick();
  assert.deepEqual(old.sent, ['x']); assert.deepEqual(fresh.sent, ['x'], 'handed to the new attempt');
  old.gates[0].resolve(); await tick();
  assert.deepEqual(states(s), ['sending'], 'the old answer is ignored');
  fresh.gates[0].resolve(); await s.close();
  assert.deepEqual(states(s), ['delivered']);
  // A late reject of the old handler does not queue it either.
  const t2 = new TopicChatSteers(); const o2 = handlerLog(); const n2 = handlerLog();
  t2.bind(o2.send); t2.add('y'); await tick(); t2.bind(null); t2.bind(n2.send); await tick();
  o2.gates[0].reject(new Error('old')); await tick();
  assert.deepEqual(states(t2), ['sending']);
  n2.gates[0].resolve(); await t2.close(); assert.deepEqual(states(t2), ['delivered']);
});

test('steer state: setLive(false) turns pending, sending and delivered into queued, and later additions wait too', async () => {
  const s = new TopicChatSteers(); const log = handlerLog();
  s.bind(log.send); s.add('d'); await tick(); log.gates[0].resolve(); await tick();
  s.add('s'); await tick(); s.add('p');
  assert.deepEqual(states(s), ['delivered', 'sending', 'sending']);
  s.live(false);
  assert.deepEqual(states(s), ['queued', 'queued', 'queued']);
  log.gates[1].resolve(); await tick();
  assert.deepEqual(states(s), ['queued', 'queued', 'queued'], 'the answer of the dropped handler changes nothing');
  s.add('after'); assert.equal(s.entries.at(-1).state, 'queued');
  await s.close(); assert.deepEqual(plain(s.takeQueued()), ['d', 's', 'p', 'after']); assert.deepEqual(plain(s.delivered()), []);
});

test('steer state: every new attempt gets each addition once (rebind)', async () => {
  const s = new TopicChatSteers(); const a1 = []; const a2 = []; const a3 = [];
  s.add('one');
  s.bind(async t => { a1.push(t); }); s.add('two'); await tick(); await tick();
  assert.deepEqual(a1, ['one', 'two']); assert.deepEqual(states(s), ['delivered', 'delivered']);
  s.bind(null); s.bind(async t => { a2.push(t); }); await tick(); await tick();
  assert.deepEqual(a2, ['one', 'two'], 'once each'); assert.deepEqual(states(s), ['delivered', 'delivered']);
  s.bind(null); assert.deepEqual(a2, ['one', 'two'], 'dropping the handler sends nothing');
  s.bind(async t => { a3.push(t); }); await tick(); await tick(); await s.close();
  assert.deepEqual(a3, ['one', 'two']); assert.deepEqual(a1, ['one', 'two']);
  // No new handler by the end: what the dead attempt took is not in the reply, so it waits.
  const u = new TopicChatSteers(); u.bind(async () => {}); u.add('z'); await tick(); await tick();
  u.bind(null); await u.close(); assert.deepEqual(states(u), ['queued']);
});

test('steer state: after close an addition is queued at once and never handed over; close waits for hand-overs under way', async () => {
  const s = new TopicChatSteers(); const log = handlerLog();
  s.bind(log.send); s.add('x'); await tick();
  let closed = false; const closing = s.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false, 'waits for the chain');
  log.gates[0].resolve(); await closing;
  assert.deepEqual(states(s), ['delivered']);
  s.bind(log.send); s.add('y');
  assert.equal(s.entries[1].state, 'queued'); await tick(); assert.deepEqual(log.sent, ['x']);
  assert.deepEqual(plain(s.takeQueued()), ['y']);
});

test('steer state: a dead owner (alive false) ignores late answers and binds', async () => {
  let alive = true; const s = new TopicChatSteers({ alive: () => alive }); const log = handlerLog();
  s.bind(log.send); s.add('x'); await tick(); alive = false; log.gates[0].resolve(); await tick();
  assert.deepEqual(states(s), ['sending']);
  const changes = []; const c = new TopicChatSteers({ onChange: () => changes.push(1) }); c.add('q'); assert.ok(changes.length > 0);
});

test('steer records: a steer line is written, read back in order, paired by id', () => {
  const turn = { type: 'turn', id: 't1', at: 'a', kind: 'research', mode: 'quick', message: 'hi' };
  const text = records.serializeTopicChatLine(turn)
    + records.serializeTopicChatLine({ type: 'result', id: 't1', at: 'b', status: 'done', text: 'ok' })
    + records.serializeTopicChatLine({ type: 'steer', id: 't1', at: 'c', text: 'one' })
    + records.serializeTopicChatLine({ type: 'steer', id: 't1', at: 'd', text: 'two' })
    + records.serializeTopicChatLine({ type: 'steer', id: 'orphan', at: 'e', text: 'lost' });
  assert.equal(JSON.parse(text.split('\n')[2]).v, 1);
  const parsed = records.parseTopicChat(text);
  assert.equal(parsed.skipped, 0); assert.equal(parsed.unrecoverable, false);
  const restored = records.restoreTopicChat(parsed.lines);
  assert.deepEqual(plain(restored.map(r => [r.id, r.result?.text, r.steers])), [['t1', 'ok', ['one', 'two']]]);
});

test('steer records: a file from before steer lines reads as before; duplicate turn ids and unknown types do not disturb a turn', () => {
  const old = '{"v":1,"type":"turn","id":"t1","at":"a","kind":"ask","mode":"quick","message":"hi"}\n{"v":1,"type":"result","id":"t1","at":"b","status":"done","text":"ok"}\n';
  const restoredOld = records.restoreTopicChat(records.parseTopicChat(old).lines);
  assert.deepEqual(plain(restoredOld), [{ id: 't1', kind: 'ask', mode: 'quick', message: 'hi', result: { status: 'done', text: 'ok' }, steers: [] }]);
  const mixed = old
    + '{"v":1,"type":"turn","id":"t1","at":"c","kind":"research","mode":"standard","message":"dup"}\n'
    + '{"v":1,"type":"steer","id":"t1","at":"d","text":"s1"}\n'
    + '{"v":1,"type":"future","id":"t1","at":"e","text":"???"}\n'
    + '{"v":1,"type":"steer","id":"t1","at":"f"}\n'
    + '{"v":1,"type":"steer","id":"","at":"g","text":"no id"}\n';
  const parsed = records.parseTopicChat(mixed);
  assert.equal(parsed.skipped, 3, 'unknown type, steer without text, steer without id');
  assert.equal(parsed.unrecoverable, false);
  const restored = records.restoreTopicChat(parsed.lines);
  assert.equal(restored.length, 1, 'a duplicate turn id adds no turn');
  assert.deepEqual(plain([restored[0].message, restored[0].result.text, restored[0].steers]), ['hi', 'ok', ['s1']]);
});

// ---- P3: steer through the view (additions typed while a task runs, the gap after the reply, the automatic follow-up) ----
const refuse = async () => { throw new Error('turn ended'); };
/** Runs `fn` once, when the first reply sentence has just been pushed (inside settleTopicChat, before the entry is freed or sent on). */
const atFirstReply = (entry, fn) => { let done = false; entry.watchers.add(() => { if (!done && entry.session.turns.some(x => x.role === 'ai')) { done = true; fn(); } }); };
const kinds = entry => entry.session.turns.map(x => x.role + ':' + (x.kind ?? ''));
/** A first ask that stays open until `gate` resolves and takes no addition (every one is queued); later asks answer at once. */
const gappedChat = (h, gate, extra) => {
  h.requests = [];
  h.plugin.mapChat = { chat: async (request, signal, _reply, _progress, onSteer) => {
    h.requests.push(request);
    if (h.requests.length === 1) { onSteer?.(refuse); await gate.promise; }
    return extra ? extra(request, h.requests.length) : answer([], 'r' + h.requests.length);
  } };
};

integrationTest('topic chat steer: the gap after the reply keeps running on, a second Enter only adds, and the waiting additions are asked exactly once as one new turn', async () => {
  const h = await harness(); const host = h.host('a'); const entry = h.entry('a'); const gate = deferred(); const gate2 = deferred();
  gappedChat(h, gate);
  let asks = 0; h.plugin.confirmAiUsage = async (_m, run) => { asks++; if (asks === 2) await gate2.promise; await run(); return true; };
  let tasks = 0; const runTask = h.view.runTopicChatTask.bind(h.view); h.view.runTopicChatTask = (...args) => { tasks++; return runTask(...args); };
  const samples = []; entry.watchers.add(() => samples.push([entry.session.running, entry.session.turns.length]));
  assert.equal(await host.submit('ask', 'q'), true); await waitFor(() => h.requests.length === 1);
  assert.equal(host.steer('s1'), true);
  assert.equal(h.entry('a').steers.entries[0].state !== 'delivered', true);
  gate.resolve(); await waitFor(() => asks === 2);
  assert.equal(entry.session.running, true, 'the usage question of the follow-up is open: still running');
  assert.equal(host.steer('s2'), true, 'a second Enter in the gap adds, it cannot start a run');
  gate2.resolve(); await finished(h);
  assert.equal(h.requests.length, 2, 'asked exactly once more'); assert.equal(tasks, 2, 'no third run');
  assert.equal(h.requests[1].message, 's1\n\ns2', 'one message, in typed order, with the one typed while the usage question was open');
  assert.deepEqual(plain(kinds(entry)), ['user:ask', 'ai:', 'user:ask', 'ai:']);
  assert.equal(entry.session.turns[2].text, 's1\n\ns2'); assert.deepEqual(plain(entry.session.turns[0].steers ?? []), [], 'taken out of the old turn');
  assert.deepEqual(samples.filter(([running, turns]) => !running && turns < 4), [], 'running never dropped over the gap');
  const lines = await topicLines(h, 'a'); assert.deepEqual(lines.map(x => x.type), ['turn', 'result', 'turn', 'result'], 'queued additions write no steer line');
});

integrationTest('topic chat steer: an addition the reply took in is shown, written after close, applied with the question and part of the next request history', async () => {
  const h = await harness(); const host = h.host('a'); const entry = h.entry('a'); const gate = deferred(); const slow = deferred(); const sent = []; let message;
  h.requests = [];
  h.plugin.mapChat = { chat: async (request, signal, _r, _p, onSteer) => {
    h.requests.push(request);
    if (h.requests.length === 1) { onSteer(async text => { sent.push(text); await slow.promise; }); await gate.promise; return answer([{ kind: 'add_child', parentId: h.ids.a, title: 'Light', summary: 'S' }], 'ok'); }
    return answer([], 'second');
  } };
  h.view.applyMapChatActions = async result => { message = result.message; return []; };
  await host.submit('ask', 'q'); await waitFor(() => h.requests.length === 1);
  host.steer('s1'); await tick(); assert.deepEqual(sent, ['s1']);
  assert.deepEqual(plain(entry.session.turns[0].steers), [{ text: 's1', state: 'live' }]);
  gate.resolve(); await tick(); await tick(); await tick();
  assert.equal(entry.session.running, true); assert.equal(entry.session.turns.length, 1, 'the reply waits for the hand-over to settle');
  assert.equal(message, undefined, 'nothing is applied before close');
  slow.resolve(); await finished(h);
  assert.equal(message, 'q\n\ns1', 'the actions are applied with the question and what went in');
  const lines = await topicLines(h, 'a'); const steerLines = lines.filter(x => x.type === 'steer');
  assert.deepEqual(steerLines.map(x => [x.id, x.text]), [[lines[0].id, 's1']]); assert.equal(lines.at(-1).type, 'steer');
  await host.submit('ask', 'next'); await finished(h);
  assert.deepEqual(plain(JSON.parse(h.requests[1].context.json).earlierTurns)[0], { role: 'user', text: 'q\n\ns1' }, 'history carries what went in');
  // Reopened (sessions gone): the taken-in addition is shown again.
  h.view.closeTopicChatWindow(); h.view.topicChatSessions.clear();
  h.view.openTopicChat(h.node('a')); await waitFor(() => h.entry('a').session.turns.length >= 4);
  assert.deepEqual(plain(h.entry('a').session.turns[0].steers), [{ text: 's1', state: 'live' }]);
});

const outcomes = [
  ['declined usage question', { hook: h => { h.control.decline = true; }, notice: true }],
  ['AI lock', { hook: h => { h.view.aiLockReason = () => ({}); }, notice: true }],
  ['busy card', { hook: h => { h.plugin.quickExpandPending.add(h.node('a').path); }, notice: true }],
  ['presentation', { hook: h => { h.view.presentation = {}; }, notice: true }],
  ['deleted card', { hook: h => { h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.a); }, notice: true }],
  ['view closed', { hook: h => { h.view.closed = true; }, notice: false }],
  ['map changed', { hook: h => { h.view.map = { ...h.view.map, id: 'other-map' }; }, notice: false }]
];
for (const [name, { hook, notice }] of outcomes) for (const windowOpen of [true, false]) {
  integrationTest(`topic chat steer follow-up not sent (${name}, window ${windowOpen ? 'open' : 'closed'}): nothing is asked, the text goes back in front of the draft, running is freed`, async () => {
    const h = await harness(); const host = h.host('a'); const entry = h.entry('a'); const gate = deferred(); gappedChat(h, gate);
    await host.submit('ask', 'q'); await waitFor(() => h.requests.length === 1);
    host.steer('first'); host.steer('second'); host.setDraft(null, 'mine');
    atFirstReply(entry, () => { if (!windowOpen) h.view.closeTopicChatWindow(); hook(h); });
    const before = h.notices.length; gate.resolve();
    await waitFor(() => !entry.session.running && entry.session.turns.length >= 2);
    assert.equal(h.requests.length, 1, 'no second question'); assert.equal(entry.submitting, false);
    assert.equal(entry.session.draftText, 'first\n\nsecond\n\nmine');
    const sentence = h.notices.slice(before).includes(t('ui.map_chat_not_sent_draft'));
    if (!notice) assert.equal(sentence, false, 'a view that is gone says nothing');
    else if (windowOpen && h.win()) assert.equal(find(h.win().el, i => i.tag === 'textarea').value, 'first\n\nsecond\n\nmine');
    else if (!h.win()) assert.equal(sentence, true, 'a window that is not there says it');
    assert.deepEqual(plain(entry.session.turns[0].steers ?? []), [], 'the waiting ones left the turn');
  });
}

const stoppedOrFailed = [
  ['stopped', (h, gate) => { h.plugin.mapChat.chat = async (request, signal, _r, _p, onSteer) => { h.requests.push(request); onSteer(refuse); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('x')))); }; }, h => [...h.plugin.activeTasks.values()][0].abort(), t('ui.topic_chat_stopped')],
  ['failed', (h, gate) => { h.plugin.mapChat.chat = async (request, signal, _r, _p, onSteer) => { h.requests.push(request); onSteer(refuse); await gate.promise; throw new Error('boom'); }; }, (h, gate) => gate.resolve(), null],
  ['needs a plan', (h, gate) => { h.plugin.mapChat.chat = async (request, signal, _r, _p, onSteer) => { h.requests.push(request); onSteer(refuse); await gate.promise; return answer(Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.a, title: 'X' + i, summary: '' }))); }; }, (h, gate) => gate.resolve(), t('ui.topic_chat_too_big')]
];
for (const [name, setup, trigger, sentence] of stoppedOrFailed)
  integrationTest(`topic chat steer ${name}: the waiting addition is not sent, it is back in the box, running is freed`, async () => {
    const h = await harness(); const host = h.host('a'); const entry = h.entry('a'); const gate = deferred(); h.requests = []; h.plugin.mapChat = {}; setup(h, gate);
    await host.submit('ask', 'q'); await waitFor(() => h.requests.length === 1);
    host.steer('late'); trigger(h, gate);
    await waitFor(() => !entry.session.running && entry.session.turns.length === 2);
    assert.equal(h.requests.length, 1); assert.equal(entry.session.draftText, 'late'); assert.equal(find(h.win().el, i => i.tag === 'textarea').value, 'late');
    if (sentence) assert.equal(entry.session.turns.at(-1).text, sentence);
    assert.deepEqual(plain(entry.session.turns[0].steers ?? []), []);
  });

integrationTest('topic chat steer: startSynthesis hands the steer to the run of a kept task (and keeps none in the stored options); a fresh task stores none either', async () => {
  const h = await harness(); const seen = []; const steer = { bind() {}, live() {} };
  h.plugin.topicRuns.start = async (_path, kind, options) => { seen.push([kind, options.steer]); return null; };
  const node = h.node('root'); const path = node.path;
  h.view.synthesisTasks.set(path, { mapPath: h.view.path, mapId: h.view.map.id, state: 'directions', step: 'directions', controller: new AbortController(), progress: '', options: { requirements: 'r' }, directions: [{ id: 'd' }], direction: '' });
  await h.view.startSynthesis(node, { steer, continuesDirections: true, onProgress() {} }, 'go', () => {}, () => {});
  assert.deepEqual(seen.map(x => x[0]), ['integrateChildren']); assert.equal(seen[0][1], steer, 'a task kept from the first step still gets the steer');
  assert.equal(h.view.synthesisTasks.get(path).options.steer, undefined);
  h.view.synthesisTasks.delete(path);
  await h.view.startSynthesis(node, { steer, onProgress() {} }, 'go', () => {}, () => {});
  assert.equal(seen[1][1], steer); assert.equal(h.view.synthesisTasks.get(path).options.steer, undefined, 'the stored options carry no steer (a retry must not)');
});

integrationTest('topic chat steer: an addition typed while the subtopics are researched first rides in the integration text once, shows as taken in, and is written', async () => {
  const h = await harness(); h.flatten(); const calls = stubResearch(h); const seen = [];
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { seen.push({ direction, steer: options.steer }); accepted(); observer.onWritten(); };
  const statuses = { a: 'completed', b: 'error' }; const load0 = h.view.hydrate;
  h.view.hydrate = async () => { await load0(); for (const [k, v] of Object.entries(statuses)) h.view.notes.get(h.ids[k]).status = v; };
  await h.view.hydrate();
  const host = h.host('root'); const entry = h.entry('root');
  await host.submit('synthesize', 'all'); await waitFor(() => calls.length === 1);
  assert.equal(calls[0].request && true, true); assert.equal(host.steer('early'), true);
  assert.equal(entry.steers.entries[0].state, 'queued', 'the subtopic research takes none');
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
  await waitFor(() => !entry.session.running);
  assert.equal(seen.length, 1); assert.equal(seen[0].direction, 'all\n\nearly', 'folded in once');
  assert.deepEqual(plain(seen[0].steer.entries), [], 'and not again as a waiting one');
  assert.deepEqual(plain(entry.session.turns[0].steers), [{ text: 'early', state: 'live' }]); assert.equal(h.requests?.length ?? 0, 0, 'no follow-up');
  const lines = await topicLines(h, 'root'); assert.deepEqual(lines.filter(x => x.type === 'steer').map(x => x.text), ['early']);
  assert.equal(entry.session.turns.length, 2);
});

integrationTest('topic chat steer: research and expand hand the steer on; a synthesis without researching first passes the same one', async () => {
  const h = await harness(); const entry0 = () => h.entry('a'); const got = {};
  h.view.runAgent = async (node, done, failed, request, accepted, runOnce, steer) => { got.research = steer; accepted?.(); done({ summary: 'S', detail: 'D' }); return { finished: Promise.resolve() }; };
  h.view.detailTemplateFor = async () => undefined;
  h.plugin.outlineGeneration = { generate: async (_r, _s, steer) => { got.expand = steer; return outlineOf('# Body\n## Light'); } };
  await h.host('a').submit('research', 'x'); await finished(h);
  await h.host('a').submit('expand', 'x'); await finished(h);
  assert.equal(got.research, got.research && entry0().steers && got.research); assert.ok(got.research && typeof got.research.bind === 'function' && typeof got.research.live === 'function');
  assert.ok(got.expand && typeof got.expand.bind === 'function');
  h.flatten(); await researched(h); let option;
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { option = options; accepted(); observer.onWritten(); };
  await h.host('root').submit('synthesize', 'go'); await waitFor(() => !h.entry('root').session.running);
  assert.equal(option.steer, h.entry('root').steers);
});

integrationTest('topic chat steer (real window): Enter while running adds the text, the box clears, a live bubble shows under the turn; the buttons stay disabled; switching cards keeps it and the draft', async () => {
  const h = await harness(); const calls = stubResearch(h); const host = h.host('a'); const entry = h.entry('a');
  await host.submit('research', 'dig'); await waitFor(() => calls.length === 1);
  const win = h.win(); const input = find(win.el, i => i.tag === 'textarea');
  input.value = 'also the code'; input.input(); byLabel(win.el, t('ui.topic_chat_send')).click(); await tick();
  assert.equal(input.value, ''); assert.equal(findAll(win.el, i => hasClass(i, 'vam-topic-chat-steer-text')).map(i => i.text).join(), 'also the code');
  assert.ok(['research', 'expand', 'synthesize'].every(k => find(win.el, i => i.tag === 'button' && i.text === t('ui.topic_chat_' + k)).disabled));
  assert.equal(calls.length, 1, 'not a second run');
  input.value = 'typing'; input.input();
  h.view.openTopicChat(h.node('b')); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.b);
  h.view.openTopicChat(h.node('a'));
  const win2 = h.win(); assert.notEqual(win2, win);
  assert.equal(find(win2.el, i => i.tag === 'textarea').value, 'typing'); assert.equal(findAll(win2.el, i => hasClass(i, 'vam-topic-chat-steer-text')).length, 1, 'the addition is still shown');
  assert.equal(entry.steers.entries.length, 1);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal(entry.session.running, false);
});

integrationTest('topic chat steer: with no addition the entry is freed in the same step as the sentence (running timing as before); an addition typed with running false and a busy card still gets the Notice', async () => {
  const h = await harness(); const calls = stubResearch(h); const entry = h.host('a') && h.entry('a'); const seen = [];
  entry.watchers.add(() => seen.push([entry.session.turns.at(-1)?.role, entry.session.running]));
  await h.host('a').submit('research', 'x'); await waitFor(() => calls.length === 1);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.ok(seen.some(([role]) => role === 'ai')); assert.deepEqual(seen.filter(([role, running]) => role === 'ai' && running), [], 'the sentence never shows with running still on');
  assert.ok(entry.session.turns.every(x => x.steers === undefined), 'no steers field without additions');
  h.plugin.quickExpandPending.add(h.node('a').path); const before = h.notices.length;
  assert.equal(h.host('a').steer('x'), false, 'not running: no addition'); assert.equal(await h.host('a').submit('ask', 'x'), false);
  assert.equal(h.notices.slice(before).at(-1), t('ui.ai_running_ai'));
});

integrationTest('topic chat steer: a retried attempt (a new handler through the view) gets each addition once, and the reply is applied with it once', async () => {
  const h = await harness(); const host = h.host('a'); const gate = deferred(); const a1 = []; const a2 = []; let message; let applied = 0;
  h.requests = [];
  h.plugin.mapChat = { chat: async (request, signal, _r, _p, onSteer) => {
    h.requests.push(request);
    if (h.requests.length === 1) {
      onSteer(async text => { a1.push(text); });
      await gate.promise;
      onSteer(null); onSteer(async text => { a2.push(text); }); await tick(); await tick();
      return answer([{ kind: 'add_child', parentId: h.ids.a, title: 'Light', summary: 'S' }], 'ok');
    }
    return answer([], 'second');
  } };
  h.view.applyMapChatActions = async result => { applied++; message = result.message; return []; };
  await host.submit('ask', 'q'); await waitFor(() => h.requests.length === 1);
  host.steer('s1'); host.steer('s2'); await tick(); await tick();
  assert.deepEqual(a1, ['s1', 's2']);
  gate.resolve(); await finished(h);
  assert.deepEqual(a2, ['s1', 's2'], 'the new attempt gets each addition exactly once');
  assert.deepEqual(a1, ['s1', 's2'], 'the old one is not sent again');
  assert.equal(applied, 1); assert.equal(message, 'q\n\ns1\n\ns2', 'each addition once in the applied question');
});

test('topic chat window stop: the running row shows a labelled Stop button that calls the host; idle and the closing gap show none', () => {
  let stoppable = true;
  const f = fixture({ stoppable: () => stoppable });
  const stopBtn = () => find(f.win.el, i => i.tag === 'button' && hasClass(i, 'vam-topic-chat-stop'));
  assert.equal(stopBtn(), undefined, 'idle: no stop button');
  f.session.running = true; f.refresh();
  const btn = stopBtn();
  assert.ok(btn, 'running: stop button shown');
  assert.equal(btn.text, t('ui.topic_chat_stop'));
  assert.equal(btn.attrs.type, 'button');
  assert.equal(btn.attrs['aria-label'], t('ui.topic_chat_stop'));
  assert.ok(hasClass(btn.parent, 'is-running'));
  btn.click();
  assert.equal(f.calls.stop, 1);
  assert.deepEqual(f.calls.submit, []);
  stoppable = false; f.refresh();
  assert.equal(stopBtn(), undefined, 'closing gap (cannot stop): no stop button');
  assert.ok(findAll(f.win.el, i => hasClass(i, 'is-running')).length === 1, 'the Running row stays');
  stoppable = true; f.session.running = false; f.refresh();
  assert.equal(stopBtn(), undefined, 'idle again: no stop button');
});

// ---- Subtree integration: the depth card and the chain below the root (root -> a, b; a -> c; c -> deep). ----
const deepen = async h => {
  const created = await h.repo.createNote('Deep', 'gpt-6-luna', h.view.map, MAP, 'inherited');
  Object.assign(created, { parentId: h.ids.c, x: 700, y: 80 });
  h.view.map.nodes.push(created); h.ids.deep = created.id; await h.view.hydrate();
};
const nameOf = (h, id) => Object.entries(h.ids).find(([, v]) => v === id)?.[0];
/** Records each integration step; `on(key, call)` may return false to make that step write nothing. */
const stubChain = (h, on = () => true) => {
  const steps = []; const research = [];
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => {
    const key = nameOf(h, node.id); steps.push({ key, options, direction });
    accepted(); if ((await on(key, steps.at(-1))) !== false) observer.onWritten();
  };
  h.view.runAgent = async (node, done, failed, request, accepted) => { research.push({ key: nameOf(h, node.id), mode: request.researchMode }); accepted?.(); done({ summary: 'S', detail: 'D' }); return { finished: Promise.resolve() }; };
  h.view.detailTemplateFor = async () => undefined;
  return { steps, research };
};
const startDeep = async (h, depth, { mode = 'quick', text = 'all' } = {}) => {
  const host = h.host('root'); host.setMode(mode);
  assert.equal(await host.submit('synthesize', text), true);
  host.chooseDepth(depth);
  const asks = h.control.usageAsks;
  assert.equal(await host.confirmChoice(), true);
  assert.equal(h.control.usageAsks, asks + 1, 'one usage question for the whole chain');
  await waitFor(() => !h.entry('root').session.running);
  return h.entry('root').session.turns.at(-1).text;
};

integrationTest('topic chat depth card: a deeper subtree shows the card with the numbers from the map; Cancel runs no AI and writes no record', async () => {
  const h = await harness(); await deepen(h); const { steps, research } = stubChain(h);
  const asks = h.control.usageAsks; const host = h.host('root');
  assert.equal(await host.submit('synthesize', 'all'), true);
  const choice = h.entry('root').session.choice;
  assert.deepEqual(plain({ ...choice, turn: undefined }), plain({ levels: 3, topics: 4, researched: 0, leaves: 2, calls: { quick: 2, 'bottom-up': 3, 'research-first': 5 }, selected: 'quick', text: 'all', turn: undefined }));
  assert.equal(h.entry('root').session.running, false); assert.equal(h.control.usageAsks, asks, 'no usage question yet');
  const win = h.win(); const card = find(win.el, i => i.attrs?.role === 'radiogroup');
  assert.ok(card, 'the radio group is drawn');
  assert.deepEqual(findAll(card, i => i.attrs?.role === 'radio').map(i => i.attrs['aria-checked']), ['true', 'false', 'false']);
  assert.ok(find(win.el, i => i.tag === 'button' && i.text === t('ui.topic_chat_choice_start')));
  const cancel = find(win.el, i => i.tag === 'button' && i.text === t('ui.topic_chat_choice_cancel'));
  cancel.click(); await tick();
  assert.equal(h.entry('root').session.choice, null);
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_choice_cancelled'));
  assert.deepEqual([steps.length, research.length, h.control.usageAsks], [0, 0, asks]);
  assert.deepEqual(await topicLines(h, 'root'), null, 'no record file line');
  assert.equal(find(win.el, i => i.attrs?.role === 'radiogroup'), undefined, 'the card is gone');
  assert.ok(h.page.doc.activeElement === find(win.el, i => i.tag === 'textarea'), 'the focus is back in the input');
});

integrationTest('topic chat depth card: a one-level subtree shows no card and starts as before', async () => {
  const h = await harness(); h.flatten(); await researched(h); const { steps } = stubChain(h);
  assert.equal(await h.host('root').submit('synthesize', 'x'), true);
  assert.equal(h.entry('root').session.choice ?? null, null); await waitFor(() => steps.length === 1);
});

integrationTest('topic chat depth card keyboard: arrows switch (wrapping), Enter starts, Escape cancels and the input gets the focus, the card has a name and states', async () => {
  const h = await harness(); await deepen(h); const { steps } = stubChain(h);
  const host = h.host('root'); await host.submit('synthesize', 'all');
  const win = h.win(); const radios = () => findAll(win.el, i => i.attrs?.role === 'radio');
  const group = find(win.el, i => i.attrs?.role === 'radiogroup');
  assert.ok(find(win.el, i => i.attrs?.id === group.attrs['aria-labelledby']).text.includes('3'), 'the group is named by the question');
  for (const r of radios()) { assert.ok(find(win.el, i => i.attrs?.id === r.attrs['aria-labelledby'])?.text, 'each option has a name'); assert.ok(find(win.el, i => i.attrs?.id === r.attrs['aria-describedby'])?.text.includes('AI'), 'and a description'); }
  assert.ok(h.page.doc.activeElement === radios()[0], 'the selected option holds the focus when the card appears');
  radios()[0].keydown({ key: 'ArrowDown' });
  assert.equal(h.entry('root').session.choice.selected, 'bottom-up');
  assert.ok(h.page.doc.activeElement === radios()[1], 'the focus follows the selection after the repaint');
  assert.deepEqual(radios().map(r => [r.attrs['aria-checked'], r.attrs.tabindex]), [['false', '-1'], ['true', '0'], ['false', '-1']]);
  radios()[1].keydown({ key: 'ArrowUp' }); radios()[0].keydown({ key: 'ArrowUp' });
  assert.equal(h.entry('root').session.choice.selected, 'research-first', 'wraps around');
  win.el.fire('keydown', { key: 'Escape' });
  assert.equal(h.entry('root').session.choice, null, 'Escape cancels the card first'); assert.ok(h.view.topicChatOpen?.win === win, 'the window stays');
  assert.ok(h.page.doc.activeElement === find(win.el, i => i.tag === 'textarea'), 'Escape: the focus is in the input');
  await host.submit('synthesize', 'again');
  radios()[0].keydown({ key: 'Enter' }); await waitFor(() => steps.length > 0 && !h.entry('root').session.running);
  assert.equal(steps.at(-1).key, 'root');
});

integrationTest('topic chat quick: the direct subtopic with subtopics integrates its own subtopics locally first, then the root; no research', async () => {
  const h = await harness(); await deepen(h); await researched(h); const { steps, research } = stubChain(h);
  const text = await startDeep(h, 'quick', { mode: 'standard' });
  assert.deepEqual(steps.map(s => s.key), ['a', 'root']); assert.equal(research.length, 0, 'no web research');
  assert.equal(steps[0].options.researchMode, 'local', 'the middle step never goes to the web'); assert.equal(steps[1].options.researchMode, 'research', 'the root runs in the chat mode as before');
  assert.equal(steps[1].direction, 'all');
  assert.equal(text, t('ui.topic_chat_subtree_done_0_1_2', 4, 0, 2));
});

integrationTest('topic chat quick: a childless unresearched direct subtopic is researched as before, then the integrations', async () => {
  const h = await harness(); await deepen(h); const { steps, research } = stubChain(h);
  await startDeep(h, 'quick');
  assert.deepEqual(research.map(r => r.key), ['b']); assert.deepEqual(steps.map(s => s.key), ['a', 'root']);
});

integrationTest('topic chat bottom-up: deepest parent first, the root last, no research; the sentence counts what was read, not researched and rewritten', async () => {
  const h = await harness(); await deepen(h); const { steps, research } = stubChain(h);
  const text = await startDeep(h, 'bottom-up');
  assert.deepEqual(steps.map(s => s.key), ['c', 'a', 'root']); assert.equal(research.length, 0);
  assert.ok(steps.slice(0, 2).every(s => s.options.researchMode === 'local' && s.direction === ''));
  assert.equal(text, t('ui.topic_chat_subtree_done_0_1_2', 4, 4, 3));
});

integrationTest('topic chat research-first: the unresearched leaves are researched in the chat mode (deepest first), then bottom-up', async () => {
  const h = await harness(); await deepen(h); const { steps, research } = stubChain(h);
  await startDeep(h, 'research-first', { mode: 'standard' });
  assert.deepEqual(research.map(r => r.key), ['deep', 'b']); assert.ok(research.every(r => r.mode === 'research'));
  assert.deepEqual(steps.map(s => s.key), ['c', 'a', 'root']);
});

integrationTest('topic chat chain: a stop in the middle writes nothing for the steps not run and says how far it got', async () => {
  const h = await harness(); await deepen(h);
  const { steps } = stubChain(h, key => { if (key === 'a') h.entry('root').controller.abort(); return key !== 'a'; });
  const text = await startDeep(h, 'bottom-up');
  assert.deepEqual(steps.map(s => s.key), ['c', 'a'], 'the root never started');
  assert.equal(text, t('ui.topic_chat_subtree_stopped_0_1', 1, 3));
  assert.equal((await topicLines(h, 'root')).at(-1).status, 'stopped');
});

integrationTest('topic chat chain: an AI lock that appears mid-chain stops before the next step', async () => {
  const h = await harness(); await deepen(h);
  const { steps } = stubChain(h, key => { if (key === 'c') return h.repo.writeAiLocked(h.node('a').path, true).then(() => true); return true; });
  const text = await startDeep(h, 'bottom-up');
  assert.deepEqual(steps.map(s => s.key), ['c'], 'a locked topic and everything after it do not run');
  assert.equal(text, t('ui.topic_chat_subtree_stopped_0_1', 1, 3));
});

integrationTest('topic chat chain: a topic deleted mid-chain is skipped, the others run', async () => {
  const h = await harness(); await deepen(h);
  const { steps } = stubChain(h, key => { if (key === 'c') h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.a); return true; });
  await startDeep(h, 'bottom-up');
  assert.deepEqual(steps.map(s => s.key), ['c', 'root']);
});

integrationTest('topic chat chain: a topic that is busy elsewhere is skipped, not waited for', async () => {
  const h = await harness(); await deepen(h); const { steps } = stubChain(h);
  h.plugin.quickExpandPending.add(h.node('c').path);
  await startDeep(h, 'bottom-up');
  assert.deepEqual(steps.map(s => s.key), ['a', 'root']);
});

integrationTest('topic chat chain: one step that fails does not stop the chain; the sentence counts only what was rewritten', async () => {
  const h = await harness(); await deepen(h); const { steps } = stubChain(h, key => key !== 'c');
  const text = await startDeep(h, 'bottom-up');
  assert.deepEqual(steps.map(s => s.key), ['c', 'a', 'root']);
  assert.equal(text, t('ui.topic_chat_subtree_done_0_1_2', 4, 4, 2));
});

integrationTest('topic chat chain: when every step fails the root is not integrated and one sentence says so', async () => {
  const h = await harness(); await deepen(h); const { steps } = stubChain(h, () => false);
  const text = await startDeep(h, 'bottom-up');
  assert.deepEqual(steps.map(s => s.key), ['c', 'a']);
  assert.equal(text, t('ui.topic_chat_failed_0', t('ui.topic_chat_failed_subtree')));
  assert.equal((await topicLines(h, 'root')).at(-1).status, 'failed');
});

integrationTest('topic chat chain: a view that closed mid-chain stops it and a late result is not written into the session or the record', async () => {
  const h = await harness(); await deepen(h);
  const { steps } = stubChain(h, key => { if (key === 'c') h.view.closed = true; return true; });
  const host = h.host('root'); await host.submit('synthesize', 'all'); host.chooseDepth('bottom-up');
  const turnsBefore = h.entry('root').session.turns.length;
  await host.confirmChoice(); await waitFor(() => !h.entry('root').session.running);
  assert.deepEqual(steps.map(s => s.key), ['c']);
  assert.equal(h.entry('root').session.turns.length, turnsBefore, 'no sentence in the closed chat');
  assert.equal((await topicLines(h, 'root'))?.some(l => l.type === 'result') ?? false, false);
});

integrationTest('topic chat chain: additions typed during the chain wait and go into the root integration once', async () => {
  const h = await harness(); await deepen(h);
  const { steps } = stubChain(h, key => { if (key === 'c') h.host('root').steer('also this'); return true; });
  await startDeep(h, 'bottom-up');
  assert.equal(steps.at(-1).direction, 'all\n\nalso this'); assert.ok(steps.slice(0, 2).every(s => s.direction === ''));
});
