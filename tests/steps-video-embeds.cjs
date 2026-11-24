// YouTube embeds in a research note (canvas-image-anchors P3): only videos whose page the provider opened stay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const { keepOpenedVideoEmbeds, youtubeVideoId, restoreDroppedMedia } = S.load('core/video-embeds.ts');

const A = 'abcdefghijk';
const B = 'ZYXWVUTSRQP';
const keep = (detail, opened) => keepOpenedVideoEmbeds(detail, opened);

test('an opened video stays and is rewritten to the one documented form; all hosts and url shapes of the same id', () => {
  const opened = [`https://www.youtube.com/watch?v=${A}&t=5s`];
  for (const url of [`https://youtu.be/${A}`, `https://youtube.com/watch?v=${A}`, `https://m.youtube.com/watch?v=${A}`, `https://www.youtube.com/embed/${A}`])
    assert.equal(keep(`![](${url})`, opened), `![](https://www.youtube.com/watch?v=${A})`, url);
  assert.equal(keep(`![demo](https://youtu.be/${A})`, [`https://youtu.be/${A}`]), `![demo](https://www.youtube.com/watch?v=${A})`);
});
test('an id that was not opened deletes the whole line; the lines around it stay', () => {
  assert.equal(keep(`before\n![](https://www.youtube.com/watch?v=${B})\nafter`, [`https://www.youtube.com/watch?v=${A}`]), 'before\nafter');
  assert.equal(keep(`![](https://www.youtube.com/watch?v=${B})`, []), '');
  assert.equal(keep(`a\r\n![](https://youtu.be/${B})\r\nb`, []), 'a\r\nb', 'CRLF');
});
test('Quick research opens no pages: every YouTube embed goes', () => {
  assert.equal(keep(`x\n![](https://youtu.be/${A})\n![](https://www.youtube.com/watch?v=${B})\ny`, []), 'x\ny');
});
test('a fake host, a wrong id length and a non-video YouTube url are deleted even when the id was opened', () => {
  const opened = [`https://www.youtube.com/watch?v=${A}`];
  for (const url of [`https://youtube.com.evil.example/watch?v=${A}`, `https://www.youtube.com.evil.example/watch?v=${A}`, `https://youtu.be.evil.example/${A}`,
    `https://www.youtube-nocookie.com/embed/${A}`, 'https://www.youtube.com/watch?v=short', `https://www.youtube.com/watch?v=${A}x`, 'https://www.youtube.com/', 'https://youtu.be/', `ftp://youtu.be/${A}`])
    assert.equal(keep(`![](${url})`, opened), '', url);
  const other = `![](https://evil.example/youtu.be/${A})`;
  assert.equal(keep(other, opened), other, 'a path that only mentions youtu.be is an ordinary embed');
});
test('the look-alike hosts are not YouTube: they are no id source for the opened set either', () => {
  assert.equal(youtubeVideoId(`https://youtube.com.evil.example/watch?v=${A}`), null);
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${A}`), A);
  const text = `![](https://www.youtube.com/watch?v=${A})`;
  assert.equal(keep(text, [`https://youtube.com.evil.example/watch?v=${A}`]), '', 'an evil opened url does not open the id');
});
test('code fences are left alone, including fences of ~ and a longer closing one', () => {
  const body = `![](https://youtu.be/${B})`;
  assert.equal(keep('```md\n' + body + '\n```', []), '```md\n' + body + '\n```');
  assert.equal(keep('~~~\n' + body + '\n~~~~\n' + body, []), '~~~\n' + body + '\n~~~~\n', 'after the fence closes the embed is checked again');
  assert.equal(keep('````\n```\n' + body + '\n````', []), '````\n```\n' + body + '\n````');
});
test('plain links, other embeds and images stay byte for byte', () => {
  const text = [`[watch](https://www.youtube.com/watch?v=${B})`, '![](https://example.org/a.png)', '![](https://vimeo.com/123456789)', `Text with https://youtu.be/${B} bare`, '![[local.png]]'].join('\n');
  assert.equal(keep(text, []), text);
});
test('an embed inside a sentence is removed alone; nothing else changes', () => {
  assert.equal(keep(`Watch ![](https://youtu.be/${B}) now`, []), 'Watch  now');
  assert.equal(keep('', []), '');
});
test('an id already embedded in the existing note survives a rewrite; a new un-opened id is still removed', () => {
  const C = 'abcdefghijk';
  const existing = `Intro\n![](https://youtu.be/${B})\n`;
  const out = keepOpenedVideoEmbeds(`Rewritten\n![](https://www.youtube.com/watch?v=${B})\n![](https://www.youtube.com/watch?v=${C})\n`, [], existing);
  assert.equal(out, `Rewritten\n![](https://www.youtube.com/watch?v=${B})\n`);
  assert.equal(keepOpenedVideoEmbeds(`![](https://www.youtube.com/watch?v=${B})`, [], ''), '');
});
const W = id => `![](https://www.youtube.com/watch?v=${id})`;
test('HTML embeds: iframe, embed and object with a YouTube src follow the same rule (kept as the one form, or removed)', () => {
  const opened = [`https://www.youtube.com/watch?v=${A}`];
  const iframe = id => `<iframe width="560" height="315" src="https://www.youtube.com/embed/${id}" frameborder="0" allowfullscreen></iframe>`;
  assert.equal(keep(`a\n${iframe(A)}\nb`, opened), `a\n${W(A)}\nb`);
  assert.equal(keep(`a\n${iframe(B)}\nb`, opened), 'a\nb');
  assert.equal(keep(`a\n<embed src='https://youtu.be/${B}'>\nb`, opened), 'a\nb');
  assert.equal(keep(`<object data=https://www.youtube.com/v/${B}></object>`, opened), '');
  assert.equal(keep(`<iframe src="//www.youtube.com/embed/${B}"></iframe>`, opened), '');
  assert.equal(keep(`<iframe\n  width="1"\n  src="https://www.youtube.com/embed/${B}"\n></iframe>\nafter`, opened), 'after', 'a tag over several lines');
  assert.equal(keep(`<IFRAME SRC="https://www.youtube-nocookie.com/embed/${A}"></IFRAME>`, opened), '', 'a look-alike host');
  assert.equal(keep(`x <iframe src="https://www.youtube.com/embed/${B}"></iframe> y`, opened), 'x  y');
  const other = '<iframe src="https://example.org/page"></iframe>';
  assert.equal(keep(other, opened), other, 'an iframe of another host is untouched');
  assert.equal(keepOpenedVideoEmbeds(`<iframe src="https://www.youtube.com/embed/${B}"></iframe>`, [], `![](https://youtu.be/${B})`), W(B), 'already in the existing note');
});
test('reference definitions used by an image: kept rewritten when allowed, else the definition and its uses go', () => {
  const opened = [`https://www.youtube.com/watch?v=${A}`];
  assert.equal(keep(`See ![demo][v]\n\n[v]: https://youtu.be/${A} "t"\n`, opened), `See ![demo][v]\n\n[v]: https://www.youtube.com/watch?v=${A} "t"\n`);
  assert.equal(keep(`See\n![demo][v]\n\n[v]: https://youtu.be/${B}\n`, opened), 'See\n\n');
  assert.equal(keep(`![][V]\n[v]: <https://youtu.be/${B}>`, opened), '', 'labels are case-insensitive');
  assert.equal(keep(`![v][]\n![v]\n[v]: https://youtu.be/${B}`, opened), '', 'collapsed and shortcut');
  assert.equal(keep(`![x][v]\n[v]: https://youtube.com.evil.example/watch?v=${A}`, opened), '', 'a look-alike host');
  const link = `[watch][v]\n\n[v]: https://youtu.be/${B}`;
  assert.equal(keep(link, opened), link, 'a definition only a plain link uses stays');
  const plain = '![x][p]\n[p]: https://example.org/a.png';
  assert.equal(keep(plain, opened), plain, 'an image definition of another host');
  const fenced = '```\n![x][v]\n[v]: https://youtu.be/' + B + '\n```';
  assert.equal(keep(fenced, opened), fenced, 'fences stay');
  assert.equal(keep(`![x][v]\r\n[v]: https://youtu.be/${B}\r\nend`, opened), 'end', 'CRLF');
});
test('a list item whose whole content was a removed embed goes with its marker; other items stay', () => {
  assert.equal(keep(`- one\n- ![](https://youtu.be/${B})\n- two`, []), '- one\n- two');
  assert.equal(keep(`1. ![](https://youtu.be/${B})\n2. two`, []), '2. two');
  assert.equal(keep(`  * <iframe src="https://youtu.be/${B}"></iframe>\n  * two`, []), '  * two');
  assert.equal(keep(`- see ![](https://youtu.be/${B})\n- two`, []), '- see\n- two', 'an item with text stays');
  assert.equal(keep(`- ![](https://youtu.be/${A})`, [`https://youtu.be/${A}`]), `- ${W(A)}`, 'a kept item stays');
});
test('hook: ai-task-service filters task-mode details with the opened urls of countsWeb runs and none otherwise', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'ai-task-service.ts'), 'utf8');
  assert.match(source, /\.\.\.\(countsWeb \? openedUrlsFromEvents\(webEvents\) : \[\]\)/);
  assert.match(source, /\.\.\.videoUrlsInText\(`\$\{input\.task\}\\n\$\{input\.userTexts \?\? ""\}`\)/);
  assert.match(source, /keepOpenedVideoEmbeds\(result\.detail, videoFilter\.opened, input\.detail\)/);
  assert.match(source, /if \(keepsEvents \|\| countsWeb\) webEvents\.push\(event\)/);
});

