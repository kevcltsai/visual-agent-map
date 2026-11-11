// P6: the Markdown builders of a facet-judged argument map's notes (pure functions). Security first: model/web text is inert inside
// tables, callouts and the program-built chart; URLs are http(s) only; a chart needs 2+ numbers of one unit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const N = S.load('experiences/visual-map/argument-notes.ts');
const { unsafeMermaid } = S.load('ai/mermaid-safety.ts');
const { translate } = S.load('i18n.ts');

const t = (key, ...values) => translate('zh-TW', key, ...values);
const proof = (over = {}) => ({ url: 'https://stats.example.org/r', quote: 'Rate was 9.1 percent', claim: 'Youth rate', check: 'page_match', checkedAt: 'x', figure: { number: '9.1', period: '2026-07', unit: '%' }, ...over });
const datum = (over = {}) => ({ id: 'd1', need: 'youth rate', attempts: 1, state: 'found', proof: proof(), propStance: 'supports', stanceReason: 'higher than overall', facetId: 'f1', ...over });
const facet = (over = {}) => ({ id: 'f1', title: 'Compare', verdict: 'supports', reason: 'clear gap', citedData: ['d1'], summary: 'sum', ...over });
const state = (data, facets = [facet()], extra = {}) => ({ v: 1, roles: { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' }, run: { runId: 'r', phase: 'analysis', status: 'running', researchCalls: 0 }, situation: { data, gate: { state: 'matched', citedData: [], round: 1 }, facets, question: 'Is it rising?' }, hypotheses: [], conclusion: { state: 'pending', basedOn: [], missing: [] }, ...extra });
const hyp = (over = {}) => ({ id: 'h1', citedData: ['d1'], round: 1, location: 'verifying', needs: [], aiVerdict: 'supported', ...over });
const need = (over = {}) => ({ id: 'n1', text: 'need', addedRound: 1, state: 'found', stance: 'supports', proof: proof(), ...over });
const rowsOf = md => md.split('\n').filter(l => l.startsWith('| '));
const pipes = row => (row.match(/\|/g) ?? []).length;
const EVIL = ['a|b', 'x\n### Injected\n> [!danger]', 'link ]] and [[Secret]]', '<script>alert(1)</script>', '![[Secret]]', '[x](javascript:alert(1))'];

test('table cells: a pipe never splits the row, a newline never starts a new line', () => {
  for (const bad of EVIL) {
    const md = N.datumDetail(t, datum({ need: bad, stanceReason: bad, proof: proof({ figure: { number: '9.1', period: bad, unit: '%' } }) }));
    for (const row of rowsOf(md)) assert.equal(pipes(row), 6, `${JSON.stringify(bad)} -> ${row}`);
    assert.ok(!md.split('\n').some(l => l === '### Injected' || l === '> [!danger]'), JSON.stringify(bad));
  }
});
test('wiki links, embeds and raw HTML are inert in every builder', () => {
  const evil = EVIL.join(' ');
  const h = hyp({ basis: evil, insights: [{ kind: 'tension', text: evil }], needs: [need({ text: evil })] });
  const st = state([datum({ need: evil })], [facet({ title: evil, reason: evil, summary: evil })], { hypotheses: [h], conclusion: { state: 'concluded', basedOn: ['h1'], missing: [] } });
  const outs = [
    N.datumDetail(t, st.situation.data[0]),
    N.notFoundDetail(t, { queries: [evil], opened: ['https://a.example/x'], why: `source_quote_missing: ${evil}` }, 'x'),
    N.facetDetail(t, st.situation.facets[0], st.situation.data),
    N.situationDetail(t, st),
    N.definitionsDetail(t, [{ label: evil, value: evil, reason: evil }], [evil]),
    N.hypothesisDetail(t, h, evil),
    N.conclusionDetail(t, st, new Map([['h1', evil]]), { summary: evil, points: [evil] }),
    N.conclusionDetail(t, state([datum()], [facet({ verdict: 'refutes', reason: evil })]), new Map(), undefined, evil)
  ];
  for (const md of outs) {
    assert.ok(!/\[\[|\]\]/.test(md), 'wikilink');
    assert.ok(!/<script|<\/script/i.test(md), 'html');
    assert.ok(!/!\[/.test(md), 'embed');
    assert.ok(!/\]\(/.test(md), 'markdown link');
  }
});

// ---- chart -------------------------------------------------------------------------------------------------------------------------
const fig = (number, unit = '%', period = '2026') => ({ number, period, unit });
test('chart: two numbers of one unit draw a program-built xychart', () => {
  const chart = N.buildChart('Rates', [{ label: 'Youth', figure: fig('9.1') }, { label: 'All', figure: fig('4.3') }]);
  assert.equal(chart, ['```mermaid', 'xychart-beta', '  title "Rates"', '  x-axis ["Youth", "All"]', '  y-axis "%" 0 --> 9.1', '  bar [9.1, 4.3]', '```'].join('\n'));
});
test('chart: mixed units, fewer than two numbers, or non-numbers draw nothing', () => {
  assert.equal(N.buildChart('t', [{ label: 'a', figure: fig('9.1', '%') }, { label: 'b', figure: fig('4', 'people') }]), '');
  assert.equal(N.buildChart('t', [{ label: 'a', figure: fig('9.1') }]), '');
  assert.equal(N.buildChart('t', [{ label: 'a', figure: fig('9.1') }, { label: 'b', figure: fig('about nine') }, { label: 'c' }]), '');
  for (const bad of ['NaN', 'Infinity', '1e999', '', '9.1.2', '--3']) assert.equal(N.buildChart('t', [{ label: 'a', figure: fig('1') }, { label: 'b', figure: fig(bad) }]), '', bad);
  assert.ok(N.buildChart('t', [{ label: 'a', figure: fig('1,200', 'people') }, { label: 'b', figure: fig('300', 'people') }]).includes('bar [1200, 300]'));
});
test('chart: labels cannot carry quotes, brackets, directives or line breaks; the block stays a safe mermaid block', () => {
  const evil = ['"] \nclick A call alert()\n%%{init: {"theme":"x"}}%%', 'a"b', '[x]', '{y}', '(z);', 'x'.repeat(60), '<img src=x>'];
  for (const bad of evil) {
    const chart = N.buildChart(bad, [{ label: bad, figure: fig('2') }, { label: `${bad}2`, figure: fig('3') }]);
    const lines = chart.split('\n');
    assert.equal(lines.length, 7, JSON.stringify(bad));
    assert.equal(lines[0], '```mermaid');
    assert.ok(!lines.some(l => /^\s*(click|call)\b/.test(l)) && !chart.includes('%%{') && !/<[a-z]/i.test(chart), JSON.stringify(bad));
    assert.ok(!unsafeMermaid(lines.slice(1, -1)), JSON.stringify(bad));
    for (const l of lines.slice(2, 5)) assert.ok((l.match(/"/g) ?? []).length % 2 === 0 && !/[[\]{}();]/.test(l.replace(/^\s*x-axis \[|\]$|^\s*y-axis "[^"]*" .*$/g, '').replace(/"[^"]*"/g, '')), l);
    assert.ok(lines[3].split('"').every((part, i) => i % 2 === 0 || part.length <= 20), 'label length');
  }
});

// ---- URLs and reasons ---------------------------------------------------------------------------------------------------------------
test('URLs: only http(s) is written, and never as link syntax', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'ftp://a.example/x', 'obsidian://open?vault=x', 'not a url', '']) {
    assert.equal(N.safeUrl(bad), '', bad);
    const md = N.datumDetail(t, datum({ proof: proof({ url: bad }) }));
    assert.ok(!md.includes('javascript:') && !md.includes('file:') && !md.includes('ftp:') && !md.includes('obsidian:'), bad);
  }
  assert.equal(N.safeUrl('https://a.example/x?q=1'), 'https://a.example/x?q=1');
  assert.ok(!/[()[\]<>|\s]/.test(N.safeUrl('http://a.example/p(1)[2]|x y')));
  assert.ok(N.datumDetail(t, datum()).includes('https://stats.example.org/r'));
  const nf = N.notFoundDetail(t, { queries: [], opened: ['javascript:alert(1)', 'https://ok.example/p'], why: 'x' }, 'x');
  assert.ok(nf.includes('https://ok.example/p') && !nf.includes('javascript:'));
});
test('not found: a readable reason and the program-recorded searches; no raw code anywhere', () => {
  const md = N.notFoundDetail(t, { queries: ['q one', 'q two'], opened: ['https://a.example/x'], why: 'source_quote_missing: page has only a single-year number' }, 'x');
  assert.ok(md.includes(t('ui.argument_why_source_quote_missing')));
  assert.ok(md.includes('q one') && md.includes('q two') && md.includes('single-year number'));
  assert.ok(!md.includes('source_quote_missing') && !md.includes('[!note]-'), md);
  assert.ok(N.notFoundDetail(t, undefined, 'budget').includes(t('ui.argument_why_budget')));
  assert.equal(N.whyText(t, 'something_new'), t('ui.argument_why_not_found'));
});

// ---- card content --------------------------------------------------------------------------------------------------------------------
test('facet card: verdict, data table with the stance and reason, a chart only for comparable numbers, sources', () => {
  const data = [datum(), datum({ id: 'd2', need: 'overall', proof: proof({ quote: 'overall 4.3', figure: fig('4.3', '%', '2026-07') }), stanceReason: 'baseline' }), datum({ id: 'd3', need: 'people', proof: proof({ figure: fig('5', 'people') }) })];
  const md = N.facetDetail(t, facet(), data.slice(0, 2));
  assert.ok(md.startsWith(`### ${t('ui.argument_note_core')}`) && md.includes(t('ui.argument_note_verdict_supports')) && md.includes('clear gap'));
  assert.equal(rowsOf(md).length, 4);
  assert.ok(md.includes('```mermaid') && md.includes('bar [9.1, 4.3]'));
  assert.ok(md.includes('"Rate was 9.1 percent"') && md.includes('https://stats.example.org/r'));
  assert.ok(!N.facetDetail(t, facet(), data).includes('```mermaid'), 'mixed units: no chart');
  assert.ok(!N.facetDetail(t, facet(), [data[0]]).includes('```mermaid'), 'one number: no chart');
});
test('definitions card: a table of items and, after the judgement, the insights', () => {
  const items = [{ label: 'Age', value: '16-24', reason: 'BLS' }];
  assert.ok(!N.definitionsDetail(t, items).includes(t('ui.argument_note_definition_insights')));
  const md = N.definitionsDetail(t, items, ['holds under the BLS age band']);
  assert.equal(rowsOf(md).length, 3);
  assert.ok(md.includes(t('ui.argument_note_definition_insights')) && md.includes('holds under the BLS age band'));
});
test('hypothesis card: verdict, why it holds, insights by kind, evidence table with missing needs', () => {
  const h = hyp({ basis: 'datum shows X', insights: [{ kind: 'consistent', text: 'agree' }, { kind: 'tension', text: 'pull' }, { kind: 'missing', text: 'lack' }], needs: [need(), need({ id: 'n2', text: 'gone', state: 'not_found', proof: undefined, stance: undefined })] });
  const md = N.hypothesisDetail(t, h, 'two studies agree');
  assert.ok(md.includes(t('ui.argument_note_hyp_supported_0_1', '1', '2')) && md.includes(t('ui.argument_note_why_holds')) && md.includes('two studies agree'));
  for (const k of ['consistent', 'tension', 'missing']) assert.ok(md.includes(t(`ui.argument_note_insight_${k}`)));
  assert.ok(md.includes(t('ui.argument_note_need_missing')) && md.includes(t('ui.argument_note_need_supports')));
  assert.ok(N.hypothesisDetail(t, hyp({ aiVerdict: 'refuted' }), 'r').includes(t('ui.argument_note_why_fails')));
});
test('conclusion card (concluded): summary, insights, basis table, eliminated, situation basis', () => {
  const st = state([datum()], [facet()], { hypotheses: [hyp({ needs: [need()] }), hyp({ id: 'h2', location: 'eliminated', eliminationReason: 'round_limit: not verified after round 3' }), hyp({ id: 'h3', location: 'eliminated', eliminationReason: 'the data fall' })], conclusion: { state: 'concluded', basedOn: ['h1'], missing: [] } });
  const md = N.conclusionDetail(t, st, new Map([['h1', 'Hyp 1'], ['h2', 'Hyp 2'], ['h3', 'Hyp 3']]), { summary: 'final answer', points: ['p1', 'p2'] });
  for (const key of ['core', 'insights', 'basis_hypotheses', 'eliminated', 'unverified', 'situation_basis']) assert.ok(md.includes(`### ${t(`ui.argument_note_${key}`)}`), key);
  assert.ok(md.includes('final answer') && md.includes('Hyp 1') && md.includes('Hyp 2') && md.includes(t('ui.argument_unverified_limit')) && md.includes('the data fall'));
  assert.ok(!md.includes('round_limit'));
});
test('conclusion card (stopped): the refuting facet with datum quote and link, or the insufficient facets with their searches', () => {
  const refuted = N.conclusionDetail(t, state([datum({ propStance: 'refutes' })], [facet({ verdict: 'refutes', reason: 'rate fell' })]), new Map(), undefined, 'stopped sentence');
  assert.ok(refuted.includes('stopped sentence') && refuted.includes(t('ui.argument_note_refuting')) && refuted.includes('"Rate was 9.1 percent"') && refuted.includes('https://stats.example.org/r'));
  const lacking = N.conclusionDetail(t, state([datum({ id: 'd9', state: 'not_found', proof: undefined, propStance: undefined, searchLog: { queries: ['10-year average'], opened: [], why: 'not_found' } })], [facet({ verdict: 'insufficient', citedData: [] })]), new Map(), undefined, 's');
  assert.ok(lacking.includes(t('ui.argument_note_insufficient')) && lacking.includes('10-year average'));
});

// ---- block / reference syntax from model or web text (security review) ---------------------------------------------------------------
const BLOCK_EVIL = ['[x]: https://evil.example/a', 'see [a][b] now', '# Heading', '%%comment%% hidden', '$$x^2$$ math', '```js\nalert(1)', '> quoted', '1. listed', '   indented', '- bullet', '+ plus', '=== setext', '~~~ fence', '2) paren'];
const allBuilders = evil => {
  const h = hyp({ basis: evil, insights: [{ kind: 'tension', text: evil }], needs: [need({ text: evil })] });
  const st = state([datum({ need: evil, stanceReason: evil })], [facet({ title: evil, reason: evil, summary: evil })], { hypotheses: [h], conclusion: { state: 'concluded', basedOn: ['h1'], missing: [] } });
  return [
    N.datumDetail(t, st.situation.data[0]),
    N.notFoundDetail(t, { queries: [evil], opened: [], why: `source_quote_missing: ${evil}` }, 'x'),
    N.facetDetail(t, st.situation.facets[0], st.situation.data),
    N.situationDetail(t, st),
    N.definitionsDetail(t, [{ label: evil, value: evil, reason: evil }], [evil]),
    N.hypothesisDetail(t, h, evil),
    N.conclusionDetail(t, st, new Map([['h1', evil]]), { summary: evil, points: [evil] }),
    N.conclusionDetail(t, state([datum()], [facet({ verdict: 'refutes', reason: evil })]), new Map(), undefined, evil)
  ];
};
test('block and reference syntax in model text is inert in every builder', () => {
  for (const evil of BLOCK_EVIL) for (const md of allBuilders(evil)) {
    const first = evil.split('\n')[0];
    assert.ok(!/\[[^\]]*\]\s*:|\]\s*\[|\[|\]/.test(md.replace(/\[!(?:summary|note)\]-?/g, '').replace(/```mermaid[\s\S]*?```/g, '')), `bracket survives: ${JSON.stringify(evil)}`);
    assert.ok(!/%%|\$\$/.test(md), `%% or $$ survives: ${JSON.stringify(evil)}`);
    const marker = /^\s*([#>+\-*=~`]|\d+[.)])/.test(first);
    if (marker) assert.ok(!md.split('\n').some(l => ['', '- ', '> ', '| ', '  - ', '- 1: '].some(pre => l.startsWith(pre + first.trim()))), `raw marker survives at a line start: ${JSON.stringify(first)}`);
    assert.ok(!md.split('\n').some(l => /indented/.test(l) && /^ {3,}\S/.test(l.replace(/^ {2}- /, ''))), 'indent');
  }
});
test('line(): leading block markers are full-width, ordinary text is unchanged', () => {
  const md = N.definitionsDetail(t, [{ label: 'plain text', value: '# H', reason: '1. one' }], ['# H', '- b', 'normal']);
  assert.ok(md.includes('＃ H'), md);
  assert.ok(!/^- (- |# )/m.test(md), md);
  assert.ok(md.includes('plain text'));
});

// ---- P7: the definitions-table parser (re-run) -----------------------------------------------------------------------------------------
const R = S.load('experiences/visual-map/argument-rerun.ts');
test('definitions parser: what definitionsDetail writes reads back, brackets, pipes and markers included', () => {
  const items = [{ label: 'Age', value: '16–24 (youth)', reason: 'BLS' }, { label: 'Odd | label', value: '[x] # a%% $$b', reason: '1. one <b>' }, { label: 'plain', value: 'v', reason: '-' }];
  const md = N.definitionsDetail(t, items, ['an insight']);
  assert.deepEqual(plainJson(R.parseDefinitionsTable(md)), items);
});
const plainJson = v => JSON.parse(JSON.stringify(v));
test('definitions parser rejects unreadable tables', () => {
  const head = '| a | b | c |\n| --- | --- | --- |';
  for (const bad of ['', 'no table here', head, `${head}\n| only | two |`, `${head}\n| a | b | c | d |`, `${head}\n|  | v | r |`, `${head}\n| l |  | r |`, `${head}\n| l | v |  |`, `${head}\n| - | v | r |`, '| a | b | c |\n| x | y | z |\n| l | v | r |', '| a | b |\n| --- | --- |\n| l | v |'])
    assert.equal(R.parseDefinitionsTable(bad), null, JSON.stringify(bad));
  assert.deepEqual(plainJson(R.parseDefinitionsTable(`${head}\r\n| l | v | r |\r\n\r\ntext after`)), [{ label: 'l', value: 'v', reason: 'r' }]);
});
test('re-run: an unreadable table creates no map and starts nothing; a readable one starts a new map with presetAssumptions', async () => {
  const calls = [];
  const ports = detail => ({ readDefinitions: async () => detail, proposition: () => ' Claim ', createMap: async () => { calls.push('create'); return 'New.md'; }, start: async (p, c, a) => { calls.push(['start', p, c, plainJson(a)]); } });
  assert.deepEqual(plainJson(await R.rerunWithAssumptions(ports('garbage'))), { kind: 'unreadable' });
  assert.deepEqual(calls, []);
  const ok = await R.rerunWithAssumptions(ports('| a | b | c |\n| --- | --- | --- |\n| l | v | r |'));
  assert.equal(ok.kind, 'started');
  assert.deepEqual(plainJson(calls), ['create', ['start', 'New.md', 'Claim', [{ label: 'l', value: 'v', reason: 'r' }]]]);
  assert.deepEqual(plainJson(await R.rerunWithAssumptions({ ...ports('| a | b | c |\n| --- | --- | --- |\n| l | v | r |'), proposition: () => '  ' })), { kind: 'unreadable' });
});

// ---- review round 1 (B1): whitelist sanitizing ---------------------------------------------------------------------------------------
const inertText = md => !/%%|\$|(^|[^&\w])#\w|\]\(|\[\[|!\[|<[a-z]|==|~~|`|\*|\bhttps?:[^\s]*[()[\]]/i.test(md);
test('safeUrl: whitelist only; a lone % is %25, $ is %24, nothing else can start math, a comment, a highlight or a link', () => {
  assert.equal(N.safeUrl('https://a.example/p?q=%%&r=$$x'), 'https://a.example/p?q=%25%25&r=%24%24x');
  assert.equal(N.safeUrl('https://a.example/a%41%%41'), 'https://a.example/a%41%25%41');
  assert.equal(N.safeUrl('https://a.example/x?a=1&b=2#frag'), 'https://a.example/x?a=1&b=2#frag');
  for (const bad of ['https://a.example/%%a%%', 'https://a.example/$x$ and $$y$$', 'https://a.example/a==b==c~~d~~', "https://a.example/p(1)[2]{3}!'*`|\\^\"", 'https://a.example/é中 x']) {
    const out = N.safeUrl(bad);
    assert.ok(/^https?:\/\/[A-Za-z0-9\-._~:/?#@&+,;=%]*$/.test(out), out);
    assert.ok(!/%%|\$|==|~~/.test(out) && !/%(?![0-9A-Fa-f]{2})/.test(out), out);
  }
  for (const out of [N.datumDetail(t, datum({ proof: proof({ url: 'https://a.example/$$%%' }) })), N.notFoundDetail(t, { queries: [], opened: ['https://a.example/$$%%'], why: 'x' }, 'x')]) assert.ok(!/\$\$|%%/.test(out), out);
});
test('line: inline math, tags, formatting and block markers cannot form from model text; ordinary text reads the same', () => {
  const evil = ['$x$ and $y$', '#tag and #other', '*bold* _it_ ~~del~~ ==hi== ^sup', '{{x}} {y} ^block', '[[a]] ![b](c) [d](obsidian://open?vault=v)', '%%comment%%', '> quote', '- item', '1. one', '|a|b|', '\\$x\\$', 'a: b'];
  for (const bad of evil) {
    const md = N.datumDetail(t, datum({ need: bad, stanceReason: bad, proof: proof({ claim: bad, quote: bad }) })) + N.hypothesisDetail(t, hyp({ basis: bad, needs: [] }), bad);
    assert.ok(inertText(md.replace(/^\s*[|>#-].*$/gm, l => (/^(### |> \[!summary\]|\| |> \[!note\]-)/.test(l) ? '' : l))), JSON.stringify(bad));
    assert.ok(!md.includes(bad) || !/[$#*_~=^{}\[\]|]/.test(bad), JSON.stringify(bad));
  }
  const md = N.hypothesisDetail(t, hyp({ basis: 'plain words only' }), 'GDP grew 3 percent in 2020');
  assert.ok(md.includes('plain words only') && md.includes('GDP grew 3 percent in 2020'));
});
test('definitions table: the stronger encoding still round-trips through the re-run parser', () => {
  const items = [{ label: '$x$ #tag', value: '*a* _b_ ~~c~~ ==d== ^e {f} [g](h) <i> |j| !k :l &#37; &amp; %%m%% $$n$$', reason: '1. one \\ back `tick` > quote' }, { label: 'Age', value: '16–24 (youth)', reason: 'BLS: x' }, { label: '+ plus', value: '- minus', reason: '2) two' }];
  assert.deepEqual(plainJson(R.parseDefinitionsTable(N.definitionsDetail(t, items, ['i']))), items);
});

// ---- sem3: no raw reason code or English program string reaches a note ----
const RAW = ['source_quote_missing', 'no_usable_data', 'not_found', 'source_rejected_url', 'budget'];
test('sem3 notes: stored reason codes render as readable text everywhere (datum rows, facet table, situation table, conclusion tables)', () => {
  const lost = datum({ id: 'd2', state: 'not_found', proof: undefined, propStance: undefined, stanceReason: undefined, reason: 'source_quote_missing: page has only a single-year number' });
  const none = facet({ id: 'f2', verdict: 'insufficient', reason: 'no_usable_data', summary: '', citedData: [] });
  const st = state([datum(), lost], [facet(), none]);
  const outs = [N.datumDetail(t, lost), N.facetDetail(t, none, st.situation.data), N.situationDetail(t, st), N.conclusionDetail(t, st, new Map(), undefined, 'stopped')];
  for (const md of outs) for (const code of RAW) assert.ok(!md.includes(code), `${code} leaked in: ${md.slice(0, 200)}`);
  assert.ok(N.facetDetail(t, none, st.situation.data).includes(t('ui.argument_why_no_usable_data')));
  assert.ok(N.facetDetail(t, none, st.situation.data).includes(t('ui.argument_why_source_quote_missing')));
  assert.ok(!N.situationDetail(t, st).includes('no usable data for this facet'), 'no English program string');
  const stored = N.facetDetail(t, facet({ reason: 'no usable data for this facet' }), []);
  assert.ok(!stored.includes('no usable data for this facet'), 'a map stored by the earlier build is rendered readable too');
});
test('sem3 notes: the definitions card lists definition needs and AI free-text reasons are untouched', () => {
  const md = N.definitionsDetail(t, [{ label: 'Age', value: '16-24', reason: 'why' }], undefined, ['how it is measured']);
  assert.ok(md.includes('how it is measured') && md.includes(t('ui.argument_note_definition_needs')));
  assert.ok(N.facetDetail(t, facet({ reason: 'clear gap' }), []).includes('clear gap'));
  assert.ok(N.definitionsDetail(t, [], undefined, ['only need']).includes('only need'));
});

// ---- live run 4 (claude:haiku): composite "code: note" strings must never show the code ----
const WHY_CODES = ['budget', 'no_answer', 'not_found', 'stance_uncertain', 'provider_error', 'card_deleted', 'source_rejected_url', 'source_bad_quote', 'source_bad_claim', 'source_network_error', 'source_http_status', 'source_content_type', 'source_no_parser', 'source_quote_missing', 'source_blocked_unverified', 'round_limit', 'no_usable_data'];
const NOTE = 'BLS 2026年10月新聞稿列出16–19歲13.9%，但沒有16至24歲合併數字；未採用7月9.1%。';
const noCode = md => { for (const code of WHY_CODES) assert.ok(!md.includes(code) && !md.includes(code.replace(/_/g, '＿')), `${code} leaked in: ${md}`); };
test('live4: a not-found datum or need with a composite searchLog.why renders no raw code, and keeps the agent note encoded', () => {
  for (const code of ['not_found', 'source_quote_missing']) {
    const why = `${code}: ${NOTE}`;
    const log = { queries: ['bls.gov unemployment rate by age'], opened: ['https://www.bls.gov/x.htm'], why };
    const md = N.notFoundDetail(t, log, code);
    noCode(md);
    assert.ok(!md.includes('&#'), md);
    assert.ok(md.includes(t(`ui.argument_why_${code}`)), `readable reason missing: ${md}`);
    assert.ok(md.includes('13.9%'), `readable agent note missing: ${md}`);
    assert.ok(md.includes(t('ui.argument_note_agent_note')), md);
    const d = datum({ id: 'd9', state: 'not_found', proof: undefined, propStance: undefined, stanceReason: undefined, reason: code, searchLog: log });
    const st = state([datum(), d], [facet(), facet({ id: 'f2', verdict: 'insufficient', reason: why })]);
    for (const out of [N.datumDetail(t, d), N.facetDetail(t, st.situation.facets[1], st.situation.data), N.situationDetail(t, st), N.conclusionDetail(t, st, new Map(), undefined, 's')]) noCode(out);
  }
});
test('live4: reasonText splits a composite: the code becomes readable text, a code with trailing punctuation too', () => {
  for (const code of WHY_CODES) {
    for (const stored of [code, `${code}: ${NOTE}`, `${code}：${NOTE}`, `${code}.`, `${code};x`, `${code}(x)`]) {
      const out = N.reasonText(t, stored);
      assert.ok(!out.includes(code), `${stored} -> ${out}`);
    }
  }
  assert.equal(N.reasonText(t, 'clear gap'), 'clear gap');
});

// ---- Bugs B and C: no HTML entities in any note, full-width neutralization, pending datum note ------------------------------------------
const NZ_CLAIM = '司法部官方新聞稿報告 NZCVS 整體犯罪被害比例從 2018 年 30% 降到 2025 年 28%，但比較基準是 2018 年而非疫情前 2019 年。';
const NZ_QUOTE = 'the proportion of victims of crime has dropped from 30% in 2018 to 28% in 2025.';
const nzDatum = (over = {}) => datum({ need: '紐西蘭官方犯罪趨勢報告中，近期與疫情前比較的敘述', proof: proof({ claim: NZ_CLAIM, quote: NZ_QUOTE, url: 'https://www.justice.govt.nz/about/news-and-media/media-releases/new-survey-shows-drop-in-crime/', figure: { number: '28', period: '2025 年', unit: '% 成人' } }), ...over });
const ATTACKS = ['$x$ and $y$', '#tag and #other', '*bold* _it_ ~~del~~ ==hi== ^sup', '{{x}} {y} ^block', '[[a]] ![b](c) [d](obsidian://open?vault=v)', '%%comment%%', '> quote', '- item', '+ plus', '1. one', '2) two', '|a|b|', '\\$x\\$', 'a: b', 'see http://evil.example/x and www.evil.example', 'key:: value', '<!-- c --> <b>x</b>', '> [!danger] callout', '# heading', '---', '===', '```js', '~~~', '&#37; &amp; &lt;', 'x\n### Injected', '30% of 2018: a-b, c.', ...EVIL];
test('Bug B: no HTML entity in any builder output, for the real NZ data and every attack string', () => {
  const entity = /&#\d+;|&(?:lt|gt|amp|quot);/;
  const st = state([nzDatum()], [facet({ title: '近期與疫情前', reason: NZ_CLAIM, summary: NZ_CLAIM })]);
  const outs = [N.datumDetail(t, st.situation.data[0]), N.facetDetail(t, st.situation.facets[0], st.situation.data), N.situationDetail(t, st), N.definitionsDetail(t, [{ label: '期間', value: '2018 年 30% 與 2025 年 28%', reason: 'NZCVS: 28% in 2025 - a "drop"' }], [NZ_CLAIM]), N.notFoundDetail(t, { queries: [NZ_QUOTE], opened: [], why: `not_found: ${NZ_CLAIM}` }, 'not_found')];
  for (const md of outs) { assert.ok(!md.includes('&#'), md); assert.ok(!entity.test(md), md); }
  assert.ok(outs[0].includes('30%') && outs[0].includes('28%'), 'percent signs read as plain %');
  for (const bad of ATTACKS) {
    const h = hyp({ basis: bad, insights: [{ kind: 'tension', text: bad }], needs: [need({ text: bad })] });
    const s2 = state([nzDatum({ need: bad, stanceReason: bad, proof: proof({ claim: bad, quote: bad, figure: { number: '1', period: bad, unit: bad } }) })], [facet({ title: bad, reason: bad, summary: bad })], { hypotheses: [h], conclusion: { state: 'concluded', basedOn: ['h1'], missing: [] } });
    const all = [N.datumDetail(t, s2.situation.data[0]), N.facetDetail(t, s2.situation.facets[0], s2.situation.data), N.situationDetail(t, s2), N.definitionsDetail(t, [{ label: bad, value: bad, reason: bad }], [bad], [bad]), N.hypothesisDetail(t, h, bad), N.conclusionDetail(t, s2, new Map([['h1', bad]]), { summary: bad, points: [bad] }), N.notFoundDetail(t, { queries: [bad], opened: [], why: `not_found: ${bad}` }, 'x')];
    for (const md of all) {
      assert.ok(!/&#\d+;|&lt;|&gt;|&amp;/.test(md), `${JSON.stringify(bad)} -> ${md}`);
      // inert: no line of model text starts a heading/quote/list/rule except the builder's own, and no inline construct survives
      assert.ok(!/%%|\$|==|~~|`|\*|\[\[|!\[|\]\(|<[a-z!/]|(^|[\s])#\w|\bhttps?:\/\/[^\s]*evil|\bwww\.evil|\w::|\^/.test(md.replace(/https:\/\/(?:stats\.example\.org|www\.justice\.govt\.nz)[^\s]*/g, '')), `${JSON.stringify(bad)} -> ${md}`);
      for (const l of md.split('\n')) {
        const own = /^(### |> \[!summary\]$|\| |- |  - |```mermaid$|```$|xychart|  |> )/.test(l) || l === '';
        if (!own) assert.ok(!/^\s*([#>+\-*=~|`<\[]|\d+[.)])/.test(l), `${JSON.stringify(bad)} -> a bare line starts a block: ${JSON.stringify(l)}`);
        if (l.startsWith('> ')) assert.ok(!/^> (\[!|>|#|-|\+|\d+[.)])/.test(l.replace('> [!summary]', '')), `callout/quote ${JSON.stringify(l)}`);
        if (l.startsWith('- ')) assert.ok(!/^- (-|\+|>|#|\d+[.)]|\[)/.test(l), `list ${JSON.stringify(l)}`);
      }
    }
  }
});
test('Bug B: full-width replacements are visually equal and the readable punctuation stays', () => {
  const md = N.definitionsDetail(t, [{ label: '$5 #tag', value: 'GDP 30% (2018): a, b. 100%% [x] <y> |z| *s* _u_ ~~d~~ x ~ y =a= ==h== ^e', reason: '1. one' }, { label: '- minus', value: '> quote', reason: '+ plus' }, { label: 'u', value: 'http://a.example/x www.a.example key:: v &#37; &amp;', reason: '2) two' }]);
  const rows = rowsOf(md);
  assert.ok(rows[2].includes('＄5 ＃tag'), rows[2]);
  assert.ok(rows[2].includes('GDP 30% (2018): a, b. 100％％ ［x］ ＜y> ｜z｜ ＊s＊ ＿u＿ ～～d～～ x ~ y =a= ＝＝h＝＝ ＾e'), rows[2]);
  assert.ok(rows[2].includes('1． one'), rows[2]);
  assert.ok(rows[3].includes('－ minus') && rows[3].includes('＞ quote') && rows[3].includes('＋ plus'), rows[3]);
  assert.ok(rows[4].includes('http：//a.example/x www．a.example key：： v ＆＃37; ＆amp;') && rows[4].includes('2） two'), rows[4]);
});
test('Bug B: the definitions table round-trips through the re-run parser, including native full-width text and old entity notes', () => {
  const items = [{ label: '$5 #tag', value: 'GDP 30% (2018): a, b. 100%% [x] <y> |z| *s* _u_ ~~d~~ x ~ y =a= ==h== ^e', reason: '1. one' }, { label: '- minus', value: '> quote', reason: '+ plus' }, { label: 'u', value: 'http://a.example/x www.a.example key:: v &#37; &amp; &lt;', reason: '2) two' }, { label: '全形：冒號（括號）％', value: '30％ 與 ！ ＂', reason: '１．不動' }, { label: 'x', value: 'back\\slash `tick` {b} !k', reason: 'ok' }];
  assert.deepEqual(plainJson(R.parseDefinitionsTable(N.definitionsDetail(t, items, ['i']))), items);
  const legacy = '| a | b | c |\n| --- | --- | --- |\n| l | 28 &#37; &#58; &#45; | r |';
  assert.deepEqual(plainJson(R.parseDefinitionsTable(legacy)), [{ label: 'l', value: '28 % : -', reason: 'r' }]);
});
test('Bug C: a found datum with no propStance gets a full note: claim, figure, period, unit, quote, link and 對命題：判定中', () => {
  const md = N.datumDetail(t, nzDatum({ propStance: undefined, stanceReason: undefined }));
  assert.ok(md.includes('對命題: 判定中') || md.includes('對命題：判定中'), md);
  assert.ok(md.includes('28 % 成人') && md.includes('2025 年'), md);
  assert.ok(md.includes(NZ_CLAIM) && md.includes(NZ_QUOTE), md);
  assert.ok(md.includes('https://www.justice.govt.nz/about/news-and-media/media-releases/new-survey-shows-drop-in-crime/'), md);
  assert.ok(!md.includes('無關') && !md.includes('支持命題'), md);
  assert.ok(!md.includes('&#'), md);
  const row = rowsOf(md).pop();
  assert.ok(row.includes('判定中'), row);
});
test('Bug C: a judged irrelevant datum shows its reason in the note, never an empty cell', () => {
  const md = N.datumDetail(t, nzDatum({ propStance: 'irrelevant', stanceReason: '比較基準不是疫情前' }));
  assert.ok(md.includes('無關') && md.includes('比較基準不是疫情前'), md);
  const row = rowsOf(md).pop();
  assert.ok(!/\| - \|$/.test(row), row);
  assert.ok(row.endsWith('比較基準不是疫情前 |'), row);
});

// ---- P1-5 (review): reference-style links and scheme-without-// are inert in summaries (plainLine) and details (line) ----
const REF = ['[x][y]', '[x]: obsidian:open?vault=a', 'obsidian:open?file=b', 'javascript:alert(1)', 'mailto:a@b.example', 'MAILTO:a@b.example'];
const refLeft = text => /[\[\]]|\b(?!https?:)[a-z][a-z0-9+.-]*:(?=\S)/i.test(text);
test('P1-5: every bracket and every non-web scheme colon is widened in plainLine and in the detail builders', () => {
  for (const bad of REF) {
    assert.ok(!refLeft(N.plainLine(`x ${bad} y`)), `plainLine ${bad} -> ${N.plainLine(bad)}`);
    const md = N.datumDetail(t, datum({ need: bad, stanceReason: bad, proof: proof({ claim: bad, quote: bad + ' quote text long enough' }) }));
    assert.ok(!/\[x\]|obsidian:open|javascript:|mailto:/i.test(md), `detail ${bad}`);
  }
  assert.equal(N.plainLine('rate: 9.2% at 10:30 see https://a.example/x'), 'rate: 9.2% at 10:30 see https://a.example/x');
});
