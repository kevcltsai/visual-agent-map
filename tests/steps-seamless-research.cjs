// Seamless research, pure core (P1): phase-1 skeleton filter, phase-2 write rules and sanitizer, failure classification.
// The filter cases follow the shapes found in real Quick/Standard notes (digits, Latin names, 「」 quotes, | tables, mermaid fences, > [!summary] callouts, numbered lists).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { skeletonFilter, sentenceHasSourceNeed, DEFAULT_SKELETON_PLACEHOLDER } = load('core/seamless-research/skeleton-filter.ts');
const apply = load('core/seamless-research/apply.ts', {}, { URL });
const { classifyFailure, seamlessOutcome } = load('core/seamless-research/outcome.ts');
const { searchNotPerformedError } = load('ai/search-not-performed.ts');

// The modules run in a separate vm context: compare plain data, not realm-specific objects.
const plain = value => JSON.parse(JSON.stringify(value));
const filter = (text, allow) => skeletonFilter(text, { allow });

// ---------- skeleton filter: removed ----------
const REMOVED = [
  ['arabic digits', '這件外套很保暖。價格落在 3000 之間。', '價格落在'],
  ['full-width digits', '這件外套很保暖。價格約２０００。', '２０００'],
  ['date with 年', '這件外套很保暖。2024 年開始流行。', '2024'],
  ['percent', '這件外套很保暖。保暖度提升 30%。', '30%'],
  ['chinese numeral plus unit (三百元)', '這件外套很保暖。大約三百元就買得到。', '三百元'],
  ['chinese numeral plus unit (十年)', '這件外套很保暖。穿十年不會壞。', '十年'],
  ['one before a measure (一公斤)', '這件外套很保暖。重量不到一公斤。', '一公斤'],
  ['one before a numeral (一百)', '這件外套很保暖。通常一百多人排隊。', '一百'],
  ['dollar sign', '這件外套很保暖。價格是 $ 很多。', '$'],
  ['yen sign', '這件外套很保暖。日本店標示 ¥ 起。', '¥'],
  ['corner quote', '這件外套很保暖。店員說「很耐穿」。', '耐穿'],
  ['white corner quote', '這件外套很保暖。店員說『很耐穿』。', '耐穿'],
  ['curly quote', '這件外套很保暖。店員說“很耐穿”。', '耐穿'],
  ['straight quote', '這件外套很保暖。店員說"很耐穿"。', '耐穿'],
  ['book title mark', '這件外套很保暖。可以參考《穿搭指南》。', '穿搭指南'],
  ['angle title mark', '這件外套很保暖。可以參考〈穿搭指南〉。', '穿搭指南'],
  ['Latin brand (Zara)', '這件外套很保暖。Zara 有類似款式。', 'Zara'],
  ['Latin acronym', '這件外套很保暖。材質常見 DNA 般的纖維紋路。', 'DNA'],
  ['camel-case brand (iPhone)', '這件外套很保暖。口袋放得下 iPhone。', 'iPhone'],
  ['url', '這件外套很保暖。詳見 https://example.com/a 的說明。', 'example.com'],
  ['www url', '這件外套很保暖。詳見 www.example.com 的說明。', 'example.com'],
  ['footnote reference', '這件外套很保暖。層層疊穿更舒適[^1]。', '層層疊穿'],
  ['markdown image', '這件外套很保暖。![外套](https://example.com/a.png)', 'example.com'],
  ['wiki embed', '這件外套很保暖。![[外套.png]]', '外套.png']
];
for (const [name, input, gone] of REMOVED) {
  test(`filter removes: ${name}`, () => {
    const out = filter(input);
    assert.ok(!out.includes(gone), `${gone} must be gone: ${out}`);
    assert.ok(out.includes('這件外套很保暖。'), `the clean sentence stays: ${out}`);
  });
}

// ---------- skeleton filter: counter-cases (kept) ----------
const KEPT = [
  ['一般 is not a number', '一般來說外套要看場合。'],
  ['一些 is not a number', '一些人偏好短版。'],
  ['一種 is not a number', '風衣是一種輕薄的外套。'],
  ['一個 is not a number', '先選一個主色。'],
  ['十分 (very) is not a number', '這個組合十分百搭。'],
  ['chinese numeral without unit', '二氧化碳與外套無關。'],
  ['lowercase Latin term', '保暖層要透氣，pH 與材質無關。'],
  ['plain Chinese sentence', '先決定場合，再決定層次。']
];
for (const [name, input] of KEPT) {
  test(`filter keeps: ${name}`, () => {
    assert.equal(filter(input).trim(), input);
  });
}

test('filter keeps a topic title with Latin letters and digits when it is allowed, removes it when not', () => {
  const title = 'Zara 2024 秋冬穿搭';
  const text = `${title} 值得一看。\n`;
  assert.equal(filter(text, [title]).trim(), `${title} 值得一看。`);
  assert.equal(filter(text).includes('Zara'), false);
});

test('filter allow list is case-insensitive and does not hide other proper nouns in the same sentence', () => {
  assert.equal(filter('Zara 與 Uniqlo 都有賣。', ['zara']).includes('Uniqlo'), false);
  assert.equal(filter('Zara 有賣。', ['zara']).trim(), 'Zara 有賣。');
});

test('filter keeps headings even when they contain digits or Latin words', () => {
  const out = filter('### 2024 Zara 趨勢\n\n先選主色。\n');
  assert.ok(out.includes('### 2024 Zara 趨勢'));
  assert.ok(out.includes('先選主色。'));
});

test('filter removes only the bad sentence of a line and keeps the list marker', () => {
  assert.equal(filter('- 先選主色。價格約 500 元。再選配件。\n').trim(), '- 先選主色。再選配件。');
  assert.equal(filter('1. 價格約 500 元。\n2. 先選主色。\n').trim(), '2. 先選主色。');
});

test('filter drops a whole table when its header is bad, and bad rows otherwise', () => {
  const good = '| 面向 | 做法 |\n|---|---|\n| 層次 | 內薄外厚 |\n| 價格 | 約 500 元 |\n';
  assert.equal(filter(good).trim(), '| 面向 | 做法 |\n|---|---|\n| 層次 | 內薄外厚 |');
  assert.equal(filter('| 品牌 | 2024 |\n|---|---|\n| a | b |\n').trim(), '');
  assert.equal(filter('| a | b |\n|---|---|\n| 1 | 2 |\n').trim(), '');
});

test('filter removes code and mermaid fences and footnote definitions', () => {
  const out = filter('先選主色。\n\n```mermaid\nflowchart TD\n  A[Zara 1]\n```\n\n[^1]: [Title](https://example.com)\n再選配件。\n');
  assert.equal(out.trim(), '先選主色。\n\n再選配件。');
});

test('filter removes a callout marker whose body vanished and keeps a callout with clean text', () => {
  assert.equal(filter('> [!summary]\n> 價格約 500 元。\n\n先選主色。\n').trim(), '先選主色。');
  assert.equal(filter('> [!summary]\n> 先選主色。\n').trim(), '> [!summary]\n> 先選主色。');
});

test('filter puts the placeholder under a section that lost all its text, not under one that was empty', () => {
  const out = filter('### 價格\n\n約 500 元。\n\n### 父層\n\n#### 子層\n\n先選主色。\n');
  assert.ok(out.includes(`### 價格\n\n${DEFAULT_SKELETON_PLACEHOLDER}`));
  assert.ok(!out.includes(`### 父層\n\n${DEFAULT_SKELETON_PLACEHOLDER}`));
  assert.ok(out.includes('先選主色。'));
  assert.equal(skeletonFilter('### 價格\n\n約 500 元。\n', { placeholder: '（待補）' }).includes('（待補）'), true);
});

