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
export { setUiLanguage, getUiLanguage, t } from "./i18n";
`, { obsidian: S.obsidian });
const { AiCardPopover } = ui;
const plain = x => JSON.parse(JSON.stringify(x));

// ---- the reader ----------------------------------------------------------------------------------------------------
const labels = { aiLatest: 'AI 最新成果', source: (title, date) => `來源：${title}（${date}）`, generated: at => `產生時間：${at}`, date: (iso, time) => `D(${iso}${time ? ',t' : ''})` };
const BEGIN = '<!-- vam-living-node:begin v1 -->', END = '<!-- vam-living-node:end v1 -->';
const sourceLine = (source, at) => `- Source: ${JSON.stringify(['e1', source, at])}`;
const managed = [
  BEGIN, '### AI latest', '- Ownership: "ai"', '- Generated: "2026-11-27T06:00:00.000Z"', '', '#### Evidence',
  sourceLine('https://www.example.com/a?x=1', '2026-11-26T08:00:00Z'), sourceLine('Notes/Own [x].md', 'not a date'), END
].join('\n');

test('reader: source lines read "title (date)" with a link for a public page; the heading and generated time are localized', () => {
  const shown = markdown.localizeLivingReader('# Mine\n\n### AI latest\n- Source: ["mine"]\n\n' + managed + '\n\nafter', labels);
  assert.ok(shown.startsWith('# Mine\n\n### AI latest\n- Source: ["mine"]\n'), 'text outside the managed region is the owner\'s');
  assert.ok(shown.includes('\n### AI 最新成果\n'));
  assert.ok(shown.includes('- 產生時間：D(2026-11-27T06:00:00.000Z,t)'), 'the generated time is a readable date, not raw ISO');
  assert.equal(shown.includes('Ownership'), false, 'the internal ownership line is hidden');
  assert.ok(shown.includes('- 來源：[example.com](<https://www.example.com/a?x=1>)（D(2026-11-26T08:00:00Z)）'));
  assert.ok(shown.includes('- 來源：Notes/Own \\[x\\].md（not a date）'), 'a non-web source is plain escaped text; a non-date is kept as is');
  assert.ok(shown.endsWith('\n\nafter'));
});

test('reader: a line that is not in the written format is left alone; without a managed region the note is untouched', () => {
  const noDate = markdown.localizeLivingReader(managed, { aiLatest: 'X', source: (a, b) => `${a}|${b}`, generated: at => at });
  assert.equal(noDate.includes('Ownership'), false);
  const odd = [BEGIN, '- Source: ["only","two"]', '- Source: not json', '- Generated: 5', END].join('\n');
  assert.equal(markdown.localizeLivingReader(odd, labels), odd);
  assert.equal(markdown.localizeLivingReader('### AI latest\n' + sourceLine('a', '2026-01-01'), labels), '### AI latest\n' + sourceLine('a', '2026-01-01'));
  const javascript = markdown.localizeLivingReader([BEGIN, sourceLine('javascript:alert(1)', '2026-01-01'), END].join('\n'), labels);
  assert.equal(javascript.includes('](<'), false, 'only an allowed web address becomes a link');
});

test('reader: the Suppression section and its hold lines are hidden; the note file text is not changed', () => {
  const hold = '- Suppression v2: "abc@v2:' + 'a'.repeat(64) + '"';
  const note = [BEGIN, '### AI latest', '- Ownership: "ai"', '', '### Suppression', '- ID: "recD"', hold, '', END, '', 'after'].join('\n');
  const shown = markdown.localizeLivingReader(note, labels);
  for (const word of ['Suppression', '@v2', 'recD', 'Ownership']) assert.equal(shown.includes(word), false, word);
  assert.ok(shown.includes('AI 最新成果') && shown.endsWith('\n\nafter'));
  const preview = markdown.localizeLivingReader(['### AI latest', '', '### Suppression', '- ID: "recD"'].join('\n'), labels, true);
  assert.equal(/Suppression|recD/.test(preview), false, 'a trial preview too');
});

test('reader view: a language change repaints the tab labels', async () => {
  const sourceView = require('./support-replay.cjs').loadSource(`
