// Living Node UI gaps: the reader's localized lines, the copy and share handling of the persisted reason, and the setup
// window's own failure box, per-source re-confirm and language relabel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;

const markdown = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
const region = S.load('core/living-node-region.ts');
const scan = S.load('experiences/sharing/share-leak-scan.ts');
const ui = require('./support-replay.cjs').loadSource(`
export { AiCardPopover } from "./experiences/visual-map/ai-card-popover";
export { setUiLanguage, getUiLanguage } from "./i18n";
`, { obsidian: S.obsidian });
const { AiCardPopover } = ui;
const plain = x => JSON.parse(JSON.stringify(x));

// ---- the reader ----------------------------------------------------------------------------------------------------
const labels = { aiLatest: 'AI 最新成果', source: (title, date) => `來源：${title}（${date}）`, generated: at => `產生時間：${at}` };
const BEGIN = '<!-- vam-living-node:begin v1 -->', END = '<!-- vam-living-node:end v1 -->';
const sourceLine = (source, at) => `- Source: ${JSON.stringify(['e1', source, at])}`;
const managed = [
  BEGIN, '### AI latest', '- Generated: "2026-11-27T06:00:00.000Z"', '', '#### Evidence',
  sourceLine('https://www.example.com/a?x=1', '2026-11-26T08:00:00Z'), sourceLine('Notes/Own [x].md', 'not a date'), END
].join('\n');

test('reader: source lines read "title (date)" with a link for a public page; the heading and generated time are localized', () => {
  const shown = markdown.localizeLivingReader('# Mine\n\n### AI latest\n- Source: ["mine"]\n\n' + managed + '\n\nafter', labels);
  assert.ok(shown.startsWith('# Mine\n\n### AI latest\n- Source: ["mine"]\n'), 'text outside the managed region is the owner\'s');
  assert.ok(shown.includes('\n### AI 最新成果\n'));
  assert.ok(shown.includes('- 產生時間：2026-11-27T06:00:00.000Z'));
  assert.ok(shown.includes('- 來源：[example.com](<https://www.example.com/a?x=1>)（2026-11-26）'));
  assert.ok(shown.includes('- 來源：Notes/Own \\[x\\].md（not a date）'), 'a non-web source is plain escaped text; a non-date is kept as is');
  assert.ok(shown.endsWith('\n\nafter'));
});

test('reader: a line that is not in the written format is left alone; without a managed region the note is untouched', () => {
  const odd = [BEGIN, '- Source: ["only","two"]', '- Source: not json', '- Generated: 5', END].join('\n');
  assert.equal(markdown.localizeLivingReader(odd, labels), odd);
  assert.equal(markdown.localizeLivingReader('### AI latest\n' + sourceLine('a', '2026-01-01'), labels), '### AI latest\n' + sourceLine('a', '2026-01-01'));
  const javascript = markdown.localizeLivingReader([BEGIN, sourceLine('javascript:alert(1)', '2026-01-01'), END].join('\n'), labels);
  assert.equal(javascript.includes('](<'), false, 'only an allowed web address becomes a link');
});

test('reader: a trial preview has no markers and is localized whole', () => {
  const preview = '### AI latest\n' + sourceLine('https://example.com/x', '2026-02-03T00:00:00Z');
  const shown = markdown.localizeLivingReader(preview, labels, true);
  assert.ok(shown.startsWith('### AI 最新成果\n- 來源：[example.com]'));
  assert.equal(markdown.localizeLivingReader(preview, labels), preview, 'the same text without `whole` is not a region');
});

// ---- the persisted reason is internal -----------------------------------------------------------------------------------
test('reason: a copied card starts without the reason, and it is an internal field the share scan knows', () => {
  const metadata = { 'ai-card': true, 'living-node-ownership': 'x', 'living-node-outcome': 'failed', 'living-node-reason': 'failed', 'living-node-last-attempt': 't' };
  try { region.resetLivingCopyDiagnostics(metadata); } catch { /* the ownership check is not under test */ }
  assert.equal('living-node-reason' in metadata, false);
  assert.equal('living-node-outcome' in metadata, false);
  assert.ok(plain(scan.INTERNAL_FIELD_NAMES).includes('living-node-reason'));
});