test('filter keeps html marker comments and leaves nothing for an all-bad input', () => {
  assert.ok(filter('<!-- visual-agent-map:detail:start -->\n先選主色。\n').includes('<!-- visual-agent-map:detail:start -->'));
  assert.equal(filter('價格 500 元。\n'), '');
  assert.equal(filter(''), '');
});

test('filter is idempotent and normalizes CRLF', () => {
  const input = '### 核心結論\r\n\r\n- 先選主色。\r\n- 價格約 500 元。\r\n- Zara 很多。\r\n\r\n### 做法\r\n\r\n2024 年很熱。\r\n';
  const once = filter(input);
  assert.equal(filter(once), once);
  assert.ok(!once.includes('\r'));
});

test('sentenceHasSourceNeed mirrors the filter for single sentences', () => {
  assert.equal(sentenceHasSourceNeed('先選主色。'), false);
  assert.equal(sentenceHasSourceNeed('先選主色 3 次。'), true);
  assert.equal(sentenceHasSourceNeed('Zara 有賣。', ['Zara']), false);
});

// ---------- write plan ----------
const { planPhase2Write, detailHash } = apply;

test('write plan replaces an empty detail', () => {
  const plan = planPhase2Write({ currentDetail: '  \n', phase2Detail: '新內容[^1]\n\n[^1]: [S](https://e.com)' });
  assert.equal(plan.mode, 'replace');
  assert.equal(plan.detail, '新內容[^1]\n\n[^1]: [S](https://e.com)');
  assert.equal(plan.writtenHash, detailHash(plan.detail));
});

test('write plan replaces AI-owned unchanged text (same hash, line-ending tolerant)', () => {
  const phase1 = '### 核心結論\n\n先選主色。\n';
  const plan = planPhase2Write({ currentDetail: phase1.replace(/\n/g, '\r\n'), writtenHash: detailHash(phase1), phase2Detail: '新內容' });
  assert.equal(plan.mode, 'replace');
  assert.equal(plan.detail, '新內容');
});

test('write plan appends when the user edited the detail: user text stays byte-identical and the hash is cleared', () => {
  const phase1 = '先選主色。\n';
  const edited = '先選主色。\n我自己加的一行，　尾端有全形空白　\n';
  const plan = planPhase2Write({ currentDetail: edited, writtenHash: detailHash(phase1), phase2Detail: '網路內容[^1]\n\n[^1]: [S](https://e.com)' });
  assert.equal(plan.mode, 'append');
  assert.ok(plan.detail.startsWith(edited));
  assert.ok(plan.detail.includes('### 網路補充'));
  assert.equal(plan.writtenHash, undefined);
});

test('write plan treats a note without a hash as user-owned and appends', () => {
  const plan = planPhase2Write({ currentDetail: '舊的手寫內容', phase2Detail: '網路內容' });
  assert.equal(plan.mode, 'append');
  assert.ok(plan.detail.startsWith('舊的手寫內容'));
});

test('write plan shifts appended footnote numbers past the user footnotes', () => {
  const current = '手寫[^1][^2]\n\n[^1]: a\n[^2]: b\n';
  const plan = planPhase2Write({ currentDetail: current, phase2Detail: '新[^1]\n\n[^1]: [S](https://e.com)' });
  assert.ok(plan.detail.startsWith(current));
  assert.ok(plan.detail.includes('新[^3]'));
  assert.ok(plan.detail.includes('[^3]: [S](https://e.com)'));
});

test('write plan is a no-op for empty phase-2 text and for text that is already there', () => {
  assert.equal(planPhase2Write({ currentDetail: '手寫', phase2Detail: '  ' }).mode, 'noop');
  const first = planPhase2Write({ currentDetail: '手寫', phase2Detail: '網路內容' });
  assert.equal(planPhase2Write({ currentDetail: first.detail, phase2Detail: '網路內容' }).mode, 'noop');
});

// ---------- corrections ----------
const { applyCorrections, originalFootnote } = apply;

test('originalFootnote is one line, drops old refs, and adds the source only when https', () => {
  assert.equal(originalFootnote('舊句[^3]\n換行', 'https://e.com/a'), '原本寫：舊句 換行（來源：https://e.com/a）');
  assert.equal(originalFootnote('舊句', 'javascript:alert(1)'), '原本寫：舊句');
});

test('corrections add the 原本寫 footnote when the model omitted it', () => {
  const detail = '價格約 500 元[^1]。其他不變。\n\n[^1]: [S](https://e.com)\n';
  const result = applyCorrections(detail, [{ sentence: '價格約 500 元[^1]。', verdict: 'unsupported', correction: '價格約 800 元。', sourceUrl: 'https://e.com/p' }]);
  assert.ok(result.detail.includes('價格約 800 元。[^2]'));
  assert.ok(result.detail.includes('[^2]: 原本寫：價格約 500 元。（來源：https://e.com/p）'));
  assert.ok(result.detail.includes('其他不變。'));
  assert.deepEqual(plain(result.corrected), ['價格約 500 元[^1]。']);
});

test('corrections do not add a second footnote when the model already wrote one', () => {
  const detail = '價格約 800 元。[^2]\n\n[^2]: 原本寫：價格約 500 元。\n';
  const result = applyCorrections(detail, [{ sentence: '價格約 500 元。', verdict: 'unsupported', correction: '價格約 800 元。' }]);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.detail, detail);
  const detail2 = '價格約 500 元。\n\n[^2]: 原本寫：價格約 500 元。\n';
  const kept = applyCorrections(detail2, [{ sentence: '價格約 500 元。', verdict: 'unsupported', correction: '價格約 800 元。' }]);
  assert.equal((kept.detail.match(/原本寫：/g) || []).length, 1);
});

test('corrections remove an unsupported sentence that has no correction, and its emptied list line', () => {
  const result = applyCorrections('- 保證有效。\n- 先選主色。\n', [{ sentence: '保證有效。', verdict: 'unsupported' }]);
  assert.equal(result.detail, '- 先選主色。\n');
  assert.deepEqual(plain(result.removed), ['保證有效。']);
});

test('corrections leave supported verdicts and unknown sentences alone', () => {
  const detail = '先選主色。\n';
  const result = applyCorrections(detail, [{ sentence: '先選主色。', verdict: 'supported' }, { sentence: '找不到的句子。', verdict: 'unsupported', correction: 'x' }]);
  assert.equal(result.detail, detail);
  assert.deepEqual(plain(result.unmatched), ['找不到的句子。']);
});

test('corrections match a sentence across different whitespace', () => {
  const result = applyCorrections('價格  約\n500 元。', [{ sentence: '價格 約 500 元。', verdict: 'unsupported' }]);
  assert.equal(result.removed.length, 1);
});

// ---------- sanitizer ----------
const { sanitizePhase2Markdown, eligibleImages, checkImageBytes, imageKind, renderFootnoteDefinitions } = apply;
const clean = text => sanitizePhase2Markdown(text).markdown;

test('sanitizer keeps https links, footnote references and plain markdown', () => {
  const text = '### 標題\n\n- 內容[^1]，見 [來源](https://example.com/a?b=c)。\n\n[^1]: [S](https://example.com)';
  assert.equal(clean(text), text);
});