// ---- AiTaskService behaviour (reviewer R1): a fake runtime with web events ----
const { load } = require('./support-replay.cjs');
const { AiTaskService } = load('core/ai-task-service.ts');
const templates = load('ai/detail-templates.ts');
const ctx = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });
const openPage = url => ({ method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'openPage', url } } } });
const rigService = (handler, videoPlayable) => {
  const calls = [];
  const runtime = { runTask: async (prompt, model, effort, schema, controls) => { const call = { n: calls.length + 1, prompt, controls }; calls.push(call); return handler(call); } };
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => runtime, claudeRuntime: () => runtime, ...(videoPlayable ? { videoPlayable } : {})
  });
  return { service, calls };
};
const reply = detail => JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] });
const countInput = extra => {
  const template = templates.copyTemplate(templates.standardTemplate('zh-TW'), '教學', 't1');
  template.sections.splice(2, 0, { id: 'ex', name: '範例', description: '', role: 'none', count: { mode: 'exact', n: 3 }, aliases: [] });
  return ctx({ language: 'zh-TW', outputLanguage: 'zh-TW', detailTemplate: template, ...extra });
};
const items = n => Array.from({ length: n }, (_, i) => `- ${i + 1}`).join('\n');
const body = (n, extra = '') => `### 核心結論\n\n- a\n\n### 範例\n\n${items(n)}${extra}`;

