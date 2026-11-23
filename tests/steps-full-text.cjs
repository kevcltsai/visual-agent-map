// Full text of a requested file (owner report 2026-11-24: "每個 skill 放 SKILL.md 全文" came back as summaries). The provider's
// page tool only returns summaries, so for a full-text request the service fetches the raw GitHub file the provider opened and
// writes it word for word; when it cannot, the note says it holds a summary. See core/full-text.ts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load, capturingRuntime } = require('./support-replay.cjs');
const ft = S.load('core/full-text.ts');

const SKILL = [
  '---',
  'name: sharpen',
  'description: Make the task deeper, not bigger.',
  '---',
  '',
  '# Sharpen',
  '',
  '## Steps',
  '',
  '- Rewrite the prompt.',
  '',
  '```bash',
  'echo "keep `ticks`"',
  '```',
  '',
  '<script>alert(1)</script>'
].join('\n');
const BLOB = 'https://github.com/cursor/plugins/blob/main/pstack/skills/sharpen/SKILL.md';
const RAW = 'https://raw.githubusercontent.com/cursor/plugins/main/pstack/skills/sharpen/SKILL.md';
const DETAIL = '### 摘要\nsharpen 讓任務更深。\n\n### 原文或數據\n僅取得摘要。\n\n### 出處\n- [S1]\n\n### 更新紀錄\n- 新增。';
const reply = (detail = DETAIL) => JSON.stringify({ summary: 'sharpen SKILL.md', detail, suggestions: [], visualReferences: [] });
const opened = url => ({ method: 'item/completed', params: { item: { id: url, type: 'webSearch', action: { type: 'openPage', url } } } });
const context = (over = {}) => ({ title: 'sharpen SKILL.md', summary: 'sharpen 技能檔 SKILL.md 的原文。', rules: '', detail: '', task: '', ancestors: '', mode: 'task', researchMode: 'research', outputLanguage: 'zh-TW', ...over });
const textFile = (text, over = {}) => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, text, ...over });

function service(events, answer, fetchPage) {
  const rt = capturingRuntime([answer]);
  const inner = rt.runTask;
  rt.runTask = async (prompt, model, effort, schema, controls) => {
    for (const event of events) controls?.onWebSearchEvent?.(event);
    return inner(prompt, model, effort, schema, controls);
  };
  const { AiTaskService } = load('core/ai-task-service.ts', {}, { window: { setTimeout, clearTimeout } });
  const fetched = [];
  const svc = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'zh-TW', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => rt, claudeRuntime: () => rt,
    ...(fetchPage ? { fetchPage: async request => { fetched.push(request.url); return fetchPage(request); } } : {})
  });
  return { svc, rt, fetched };
}

test('wantsFullText reads only the topic\'s own words', () => {
  assert.equal(ft.wantsFullText(context()), true);
  assert.equal(ft.wantsFullText(context({ summary: '', task: '把 SKILL.md 全文放進去' })), true);
  assert.equal(ft.wantsFullText(context({ summary: '', rules: 'Quote it verbatim.' })), true);
  assert.equal(ft.wantsFullText(context({ summary: '它做什麼', title: 'sharpen' })), false);
});

test('rawFileUrl accepts only GitHub file addresses over https', () => {
  assert.equal(ft.rawFileUrl(BLOB), RAW);
  assert.equal(ft.rawFileUrl(BLOB.replace('/blob/', '/raw/')), RAW);
  assert.equal(ft.rawFileUrl(RAW), RAW);
  assert.equal(ft.rawFileUrl('https://gist.githubusercontent.com/u/abc/raw/f.md'), 'https://gist.githubusercontent.com/u/abc/raw/f.md');
  for (const url of [
    'http://raw.githubusercontent.com/a/b/main/f.md',
    'https://github.com/cursor/plugins/tree/main/pstack',
    'https://github.com/cursor/plugins',
    'https://raw.githubusercontent.com.evil.example/a/b/main/f.md',
    'https://user:pw@raw.githubusercontent.com/a/b/main/f.md',
    'https://raw.githubusercontent.com:8443/a/b/main/f.md',
    'https://localhost/a/b/blob/main/f.md',
    'https://example.org/SKILL.md',
    'file:///etc/passwd',
    'not a url'
  ]) assert.equal(ft.rawFileUrl(url), undefined, url);
});

test('full-text request: the raw file the provider opened is written word for word, labelled, inside the original-text section', async () => {
  const { svc, rt, fetched } = service([opened(BLOB)], reply(), async () => textFile(SKILL + '\r\n'));
  const result = await svc.askModel(context(), 'claude:sonnet', 'low');
  assert.deepEqual(fetched, [RAW]);
  assert.match(rt.calls[0].prompt, /VAM 會自己抓那份原始檔/);
  const detail = result.detail;
  assert.ok(detail.includes('#### 全文：SKILL.md'));
  assert.ok(detail.includes(`VAM 直接從 ${RAW} 抓取原始檔，逐字放入，未經 AI 改寫。`));
  assert.ok(detail.includes('````markdown\n' + SKILL + '\n````'), 'verbatim inside a fence longer than the file\'s own');
  // Inside the original-text section, before the next section.
  assert.ok(detail.indexOf('### 原文或數據') < detail.indexOf('#### 全文：SKILL.md'));
  assert.ok(detail.indexOf('#### 全文：SKILL.md') < detail.indexOf('### 出處'));
  assert.doesNotMatch(detail, /全文未取得/);
});