test('sanitizer turns a javascript: link into its label', () => {
  const out = clean('點 [這裡](javascript:alert(1)) 看看');
  assert.ok(!/javascript/i.test(out), out);
  assert.ok(out.includes('這裡'));
});

test('sanitizer rejects disguised schemes, http links and relative links as links', () => {
  for (const target of ['JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html;base64,AAA', 'http://example.com', '/etc/passwd', 'file:///etc/passwd', 'java%0ascript:alert(1)']) {
    const out = clean(`[X](${target})`);
    assert.equal(out, 'X', target);
  }
});

test('sanitizer removes data: and remote markdown images and wiki embeds', () => {
  const out = clean('前 ![a](data:image/png;base64,AAAA) 中 ![b](https://evil.example/leak.png) ![[secret.png]] 後');
  assert.ok(!out.includes('data:') && !out.includes('evil.example') && !out.includes('![['), out);
  assert.ok(out.includes('前') && out.includes('後'));
});

test('sanitizer removes raw html, scripts and the remote <img> that leaks note text in its query', () => {
  const out = clean('正文<script>alert(1)</script>結尾 <img src="https://evil.example/p?q=我的私人筆記內容" onerror="x()"> <div>塊</div><iframe src="https://e.com"></iframe>');
  assert.ok(!/<|evil\.example|私人筆記|alert/.test(out), out);
  assert.ok(out.includes('正文') && out.includes('結尾') && out.includes('塊'));
});

test('sanitizer removes an http (non-https) image and an image written as a reference', () => {
  const out = clean('![x](http://example.com/a.png)\n![y][1]\n\n[1]: http://example.com/a.png');
  assert.ok(!out.includes('example.com'), out);
});

test('sanitizer drops reference definitions that are not https, keeps https ones', () => {
  const out = clean('[a][1] [b][2]\n\n[1]: javascript:alert(1)\n[2]: https://example.com');
  assert.ok(!out.includes('javascript'));
  assert.ok(out.includes('[2]: https://example.com'));
});

test('sanitizer strips html comments and control or bidi characters and reports what it dropped', () => {
  const result = sanitizePhase2Markdown('a<!-- visual-agent-map:detail:end -->b‮\u0000c');
  assert.equal(result.markdown, 'abc');
  assert.ok(result.dropped.length >= 1);
});

// ---------- images ----------
const img = (over = {}) => ({ imageUrl: 'https://upload.example.org/a.png', sourceUrl: 'https://example.org/page', title: 'T', license: 'CC BY 4.0', ...over });

test('eligibleImages accepts https images with a license and a source page', () => {
  const { eligible, rejected } = eligibleImages([img()]);
  assert.equal(eligible.length, 1);
  assert.equal(rejected.length, 0);
});

test('eligibleImages rejects http, data, javascript, credentials, private hosts, missing license, duplicates, and caps at 6', () => {
  const bad = [
    img({ imageUrl: 'http://upload.example.org/a.png' }),
    img({ imageUrl: 'data:image/png;base64,AAAA' }),
    img({ imageUrl: 'javascript:alert(1)' }),
    img({ imageUrl: 'https://user:pw@example.org/a.png' }),
    img({ imageUrl: 'https://localhost/a.png' }),
    img({ imageUrl: 'https://192.168.1.5/a.png' }),
    img({ imageUrl: 'https://169.254.169.254/latest' }),
    img({ sourceUrl: 'http://example.org/page' }),
    img({ license: '' }),
    img({ license: 'unknown' }),
    img({ license: '未知' })
  ];
  const result = eligibleImages(bad);
  assert.equal(result.eligible.length, 0, JSON.stringify(result.rejected.map(item => item.reason)));
  assert.equal(result.rejected.length, bad.length);
  const many = Array.from({ length: 9 }, (_v, i) => img({ imageUrl: `https://upload.example.org/${i}.png` }));
  assert.equal(eligibleImages(many).eligible.length, 6);
  assert.equal(eligibleImages([img(), img()]).eligible.length, 1);
});