export { LivingReaderView } from "./experiences/visual-map/living-node-reader";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Component: class { load() {} unload() {} }, ItemView: class { constructor() { this.contentEl = element('div'); this.app = { vault: { read: async () => '' } }; } }, MarkdownRenderer: { render: async () => {} } } });
  sourceView.setUiLanguage('en');
  try {
    const view = new sourceView.LivingReaderView({});
    await view.show({ path: 'a.md' }, 'preview', 'owner');
    const tabs = () => findAll(view.contentEl, i => i.tag === 'button' && i.attrs?.role === 'tab').map(i => i.text);
    eq2(tabs(), ['Official', 'Trial']);
    sourceView.setUiLanguage('zh-TW');
    view.refreshLanguage();
    await new Promise(resolve => setTimeout(resolve, 0));
    eq2(tabs(), ['正式內容', '試跑']);
  } finally { sourceView.setUiLanguage('en'); }
  // The plugin tells every open reader when the language changes.
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.ts'), 'utf8');
  assert.match(main, /refreshLocalizedEntrypoints\(\): void \{[\s\S]*?getLeavesOfType\(LIVING_READER_VIEW\)[\s\S]*?refreshLanguage\(\)/);
});
const eq2 = (actual, expected) => assert.deepEqual(plain(actual), expected);

test('reader: a trial preview has no markers and is localized whole', () => {
  const preview = '### AI latest\n' + sourceLine('https://example.com/x', '2026-02-03T00:00:00Z');
  const shown = markdown.localizeLivingReader(preview, labels, true);
  assert.ok(shown.startsWith('### AI 最新成果\n- 來源：[example.com]'));
  assert.equal(markdown.localizeLivingReader(preview, labels), preview, 'the same text without `whole` is not a region');
});