test('a re-research replaces the earlier copy instead of adding a second one', async () => {
  const first = await service([opened(BLOB)], reply(), async () => textFile(SKILL)).svc.askModel(context(), 'claude:sonnet', 'low');
  const again = await service([opened(RAW)], reply(first.detail), async () => textFile(SKILL + '\nnew line')).svc.askModel(context({ detail: first.detail }), 'claude:sonnet', 'low');
  assert.equal(again.detail.split('#### 全文：SKILL.md').length, 2);
  assert.ok(again.detail.includes('new line'));
  const failed = await service([], reply(again.detail), async () => textFile(SKILL)).svc.askModel(context({ detail: again.detail }), 'claude:sonnet', 'low');
  assert.equal(failed.detail.split('全文未取得：').length, 2);
  assert.doesNotMatch(failed.detail, /#### 全文：/);
});

test('no raw file opened: the note says the full text was not retrieved and the rest is a summary', async () => {
  const { svc, fetched } = service([opened('https://github.com/cursor/plugins/tree/main/pstack')], reply(), async () => textFile(SKILL));
  const result = await svc.askModel(context(), 'claude:sonnet', 'low');
  assert.deepEqual(fetched, []);
  assert.match(result.detail, /全文未取得：這次 AI 沒有打開可直接下載的原始檔網址（目前只支援 GitHub 檔案）。這則筆記的其他內容是 AI 依網頁整理的摘要，不是原文。/);
  assert.doesNotMatch(result.detail, /#### 全文：/);
});

test('refused files: too large, not text, bad status, network failure; never inserted', async () => {
  const cases = [
    [textFile('x'.repeat(ft.MAX_FILE_BYTES + 1)), /SKILL\.md 超過 200 KB 上限/],
    [textFile('PNG', { headers: { 'content-type': 'application/octet-stream' } }), /SKILL\.md 不是文字檔/],
    [textFile('a\u0000b'), /SKILL\.md 不是文字檔/],
    [textFile('', { status: 404 }), /SKILL\.md 的網址沒有回傳檔案/],
    ['reject', /SKILL\.md 連線失敗或逾時/]
  ];
  for (const [response, reason] of cases) {
    const result = await service([opened(BLOB)], reply(), async () => { if (response === 'reject') throw new Error('offline'); return response; }).svc.askModel(context(), 'claude:sonnet', 'low');
    assert.match(result.detail, reason);
    assert.match(result.detail, /全文未取得：/);
    assert.doesNotMatch(result.detail, /#### 全文：/);
  }
});

test('at most three distinct files are fetched; a slow fetch times out', async () => {
  const urls = ['a', 'b', 'c', 'd'].map(name => `https://raw.githubusercontent.com/o/r/main/${name}.md`);
  const { svc, fetched } = service([...urls, urls[0]].map(opened), reply(), async () => textFile('ok'));
  await svc.askModel(context(), 'claude:sonnet', 'low');
  assert.deepEqual(fetched, urls.slice(0, 3));
  const files = await ft.fetchFullTexts([RAW], () => new Promise(() => {}), 10);
  assert.deepEqual(JSON.parse(JSON.stringify(files)), [{ ok: false, url: RAW, name: 'SKILL.md', reason: 'network' }]);
});

test('a backtick run in the file gets a longer fence', () => {
  const text = 'a\n`````\nb';
  const detail = ft.attachFullText('### Source text or data\nq', [{ ok: true, url: RAW, name: 'SKILL.md', text }], 'en');
  assert.ok(detail.includes('``````markdown\n' + text + '\n``````'));
  assert.ok(detail.startsWith('### Source text or data\nq\n\n#### Full text: SKILL.md\nFetched by VAM directly from'));
});

test('not a full-text request: nothing is fetched and the detail is unchanged', async () => {
  const { svc, rt, fetched } = service([opened(BLOB)], reply(), async () => textFile(SKILL));
  const result = await svc.askModel(context({ title: 'sharpen', summary: '它做什麼' }), 'claude:sonnet', 'low');
  assert.deepEqual(fetched, []);
  assert.doesNotMatch(result.detail, /全文/);
  assert.doesNotMatch(rt.calls[0].prompt, /VAM 會自己抓/);
  const local = await service([opened(BLOB)], reply(), async () => textFile(SKILL)).svc.askModel(context({ researchMode: 'local' }), 'claude:sonnet', 'low');
  assert.doesNotMatch(local.detail, /全文/);
});

test('the fetched text survives the note write path word for word (headings, html and callouts inside stay inert)', () => {
  const ru = S.load('ai/result-utils.ts');
  const mi = S.load('ai/markdown-intake.ts');
  const ns = S.load('core/book-pipeline/note-sections.ts');
  const dt = S.load('ai/detail-templates.ts');
  const text = SKILL + '\n### Deep\n> [!note] hi\n<iframe src="https://e.org"></iframe>\n![[secret.png]]\n- [ ] task';
  const detail = ft.attachFullText(DETAIL, [{ ok: true, url: RAW, name: 'SKILL.md', text }], 'zh-TW');
  const template = dt.standardTemplate('zh-TW');
  const written = ns.neutralizeText(mi.intakeAiMarkdown(detail, { kind: 'task-detail', compose: fresh => ru.canonicalDetail(fresh, 'zh-TW', template) }));
  assert.ok(written.includes('````markdown\n' + text + '\n````'));
});

test('every fetch asks for at most one byte over the cap; a 206 answer is used; a bad escape in the name does not throw', async () => {
  const seen = [];
  const files = await ft.fetchFullTexts(['https://raw.githubusercontent.com/o/r/main/%E0%A4%A.md'], async request => { seen.push(request.headers); return textFile('partial ok', { status: 206 }); });
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [{ Range: `bytes=0-${ft.MAX_FILE_BYTES}` }]);
  assert.deepEqual(JSON.parse(JSON.stringify(files)), [{ ok: true, url: 'https://raw.githubusercontent.com/o/r/main/%E0%A4%A.md', name: '%E0%A4%A.md', text: 'partial ok' }]);
});
