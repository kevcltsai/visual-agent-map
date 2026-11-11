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
  const st = state([datum()], [facet()], { hypotheses: [hyp({ needs: [need()] }), hyp({ id: 'h2', location: 'eliminated', eliminationReason: 'round_limit: not verified after round 3' })], conclusion: { state: 'concluded', basedOn: ['h1'], missing: [] } });
  const md = N.conclusionDetail(t, st, new Map([['h1', 'Hyp 1'], ['h2', 'Hyp 2']]), { summary: 'final answer', points: ['p1', 'p2'] });
  for (const key of ['core', 'insights', 'basis_hypotheses', 'eliminated', 'situation_basis']) assert.ok(md.includes(`### ${t(`ui.argument_note_${key}`)}`), key);
  assert.ok(md.includes('final answer') && md.includes('Hyp 1') && md.includes('Hyp 2') && md.includes(t('ui.argument_why_round_limit')));
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
test('line(): leading block markers are entity-encoded, ordinary text is unchanged', () => {
  const md = N.definitionsDetail(t, [{ label: 'plain text', value: '# H', reason: '1. one' }], ['# H', '- b', 'normal']);
  assert.ok(md.includes('&#35; H'), md);
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
const inertText = md => !/%%|\$|(^|[^&\w])#\w|\]\(|\[\[|!\[|<[a-z]|==|~~|`|\*|\bhttps?:[^\s]*[()[\]]/i.test(md.replace(/&#\d+;/g, ''));
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
const noCode = md => { for (const code of WHY_CODES) assert.ok(!md.includes(code) && !md.includes(code.replace(/_/g, '&#95;')), `${code} leaked in: ${md}`); };
test('live4: a not-found datum or need with a composite searchLog.why renders no raw code, and keeps the agent note encoded', () => {
  for (const code of ['not_found', 'source_quote_missing']) {
    const why = `${code}: ${NOTE}`;
    const log = { queries: ['bls.gov unemployment rate by age'], opened: ['https://www.bls.gov/x.htm'], why };
    const md = N.notFoundDetail(t, log, code);
    noCode(md);
    assert.ok(!md.includes('&#58;') || !md.includes(code), md);
    assert.ok(md.includes(t(`ui.argument_why_${code}`)), `readable reason missing: ${md}`);
    assert.ok(md.includes('13.9&#37;'), `encoded agent note missing: ${md}`);
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