test('AiTaskService: a research run keeps the embed of an opened video and removes an un-opened one', async () => {
  const h = rigService(call => {
    call.controls.onWebSearchEvent?.(openPage(`https://www.youtube.com/watch?v=${A}`));
    return reply(`x\n\n![](https://youtu.be/${A})\n\n![](https://youtu.be/${B})\n`);
  });
  const result = await h.service.askModel(ctx({ researchMode: 'research', researchDepth: 'normal' }), 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes(`![](https://www.youtube.com/watch?v=${A})`));
  assert.ok(!result.detail.includes(B));
});
test('AiTaskService: a Quick run opens no page, so every embed goes', async () => {
  const h = rigService(call => reply(`x\n\n![](https://youtu.be/${A})\n`));
  const result = await h.service.askModel(ctx(), 'gpt-6-luna', 'low');
  assert.ok(!result.detail.includes(A));
});
test('count repair: an un-opened id added by the repair is removed; the opened id of the first call stays', async () => {
  const h = rigService(call => {
    if (call.n === 1) {
      call.controls.onWebSearchEvent?.(openPage(`https://www.youtube.com/watch?v=${A}`));
      return reply(body(2, `\n\n![](https://youtu.be/${A})`));
    }
    return reply(body(3, `\n\n![](https://youtu.be/${A})\n\n![](https://youtu.be/${B})`));
  });
  const result = await h.service.askModel(countInput({ researchMode: 'research', researchDepth: 'normal' }), 'gpt-6-luna', 'low');
  assert.equal(h.calls.length, 2, 'the count repair ran');
  assert.ok(result.detail.includes(`watch?v=${A}`), 'the opened id stays');
  assert.ok(!result.detail.includes(B), 'the repair cannot add a video the provider never opened');
});

