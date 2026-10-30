// core/steps/chart: the chart step (chart.add@1) - pure insert rules, the step definition and the AiTaskService integration.
const { test } = require('node:test');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./support-replay.cjs');

const insert = load('core/steps/chart/insert.ts');
const { chartStep, CHART_SCHEMA, parseChartReply } = load('core/steps/chart/step.ts');
const { neutralizeUnsafeMermaid } = load('ai/mermaid-safety.ts');
const { canonicalDetail } = load('ai/result-utils.ts');
const { standardTemplate, textbookTemplate } = load('ai/detail-templates.ts');
const { AiTaskService } = load('core/ai-task-service.ts');
const { AiExchangeLog } = load('ai-exchange-log.ts');

const NOTE = [
  'The larva stage lasts 3 days at 25°C and reaches 160–180 mm.',
  '',
  'Second paragraph, unique text. See [guide](https://example.com/page/777) and a note.[^99]',
  '',
  '| Stage | Days |',
  '| --- | --- |',
  '| Pupa | 5 |',
  '',
  '- list item with 42 in it',
  '',
  '> [!note]',
  '> callout line with 9',
  '',
  '### Heading 12',
  '',
  'Repeated line.',
  '',
  'Repeated line.',
  '',
  '```text',
  'code line with 88',
  '```',
  '',
  'Tail paragraph with H2O and 1,200 items.',
  '',
  '[^1]: Footnote text 555.'
].join('\n');
const TIMELINE = 'timeline\n  title Life cycle\n  3 days : Larva\n  5 days : Pupa';
const draft = (anchor, mermaid = TIMELINE, shape = 'stages') => ({ anchor, shape, mermaid });
const apply = (detail, charts, extra = {}) => insert.applyCharts(detail, charts, { remaining: 3, ...extra });
const code = async (detail, charts, extra) => {
  const r = await apply(detail, charts, extra);
  return r.ok ? 'ok' : r.code;
};
const P1 = 'The larva stage lasts 3 days at 25°C and reaches 160–180 mm.';
test('anchor rules: paragraph and table anchors pass, everything else fails', async () => {
  assert.equal(await code(NOTE, [draft(P1)]), 'ok');
  assert.equal(await code(NOTE, [draft('| Pupa | 5 |')]), 'ok');
  assert.equal(await code(NOTE, [draft('Nowhere to be found')]), 'anchor_missing');
  assert.equal(await code(NOTE, [draft('Repeated line.')]), 'anchor_not_unique');
  assert.equal(await code(NOTE, [draft('- list item with 42 in it')]), 'anchor_bad_block');
  assert.equal(await code(NOTE, [draft('> callout line with 9')]), 'anchor_bad_block');
  assert.equal(await code(NOTE, [draft('### Heading 12')]), 'anchor_bad_block');
  assert.equal(await code(NOTE, [draft('code line with 88')]), 'anchor_missing');
  assert.equal(await code(NOTE, [draft(P1), draft(P1.replace('The', 'The'))]), 'anchor_shared');
  assert.equal(await code(NOTE, [draft('| Stage | Days |'), draft('| Pupa | 5 |')]), 'anchor_shared');
  const mixed = 'Para line 5\n| a | b |\n\nnext';
  assert.equal(await code(mixed, [draft('Para line 5', 'pie\n  title x\n  "a" : 5')]), 'anchor_bad_block');
});