test('image bytes: png, jpeg, gif, webp pass; a text or html file named .png is refused', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
  const gif = Uint8Array.from(Buffer.from('GIF89a....'));
  const webp = Uint8Array.from(Buffer.from('RIFF\0\0\0\0WEBPVP8 '));
  assert.deepEqual([png, jpeg, gif, webp].map(imageKind), ['png', 'jpeg', 'gif', 'webp']);
  assert.deepEqual(plain(checkImageBytes(Uint8Array.from(Buffer.from('<html><script>alert(1)</script></html>')))), { rejected: 'not-an-image' });
  assert.deepEqual(plain(checkImageBytes(Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')))), { rejected: 'not-an-image' });
  assert.deepEqual(plain(checkImageBytes(new Uint8Array(0))), { rejected: 'empty' });
  assert.deepEqual(plain(checkImageBytes(png)), { kind: 'png' });
});

test('image bytes: a file over 10 MB is refused even with valid magic bytes', () => {
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(plain(checkImageBytes(big)), { rejected: 'too-large' });
});

test('footnote definitions keep only https sources and safe ids', () => {
  const out = renderFootnoteDefinitions([
    { id: '1', url: 'https://example.com/a', title: '標題 [x]' },
    { id: '2', url: 'javascript:alert(1)', title: 'bad' },
    { id: '3', url: 'http://example.com', title: 'plain http' },
    { id: 'a b', url: 'https://example.com', title: 'bad id' }
  ]);
  assert.equal(out, '[^1]: [標題 \\[x\\]](https://example.com/a)');
});

// ---------- failure classification ----------
test('classifyFailure table', () => {
  const named = (name, message = '') => Object.assign(new Error(message), { name });
  const coded = (code, message = 'x') => Object.assign(new Error(message), { code });
  const table = [
    [named('AbortError', 'Aborted'), 'stopped'],
    [searchNotPerformedError(), 'network'],
    [coded('ENOTFOUND'), 'network'],
    [coded('ECONNRESET'), 'network'],
    [coded('ECONNREFUSED'), 'network'],
    [coded('ETIMEDOUT'), 'network'],
    [new Error('fetch failed'), 'network'],
    [new Error('getaddrinfo ENOTFOUND api.example.com'), 'network'],
    [new Error('x', { cause: coded('ECONNRESET') }), 'network'],
    [new Error('Network error while contacting the provider'), 'network'],
    ['socket hang up', 'network'],
    [new Error('Invalid JSON in reply'), 'other'],
    [new Error('rate limit'), 'other'],
    [undefined, 'other'],
    [null, 'other']
  ];
  for (const [error, expected] of table) assert.equal(classifyFailure(error), expected, String(error?.message ?? error));
});

test('seamlessOutcome table: only a fully applied phase 2 is completed', () => {
  const base = { phase1Written: true, phase2: 'applied', imagesRequested: false, imagesSaved: 0 };
  const table = [
    [{ ...base }, { status: 'completed' }],
    [{ ...base, imagesRequested: true, imagesSaved: 2 }, { status: 'completed' }],
    [{ ...base, imagesRequested: true, imagesSaved: 0 }, { status: 'error', reason: 'no-images', action: 'dismiss' }],
    [{ ...base, failure: 'network', phase2: 'none' }, { status: 'error', reason: 'network', action: 'retry' }],
    [{ ...base, failure: 'no-web-model', phase2: 'none' }, { status: 'error', reason: 'no-web-model', action: 'switch-model' }],
    [{ ...base, failure: 'other', phase2: 'none' }, { status: 'error', reason: 'other', action: 'retry' }],
    [{ ...base, phase2: 'held' }, { status: 'running' }],
    [{ ...base, phase2: 'none' }, { status: 'running' }],
    [{ ...base, stopped: true, phase2: 'none' }, { status: 'idea', reason: 'stopped' }],
    [{ ...base, failure: 'stopped', phase2: 'none' }, { status: 'idea', reason: 'stopped' }],
    [{ ...base, stopped: true, phase1Written: false, phase2: 'none' }, { status: 'restore', reason: 'stopped' }]
  ];
  for (const [input, expected] of table) assert.deepEqual({ ...seamlessOutcome(input) }, expected, JSON.stringify(input));
});

test('seamlessOutcome never reports completed when any failure, stop or missing image is present', () => {
  for (const failure of [undefined, 'network', 'no-web-model', 'no-images', 'stopped', 'other']) {
    for (const stopped of [false, true]) for (const phase2 of ['applied', 'held', 'none']) for (const imagesRequested of [false, true]) for (const imagesSaved of [0, 3]) for (const phase1Written of [false, true]) {
      const outcome = seamlessOutcome({ failure, stopped, phase1Written, phase2, imagesRequested, imagesSaved });
      const clean = !failure && !stopped && phase2 === 'applied' && !(imagesRequested && imagesSaved === 0);
      assert.equal(outcome.status === 'completed', clean, JSON.stringify({ failure, stopped, phase2, imagesRequested, imagesSaved }));
    }
  }
});

test('the gate stays as before: SearchNotPerformed is classified, never converted into success', () => {
  const error = searchNotPerformedError();
  assert.equal(error.name, 'SearchNotPerformedError');
  assert.notEqual(seamlessOutcome({ failure: classifyFailure(error), phase1Written: true, phase2: 'none', imagesRequested: false, imagesSaved: 0 }).status, 'completed');
});

// ---------- research-verify step (P2): strict phase-2 parse, prompts ----------
const verify = load('core/steps/research-verify/step.ts', {}, { URL });
const { parseResearchVerify, researchVerifyStep, skeletonInstruction, RESEARCH_VERIFY_SCHEMA } = verify;
const validReply = (overrides = {}) => ({
  detail: '## 概念\n外套有分厚薄。[^1]',
  footnotes: [{ id: '1', url: 'https://example.org/a', title: 'A' }],
  verdicts: [{ sentence: '外套有分厚薄。', verdict: 'supported' }],
  images: [{ imageUrl: 'https://upload.example.org/a.jpg', sourceUrl: 'https://example.org/a', title: 'A', license: 'CC BY 4.0' }],
  ...overrides
});
const parseOf = value => parseResearchVerify(typeof value === 'string' ? value : JSON.stringify(value));
const parseReason = value => {
  try { parseOf(value); } catch (error) { assert.equal(error.name, 'ResearchVerifyParseError'); return error.reason; }
  assert.fail(`expected a parse error for ${JSON.stringify(value).slice(0, 120)}`);
};

test('research-verify parse: a valid reply keeps detail, footnotes, verdicts and images', () => {
  const result = plain(parseOf(validReply()));
  assert.equal(result.detail, '## 概念\n外套有分厚薄。[^1]');
  assert.deepEqual(result.footnotes, [{ id: '1', url: 'https://example.org/a', title: 'A' }]);
  assert.deepEqual(result.verdicts, [{ sentence: '外套有分厚薄。', verdict: 'supported' }]);
  assert.equal(result.images.length, 1);
});

test('research-verify parse: unsupported verdict keeps correction and sourceUrl; output feeds applyCorrections', () => {
  const result = plain(parseOf(validReply({
    detail: '外套都防水。',
    verdicts: [{ sentence: '外套都防水。', verdict: 'unsupported', correction: '多數外套不防水。', sourceUrl: 'https://example.org/b' }]
  })));
  assert.deepEqual(result.verdicts[0], { sentence: '外套都防水。', verdict: 'unsupported', correction: '多數外套不防水。', sourceUrl: 'https://example.org/b' });
  const applied = plain(apply.applyCorrections(result.detail, result.verdicts));
  assert.match(applied.detail, /多數外套不防水。\[\^1\]/);
  assert.match(applied.detail, /\[\^1\]: 原本寫：外套都防水。（來源：https:\/\/example\.org\/b）/);
});

test('research-verify parse: malformed replies are typed parse errors, never silent success', () => {
  const cases = [
    ['not JSON', 'here is your answer', 'not-json'],
    ['empty string', '', 'not-json'],
    ['array root', '[]', 'not-object'],
    ['null root', 'null', 'not-object'],
    ['markdown fence around JSON', '```json\n' + JSON.stringify(validReply()) + '\n```', 'not-json'],
    ['extra top-level field', { ...validReply(), notes: 'x' }, 'unexpected-field'],
    ['missing detail', (({ detail, ...rest }) => rest)(validReply()), 'detail'],
    ['blank detail', validReply({ detail: '  \n ' }), 'detail'],
    ['non-string detail', validReply({ detail: 3 }), 'detail'],
    ['missing footnotes', (({ footnotes, ...rest }) => rest)(validReply()), 'footnotes'],
    ['footnotes not an array', validReply({ footnotes: {} }), 'footnotes'],
    ['footnote with http url', validReply({ footnotes: [{ id: '1', url: 'http://example.org', title: 'A' }] }), 'footnotes'],
    ['footnote with javascript url', validReply({ footnotes: [{ id: '1', url: 'javascript:alert(1)', title: 'A' }] }), 'footnotes'],
    ['footnote id with bracket', validReply({ footnotes: [{ id: '1]', url: 'https://example.org', title: 'A' }] }), 'footnotes'],
    ['footnote missing title', validReply({ footnotes: [{ id: '1', url: 'https://example.org' }] }), 'footnotes'],
    ['footnote extra field', validReply({ footnotes: [{ id: '1', url: 'https://example.org', title: 'A', note: 'x' }] }), 'footnotes'],
    ['verdict outside the enum', validReply({ verdicts: [{ sentence: 'x', verdict: 'maybe' }] }), 'verdicts'],
    ['verdict with blank sentence', validReply({ verdicts: [{ sentence: ' ', verdict: 'supported' }] }), 'verdicts'],
    ['verdict correction not a string', validReply({ verdicts: [{ sentence: 'x', verdict: 'unsupported', correction: 4 }] }), 'verdicts'],
    ['verdict sourceUrl http', validReply({ verdicts: [{ sentence: 'x', verdict: 'unsupported', sourceUrl: 'http://example.org' }] }), 'verdicts'],
    ['verdict extra field', validReply({ verdicts: [{ sentence: 'x', verdict: 'supported', why: 'y' }] }), 'verdicts'],
    ['image http', validReply({ images: [{ imageUrl: 'http://x.org/a.png', sourceUrl: 'https://x.org', title: 'A', license: 'CC0' }] }), 'images'],
    ['image data url', validReply({ images: [{ imageUrl: 'data:image/png;base64,AAAA', sourceUrl: 'https://x.org', title: 'A', license: 'CC0' }] }), 'images'],
    ['image source page http', validReply({ images: [{ imageUrl: 'https://x.org/a.png', sourceUrl: 'http://x.org', title: 'A', license: 'CC0' }] }), 'images'],
    ['image missing license', validReply({ images: [{ imageUrl: 'https://x.org/a.png', sourceUrl: 'https://x.org', title: 'A' }] }), 'images'],
    ['image extra field', validReply({ images: [{ imageUrl: 'https://x.org/a.png', sourceUrl: 'https://x.org', title: 'A', license: 'CC0', alt: 'x' }] }), 'images'],
    ['images not an array', validReply({ images: 'none' }), 'images']
  ];
  for (const [name, input, reason] of cases) assert.equal(parseReason(input), reason, name);
});

test('research-verify parse: at most six images; seven is an error, six passes', () => {
  const image = index => ({ imageUrl: `https://x.org/${index}.png`, sourceUrl: 'https://x.org/p', title: `T${index}`, license: 'CC0' });
  assert.equal(parseOf(validReply({ images: [1, 2, 3, 4, 5, 6].map(image) })).images.length, 6);
  assert.equal(parseReason(validReply({ images: [1, 2, 3, 4, 5, 6, 7].map(image) })), 'too-many-images');
  assert.equal(RESEARCH_VERIFY_SCHEMA.properties.images.maxItems, 6);
});

test('research-verify parse: empty arrays are valid (no footnotes, verdicts or images found)', () => {
  const result = plain(parseOf(validReply({ footnotes: [], verdicts: [], images: [] })));
  assert.deepEqual([result.footnotes, result.verdicts, result.images], [[], [], []]);
});

test('research-verify parse: an image with a blank license still parses; eligibleImages is what refuses it', () => {
  const result = plain(parseOf(validReply({ images: [{ imageUrl: 'https://x.org/a.png', sourceUrl: 'https://x.org/p', title: 'A', license: 'unknown' }] })));
  assert.equal(plain(apply.eligibleImages(result.images)).eligible.length, 0);
});

test('research-verify schema: strict objects, https patterns, required fields', () => {
  const schema = plain(RESEARCH_VERIFY_SCHEMA);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['detail', 'footnotes', 'verdicts', 'images']);
  assert.deepEqual(schema.properties.verdicts.items.properties.verdict.enum, ['supported', 'unsupported']);
  assert.deepEqual(schema.properties.verdicts.items.required, ['sentence', 'verdict']);
  for (const key of ['footnotes', 'verdicts', 'images']) assert.equal(schema.properties[key].items.additionalProperties, false);
  assert.equal(schema.properties.images.items.properties.imageUrl.pattern, '^https://');
  assert.equal(researchVerifyStep.version, 1);
  assert.equal(researchVerifyStep.id, 'research-verify');
});

test('research-verify render: both instruction languages carry the same obligations and the inputs as JSON strings', () => {
  const input = language => ({ topic: '外套 "疊穿"', context: '', skeleton: '## 概念\n疊穿。', language });
  for (const language of ['zh-TW', 'zh-CN', 'en']) {
    const prompt = researchVerifyStep.render(input(language));
    assert.ok(!/\{\{|\}\}/.test(prompt), `${language}: unfilled placeholder`);
    assert.ok(prompt.includes(JSON.stringify('外套 "疊穿"')), `${language}: topic as JSON string`);
    assert.ok(prompt.includes(JSON.stringify('## 概念\n疊穿。')), `${language}: skeleton as JSON string`);
    for (const word of ['supported', 'unsupported', 'correction', 'sourceUrl', 'imageUrl', 'license', '[^1]', 'https', 'JSON']) assert.ok(prompt.includes(word), `${language}: ${word}`);
  }
  assert.match(researchVerifyStep.render(input('en')), /web search/i);
  assert.match(researchVerifyStep.render(input('zh-TW')), /網路搜尋/);
});

test('research-verify render: conflicting sources and untrusted pages are stated; images are not requested here', () => {
  const en = researchVerifyStep.render({ topic: 't', context: '', skeleton: 's', language: 'en' });
  assert.match(en, /sources conflict[\s\S]*era, region or definition/);
  assert.match(en, /untrusted data/);
  assert.match(en, /always return `images` as an empty array/);
  assert.match(en, /do not put images or image links inside `detail`/);
  assert.doesNotMatch(en, /at most 6/);
  const zh = researchVerifyStep.render({ topic: 't', context: '', skeleton: 's', language: 'zh-TW' });
  assert.match(zh, /來源互相矛盾[\s\S]*年代、地區或定義/);
  assert.match(zh, /不可信的資料/);
  assert.match(zh, /`images` 一律回傳空陣列/);
  assert.doesNotMatch(zh, /最多 6 張/);
});

test('research-verify render: unsupported is limited to contradicted or checkable unsourced claims; hedge before delete; no dated log', () => {
  const en = researchVerifyStep.render({ topic: 't', context: '', skeleton: 's', language: 'en' });
  assert.match(en, /contradicts the sentence, or the sentence is a specific, checkable factual claim/);
  assert.match(en, /General advice and explanations[\s\S]*are not listed as unsupported/);
  assert.match(en, /prefer a `correction` that downgrades it to a hedged qualifier[\s\S]*instead of deleting it/);
  assert.match(en, /Only when the sentence is wrong/);
  assert.match(en, /Do not add a dated update-log entry/);
  const zh = researchVerifyStep.render({ topic: 't', context: '', skeleton: 's', language: 'zh-TW' });
  assert.match(zh, /來源與它相反；或它是具體、可查核的事實主張/);
  assert.match(zh, /一般性的建議與解釋[\s\S]*不要列入/);
  assert.match(zh, /優先在 `correction` 寫一句降級為限定語的句子[\s\S]*不要刪除/);
  assert.match(zh, /只有句子本身是錯的/);
  assert.match(zh, /不要新增帶日期的「更新紀錄」條目/);
  assert.deepEqual(plain(parseOf(validReply({ images: [] }))).images, []);
});

// ---------- research images step (P2b) ----------
const imagesMod = load('core/steps/research-verify/images.ts', {}, { URL });
const { researchImagesStep, parseResearchImages, RESEARCH_IMAGES_SCHEMA } = imagesMod;
const imagesReply = images => JSON.stringify({ images });
const oneImage = (overrides = {}) => ({ imageUrl: 'https://upload.example.org/a.jpg', sourceUrl: 'https://example.org/a', title: 'A', license: 'CC BY-SA 4.0', ...overrides });
const imagesReason = raw => {
  try { parseResearchImages(raw); } catch (error) { assert.equal(error.name, 'ResearchVerifyParseError'); return error.reason; }
  assert.fail('expected a parse error');
};

test('research images step: id, schema, render carries inputs as JSON strings and the fetch-and-license rules', () => {
  assert.equal(researchImagesStep.id, 'research.images');
  assert.deepEqual(plain(RESEARCH_IMAGES_SCHEMA).required, ['images']);
  assert.equal(plain(RESEARCH_IMAGES_SCHEMA).properties.images.maxItems, 6);
  const prompt = researchImagesStep.render({ topic: '外套 "疊穿"', context: '穿搭' });
  assert.ok(!/\{\{|\}\}/.test(prompt));
  assert.ok(prompt.includes(JSON.stringify('外套 "疊穿"')) && prompt.includes(JSON.stringify('穿搭')));
  assert.match(prompt, /Open \(fetch\) the candidate pages/);
  assert.match(prompt, /actually saw in a fetched page/);
  assert.match(prompt, /license or credit exactly as stated on that page/);
  assert.match(prompt, /\{"images":\[\]\}/);
  assert.match(prompt, /untrusted data/);
});

test('research images step: parse keeps a valid list, accepts empty, rejects bad shapes and counts', () => {
  assert.equal(plain(parseResearchImages(imagesReply([oneImage()]))).images.length, 1);
  assert.deepEqual(plain(parseResearchImages(imagesReply([]))).images, []);
  assert.equal(imagesReason('nope'), 'not-json');
  assert.equal(imagesReason('[]'), 'not-object');
  assert.equal(imagesReason(JSON.stringify({ images: [], extra: 1 })), 'unexpected-field');
  assert.equal(imagesReason(JSON.stringify({})), 'images');
  assert.equal(imagesReason(imagesReply([oneImage({ imageUrl: 'http://x.org/a.png' })])), 'images');
  assert.equal(imagesReason(imagesReply([1, 2, 3, 4, 5, 6, 7].map(n => oneImage({ imageUrl: `https://x.org/${n}.png` })))), 'too-many-images');
});

test('research images step: a blank or unknown license parses but eligibleImages refuses it', () => {
  const { images } = plain(parseResearchImages(imagesReply([oneImage(), oneImage({ imageUrl: 'https://x.org/b.png', license: 'unknown' }), oneImage({ imageUrl: 'https://x.org/c.png', license: '' })])));
  const result = plain(apply.eligibleImages(images));
  assert.equal(result.eligible.length, 1);
  assert.deepEqual(result.rejected.map(r => r.reason), ['license', 'license']);
});

test('skeleton instruction: conservative, forbids numbers, dates, proper nouns, quotes and prices', () => {
  for (const language of ['zh-TW', 'zh-CN', 'en']) {
    const text = skeletonInstruction(language);
    assert.ok(text.length > 100 && !/\{\{/.test(text), language);
  }
  const zh = skeletonInstruction('zh-TW');
  for (const word of ['數字', '日期', '價格', '專有名詞', '引文', '架構', '概念']) assert.ok(zh.includes(word), word);
  const en = skeletonInstruction('en');
  for (const word of ['numbers', 'dates', 'prices', 'proper nouns', 'quotations', 'architecture', 'concepts']) assert.ok(en.includes(word), word);
  assert.equal(skeletonInstruction('zh-TW'), skeletonInstruction('zh-CN'));
});

// ---------- R1 F1: allowlist builder, URL gate, private hosts ----------
const { normalizeHttpsUrl } = apply;
const hasImageNode = text => /(^|[^\\])!\[/.test(text) || /<img/i.test(text);
const BYPASSES = [
  ['R1-B1 nested brackets in alt text', '![a [b] c](https://evil.example/x.png?q=secret)'],
  ['R1-B1 reference-style image with a definition', '![x]\n\n[x]: https://evil.example/i.png'],
  ['R1-B1 collapsed reference image', '![x][]\n\n[x]: https://evil.example/i.png'],
  ['R1-B1 full reference image', '![x][r]\n\n[r]: https://evil.example/i.png'],
  ['R1-B1 angle-bracket destination', '![a](<https://evil.example/x y.png>)'],
  ['R1-B1 image inside a link', '[![x](https://evil.example/i.png)](https://ok.example)'],
  ['R1-B1 title containing a paren', '![x](https://evil.example/i.png "t)")'],
  ['R1-B1 raw img split over lines', '<img\nsrc="https://evil.example/i.png">'],
  ['R1-B1 parenthesized url', '![x](https://evil.example/a(b).png)']
];

test('R1-B1 allowlist builder: no image node or remote load survives any bypass form', () => {
  for (const [name, input] of BYPASSES) {
    const out = clean(input);
    assert.ok(!hasImageNode(out), `${name}: ${JSON.stringify(out)}`);
    assert.ok(!/evil\.example/.test(out.replace(/\[[^\]]*\]:\s*\S+/g, '')) || !/!\[/.test(out), name);
  }
});

test('R1-B1 allowlist builder: wiki links, reference links and unknown footnote references become escaped text', () => {
  assert.equal(clean('[[Secret note]]'), '\\[\\[Secret note\\]\\]');
  assert.equal(clean('[x][r]'), '\\[x\\]\\[r\\]');
  const out = sanitizePhase2Markdown('見[^1]和[^9]', { footnoteIds: new Set(['1']) }).markdown;
  assert.equal(out, '見[^1]和\\[^9\\]');
});

test('R1-B1 allowlist builder: own embeds pass only when listed; the output is stable when built twice', () => {
  const options = { embeds: new Set(['Att/a.png']) };
  assert.equal(sanitizePhase2Markdown('![[Att/a.png]]\n![[Att/b.png]]', options).markdown, '![[Att/a.png]]');
  for (const [, input] of BYPASSES.concat([['mix', '## 標題\n\n- 內容[^1] [來源](https://example.com/a?b=c) [[w]] <b>x</b>\n\n[^1]: [S](https://example.com)']])) {
    const once = sanitizePhase2Markdown(input, options).markdown;
    assert.equal(sanitizePhase2Markdown(once, options).markdown, once, input);
  }
});

test('R1-B1 footnote titles: <img>, markdown images and nested brackets never reach the definition', () => {
  const out = renderFootnoteDefinitions([
    { id: '1', url: 'https://ok.example/', title: '<img src="https://evil.example/p.png?q=secret">' },
    { id: '2', url: 'https://ok.example/', title: '![x](https://evil.example/i.png)' },
    { id: '3', url: 'https://ok.example/', title: '[<img src="https://evil.example/p.png">](https://ok.example/)' },
    { id: '4', url: 'https://ok.example/', title: 'a\\' }
  ]);
  assert.doesNotMatch(out, /evil\.example|<img|!\[/);
  assert.equal(out.split('\n').length, 4);
  for (const line of out.split('\n')) assert.match(line, /^\[\^\d\]: \[(?:[^\][\\]|\\.)*\]\(https:\/\/ok\.example\/\)$/);
});

test('R1-B1 corrections: correction text and old-sentence footnotes go through the builder', () => {
  const result = applyCorrections('外套很保暖。', [{ sentence: '外套很保暖。', verdict: 'unsupported', correction: '<img src="https://evil.example/p.png?q=secret"> ![x](https://evil.example/i.png) 其實普通。', sourceUrl: 'https://ok.example/a' }]);
  assert.doesNotMatch(result.detail, /evil\.example|<img|!\[/);
  assert.match(result.detail, /其實普通。/);
  assert.deepEqual(plain(result.addedFootnoteIds), ['1']);
  const gone = applyCorrections('外套很保暖。', [{ sentence: '外套很保暖。', verdict: 'unsupported', correction: '<img src="https://evil.example/p.png">' }]);
  assert.equal(gone.removed.length, 1, 'a correction with nothing left removes the sentence');
});

test('R1-M1 URL gate: Wikimedia address with parentheses is accepted and written with %28 %29', () => {
  const wiki = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Coat_(October_08,_2017).jpg';
  assert.equal(normalizeHttpsUrl(wiki), 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Coat_%28October_08,_2017%29.jpg');
  assert.ok(apply.isHttpsUrl(wiki));
  assert.equal(clean(`[圖](${wiki})`), '[圖](https://upload.wikimedia.org/wikipedia/commons/a/ab/Coat_%28October_08,_2017%29.jpg)');
  const out = renderFootnoteDefinitions([{ id: '1', url: wiki, title: 'File' }]);
  assert.match(out, /Coat_%28October_08,_2017%29\.jpg\)$/);
});

test('R1-M1 URL gate: an escape string cannot close the link or open an image', () => {
  const evil = 'https://x.example/a)![i](https://evil.example/p.png';
  const href = normalizeHttpsUrl(evil);
  assert.ok(href && !/[()[\]!]/.test(href.slice(8)), href);
  const out = renderFootnoteDefinitions([{ id: '1', url: evil, title: 'T' }]);
  assert.ok(!hasImageNode(out) && !/!\[/.test(out), out);
  assert.equal((out.match(/\]\(/g) || []).length, 1);
  assert.ok(!/!\[/.test(clean(`[a](<${evil}>)`)));
});

test('R1-M1 URL gate: javascript, http, data, credentials, private hosts and unsafe characters stay rejected', () => {
  for (const bad of [
    'javascript:alert(1)', 'http://example.com/a', 'data:text/html;base64,AAA', 'https://user:pw@example.com/a', 'https://user@example.com/a', 'https://@example.com/a',
    'https://localhost/a', 'https://192.168.1.5/a', 'https://example.com/a b', 'https://example.com/a\tb', 'https://example.com/a\u0000b', 'https://example.com/a<b',
    'https://example.com/a"b', "https://example.com/a'b", 'https://example.com/a`b', 'https://example.com/a\\b', `https://example.com/a${String.fromCharCode(0x200b)}b`, 'https://', 'https:///a', ''
  ])
    assert.equal(normalizeHttpsUrl(bad), undefined, JSON.stringify(bad));
});

test('R1-M1 parse: one bad footnote, source address or image is dropped, the rest of phase 2 stays', () => {
  const result = plain(parseOf(validReply({
    footnotes: [
      { id: '1', url: 'https://example.org/a', title: 'A' },
      { id: '2', url: 'https://example.org/a b', title: 'space' },
      { id: '3', url: 'https://127.0.0.1/a', title: 'private' },
      { id: '4', url: 'https://commons.example/File_(x).jpg', title: 'paren' }
    ],
    verdicts: [{ sentence: 'x', verdict: 'unsupported', correction: 'y', sourceUrl: 'https://user:pw@example.org/' }],
    images: [
      { imageUrl: 'https://x.org/a.png', sourceUrl: 'https://x.org/p', title: 'ok', license: 'CC0' },
      { imageUrl: 'https://x.org/b c.png', sourceUrl: 'https://x.org/p', title: 'bad', license: 'CC0' },
      { imageUrl: 'https://upload.example/File_(1).jpg', sourceUrl: 'https://x.org/p', title: 'paren', license: 'CC0' }
    ]
  })));
  assert.deepEqual(result.footnotes.map(note => note.id), ['1', '4']);
  assert.equal(result.footnotes[1].url, 'https://commons.example/File_%28x%29.jpg');
  assert.deepEqual(result.verdicts[0], { sentence: 'x', verdict: 'unsupported', correction: 'y' });
  assert.deepEqual(result.images.map(image => image.title), ['ok', 'paren']);
  assert.equal(result.images[1].imageUrl, 'https://upload.example/File_%281%29.jpg');
});

test('R1-M1 images parse: a bad address drops that image only', () => {
  const { images } = plain(parseResearchImages(imagesReply([oneImage(), oneImage({ imageUrl: 'https://x.org/a b.png' }), oneImage({ sourceUrl: 'https://10.0.0.1/p' })])));
  assert.equal(images.length, 1);
});

test('R1-M2 private hosts: IPv4-mapped and compatible IPv6, CGNAT, and other forms are rejected; public hosts pass', () => {
  for (const host of [
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::127.0.0.1]', '[::7f00:1]', '[::ffff:10.0.0.1]', '[::ffff:a9fe:a9fe]', '[::1]', '[::]', '[fd00::1]', '[fe80::1]',
    '100.64.0.1', '100.127.255.254', '0x7f000001', '2130706433', '127.1', '169.254.169.254', '172.16.0.1', '10.1.2.3', 'localhost.', 'printer.local', 'a.internal', '[64:ff9b::7f00:1]', '[2002:7f00:1::]'
  ])
    assert.equal(normalizeHttpsUrl(`https://${host}/a.png`), undefined, host);
  for (const host of ['100.63.255.255', '100.128.0.1', '8.8.8.8', '[2606:4700:4700::1111]', 'upload.wikimedia.org'])
    assert.ok(normalizeHttpsUrl(`https://${host}/a.png`), host);
  const bad = ['https://[::ffff:127.0.0.1]/a.png', 'https://100.64.0.1/a.png'].map(imageUrl => img({ imageUrl }));
  assert.equal(eligibleImages(bad).eligible.length, 0);
});

// ---------- F2: short skeleton task, user choices in the phase-2 prompt (R1-B2, R1-M3) ----------

test('R1-B2 skeleton task: a short format with a length cap, no page layout, in every instruction language', () => {
  for (const language of ['zh-TW', 'zh-CN', 'en']) {
    const text = skeletonInstruction(language);
    assert.match(text, /600|300/, `${language}: length cap`);
    assert.match(text, /##/, `${language}: short sections`);
    assert.ok(text.length < 1500, `${language}: the task text itself stays short`);
  }
});

test('R1-M3 research-verify render: no choices adds nothing; each choice adds its block after the base prompt', () => {
  const base = { topic: '外套', context: '穿搭', skeleton: '## 概念\n疊穿。', language: 'zh-TW' };
  const plainPrompt = researchVerifyStep.render(base);
  assert.equal(researchVerifyStep.render({ ...base, requirements: '  ', toneText: '', structure: '\n' }), plainPrompt);
  const withAll = researchVerifyStep.render({ ...base, requirements: '只談休閒穿搭"', toneText: '平實語氣', structure: '- 核心：結論' });
  assert.ok(withAll.startsWith(plainPrompt.trimEnd()));
  assert.match(withAll, /只談休閒穿搭\\"/, 'requirements are a JSON string, so a quote cannot end it');
  assert.match(withAll, /平實語氣/);
  assert.match(withAll, /- 核心：結論/);
  const english = researchVerifyStep.render({ ...base, language: 'en', requirements: 'casual only' });
  assert.match(english, /The user's extra requirements/);
  assert.doesNotMatch(researchVerifyStep.render({ ...base, requirements: 'x' }), /內容範本|文字語氣/, 'only the chosen blocks appear');
});

test('R2-N3 hosts are written as punycode; an address without a path keeps no trailing slash', () => {
  assert.equal(apply.normalizeHttpsUrl('https://\u0430pple.com/login'), 'https://xn--pple-43d.com/login');
  assert.equal(apply.normalizeHttpsUrl('https://\u0430pple.com'), 'https://xn--pple-43d.com');
  assert.equal(apply.normalizeHttpsUrl('https://Example.COM/A?b=(c)'), 'https://example.com/A?b=%28c%29');
  assert.equal(apply.normalizeHttpsUrl('https://example.com'), 'https://example.com');
});

test('R2-N1 builder: the scheme text is kept and escaped, nothing is deleted from plain text', () => {
  const out = apply.sanitizePhase2Markdown('!javascript:x[a](https://evil.example/i.png)').markdown;
  assert.equal(out, '\\!javascript:x[a](https://evil.example/i.png)');
  const two = apply.sanitizePhase2Markdown('!![i](https://x.example/)[java](javascript:1)script:y[a](https://evil.example/i.png)').markdown;
  assert.doesNotMatch(two.replace(/\\[\s\S]/g, '  '), /!\[/);
  assert.equal(apply.sanitizePhase2Markdown('a (b) `c` d > e!').markdown, 'a \\(b\\) \\`c\\` d \\> e\\!');
  assert.equal(apply.sanitizePhase2Markdown('> quote\n> [!note] x').markdown, '> quote\n> [!note] x');
});

// Image download SSRF guard: fetchPublicImage re-checks every hop and pins the connection (fake lookup/get, no network).
const imageFetch = load('core/seamless-research/image-fetch.ts', {}, { URL });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
function imageHarness({ dns = {}, pages = {}, signal = new AbortController().signal } = {}) {
  const gets = [];
  const lookups = [];
  const deps = {
    signal,
    lookup: async host => {
      lookups.push(host);
      return dns[host] ?? [{ address: '93.184.216.34', family: 4 }];
    },
    get: async request => {
      gets.push(request);
      const page = pages[request.url];
      if (!page) throw new Error('unexpected request');
      return page;
    }
  };
  return { deps, gets, lookups };
}
const redirectTo = location => ({ status: 302, location });

test('image fetch: redirect to a private IPv4 literal throws after one request', async () => {
  const h = imageHarness({ pages: { 'https://a.example/x.png': redirectTo('https://127.0.0.1/x.png') } });
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps));
  assert.equal(h.gets.length, 1);
});

test('image fetch: redirect to http throws', async () => {
  const h = imageHarness({ pages: { 'https://a.example/x.png': redirectTo('http://example.com/x.png') } });
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps));
  assert.equal(h.gets.length, 1);
});

test('image fetch: redirect to localhost, mapped IPv6 loopback and metadata address each throw', async () => {
  for (const target of ['https://localhost/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/']) {
    const h = imageHarness({ pages: { 'https://a.example/x.png': redirectTo(target) } });
    await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), undefined, target);
    assert.equal(h.gets.length, 1, target);
  }
});

test('image fetch: one private DNS answer among public ones throws before any request', async () => {
  const h = imageHarness({ dns: { 'a.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] } });
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), /private address/);
  assert.equal(h.gets.length, 0);
});

test('image fetch: loopback, CGNAT, ::1 and mapped private DNS answers each throw', async () => {
  const answers = [
    { address: '127.0.0.1', family: 4 },
    { address: '100.64.0.1', family: 4 },
    { address: '::1', family: 6 },
    { address: '::ffff:192.168.1.1', family: 6 }
  ];
  for (const answer of answers) {
    const h = imageHarness({ dns: { 'a.example': [answer] } });
    await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), undefined, answer.address);
    assert.equal(h.gets.length, 0, answer.address);
  }
});

test('image fetch: an empty DNS answer throws', async () => {
  const h = imageHarness({ dns: { 'a.example': [] } });
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps));
  assert.equal(h.gets.length, 0);
});

test('image fetch: rebinding on a redirect target (public first hop, private second) throws without a second request', async () => {
  const h = imageHarness({
    dns: { 'b.example': [{ address: '192.168.0.5', family: 4 }] },
    pages: { 'https://a.example/x.png': redirectTo('https://b.example/y.png') }
  });
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), /private address/);
  assert.equal(h.gets.length, 1);
  assert.deepEqual(h.lookups, ['a.example', 'b.example']);
});

