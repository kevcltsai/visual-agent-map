// Web sources a reply names that the run never opened (V3.3 #06, D5): only URLs new in this reply, not opened and not in any
// input, get the note-language marker; Quick opens nothing, so the same rule marks every URL it adds.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { markUnverifiedUrls, webUrlKey, webUrlsIn } = S.load('core/web-sources.ts');
const { translate, translateNote } = S.load('i18n.ts');

const M = '(source not verified)';
const mark = (detail, known = []) => markUnverifiedUrls(detail, known, M, [M, '（來源未驗證）', '（来源未验证）']);

test('a fabricated URL is marked after the link, after an autolink and after a bare URL (before its trailing punctuation)', () => {
  assert.equal(mark('See [Paper](https://fake.example/p).'), `See [Paper](https://fake.example/p) ${M}.`);
  assert.equal(mark('See <https://fake.example/p>'), `See <https://fake.example/p> ${M}`);
  assert.equal(mark('See https://fake.example/p.'), `See https://fake.example/p ${M}.`);
  assert.equal(mark('來源 https://fake.example/p。'), `來源 https://fake.example/p ${M}。`);
  assert.equal(mark('[^1]: [Title](https://fake.example/p "t")'), `[^1]: [Title](https://fake.example/p "t") ${M}`, 'a footnote definition');
  assert.equal(mark('[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))'), `[Wiki](https://en.wikipedia.org/wiki/Foo_(bar)) ${M}`, 'balanced parentheses');
});
test('a known URL is not marked: http/https, trailing slash, fragment and host case are the same URL', () => {
  for (const written of ['https://a.example/x', 'http://a.example/x', 'https://a.example/x/', 'https://A.example/x#part', 'http://a.example/x/#p'])
    assert.equal(mark(`[a](${written})`, ['https://a.example/x']), `[a](${written})`, written);
  assert.equal(webUrlKey('https://a.example/'), webUrlKey('http://a.example'));
  assert.notEqual(webUrlKey('https://a.example/x?q=1'), webUrlKey('https://a.example/x?q=2'), 'the query is part of the page');
  assert.notEqual(webUrlKey('https://a.example/x'), webUrlKey('https://a.example/y'));
});
test('code, images, embeds, HTML tags and reference definitions are left byte for byte; a URL already marked is not marked twice', () => {
  const text = [
    '```\nhttps://fake.example/code\n```',
    '`https://fake.example/inline`',
    '![](https://fake.example/a.png)',
    '<iframe src="https://fake.example/embed"></iframe>',
    '[ref]: https://fake.example/ref',
    `[x](https://fake.example/x) ${M}`,
    'https://fake.example/y（來源未驗證）'
  ].join('\n');
  assert.equal(mark(text), text);
});
test('the URL text of a link is one URL: [url](url) gets one marker', () => {
  assert.equal(mark('[https://fake.example/p](https://fake.example/p)'), `[https://fake.example/p](https://fake.example/p) ${M}`);
});
test('webUrlsIn finds the URLs of any text without trailing punctuation', () => {
  assert.deepEqual([...webUrlsIn('a https://x.example/1, b [t](http://y.example/2) c <https://z.example/3>.')], ['https://x.example/1', 'http://y.example/2', 'https://z.example/3']);
});
test('the marker exists in the three dictionaries and is written in the note language', () => {
  assert.equal(translate('en', 'note.source_unverified'), '(source not verified)');
  assert.equal(translate('zh-TW', 'note.source_unverified'), '（來源未驗證）');
  assert.equal(translate('zh-CN', 'note.source_unverified'), '（来源未验证）');
  assert.equal(translateNote('zh-CN', 'note.source_unverified'), translateNote('zh-TW', 'note.source_unverified'), 'note text follows the note language, like note.source_unconfirmed_0');
});