// ---- playable check (oEmbed port) ----
const openBoth = call => {
  call.controls.onWebSearchEvent?.(openPage(`https://www.youtube.com/watch?v=${A}`));
  call.controls.onWebSearchEvent?.(openPage(`https://www.youtube.com/watch?v=${B}`));
};
const researchCtx = extra => ctx({ researchMode: 'research', researchDepth: 'normal', ...extra });
test('playable check: an opened video the port calls unplayable is removed, the playable one stays', async () => {
  const asked = [];
  const h = rigService(call => { openBoth(call); return reply(`x\n\n![](https://youtu.be/${A})\n\n![](https://youtu.be/${B})\n`); }, async id => { asked.push(id); return id === A; });
  const result = await h.service.askModel(researchCtx(), 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes(`watch?v=${A}`));
  assert.ok(!result.detail.includes(B));
  assert.deepEqual(asked.sort(), [A, B].sort());
});
test('playable check: null (cannot tell) and a throwing port keep the embed', async () => {
  for (const port of [async () => null, async () => { throw new Error('offline'); }]) {
    const h = rigService(call => { openBoth(call); return reply(`x\n\n![](https://youtu.be/${A})\n\n![](https://youtu.be/${B})\n`); }, port);
    const result = await h.service.askModel(researchCtx(), 'gpt-6-luna', 'low');
    assert.ok(result.detail.includes(A) && result.detail.includes(B));
  }
});
test('playable check: a video already in the note is never checked and stays', async () => {
  const asked = [];
  const h = rigService(call => reply(`x\n\n![](https://youtu.be/${A})\n`), async id => { asked.push(id); return false; });
  const result = await h.service.askModel(researchCtx({ detail: `old\n\n![](https://www.youtube.com/watch?v=${A})\n` }), 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes(`watch?v=${A}`));
  assert.deepEqual(asked, []);
});
test('playable check: no port means no check', async () => {
  const h = rigService(call => { openBoth(call); return reply(`![](https://youtu.be/${B})\n`); });
  assert.ok((await h.service.askModel(researchCtx(), 'gpt-6-luna', 'low')).detail.includes(B));
});
test('playable check: the count repair also drops an unplayable video', async () => {
  const h = rigService(call => {
    if (call.n === 1) { openBoth(call); return reply(body(2, `\n\n![](https://youtu.be/${A})`)); }
    return reply(body(3, `\n\n![](https://youtu.be/${A})\n\n![](https://youtu.be/${B})`));
  }, async id => id === A);
  const result = await h.service.askModel(countInput({ researchMode: 'research', researchDepth: 'normal' }), 'gpt-6-luna', 'low');
  assert.equal(h.calls.length, 2);
  assert.ok(result.detail.includes(`watch?v=${A}`));
  assert.ok(!result.detail.includes(B));
});

// ---- A video the user pasted in the instruction (share-export-leftovers 04) ----
test('AiTaskService: a video the user pasted in the task stays even when no page was opened; an invented one still goes', async () => {
  const h = rigService(() => reply(`x\n\n![](https://www.youtube.com/watch?v=${A})\n\n![](https://youtu.be/${B})\n`));
  const result = await h.service.askModel(ctx({ task: `Research this.\n\nAdd this video: https://youtu.be/${A}` }), 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes(`![](https://www.youtube.com/watch?v=${A})`), 'the pasted video stays');
  assert.ok(!result.detail.includes(B), 'a video nobody pasted or opened is still removed');
});
test('AiTaskService: a video in the user\'s own text nodes counts as pasted', async () => {
  const h = rigService(() => reply(`x\n\n![](https://youtu.be/${A})\n`));
  const result = await h.service.askModel(ctx({ userTexts: `- my note https://www.youtube.com/watch?v=${A}` }), 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes(`watch?v=${A}`));
});
test('videoUrlsInText: plain YouTube urls of the text, nothing for look-alike hosts or other sites', () => {
  const { videoUrlsInText } = S.load('core/video-embeds.ts');
  assert.deepEqual(
    [...videoUrlsInText(`see https://youtu.be/${A}, (https://www.youtube.com/watch?v=${B}) and https://youtube.com.evil.example/watch?v=${A} or https://example.org`)],
    [`https://youtu.be/${A}`, `https://www.youtube.com/watch?v=${B}`]
  );
});
test('map chat: a YouTube url the chat model wrote into a research direction stays only when the user pasted it', () => {
  const { keepPastedVideoUrls } = S.load('core/map-chat-plan.ts');
  const research = direction => ({ kind: 'run_map_action', action: 'research_standard', nodeIds: [], title: '', goal: '', direction });
  const actions = [research(`Use https://youtu.be/${A} and https://www.youtube.com/watch?v=${B} please`), { kind: 'select_topics', nodeIds: ['n1'], all: false }];
  const out = keepPastedVideoUrls(actions, `把這支加進去 https://www.youtube.com/watch?v=${A}`);
  assert.equal(out[0].direction, `Use https://youtu.be/${A} and  please`);
  assert.deepEqual(out[1], actions[1], 'other actions are untouched');
  assert.equal(keepPastedVideoUrls([research('no video here')], '')[0].direction, 'no video here');
});
test('hook: the map chat conversation checks pasted videos against what the user wrote, history included', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences', 'visual-map', 'map-chat-conversation.ts'), 'utf8');
  assert.match(source, /keepPastedVideoUrls\(\s*resolveSelectionTargets\(outcome\.actions\),\s*userWords\s*\)/);
  assert.match(source, /\.filter\(item => item\.role === "user" && !item\.auto\)/);
  assert.match(source, /autoOrigin \? "" : origin\.text/);
});

