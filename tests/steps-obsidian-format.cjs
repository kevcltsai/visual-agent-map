// Obsidian syntax in a model-written detail: the prompt asks for it, the parse/write path keeps it, and an unsafe
// mermaid block is turned into plain code before anything is written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, promptsFor, makeService } = require('./support-replay.cjs');
const support = require('./support.cjs');

const { parseAiResult } = load('core/steps/task/parse.ts');
const { neutralizeUnsafeMermaid, addedMermaidBlocks } = load('ai/mermaid-safety.ts');
const { canonicalDetail } = load('ai/result-utils.ts');
const { resolveDetailReferences } = load('ai/reference-materials.ts');

const reply = detail => JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] });
const parse = detail => parseAiResult(reply(detail), 'Test', 'zh-TW').detail;

const RICH = [
  '### 核心結論',
  '',
  '> [!summary] 結論',
  '> ==間隔重複==比集中練習更能維持長期記憶。',
  '',
  '### 關鍵知識',
  '',
  '| 方法 | 短期 | 長期 |',
  '| --- | --- | --- |',
  '| 集中練習 | 高 | 低 |',
  '| 間隔重複 | 中 | 高 |',
  '',
  '```mermaid',
  'flowchart LR',
  '  A["學習 (第 1 天)"] --> B[複習]',
  '  B -->|間隔變長| C[長期記憶]',
  '```',
  '',
  '```mermaid',
  'timeline',
  '  title 記憶研究',
  '  1885 : 遺忘曲線',
  '  1970s : 間隔效應實驗',
  '```',
  '',
  '> [!warning] 常見誤解',
  '> 重讀不等於主動回想。',
  '',
  '> [!example] 圖解',
  '> ```mermaid',
  '> graph TD',
  '> A --> B',
  '> ```',
  '',
  '### 待確認事項',
  '',
  '> [!question] 間隔要多長？',
  '',
  '- [ ] 用 Anki 建 20 張卡片',
  '- [x] 讀完第一章',
  '',
  '> [!tip] 每次複習先回想再看答案。'
].join('\n');

test('allowed Obsidian syntax survives parse, canonical sections, source footnotes and the note write', async () => {
  assert.equal(parse(RICH), RICH);
  assert.equal(neutralizeUnsafeMermaid(RICH), RICH);
  const canonical = canonicalDetail(parse(RICH), 'zh-TW');
  for (const fragment of ['> [!summary] 結論', '==間隔重複==', '| 間隔重複 | 中 | 高 |', '```mermaid\nflowchart LR\n  A["學習 (第 1 天)"] --> B[複習]', '```mermaid\ntimeline', '> ```mermaid\n> graph TD', '> [!question] 間隔要多長？', '- [ ] 用 Anki 建 20 張卡片', '- [x] 讀完第一章', '> [!tip]'])
    assert.ok(canonical.includes(fragment), `canonical detail keeps ${JSON.stringify(fragment)}`);
  assert.equal(resolveDetailReferences(canonical, []), canonical);
  const { repo } = support.fixture('zh-TW');
  const node = await support.topicNote(repo);
  await repo.updateNote(node.path, { detail: canonical });
  assert.equal((await repo.readNote(node.path)).detail, canonical);
});

test('a mermaid block with click, HTML, an init directive or a URL is kept as plain code, not rendered', () => {
  const unsafe = {
    click: ['flowchart LR', '  A --> B', '  click A "https://example.com"'],
    callback: ['graph TD', '  A --> B', '  click B callback'],
    html: ['flowchart LR', '  A["<img src=x onerror=alert(1)>"] --> B'],
    init: ['%%{init: {"securityLevel": "loose"}}%%', 'flowchart LR', '  A --> B'],
    frontMatter: ['---', 'config:', '  securityLevel: loose', '---', 'flowchart LR', '  A --> B'],
    url: ['flowchart LR', '  A["see https://evil.example/x"] --> B'],
    javascript: ['flowchart LR', '  A["javascript:alert(1)"] --> B'],
    style: ['flowchart LR', '  A --> B', '  style A fill:#f00'],
    classDef: ['flowchart LR', '  A:::hot --> B'],
    image: ['flowchart LR', '  A@{ img: "https://x/y.png" } --> B'],
    icon: ['flowchart LR', '  A["fa:fa-car"] --> B'],
    otherDiagram: ['sequenceDiagram', '  A->>B: hi', '  link A: Site @ https://x']
  };
  for (const [name, body] of Object.entries(unsafe)) {
    const detail = ['before', '', '```mermaid', ...body, '```', '', 'after'].join('\n');
    const expected = ['before', '', '```text', ...body, '```', '', 'after'].join('\n');
    assert.equal(parse(detail), expected, `${name}: block becomes plain code with its text intact`);
  }
  // Inside a callout, in a longer fence, and an unclosed fence at the end.
  assert.equal(parse('> [!example]\n> ```mermaid\n> flowchart LR\n> A --> B\n> click A "x"\n> ```'), '> [!example]\n> ```text\n> flowchart LR\n> A --> B\n> click A "x"\n> ```');
  assert.equal(parse('````mermaid\ngraph TD\nA --> B\n```\nclick A "x"\n````'), '````text\ngraph TD\nA --> B\n```\nclick A "x"\n````');
  assert.equal(parse('x\n\n```mermaid\nflowchart LR\nA["<b>x</b>"] --> B'), 'x\n\n```text\nflowchart LR\nA["<b>x</b>"] --> B');
});

