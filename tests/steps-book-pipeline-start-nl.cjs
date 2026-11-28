// V3.3 P5.1a (G02): the start card asks for the book in plain words on top and folds the models and six settings into a closed
// "Advanced settings". Unit level on a stand-in DOM; the real look (open, fold, focus, themes, languages, narrow window) is UI evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

class OptionStub { constructor(text, value) { const o = dom.element('option', { text }); o.optionValue = value; o.value = value; o.disabled = false; return o; } }
const bundle = loadSource(`
export { BookStartModal, bookSettingsPatch } from "./experiences/visual-map/book-pipeline-start-modal";
export { setUiLanguage, t } from "./i18n";
`, { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Option: OptionStub, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
bundle.setUiLanguage('zh-TW');

const SUGGEST = { reader: '建議讀者', goal: '建議目標', angle: '建議角度', tone: '建議語氣', length: '建議篇幅', style: '建議風格' };
const shown = el => { for (let n = el; n; n = n.parent) if (n.hidden || (n.tag === 'details' && !n.open)) return false; return true; };
const field = (modal, label) => dom.findAll(modal.modalEl, i => i.tag === 'textarea').find(f => f.attrs['aria-label'] === label);
const byCls = (modal, cls) => dom.findAll(modal.modalEl, i => (i.cls ?? '').split(/\s+/).includes(cls));
const chatInput = modal => dom.findAll(modal.modalEl, i => i.tag === 'input' && i.attrs.id === 'vam-book-chat-input')[0];
const say = async (modal, text) => {
  chatInput(modal).value = text; chatInput(modal).fire('input');
  byCls(modal, 'vam-book-chat-send')[0].click();
  await dom.tick(); await dom.tick();
};
const type = (modal, label, text) => { const f = field(modal, label); f.value = text; f.fire('input'); };
const card = ({ edit, settings = {}, onStart = () => {} } = {}) => {
  const modal = new bundle.BookStartModal({}, {
    cards: 3, trialCards: 2,
    models: { plan: 'a', write: 'b', images: 'c', proof: 'd' },
    modelChoice: { options: () => ['a', 'b', 'c', 'd', 'e'], label: x => x, onChange() {} },
    settings,
    ...(edit ? { editSettings: edit } : {}),
    onStart
  });
  modal.open();
  return modal;
};

test('start nl: with the chief editor the request box is on top, then the new intro and the estimate; the four models and six settings sit in a closed "Advanced settings" and show when it is opened', () => {
  const modal = card({ edit: async () => ({ reply: 'ok', changes: {} }) });
  const order = dom.findAll(modal.modalEl, () => true);
  const at = pred => order.findIndex(pred);
  const iAsk = at(i => i.cls.includes('vam-book-start-ask')), iIntro = at(i => i.cls.includes('vam-modal-intro'));
  const iEst = at(i => i.cls.includes('vam-book-start-estimate')), iAdv = at(i => i.tag === 'details');
  assert.ok(iAsk >= 0 && iAsk < iIntro && iIntro < iEst && iEst < iAdv, [iAsk, iIntro, iEst, iAdv].join(','));
  assert.ok(dom.texts(modal.modalEl).includes('想要什麼樣的書？用一兩句話說'));
  assert.ok(dom.texts(modal.modalEl).includes('AI 會照這段話填好全書設定；企劃好後停下來讓你看方向。'));
  assert.ok(shown(chatInput(modal)), 'the request box is on screen');
  const details = dom.findAll(modal.modalEl, i => i.tag === 'details');
  assert.equal(details.length, 1);
  assert.equal(details[0].open, false, 'closed by default');
  assert.equal(details[0].children[0].tag, 'summary');
  assert.equal(details[0].children[0].text, '進階設定（模型、讀者、語氣…六項）');
  const areas = dom.findAll(modal.modalEl, i => i.tag === 'textarea');
  const selects = dom.findAll(modal.modalEl, i => i.tag === 'select');
  assert.equal(areas.length, 6); assert.equal(selects.length, 4);
  for (const el of [...areas, ...selects]) assert.ok(!shown(el), 'hidden while folded');
  assert.ok(shown(dom.find(modal.modalEl, i => i.cls.includes('vam-book-start-estimate'))), 'the estimate stays outside the fold');
  details[0].open = true;
  for (const el of [...areas, ...selects]) assert.ok(shown(el), 'shown once opened');
  assert.equal(dom.focusedNow().text, '取消', 'the keyboard still starts on Cancel');
  modal.close();
});

test('start nl: without editSettings there is no request box and no fold: the card is as before (old intro, everything open)', () => {
  const modal = card();
  assert.equal(chatInput(modal), undefined);
  assert.equal(byCls(modal, 'vam-book-start-ask').length, 0);
  assert.equal(dom.find(modal.modalEl, i => i.tag === 'details'), undefined);
  assert.ok(dom.texts(modal.modalEl).includes('AI 會企劃、寫作、找圖、校對每一章；企劃好後停下來讓你看方向。'));
  for (const el of dom.findAll(modal.modalEl, i => i.tag === 'textarea' || i.tag === 'select')) assert.ok(shown(el));
  modal.close();
});

test('start nl: a sentence fills only the fields the owner left empty: prefilled and hand-typed text stays, the reply says which were kept, the editor may rewrite its own values', async () => {
  const answers = [
    { reply: '好', changes: { reader: 'AI 讀者', goal: 'AI 目標', tone: 'AI 語氣', length: 'AI 篇幅' } },
    { reply: '再改', changes: { goal: 'AI 目標二', length: 'AI 篇幅二' } }
  ];
  const sent = [];
  const modal = card({ settings: { reader: '原本的讀者' }, edit: async request => { sent.push(request); return answers[sent.length - 1]; } });
  modal.setSuggestions(SUGGEST);
  type(modal, '語氣', '我手打的語氣');
  await say(modal, '給國中生看的、輕鬆的');
  assert.equal(field(modal, '讀者').value, '原本的讀者', 'prefilled value kept');
  assert.equal(field(modal, '語氣').value, '我手打的語氣', 'hand-typed value kept');
  assert.equal(field(modal, '學習目標').value, 'AI 目標', 'an empty field (grey suggestion) is filled');
  assert.equal(field(modal, '每章字數').value, 'AI 篇幅');
  assert.equal(byCls(modal, 'vam-book-chat-kept')[0].text, '你已填的沒有改：讀者、語氣。要改請打開「進階設定」');
  assert.equal(byCls(modal, 'vam-book-start-edited').length, 2, 'only the filled fields are marked');
  // The editor's own values are not the owner's: the next turn may change them, but a hand edit since is kept.
  type(modal, '每章字數', '我改的篇幅');
  await say(modal, '目標再具體一點');
  assert.equal(sent[1].turns[0].editor, '好 （使用者已填，未改：讀者、語氣）', 'the next turn\'s history tells the editor which fields stayed');
  assert.equal(field(modal, '學習目標').value, 'AI 目標二');
  assert.equal(field(modal, '每章字數').value, '我改的篇幅');
  assert.equal(byCls(modal, 'vam-book-chat-kept')[1].text, '你已填的沒有改：每章字數。要改請打開「進階設定」');
  // Undo of the first turn puts back only what it wrote and is still there (goal now holds the second turn's text).
  byCls(modal, 'vam-book-chat-undo')[0].click();
  assert.equal(field(modal, '學習目標').value, 'AI 目標二');
  assert.equal(field(modal, '語氣').value, '我手打的語氣');
  modal.close();
});

test('start nl: Start sends the same patch and models as the card without the request box, for the same hand edits, cleared field, suggestions and model pick', () => {
  const run = edit => {
    const got = [];
    const modal = card({ edit, settings: { reader: '原本的讀者', style: '原本的風格' }, onStart: (patch, models) => got.push({ patch, models }) });
    modal.setSuggestions(SUGGEST);
    for (const d of dom.findAll(modal.modalEl, i => i.tag === 'details')) d.open = true;
    type(modal, '語氣', '手打語氣');
    type(modal, '寫作風格', '');
    const select = dom.findAll(modal.modalEl, i => i.tag === 'select')[1];
    select.value = 'e'; select.fire('change');
    dom.findAll(modal.modalEl, i => i.tag === 'button').find(b => b.text === '開始').click();
    return got;
  };
  const folded = run(async () => ({ reply: 'ok', changes: {} }));
  const plain = run(undefined);
  assert.equal(folded.length, 1);
  assert.deepEqual(folded, plain);
  const expected = bundle.bookSettingsPatch({ reader: '原本的讀者', style: '原本的風格' }, { reader: '原本的讀者', goal: '', angle: '', tone: '手打語氣', length: '', style: '' }, SUGGEST);
  assert.deepEqual(folded[0].patch, expected);
  assert.equal(folded[0].patch.style, null, 'a cleared field is removed');
  assert.equal(folded[0].patch.goal, SUGGEST.goal, 'an empty field takes its suggestion');
  assert.equal(folded[0].models.write, 'e');
});

test('start nl: three languages carry the new lines (the kept list uses each language\'s separator); the fold and the request box have VAM-scoped CSS (focus ring on the summary)', async () => {
  for (const [lang, adv] of [['en', /^Advanced settings/], ['zh-CN', /^高级设置/], ['zh-TW', /^進階設定/]]) {
    bundle.setUiLanguage(lang);
    assert.match(bundle.t('ui.book_start_advanced'), adv);
    assert.ok(bundle.t('ui.book_start_intro_ask'));
    assert.match(bundle.t('ui.book_chat_kept_0', 'X'), /X/);
    assert.match(bundle.t('ui.book_chat_kept_turn_0', 'X'), /X/);
    assert.notEqual(bundle.t('ui.book_start_suggesting_ask'), bundle.t('ui.book_start_suggesting'));
  }
  bundle.setUiLanguage('en');
  const en = card({ settings: { reader: 'Mine', tone: 'Mine too' }, edit: async () => ({ reply: 'ok', changes: { reader: 'x', tone: 'y' } }) });
  en.setSuggestions({});
  await say(en, 'kids');
  assert.equal(byCls(en, 'vam-book-chat-kept')[0].text, 'Kept what you filled in: Reader, Tone. To change them, open Advanced settings');
  en.close();
  bundle.setUiLanguage('zh-TW');
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.vam-book-start-advanced > summary:focus-visible \{[^}]*outline/);
  assert.match(css, /\.vam-book-start-ask \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

test('start nl: while the suggestions load, the line under the request box says Send waits; the card without the box keeps the old line', () => {
  const ask = card({ edit: async () => ({ reply: 'ok', changes: {} }) });
  const box = dom.find(ask.modalEl, i => i.cls.includes('vam-book-start-ask'));
  assert.ok(dom.texts(box).includes('AI 正在想建議，好了就能送出'));
  ask.close();
  const plain = card();
  assert.ok(dom.texts(plain.modalEl).includes('AI 正在依主題想建議，好了會自動填進下面的框'));
  plain.close();
});

test('start nl: undo of a later turn puts back the earlier turn\'s editor value as the editor\'s, so a third turn may still change it (no kept line)', async () => {
  const answers = [{ reply: 'a', changes: { goal: 'A' } }, { reply: 'b', changes: { goal: 'B' } }, { reply: 'c', changes: { goal: 'C' } }];
  let n = 0;
  const modal = card({ edit: async () => answers[n++] });
  modal.setSuggestions(SUGGEST);
  await say(modal, 'one'); await say(modal, 'two');
  byCls(modal, 'vam-book-chat-undo')[1].click();
  assert.equal(field(modal, '學習目標').value, 'A');
  assert.equal(byCls(modal, 'vam-book-start-edited').length, 1, 'the field is still marked as the editor\'s');
  await say(modal, 'three');
  assert.equal(field(modal, '學習目標').value, 'C');
  assert.equal(byCls(modal, 'vam-book-chat-kept').length, 0);
  modal.close();
});
