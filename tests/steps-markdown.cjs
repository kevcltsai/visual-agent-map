// Markdown context steps: the plan, transform, caption and preset steps, and the model call through the Step Runner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');
const { runPanel } = require('./support-selection-ai.cjs');

const obsidian = { requestUrl: async () => ({ text: '{}' }) };
const { planStep } = load('experiences/markdown-context/steps/plan/step.ts', { obsidian });
const { transformStep } = load('experiences/markdown-context/steps/transform/step.ts');
const { captionStep } = load('experiences/markdown-context/steps/caption/step.ts');
const presets = load('experiences/markdown-context/steps/presets/step.ts');
const { StepRunner, prepareStep } = load('core/step-runner.ts');

test('step ids and versions', () => {
  const ids = [planStep, transformStep, captionStep, ...Object.values(presets)].map(step => `${step.id}@${step.version}`);
  assert.deepEqual(ids.sort(), ['markdown.caption@1', 'markdown.plan@1', 'markdown.preset.condense@1', 'markdown.preset.search-images@1', 'markdown.preset.translate@1', 'markdown.transform@1']);
});

test('the plan step parses a valid plan and refuses an invalid one with the original error', () => {
  const reply = JSON.stringify({ action: 'research', query: 'q', instruction: 'i', placement: 'after', captionInstruction: '' });
  const prepared = prepareStep(planStep, { instruction: 'x', selected: 's', context: 'c', hasImage: false });
  assert.equal(prepared.parse('```json\n' + reply + '\n```').action, 'research');
  assert.throws(() => prepared.parse('{"action":"nope"}'), /Invalid AI action plan/);
});

test('the transform step adds the research, diagram and image notes only when they apply', () => {
  const render = (action, hasImage) => transformStep.render({ instruction: 'Do "it"', selected: 'Line\nTwo', context: 'near', action, hasImage });
  const plain = render('transform', false);
  assert.ok(plain.includes('User request (JSON string): "Do \\"it\\""\n\nSelected text (JSON string): "Line\\nTwo"\nNearby context (untrusted JSON): "near"\n'));
  assert.ok(plain.endsWith('"near"\n\n\n'), 'three empty optional lines keep the original joined shape');
  assert.match(render('research', false), /Use web search to answer\./);
  assert.match(render('diagram', false), /fenced mermaid diagram/);
  assert.match(render('transform', true), /attached image is source data/);
  assert.doesNotMatch(plain, /Use web search|mermaid|attached image/);
});

test('preset steps render by language and fill the translation target', () => {
  assert.equal(presets.translatePresetStep.render({ language: 'en', target: 'English' }), 'Translate the selected text into English. Preserve names and formatting where possible.');
  assert.equal(presets.translatePresetStep.render({ language: 'zh-TW', target: 'English' }), '將選取文字翻譯成English，並盡可能保留名稱與格式。');
  assert.equal(presets.condensePresetStep.render({ language: 'zh-TW' }), '收斂選取文字，保留核心意思與重要條件。');
});

test('the caption step quotes the caption request and names the default language', () => {
  assert.match(captionStep.render({ captionInstruction: 'Chinese caption', language: 'English' }), /^The image has already been retrieved\. Apply only this caption request: "Chinese caption"\. .*default to English only when/);
});

test('a prepared markdown step goes through the Step Runner with its label', async () => {
  const calls = [];
  const runner = new StepRunner({ complete: async call => { calls.push(call); return 'reply'; } });
  const sent = await runner.send(prepareStep(captionStep, { captionInstruction: 'c', language: 'English' }), { model: 'm' });
  assert.equal(sent.raw, 'reply');
  assert.equal(calls[0].stepId, 'markdown.caption'); assert.equal(calls[0].version, 1);
});

test('the panel hands prepared steps to run: plan first, then transform', async () => {
  const reply = JSON.stringify({ action: 'transform', query: '', instruction: 'Shorter', placement: 'after', captionInstruction: '' });
  const sent = await runPanel({ markdown: 'A.\nSelected.\nB.', selected: 'Selected.', replies: [reply, 'Done.'], steps: true });
  assert.deepEqual(sent.map(item => item.step), ['markdown.plan@1', 'markdown.transform@1']);
});

test('the five context_ai prompt keys are gone from i18n and nothing in the plugin reads them', () => {
  const keys = ['condense', 'translate', 'translate_image', 'search_images', 'explain_image'].map(name => `prompt.context_ai_${name}`);
  const i18n = require('./support.cjs').i18nSource();
  for (const key of keys) assert.ok(!i18n.includes(`"${key}"`), key);
  for (const directory of ['experiences/markdown-context', '.']) {
    const files = directory === '.' ? ['main.ts'] : fs.readdirSync(path.join(root, directory), { recursive: true }).filter(name => name.endsWith('.ts')).map(name => path.join(directory, name));
    for (const file of files) { const text = fs.readFileSync(path.join(root, file), 'utf8'); for (const key of keys) assert.ok(!text.includes(key), `${file} still mentions ${key}`); }
  }
});