// ---- the setup window ------------------------------------------------------------------------------------------------
function open(overrides = {}) {
  const calls = { save: [], trial: 0, cancel: 0 };
  const host = {
    cardTitle: null, initial: { question: 'Why?', sources: ['Ref'], keepOld: true },
    anchor: () => null, pickNote() {}, cancel: () => { calls.cancel++; },
    save: async values => { calls.save.push(values); return true; },
    trial: async () => { calls.trial++; return true; },
    ...overrides
  };
  const parent = element('div');
  const win = new AiCardPopover(host, parent);
  return { win, calls, el: win.el };
}
const alertBox = el => find(el, i => i.attrs?.role === 'alert');

test('setup window: a failed trial is shown inside the window as an alert with the reason and a retry that tries again', async () => {
  const { win, calls, el } = open();
  assert.equal(alertBox(el).hidden, true, 'nothing to say before a failure');
  win.showTrialFailure('Provider said no');
  const box = alertBox(el);
  assert.equal(box.hidden, false);
  assert.ok(findAll(box, i => i.text === 'Provider said no').length === 1);
  const retry = find(box, i => i.tag === 'button');
  assert.ok(retry, 'there is a retry button');
  assert.equal(dom.focusedNow(), retry, 'the keyboard lands on the retry');
  retry.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.trial, 1);
  assert.equal(alertBox(el).hidden, true, 'a new try clears the old failure');
});

test('setup window: editing the question clears the failure; destroyed windows ignore late failures', () => {
  const { win, el } = open();
  win.showTrialFailure('x');
  const question = find(el, i => i.tag === 'textarea');
  question.value = 'Why again?';
  question.input();
  assert.equal(alertBox(el).hidden, true);
  win.destroy();
  assert.doesNotThrow(() => win.showTrialFailure('late'));
});

test('setup window: a replaced source offers "Confirm again"; choosing it is saved as a reconfirm, then the mark is gone', async () => {
  const { win, calls, el } = open({ initial: { question: 'Why?', sources: ['Ref', 'Other'], keepOld: true } });
  win.markReplaced(['Ref']);
  const confirms = findAll(el, i => i.hasClass?.('vam-ai-card-pop-chip-confirm'));
  assert.equal(confirms.length, 1, 'only the replaced source has one');
  assert.equal(confirms[0].text, 'Confirm again');
  assert.equal(win.values().reconfirm, undefined, 'nothing is confirmed until the user chooses it');
  confirms[0].click();
  assert.deepEqual(plain(win.values().reconfirm), ['Ref']);
  assert.equal(findAll(el, i => i.hasClass?.('vam-ai-card-pop-chip-confirm')).length, 0);
  const save = find(el, i => i.tag === 'button' && i.text === 'Save');
  save.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(plain(calls.save[0].reconfirm), ['Ref']);
  assert.equal(win.values().reconfirm, undefined, 'after a saved confirm the window no longer carries it');
});

test('setup window: a refused save keeps the confirm for another try; removing the source drops it', async () => {
  const { win, el } = open({ save: async () => false });
  win.markReplaced(['Ref']);
  find(el, i => i.hasClass?.('vam-ai-card-pop-chip-confirm')).click();
  find(el, i => i.tag === 'button' && i.text === 'Save').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(plain(win.values().reconfirm), ['Ref']);
  find(el, i => i.tag === 'button' && i.attrs?.['aria-label']?.includes('Ref') && i.text === '×').click();
  assert.equal(win.values().reconfirm, undefined);
});

test('setup window: relabel sets the fixed words again and keeps the draft', () => {
  ui.setUiLanguage('en');
  const { win, el } = open();
  const question = find(el, i => i.tag === 'textarea');
  question.value = 'My draft';
  const save = () => find(el, i => i.tag === 'button' && i.hasClass?.('mod-cta')).text;
  assert.equal(save(), 'Save');
  ui.setUiLanguage('zh-TW');
  try {
    win.relabel();
    assert.notEqual(save(), 'Save');
    assert.equal(question.value, 'My draft');
  } finally { ui.setUiLanguage('en'); }
});