// ---- AiTaskService behaviour: a fake runtime with web events ----
const { load } = require('./support-replay.cjs');
const { AiTaskService } = load('core/ai-task-service.ts');
const ctx = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });
const standard = extra => ctx({ researchMode: 'research', researchDepth: 'normal', ...extra });
const openPage = url => ({ method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'openPage', url } } } });
const rig = (opened, detail) => {
  const runtime = { runTask: async (_prompt, _model, _effort, _schema, controls) => {
    for (const url of opened) controls.onWebSearchEvent?.(openPage(url));
    return JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] });
  } };
  return new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => runtime, claudeRuntime: () => runtime });
};
const OPENED = 'https://opened.example/page';
const FAKE = 'https://fake.example/made-up';

test('AiTaskService: a Standard run marks only the URL it never opened; opened, previous-Detail, user-text and reference URLs stay plain', async () => {
  const detail = [`[o](${OPENED}/)`, `[f](${FAKE})`, '[p](http://prev.example/a#x)', '[u](https://user.example/b)', '[r](https://ref.example/c)', '[s](https://src.example/d)'].join('\n');
  const result = await rig([OPENED], detail).askModel(standard({
    detail: 'Old: https://prev.example/a', userTexts: 'Pasted https://user.example/b', sourceContext: 'Local https://src.example/d',
    referenceGroups: [{ id: 'g', name: 'G', location: 'L', documents: [{ path: 'r.md', content: 'see https://ref.example/c' }] }], referenceDelivery: 'direct'
  }), 'gpt-6-luna', 'low');
  const lines = result.detail.split('\n');
  assert.equal(lines.filter(line => line.includes(M)).length, 1, result.detail);
  assert.ok(lines.find(line => line.includes(FAKE)).endsWith(M));
});
test('AiTaskService: a Quick run opens nothing, so every URL the model wrote is marked, and no other line is added', async () => {
  const result = await rig([], `A [one](${FAKE})\nB https://other.example/x`).askModel(ctx(), 'gpt-6-luna', 'low');
  assert.equal(result.detail, `A [one](${FAKE}) ${M}\nB https://other.example/x ${M}`);
});
test('AiTaskService: a top (append) reply is only the inserted fragment; a URL of the old Detail stays plain in it', async () => {
  const result = await rig([], `New [old](https://prev.example/a) and [new](${FAKE})`).askModel(ctx({ updateMode: 'top', detail: 'Old [x](https://prev.example/a) [y](https://prev2.example/b)' }), 'gpt-6-luna', 'low');
  assert.equal(result.detail, `New [old](https://prev.example/a) and [new](${FAKE}) ${M}`);
});
test('AiTaskService: a re-run keeps an earlier marker once and writes the marker in the note language', async () => {
  const prev = `[f](${FAKE}) ${M}`;
  assert.equal((await rig([], prev).askModel(ctx({ detail: prev }), 'gpt-6-luna', 'low')).detail, prev);
  const zh = await rig([], `[f](${FAKE})`).askModel(ctx({ language: 'zh-TW', outputLanguage: 'zh-CN' }), 'gpt-6-luna', 'low');
  assert.equal(zh.detail, `[f](${FAKE}) （來源未驗證）`);
});
test('AiTaskService: a rewrite that drops an earlier marker gets it back; a run that opens the page drops it for good', async () => {
  const prev = `[f](${FAKE}) ${M}`;
  assert.equal((await rig([], `[f](${FAKE})`).askModel(ctx({ detail: prev }), 'gpt-6-luna', 'low')).detail, prev, 'the previous Detail does not vouch for a URL it marked');
  assert.equal((await rig([FAKE], `[f](${FAKE})`).askModel(standard({ detail: prev }), 'gpt-6-luna', 'low')).detail, `[f](${FAKE})`, 'opened now: verified');
});
test('AiTaskService: an intermediate (not reader-facing) reply is not marked', async () => {
  const result = await rig([], `[f](${FAKE})`).askModel(ctx({ intermediateDetail: true }), 'gpt-6-luna', 'low');
  assert.equal(result.detail, `[f](${FAKE})`);
});