test('number rules: sourced numbers pass; midpoints, invented bounds and non-body sources fail', async () => {
  const range = 'timeline\n  title T\n  160–180 mm : Larva';
  assert.equal(await code(NOTE, [draft(P1, range)]), 'ok');
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n  title T\n  170 mm : Larva')]), 'number_not_in_note');
  const bar = b => `xychart-beta\n  title "x"\n  x-axis ["A", "B"]\n  y-axis "mm"${b}\n  bar [3, 5]`;
  assert.equal(await code(NOTE, [draft(P1, bar(''), 'comparison')]), 'ok');
  assert.equal(await code(NOTE, [draft(P1, bar(' 0 --> 300'), 'comparison')]), 'number_not_in_note');
  // identifier digits are ignored
  for (const body of ['flowchart TD\n  A1["3 days"] --> C4["5 days"]', 'flowchart TD\n  A["H2O"] --> B["quadrant-1"]'])
    assert.equal(await code(NOTE, [draft(P1, body, 'process')]), 'ok', body);
  // thousands separators and NFKC
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n  title T\n  1200 : Items')]), 'ok');
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n  title T\n  １,２００ : Items')]), 'ok');
  assert.deepEqual([...insert.numberTokens('A1 v2 C4 H2O quadrant-1 stateDiagram-v2 7 1,200.5')], ['7', '1200.5']);
  // URL, footnote and existing-mermaid numbers are not sources
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n  title T\n  777 : Link')]), 'number_not_in_note');
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n  title T\n  99 : Footnote')]), 'number_not_in_note');
  const withDiagram = NOTE + '\n\n```mermaid\nflowchart TD\nA["31 days"] --> B["32 days"]\n```';
  assert.equal(await code(withDiagram, [draft(P1, 'timeline\n  title T\n  31 days : Old')]), 'number_not_in_note');
});

test('V5 covers the first line after the type keyword, and tilde-fenced diagrams count', async () => {
  const slice = '\n  "A" : 3';
  assert.equal(await code(NOTE, [draft(P1, 'pie title 2024 survey 999' + slice, 'proportion')]), 'number_not_in_note');
  assert.equal(await code(NOTE, [draft(P1, 'pie showData title 1234' + slice, 'proportion')]), 'number_not_in_note');
  assert.equal(await code(NOTE, [draft(P1, 'pie title Days 3' + slice, 'proportion')]), 'ok');
  assert.equal(await code(NOTE, [draft(P1, 'xychart-beta')]), 'ok');
  assert.equal(await code(NOTE, [draft(P1, 'stateDiagram-v2\n  [*] --> A', 'states')]), 'ok');
  assert.equal(await code(NOTE, [draft(P1, 'stateDiagram-v2 3', 'states')]), 'ok');
  const tilde = P1 + '\n\n~~~mermaid\nflowchart TD\nA["31 days"]\n~~~';
  assert.equal(insert.existingDiagrams(tilde).count, 1);
  assert.equal(await code(tilde, [draft(P1, 'timeline\n  title T\n  31 days : Old')]), 'number_not_in_note');
});

test('other checks: unsafe or bad-header, parse, cap, fences in the body, CRLF', async () => {
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n  title T\n  3 days : Larva\n  click A href "x"')]), 'unsafe_or_header');
  assert.equal(await code(NOTE, [draft(P1, '%%{init: {}}%%\ntimeline\n  title T')]), 'unsafe_or_header');
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n  title T\n  3 days : <img src=x>')]), 'unsafe_or_header');
  assert.equal(await code(NOTE, [draft(P1, '```mermaid\ntimeline\n```')]), 'bad_body');
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n~~~')]), 'bad_body');
  assert.equal(await code(NOTE, [draft(P1, 'timeline\n' + '  title T\n'.repeat(31))]), 'bad_body');
  assert.equal(await code(NOTE, [draft(P1), draft('| Pupa | 5 |')], { remaining: 1 }), 'over_cap');
  assert.equal(await code(NOTE, [draft(P1)], { remaining: 0 }), 'over_cap');
  assert.equal(await code(NOTE, [draft(P1)], { parses: async () => false }), 'unparsable');
  assert.equal(await code(NOTE, [draft(P1)], { parses: async () => { throw new Error('x'); } }), 'unparsable');
  const crlf = NOTE.replace(/\n/g, '\r\n');
  const result = await apply(crlf, [draft(P1, TIMELINE.replace(/\n/g, '\r\n'))]);
  assert.equal(result.ok, true);
  assert.ok(!/(?<!\r)\n/.test(result.detail), 'every line ending stays CRLF');
});