test('a <br> line break in a mermaid label becomes a space, so the diagram still renders (owner 2026-11-14)', () => {
  const detail = ['<br> outside stays', '', '```mermaid', 'flowchart TD', '  A["one<br/>two"] --> B["three<br>four<BR />five"]', '```'].join('\n');
  const expected = ['<br> outside stays', '', '```mermaid', 'flowchart TD', '  A["one two"] --> B["three four five"]', '```'].join('\n');
  assert.equal(parse(detail), expected);
  assert.equal(parse('> ```mermaid\n> graph TD\n> A["a<br>b"] --> B\n> ```'), '> ```mermaid\n> graph TD\n> A["a b"] --> B\n> ```');
  // Any other HTML in the same block still turns it into plain code.
  assert.equal(parse('```mermaid\nflowchart LR\nA["a<br>b"] --> B["<b>x</b>"]\n```'), '```text\nflowchart LR\nA["a b"] --> B["<b>x</b>"]\n```');
});

test('only the unsafe mermaid block changes; safe blocks and other code stay as written', () => {
  const safe = '```mermaid\nflowchart TD\n  A --> B\n```';
  const bad = '```mermaid\nflowchart TD\n  A --> B\n  click A "https://x"\n```';
  const code = '```md\n```mermaid\nclick A "x"\n```';
  assert.equal(parse([safe, bad, safe].join('\n\n')), [safe, bad.replace('```mermaid', '```text'), safe].join('\n\n'));
  // Each mermaid opening is checked on its own, even one quoted inside another code block (never rendered there).
  assert.equal(parse(`~~~\n${code}\n~~~`), `~~~\n${code.replace('```mermaid', '```text')}\n~~~`);
  assert.equal(parse('~~~md\n```mermaid\nflowchart LR\nA --> B\n```\n~~~'), '~~~md\n```mermaid\nflowchart LR\nA --> B\n```\n~~~');
});