// ---- research keeps the media of the old note ----
const WU = id => `https://www.youtube.com/watch?v=${id}`;
const IMG = 'https://example.com/a.gif';
const oldNote = `intro\n\n![](${WU(A)})\n\n![pic](${IMG})\n\n## 更新紀錄\n\n- old\n`;
test('restoreDroppedMedia: a dropped embed and image come back as own paragraphs before the update log', () => {
  const r = restoreDroppedMedia('intro 2\n\n## 更新紀錄\n\n- new\n', oldNote);
  assert.equal(r.detail, `intro 2\n\n![](${WU(A)})\n\n![pic](${IMG})\n\n## 更新紀錄\n\n- new\n`);
  assert.deepEqual([...r.restoredVideoIds], [A]);
});
test('restoreDroppedMedia: no update log puts them at the end; code fences are not media', () => {
  const r = restoreDroppedMedia('intro 2', `\`\`\`\n![](${WU(B)})\n\`\`\`\n![](${WU(A)})`);
  assert.equal(r.detail, `intro 2\n\n![](${WU(A)})\n`);
});
test('restoreDroppedMedia: a markdown link or an <a href> to the video becomes the embed again', () => {
  assert.equal(restoreDroppedMedia(`see [Title](https://youtu.be/${A}) now`, `![](${WU(A)})`).detail, `see ![Title](${WU(A)}) now`);
  assert.equal(restoreDroppedMedia(`see <a href="https://youtu.be/${A}">Title</a> now`, `![](${WU(A)})`).detail, `see ![Title](${WU(A)}) now`);
});
test('restoreDroppedMedia: an image kept as a link is left alone', () => {
  const d = `x [pic](${IMG})`;
  assert.equal(restoreDroppedMedia(d, `![pic](${IMG})`).detail, d);
});
test('restoreDroppedMedia: nothing missing or no media in the old note returns the input byte for byte', () => {
  const d = `a\r\n\r\n![](${WU(A)})\r\n\r\n![pic](${IMG})\r\n`;
  assert.equal(restoreDroppedMedia(d, d).detail, d);
  assert.equal(restoreDroppedMedia('plain\n', 'no media\n').detail, 'plain\n');
  assert.equal(restoreDroppedMedia('plain\n', '').restoredVideoIds.size, 0);
});
test('AiTaskService: research restores a dropped video; an unplayable one is not restored', async () => {
  const old = `old\n\n![](${WU(A)})\n\n![](${WU(B)})\n`;
  const h = rigService(() => reply('new text\n'), async id => id === A);
  const r = await h.service.askModel(researchCtx({ detail: old }), 'gpt-6-luna', 'low');
  assert.ok(r.detail.includes(`watch?v=${A}`));
  assert.ok(!r.detail.includes(B), 'private video is not put back');
});
test('AiTaskService: a non-research task does not restore', async () => {
  const h = rigService(() => reply('new text\n'));
  const r = await h.service.askModel(ctx({ detail: `old\n\n![](${WU(A)})\n` }), 'gpt-6-luna', 'low');
  assert.ok(!r.detail.includes(A));
});