test('image fetch: 3 redirects succeed, 4 throw', async () => {
  const chain = count => {
    const pages = {};
    for (let i = 0; i < count; i++) pages[`https://h${i}.example/p`] = redirectTo(`https://h${i + 1}.example/p`);
    pages[`https://h${count}.example/p`] = { status: 200, body: PNG };
    return pages;
  };
  const ok = imageHarness({ pages: chain(3) });
  assert.deepEqual(Array.from(await imageFetch.fetchPublicImage('https://h0.example/p', ok.deps)), Array.from(PNG));
  const bad = imageHarness({ pages: chain(4) });
  await assert.rejects(imageFetch.fetchPublicImage('https://h0.example/p', bad.deps), /redirect limit/);
});

test('image fetch: a redirect without Location throws; a relative Location resolves against the current URL', async () => {
  const missing = imageHarness({ pages: { 'https://a.example/x.png': { status: 301 } } });
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', missing.deps));
  const h = imageHarness({
    pages: { 'https://a.example/dir/x.png': redirectTo('/b.png'), 'https://a.example/b.png': { status: 200, body: PNG } }
  });
  await imageFetch.fetchPublicImage('https://a.example/dir/x.png', h.deps);
  assert.equal(h.gets[1].url, 'https://a.example/b.png');
  assert.equal(h.gets[1].hostname, 'a.example');
});