test('reader: readableDate follows the language and the zone; a non-date is kept as is', () => {
  const en = markdown.readableDate('2026-11-27T06:00:00.000Z', 'en', true, 'UTC');
  const zh = markdown.readableDate('2026-11-27T06:00:00.000Z', 'zh-TW', true, 'UTC');
  assert.notEqual(en, zh);
  assert.ok(!en.includes('T06:00') && /2026/.test(en) && /06:00|6:00/.test(en), en);
  assert.ok(!/\d{2}:\d{2}/.test(markdown.readableDate('2026-11-27T06:00:00.000Z', 'en', false, 'UTC')), 'a date-only form has no time');
  assert.equal(markdown.readableDate('not a date', 'en', true), 'not a date');
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
  const doc = { activeElement: null };
  parent.root = doc;
  const win = new AiCardPopover(host, parent);
  win.el.ownerDocument = doc;
  return { win, calls, el: win.el };
}
const alertBox = el => find(el, i => i.attrs?.role === 'alert');

test('setup window: a failed trial is shown inside the window as an alert with the reason and a retry that tries again', async () => {
  const { win, calls, el } = open();
  assert.equal(alertBox(el).hidden, true, 'nothing to say before a failure');
  win.showTrialFailure('ui.living_node_trial_reason_provider');
  const box = alertBox(el);
  assert.equal(box.hidden, false);
  assert.ok(findAll(box, i => i.text === ui.t('ui.living_node_trial_reason_provider')).length === 1);
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
  win.showTrialFailure('ui.living_node_trial_reason_provider');
  const question = find(el, i => i.tag === 'textarea');
  question.value = 'Why again?';
  question.input();
  assert.equal(alertBox(el).hidden, true);
  win.destroy();
  assert.doesNotThrow(() => win.showTrialFailure('ui.living_node_trial_reason_provider'));
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

test('setup window: a relabel puts the focus back on the equivalent rebuilt control (retry, Confirm again), not the question field', () => {
  ui.setUiLanguage('en');
  const { win, el } = open({ initial: { question: 'Why?', sources: ['Ref', 'Other'], keepOld: true } });
  win.markReplaced(['Other']);
  try {
    const confirm = find(el, i => i.hasClass?.('vam-ai-card-pop-chip-confirm'));
    confirm.focus();
    win.relabel();
    const again = find(el, i => i.hasClass?.('vam-ai-card-pop-chip-confirm'));
    assert.notEqual(again, confirm, 'the chip was rebuilt');
    assert.equal(dom.focusedNow(), again, 'the keyboard is on the rebuilt Confirm again');
    win.showTrialFailure('ui.living_node_trial_reason_provider');
    const retry = find(alertBox(el), i => i.tag === 'button');
    assert.equal(dom.focusedNow(), retry);
    win.relabel();
    const retryAgain = find(alertBox(el), i => i.tag === 'button');
    assert.notEqual(retryAgain, retry);
    assert.equal(dom.focusedNow(), retryAgain, 'the keyboard stays on the retry');
  } finally { ui.setUiLanguage('en'); }
});

// ---- the trial failure reason -----------------------------------------------------------------------------------------
const reasonModule = require('./support-replay.cjs').loadSource(`
export { livingTrialReason } from "./experiences/visual-map/living-node-trial-reason";
export { LivingTrial } from "./experiences/visual-map/living-node-trial";
export { setUiLanguage, t } from "./i18n";
export { searchNotPerformedError } from "./ai/search-not-performed";
export { livingSnapshotRevision } from "./experiences/visual-map/living-node-markdown";
`, { obsidian: S.obsidian });

test('trial failure: a provider error and a validation error each give a short reason, with the raw code only as a detail', () => {
  reasonModule.setUiLanguage('en');
  const provider = reasonModule.livingTrialReason(new Error('Request to /Users/me/secret prompt "my private question" failed'));
  assert.equal(provider.reason, 'The AI provider failed or did not answer.');
  assert.equal(provider.code, '', 'free-form error text is never passed on');
  assert.equal(reasonModule.livingTrialReason(new Error('Request timed out')).reason, 'The AI took too long and timed out.');
  const web = reasonModule.livingTrialReason(new Error('required-web-unavailable'));
  assert.match(web.reason, /web search/);
  assert.equal(web.code, 'required-web-unavailable');
  // D1-x5: a runtime's "the search did not happen" error is a web reason, not a provider failure; its sentence is not a code.
  const notSearched = reasonModule.livingTrialReason(reasonModule.searchNotPerformedError());
  assert.equal(notSearched.key, 'ui.living_node_trial_reason_web');
  assert.equal(notSearched.code, '');
  assert.match(reasonModule.livingTrialReason(new Error('living-node-context-too-large')).reason, /too large/);
  assert.match(reasonModule.livingTrialReason(new Error('stale-base')).reason, /replaced or changed/);
  assert.match(reasonModule.livingTrialReason(new Error('ambiguous-living-node-region')).reason, /markers are damaged/);
  const validation = reasonModule.livingTrialReason(new Error('missing-evidence'));
  assert.equal(validation.reason, 'The AI answer was rejected by validation.');
  assert.equal(validation.code, 'missing-evidence');
  reasonModule.setUiLanguage('zh-TW');
  assert.match(reasonModule.livingTrialReason(new Error('missing-evidence')).reason, /沒有通過檢查/);
  reasonModule.setUiLanguage('zh-CN');
  assert.match(reasonModule.livingTrialReason(new Error('missing-evidence')).reason, /没有通过检查/);
  reasonModule.setUiLanguage('en');
});

test('trial failure: the setup window shows the reason and the code line; a failed run keeps its error code', async () => {
  reasonModule.setUiLanguage('en');
  const { win, el } = open();
  win.showTrialFailure('ui.living_node_trial_reason_validation', 'missing-evidence');
  const box = alertBox(el);
  assert.ok(findAll(box, i => i.text === 'The AI answer was rejected by validation.').length === 1);
  assert.ok(findAll(box, i => i.text === 'Code: missing-evidence').length === 1);
  const lease = { signal: new AbortController().signal, current: () => true, release() {}, stop() {} };
  const trial = new reasonModule.LivingTrial({ acquire: () => lease });
  const ok = await trial.run({
    candidate: { mapId: 'm', viewSession: 's', baseRevision: 'old' }, path: 'a.md', expectedContent: '', base: { revision: 'empty' },
    context: {}, generate: async () => ({}), stillCurrent: async () => true
  });
  assert.equal(ok, false);
  assert.equal(trial.failureCode, 'stale-base');
});

test('trial failure (D1-x5b): a real trial whose runtime did not search ends with the web reason, a generic error with the provider reason', async () => {
  reasonModule.setUiLanguage('en');
  const lease = { signal: new AbortController().signal, current: () => true, release() {}, stop() {} };
  const run = async error => {
    const trial = new reasonModule.LivingTrial({ acquire: () => lease });
    const ok = await trial.run({
      candidate: { mapId: 'm', viewSession: 's', baseRevision: reasonModule.livingSnapshotRevision('') }, path: 'a.md', expectedContent: '', base: { revision: 'empty' },
      context: {}, generate: async () => { throw error; }, stillCurrent: async () => true
    });
    assert.equal(ok, false);
    return reasonModule.livingTrialReason(trial.failure ?? trial.failureCode ?? '');
  };
  const web = await run(reasonModule.searchNotPerformedError());
  assert.equal(web.key, 'ui.living_node_trial_reason_web');
  assert.equal(web.code, '', 'the sentence is never shown as a code');
  const provider = await run(new Error('connect EPROTO /Users/me/secret'));
  assert.equal(provider.key, 'ui.living_node_trial_reason_provider');
  assert.equal(provider.code, '');
  // D1-x11: a network failure is its own class, for the trial; no path or raw text reaches the reason or the code.
  const networkErrors = [new Error('connect ECONNRESET /Users/me/secret'), Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND /Users/me/secret') }), new Error('connect ETIMEDOUT /Users/me/secret')];
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    reasonModule.setUiLanguage(language);
    for (const error of networkErrors) {
      const network = await run(error);
      assert.equal(network.key, 'ui.living_node_trial_reason_network', language + ' ' + error.message);
      assert.equal(network.code, '');
      assert.doesNotMatch(network.reason + network.code, /secret|\/Users|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed/);
      assert.notEqual(network.reason, reasonModule.t('ui.living_node_trial_reason_provider'));
    }
  }
  reasonModule.setUiLanguage('en');
  assert.match((await run(networkErrors[0])).reason, /network/i);
});

test('setup window: an open failure follows a language change (zh-TW, en, zh-CN)', () => {
  ui.setUiLanguage('zh-TW');
  try {
    const { win, el } = open();
    win.showTrialFailure('ui.living_node_trial_reason_provider', 'missing-evidence');
    const reason = () => find(alertBox(el), i => i.hasClass?.('vam-living-editor-failure-reason')).text;
    const first = reason();
    assert.equal(first, ui.t('ui.living_node_trial_reason_provider'));
    ui.setUiLanguage('en'); win.relabel();
    assert.equal(reason(), ui.t('ui.living_node_trial_reason_provider'));
    assert.notEqual(reason(), first);
    ui.setUiLanguage('zh-CN'); win.relabel();
    assert.equal(reason(), ui.t('ui.living_node_trial_reason_provider'));
    assert.notEqual(reason(), first);
  } finally { ui.setUiLanguage('en'); }
});

// ---- D1-x8: editor wait state, convert lock, readable trial preview ----------------------------------------------------
const buttonOf = (el, key) => find(el, i => i.tag === 'button' && i.text === ui.t(key));
const statusOf = el => find(el, i => i.attrs?.role === 'status');

test('D1-x8: while the first-send consent is pending the editor shows the wait state, not "AI running"', async () => {
  ui.setUiLanguage('zh-TW');
  let release;
  let win;
  const ctx = open({
    convert: async () => true,
    trial: () => new Promise(resolve => { release = resolve; })
  });
  win = ctx.win;
  buttonOf(ctx.el, 'ui.living_node_try_prompt').click();
  assert.equal(statusOf(ctx.el).text, ui.t('ui.ai_running'), 'before the consent question the run is simply running');
  win.setTrialWaiting(true);
  const waiting = statusOf(ctx.el).text;
  assert.notEqual(waiting, ui.t('ui.ai_running'));
  assert.ok(waiting.includes(ui.t('ui.ai_card_status_waiting')), waiting);
  assert.ok(waiting.includes(ui.t('ui.living_node_trial_waiting_consent')), waiting);
  win.setTrialWaiting(false);
  assert.equal(statusOf(ctx.el).text, ui.t('ui.ai_running'), 'after consent the run is running');
  release(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(statusOf(ctx.el).text, '');
});

test('D1-x8: the convert button is disabled for the whole trial and enabled again when it ends', async () => {
  let release;
  const ctx = open({ convert: async () => true, trial: () => new Promise(resolve => { release = resolve; }) });
  const convert = buttonOf(ctx.el, 'ui.living_node_convert');
  assert.equal(!!convert.disabled, false);
  buttonOf(ctx.el, 'ui.living_node_try_prompt').click();
  assert.equal(convert.disabled, true, 'locked while the trial runs');
  release(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(convert.disabled, false, 'free again after the trial');
});

test('D1-x8: the trial preview of an observation shows no internal field names', () => {
  const field = (name, value) => `- ${name}: ${JSON.stringify(value)}`;
  const preview = [
    '## Living Node', '', '### Observation', field('ID', 'r1'), field('Subject', 'price'), field('Scope', 'daily'),
    field('Granularity', 'day'), field('Event time', '2026-11-26'), field('Validity', 'active'), field('Ownership', 'ai'), '',
    '> 100', '', '#### Evidence', sourceLine('https://example.com/x', '2026-11-26T00:00:00Z'),
    '', '#### History', field('Time', '2026-11-25T00:00:00Z'), field('Reason', 'corrected'), '', '> 90'
  ].join('\n');
  const shown = markdown.localizeLivingReader(preview, labels, true);
  for (const name of ['ID:', 'Subject', 'Scope', 'Granularity', 'Event time', 'Validity', 'Ownership', 'Observation', '- Time:', '- Reason:'])
    assert.equal(shown.includes(name), false, name + '\n' + shown);
  assert.ok(shown.includes('### price'), 'the subject is the heading');
  assert.ok(shown.includes('D(2026-11-26)') && shown.includes('corrected') && shown.includes('> 100'), shown);
  assert.equal(markdown.localizeLivingReader('### Observation\n' + field('Subject', 'x'), labels, true).includes('Subject'), true, 'a block not in the written format is left alone');
});

// ---- D1-x11: the real right-pane reader (official tab) and the network reason ------------------------------------------
const NOTE_FM = '---\nagent-map-node: true\ntitle: R4C\nsummary: "STUB FIXED lighthouse built 1887, 31 m."\nai-card: true\n---\n';
const NOTE_BODY = '# R4C\n\n## 詳細內容\n\n<!-- visual-agent-map:detail:start -->\n\n<!-- visual-agent-map:detail:end -->\n\n> [!info]- 提示\n> Summarize\n\n' +
  [BEGIN, '', '## Living Node', '', '### Current output', '- Ownership: "ai"', '', '> STUB FIXED lighthouse built 1887, 31 m.', '', '#### Evidence',
    sourceLine('note:abc', '2026-11-28T10:37:25.377Z'), '', '### Suppression', '', END].join('\n') + '\n';
async function officialMarkdown(raw, language = 'zh-TW') {
  const rendered = [];
  const view = require('./support-replay.cjs').loadSource(`
export { LivingReaderView } from "./experiences/visual-map/living-node-reader";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Component: class { load() {} unload() {} }, ItemView: class { constructor() { this.contentEl = element('div'); this.app = { vault: { read: async () => raw } }; } }, MarkdownRenderer: { render: async (_app, text) => { rendered.push(text); } } } });
  view.setUiLanguage(language);
  try {
    const reader = new view.LivingReaderView({});
    await reader.show({ path: 'a.md' }, 'preview', 'owner');
    reader.tab = 'official';
    await reader.paint();
  } finally { view.setUiLanguage('en'); }
  return rendered[rendered.length - 1];
}

test('D1-x11: the official tab shows no internal markers, like the trial preview', async () => {
  const shown = await officialMarkdown(NOTE_FM + NOTE_BODY);
  for (const word of ['vam-living-node', 'Ownership', 'Source: [', 'Suppression']) assert.equal(shown.includes(word), false, word + ' in:\n' + shown);
  assert.ok(shown.includes('STUB FIXED lighthouse built 1887, 31 m.'));
});

test('D1-x11: the official tab shows the frontmatter summary when the note has no Current Summary section, and does not repeat it when it has one', async () => {
  const without = await officialMarkdown(NOTE_FM + NOTE_BODY);
  assert.match(without, /^## 目前摘要\n\nSTUB FIXED lighthouse built 1887, 31 m\.\n/m, without);
  const withSection = await officialMarkdown(NOTE_FM + '# R4C\n\n## 目前摘要\n\nSection text\n\n' + NOTE_BODY.replace('# R4C\n\n', ''));
  assert.equal((withSection.match(/目前摘要/g) || []).length, 1);
  assert.equal(withSection.includes('STUB FIXED lighthouse built 1887, 31 m.\n\n## '), false);
  const plainNote = await officialMarkdown('---\ntitle: x\nsummary: "ignored"\n---\n# x\n');
  assert.equal(plainNote.includes('ignored'), false, 'a note that is not a Living card is left alone');
});

test('D1-x11: the reader has a keyboard-operable "Open in editor" entry that opens the note natively; none for an unsaved draft', async () => {
  const view = require('./support-replay.cjs').loadSource(`
export { LivingReaderView } from "./experiences/visual-map/living-node-reader";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Component: class { load() {} unload() {} }, ItemView: class { constructor() { this.contentEl = element('div'); this.app = { vault: { read: async () => '' } }; } }, MarkdownRenderer: { render: async () => {} } } });
  const opened = [];
  const entry = reader => findAll(reader.contentEl, i => i.tag === 'button' && i.attrs?.role !== 'tab');
  for (const [language, label] of [['en', 'Open in editor'], ['zh-TW', '在編輯器開啟'], ['zh-CN', '在编辑器打开']]) {
    view.setUiLanguage(language);
    try {
      const reader = new view.LivingReaderView({});
      reader.leaf = { async openFile(file) { opened.push(file.path); } };
      await reader.showOfficial({ path: 'a.md' });
      const buttons = entry(reader).filter(b => b.text === label);
      assert.equal(buttons.length, 1, language);
      assert.equal(buttons[0].attrs.type, 'button', 'a real button: reachable and operable by keyboard');
      buttons[0].click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const draft = new view.LivingReaderView({});
      await draft.show({ path: 'd.md' }, 'preview', 'owner', [], false, undefined, true);
      assert.equal(entry(draft).filter(b => b.text === label).length, 0, 'an unsaved draft has no note to open');
    } finally { view.setUiLanguage('en'); }
  }
  assert.deepEqual(opened, ['a.md', 'a.md', 'a.md']);
});
