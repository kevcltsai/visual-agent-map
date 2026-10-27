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
  assert.equal(out, '[^1]: [標題  x](https://example.com/a)');
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