test('image fetch: the request is pinned to the validated address', async () => {
  const h = imageHarness({
    dns: { 'a.example': [{ address: '2606:2800:220:1::1', family: 6 }, { address: '93.184.216.34', family: 4 }] },
    pages: { 'https://a.example/x.png': { status: 200, body: PNG } }
  });
  await imageFetch.fetchPublicImage('https://a.example/x.png', h.deps);
  assert.equal(h.gets[0].address, '2606:2800:220:1::1');
  assert.equal(h.gets[0].family, 6);
});

test('image fetch: 404 and 500 throw', async () => {
  for (const status of [404, 500]) {
    const h = imageHarness({ pages: { 'https://a.example/x.png': { status } } });
    await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), undefined, String(status));
  }
});

test('image fetch: a stop after the DNS lookup returns undefined and sends no request', async () => {
  const controller = new AbortController();
  const h = imageHarness({ signal: controller.signal });
  const lookup = h.deps.lookup;
  h.deps.lookup = async host => {
    const answers = await lookup(host);
    controller.abort();
    return answers;
  };
  assert.equal(await imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), undefined);
  assert.equal(h.gets.length, 0);
});

test('image fetch: a download that rejects because the run was stopped returns undefined', async () => {
  const controller = new AbortController();
  const h = imageHarness({ signal: controller.signal });
  h.deps.get = async () => {
    controller.abort();
    throw new Error('image download stopped');
  };
  assert.equal(await imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), undefined);
});

test('image fetch: a download that rejects while not stopped still throws', async () => {
  const h = imageHarness();
  h.deps.get = async () => {
    throw new Error('image download failed');
  };
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/x.png', h.deps), /image download failed/);
});

test('image fetch: errors do not carry the full URL', async () => {
  const h = imageHarness({ pages: { 'https://a.example/secret-token.png': redirectTo('https://127.0.0.1/secret-token2') } });
  await assert.rejects(imageFetch.fetchPublicImage('https://a.example/secret-token.png', h.deps), error => !/secret-token/.test(error.message));
});

test('pinnedLookup answers with the given address in both callback shapes', () => {
  const lookup = imageFetch.pinnedLookup('93.184.216.34', 4);
  let all;
  lookup('x.example', { all: true }, (error, list) => (all = { error, list }));
  assert.equal(all.error, null);
  assert.deepEqual(JSON.parse(JSON.stringify(all.list)), [{ address: '93.184.216.34', family: 4 }]);
  let one;
  lookup('x.example', {}, (error, address, family) => (one = { error, address, family }));
  assert.deepEqual(one, { error: null, address: '93.184.216.34', family: 4 });
});
