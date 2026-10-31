const assert = require('node:assert/strict');
const { integrationTest, load, plain, TFile, obsidian, fixture, coffee, coffeeSession, deferred, until, coffeeElement, coffeeFind, withCoffeeModelDiscovery, reframingModalFixture } = require('../support.cjs');
integrationTest('Coffee Tables continues in the same timeline and refreshes observer notes from the full context', async () => {
  const session = coffeeSession(); session.guests.customPrompt = '多談小公司能採取的做法';
  const notes = (version, label) => `# 觀察者整理\n\n## 最大討論轉折\n- ${label}\n\n## 被推翻或修正的假設\n- ${version}\n\n## 值得繼續追問的問題\n- 下一步？\n\n## 尚未解決的核心分歧\n- 仍有取捨`;
  const responses = [
    `### 主持人｜林岑\n先從規模談起。\n\n${notes('小公司不一定有完整團隊', '從導入轉向誰負責')}`,
    `### 受影響者｜客服代表\n我們要先談員工能不能拒絕。\n\n${notes('效率不代表工作量消失', '追問把焦點帶到拒絕權')}`,
    `### 主持人｜周以安\n先把試辦退出條件寫清楚。\n\n${notes('試辦也需要退出條件', '使用者追問帶出可逆性')}`,
  ];
  const prompts = [];
  const engine = new coffee.CoffeeEngine(session, async request => { prompts.push(request.prompt); return responses.shift(); }, async () => {});
  await engine.start(); const firstTranscript = engine.session.transcriptMarkdown;
  await engine.continueTable();
  assert.equal(engine.session.rounds.length, 2); assert.match(engine.session.transcriptMarkdown, /先從規模談起/); assert.match(engine.session.transcriptMarkdown, /我們要先談員工能不能拒絕/);
  assert.match(prompts[1], /(?:新增約 8–12 次簡短發言|add roughly 8–12 concise speaker turns)/); assert.match(prompts[1], /小公司能採取的做法/); assert.match(prompts[1], /從導入轉向誰負責/);
  assert.equal(engine.session.observerNotes.length, 1); assert.match(engine.session.observerNotes[0], /追問把焦點帶到拒絕權/); assert.match(engine.session.observerNotes[0], /從導入轉向誰負責/);
  await engine.ask('員工能拒絕試辦嗎？');
  assert.match(engine.session.questions.at(-1).question, /員工能拒絕試辦嗎/); assert.match(engine.session.questions.at(-1).answer, /先把試辦退出條件寫清楚/); assert.match(prompts[2], /小公司能採取的做法/); assert.match(prompts[2], /使用者的新問題/); assert.match(prompts[2], /追問把焦點帶到拒絕權/);
  assert.equal(engine.session.observerNotes.length, 1); assert.match(engine.session.observerNotes[0], /小公司不一定有完整團隊/); assert.ok(firstTranscript.length > 0);
});
integrationTest('Coffee Tables makes one full-text call and saves the complete Markdown only after success', async () => {
  const session = coffeeSession(); let calls = 0, saves = [];
  const transcript = '# 對談\n\n### 主持人｜主持人\n\n可以加菜，但別讓孩子被標記。\n\n# 觀察者整理\n\n## 最大討論轉折\n- 從公平轉向選擇\n\n## 被推翻或修正的假設\n- 家長付費必然改善品質\n\n## 值得繼續追問的問題\n- 如何避免標記\n\n## 尚未解決的核心分歧\n- 公平與選擇的取捨';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /1 位中立觀察者/); assert.equal(request.session.model, 'test-model'); return transcript; }, async value => saves.push(plain(value)));
  await engine.generate();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'completed', engine.error); assert.equal(engine.session.transcriptMarkdown, '# 對談\n\n### 主持人｜主持人\n\n可以加菜，但別讓孩子被標記。');
  assert.equal(saves.at(-1).transcriptMarkdown, engine.session.transcriptMarkdown); assert.equal(saves.at(-1).status, 'completed');
});
integrationTest('Coffee Tables recognizes a complete saved draft with bold Markdown insight groups without calling the model again', async () => {
  const session = coffeeSession(); const transcript = '### 主持人｜周沐\n\n先從時間實際去了哪裡開始。\n\n### 觀察者｜許安\n\n要確認績效制度有沒有改變。'; const notes = '# 觀察者整理\n\n- **最新轉折**\n  - 焦點轉向時間是否真的回到員工。\n- **修正後的假設**\n  - 省時不代表工作量下降。\n- **值得繼續追問的問題**\n  - 如何記錄修正成本？\n- **尚未解決的核心分歧**\n  - 產能與喘息空間如何取捨。'; const draft = `${transcript}\n\n${notes}\n\n${transcript}\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.error = 'observer format'; session.draftMarkdown = draft;
  session.rounds = [{ id: 'draft-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0, saved;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async value => { saved = plain(value); });
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /先從時間實際去了哪裡開始/); assert.equal((engine.session.transcriptMarkdown.match(/先從時間實際去了哪裡開始/g) ?? []).length, 1, engine.session.transcriptMarkdown);
  assert.match(engine.session.observerNotes[0], /省時不代表工作量下降/); assert.equal(engine.session.draftMarkdown, undefined); assert.equal(saved.status, 'completed');
});
integrationTest('Coffee Tables recovers complete observer sections when the root heading is missing', async () => {
  const session = coffeeSession();
  const dialogue = '### 主持人｜林岑\n\n對話文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。';
  const notes = [
    '## 意外連結\n\n- 這裡寫出討論中出現的意外連結。',
    '## 值得繼續想的問題\n\n- 還要釐清後續值得討論的問題。',
    '## 核心分歧\n\n- 這裡保留尚未解決的核心分歧。',
    '## 探索方向\n\n- 可以接著探索其他方向。',
    '## 值得查證的假設\n\n- 需要查證的假設仍待確認。',
  ].join('\n\n');
  const draft = `${dialogue}\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.error = 'observer format'; session.draftMarkdown = draft;
  session.rounds = [{ id: 'missing-root-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed');
  assert.match(engine.session.transcriptMarkdown, /簡短觀察/); assert.doesNotMatch(engine.session.transcriptMarkdown, /## 意外連結/);
  assert.match(engine.session.observerNotes[0], /^# 觀察者整理/); assert.match(engine.session.observerNotes[0], /## 意外連結/);
});
integrationTest('Coffee Tables removes earlier rootless observer sections when a complete draft is duplicated', async () => {
  const session = coffeeSession();
  const notes = label => [
    `## 意外連結\n\n- ${label} 的意外連結內容已完整整理。`,
    `## 值得繼續想的問題\n\n- ${label} 後續值得討論的問題仍然存在。`,
    `## 核心分歧\n\n- ${label} 尚未解決的核心分歧需要保留。`,
    `## 探索方向\n\n- ${label} 可以接著探索其他方向。`,
    `## 值得查證的假設\n\n- ${label} 還需要查證這項假設。`,
  ].join('\n\n');
  const first = `### 主持人｜林岑\n\n第一段對談。\n\n### 沈默｜中立觀察者\n\n第一份整理前的觀察。\n\n${notes('第一份')}`;
  const second = `### 主持人｜周禾\n\n第二段對談。\n\n### 沈默｜中立觀察者\n\n第二份整理前的觀察。\n\n${notes('第二份')}`;
  const draft = `${first}\n\n${second}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'duplicate-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed');
  assert.match(engine.session.transcriptMarkdown, /第一段對談/); assert.match(engine.session.transcriptMarkdown, /第二段對談/);
  assert.doesNotMatch(engine.session.transcriptMarkdown, /## 意外連結/);
  assert.match(engine.session.observerNotes[0], /第二份.*意外連結內容/); assert.doesNotMatch(engine.session.observerNotes[0], /第一份.*意外連結內容/);
});
integrationTest('Coffee Tables does not recover rootless observer notes missing a standard section', async () => {
  const session = coffeeSession();
  const draft = '### 主持人｜林岑\n\n對談文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。\n\n## 意外連結\n\n- 有整理。\n\n## 值得繼續想的問題\n\n- 有整理。\n\n## 核心分歧\n\n- 有整理。\n\n## 探索方向\n\n- 有整理。\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'incomplete-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables does not recover rootless observer notes with an empty standard section', async () => {
  const session = coffeeSession();
  const draft = '### 主持人｜林岑\n\n對談文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。\n\n## 意外連結\n\n- 有整理。\n\n## 值得繼續想的問題\n\n- 有整理。\n\n## 核心分歧\n\n- 有整理。\n\n## 探索方向\n\n- 有整理。\n\n## 值得查證的假設\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'empty-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables recognizes complete English observer sections without the root heading', async () => {
  const session = coffeeSession(); session.language = 'en';
  const draft = '### Host | Lin Cen\n\nConversation text.\n\n### Observer | Observer\n\nBrief observation.\n\n## Unexpected connections\n\n- A useful unexpected connection is visible in the conversation.\n\n## Questions worth pursuing\n\n- A question remains open for further discussion.\n\n## Core disagreements\n\n- The unresolved disagreement should be retained.\n\n## Directions to explore\n\n- Several directions remain available for exploration.\n\n## Assumptions to verify\n\n- This assumption needs checking before it is treated as fact.\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'english-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.observerNotes[0], /^# Observer’s notes/);
});
integrationTest('Coffee Tables trusts a complete observer summary from the resolved stream when the runtime final text disagrees', async () => {
  const session = coffeeSession(), streamed = '### 主持人｜林岑\n\n省下時間要先確認有沒有轉成別人的工作。\n\n# 觀察者整理\n\n- **最新轉折**\n  - 討論從節省時間轉向工作是否轉移。\n- **修正後的假設**\n  - 個人省時不代表案件總時間下降。\n- **值得繼續追問的問題**\n  - 如何記錄交接成本？\n- **尚未解決的核心分歧**\n  - 緩衝和產能怎麼分配？';
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async request => { calls++; request.onText?.(streamed); return 'Runtime final text omitted the completed summary.'; }, async () => {});
  await engine.start(); assert.equal(calls, 1); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /省下時間要先確認/); assert.match(engine.session.observerNotes[0], /交接成本/); assert.equal(engine.session.draftMarkdown, undefined);
});
integrationTest('Coffee Tables accepts the concise prose observer summary returned during Obsidian acceptance', async () => {
  const session = coffeeSession();
  const transcript = '### 周沐｜主持人（好奇追問）\n\n今天的題目是省下的時間應該去哪裡？';
  const notes = '# 觀察者整理\n\n目前桌上有一個暫時共識：省下的時間不應自動等同於多接案件，應該考慮減少尖峰壓力、培訓、交接緩衝和實際休息。但這些選項怎麼分配，仍取決於績效制度與輪班安排是否一起調整。\n\n還需要查證幾件事：AI 真正節省的是哪些工作時間；人工檢查和修正增加多少成本；不同班別、資歷和案件類型是否受到不同影響；以及員工選擇休息或培訓後，績效評估是否真的不會吃虧。';
  const engine = new coffee.CoffeeEngine(session, async () => `${transcript}\n\n${notes}`, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'completed', engine.error);
  assert.equal(engine.session.transcriptMarkdown, transcript);
  assert.match(engine.session.observerNotes[0], /省下的時間不應自動等同於多接案件/);
  assert.match(engine.session.observerNotes[0], /還需要查證幾件事/);
});
integrationTest('Coffee Tables keeps a prose observer summary as a draft when its final paragraph is truncated', async () => {
  const session = coffeeSession();
  const response = '### 周沐｜主持人\n\n我們需要一起看工作量。\n\n# 觀察者整理\n\n目前桌上有一個暫時共識：要同時觀察緩衝時間、交接和工作負擔。\n\n還需要查證幾件事：不同班別是否受影響，以及客服選擇休息後的績效「保護條款」';
  const engine = new coffee.CoffeeEngine(session, async request => { request.onText?.(response); return response; }, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'error');
  assert.equal(engine.session.transcriptMarkdown, '');
  assert.match(engine.session.draftMarkdown, /績效「保護條款」$/);
  assert.match(engine.error, /整理格式不完整/);
});
integrationTest('Coffee Tables does not recover an interrupted draft with empty observer groups', async () => {
  const session = coffeeSession(); const partial = '### 主持人｜林岑\n\n先把問題拆小。\n\n# 觀察者整理\n\n- **最新轉折**\n  - 焦點改變了。\n- **修正後的假設**\n  - 假設需要重看。\n- **值得繼續追問的問題**\n  - 這段尚未完成。\n- **尚未解決的核心分歧**\n  - 尚';
  session.status = 'error'; session.draftMarkdown = partial; session.rounds = [{ id: 'partial-round', markdown: '', notes: '', draftMarkdown: partial, status: 'error', createdAt: session.createdAt }];
  const pending = deferred(); let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return pending.promise; }, async () => {});
  const running = engine.start(); await until(() => calls === 1); assert.equal(engine.session.status, 'generating');
  engine.cancel(); pending.resolve(''); await running; assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /尚未完成/);
});
integrationTest('Coffee Tables preserves turn positions when recovering a draft that contains interventions', async () => {
  const session = coffeeSession(); const speech = '### 主持人｜林岑\n\n先談怎麼分工。'; const notes = '# 觀察者整理\n\n- **最新轉折**\n  - 討論開始從工具轉向工作如何重新分配。\n- **修正後的假設**\n  - 省下時間不代表第一線工作量自然下降。\n- **值得繼續追問的問題**\n  - 誰來記錄並處理自動化的例外？\n- **尚未解決的核心分歧**\n  - 效率提升應該回到公司還是員工？';
  const draft = `${speech}\n\n${speech}\n\n${notes}\n\n<!-- coffee-tables-complete -->`; session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'draft-with-intervention', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }]; session.interventions = [{ id: 'comment-1', kind: 'comment', text: '先談第一線的工作量。', createdAt: new Date().toISOString(), status: 'sent', roundId: 'draft-with-intervention', afterTurn: 2 }];
  const engine = new coffee.CoffeeEngine(session, async () => { throw new Error('must not call provider'); }, async () => {}); await engine.start();
  assert.equal(engine.session.interventions[0].afterTurn, 2); assert.equal((engine.session.transcriptMarkdown.match(/先談怎麼分工/g) ?? []).length, 2); assert.equal(engine.session.status, 'completed');
});
integrationTest('Coffee Tables failure preserves the existing transcript and retry replaces the same follow-up', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '完整對談'; let fail = true, calls = 0;
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /完整對談/); if (fail) throw new Error('provider failed'); return '### 林岑｜主持人\n\n由主持人接話。\n\n# 觀察者整理\n\n## 最大討論轉折\n- 更新\n## 被推翻或修正的假設\n- 更新\n## 值得繼續追問的問題\n- 更新\n## 尚未解決的核心分歧\n- 更新'; }, async () => {});
  await engine.ask('為什麼免費和加價不能混在一起？', 'q1');
  assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].status, 'error'); assert.equal(engine.session.transcriptMarkdown, '完整對談');
  fail = false; await engine.ask('為什麼免費和加價不能混在一起？', 'q1');
  assert.equal(calls, 2); assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].status, 'complete'); assert.equal(engine.session.questions[0].answer, '### 林岑｜主持人\n\n由主持人接話。');
});
integrationTest('Coffee Tables follow-up retry drops an interrupted observer-notes tail from the answer', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '原本對談'; session.questions = [{ id: 'q-tail', question: '追問問題', answer: '', draftAnswer: '### 林岑｜主持人\n\n已收到的回答。\n\n# 觀察者整理\n\n## 核心分歧\n- 尚未整理完成', status: 'error', createdAt: session.createdAt }];
  const notes = '# 觀察者整理\n\n## 最大討論轉折\n- 回到工作分配\n\n## 被推翻或修正的假設\n- 效率不等於公平\n\n## 值得繼續追問的問題\n- 誰承擔例外？\n\n## 尚未解決的核心分歧\n- 由誰決定';
  const engine = new coffee.CoffeeEngine(session, async () => `### 受影響者｜客服代表\n\n我補充例外工作。\n\n${notes}`, async () => {});
  await engine.ask('追問問題', 'q-tail');
  const answer = engine.session.questions[0].answer;
  assert.match(answer, /已收到的回答/); assert.match(answer, /我補充例外工作/);
  assert.doesNotMatch(answer, /# 觀察者整理|尚未整理完成/);
  assert.equal((answer.match(/已收到的回答/g) ?? []).length, 1);
});
integrationTest('Coffee Tables locks follow-up submission while the question is being saved', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = 'Full table'; const saved = deferred(); let saving = false;
  const engine = new coffee.CoffeeEngine(session, async () => 'One answer', async value => { if (value.questions.length && !saving) { saving = true; await saved.promise; } });
  const first = engine.ask('First question'); await until(() => saving); await engine.ask('Second question'); saved.resolve(); await first;
  assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].question, 'First question');
});
integrationTest('Coffee Tables cancellation discards late text and closing waits for the pending request', async () => {
  const late = deferred(); let saved = [];
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.onText?.('已收到的草稿'); return late.promise; }, async value => saved.push(plain(value)));
  const running = engine.generate(); await until(() => engine.busy && engine.session.draftMarkdown); engine.cancel(); late.resolve('這是取消後的晚到回答'); await running;
  assert.equal(engine.session.transcriptMarkdown, ''); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.draftMarkdown, '已收到的草稿'); assert.equal(saved.at(-1).draftMarkdown, '已收到的草稿');
  const second = new coffee.CoffeeEngine(coffeeSession(), async () => late.promise, async () => {}); const task = second.generate(); await until(() => second.busy); const closing = second.stop(); await closing; await task;
  assert.equal(second.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables retry folds its saved partial conversation into the completed segment', async () => {
  const session = coffeeSession(); let calls = 0; const partial = '### 林岑｜主持人\n先談怎麼分工。';
  session.status = 'error'; session.draftMarkdown = partial; session.rounds = [{ id: 'failed-round', markdown: '', notes: '', draftMarkdown: partial, status: 'error', createdAt: session.createdAt }]; session.interventions = [{ id: 'retry-comment', kind: 'comment', text: '先把第一線的工作量算進去。', createdAt: session.createdAt, status: 'sent', roundId: 'failed-round', afterTurn: 1 }];
  const notes = '# 觀察者整理\n\n## 最大討論轉折\n- 從工具轉向分工\n\n## 被推翻或修正的假設\n- 自動化不會自行減少責任\n\n## 值得繼續追問的問題\n- 誰負責覆核？\n\n## 尚未解決的核心分歧\n- 效率與控制';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; if (calls === 1) { request.onText?.(partial); throw new Error('network interrupted'); } assert.match(request.prompt, /先談怎麼分工/); request.onText?.(`${partial}\n\n### 家長｜受影響者\n我想先知道誰負責。`); return `### 家長｜受影響者\n我想先知道誰負責。\n\n${notes}`; }, async () => {});
  await engine.start(); assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /先談怎麼分工/);
  await engine.start(); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /先談怎麼分工/); assert.match(engine.session.transcriptMarkdown, /誰負責/); assert.equal(engine.session.draftMarkdown, undefined); assert.equal(engine.session.rounds.filter(round => round.draftMarkdown).length, 0); assert.equal(engine.session.interventions[0].roundId, engine.session.rounds[0].id); assert.equal(engine.session.interventions[0].afterTurn, 1); assert.ok(Date.parse(engine.session.lastCompletedAt) >= Date.parse(session.createdAt));
});
integrationTest('Coffee Tables can refresh observer notes from a stopped draft without generating dialogue', async () => {
  const session = coffeeSession(); session.status = 'error'; session.transcriptMarkdown = '### 林岑｜主持人\n\n先前已完成的對談。'; session.draftMarkdown = '### 家長｜受影響者\n\n收到一半的觀點。';
  const previous = '# 觀察者整理\n\n## 最大討論轉折\n- 舊整理'; session.observerNotes = [previous]; let calls = 0, saved;
  const fresh = '# 觀察者整理\n\n## 最大討論轉折\n- 草稿帶來的新轉折\n\n## 被推翻或修正的假設\n- 舊假設需要修正\n\n## 值得繼續追問的問題\n- 誰承擔後續責任？\n\n## 尚未解決的核心分歧\n- 效率與公平';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /只更新觀察者整理|only produce observer notes/i); assert.match(request.prompt, /收到一半的觀點/); request.onText?.(fresh); return fresh; }, async value => { saved = plain(value); });
  await engine.refreshObserverNotes();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /收到一半的觀點/); assert.match(engine.session.observerNotes[0], /草稿帶來的新轉折/); assert.equal(saved.status, 'error');
});
integrationTest('Coffee Tables retains a previous observer-summary draft if a summary retry fails', async () => {
  const session = coffeeSession(); session.status = 'error'; session.draftMarkdown = '### 來賓｜專家\n\n已保存對談。'; session.observerDraftMarkdown = '# 觀察者整理\n\n## 核心分歧\n- 先前整理草稿';
  const previous = '# 觀察者整理\n\n## 核心分歧\n- 正式舊版'; session.observerNotes = [previous];
  const engine = new coffee.CoffeeEngine(session, async request => { request.onText?.('未完成的新整理'); throw new Error('network interrupted'); }, async () => {});
  await engine.refreshObserverNotes();
  assert.equal(engine.session.observerNotes[0], previous);
  assert.match(engine.session.observerDraftMarkdown, /先前整理草稿/);
  assert.match(engine.session.observerDraftMarkdown, /未完成的新整理/);
  assert.equal(engine.session.dirtyNotes, true);
});
integrationTest('Coffee Tables routes in-room comments, guest questions and direction changes into the active request', async () => {
  const pending = deferred(), steers = [], saves = [];
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.registerIntervention?.(async text => { steers.push(text); }); return pending.promise; }, async value => saves.push(plain(value)));
  const task = engine.start(); const early = engine.intervene('comment', 'A parent in the room has a different concern.'); await until(() => engine.busy && engine.steer); await early;
  await engine.intervene('guest-question', 'What would this cost?', '林岑');
  await engine.intervene('redirect', 'Compare equal access with family choice.');
  assert.equal(steers.length, 3); assert.match(steers[0], /A parent/); assert.match(steers[1], /林岑/); assert.match(steers[2], /new direction|redirect/i);
  assert.equal(engine.session.interventions?.length, 3); assert.ok(engine.session.interventions.every(item => item.status === 'sent')); assert.equal(saves.at(-1).interventions.length, 3);
  pending.resolve('The full discussion.'); await task;
});
integrationTest('Coffee Tables shutdown drains an accepted intervention before returning', async () => {
  const response = deferred(), steering = deferred(); let startedSteer = false;
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.signal.addEventListener('abort', () => response.resolve('')); request.registerIntervention?.(async () => { startedSteer = true; await steering.promise; }); return response.promise; }, async () => {});
  const task = engine.start(); await until(() => engine.busy && engine.steer);
  const intervention = engine.intervene('comment', 'One last point.'); await until(() => startedSteer);
  let returned = false; const stopping = engine.stop().then(() => { returned = true; }); await task; await Promise.resolve(); assert.equal(returned, false);
  steering.resolve(); await intervention; await stopping; assert.equal(returned, true);
});
integrationTest('Coffee Tables preview inspection is read-only and refuses an incomplete save journal', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f => f instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 主持人｜林岑\n已保存。'; session.rounds = [{ id: 'round-ro', markdown: session.transcriptMarkdown, notes: '# 觀察者整理\n\n## 分歧\n- 保留', status: 'completed', createdAt: session.createdAt }]; await store.save(session);
  const path = store.sessionPath(session.id), before = contents.get(path), sidePath = store.sidecarPath(session.id), sideRaw = contents.get(sidePath); let writes = 0; const write = app.vault.adapter.write, processFile = app.vault.adapter.process; app.vault.adapter.write = async (...args) => { writes++; return write(...args); }; app.vault.adapter.process = async (...args) => { writes++; return processFile(...args); };
  const read = await store.inspectReadOnly(path); assert.equal(read.id, session.id); assert.equal(writes, 0); assert.equal(contents.get(path), before);
  const side = JSON.parse(sideRaw); side.journal = { previousMarkdownHash: 'x', nextMarkdownHash: 'y', previousSidecar: sideRaw }; contents.set(sidePath, JSON.stringify(side)); const journal = contents.get(sidePath); await assert.rejects(store.inspectReadOnly(path), /unfinished save/); assert.equal(writes, 0); assert.equal(contents.get(sidePath), journal);
});
integrationTest('Coffee Tables persists follow-up guest invitations and keeps one cumulative insight document', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed';
  const invited = [{ id: 'invite-anna', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' }];
  session.questions = [{ id: 'question-guest', question: '夜班遇到突發狀況如何求援？', answer: '先確認交接流程。', status: 'complete', createdAt: session.createdAt, invitedGuests: invited }];
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 是否把求援責任留給第一線。', '# 觀察者整理\n\n## 意外連結\n- 夜班支援也像備援網絡。'];
  await store.save(session); const path = store.sessionPath(session.id), raw = contents.get(path);
  assert.match(raw, /林照｜受影響者/); assert.doesNotMatch(raw, /### 先前版本|### 最新版本/); assert.match(raw, /夜班支援也像備援網絡/); assert.match(raw, /是否把求援責任留給第一線/);
  const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id);
  assert.equal(JSON.stringify(restored.questions[0].invitedGuests), JSON.stringify(invited)); assert.equal(restored.observerNotes.length, 1);
});
integrationTest('Coffee Tables backs up the exact old versioned Markdown before its first cumulative rewrite', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed';
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 最新見解。', '# 觀察者整理\n\n## 意外連結\n- 早期跨域線索。']; await store.save(session);
  const path = store.sessionPath(session.id), first = contents.get(path), old = first.replace(/## 觀察者整理[\s\S]*$/, '## 觀察者整理\n\n### 最新版本\n\n# 觀察者整理\n\n## 核心分歧\n- 最新見解。\n\n### 先前版本\n\n#### 第 1 版\n\n# 觀察者整理\n\n## 意外連結\n- 早期跨域線索。'); contents.set(path, old);
  const reopenedStore = new CoffeeStorage(app.vault, 'Agent Workspace'), loaded = await reopenedStore.load(session.id); await reopenedStore.save(loaded);
  const backups = [...contents.keys()].filter(name => name.includes('/.sessions/backups/') && name.endsWith('.md'));
  assert.equal(backups.length, 1); assert.equal(contents.get(backups[0]), old); assert.match(contents.get(path), /早期跨域線索/); assert.doesNotMatch(contents.get(path), /### 先前版本/);
});
integrationTest('Coffee Tables Markdown storage round trips punctuation, Traditional Chinese, Q&A and protects outside edits', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f => f instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession();
  session.status = 'completed'; session.lastGenerationStartedAt = '2026-09-29T20:00:00.000Z'; session.lastCompletedAt = '2026-09-29T20:05:00.000Z'; session.transcriptMarkdown = '### 林岑｜主持人\n先問現場怎麼運作。\n\n### 家長｜受影響者\n孩子會注意到標籤。'; session.rounds = [{ id: 'round-main', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  session.draftMarkdown = '### 主持人｜追問\n第一段尚未完成';
  session.observerDraftMarkdown = '# 觀察者整理\n\n## 核心分歧\n- 整理草稿也需要保存';
  session.observerNotes = ['# 觀察者整理\n\n## 最大討論轉折\n- 新版轉折\n\n## 尚未解決的核心分歧\n- 新版分歧', '# 觀察者整理\n\n## 最大討論轉折\n- 舊版轉折\n\n## 尚未解決的核心分歧\n- 舊版分歧'];
  session.questions = [{ id: 'q-1', question: '會不會造成分級？', answer: '要看加價如何呈現。', draftAnswer: '### 觀眾｜家長\n我還在回答…', status: 'complete', createdAt: new Date(Date.parse(session.createdAt) + 2000).toISOString() }];
  session.interventions = [{ id: 'comment-1', kind: 'comment', text: '家長也需要看得到退出方式。', createdAt: new Date(Date.parse(session.createdAt) + 1000).toISOString(), status: 'sent', roundId: 'round-main', afterTurn: 1 }];
  await store.save(session); const filePath = store.sessionPath(session.id), original = contents.get(filePath);
  assert.match(original, /先問現場怎麼運作[\s\S]*你（插話）[\s\S]*家長也需要看得到退出方式[\s\S]*孩子會注意到標籤/); assert.match(original, /會不會造成分級/); assert.match(original, /Reasoning|推理強度/); assert.match(original, /## 對話紀錄/); assert.equal(original.split("\n")[0], `# ${session.topic}`); assert.doesNotMatch(original, /coffee-tables-data|coffee-tables-transcript-end|<\!--.*version/i); assert.ok(files.has(`${store.hidden}/${session.id}.json`)); assert.doesNotMatch(original, new RegExp(session.id));
  assert.ok(original.length < (session.transcriptMarkdown.length + session.draftMarkdown.length + session.questions[0].draftAnswer.length) * 2 + 2200, 'session metadata should not duplicate or expand the transcript');
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'), restored = await reopened.load(session.id); assert.equal(restored.topic, session.topic); assert.match(restored.transcriptMarkdown,/先問現場怎麼運作/); assert.equal(restored.questions[0].question,session.questions[0].question); assert.equal(restored.questions[0].draftAnswer,session.questions[0].draftAnswer); assert.match(restored.interventions[0].text,/退出方式/); assert.match(restored.draftMarkdown,/第一段尚未完成/); assert.match(restored.observerDraftMarkdown,/整理草稿也需要保存/); assert.match(restored.observerNotes[0], /新版分歧/); assert.match(restored.observerNotes[0], /舊版分歧/); assert.equal(restored.observerNotes.length, 1); assert.equal(restored.model,session.model); assert.equal(restored.lastGenerationStartedAt, session.lastGenerationStartedAt); assert.equal(restored.lastCompletedAt, session.lastCompletedAt);
  const outside = original.replace('先問現場怎麼運作。', '編輯者補上現場資訊。'); contents.set(filePath, outside); const inspected = await store.inspect(filePath); assert.equal(inspected.dirtyNotes, true); await assert.rejects(store.save(session), /changed outside/); assert.equal(contents.get(filePath), outside);
  const adopted = await store.reload(filePath); assert.match(adopted.transcriptMarkdown, /編輯者補上現場資訊/); assert.match(adopted.interventions[0].text, /退出方式/); assert.equal(adopted.dirtyNotes, true);
});
integrationTest('Coffee Tables Markdown round trips style snapshots and reference text without parsing embedded headings as dialogue', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed'; session.guests.styleId = 'style-1'; session.guests.styleName = '輕鬆聊天'; session.guests.stylePrompt = '主持人多追問。'; session.guests.referenceFiles = [{ name: '背景.md', content: '# 內文標題\n```md\n### 假來賓｜主持人\n<!-- coffee-tables-complete -->\n```' }]; session.transcriptMarkdown = '### 林岑｜主持人\n真正的發言。'; session.rounds = [{ id: 'style-round', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  await store.save(session); const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id); assert.equal(restored.guests.styleId, 'style-1'); assert.equal(restored.guests.styleName, '輕鬆聊天'); assert.equal(restored.guests.stylePrompt, '主持人多追問。'); assert.equal(JSON.stringify(restored.guests.referenceFiles), JSON.stringify(session.guests.referenceFiles)); assert.equal(restored.rounds[0].markdown, session.transcriptMarkdown);
});
integrationTest('Coffee Tables Markdown omits empty failed rounds while retaining the saved draft', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'error'; session.rounds = [{ id: 'empty-1', markdown: '', notes: '', status: 'error', createdAt: session.createdAt }, { id: 'empty-2', markdown: '', notes: '', status: 'error', createdAt: session.createdAt }, { id: 'draft-3', markdown: '', notes: '', draftMarkdown: '### 主持人｜林岑\n草稿保留。', status: 'error', createdAt: session.createdAt }]; session.draftMarkdown = session.rounds[2].draftMarkdown;
  await store.save(session); const markdown = contents.get(store.sessionPath(session.id)); assert.doesNotMatch(markdown, /^## (?:Conversation part \d+|對談第 \d+ 段)$/m); assert.match(markdown, /Unfinished drafts|未完成草稿/); assert.match(markdown, /草稿保留/);
  const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id); assert.deepEqual(Array.from(restored.rounds, item => item.id), ["empty-1","empty-2","draft-3"]); assert.match(restored.draftMarkdown, /草稿保留/);
});
integrationTest('Coffee Tables titles produce safe Markdown names without replacing a same-title table', async () => {
  const { CoffeeStorage, topicSlug } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  assert.equal(topicSlug('  AI / 工作？  '), 'AI 工作？');
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), first = coffeeSession(); first.topic = 'AI / 工作？'; await store.save(first);
  const second = coffeeSession(); second.topic = first.topic; await store.save(second);
  assert.match(store.sessionPath(first.id), /AI 工作？\.md$/); assert.match(store.sessionPath(second.id), /AI 工作？（2）\.md$/);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'); assert.equal((await reopened.load(store.sessionPath(first.id))).topic, first.topic);
  files.delete(store.sessionPath(first.id)); contents.delete(store.sessionPath(first.id)); assert.equal((await reopened.load(store.sessionPath(second.id))).id, second.id); assert.equal((await reopened.reload(store.sessionPath(second.id))).id, second.id);
});
integrationTest('Coffee Tables recovers a new table when interruption occurs between Markdown and sidecar writes', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.transcriptMarkdown = '### 主持人｜林岑\n這是第一段完整對談。'; session.rounds = [{ id: 'round-a', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  const process = app.vault.adapter.process; let writes = 0; app.vault.adapter.process = async (...args) => { if (++writes === 1) throw new Error('simulated interruption'); return process(...args); };
  await assert.rejects(store.save(session), /simulated interruption/);
  const markdownPath = store.path(session.id, session.topic), sidecarPath = store.sidecarPath(session.id); assert.ok(contents.has(markdownPath)); assert.match(contents.get(sidecarPath), /targetMarkdown/);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'); await reopened.recoverPendingCreates();
  assert.doesNotMatch(contents.get(sidecarPath), /targetMarkdown/); const loaded = await reopened.load(markdownPath); assert.match(loaded.transcriptMarkdown, /第一段完整對談/);
});
integrationTest('Coffee Tables stores same-topic sessions in native topic folders and moves legacy notes with their sidecar mapping', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target));
  const first = coffeeSession(); first.status = 'completed'; first.transcriptMarkdown = '### 林岑｜主持人\n\n完整內容'; first.rounds = [{ id: 'r1', markdown: first.transcriptMarkdown, notes: '', status: 'completed', createdAt: first.createdAt }];
  await store.save(first); const firstPath = store.sessionPath(first.id); assert.match(firstPath, /Coffee Tables\/.+（[a-f0-9]{8}）\/.+\.md$/);
  const second = { ...coffeeSession(), id: 'coffee-second' }; await store.save(second); assert.equal(store.sessionPath(first.id).split('/').at(-2), store.sessionPath(second.id).split('/').at(-2));
  const original = app.vault.getAbstractFileByPath(firstPath), legacyPath = `${store.folder}/legacy.md`; await app.fileManager.renameFile(original, legacyPath);
  const sidePath = store.sidecarPath(first.id), side = JSON.parse(contents.get(sidePath)); side.filePath = legacyPath; contents.set(sidePath, JSON.stringify(side, null, 2));
  const upgrader = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const moved = await upgrader.organizeExisting(); assert.equal(moved.moved, 1);
  assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(first.id)).id, first.id);
});
integrationTest('Coffee Tables resolves a moved note with frontmatter and preserves an explicitly edited root title', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const initial = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const session = coffeeSession(); await initial.save(session);
  const originalPath = initial.sessionPath(session.id), originalFile = app.vault.getAbstractFileByPath(originalPath); contents.set(originalPath, `---\ntags: [coffee]\n---\n\n${contents.get(originalPath)}`);
  const movedPath = `${initial.folder}/renamed-note.md`; await app.fileManager.renameFile(originalFile, movedPath);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const restored = await reopened.load(session.id); assert.equal(restored.topic, session.topic);
  const edited = contents.get(movedPath).replace(`# ${session.topic}`, '# A title explicitly changed in Obsidian'); contents.set(movedPath, edited);
  const adopted = await reopened.reload(movedPath); assert.equal(adopted.topic, 'A title explicitly changed in Obsidian');
});
integrationTest('Coffee Tables startup move recovery does not clear a live FileManager move journal', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const initial = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const session = coffeeSession(); await initial.save(session); const current = initial.sessionPath(session.id), legacyPath = `${initial.folder}/moving-note.md`; await app.fileManager.renameFile(app.vault.getAbstractFileByPath(current), legacyPath); const sidePath = initial.sidecarPath(session.id), side = JSON.parse(contents.get(sidePath)); side.filePath = legacyPath; contents.set(sidePath, JSON.stringify(side, null, 2));
  const gate = deferred(), renameStarted = deferred(), store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => { renameStarted.resolve({ file, target }); return gate.promise.then(() => app.fileManager.renameFile(file, target)); }); const moving = store.organizeExisting(); const { target } = await renameStarted.promise; const staged = JSON.parse(contents.get(sidePath)); assert.ok(staged.moveJournal); await store.recoverMoves(); assert.ok(JSON.parse(contents.get(sidePath)).moveJournal); gate.resolve(); const result = await moving; assert.equal(result.moved, 1); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(target)).id, session.id);
});
integrationTest('Coffee Tables deletion waits for a safe archive and restores Markdown and hidden session state without overwrite', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  app.vault.delete = async file => { files.delete(file.path); contents.delete(file.path); }; app.vault.adapter.remove = async path => { files.delete(path); contents.delete(path); }; const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target), async file => app.vault.delete(file));
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 林岑｜主持人\n\n保留對談'; session.rounds = [{ id: 'r1', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }]; await store.save(session);
  const originalPath = store.sessionPath(session.id), trashRecord = await store.delete(session.id); assert.equal(app.vault.getAbstractFileByPath(originalPath), undefined); assert.equal((await store.deletedTables()).length, 1); await assert.rejects(store.save(session), /was deleted/);
  const restoredPath = await store.restoreDeleted(trashRecord); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(restoredPath)).id, session.id); assert.match(await app.vault.read(app.vault.getAbstractFileByPath(restoredPath)), /保留對談/); const restoredSession = await store.load(restoredPath); restoredSession.updatedAt = new Date().toISOString(); await store.save(restoredSession);
  const other = { ...coffeeSession(), topic: 'Collision test topic' }; await store.save(other); const record = await store.delete(other.id); const parsed = JSON.parse(contents.get(record)); await app.vault.create(parsed.originalPath, '# occupied'); const collisionPath = await store.restoreDeleted(record); assert.notEqual(collisionPath, parsed.originalPath); assert.match(collisionPath, /（2）\.md$/);
  const retainedSidecar = { ...coffeeSession(), id: 'coffee-delete-retained', topic: 'Retained sidecar topic' }; await store.save(retainedSidecar); const retainedPath = store.sessionPath(retainedSidecar.id); const remove = app.vault.adapter.remove; app.vault.adapter.remove = async path => { if (path === store.sidecarPath(retainedSidecar.id)) throw new Error('simulated sidecar cleanup failure'); return remove(path); }; const retainedRecord = await store.delete(retainedSidecar.id); assert.equal((await store.deletedTables()).some(item => item.path === retainedRecord), true); await app.vault.create(retainedPath, '# collision'); const retainedRestored = await store.restoreDeleted(retainedRecord); const reopenedRetained = await new CoffeeStorage(app.vault, 'Agent Workspace').load(retainedRestored); assert.equal(reopenedRetained.id, retainedSidecar.id); assert.equal(JSON.parse(contents.get(store.sidecarPath(retainedSidecar.id))).filePath, retainedRestored);
  const interrupted = { ...coffeeSession(), id: 'coffee-delete-interrupted', topic: 'Interrupted trash metadata' }; await store.save(interrupted); const process = app.vault.adapter.process; let failedOnce = false; app.vault.adapter.process = async (path, fn) => { if (!failedOnce && path.includes('/.sessions/trash/')) { failedOnce = true; throw new Error('simulated archive status interruption'); } return process(path, fn); }; const interruptedRecord = await store.delete(interrupted.id); app.vault.adapter.process = process; assert.equal(JSON.parse(contents.get(interruptedRecord)).trashed, false); assert.equal((await store.deletedTables()).some(item => item.path === interruptedRecord), true); const interruptedPath = await store.restoreDeleted(interruptedRecord); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(interruptedPath)).id, interrupted.id);
  const partial = { ...coffeeSession(), id: 'coffee-restore-interrupted', topic: 'Interrupted restore' }; await store.save(partial); const partialRecord = await store.delete(partial.id); const processRestore = app.vault.adapter.process; let restoreFailed = false; app.vault.adapter.process = async (path, fn) => { if (!restoreFailed && path === store.sidecarPath(partial.id)) { restoreFailed = true; throw new Error('simulated sidecar restore interruption'); } return processRestore(path, fn); }; await assert.rejects(store.restoreDeleted(partialRecord), /simulated sidecar restore interruption/); app.vault.adapter.process = processRestore; const journal = JSON.parse(contents.get(partialRecord)).restoreJournal; assert.ok(journal.targetPath); const partialRestored = await store.restoreDeleted(partialRecord); assert.equal(partialRestored, journal.targetPath); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(partialRestored)).id, partial.id);
});
integrationTest('Coffee Tables reports swallowed storage cleanup failures to the debug log and never restores a completed record twice', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  app.vault.delete = async file => { files.delete(file.path); contents.delete(file.path); }; app.vault.adapter.remove = async path => { files.delete(path); contents.delete(path); };
  const warnings = [], store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target), async file => app.vault.delete(file), message => warnings.push(message));
  const process = app.vault.adapter.process, remove = app.vault.adapter.remove;
  const statusLost = { ...coffeeSession(), id: 'coffee-warn-status', topic: 'Lost trash status' }; await store.save(statusLost);
  app.vault.adapter.process = async (path, fn) => { if (path.includes('/.sessions/trash/')) throw new Error('simulated trash status failure'); return process(path, fn); };
  const statusRecord = await store.delete(statusLost.id); app.vault.adapter.process = process;
  assert.ok(warnings.some(message => message.includes(statusRecord) && message.includes('simulated trash status failure')), warnings.join('\n'));
  const sidecarKept = { ...coffeeSession(), id: 'coffee-warn-sidecar', topic: 'Kept sidecar' }; await store.save(sidecarKept); const keptSidePath = store.sidecarPath(sidecarKept.id);
  app.vault.adapter.process = async (path, fn) => { if (path === keptSidePath) throw new Error('simulated sidecar removal failure'); return process(path, fn); };
  await store.delete(sidecarKept.id); app.vault.adapter.process = process;
  assert.ok(warnings.some(message => message.includes(keptSidePath) && message.includes('simulated sidecar removal failure')), warnings.join('\n'));
  const restored = { ...coffeeSession(), id: 'coffee-warn-restore', topic: 'Restore cleanup' }; await store.save(restored); const restoreRecord = await store.delete(restored.id);
  app.vault.adapter.remove = async path => { if (path === restoreRecord) throw new Error('simulated bundle removal failure'); return remove(path); };
  await store.restoreDeleted(restoreRecord); app.vault.adapter.remove = remove;
  assert.ok(warnings.some(message => message.includes(restoreRecord) && message.includes('simulated bundle removal failure')), warnings.join('\n'));
  assert.equal((await store.deletedTables()).some(item => item.path === restoreRecord), false);
  const markdownCount = [...files.keys()].filter(path => path.endsWith('.md')).length;
  await assert.rejects(store.restoreDeleted(restoreRecord), /already restored/); assert.equal([...files.keys()].filter(path => path.endsWith('.md')).length, markdownCount);
  const legacy = await app.vault.create(`${store.folder}/legacy-warn.md`, '# Legacy warning topic\n\nBody');
  const organizer = new CoffeeStorage(app.vault, 'Agent Workspace', async () => { throw new Error('simulated rename failure'); }, undefined, message => warnings.push(message));
  const organized = await organizer.organizeExisting(); assert.equal(organized.skipped, 1);
  assert.ok(warnings.some(message => message.includes(legacy.path) && message.includes('simulated rename failure')), warnings.join('\n'));
});
integrationTest('Coffee Tables delete archives the latest hidden state if it changes during the trash callback', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile); app.vault.adapter.remove = async path => { files.delete(path); contents.delete(path); };
  const session = coffeeSession(); session.status = 'completed'; const sidePath = `Agent Workspace/Coffee Tables/.sessions/${session.id}.json`; const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target), async file => { const side = JSON.parse(contents.get(sidePath)); side.updatedAt = '2026-09-30T12:00:00.000Z'; contents.set(sidePath, JSON.stringify(side, null, 2)); files.delete(file.path); contents.delete(file.path); }); await store.save(session);
  const recordPath = await store.delete(session.id), record = JSON.parse(contents.get(recordPath)); assert.equal(JSON.parse(record.sidecar).updatedAt, '2026-09-30T12:00:00.000Z'); assert.equal((await store.deletedTables()).length, 1);
});
integrationTest('Coffee Tables v2 migration backs up the source, writes clean Markdown and is idempotent', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const id = 'coffee-v2-recoverable', topic = '舊版桌聊主題', path = `Agent Workspace/Coffee Tables/${id}.md`, createdAt = '2026-09-29T00:00:00.000Z';
  await app.vault.createFolder('Agent Workspace'); await app.vault.createFolder('Agent Workspace/Coffee Tables');
  const legacy = { version: 2, id, topic, language: 'zh-TW', model: 'test-model', reasoning: 'low', createdAt, updatedAt: createdAt, status: 'completed', transcriptMarkdown: '', questions: [], guests: { perspectives: ['experts'], background: '客服' } };
  const source = `# ${topic}\n\n<!-- coffee-tables-data:${encodeURIComponent(JSON.stringify(legacy))} -->\n\n## 對談\n\n### 主持人｜林岑\n\n保留這段原始對談。\n\n<!-- coffee-tables-transcript-end:${id} -->\n\n<!-- coffee-tables-draft-start:${id} -->\n\n### 主持人｜續聊\n\n保留這段舊草稿。\n\n<!-- coffee-tables-draft-end:${id} -->`;
  const oldFile = await app.vault.create(path, source); const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, next) => app.fileManager.renameFile(file, next)); const migrated = await store.load(path);
  assert.equal(migrated.version, 3); assert.match(migrated.transcriptMarkdown, /保留這段原始對談/); assert.match(migrated.draftMarkdown, /保留這段舊草稿/); assert.equal(migrated.guests.counts.experts, 4);
  const backup = contents.get(`${store.hidden}/backups/${id}-v2.md`); assert.equal(backup, source); assert.doesNotMatch(contents.get(store.sessionPath(id)), /coffee-tables-data/);
  const again = await new CoffeeStorage(app.vault, 'Agent Workspace').load(store.sessionPath(id)); assert.equal(again.id, id); assert.equal(oldFile.path, store.sessionPath(id)); assert.notEqual(oldFile.path, path); assert.equal([...files.keys()].filter(item => item.endsWith(`${id}-v2.md`)).length, 1);
});
integrationTest('Coffee Tables engine survives view closure and reopening without starting a duplicate request', async () => {
  const pending = deferred(); let calls = 0, saved = [];
  const manager = new coffee.CoffeeManager(async request => { calls++; request.onText?.('Live draft'); return pending.promise; }, async value => { saved.push(plain(value)); });
  const session = coffeeSession(), firstViewEngine = manager.open(session), task = firstViewEngine.start(); await until(() => calls === 1 && firstViewEngine.session.draftMarkdown === 'Live draft');
  const reopenedViewEngine = manager.open(session); assert.equal(reopenedViewEngine, firstViewEngine); assert.equal(calls, 1);
  pending.resolve('### 主持人｜主持人\n\nComplete conversation\n\n# 觀察者整理\n\n## 最大討論轉折\n- A\n## 被推翻或修正的假設\n- B\n## 值得繼續追問的問題\n- C\n## 尚未解決的核心分歧\n- D'); await task; assert.equal(manager.open(firstViewEngine.session).session.status, 'completed'); assert.equal(calls, 1); assert.match(saved.at(-1).transcriptMarkdown, /Complete conversation/);
});
integrationTest('Coffee Tables puts saved-draft recovery in the pinned room toolbar', () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'error'; session.draftMarkdown = '### 主持人｜林岑\n\n已收到的對談。'; session.rounds = [{ id: 'failed-round', markdown: '', notes: '', draftMarkdown: session.draftMarkdown, status: 'error', createdAt: session.createdAt }];
  const plugin = { settings: { language: 'zh-TW' }, modelLabel: value => value, confirmAiUsage: async (_model, run) => run() };
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); view.engine = { session, busy: false, persistenceFailed: false, error: 'observer summary incomplete' }; view.store = { sessionPath: () => 'failed.md' }; view.contentEl = coffeeElement('root'); view.contentEl.ownerDocument = { activeElement: null }; view.contentEl.querySelector = () => null; view.contentEl.querySelectorAll = () => [];
  view.renderRound = () => {}; view.renderMarkdown = () => {}; view.renderRoster = () => {}; view.updateStatus = () => {};
  view.render();
  const fixed = view.contentEl.children[0].children[0];
  const header = fixed.children[0], actions = header.children[1];
  assert.equal(header.children[0].tag, 'h2');
  assert.equal(actions.tag, 'div');
  assert.deepEqual(actions.children.map(item => item.text), ['回主頁', '開啟 Markdown', '刪除桌聊', '開新桌']);
  assert.equal(header.children[2].tag, 'p');
  assert.ok(coffeeFind(fixed, item => item.tag === 'button' && item.text === '從已保存草稿繼續'));
});
integrationTest('Coffee Tables home form keeps discovered model and reasoning choices and disables start during discovery', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const plugin = withCoffeeModelDiscovery({ settings: { language: 'en', cliModel: 'm', cliReasoning: 'low' }, currentModelChoice: () => ({ model: 'm', reasoning: 'low' }), coffeeReasoningEfforts: model => model === 'm' ? ['low'] : ['medium', 'high'], refreshCoffeeModels: async () => ['m', 'codex-other'], confirmAiUsage: async (_model, run) => run() }, ['m', 'codex-other']);
  const view = new CoffeeTablesView({ app: {} }, plugin); view.contentEl = coffeeElement('root'); view.store = { cleanupEmptyTopicFolders: async () => {}, list: () => [] }; await view.home();
  const selects = []; const visit = node => { if (node.tag === 'select') selects.push(node); node.children.forEach(visit); }; visit(view.contentEl);
  await until(() => !selects[0].disabled); assert.deepEqual(selects[0].children.map(option => option.value), ['m', 'codex-other']);
  assert.deepEqual(selects[1].children.map(option => option.value), ['auto', 'low']);
  const summaries = []; const findSummaries = node => { if (node.tag === 'summary') summaries.push(node.text); node.children.forEach(findSummaries); }; findSummaries(view.contentEl); assert.ok(summaries.some(text => /Adjust this table · m · 2 hosts \+ 7 guests/.test(text)));
  selects[0].value = 'codex-other'; selects[0].change(); assert.deepEqual(selects[1].children.map(option => option.value), ['auto', 'medium', 'high']);
});
integrationTest('Coffee Tables explicit return home cannot be overridden by a delayed saved session state', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }); let loads = 0, saves = 0;
  const plugin = { ready: Promise.resolve(), settings: {}, coffeeStorage: {} };
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout: () => saves++ } } }, plugin); view.store = {}; view.home = async () => { view.engine = null; }; view.loadSession = async () => { loads++; };
  view.returnHome(); await view.setState({ sessionId: 'previous-session' }, { history: false });
  assert.equal(loads, 0); assert.equal(saves, 1);
  const restored = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); restored.store = {}; restored.loadSession = async () => { loads++; };
  await restored.setState({ sessionId: 'saved-session' }, { history: false }); assert.equal(loads, 1);
});
integrationTest('Coffee Tables stale external-conflict loads cannot override a newer room selection', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }), oldLoad = { promise: null, reject: null }, newLoad = deferred(), stopPending = deferred(); oldLoad.promise = new Promise((_resolve, reject) => { oldLoad.reject = reject; }); let stopCalled = false, attached = []; const session = { ...coffeeSession(), status: 'completed' };
  const cached = { busy: true, session, stop: async () => { stopCalled = true; await stopPending.promise; }, reportPersistenceError() {} }; const plugin = { coffeeManager: { get: () => cached } };
  const view = new CoffeeTablesView({ app: {} }, plugin); view.store = { load: path => path === 'old.md' ? oldLoad.promise : newLoad.promise, inspect: async () => session }; view.attach = value => attached.push(value.topic);
  const older = view.loadSession('old.md'); oldLoad.reject(new Error('changed outside the room')); await until(() => stopCalled); const newer = view.loadSession('new.md'); stopPending.resolve(); await older; assert.deepEqual(attached, []); newLoad.resolve(session); await newer; assert.deepEqual(attached, [session.topic]);
});
integrationTest('Coffee Tables historical preview cancels a pending generating-room navigation', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  let delayedRoom = deferred(); const completed = { ...coffeeSession(), id: 'done', topic: 'History topic', status: 'completed', transcriptMarkdown: '', rounds: [], observerNotes: [] };
  const generating = { ...coffeeSession(), id: 'running', topic: 'Running topic', status: 'generating', transcriptMarkdown: '', rounds: [], observerNotes: [] };
  const plugin = withCoffeeModelDiscovery({ settings: { language: 'en', cliModel: 'm', cliReasoning: 'low', workspaceFolder: 'workspace' }, currentModelChoice: () => ({ model: 'm', reasoning: 'low' }), coffeeReasoningEfforts: () => ['low'], refreshCoffeeModels: async () => ['m'], confirmAiUsage: async (_model, run) => run(), coffeeManager: { get: id => id === generating.id ? { busy: true, session: generating } : undefined } }, ['m']);
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); view.contentEl = coffeeElement('root');
  view.store = { cleanupEmptyTopicFolders: async () => {}, recoverPendingCreates: async () => {}, list: () => [{ path: 'running.md', extension: 'md', basename: 'Running topic', stat: { ctime: 1, mtime: 1 } }, { path: 'done.md', extension: 'md', basename: 'History topic', stat: { ctime: 1, mtime: 1 } }], inspectReadOnly: async path => path === 'done.md' ? completed : generating, load: () => delayedRoom.promise };
  const attached = []; view.attach = session => attached.push(session.id); await view.home();
  const findButton = text => coffeeFind(view.contentEl, element => element.tag === 'button' && (element.text.includes(text) || element.children.some(child => child.text.includes(text))));
  await until(() => findButton('Running topic')); const runningButton = findButton('Running topic'); assert.ok(runningButton); runningButton.click(); await Promise.resolve();
  const historyButton = findButton('History topic'); assert.ok(historyButton); historyButton.click(); await until(() => findButton('Enter this table'));
  delayedRoom.resolve(generating); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(attached, []);
  delayedRoom = deferred(); findButton('Enter this table').click(); await Promise.resolve(); findButton('Open new table').click(); delayedRoom.resolve(completed); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(attached, []);
});
integrationTest('Coffee Tables VAM handoff preserves insight snapshots and requires editable confirmation', async () => {
  const fixtureData = await reframingModalFixture(); const {modal,repo,store,contents,session,path,plugin} = fixtureData;
  const before = contents.get(path), sideBefore=contents.get(store.sidecarPath(session.id));
  assert.equal((await repo.mapFiles()).length,0);
  const question=coffeeFind(modal.contentEl,e=>e.attrs['aria-label']==='Research question'); question.value='Which evidence would distinguish access from affordability?';
  const create=coffeeFind(modal.contentEl,e=>e.text==='Create research map'); create.onclick(); create.onclick();
  await until(()=>fixtureData.opened.length===1);
  const map=await repo.readMap(fixtureData.opened[0]); assert.equal(map.nodes.length,1);
  const note=await repo.readNote(map.nodes[0].path); assert.match(note.detail,/Candidate/); assert.match(note.thinkingOrigin,/Important limits/); assert.match(note.thinkingOrigin,/coffee-tables/); assert.equal(note.model,session.model); assert.equal(plugin.running.size,0);
  assert.equal(contents.get(path),before);assert.equal(contents.get(store.sidecarPath(session.id)),sideBefore); assert.equal((await repo.mapFiles()).length,1);
});
integrationTest('Coffee Tables streaming restores scroll after asynchronous Markdown and preserves user scrolling', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'generating'; session.draftMarkdown = 'A growing dialogue';
  const view = new CoffeeTablesView({ app: {} }, { settings: { language: 'en' } });
  view.engine = { session }; view.renderRoster = () => {};
  const scrolling = { scrollTop: 400, scrollHeight: 1000, clientHeight: 300, isConnected: true };
  const draft = { style: {}, setCssProps() {}, addClass() { this.style.minHeight = "900px"; }, removeClass() { this.style.minHeight = ""; }, offsetHeight: 900, empty() { scrolling.scrollHeight = 500; } };
  view.contentEl = { querySelector: selector => selector === '.ct-chat-scroll' ? scrolling : selector === '.ct-live-draft' ? draft : null };
  let pending = deferred();
  view.renderRound = () => { view.markdownJobs.push(pending.promise.then(() => { scrolling.scrollHeight = 1200; })); };
  view.refreshLive();
  pending.resolve(); await until(() => draft.style.minHeight === '');
  assert.equal(scrolling.scrollTop, 400);
  scrolling.scrollTop = 900; pending = deferred(); view.refreshLive();
  scrolling.scrollTop = 650; view.scrollEpoch++; pending.resolve(); await until(() => draft.style.minHeight === '');
  assert.equal(scrolling.scrollTop, 650);
});
integrationTest('Coffee Tables accepts complete bold observer headings and prose with hidden source comments', async () => {
  const sections = ['意外連結', '值得繼續想的問題', '核心分歧', '探索方向', '值得查證的假設'];
  const notes = sections.map(title => `**## ${title}**\n\n共同規則有助於避免任意，但可能忽略處境差異，仍需要確認實際使用情況。<!-- source: 共同規則可能把差異藏起來。 -->`).join('\n\n');
  const response = `### 林予安｜主持人\n\n共同規則可能把差異藏起來。\n\n### 陳敬文｜中立觀察者\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  const engine = new coffee.CoffeeEngine(coffeeSession(), async () => response, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'completed');
  assert.doesNotMatch(engine.session.transcriptMarkdown, /核心分歧/);
  assert.match(engine.session.observerNotes[0], /^# 觀察者整理/);
  const { parseCoffeeOutline } = load('experiences/coffee-tables/outline.ts');
  const outline = parseCoffeeOutline(engine.session.observerNotes[0]);
  assert.equal(outline.length, 5);
  assert.equal(outline[0].items[0].sourceText, '共同規則可能把差異藏起來。');
  const stopped = coffeeSession(); stopped.status = 'stopped'; stopped.draftMarkdown = response;
  const reopened = new coffee.CoffeeEngine(stopped, async () => { assert.fail('Complete stopped draft must recover without AI'); }, async () => {});
  await reopened.start(); assert.equal(reopened.session.status, 'completed');
});
integrationTest('Coffee Tables token timestamps repaint live regions instead of rebuilding the reading pane', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const session = coffeeSession(); session.status = 'generating'; let renders = 0, live = 0;
  const view = new CoffeeTablesView({ app: {} }, { settings: {} }); view.engine = { session, busy: true, error: '' }; view.render = () => renders++; view.refreshLive = () => live++;
  view.refresh(); session.updatedAt = 'later-token'; view.refresh(); await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(live, 1); assert.equal(renders, 1);
});
integrationTest('Coffee Tables consecutive full repaints retain reading position until Markdown finishes', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'completed'; session.rounds = [{id:'r',markdown:'Saved dialogue',createdAt:session.createdAt}];
  const view = new CoffeeTablesView({ app: {} }, {settings:{language:'en'},modelLabel:x=>x}); view.engine = {session,busy:false}; view.store = {sessionPath:()=>''}; view.renderRoster=()=>{}; view.updateStatus=()=>{}; view.renderMarkdown=()=>{};
  let scrolling = {scrollTop:400,scrollHeight:1000,clientHeight:300}; const pending = deferred();
  const make = (tag, options={}) => { const el = coffeeElement(tag,options); const cls=typeof options==='string'?options:options.cls; el.isConnected=true;
    el.createDiv=value=>{const child=make('div',typeof value==='string'?{cls:value}:value);el.children.push(child);return child};
    if (cls==='ct-chat-scroll') { scrolling=el; el.scrollHeight=300;el.clientHeight=300;let top=0;Object.defineProperty(el,'scrollTop',{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,el.scrollHeight-el.clientHeight))}}); }
    if (cls==='ct-messages') { const owner=scrolling;el.setCssProps=props=>{owner.scrollHeight=parseFloat(props['--ct-live-held-height'])};el.removeClass=()=>{owner.scrollHeight=1200}; }
    return el;
  };
  view.contentEl=make('root');view.contentEl.ownerDocument={activeElement:null};view.contentEl.querySelector=selector=>selector==='.ct-chat-scroll'?scrolling:null;view.contentEl.querySelectorAll=()=>[];
  view.renderRound=()=>view.markdownJobs.push(pending.promise);
  view.render(); assert.equal(scrolling.scrollTop,400);view.render();assert.equal(scrolling.scrollTop,400);
  pending.resolve();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(scrolling.scrollTop,400);
  view.engine.busy=true; session.status='generating'; view.render(); let rebuilt=0; view.render=()=>rebuilt++; view.refreshLive=()=>{}; session.updatedAt='next-token';view.refresh();assert.equal(rebuilt,0);
});
integrationTest('Coffee Tables observer refresh keeps the previous latest notes when final saving fails', async () => {
  const session=coffeeSession();session.status='completed';session.observerNotes=['Previous latest notes'];
  const fresh='# 觀察者整理\n\n'+['意外連結','值得繼續想的問題','核心分歧','探索方向','值得查證的假設'].map(t=>'## '+t+'\n- A concrete observation.\n- A second observation.').join('\n\n');
  const engine=new coffee.CoffeeEngine(session,async request=>{request.onText?.(fresh);return fresh},async value=>{if(value.observerNotes[0].includes('A concrete observation.'))throw new Error('Final save failed')});
  await engine.refreshObserverNotes();assert.equal(engine.session.observerNotes[0],'Previous latest notes');assert.match(engine.session.observerDraftMarkdown,/A concrete observation\./);assert.match(engine.error,/Final save failed/);
});
integrationTest('Coffee segment summaries are saved with generation; retries retain round identity and missing summaries do not fail dialogue', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const session = coffeeSession(); let attempts = 0;
  const coffeeResponse = '### Host|Host\nA discussion.\n# Observer’s notes\n' + ['Unexpected connections','Questions worth pursuing','Core disagreements','Directions to explore','Assumptions to verify'].map(title => `## ${title}\n- A concrete observation from this dialogue.`).join('\n');
  const engine = new CoffeeEngine(session, async () => { if (++attempts === 1) throw new Error('offline'); return coffeeResponse + '\n<!-- coffee-segment-summary: {"summary":"A shift in the question."} -->'; }, async () => {});
  await engine.start(); const id = engine.session.rounds[0].id; assert.equal(engine.session.rounds[0].status, 'error');
  await engine.start(); assert.equal(engine.session.rounds.length,1); assert.equal(engine.session.rounds[0].id,id); assert.equal(engine.session.rounds[0].summary,'A shift in the question.'); assert.ok(!engine.session.transcriptMarkdown.includes('coffee-segment-summary'));
  const other = new CoffeeEngine(coffeeSession(), async () => coffeeResponse, async () => {}); await other.start(); assert.equal(other.session.status,'completed'); assert.equal(other.session.rounds[0].summary,undefined);
});
integrationTest('Coffee summary backfill makes one request, saves partial IDs only, and preserves dialogue and insights on failure or cancellation', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const session = coffeeSession(); session.status='completed'; session.rounds=[{id:'a',markdown:'Hello.',notes:'',status:'completed',createdAt:session.createdAt},{id:'b',markdown:'More.',notes:'',summary:'Existing.',status:'completed',createdAt:session.createdAt}]; session.questions=[{id:'q',question:'Why?',answer:'Reason.',status:'complete',createdAt:session.createdAt}]; session.observerNotes=['Keep these notes.']; let calls=0;
  const engine = new CoffeeEngine(session, async ({prompt}) => {calls++; assert.ok(prompt.includes('round:a')); assert.ok(!prompt.includes('round:b')); return '{"summaries":[{"id":"round:a","summary":"Opening turn."}]}';},async()=>{});
  await engine.fillSegmentSummaries(); assert.equal(calls,1); assert.equal(engine.session.rounds[0].summary,'Opening turn.'); assert.equal(engine.session.rounds[1].summary,'Existing.'); assert.equal(engine.session.questions[0].summary,undefined); assert.equal(engine.session.observerNotes[0],'Keep these notes.'); assert.ok(engine.error);
  const failed = new CoffeeEngine(session,async()=>'{broken',async()=>{}); await failed.fillSegmentSummaries(); assert.deepEqual(plain(failed.session),plain(session));
  const saveFailed = new CoffeeEngine(session,async()=>'{"summaries":[{"id":"round:a","summary":"Opening turn."}]}',async()=>{throw new Error('disk');}); await saveFailed.fillSegmentSummaries(); assert.equal(saveFailed.session.rounds[0].summary,undefined);
  let abort; const cancelled = new CoffeeEngine(session,({signal})=>new Promise(resolve=>{abort=()=>resolve('{"summaries":[{"id":"round:a","summary":"Never save."}]}'); signal.addEventListener('abort',abort);}),async()=>{}); const pending=cancelled.fillSegmentSummaries(); cancelled.cancel(); await pending; assert.equal(cancelled.session.rounds[0].summary,undefined);
});
integrationTest('Coffee navigation summary metadata round trips by identity without changing transcript or triggering stale insights', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f=>f instanceof TFile);
  const store=new CoffeeStorage(app.vault,'Agent Workspace'), session=coffeeSession(); session.status='completed'; session.rounds=[{id:'empty',markdown:'',notes:'',status:'error',createdAt:session.createdAt},{id:'spoken',markdown:'### A|Host\nSpeech.',notes:'',kind:'continuation',summary:'A concrete turn.',status:'completed',createdAt:session.createdAt}]; session.questions=[{id:'q',question:'Why?',answer:'Because.',status:'complete',summary:'The follow-up explores causes.',createdAt:session.createdAt}];
  await store.save(session); const reopened=await new CoffeeStorage(app.vault,'Agent Workspace').load(session.id); assert.equal(reopened.rounds.find(x=>x.id==='spoken').summary,'A concrete turn.'); assert.equal(reopened.rounds.find(x=>x.id==='spoken').kind,'continuation'); assert.equal(reopened.questions[0].summary,'The follow-up explores causes.'); assert.ok(!reopened.dirtyNotes); assert.equal(reopened.transcriptMarkdown,'### A|Host\nSpeech.');
  const file=store.sessionPath(session.id), raw=contents.get(file); const marker=/<!-- coffee-tables-navigation:([^\n]+) -->/.exec(raw); const metadata=JSON.parse(decodeURIComponent(marker[1])); metadata.find(x=>x.id==='round:spoken').summary='Edited summary.'; contents.set(file,raw.replace(marker[0],`<!-- coffee-tables-navigation:${encodeURIComponent(JSON.stringify(metadata))} -->`)); const edited=await new CoffeeStorage(app.vault,'Agent Workspace').load(session.id); assert.equal(edited.rounds.find(x=>x.id==='spoken').summary,'Edited summary.'); assert.ok(!edited.dirtyNotes);
});
integrationTest('Coffee insight filtering expands matching context without changing saved collapse preferences', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian}); const view=new CoffeeTablesView({app:{}},{settings:{language:'en'}}); view.engine={session:{id:'table',language:'en'}}; view.renderMarkdown=()=>{};
  const markdown='# Observer’s notes\n## Unexpected connections\n- Brief insight. <!-- coffee-insight:v1:id=item-a -->\n  - Context: A detailed bridge to trust.\n## Core disagreements\n- Other insight. <!-- coffee-insight:v1:id=item-b -->'; const target=coffeeElement('root'); view.renderInsightNotes(markdown,target);
  const input=coffeeFind(target,x=>x.tag==='input'); input.value='trust'; input.input(); assert.equal(coffeeFind(target,x=>x.tag==='input'),input);
  const state=view.insightStates.get('table'); state.collapsed.add('connections'); state.query='trust'; target.empty(); view.renderInsightNotes(markdown,target); const group=coffeeFind(target,x=>x.tag==='details' && x.dataset.insightCategory); assert.equal(group.open,true); assert.equal(coffeeFind(group,x=>x.dataset.insightId==='item-a').open,true); assert.equal(coffeeFind(target,x=>x.dataset.insightId==='item-b'),undefined); assert.equal(state.expanded.size,0); assert.ok(state.collapsed.has('connections'));
  state.query='';target.empty();view.renderInsightNotes(markdown,target); assert.equal(coffeeFind(target,x=>x.dataset.insightCategory==='connections').open,false); assert.equal(coffeeFind(target,x=>x.dataset.insightId==='item-a').open,false);
});
integrationTest('Coffee segment jump uses exact anchors and switches narrow layout to conversation', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian}); const view=new CoffeeTablesView({app:{}},{settings:{language:'en'}}); let scroll; const message={addClass(){},removeClass(){}}, segment={dataset:{coffeeSegment:'round:a'},getBoundingClientRect:()=>({top:300}),querySelector:()=>message},scroller={scrollTop:50,getBoundingClientRect:()=>({top:100}),scrollTo:value=>scroll=value},body={dataset:{pane:'insight'}};
  view.contentEl={querySelectorAll:()=>[segment],querySelector:q=>q==='.ct-chat-scroll'?scroller:q==='.ct-room-columns'?body:null}; assert.equal(view.locateSegment('round:a'),true); assert.equal(scroll.top,226); assert.equal(body.dataset.pane,'chat'); assert.equal(view.locateSegment('round:missing'),false);
});
integrationTest('Coffee legacy navigation stays read only and clears the previous room', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian:{...obsidian,MarkdownRenderer:{render:async()=>{}}}});
  const view=new CoffeeTablesView({app:{workspace:{}}},{settings:{language:'en'},isCoffeeOutlineSource:()=>true,refreshCoffeeOutline(){}});
  view.contentEl=coffeeElement('root'); view.button=()=>{}; view.store={sessionPath:()=> 'legacy.md'}; view.engine={session:{id:'previous'}};
  view.attachLegacy({version:1,id:'old',topic:'Old table',model:'model',createdAt:'2026-01-01',messages:[{speakerId:'host',text:'Old discussion'}],participants:[{id:'host',name:'Host',role:'Host'}],notes:null});
  assert.equal(view.engine,null); assert.equal(view.outlineSnapshot().sessionId,'old'); assert.equal(view.outlineSnapshot().segments[0].kind,'legacy'); assert.ok(coffeeFind(view.contentEl,x=>x.attrs['data-coffee-segment']==='legacy'));
});
integrationTest('Coffee summary-only save preserves exact historic insight Markdown', async () => {
 const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian}); const {app,files,contents}=fixture(); app.vault.getFiles=()=>[...files.values()].filter(f=>f instanceof TFile);
 const store=new CoffeeStorage(app.vault,'Agent Workspace'), session=coffeeSession(); session.rounds=[{id:'round-a',markdown:'### Host|Host\nOriginal dialogue.',notes:'',status:'completed',createdAt:session.createdAt}]; await store.save(session);
 const path=store.sessionPath(session.id), original=contents.get(path), historic=original.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->\n?/m,'').replace('## Observer notes','## Observer notes\n\n### Latest\n\nKeep this formatting.\n\n### History'); contents.set(path,historic);
 const fresh=new CoffeeStorage(app.vault,'Agent Workspace'); const loaded=await fresh.load(session.id); loaded.rounds[0].summary='The segment explored a concrete turn.'; await fresh.save(loaded,true); const saved=contents.get(path);
 assert.equal(saved.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->\n\n/m,''),historic); assert.equal((await fresh.load(session.id)).rounds[0].summary,loaded.rounds[0].summary);
});
integrationTest('Coffee summary metadata ignores reference markers and headings', async () => {
 const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian}); const {app,files,contents}=fixture(); app.vault.getFiles=()=>[...files.values()].filter(f=>f instanceof TFile); const store=new CoffeeStorage(app.vault,'Agent Workspace'),session=coffeeSession();
 session.rounds=[{id:'round-a',markdown:'### Host|Host\nReal conversation.',notes:'',status:'completed',createdAt:session.createdAt}]; session.guests={...(session.guests||{}),customPrompt:'',counts:{experts:1,'cross-domain':0,generalist:0,affected:0},referenceFiles:[{name:'reference.md',content:'```\n<!-- coffee-tables-navigation:%5B%5D -->\n\n## Conversation\nQuoted reference headings.'}]};
 await store.save(session); const encoded=contents.get(store.sessionPath(session.id)); const before=encoded.replace('````text','```text').replace(/\n````\n/g,'\n```\n'); contents.set(store.sessionPath(session.id),before); const fresh=new CoffeeStorage(app.vault,'Agent Workspace'); const loaded=await fresh.load(session.id); assert.equal(loaded.rounds[0].markdown,session.rounds[0].markdown); loaded.rounds[0].summary='A genuine navigation summary.'; await fresh.save(loaded,true); const after=contents.get(store.sessionPath(session.id)); assert.ok(after.includes(session.guests.referenceFiles[0].content)); assert.equal(after.match(/coffee-tables-navigation:/g).length,2); assert.equal((await fresh.load(session.id)).rounds[0].summary,loaded.rounds[0].summary); assert.equal(before.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->$/gm,''),after.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->$/gm,''));
});
// Owner decision 2026-10-19: "Preview convergence once" hides its window once AI starts; completion is a Notice with a
// Review button, never an automatic window.
function customizationHarness({ confirm = async (_work) => {} } = {}) {
  const dom = require('../support-dom.cjs'), notices = [], Notice = dom.makeNotice(notices), modals = [];
  class Modal { constructor() { this.contentEl = coffeeElement('content'); this.modalEl = coffeeElement('modal'); this.closeCount = 0; } open() { modals.push(this); this.onOpen?.(); } close() { this.closeCount++; this.onClose?.(); } }
  const ui = load('experiences/coffee-tables/customization-ui.ts', { obsidian: { ...obsidian, Modal, Notice } }, { createFragment: dom.createFragment });
  const gate = deferred(), session = { language: 'en', model: 'test-model', guests: {} };
  const engine = { session, started: 0, setCustomization: async () => {}, previewConvergence: async () => { engine.started++; await gate.promise; session.convergenceDraft = { proposals: [] }; } };
  const reviewed = [];
  const modal = new ui.CoffeeCustomizationModal({}, engine, async () => {}, () => reviewed.push(1), work => confirm(work));
  modal.open();
  const previewButton = coffeeFind(modal.contentEl, e => e.text === 'Preview convergence once');
  return { ui, modal, engine, gate, reviewed, notices, Notice, previewButton };
}
integrationTest('Preview convergence once: the window closes before AI runs; completion after closing gives a Notice and never opens the review', async () => {
  const h = customizationHarness({ confirm: async work => { await work(); } });
  h.previewButton.onclick(); await until(() => h.engine.started === 1);
  assert.equal(h.modal.closeCount, 1);
  h.gate.resolve(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  // The bug: completion used to call close() and reviewed() again after the user had closed the window.
  assert.equal(h.modal.closeCount, 1); assert.equal(h.reviewed.length, 0);
  assert.equal(h.Notice.all.length, 1); assert.deepEqual(h.Notice.all[0].actions.map(b => b.text), ['Review']);
  h.Notice.all[0].actions[0].click(); assert.equal(h.reviewed.length, 1); assert.equal(h.Notice.all[0].hidden, true);
});
integrationTest('Preview convergence once: closing during the usage notice starts nothing, a declined notice keeps the window open', async () => {
  const usage = deferred();
  const early = customizationHarness({ confirm: async work => { if (await usage.promise) await work(); } });
  early.previewButton.onclick(); await Promise.resolve(); early.modal.close(); usage.resolve(true);
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(early.engine.started, 0); assert.equal(early.Notice.all.length, 0); assert.equal(early.reviewed.length, 0);
  const declined = customizationHarness({ confirm: async () => {} });
  declined.previewButton.onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(declined.modal.closeCount, 0); assert.equal(declined.engine.started, 0); assert.equal(declined.Notice.all.length, 0);
});
integrationTest('Convergence preview Notice (also used by the Coffee view button) appears only for a new preview and never opens the review itself', async () => {
  const { ui, Notice } = customizationHarness();
  const engine = { session: { language: 'en', convergenceDraft: { proposals: [] } } }, reviews = [];
  const marks = ui.convergencePreviewMarks(engine);
  ui.notifyConvergencePreview(engine, marks, () => reviews.push(1)); // a stopped or failed run leaves the old preview
  assert.equal(Notice.all.length, 0);
  engine.session.convergenceDraft = { proposals: [] }; // a new preview
  ui.notifyConvergencePreview(engine, marks, () => reviews.push(1));
  assert.equal(Notice.all.length, 1); assert.equal(reviews.length, 0);
  Notice.all[0].actions[0].click(); assert.equal(reviews.length, 1);
});

// MS-07 P7a (plan D7): a new table starts from the current model and reasoning; the summary confirmation shows the model's label.
const homeSelects = async plugin => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const view = new CoffeeTablesView({ app: {} }, plugin); view.contentEl = coffeeElement('root'); view.store = { cleanupEmptyTopicFolders: async () => {}, list: () => [] }; await view.home();
  const selects = []; const visit = node => { if (node.tag === 'select') selects.push(node); node.children.forEach(visit); }; visit(view.contentEl);
  await until(() => !selects[0].disabled); return { view, selects };
};
integrationTest('Coffee Tables new table defaults to the current model and reasoning, not the stale settings or a previous table', async () => {
  let current = { model: 'cur', reasoning: 'medium' };
  const plugin = withCoffeeModelDiscovery({ settings: { language: 'en', cliModel: 'old', cliReasoning: 'low' }, currentModelChoice: () => current, coffeeReasoningEfforts: () => ['low', 'medium', 'high'], refreshCoffeeModels: async () => ['old', 'cur', 'opus'], confirmAiUsage: async (_model, run) => run() }, ['old', 'cur', 'opus']);
  const first = await homeSelects(plugin); assert.equal(first.selects[0].value, 'cur'); assert.equal(first.selects[1].value, 'medium');
  first.view.homeForm = { model: 'opus', reasoning: 'high' }; first.view.homeForm = {};
  const second = await homeSelects(plugin); assert.equal(second.selects[0].value, 'cur', 'a previous table with opus does not carry over');
  current = { model: 'old', reasoning: 'low' };
  const third = await homeSelects(plugin); assert.equal(third.selects[0].value, 'old'); assert.equal(third.selects[1].value, 'low');
});
integrationTest('Coffee Tables home form does not freeze the current model: only a model that differs from the current one is remembered', async () => {
  let current = { model: 'cur', reasoning: 'medium' };
  const plugin = withCoffeeModelDiscovery({ settings: { language: 'en', cliModel: 'cur', cliReasoning: 'medium' }, currentModelChoice: () => current, coffeeReasoningEfforts: () => ['low', 'medium', 'high'], refreshCoffeeModels: async () => ['cur', 'next', 'opus'], confirmAiUsage: async (_model, run) => run() }, ['cur', 'next', 'opus']);
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const view = new CoffeeTablesView({ app: {} }, plugin); view.contentEl = coffeeElement('root'); view.store = { cleanupEmptyTopicFolders: async () => {}, list: () => [] };
  const render = async () => { view.contentEl = coffeeElement('root'); await view.home(); const selects = []; const visit = node => { if (node.tag === 'select') selects.push(node); node.children.forEach(visit); }; visit(view.contentEl); await until(() => !selects[0].disabled); return selects; };
  let selects = await render(); const topic = coffeeFind(view.contentEl, e => e.tag === 'textarea' || e.tag === 'input'); topic.input?.();
  current = { model: 'next', reasoning: 'medium' };
  selects = await render(); assert.equal(selects[0].value, 'next', 'untouched form follows the new current model');
  selects[0].value = 'opus'; selects[0].change(); selects[1].change();
  selects = await render(); assert.equal(selects[0].value, 'opus', 'a hand-picked different model is kept when the form is rebuilt');
});
integrationTest('Coffee Tables summary confirmation shows the model label, not the raw id', async () => {
  const modals = []; class Modal { constructor() { this.contentEl = coffeeElement('content'); } open() { modals.push(this); this.onOpen?.(); } close() { this.onClose?.(); } }
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian: { ...obsidian, Modal } });
  const plugin = { settings: { language: 'en' }, modelLabel: id => `Label of ${id}`, confirmAiUsage: async (_m, run) => run() };
  const view = new CoffeeTablesView({ app: {} }, plugin); view.engine = { busy: false, session: { model: 'raw-id' }, fillSegmentSummaries: async () => {} };
  const pending = view.confirmFillSummaries(); const text = []; const visit = node => { text.push(node.text); node.children.forEach(visit); }; visit(modals[0].contentEl);
  assert.ok(text.some(value => value.includes('Label of raw-id')), text.join('|')); assert.equal(text.some(value => value.includes('raw-id') && !value.includes('Label of raw-id')), false);
  modals[0].close(); await pending;
});