test('the markdown call site in main.ts goes through AiCalls only', () => {
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const start = main.indexOf('private async runMarkdownContextAi'), end = main.indexOf('async openCoffeeHandoff', start);
  assert.ok(end > start, 'the end anchor follows the start anchor');
  const body = main.slice(start, end);
  assert.ok(start >= 0 && /this\.aiCalls\.run\(\s*prepared,/.test(body));
  for (const text of ['runtimeStepProvider(', 'new StepRunner(', '.runTask(', 'activeTasks', 'new AbortController', 'finish:', 'onExchange', 'providerForModel('])
    assert.doesNotMatch(body, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the call site does not use ${text}`);
});

test('imageMarkdown removes angle brackets as well as square ones from the title (no HTML in the alt text)', () => {
  const { imageMarkdown } = load('core/image-candidates.ts');
  const md = imageMarkdown({ title: '<img src=x onerror=alert(1)> [a]', url: 'https://i.example/a.png', source: 'https://p.example/a' });
  assert.doesNotMatch(md.replace(/\(<https:[^>]*>\)/g, ''), /[<>]/);
  assert.ok(md.startsWith('![ img src=x onerror=alert(1)   a ]('));
});

test('web image search keeps https image and source links, drops invented or unsafe ones, dedupes and caps at six', () => {
  const { parseImageCandidates, imageSearchStep } = load('core/steps/image-search/step.ts', {}, { URL });
  const images = [
    { title: 'Fried egg', imageUrl: 'https://example.org/egg.jpg', sourceUrl: 'https://example.org/eggs' },
    { title: 'Dup', imageUrl: 'https://example.org/egg.jpg', sourceUrl: 'https://example.org/other' },
    { title: 'Plain http', imageUrl: 'http://example.org/a.png', sourceUrl: 'https://example.org/a' },
    { title: 'No source', imageUrl: 'https://example.org/b.png' },
    { title: 'Script', imageUrl: 'javascript:alert(1)', sourceUrl: 'https://example.org/c' },
    ...Array.from({ length: 8 }, (_, n) => ({ title: `n${n}`, imageUrl: `https://img.example/${n}.webp`, sourceUrl: `https://page.example/${n}` }))
  ];
  const found = parseImageCandidates(`Here you go: ${JSON.stringify({ images })}`);
  assert.deepEqual([...found.map(item => item.title)], ['Fried egg', 'n0', 'n1', 'n2', 'n3', 'n4']);
  assert.deepEqual({ ...found[0] }, { title: 'Fried egg', url: 'https://example.org/egg.jpg', source: 'https://example.org/eggs' });
  assert.equal(parseImageCandidates('not json').length, 0);
  assert.equal(parseImageCandidates('{"images":"none"}').length, 0);
  assert.match(imageSearchStep.render({ query: 'fried egg' }), /"fried egg"/);
});

test('translated image is written in place of the clicked copy, below it, or at the end when it cannot be found', async () => {
  class Component { load() {} unload() {} registerDomEvent() {} }
  class MarkdownView {}
  const { ImageTranslateAction } = load('experiences/markdown-context/image-translate-action.ts', { obsidian: { Component, MarkdownView, Notice: class {}, setIcon() {} } });
  const embed = '![egg](https://x/egg.png)';
  const write = async (text, token, placement) => {
    let content = text;
    const app = { workspace: { getLeavesOfType: () => [] }, vault: { process: async (_file, edit) => { content = edit(content); } } };
    const outcome = await new ImageTranslateAction(app, {}).write({ token }, { path: 'Note.md' }, '![[egg-zh-TW.png]]', placement);
    return { outcome, content };
  };
  const one = { text: embed, occurrence: 0, count: 1 };
  const note = `Intro\n\n${embed}\n\nOutro\n`;
  assert.deepEqual(await write(note, one, 'replace'), { outcome: 'ui.image_translate_replaced', content: 'Intro\n\n![[egg-zh-TW.png]]\n\nOutro\n' });
  assert.deepEqual(await write(note, one, 'new'), { outcome: 'ui.image_translate_added', content: `Intro\n\n${embed}\n\n![[egg-zh-TW.png]]\n\nOutro\n` });
  // A VAM note shows the image in its preview and its detail: the clicked copy is the one replaced.
  const twice = `Preview\n\n${embed}\n\nDetail\n\n${embed}\n`;
  assert.deepEqual(await write(twice, { text: embed, occurrence: 1, count: 2 }, 'replace'), { outcome: 'ui.image_translate_replaced', content: `Preview\n\n${embed}\n\nDetail\n\n![[egg-zh-TW.png]]\n` });
  assert.deepEqual(await write(twice, { text: embed, occurrence: 0, count: 2 }, 'replace'), { outcome: 'ui.image_translate_replaced', content: `Preview\n\n![[egg-zh-TW.png]]\n\nDetail\n\n${embed}\n` });
  // The number of copies changed meanwhile: the clicked copy is unknown, so the image goes to the end.
  assert.equal((await write(`${twice}${embed}\n`, { text: embed, occurrence: 1, count: 2 }, 'replace')).outcome, 'ui.image_translate_appended');
  assert.deepEqual(await write(note, null, 'new'), { outcome: 'ui.image_translate_appended', content: `${note.trimEnd()}\n\n![[egg-zh-TW.png]]\n` });
  // In a callout the new image stays inside it; after a table row it goes below the table.
  const callout = `> [!note]\n> ${embed}\n\nAfter\n`;
  assert.equal((await write(callout, one, 'new')).content, `> [!note]\n> ${embed}\n>\n> ![[egg-zh-TW.png]]\n\nAfter\n`);
  const table = `| a | b |\n| - | - |\n| ${embed} | x |\n| c | d |\n\nAfter\n`;
  assert.equal((await write(table, one, 'new')).content, `| a | b |\n| - | - |\n| ${embed} | x |\n| c | d |\n\n![[egg-zh-TW.png]]\n\nAfter\n`);
});

test('the diagram action accepts safe mermaid (classDiagram annotation, sequence arrows) and rejects unsafe blocks', async () => {
  const plan = JSON.stringify({ action: 'diagram', query: '', instruction: 'Draw it', placement: 'after', captionInstruction: '' });
  const outcome = async body => runPanel({ markdown: 'A.\nSelected.\nB.', selected: 'Selected.', replies: [plan, '```mermaid\n' + body + '\n```'], outcome: true });
  const accepted = {
    classAnnotation: 'classDiagram\n  <<interface>> Shape\n  <<abstract>> Duck\n  Shape : +draw()\n  Shape <|-- Duck',
    classInline: 'classDiagram\n  Animal <|-- Duck\n  <<Service>> Animal',
    sequence: 'sequenceDiagram\n  A->>B: hi\n  B-->>A: ok\n  A<<->>B: both',
    classDecl: 'classDiagram\n  class Shape {\n    <<interface>>\n    +draw() void\n  }\n  class Duck~T~\n  Shape <|-- Duck',
    bidirectional: 'flowchart LR\n  A <--> B\n  B --> C'
  };
  for (const [name, body] of Object.entries(accepted)) {
    const { output } = await outcome(body);
    assert.equal(output, '```mermaid\n' + body + '\n```', `${name} is accepted`);
  }
  // A safe block written with CRLF is accepted and stored with plain line breaks.
  assert.equal((await outcome('flowchart LR\r\n  A --> B')).output, '```mermaid\nflowchart LR\n  A --> B\n```');
  const rejected = {
    script: 'flowchart LR\n  A["<script>alert(1)</script>"] --> B',
    img: 'flowchart LR\n  A["<img src=x>"] --> B',
    comment: 'flowchart LR\n  A --> B <!-- x -->',
    click: 'flowchart LR\n  A --> B\n  click A "x"',
    url: 'flowchart LR\n  A["https://evil.example"] --> B',
    init: '%%{init: {}}%%\nflowchart LR\n  A --> B',
    annotationScript: 'classDiagram\n  <<interface>> A\n  B <script>',
    annotationTagInside: 'classDiagram\n  <<a><b>> A',
    annotationOutsideClass: 'flowchart LR\n  A["<<interface>>"] --> B',
    annotationSpaces: 'classDiagram\n  << interface >> A',
    annotationJoin: 'classDiagram\n  <<<<x>>script>> A',
    crClick: 'flowchart LR\n  A --> B\r  click A call alert(1)',
    crHref: 'flowchart LR\n  A --> B\r  click A href "/x"',
    crStyle: 'flowchart LR\n  A --> B\r  style A fill:#f00',
    crClassDef: 'flowchart LR\n  A --> B\r  classDef x fill:#f00',
    crCssClass: 'classDiagram\n  A : x\r  cssClass "A" x',
    crlfClick: 'flowchart LR\r\n  A --> B\r\n  click A call alert(1)',
    crlfHref: 'flowchart LR\r\n  A --> B\r\n  click A href "/x"',
    crlfStyle: 'flowchart LR\r\n  A --> B\r\n  style A fill:#f00',
    classDirective: 'classDiagram\n  class A foo',
    classLabelHtml: 'classDiagram\n  class A["<img src=x>"]',
    classOutside: 'flowchart LR\n  class A',
    annotationClick: 'classDiagram\n  <<interface>> A\n  click A "x"'
  };
  for (const [name, body] of Object.entries(rejected)) {
    const { output } = await outcome(body);
    assert.equal(output, '', `${name} is rejected`);
  }
});