test('reader-facing prompts carry the Obsidian syntax rules; decompose does not', async () => {
  const marker = { en: 'The detail is rendered in Obsidian.', 'zh-TW': 'detail 會在 Obsidian 中渲染' };
  const base = { title: 'T', summary: 'S', rules: '', detail: 'D', task: 'X', ancestors: '', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  const sent = async context => (await promptsFor(context, { language: context.outputLanguage })).at(-1).prompt;
  for (const language of ['en', 'zh-TW']) {
    const has = async context => (await sent({ ...base, ...context, outputLanguage: language })).includes(marker[language]);
    assert.equal(await has({ mode: 'task' }), true, `${language} task`);
    assert.equal(await has({ mode: 'synthesize' }), true, `${language} synthesize`);
    assert.equal(await has({ mode: undefined, detailFormat: 'adaptive' }), true, `${language} adaptive`);
    assert.equal(await has({ mode: 'task', detailTemplate: { id: 'custom', name: 'C', sections: [{ name: 'A', description: '', role: 'body' }] } }), true, `${language} custom template`);
    assert.equal(await has({ mode: 'decompose' }), false, `${language} decompose`);
    assert.equal(await has({ mode: 'task', intermediateDetail: true }), false, `${language} reference extraction`);
  }
});

test('an unsafe mermaid block from a provider reply is neutralized by the AiTaskService result', async () => {
  const runtime = { runTask: async () => reply('```mermaid\nflowchart LR\nA --> B\nclick A "https://x"\n```') };
  const service = makeService(runtime, { language: 'en' });
  const result = await service.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'X', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', outputLanguage: 'en' }, 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes('```text\nflowchart LR'));
  assert.ok(!result.detail.includes('```mermaid'));
});

test('reviewer gaps: inline mermaid code, fences in lists, and directives after a semicolon', () => {
  const bad = ['```mermaid', 'flowchart LR', 'A --> B', 'click A "https://x"', '```'];
  // Inline ```mermaid``` is not a fence (a backtick info string cannot hold a backtick); the real block after it is checked.
  const inline = ['```mermaid``` 是流程圖語法。', '', ...bad].join('\n');
  assert.equal(parse(inline), ['```mermaid``` 是流程圖語法。', '', '```text', ...bad.slice(1)].join('\n'));
  // A fence continued in a list (indented four spaces) and a fence on the list marker's own line.
  const indented = ['- step', '', ...bad.map(line => `    ${line}`)].join('\n');
  assert.equal(parse(indented), indented.replace('```mermaid', '```text'));
  const onMarker = ['- ```mermaid', ...bad.slice(1).map(line => `  ${line}`)].join('\n');
  assert.equal(parse(onMarker), onMarker.replace('```mermaid', '```text'));
  const task = ['- [ ] ```mermaid', ...bad.slice(1).map(line => `  ${line}`)].join('\n');
  assert.equal(parse(task), task.replace('```mermaid', '```text'));
  const numbered = ['1. ```mermaid', ...bad.slice(1).map(line => `   ${line}`)].join('\n');
  assert.equal(parse(numbered), numbered.replace('```mermaid', '```text'));
  // Directives chained with ';' on one line.
  for (const directive of ['click A someFn', 'style A fill:#f00', 'classDef hot fill:#f00', 'linkStyle 0 stroke:red'])
    assert.equal(parse(`\`\`\`mermaid\nflowchart LR\nA --> B; ${directive}\n\`\`\``), `\`\`\`text\nflowchart LR\nA --> B; ${directive}\n\`\`\``, directive);
  // A safe block in a list still renders.
  const safe = '- step\n\n    ```mermaid\n    flowchart LR\n    A --> B\n    ```';
  assert.equal(parse(safe), safe);
});

test('a counted section keeps its items as a top-level list: the prompt says so and such a reply needs no repair', async () => {
  const template = { id: 'custom-count', name: 'Counted', sections: [
    { id: 'a', name: 'Core conclusions', description: '', role: 'body', count: { mode: 'exact', n: 3 }, aliases: [] },
    { id: 'b', name: 'Notes', description: '', role: 'body', aliases: [] }
  ] };
  const context = { title: 'T', summary: '', rules: '', detail: '', task: 'X', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', outputLanguage: 'en', detailTemplate: template };
  const calls = [];
  const replies = [
    reply('### Core conclusions\n\n> [!summary]\n> - a\n> - b\n> - c\n\n### Notes\n\nn'),
    reply('### Core conclusions\n\n- a\n- b\n- c\n\n### Notes\n\n> [!tip] n')
  ];
  const runtime = { runTask: async prompt => { calls.push(prompt); return replies[calls.length - 1]; } };
  const result = await makeService(runtime, { language: 'en' }).askModel(context, 'gpt-6-luna', 'low');
  const rule = 'In a section with a required item count, write the items as a top-level list or #### subheadings, not inside a callout or table.';
  assert.ok(calls[0].includes(rule), 'the first request carries the count rule');
  assert.equal(calls.length, 2, 'the callout-wrapped list misses the count and gets the single repair');
  assert.ok(calls[1].includes(rule), 'the repair request carries it too');
  assert.equal(result.formatIssues.length, 0);
  assert.ok(result.detail.includes('- a\n- b\n- c'));
});

test('each mermaid opening is judged on its own: an unclosed block in a list cannot hide a later one, and quotes inside lists are seen', () => {
  const later = ['- ```mermaid', '  flowchart LR', '  A-->B', '', 'Text', '', '```mermaid', 'flowchart LR', 'A-->B', 'click A "https://x"', '```'].join('\n');
  // The later unsafe block is caught; the unclosed list block is checked with the text after it, so it is blocked too.
  assert.equal(parse(later), later.replaceAll('```mermaid', '```text'));
  const quotedInList = '- > ```mermaid\n  > flowchart LR\n  > click A x\n  > ```';
  assert.equal(parse(quotedInList), quotedInList.replace('```mermaid', '```text'));
  const calloutInTask = '- [ ] > [!example]\n  > ```mermaid\n  > graph TD\n  > A --> B; style A fill:red\n  > ```';
  assert.equal(parse(calloutInTask), calloutInTask.replace('```mermaid', '```text'));
  const safeQuotedInList = '- > ```mermaid\n  > flowchart LR\n  > A --> B\n  > ```';
  assert.equal(parse(safeQuotedInList), safeQuotedInList);
});

// Math: Obsidian renders only `$…$` and `$$…$$`; the prompt asks for them and the result is normalized either way.
const { normalizeMathDelimiters } = load('ai/markdown-blocks.ts');

test('the Obsidian format prompt asks for dollar-delimited math in both languages', async () => {
  const base = { title: 'T', summary: 'S', rules: '', detail: 'D', task: 'X', ancestors: '', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', mode: 'task' };
  for (const [language, rule] of [['en', 'inline math as `$…$` with no spaces just inside the dollars'], ['zh-TW', '行內用 `$…$`（錢字號內側不留空白）']]) {
    const prompt = (await promptsFor({ ...base, outputLanguage: language }, { language })).at(-1).prompt;
    assert.ok(prompt.includes(rule), `${language} states the math rule`);
    for (const delimiter of ['`\\(`', '`\\)`', '`\\[`', '`\\]`']) assert.ok(prompt.includes(delimiter), `${language} forbids ${delimiter}`);
  }
});

test('math normalizer converts LaTeX delimiters to dollar math', () => {
  const n = normalizeMathDelimiters;
  assert.equal(n('傅立葉數\n\\[\nFo=\\frac{\\alpha t}{L^2}\n\\]\n結束'), '傅立葉數\n$$\nFo=\\frac{\\alpha t}{L^2}\n$$\n結束');
  assert.equal(n('\\[ Fo=\\frac{\\alpha t}{L^2} \\]'), '$$Fo=\\frac{\\alpha t}{L^2}$$');
  assert.equal(n('導熱係數 \\(k\\) 越大'), '導熱係數 $k$ 越大');
  assert.equal(n('時間 \\( t\\propto L^2/\\alpha \\) 成正比'), '時間 $t\\propto L^2/\\alpha$ 成正比');
  assert.equal(n('\\(a\\) 與 \\(b\\)，且 \\[x^2\\]'), '$a$ 與 $b$，且 $$x^2$$');
  assert.equal(n('> \\[\n> E=mc^2\n> \\]'), '> $$\n> E=mc^2\n> $$');
});

test('math normalizer leaves code, escapes, unmatched and dollar math alone', () => {
  const n = normalizeMathDelimiters;
  const fenced = '```latex\n\\[\nx\n\\]\n\\(k\\)\n```';
  assert.equal(n(fenced), fenced);
  assert.equal(n('~~~\n\\(k\\)\n~~~'), '~~~\n\\(k\\)\n~~~');
  assert.equal(n('寫成 `\\(k\\)` 與 ``\\[x\\]``'), '寫成 `\\(k\\)` 與 ``\\[x\\]``');
  assert.equal(n('`code` 之後 \\(k\\)'), '`code` 之後 $k$');
  assert.equal(n('escaped \\\\[x\\\\] and \\\\(k\\\\)'), 'escaped \\\\[x\\\\] and \\\\(k\\\\)');
  assert.equal(n('a lone \\[ bracket'), 'a lone \\[ bracket');
  assert.equal(n('\\[\nno closing line\n\n之後 \\] 隔著空行'), '\\[\nno closing line\n\n之後 \\] 隔著空行');
  assert.equal(n('a lone \\( paren'), 'a lone \\( paren');
  assert.equal(n('a stray \\) and \\] alone'), 'a stray \\) and \\] alone');
  const dollars = '行內 $k$ 與\n$$\nx^2\n$$';
  assert.equal(n(dollars), dollars);
  assert.equal(n(''), '');
});

test('owner-note math pattern (synthetic) is fixed by the result path and AIM-free summaries too', async () => {
  const detail = ['### 熱擴散', '', '熱擴散係數 \\(\\alpha\\) 由 \\(k\\)、\\(\\rho\\)、\\(c_p\\) 決定。', '', '\\[', '\\alpha=\\frac{k}{\\rho c_p}', '\\]', '', '\\[', 'Fo=\\frac{\\alpha t}{L^2}', '\\]', '', '所以 \\(t\\propto L^2/\\alpha\\)。'].join('\n');
  const runtime = { runTask: async () => JSON.stringify({ summary: '擴散時間 \\(t\\propto L^2/\\alpha\\)', detail, suggestions: [], visualReferences: [] }) };
  const service = makeService(runtime, { language: 'zh-TW' });
  const result = await service.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'X', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', outputLanguage: 'zh-TW' }, 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes('熱擴散係數 $\\alpha$ 由 $k$、$\\rho$、$c_p$ 決定。'));
  assert.ok(result.detail.includes('$$\n\\alpha=\\frac{k}{\\rho c_p}\n$$'));
  assert.ok(result.detail.includes('$$\nFo=\\frac{\\alpha t}{L^2}\n$$'));
  assert.ok(result.detail.includes('所以 $t\\propto L^2/\\alpha$。'));
  assert.ok(!/\\[[\]()]/.test(result.detail));
  assert.equal(result.summary, '擴散時間 $t\\propto L^2/\\alpha$');
  // A decompose request is not reader-facing and is left as the model wrote it.
  const raw = await service.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'X', ancestors: '', mode: 'decompose', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', outputLanguage: 'zh-TW' }, 'gpt-6-luna', 'low').catch(() => null);
  if (raw) assert.ok(raw.detail.includes('\\[\n\\alpha'));
});

test('math normalizer keeps escaped link text; a prose regex bracket is a known LaTeX ambiguity', () => {
  const n = normalizeMathDelimiters;
  assert.equal(n('見 \\[link\\](https://example.org) 說明'), '見 \\[link\\](https://example.org) 說明');
  assert.equal(n('\\[\nx\n\\](url)'), '\\[\nx\n\\](url)');
  assert.equal(n('regex `\\[a-z\\]` 在程式碼內'), 'regex `\\[a-z\\]` 在程式碼內');
  // Documented ambiguity: outside code, `\[a-z\]` is read as display math.
  assert.equal(n('regex \\[a-z\\]'), 'regex $$a-z$$');
});

// Every offline mermaid type Obsidian draws is kept as a mermaid block; anything else, and any unsafe line, is not.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { DIAGRAM_TYPES } = load('ai/mermaid-safety.ts');
const repoRoot = nodePath.join(__dirname, '..');
const typesFixture = nodeFs.readFileSync(nodePath.join(repoRoot, 'tests/fixtures/mermaid-types.md'), 'utf8');
const fixtureBlocks = [...typesFixture.matchAll(/^```mermaid\n([\s\S]*?)\n```$/gm)].map(match => match[1].split('\n'));
const fixtureHeader = lines => lines[0].trim().split(/\s/)[0];

test('mermaid types: the safe fixture keeps every block as mermaid, one block per type plus flowchart and graph', () => {
  assert.equal(neutralizeUnsafeMermaid(typesFixture), typesFixture);
  const headers = fixtureBlocks.map(fixtureHeader);
  for (const type of DIAGRAM_TYPES) assert.equal(headers.filter(header => header === type).length, 1, `${type}: exactly one fixture block`);
  for (const header of headers) assert.ok(DIAGRAM_TYPES.includes(header) || header === 'flowchart' || header === 'graph', `${header} is in DIAGRAM_TYPES`);
  assert.ok(headers.includes('flowchart') && headers.includes('graph'));
  assert.equal(headers.length, DIAGRAM_TYPES.length + 2);
});

test('mermaid types: generic unsafe lines neutralize a block of every type', () => {
  const generic = {
    init: ['%%{init: {}}%%'], url: ['https://x'], click: ['click A "x"'], style: ['style A fill:red'],
    classDef: ['classDef x fill:red'], shorthand: ['A:::x']
  };
  for (const lines of fixtureBlocks) {
    const [header, ...rest] = lines;
    for (const [name, extra] of Object.entries(generic)) {
      const body = [header, ...rest, ...extra];
      assert.equal(parse('```mermaid\n' + body.join('\n') + '\n```'), '```text\n' + body.join('\n') + '\n```', `${fixtureHeader(lines)} + ${name}`);
    }
    const front = ['---', 'config:', '  theme: dark', '---', header, ...rest];
    assert.equal(parse('```mermaid\n' + front.join('\n') + '\n```'), '```text\n' + front.join('\n') + '\n```', `${fixtureHeader(lines)} + front-matter`);
  }
});

test('mermaid types: type-specific unsafe syntax is neutralized', () => {
  const cases = {
    'sequence link': ['sequenceDiagram', '  link A: x @ /x'],
    'sequence links': ['sequenceDiagram', '  links A: {"x":"/x"}'],
    'sequence properties': ['sequenceDiagram', '  properties A: {"k":"v"}'],
    'sequence details': ['sequenceDiagram', '  details A: /x'],
    'class callback': ['classDiagram', '  A : x', '  callback A "fn"'],
    'class cssClass': ['classDiagram', '  A : x', '  cssClass "A" x'],
    'class html tag': ['classDiagram', '  <interface> A'],
    'class body html': ['classDiagram', '  class A {', '    <b>x', '  }'],
    'gantt click call': ['gantt', '  dateFormat YYYY-MM-DD', '  a : a1, 2026-01-01, 1d', '  click a call fn()'],
    'gantt click href': ['gantt', '  dateFormat YYYY-MM-DD', '  a : a1, 2026-01-01, 1d', '  click a href "/x"'],
    'C4 link': ['C4Context', '  Person(a, "A", $link="/x")'],
    'C4 sprite': ['C4Context', '  Person(a, "A", $sprite="x")'],
    'C4 tags': ['C4Context', '  Person(a, "A", $tags="x")'],
    'C4 style': ['C4Context', '  Person(a, "A")', '  UpdateElementStyle(a, $bgColor="red")'],
    'C4 tag': ['C4Context', '  AddElementTag("x", $bgColor="red")'],
    'mindmap icon': ['mindmap', '  root', '    a', '    ::icon(fa fa-book)'],
    'quadrant point style': ['quadrantChart', '  x-axis "a" --> "b"', '  Point A: [0.3, 0.6] radius: 10, color: #ff0000'],
    'kanban metadata': ['kanban', '  todo', '    t1[任務]@{ ticket: 1 }']
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.equal(parse('```mermaid\n' + body.join('\n') + '\n```'), '```text\n' + body.join('\n') + '\n```', name);
  }
});

test('mermaid types: unknown or near-miss headers are neutralized', () => {
  for (const header of ['hello', 'Pie', 'pie-chart', 'flowchart-elk TD', 'zenuml', 'info', 'xychart', 'sankey', 'Timeline', 'flowchart FOO']) {
    const body = [header, '  A --> B'];
    assert.equal(parse('```mermaid\n' + body.join('\n') + '\n```'), '```text\n' + body.join('\n') + '\n```', header);
  }
});

test('mermaid types: the prompt bullets name only types the sanitizer keeps', () => {
  const plain = new Set(['timeline', 'gantt', 'pie', 'mindmap']);
  for (const [lang, marker] of [['zh', '- 圖表：'], ['en', '- Diagrams:']]) {
    const text = nodeFs.readFileSync(nodePath.join(repoRoot, `core/steps/_shared/obsidian-format.${lang}.md`), 'utf8');
    const bullet = text.split('\n').find(line => line.startsWith(marker));
    assert.ok(bullet, `${lang}: diagram bullet`);
    const tokens = bullet.match(/[A-Za-z][A-Za-z0-9-]*/g).filter(token => /^[a-z]+[A-Z]|-beta$|-v2$/.test(token) || plain.has(token));
    assert.ok(tokens.length >= 8, `${lang}: bullet names several types`);
    for (const token of tokens) assert.ok(DIAGRAM_TYPES.includes(token), `${lang}: ${token} is in DIAGRAM_TYPES`);
    for (const token of lang === 'en' ? ['flowchart', 'sequenceDiagram', 'xychart-beta', 'sankey-beta'] : ['flowchart', 'sequenceDiagram', 'xychart-beta']) assert.ok(bullet.includes(token), `${lang}: ${token}`);
    assert.equal(bullet.includes('sankey-beta'), lang === 'en', `${lang}: the sankey hint is English-only (sankey labels are ASCII only)`);
  }
});

const OPEN_SYNTAX = {
  nested: ['> [!note] 背景', '> 外層說明', '>', '> > [!warning] 內層', '> > 小心這個例外'].join('\n'),
  foldable: ['> [!note]- 完整推導', '> 第一步', '> 第二步', '', '> [!tip]+ 展開的提示', '> 先回想再看答案'].join('\n'),
  details: ['<details>', '<summary>延伸說明</summary>', '補充說明第一行，<kbd>Ctrl</kbd> 加 <mark>C</mark>。', '補充說明第二行。', '</details>'].join('\n'),
  inlineHtml: '水是 H<sub>2</sub>O，面積用 m<sup>2</sup>，按 <kbd>Ctrl</kbd> + <kbd>C</kbd> 複製，重點是 <mark>間隔</mark>。'
};

test('open syntax: nested and foldable callouts, details and inline HTML survive parse, canonical sections, the write and the read byte for byte', async () => {
  const { repo } = support.fixture('zh-TW');
  for (const [name, text] of Object.entries(OPEN_SYNTAX)) {
    const detail = ['### 核心結論', '', text, '', '### 關鍵知識', '', '一般段落。'].join('\n');
    assert.equal(parse(detail), detail, `${name}: parse keeps it`);
    const canonical = canonicalDetail(parse(detail), 'zh-TW');
    assert.ok(canonical.includes(text), `${name}: canonicalDetail keeps it byte for byte`);
    assert.equal(canonicalDetail(canonical, 'zh-TW'), canonical, `${name}: canonicalDetail is stable`);
    const node = await support.topicNote(repo);
    await repo.updateNote(node.path, { detail: canonical, preview: '預覽內容', prompt: '提示內容' });
    const read = await repo.readNote(node.path);
    assert.equal(read.detail, canonical, `${name}: read returns the written detail`);
    assert.equal(read.preview, '預覽內容', `${name}: Preview callout still parses`);
    assert.equal(read.prompt, '提示內容', `${name}: Prompt callout still parses`);
    assert.equal(neutralizeUnsafeMermaid(canonical), canonical, `${name}: sanitizer leaves it alone`);
  }
  // All four together, and a Prompt-looking callout inside the detail does not become the Prompt section.
  const all = Object.values(OPEN_SYNTAX).join('\n\n');
  const detail = canonicalDetail(parse(['### 核心結論', '', all, '', '> [!info]- Prompt', '> 假的'].join('\n')), 'zh-TW');
  const node = await support.topicNote(repo);
  await repo.updateNote(node.path, { detail, prompt: '真的' });
  const read = await repo.readNote(node.path);
  assert.equal(read.detail, detail);
  assert.equal(read.prompt, '真的');
});

test('mermaid safety: CRLF and lone CR cannot hide a fence, header or directive; a safe CRLF block stays mermaid', () => {
  const blocks = [
    ['```mermaid', 'flowchart LR', 'A-->B', 'click A href "javascript:alert(1)"', '```'],
    ['```mermaid', 'classDiagram', 'class A', 'click A call alert()', '```']
  ];
  for (const lines of blocks) {
    for (const eol of ['\r\n', '\r']) {
      const out = neutralizeUnsafeMermaid(lines.join(eol));
      assert.ok(!/```mermaid/.test(out) && out.startsWith('```text'), `${JSON.stringify(eol)}: neutralized`);
      assert.ok(!out.includes('\r'), 'line breaks are normalized');
    }
  }
  const header = 'classDiagram\rclass A\rclick A call alert()';
  assert.ok(neutralizeUnsafeMermaid('```mermaid\r' + header + '\r```').startsWith('```text'));
  // The fence line alone, the header line alone and a body line alone each end in CRLF/CR.
  assert.ok(neutralizeUnsafeMermaid('```mermaid\r\nflowchart LR\nA-->B\nstyle A fill:red\n```').startsWith('```text'));
  assert.ok(neutralizeUnsafeMermaid('```mermaid\nflowchart LR\r\nA-->B\nstyle A fill:red\n```').includes('```text'));
  assert.ok(neutralizeUnsafeMermaid('```mermaid\nflowchart LR\nA-->B\rstyle A fill:red\n```').includes('```text'));
  for (const eol of ['\r\n', '\r']) {
    const safe = ['```mermaid', 'flowchart LR', 'A-->B', '```'].join(eol);
    assert.equal(neutralizeUnsafeMermaid(safe), safe.replace(/\r\n?/g, '\n'));
    assert.ok(neutralizeUnsafeMermaid(safe).startsWith('```mermaid'));
  }
});

test('mermaid safety: sequence actor menus after a semicolon are neutralized', () => {
  const body = ['sequenceDiagram', '  A->>B: hi; properties A: {"k":"v"}'];
  assert.equal(parse('```mermaid\n' + body.join('\n') + '\n```'), '```text\n' + body.join('\n') + '\n```');
  const details = ['sequenceDiagram', '  A->>B: hi; details A: /x'];
  assert.equal(parse('```mermaid\n' + details.join('\n') + '\n```'), '```text\n' + details.join('\n') + '\n```');
});

test('classDiagram annotations <<word>> stay mermaid; every other angle bracket is still unsafe', () => {
  const block = lines => '```mermaid\n' + lines.join('\n') + '\n```';
  const keep = [
    ['classDiagram', '  <<interface>> Shape', '  Shape <|-- Duck'],
    ['classDiagram-v2', '  <<abstract>> A', '  Animal : <<Service>>'],
    ['sequenceDiagram', '  A->>B: hi', '  B-->>A: ok'],
    ['flowchart LR', '  A <--> B']
  ];
  for (const lines of keep) assert.equal(neutralizeUnsafeMermaid(block(lines)), block(lines), lines[0]);
  const reject = [
    ['classDiagram', '  <<interface>> A', '  B <script>'],
    ['classDiagram', '  <<a><b>> A'],
    ['classDiagram', '  << interface >> A'],
    ['classDiagram', '  <<<<x>>script>> A'],
    ['classDiagram', '  <<interface>> A', '  click A "x"'],
    ['classDiagram', '  <<img src=x>> A'],
    ['flowchart LR', '  A["<<interface>>"] --> B'],
    ['sequenceDiagram', '  A->>B: <<x>>'],
    ['classDiagram', '  A <-- <!-- x -->'],
    ['classDiagram', '  <<interface>> A', '  B["<img src=x>"]']
  ];
  for (const lines of reject) assert.equal(neutralizeUnsafeMermaid(block(lines)), block(lines).replace('```mermaid', '```text'), lines.join(' / '));
});

test('classDiagram class declarations stay mermaid; class directives and injected text elsewhere stay unsafe', () => {
  const block = lines => '```mermaid\n' + lines.join('\n') + '\n```';
  const keep = [
    ['classDiagram', '  class Shape', '  class Duck~T~', '  Shape <|-- Duck'],
    ['classDiagram', '  class Shape {', '    <<interface>>', '    +String name', '    +draw() void', '  }'],
    ['classDiagram-v2', '  class Shape["My Shape"]', '  class List~int~ {', '    +add(int x)', '  }']
  ];
  for (const lines of keep) assert.equal(neutralizeUnsafeMermaid(block(lines)), block(lines), lines.join(' / '));
  const reject = [
    ['flowchart LR', '  class A foo'],
    ['flowchart LR', '  class A'],
    ['sequenceDiagram', '  class A'],
    ['classDiagram', '  class A foo'],
    ['classDiagram', '  class A,B foo'],
    ['classDiagram', '  class A:::foo'],
    ['classDiagram', '  class A <script>'],
    ['classDiagram', '  class A["<img src=x>"]'],
    ['classDiagram', '  class A["https://evil.example"]'],
    ['classDiagram', '  class A {', '    click A "x"', '  }'],
    ['classDiagram', '  class A {', '    +x <b>', '  }'],
    ['classDiagram', '  class A', '  click A "https://x"'],
    ['classDiagram', '  class A~<script>~'],
    ['classDiagram', '  class A', '  cssClass "A" x'],
    ['classDiagram', '  class A;click A "x"']
  ];
  for (const lines of reject) assert.equal(neutralizeUnsafeMermaid(block(lines)), block(lines).replace('```mermaid', '```text'), lines.join(' / '));
});

// demoteUnparsableMermaid: the runtime parser decides; only a rejected block's info string changes.
const { demoteUnparsableMermaid, mermaidSyntaxCheck } = load('ai/mermaid-safety.ts');
const BAD_PIE = ['```mermaid', 'pie showTitle', '    title "台北市都更案件狀態（2026年）"', '    "已核定" : 718', '```'];
const GOOD_PIE = ['```mermaid', 'pie showData', '  title Status', '  "A" : 6', '```'];
const stub = async code => (/^pie showTitle/.test(code) ? 'invalid' : 'ok');

test('a pie showTitle block is demoted to text; the rest of the page is byte-identical', async () => {
  const page = ['前言\r', '', ...BAD_PIE.map(l => l + '\r'), '', ...GOOD_PIE.map(l => l + '\r'), '尾巴'].join('\n');
  const out = await demoteUnparsableMermaid(page, stub);
  assert.equal(out, page.replace('```mermaid', '```text'), 'only the first fence changes, CRLF kept');
});

test('a block that parses, and a page with no mermaid, come back identical', async () => {
  const page = ['x', ...GOOD_PIE, 'y'].join('\n');
  assert.equal(await demoteUnparsableMermaid(page, stub), page);
  assert.equal(await demoteUnparsableMermaid('plain', async () => assert.fail('no block, no parse')), 'plain');
  assert.equal(await demoteUnparsableMermaid(page, undefined), page);
});

test('a failing block inside a callout or a list is demoted alone, with the prefix stripped before parsing', async () => {
  const seen = [];
  const check = async code => { seen.push(code); return stub(code); };
  const page = ['> [!note]', ...BAD_PIE.map(l => '> ' + l), '', '- item', ...GOOD_PIE.map(l => '  ' + l)].join('\n');
  const out = await demoteUnparsableMermaid(page, check);
  assert.equal(out, page.replace('> ```mermaid', '> ```text'));
  assert.equal(seen[0], BAD_PIE.slice(1, -1).join('\n'), 'no "> " prefix reaches the parser');
  assert.equal(seen[1], GOOD_PIE.slice(1, -1).join('\n'), 'list indentation is stripped');
});

test('an unusable parser keeps the whole page, demotes nothing and logs once', async () => {
  const page = ['```mermaid', 'pie showTitle', '```', '', ...BAD_PIE].join('\n');
  const warns = [], original = console.warn; console.warn = (...args) => warns.push(args);
  try {
    assert.equal(await demoteUnparsableMermaid(page, async () => 'unavailable'), page);
    assert.equal(await demoteUnparsableMermaid(page, mermaidSyntaxCheck(async () => { throw new Error('no engine'); })), page);
    assert.equal(await demoteUnparsableMermaid(page, mermaidSyntaxCheck(async () => ({}))), page);
  } finally { console.warn = original; }
  assert.equal(warns.length, 3);
});

test('mermaidSyntaxCheck: a rejection is invalid only when a known-good diagram still parses; a parser that rejects everything is unavailable', async () => {
  assert.equal(await mermaidSyntaxCheck(async () => ({ parse: async () => ({}) }))('x'), 'ok');
  const real = { parse: async text => { if (!/^(?:flowchart|pie)/.test(text)) throw new Error('Parse error'); } };
  assert.equal(await mermaidSyntaxCheck(async () => real)('x'), 'invalid');
  assert.equal(await mermaidSyntaxCheck(async () => null)('x'), 'unavailable');
  const warns = [], original = console.warn; console.warn = (...args) => warns.push(args);
  try {
    const broken = mermaidSyntaxCheck(async () => ({ parse: async () => { throw new TypeError('engine is broken'); } }));
    assert.equal(await broken('flowchart TD\n  A --> B'), 'unavailable');
    assert.ok(warns.length >= 1 && String(warns[0].join(' ')).includes('engine is broken'), 'the error is logged');
    const page = ['```mermaid', 'flowchart TD', '  A --> B', '```', '', ...BAD_PIE].join('\n');
    assert.equal(await demoteUnparsableMermaid(page, broken), page, 'a broken parser demotes nothing');
  } finally { console.warn = original; }
});

test('mermaidSyntaxCheck: a transient probe failure is not remembered forever', async () => {
  let calls = 0;
  const check = mermaidSyntaxCheck(async () => ({ parse: async text => { calls++; if (calls <= 2) throw new TypeError('warming up'); if (/bad/.test(text)) throw new Error('Parse error'); } }));
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await check('bad'), 'unavailable');
    assert.equal(await check('bad'), 'invalid', 'once the probe parses, a rejection is a syntax error');
  } finally { console.warn = warn; }
});

test('demoteUnparsableMermaid leaves a mermaid fence quoted inside another code block as it is', async () => {
  const seen = [];
  const check = async code => { seen.push(code); return 'invalid'; };
  const outer4 = ['````markdown', '```mermaid', 'pie showTitle', '```', '````'].join('\n');
  const outerTilde = ['~~~md', '```mermaid', 'pie showTitle', '```', '~~~'].join('\n');
  assert.equal(await demoteUnparsableMermaid(outer4, check), outer4);
  assert.equal(await demoteUnparsableMermaid(outerTilde, check), outerTilde);
  assert.equal(seen.length, 0, 'the parser never saw the quoted blocks');
  const mixed = `${outer4}\n\n${BAD_PIE.join('\n')}`;
  assert.equal(await demoteUnparsableMermaid(mixed, check), `${outer4}\n\n${BAD_PIE.join('\n').replace('mermaid', 'text')}`);
});

test('the pie example in the prompts is a pie the syntax rules allow: first line pie or pie showData, unquoted title on its own line', () => {
  const fs = require('node:fs');
  for (const file of ['core/steps/_shared/obsidian-format.zh.md', 'core/steps/_shared/obsidian-format.en.md', 'core/steps/chart/chart.zh.md', 'core/steps/chart/chart.en.md']) {
    const text = fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
    assert.match(text, /`pie` or `pie showData`|`pie` 或 `pie showData`/, file);
    assert.match(text, /`pie`[、,][^\n]*`  title [^"`]+`/, file);
  }
});

test('indentation inside a diagram reaches the parser: a mindmap in a list item keeps its levels', async () => {
  const seen = [];
  const page = ['- item', '  ```mermaid', '  mindmap', '    root["a"]', '      b["c"]', '  ```'].join('\n');
  assert.equal(await demoteUnparsableMermaid(page, async code => { seen.push(code); return 'ok'; }), page);
  assert.equal(seen[0], 'mindmap\n  root["a"]\n    b["c"]');
});

test('addedMermaidBlocks: only the blocks the after text has beyond the before text (multiset, LF-normalized, parser code keeps relative indentation)', () => {
  const style = '```mermaid\nflowchart TD\n  A --> B\n  style A fill:#f00\n```';
  const mind = '```mermaid\nmindmap\n  root((r))\n    child\n```';
  assert.equal(addedMermaidBlocks(`${style}\n\ntext\n`, `${style}\n\nother\n`).length, 0);
  assert.equal(addedMermaidBlocks(`${style}\r\n\r\ntext\r\n`, `${style}\n\nother\n`).length, 0, 'CRLF vs LF is the same block');
  assert.equal(addedMermaidBlocks(style, `${style}\n\n${style}`).length, 1, 'a second copy counts');
  const added = addedMermaidBlocks('text', `> - ${mind.replace(/\n/g, '\n>   ')}`);
  assert.equal(added.length, 1);
  assert.equal(added[0].unsafe, false);
  assert.equal(added[0].code, 'mindmap\n  root((r))\n    child');
  assert.equal(addedMermaidBlocks('text', style)[0].unsafe, true);
  assert.equal(addedMermaidBlocks('a', 'a b').length, 0);
  const foo = style.replace('```mermaid', '```mermaid.foo');
  assert.equal(addedMermaidBlocks(style, foo).length, 1, 'only the info string changed: still a new block');
  assert.equal(addedMermaidBlocks(`${foo}\n\ntext`, `${foo}\n\nother`).length, 0, 'same body and same info: not new');
});