test('all or nothing: one good chart plus one bad chart leaves the note unchanged', async () => {
  const result = await apply(NOTE, [draft(P1), draft('| Pupa | 5 |', 'timeline\n  title T\n  999 days : Bad')]);
  assert.deepEqual({ ...result }, { ok: false, code: 'number_not_in_note', index: 1 });
});

test('insertion invariants: input is recoverable, the result is neutralize-stable, charts survive canonicalDetail', async () => {
  const result = await apply(NOTE, [draft(P1), draft('Tail paragraph with H2O and 1,200 items.', 'pie\n  title Items\n  "A" : 3\n  "B" : 5', 'proportion')]);
  assert.equal(result.ok, true);
  assert.equal(neutralizeUnsafeMermaid(result.detail), result.detail);
  const lines = result.detail.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '```mermaid' && lines[i - 1] === '') {
      const end = lines.indexOf('```', i);
      i = end;
      if (kept.at(-1) === '' ) kept.pop();
      continue;
    }
    kept.push(lines[i]);
  }
  // Each insertion is a blank line plus the fence; a blank line before it is the input's own.
  assert.equal(kept.join('\n').replace(/\n{3,}/g, '\n\n'), NOTE);
  assert.equal(existingCount(result.detail), 2);
  for (const template of [standardTemplate('en'), textbookTemplate('en')]) {
    const body = `### ${template.sections[0].name}\n\n${result.detail}`;
    const canonical = canonicalDetail(body, 'en', template);
    assert.equal((canonical.match(/```mermaid/g) ?? []).length, 2, `${template.id}: both diagrams kept`);
  }
});
function existingCount(detail) { return insert.existingDiagrams(detail).count; }

test('existingDiagrams reads the first word of each diagram', () => {
  const d = 'a\n\n```mermaid\nflowchart TD\nA-->B\n```\n\n````mermaid\n\nsequenceDiagram\n````';
  assert.deepEqual(JSON.parse(JSON.stringify(insert.existingDiagrams(d))), { count: 2, types: ['flowchart', 'sequenceDiagram'] });
});

test('step: schema, reply parsing (V0) and prompt placeholders', () => {
  assert.equal(chartStep.id, 'chart.add'); assert.equal(chartStep.version, 1);
  assert.equal(CHART_SCHEMA.properties.charts.maxItems, 3);
  const ok = JSON.stringify({ charts: [{ anchor: 'a', shape: 'stages', mermaid: 'timeline' }] });
  assert.equal(parseChartReply(ok).length, 1);
  assert.equal(parseChartReply('{"charts":[]}').length, 0);
  for (const bad of ['not json', '[]', '{}', '{"charts":[],"x":1}', '{"charts":[{"anchor":"a","shape":"other","mermaid":"x"}]}', '{"charts":[{"anchor":"","shape":"stages","mermaid":"x"}]}', '{"charts":[{"anchor":"a","shape":"stages"}]}', JSON.stringify({ charts: Array(4).fill({ anchor: 'a', shape: 'stages', mermaid: 'x' }) })])
    assert.throws(() => parseChartReply(bad), error => error.code === 'invalid_reply', bad);
  const render = (language, types) => chartStep.render({ title: 'T', detail: 'D {{x}}', language, existingCount: types.length, existingTypes: types, remaining: 3 - types.length });
  assert.match(render('zh-TW', ['flowchart', 'pie']), /已有 2 張圖（flowchart、pie），.*最多再補 1 張/);
  assert.match(render('zh-TW', []), /已有 0 張圖（無）/);
  assert.match(render('en', ['flowchart', 'pie']), /already has 2 diagram\(s\) \(flowchart, pie\).*add at most 1/);
  assert.match(render('en', []), /\(none\)/);
  assert.match(render('en', []), /<detail>\nD \{\{x\}\}\n<\/detail>/, 'detail text is data and is not scanned for placeholders');
});

// ---- AiTaskService integration with a fake runtime
// The chart step no longer runs inside askModel: the caller runs it after the write (chartEligible, then chartDetail).
// This helper does what the plugin's background job does, minus the note write, so each case keeps its original shape.
async function askAndChart(service, input, model, effort, ...rest) {
  const result = await service.askModel(input, model, effort, ...rest);
  if (!service.chartEligible(input)) return result;
  const detail = await service.chartDetail({ input, detail: result.detail, countIssues: result.formatIssues, model, signal: rest[0] });
  return { ...result, detail };
}

const TASK_REPLY = detail => JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] });
function fixture(replies, { parses, logging = true, template, onCall } = {}) {
  const calls = [];
  const runtime = {
    runTask: async (prompt, model, effort, schema, controls) => {
      calls.push({ prompt, model, effort, schema, controls });
      controls.onRequest?.({ n: calls.length });
      onCall?.(calls.length);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return reply;
    }
  };
  const log = new AiExchangeLog(nodeFsAdapter, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-chart-')), 'ai-exchanges.json'), error => { throw error; });
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => logging, exchanges: () => log,
    codexRuntime: () => runtime, claudeRuntime: () => runtime,
    ...(parses ? { mermaidParses: parses } : {})
  });
  const base = { title: 'Topic', summary: 's', rules: '', detail: '', task: 'do', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'auto', outputLanguage: 'en', addCharts: true, ...(template ? { detailTemplate: template } : {}) };
  return { calls, log, service, base };
}
const chartReply = (anchor = P1, mermaid = TIMELINE) => JSON.stringify({ charts: [{ anchor, shape: 'stages', mermaid }] });
const withWarn = async work => {
  const seen = [], original = console.warn;
  console.warn = (...args) => seen.push(args);
  try { return [await work(), seen]; } finally { console.warn = original; }
};
const chartEntry = log => log.getEntries().find(entry => entry.step === 'chart.add@1');

test('a valid reply: two calls, the second uses the schema, low effort, no web and no tools; the detail gains the chart', async () => {
  const { calls, service, base, log } = fixture([TASK_REPLY(NOTE), chartReply()], { parses: async () => true });
  const result = await askAndChart(service, base, 'claude:sonnet', 'high');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].effort, 'low', 'the main call keeps its own effort');
  assert.equal(calls[1].effort, 'low'); assert.equal(calls[1].model, 'sonnet');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].schema)), JSON.parse(JSON.stringify(CHART_SCHEMA)));
  assert.equal(calls[1].controls.webSearch, false); assert.equal(calls[1].controls.textOnly, true);
  assert.equal(calls[1].controls.timeoutMs, 180_000);
  assert.match(calls[1].prompt, /<detail>/);
  assert.match(result.detail, /```mermaid\ntimeline/);
  assert.equal(chartEntry(log).status, 'completed');
});

test('a Codex model runs the chart step through the same local runtime with text only', async () => {
  const { calls, service, base } = fixture([TASK_REPLY(NOTE), chartReply()]);
  await askAndChart(service, base, 'gpt-6-luna', 'low');
  assert.equal(calls.length, 2); assert.equal(calls[1].controls.textOnly, true); assert.equal(calls[1].effort, 'low');
});

test('a number violation: detail unchanged, entry marked failed with the code, one warn, no throw', async () => {
  const { calls, service, base, log } = fixture([TASK_REPLY(NOTE), chartReply(P1, 'timeline\n  title T\n  170 mm : Larva')], { parses: async () => true });
  const [result, warns] = await withWarn(() => askAndChart(service, base, 'claude:sonnet', 'low'));
  const plain = await fixture([TASK_REPLY(NOTE)], {}).service.askModel({ ...base, addCharts: undefined }, 'claude:sonnet', 'low');
  assert.equal(calls.length, 2);
  assert.equal(result.detail, plain.detail);
  assert.deepEqual(warns, [['Visual Agent Map chart step', 'number_not_in_note']]);
  const entry = chartEntry(log);
  assert.equal(entry.status, 'failed'); assert.match(entry.error, /number_not_in_note/); assert.doesNotMatch(entry.error, /larva/i);
});

test('an unparsable reply, a runtime error and a timeout leave the detail unchanged', async () => {
  const plain = await fixture([TASK_REPLY(NOTE)]).service.askModel({ ...fixture([]).base, addCharts: undefined }, 'claude:sonnet', 'low');
  for (const [reply, expected] of [['not json', 'invalid_reply'], [new Error('runtime down'), 'runtime_error'], [Object.assign(new Error('AI task exceeded 3 minutes'), { name: 'Error' }), 'runtime_error']]) {
    const { service, base, log } = fixture([TASK_REPLY(NOTE), reply]);
    const [result, warns] = await withWarn(() => askAndChart(service, base, 'claude:sonnet', 'low'));
    assert.equal(result.detail, plain.detail);
    assert.deepEqual(warns, [['Visual Agent Map chart step', expected]]);
    assert.equal(chartEntry(log).status, 'failed');
  }
});

test('abort during the chart step rethrows', async () => {
  const controller = new AbortController();
  const { service, base } = fixture([TASK_REPLY(NOTE), Object.assign(new Error('Aborted'), { name: 'AbortError' })], { onCall: n => { if (n === 2) controller.abort(); } });
  await assert.rejects(askAndChart(service, { ...base }, 'claude:sonnet', 'low', controller.signal), error => error.name === 'AbortError');
});

test('askModel makes exactly one call even when the request is chart-eligible; the chart step is a separate call', async () => {
  const { calls, service, base } = fixture([TASK_REPLY(NOTE), chartReply()], { parses: async () => true });
  assert.equal(service.chartEligible(base), true);
  const result = await service.askModel(base, 'claude:sonnet', 'low');
  assert.equal(calls.length, 1, 'no inline chart call');
  assert.doesNotMatch(result.detail, /mermaid/);
  const detail = await service.chartDetail({ input: base, detail: result.detail, model: 'claude:sonnet' });
  assert.equal(calls.length, 2);
  assert.match(detail, /```mermaid\ntimeline/);
});

test('chartEligible is false without the flag, and for decompose, merge, AIM, intermediate and count-repair requests', async () => {
  const cases = [{ addCharts: undefined }, { mode: 'decompose' }, { mode: 'merge' }, { promptProfile: 'aim' }, { intermediateDetail: true }, { countRepair: true }];
  for (const extra of cases) {
    const { calls, service, base } = fixture([TASK_REPLY(NOTE), chartReply()]);
    assert.equal(service.chartEligible({ ...base, ...extra }), false, JSON.stringify(extra));
    await askAndChart(service, { ...base, ...extra }, 'claude:sonnet', 'low').catch(() => {});
    assert.equal(calls.length, 1, JSON.stringify(extra));
  }
  assert.equal(fixture([]).service.chartEligible({ ...fixture([]).base, mode: 'synthesize' }), true);
});

test('chartDetail reports the chart entry id so a caller can mark a stale result failed with its reason', async () => {
  const { service, base, log } = fixture([TASK_REPLY(NOTE), chartReply()], { parses: async () => true });
  const result = await service.askModel(base, 'claude:sonnet', 'low');
  let chartId = '';
  await service.chartDetail({ input: base, detail: result.detail, model: 'claude:sonnet', onExchange: id => { chartId = id; } });
  assert.equal(log.getEntries().find(entry => entry.id === chartId).step, 'chart.add@1');
  service.failExchange(chartId, 'stale reason');
  const entry = chartEntry(log);
  assert.equal(entry.status, 'failed'); assert.equal(entry.error, 'stale reason');
});

test('onExchange and onRequestAccepted see only the main entry', async () => {
  const { service, base, log } = fixture([TASK_REPLY(NOTE), chartReply()]);
  const ids = []; let accepted = 0;
  await askAndChart(service, { ...base }, 'claude:sonnet', 'low', undefined, id => ids.push(id), () => { accepted++; });
  const entries = log.getEntries();
  assert.equal(entries.length, 2);
  assert.deepEqual(ids, [entries.find(entry => entry.step !== 'chart.add@1').id]);
  assert.ok(accepted <= 1);
});

test('V9: a reply that changes the section counts is refused', async () => {
  const section = standardTemplate('en').sections[0];
  let flipped = false;
  const template = { ...standardTemplate('en'), get sections() { return standardTemplate('en').sections.map(s => (s.id === section.id ? { ...s, count: { mode: 'exact', n: flipped ? 2 : 1 } } : s)); } };
  const note = `### ${section.name}\n\n${P1}\n\n- one item`;
  const { calls, service, base } = fixture([TASK_REPLY(note), chartReply(P1, 'timeline\n  title T\n  3 days : Larva')], { template, onCall: n => { if (n === 2) flipped = true; } });
  const [result, warns] = await withWarn(() => askAndChart(service, base, 'claude:sonnet', 'low'));
  assert.equal(calls.length, 2);
  assert.doesNotMatch(result.detail, /mermaid/);
  assert.deepEqual(warns, [['Visual Agent Map chart step', 'counts_changed']]);
  // unchanged counts: the chart is added
  const fine = fixture([TASK_REPLY(note), chartReply(P1, 'timeline\n  title T\n  3 days : Larva')], { template: { ...standardTemplate('en'), sections: standardTemplate('en').sections.map(s => (s.id === section.id ? { ...s, count: { mode: 'exact', n: 1 } } : s)) } });
  const ok = await askAndChart(fine.service, fine.base, 'claude:sonnet', 'low');
  assert.match(ok.detail, /```mermaid/);
});

test('mermaidParses returning false leaves the detail unchanged', async () => {
  const { service, base, log } = fixture([TASK_REPLY(NOTE), chartReply()], { parses: async () => false });
  const [result, warns] = await withWarn(() => askAndChart(service, base, 'claude:sonnet', 'low'));
  assert.doesNotMatch(result.detail, /mermaid/);
  assert.deepEqual(warns, [['Visual Agent Map chart step', 'unparsable']]);
  assert.equal(chartEntry(log).status, 'failed');
});

test('sequenceDiagram: wrapping double quotes in aliases, messages and notes are removed; other types untouched', async () => {
  const quoted = [
    'sequenceDiagram',
    '  participant U as "User"',
    '  actor S as "Server side"',
    '  U->>S: "Send 3 days"',
    '  S-->>U: "Reply"',
    '  Note over U,S: "Wait 5 days"',
    '  Note right of S: plain'
  ].join('\n');
  const plain = quoted.replace(/"/g, '');
  const r = await apply(NOTE, [draft(P1, quoted, 'process')]);
  assert.equal(r.ok, true);
  assert.ok(r.detail.includes('```mermaid\n' + plain + '\n```'));
  assert.ok(!r.detail.includes('"User"'));
  const already = await apply(NOTE, [draft(P1, plain, 'process')]);
  assert.equal(already.detail, r.detail);
  const flow = 'flowchart TD\n  A["3 days"] -->|"x"| B["5 days"]';
  const f = await apply(NOTE, [draft(P1, flow, 'process')]);
  assert.ok(f.detail.includes(flow));
  const pie = 'pie\n  title "x"\n  "a" : 3';
  const p = await apply(NOTE, [draft(P1, pie, 'comparison')]);
  assert.ok(p.detail.includes(pie));
});

test('sequenceDiagram: inner quotes or empty quotes are left alone', async () => {
  const body = [
    'sequenceDiagram',
    '  participant U as "a" and "b"',
    '  U->>U: "a" and "b"',
    '  Note over U: "a" and "b"',
    '  U->>U:""'
  ].join('\n');
  const r = await apply(NOTE, [draft(P1, body, 'process')]);
  assert.equal(r.ok, true);
  assert.ok(r.detail.includes('```mermaid\n' + body + '\n```'));
});
