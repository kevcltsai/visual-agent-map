const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, plain, obsidian, coffeeTypes, coffee, coffeePrompts, coffeeInsights, coffeeGuestInvitations, coffeeCustomization, coffeeConvergence, coffeeSession, coffeeTableList, coffeeTopics } = require('../support.cjs');
test('Coffee insight migration retains distinct older notes and creates stable IDs', () => {
  const oldest = '# 觀察者整理\n\n## 核心分歧\n- 規則一致能增加可預期性，但無法消除起點差異。<!-- source: 規則要一樣 -->\n';
  const latest = '# 觀察者整理\n\n## 核心分歧\n- 規則一致能增加可預期性，但無法消除起點差異。\n- 申請門檻可能先排除最需要協助的人。\n';
  const baseline = coffeeInsights.baselineFromVersions([latest, oldest], 'zh-TW');
  assert.equal(baseline.length, 2);
  assert.equal(new Set(baseline.map(item => item.id)).size, 2);
  assert.equal(baseline[0].sources[0], '規則要一樣');
});
test('Coffee insight merge updates IDs, explicitly folds aliases, and keeps omitted insights', () => {
  const current = coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 舊觀點 A。\n- 舊觀點 B。\n'], 'zh-TW');
  const [a,b] = current;
  const update = `# 觀察者整理\n\n## 疑問與可能解方\n- 疑問的可能解方仍受資源限制。<!-- coffee-insight:merge:${a.id},${b.id} -->\n  疑問：需要支援但流程很長。\n  可能解方：提供簡化申請。\n  條件與限制：簡化流程仍需足夠人力。\n`;
  const merged = coffeeInsights.mergeInsightUpdates(current, update, 'zh-TW');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, a.id);
  assert.deepEqual(plain(merged[0].mergedIds), [b.id]);
  assert.match(merged[0].proposedSolution, /簡化申請/);
  assert.match(merged[0].detail, /舊觀點 B/);
  const roundTrip = coffeeInsights.parseInsightNotes(coffeeInsights.serializeInsightNotes(merged, 'zh-TW'), 'zh-TW');
  assert.equal(roundTrip[0].id, a.id);
  assert.deepEqual(plain(roundTrip[0].mergedIds), [b.id]);
});
test('Coffee insight update preserves the explicit ID through summary changes and reopen', () => {
  const original = coffeeInsights.serializeInsightNotes(coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 規則一致可能掩蓋不同起點。\n'], 'zh-TW'), 'zh-TW');
  const before = coffeeInsights.parseInsightNotes(original, 'zh-TW')[0];
  const generated = `# 觀察者整理\n\n## 核心分歧\n- 統一規則提升可預期性，卻可能讓起點差異更難被看見。<!-- coffee-insight:update:${before.id} -->\n  - 脈絡：來賓補充資源配置條件會改變規則效果。\n`;
  const revised = coffeeInsights.mergeInsightUpdates([before], generated, 'zh-TW');
  assert.equal(revised[0].id, before.id);
  const reopened = coffeeInsights.baselineFromVersions([coffeeInsights.serializeInsightNotes(revised, 'zh-TW')], 'zh-TW');
  assert.equal(reopened[0].id, before.id);
  assert.match(reopened[0].summary, /統一規則提升可預期性/);
});
test('Coffee insight duplicate consolidation retains persisted merge aliases', () => {
  const versions = [
    '# 觀察者整理\n\n## 核心分歧\n- 同一核心觀點。<!-- coffee-insight:v1:id=primary;merged=older-alias -->\n',
    '# 觀察者整理\n\n## 核心分歧\n- 同一核心觀點。<!-- coffee-insight:v1:id=duplicate;merged=another-alias -->\n',
  ];
  const merged = coffeeInsights.baselineFromVersions(versions, 'zh-TW');
  assert.equal(merged.length, 1);
  assert.deepEqual(plain(merged[0].mergedIds), ['older-alias', 'duplicate', 'another-alias']);
  const reopened = coffeeInsights.parseInsightNotes(coffeeInsights.serializeInsightNotes(merged, 'zh-TW'), 'zh-TW');
  assert.deepEqual(plain(reopened[0].mergedIds), ['older-alias', 'duplicate', 'another-alias']);
});
test('Coffee insight update rejects unknown targets without modifying baseline', () => {
  const current = coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 保留舊內容。\n'], 'zh-TW');
  assert.throws(() => coffeeInsights.mergeInsightUpdates(current, '# 觀察者整理\n\n## 核心分歧\n- 新內容。<!-- coffee-insight:update:missing-id -->\n', 'zh-TW'), /unknown|不存在/i);
  assert.match(coffeeInsights.serializeInsightNotes(current, 'zh-TW'), /保留舊內容/);
});
test('Coffee invitation validation accepts a new guest and caps cumulative room size', () => {
  const types = load('experiences/coffee-tables/types.ts');
  const counts = { experts: 4, 'cross-domain': 1, generalist: 1, affected: 1 };
  const invites = (length, category = 'experts') => Array.from({ length }, (_, index) => ({ id: `new-${index}`, name: `新來賓${index}`, category, description: '帶來不同處境的觀點' }));
  assert.equal(coffeeGuestInvitations.validateGuestInvitations(invites(1), counts, []), null);
  assert.match(coffeeGuestInvitations.validateGuestInvitations(invites(6), counts, []), /12 位/);
  assert.match(coffeeGuestInvitations.validateGuestInvitations([{ ...invites(1)[0], name: '既有來賓' }], counts, [], undefined, ['既有來賓']), /已在這桌/);
  const completed = { id: 'asked-before', question: 'q', answer: 'a', status: 'complete', invitedGuests: invites(1, 'affected') };
  assert.equal(coffeeGuestInvitations.validateGuestInvitations(invites(4).map((guest, index) => ({ ...guest, id: `later-${index}`, name: `後續來賓${index}` })), counts, [completed]), null);
  assert.ok(types.parseSession(JSON.stringify({ ...types.createSession('題目', 'm', 'low', 'zh-TW'), status: 'completed', questions: [{ ...completed, createdAt: new Date().toISOString() }] })).questions[0].invitedGuests);
});
test('Coffee Tables every prompt mode carries cumulative update operations and the solutions category', () => {
  const session = coffeeTypes.createSession('整桌題目', 'm', 'low', 'zh-TW');
  session.status = 'completed';
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 最新整桌洞見。', '# 觀察者整理\n\n## 意外連結\n- 更早保存的跨域連結。'];
  const prompts = [coffeePrompts.tablePrompt(session.topic, session.language, session.guests), coffeePrompts.tablePrompt(session.topic, session.language, session.guests, '草稿'), coffeePrompts.questionPrompt(session, '新追問'), coffeePrompts.observerOnlyPrompt(session)];
  for (const prompt of prompts) {
    assert.match(prompt, /疑問與可能解方/);
    assert.match(prompt, /coffee-insight:(?:keep|update|merge):/);
    assert.match(prompt, /coffee-insight:new/);
    assert.match(prompt, /沒有重新輸出的舊項目會由程式保留|the program retains old items you do not rewrite/i);
  }
  const refresh = coffeePrompts.observerOnlyPrompt(session);
  assert.match(refresh, /更早保存的跨域連結/);
});
test('Coffee customization preserves saved text, validates reserved markers, and keeps editable style focused', () => {
  const defaults = coffeeCustomization.defaultCustomization('zh-TW');
  const saved = { ...defaults, observerPrompt: '不要刪除來源；這是一般整理偏好。' };
  assert.equal(coffeeCustomization.normalizeCustomization(saved, 'zh-TW').observerPrompt, saved.observerPrompt);
  assert.deepEqual(plain(coffeeCustomization.validateCustomization(saved, 'zh-TW')), []);
  assert.match(coffeeCustomization.validateCustomization({ ...saved, observerPrompt: 'x'.repeat(12001) }, 'zh-TW')[0], /12,000/);
  assert.match(coffeeCustomization.validateCustomization({ ...saved, observerPrompt: '保留 <!-- coffee-insight:keep:x -->' }, 'zh-TW')[0], /保留的內部標記/);
  const clean = coffeePrompts.cleanChatStyle(coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT);
  assert.match(clean, /自然、口語/); assert.doesNotMatch(clean, /觀察者整理|coffee-insight|stable program IDs/);
  const custom = { ...coffeeTypes.createSession('題目', 'm', 'low', 'zh-TW').guests, customization: saved };
  const preview = coffeePrompts.openingPromptPreview('題目', 'zh-TW', custom);
  assert.match(preview, /不要刪除來源/); assert.doesNotMatch(preview, /coffee-insight:(?:keep|update|merge):/);
});
test('Coffee convergence accounts for each baseline once and applies partial proposals with safe undo', async () => {
  const notes = '# 觀察者整理\n\n## 核心分歧\n- 洞見 A，保留來源脈絡。<!-- coffee-insight:v1:id=insight-a -->\n- 洞見 B，保留條件脈絡。<!-- coffee-insight:v1:id=insight-b -->\n\n## 值得繼續想的問題\n- 洞見 C，仍有一個待答問題。<!-- coffee-insight:v1:id=insight-c -->';
  const baseline = coffeeInsights.baselineFromVersions([notes], 'zh-TW');
  const proposals = [
    { sourceIds: ['insight-a', 'insight-b'], summary: '合併兩個洞見。', detail: '保留不同理由。', category: 'disagreements' },
    { sourceIds: ['insight-c'], summary: '保留問題。', detail: '問題仍未解。', category: 'questions' },
  ];
  const raw = JSON.stringify({ proposals });
  assert.equal(coffeeCustomization.parseConvergenceProposals(raw, baseline.map(item => item.id)).length, 2);
  assert.throws(() => coffeeCustomization.parseConvergenceProposals(JSON.stringify({ proposals: [proposals[0]] }), baseline.map(item => item.id)), /every baseline|每個|exactly once/i);
  const session = coffeeSession(); session.status = 'completed'; session.observerNotes = [notes];
  const fingerprint = coffeeConvergence.convergenceFingerprint(session);
  session.convergenceDraft = { baseFingerprint: fingerprint, proposals, raw, createdAt: session.createdAt, customization: coffeeCustomization.defaultCustomization(session.language) };
  const engine = new coffee.CoffeeEngine(session, async () => assert.fail('Convergence apply must not call a provider'), async () => {});
  await assert.rejects(engine.applyConvergence([0, 1], { 0: { summary: '## injected heading', detail: 'invalid' } }), /單行|標題|heading|metadata/i);
  await engine.applyConvergence([0]);
  const applied = coffeeInsights.baselineFromVersions(engine.session.observerNotes, 'zh-TW');
  assert.deepEqual(plain(applied.map(item => item.id).sort()), ['insight-a', 'insight-c']);
  assert.match(applied.find(item => item.id === 'insight-a').summary, /合併兩個洞見/); assert.deepEqual(plain(applied.find(item => item.id === 'insight-a').sources), []);
  await engine.undoConvergence(); assert.deepEqual(plain(engine.session.observerNotes), [notes]);
  const staleSession = coffeeSession(); staleSession.status = 'completed'; staleSession.observerNotes = [notes];
  staleSession.convergenceDraft = { baseFingerprint: coffeeConvergence.convergenceFingerprint(staleSession), proposals, raw, createdAt: staleSession.createdAt, customization: coffeeCustomization.defaultCustomization(staleSession.language) };
  const staleEngine = new coffee.CoffeeEngine(staleSession, async () => assert.fail('A stale preview must not call a provider'), async () => {});
  staleEngine.session.transcriptMarkdown = 'New dialogue invalidates a saved preview';
  await assert.rejects(staleEngine.applyConvergence([0]), /changed|refresh|已更新|重新整理/);
  assert.deepEqual(plain(staleEngine.session.observerNotes), [notes]); assert.ok(staleEngine.session.convergenceDraft);
});
test('Coffee convergence keeps pinned items isolated during proposals and protects sample sessions', async () => {
  const notes = '# 觀察者整理\n\n## 核心分歧\n- 釘選洞見 A。<!-- coffee-insight:v1:id=pinned-a -->\n- 洞見 B。<!-- coffee-insight:v1:id=insight-b -->';
  const baseline = coffeeInsights.baselineFromVersions([notes], 'zh-TW');
  assert.throws(() => coffeeConvergence.enforcePinnedProposals([{ sourceIds: ['pinned-a', 'insight-b'], summary: '合併', detail: '', category: 'disagreements' }], baseline, ['pinned-a']), /Pinned|釘選/);
  const session = coffeeSession(); session.id = 'sample-zh'; session.status = 'completed'; session.observerNotes = [notes]; session.pinnedInsightIds = ['pinned-a'];
  let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => { calls++; });
  await assert.rejects(engine.togglePinnedInsight('pinned-a'), /read-only|只能閱讀/); await engine.previewConvergence(); await engine.continueTable();
  assert.deepEqual(plain(engine.session.pinnedInsightIds), ['pinned-a']);
  assert.equal(calls, 0);
});
test('Coffee observer refresh preserves every baseline insight in a generated merge that touches a pin', async () => {
  const notes = '# 觀察者整理\n\n## 核心分歧\n- 釘選洞見 A 有它自己的理由與條件。<!-- coffee-insight:v1:id=pinned-a -->\n- 洞見 B 有不同理由與適用情境。<!-- coffee-insight:v1:id=insight-b -->';
  const baseline = coffeeInsights.baselineFromVersions([notes], 'zh-TW');
  const generated = '# 觀察者整理\n\n## 意外連結\n\n- 這是一個具體的意外連結並且有完整脈絡。\n\n## 值得繼續想的問題\n\n- 這個問題仍需要進一步討論並確認更多情境。\n\n## 核心分歧\n\n- 合併後的新寫法，忽略 pinned note。<!-- coffee-insight:merge:pinned-a,insight-b -->\n\n## 探索方向\n\n- 下一步可以在不同服務情境中觀察成果。\n\n## 值得查證的假設\n\n- 仍要確認這個假設是否符合當事人的經驗。';
  const session = coffeeSession(); session.status = 'completed'; session.observerNotes = [notes]; session.pinnedInsightIds = ['pinned-a'];
  const engine = new coffee.CoffeeEngine(session, async () => generated, async () => {});
  await engine.refreshObserverNotes();
  const after = coffeeInsights.baselineFromVersions(engine.session.observerNotes, 'zh-TW');
  assert.deepEqual(plain(after.filter(item => ['pinned-a', 'insight-b'].includes(item.id)).map(item => [item.id, item.summary]).sort()), [['insight-b', '洞見 B 有不同理由與適用情境。'], ['pinned-a', '釘選洞見 A 有它自己的理由與條件。']]);
});
test('Coffee follow-up prompts name invited guests and retain them in later table continuations', () => {
  const session = coffeeTypes.createSession('整桌題目', 'm', 'low', 'zh-TW');
  const invite = { id: 'guest-invite-1', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' };
  const followUp = coffeePrompts.questionPrompt(session, '夜班怎麼找支援', '', [invite]);
  assert.match(followUp, /林照[｜|]受影響者：熟悉夜班與照護資源的社工/);
  session.questions.push({ id: 'q-1', createdAt: session.createdAt, question: '已完成的追問', answer: '林照談到夜班資源。', status: 'complete', invitedGuests: [invite] });
  assert.match(coffeePrompts.tablePrompt(session.topic, session.language, session.guests, '', coffeePrompts.assembleCoffeeContext(session)), /林照[｜|]受影響者：熟悉夜班與照護資源的社工/);
});
integrationTest('Coffee Tables keeps an invited guest through failed retry and later continuation', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 周沐｜主持人\n\n先談如何求援。'; session.rounds = [{ id: 'prior-round', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  const invitation = { id: 'invite-care-worker', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' }; let fail = true, prompts = [];
  const notes = '# 觀察者整理\n\n' + ['意外連結','值得繼續想的問題','核心分歧','探索方向','值得查證的假設'].map((title,index)=>`## ${title}\n- 具體洞見 ${index + 1}，脈絡完整且仍待對談推進。`).join('\n\n');
  const engine = new coffee.CoffeeEngine(session, async request => { prompts.push(request.prompt); if (fail) throw new Error('retry this invite'); if (prompts.length === 2) return `### 林照｜受影響者\n\n夜班同仁要有可直接使用的求援窗口。\n\n${notes}`; return `### 周沐｜主持人\n\n${prompts.length === 3 ? '林照提出的窗口需要接上正式交接流程。' : '正式交接流程應列明跨班支援窗口。'}\n\n${notes}`; }, async () => {});
  await engine.ask('夜班如何找到即時支援？', 'followup-care', [invitation]); assert.equal(engine.session.questions[0].status, 'error'); assert.equal(JSON.stringify(engine.session.questions[0].invitedGuests), JSON.stringify([invitation]));
  fail = false; await engine.ask('夜班如何找到即時支援？', 'followup-care'); assert.equal(engine.session.questions.length, 1); assert.match(prompts[1], /林照[｜|].*熟悉夜班與照護資源的社工/); assert.equal(engine.session.questions[0].status, 'complete');
  await engine.continueTable(); assert.match(prompts[2], /林照[｜|].*熟悉夜班與照護資源的社工/); assert.match(prompts[2], /求援窗口/); await engine.continueTable(); assert.match(prompts[3], /正式交接流程/); assert.equal(engine.session.observerNotes.length, 1);
});
test('Coffee Tables inspiration topics are bilingual, deterministic in tests and avoid immediate repeats', () => {
  assert.equal(coffeeTopics.COFFEE_TOPICS.length, 20);
  assert.ok(coffeeTopics.COFFEE_TOPICS.every(item => item.zh.length > 8 && item.en.length > 8));
  assert.equal(new Set(coffeeTopics.COFFEE_TOPICS.map(item => item.id)).size, 20);
  assert.equal(coffeeTopics.coffeeTopicText('school-lunch', 'en'), coffeeTopics.COFFEE_TOPICS[6].en);
  assert.equal(coffeeTopics.coffeeTopicText('school-lunch', 'zh-TW'), coffeeTopics.COFFEE_TOPICS[6].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('zh-TW', '', () => 0), coffeeTopics.COFFEE_TOPICS[0].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('zh-TW', coffeeTopics.COFFEE_TOPICS[0].zh, () => 0), coffeeTopics.COFFEE_TOPICS[1].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('en', '', () => 0), coffeeTopics.COFFEE_TOPICS[0].en);
});
test('Coffee Tables roster shows configured role placeholders and replaces introduced guests as text arrives', () => {
  const { rosterFor, liveRosterFor } = load('experiences/coffee-tables/view.ts', { obsidian }); const session = coffeeSession();
  const roster = rosterFor(session, '- **林岑｜主持人**：擅長追問。\n- **許雯｜主題專家**：研究勞動。');
  assert.equal(roster.length, 10); assert.deepEqual(Array.from(roster.slice(0, 2), person => person.name), ['林岑', '許雯']);
  assert.equal(roster.filter(person => person.role === '即將登場').length, 8);
  session.rounds = [{ id: 'round-1', markdown: '- **林岑｜主持人**：擅長追問。\n- **許雯｜主題專家**：研究勞動。', notes: '', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' }];
  const whileContinuing = liveRosterFor(session, '- **柏翰｜主題專家**：研究組織行為。\n\n### 柏翰｜主題專家\n接續發言。');
  assert.deepEqual(Array.from(whileContinuing.slice(0, 2), person => person.name), ['林岑', '許雯']);
  assert.equal(whileContinuing.find(person => person.name === '柏翰')?.role, '主題專家');
  assert.equal(whileContinuing.length, 10);
});
test('Coffee Tables recent-first list filters states, searches exact topics and sorts by meaningful activity', () => {
  const now = Date.parse('2026-09-30T00:00:00.000Z'), item = (id, topic, status, updatedAt, extra = {}) => ({ id, path: `${id}.md`, topic, status, createdAt: '2026-09-01T00:00:00.000Z', updatedAt, model: 'm', ...extra });
  const entries = [item('older','Shared','completed','2026-09-29T23:00:00.000Z',{lastCompletedAt:'2026-09-02T00:00:00.000Z'}), item('running','Shared','generating','2026-09-20T00:00:00.000Z',{lastGenerationStartedAt:'2026-09-29T23:30:00.000Z'}), item('draft','unfinished','error','2026-09-28T00:00:00.000Z'), item('recent','recent','completed','2026-09-10T00:00:00.000Z',{lastCompletedAt:'2026-09-29T23:45:00.000Z'}), item('past','past','completed','2026-09-29T00:00:00.000Z',{lastCompletedAt:'2026-09-22T00:00:00.000Z'})];
  assert.deepEqual(coffeeTableList.selectTables(entries).map(row => row.id), ['recent','running','draft','past','older']);
  assert.deepEqual(coffeeTableList.selectTables(entries, 'SHARED').map(row => row.id), ['running','older']);
  assert.deepEqual(coffeeTableList.selectTables(entries, '', 'unfinished').map(row => row.id), ['draft']);
  assert.deepEqual(coffeeTableList.selectTables(entries, '', 'completed', ' Shared ').map(row => row.id), ['older']);
  assert.equal(coffeeTableList.topicTableCount('Shared', entries), 2); assert.equal(coffeeTableList.topicTableCount('shared', entries), 0);
  assert.equal(coffeeTableList.tableTime(entries[2]).isFallback, true); assert.equal(coffeeTableList.tableTime(entries[1]).value, Date.parse('2026-09-29T23:30:00.000Z'));
  assert.equal(coffeeTableList.effectiveTableStatus({ status: 'completed', questions: [{ status: 'pending' }], rounds: [] }, true), 'generating'); assert.equal(coffeeTableList.effectiveTableStatus({ status: 'completed', questions: [{ status: 'error' }], rounds: [] }), 'error'); assert.equal(coffeeTableList.effectiveTableStatus({ status: 'generating', questions: [], rounds: [] }), 'error'); assert.deepEqual(coffeeTableList.selectTables([], '').map(row => row.id), []);
});
test('Coffee Tables list timestamps stay compact while retaining clear day and year context', () => {
  const now = new Date(2026, 8, 30, 16, 0).getTime();
  assert.match(coffeeTableList.formatTableTime(new Date(2026, 8, 30, 14, 30).getTime(), now, 'zh-TW'), /^今天/);
  assert.match(coffeeTableList.formatTableTime(new Date(2026, 8, 29, 14, 30).getTime(), now, 'en'), /^Yesterday/);
  assert.doesNotMatch(coffeeTableList.formatTableTime(new Date(2026, 8, 20, 14, 30).getTime(), now, 'zh-TW'), /2026/);
  assert.match(coffeeTableList.formatTableTime(new Date(2025, 8, 20, 14, 30).getTime(), now, 'en'), /2025/);
});
test('Coffee Tables prompt keeps the owner’s role topology and conversational intent in one plain-text request', () => {
  const prompt = coffeePrompts.tablePrompt('Topic', 'zh-TW');
  assert.match(prompt, /使用者原始主題[\s\S]*\nTopic\n/); assert.match(prompt, /主持人 2 位/); assert.match(prompt, /兩位主持人分工為一位留意矛盾、一位好奇追問/); assert.match(prompt, /觀察者/); assert.match(prompt, /source: 對談中的原句/); assert.equal((prompt.match(/- 主題專家/g) ?? []).length, 4);
  assert.match(prompt, /每個可定位到具體發言的洞見，都要/); assert.match(prompt, /沒有單一來源/);
  assert.match(prompt, /跨領域專家/); assert.match(prompt, /generalist/); assert.match(prompt, /虛構模擬/); assert.match(prompt, /完整保留，不另取聊天室標題/);
  assert.match(prompt, /10–18 次簡短發言/); assert.match(prompt, /# 觀察者整理/); assert.match(prompt, /## 意外連結[\s\S]*## 值得繼續想的問題[\s\S]*## 核心分歧[\s\S]*## 探索方向[\s\S]*## 值得查證的假設/); assert.match(prompt, /每次續聊新增約 8–12 次簡短發言/); assert.match(prompt, /未解問題/); assert.match(prompt, /coffee-tables-complete/);
  const resumed = coffeePrompts.tablePrompt('Topic', 'zh-TW', undefined, '### 林岑｜主持人\n先前中斷的話');
  assert.match(resumed, /不加前言、流程說明或重複人物介紹/); assert.match(resumed, /從前一句自然接續/);
  const resumedEnglish = coffeePrompts.tablePrompt('Topic', 'en', undefined, '### Host\nAn interrupted thought');
  assert.match(resumedEnglish, /without a preamble, process notes/); assert.match(resumedEnglish, /resume naturally from the last sentence/);
  const tailored = coffeePrompts.tablePrompt('原始主題：保留標點？', 'en', { counts: { experts: 0, 'cross-domain': 0, generalist: 0, affected: 1 }, guests: [{ id: 'g1', category: 'affected', description: 'frontline support' }], background: '', customPrompt: 'Use small company examples.' });
  assert.match(tailored, /原始主題：保留標點？/); assert.match(tailored, /frontline support/); assert.match(tailored, /Use small company examples/); assert.doesNotMatch(tailored, /4 位與主題相關/); assert.doesNotMatch(tailored, /本桌沒有跨領域來賓/);
  assert.match(tailored, /For an opening, aim for 10–18 concise turns/); assert.match(tailored, /# Observer’s notes/); assert.match(tailored, /## Unexpected connections[\s\S]*## Questions worth pursuing[\s\S]*## Core disagreements[\s\S]*## Directions to explore[\s\S]*## Assumptions to verify/); assert.match(tailored, /questions worth pursuing/i); assert.match(tailored, /coffee-tables-complete/);
  assert.match(tailored, /For every insight that can be located in specific dialogue, append one or more/);
  assert.doesNotMatch(prompt, /JSON|nextSpeakerId|輪數|字數限制/);
  const session = coffeeSession(); session.transcriptMarkdown = '主持人：我們剛才談到免費午餐。';
  assert.match(coffeePrompts.questionPrompt(session, '那家長付費會不會讓孩子被分級？'), /我們剛才談到免費午餐/);
  assert.match(coffeePrompts.questionPrompt(session, '那家長付費會不會讓孩子被分級？'), /家長付費/);
  assert.match(coffeePrompts.questionPrompt(session, '追問'), /## 意外連結[\s\S]*## 值得繼續想的問題[\s\S]*## 核心分歧[\s\S]*## 探索方向[\s\S]*## 值得查證的假設/); assert.match(coffeePrompts.questionPrompt(session, '追問'), /coffee-tables-complete/);
  const snapshot = { ...session, guests: { ...session.guests, styleId: 'style-1', styleName: '輕鬆聊天', stylePrompt: '先多問問題，再整理分歧。', referenceFiles: [{ name: '背景.md', content: '# 標題\n```md\n<!-- coffee-tables-complete -->\n```' }] } };
  assert.match(coffeePrompts.tablePrompt('Topic', 'zh-TW', snapshot.guests), /先多問問題，再整理分歧/); assert.match(coffeePrompts.tablePrompt('Topic', 'zh-TW', snapshot.guests), /背景.md[\s\S]*<!-- coffee-tables-complete -->/);
  assert.match(coffeePrompts.questionPrompt(snapshot, '追問'), /先多問問題，再整理分歧/); assert.match(coffeePrompts.questionPrompt(snapshot, '追問'), /背景.md/);
  assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /先多問問題，再整理分歧/); assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /背景.md/); assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /source: 對談中的原句/);
  assert.throws(() => coffeePrompts.questionPrompt(snapshot, 'x'.repeat(load('experiences/coffee-tables/prompt-parts.ts').MAX_COFFEE_CONTEXT_CHARS)), /太長|too long/);
});
test('Coffee Tables custom style replaces editable built-in behavior guidance in every generation mode', () => {
  const session = coffeeSession();
  session.guests.stylePrompt = '自由深入討論，不限制發言輪數；遇到草稿從全新角度重新展開；觀察者只整理三個最重要的發現。';
  session.observerNotes = ['舊觀察整理'];
  const opening = coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests);
  const continuation = coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests, '### 主持人｜甲\n草稿');
  const followUp = coffeePrompts.questionPrompt(session, '請談談成本', '先前追問草稿');
  const observerRefresh = coffeePrompts.observerOnlyPrompt(session);
  for (const prompt of [opening, continuation, followUp, observerRefresh]) {
    assert.match(prompt, /自由深入討論，不限制發言輪數[\s\S]*遇到草稿從全新角度重新展開/);
    assert.doesNotMatch(prompt, /10–18 次簡短發言|約 8–12 次簡短發言|roughly 8–12 concise speaker turns|10–18 concise speaker turns|每個標題下 2–4 個條列|each followed by 2–4 bullets|一位留意矛盾，一位好奇追問/);
    assert.doesNotMatch(prompt, /只作脈絡，不要重寫|請從最後一句接續|只用來推進討論，不要重寫|請從最後一句繼續|不要重複/);
  }
  assert.match(opening, /### 姓名｜角色/);
  assert.match(opening, /## 意外連結/);
  assert.match(opening, /coffee-tables-complete/);
  assert.match(observerRefresh, /只更新觀察者整理/);
  session.guests.stylePrompt = '';
  assert.doesNotMatch(coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests), /聊天室風格：[\s\S]*?請用自然、口語的繁體中文（台灣用法）對話/);
});
test('Coffee Tables assembles the full timeline chronologically, including interventions, drafts and custom instructions', () => {
  const session = coffeeSession();
  session.guests.customPrompt = '多談第一線的實際情況';
  session.rounds = [{ id: 'r1', markdown: '第一段來賓發言', notes: '', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'r2', markdown: '', draftMarkdown: '第二段未完成草稿', notes: '', status: 'error', createdAt: '2026-01-01T00:00:04.000Z' }];
  session.transcriptMarkdown = '第一段來賓發言';
  session.questions = [{ id: 'q1', question: '追問已完成？', answer: '已完成回答', status: 'complete', createdAt: '2026-01-01T00:00:02.000Z' }, { id: 'q2', question: '追問中斷？', answer: '', draftAnswer: '追問回答草稿', status: 'error', createdAt: '2026-01-01T00:00:05.000Z' }];
  session.interventions = [{ id: 'i1', kind: 'comment', text: '使用者中途補充', createdAt: '2026-01-01T00:00:03.000Z' }];
  const context = coffeePrompts.assembleCoffeeContext(session);
  const positions = ['第一段來賓發言', '追問已完成？', '使用者中途補充', '第二段未完成草稿', '追問中斷？'].map(item => context.indexOf(item));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(coffeePrompts.observerOnlyPrompt(session), /第二段未完成草稿/);
  assert.match(coffeePrompts.observerOnlyPrompt(session), /追問回答草稿/);
  assert.match(coffeePrompts.questionPrompt(session, '接下來呢？'), /多談第一線的實際情況/);
  session.rounds[0].markdown = '### 主持人｜甲\n\n第一句。\n\n### 專家｜乙\n\n第二句。';
  session.interventions = [{ id: 'mid', kind: 'comment', text: '使用者在兩位發言間插話', createdAt: '2026-01-01T00:00:01.500Z', roundId: 'r1', afterTurn: 1 }];
  const interleaved = coffeePrompts.assembleCoffeeContext(session);
  assert.ok(interleaved.indexOf('第一句。') < interleaved.indexOf('使用者在兩位發言間插話'));
  assert.ok(interleaved.indexOf('使用者在兩位發言間插話') < interleaved.indexOf('第二句。'));
});
test('Coffee Tables bilingual samples retain full discussions, five observer notes and a follow-up each', () => {
  const { COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN } = load('experiences/coffee-tables/samples.ts');
  for (const sample of [COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN]) {
    assert.ok(sample.markdown.length > 8000); assert.ok(sample.question.length > 20); assert.ok(sample.answer.length > 100);
    assert.match(sample.markdown, /(?:最大.*討論轉折|Major turns)/); assert.match(sample.markdown, /(?:尚未解決的核心衝突|Unresolved conflicts)/);
  }
  assert.match(COFFEE_SAMPLE_ZH.title, /中文/); assert.match(COFFEE_SAMPLE_EN.title, /English/);
});
test('Coffee Tables validates numeric guest counts and named guests occupy their selected category slots', () => {
  const { parseSession } = coffeeTypes;
  const valid = coffeeSession();
  valid.guests = { counts: { experts: 2, 'cross-domain': 0, generalist: 0, affected: 1 }, guests: [{ id: 'named-1', category: 'experts', description: '第一線客服' }], background: '小公司', customPrompt: '多談實際做法' };
  assert.equal(parseSession(JSON.stringify(valid)).guests.guests.length, 1); assert.equal(parseSession(JSON.stringify(valid)).guests.hostCount, 2);
  for (let count = 1; count <= 4; count++) { const hosted = { ...valid, guests: { ...valid.guests, hostCount: count } }; assert.equal(parseSession(JSON.stringify(hosted)).guests.hostCount, count); assert.match(coffeePrompts.tablePrompt('Topic', 'en', hosted.guests), new RegExp(`主持人 ${count} 位`)); }
  assert.throws(() => parseSession(JSON.stringify({ ...valid, guests: { ...valid.guests, hostCount: 5 } })), /guest count/i);
  for (const counts of [
    { experts: 0, 'cross-domain': 0, generalist: 0, affected: 0 },
    { experts: 8, 'cross-domain': 8, generalist: 0, affected: 0 },
    { experts: 9, 'cross-domain': 1, generalist: 1, affected: 1 },
    { experts: 1, 'cross-domain': 0, generalist: 0, affected: 0 },
  ]) {
    const invalid = { ...valid, guests: { ...valid.guests, counts, guests: [{ id: 'named-1', category: 'experts', description: '客服' }, { id: 'named-2', category: 'experts', description: '店長' }] } };
    assert.throws(() => parseSession(JSON.stringify(invalid)), /guest count/i);
  }
});
test('Coffee Tables speaker parser creates stable roster and speech identities and ignores note headings', () => {
  const { parseGuests, parseSpeeches } = load('experiences/coffee-tables/view.ts', { obsidian });
  const markdown = '- **主持人 甲｜林岑**：抓矛盾\n- **Xiao Yun｜Customer-support lead**: Frontline work\n\n### 林岑｜主持人\n你說要自動化，責任歸誰？\n\n### Xiao Yun｜Customer-support lead\n工作量沒有減少。\n\n# 觀察者整理\n## 主要轉折\n### 假設一\n不是來賓';
  assert.deepEqual(plain(parseGuests(markdown)), [{ name: '林岑', role: '主持人 甲', bio: '抓矛盾' }, { name: 'Xiao Yun', role: 'Customer-support lead', bio: 'Frontline work' }]);
  assert.deepEqual(plain(parseSpeeches(markdown)), [{ name: '林岑', role: '主持人', text: '你說要自動化，責任歸誰？' }, { name: 'Xiao Yun', role: 'Customer-support lead', text: '工作量沒有減少。' }]);
});
test('Coffee Tables outline parses localized headings, wrapped bullets and nested list detail without treating code as structure', () => {
  assert.ok(fs.existsSync(path.join(root, 'experiences/coffee-tables/outline.ts')), 'Coffee Tables outline logic module exists');
  const { parseCoffeeOutline } = load('experiences/coffee-tables/outline.ts');
  const notes = '# 觀察者整理\n\n## 意外連結\n- **創作價值**與勞動條件相連，\n  速度未必讓人得到更多自由。 <!-- source: AI 工具讓創作者產出更快，卻沒有得到更多自由時間。 -->\n  - 也要查看接案者的修改成本。\n\n## Questions worth pursuing\n- Can creators refuse training use?\n\n```md\n## fake section\n- fake item\n```';
  const parsedNotes = parseCoffeeOutline(notes);
  assert.equal(parsedNotes[0].items[0].sourceText, 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。');
  assert.doesNotMatch(parsedNotes[0].items[0].text, /source:/);
  const { findRelatedSpeech } = load('experiences/coffee-tables/outline.ts');
  assert.equal(findRelatedSpeech(parsedNotes[0].items[0].sourceText, [{ id: 'source-speech', text: 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。', order: 5 }]), 'source-speech');
  assert.deepEqual(plain(parsedNotes), [
    { id: 'section-0', title: '意外連結', depth: 2, items: [
      { id: 'section-0-item-0', text: '創作價值與勞動條件相連，速度未必讓人得到更多自由。', sourceText: 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。', context: '也要查看接案者的修改成本。', depth: 0 },
    ] },
    { id: 'section-1', title: 'Questions worth pursuing', depth: 2, items: [
      { id: 'section-1-item-0', text: 'Can creators refuse training use?', depth: 0 },
    ] },
  ]);
});
test('Coffee Tables outline matching finds the strongest related Chinese speech and refuses ambiguous or generic matches', () => {
  assert.ok(fs.existsSync(path.join(root, 'experiences/coffee-tables/outline.ts')), 'Coffee Tables outline logic module exists');
  const { findRelatedSpeech } = load('experiences/coffee-tables/outline.ts');
  const targets = [
    { id: 'dialogue-1', text: 'AI工具讓作品生產更快，卻沒有證據顯示創作者因此得到更多自由時間。', order: 0 },
    { id: 'dialogue-2', text: '稿酬降低可能和接案工作者需要反覆修改作品有關。', order: 1 },
    { id: 'dialogue-3', text: '要再觀察使用者是否真的理解作品。', order: 2 },
  ];
  assert.equal(findRelatedSpeech('自動化產出更快，創作者仍沒有因此得到更多自由時間。', targets), 'dialogue-1');
  assert.equal(findRelatedSpeech('加價午餐不只涉及食物，也像公共運輸的差別定價，牽涉基本服務與額外選擇的界線。', [
    { id: 'analogy', text: '公共運輸有時會讓乘客加價買更舒適的座位，這跟午餐有一點相似：都是在基本服務之外提供選擇。但限制也很明顯，交通座位比較像個人使用；孩子一起吃飯時，食物差異會直接變成同儕之間看得見的差距。', order: 0 },
    { id: 'other', text: '學校必須先保障基本營養，不能把過敏或醫療需求當成額外選擇。', order: 1 },
  ]), 'analogy');
  assert.equal(findRelatedSpeech('產出速度和創作人自由時間的關係', [
    { id: 'first', text: 'AI提高產出速度，也未增加創作者的自由時間。', order: 0 },
    { id: 'second', text: 'AI提升產出速度，也未增加創作者的休閒時間。', order: 1 },
  ]), 'first');
  assert.equal(findRelatedSpeech('先用 MIT、之後改授權聽起來簡單，但外部貢獻者的著作權會讓未來的選擇更複雜。', [
    { id: 'license-question', text: '那如果我不確定未來會不會做雲端服務，是不是先 MIT，之後有人拿去做 SaaS 再改 AGPL 就好？', order: 0 },
    { id: 'license-rights', text: '你通常可以對未來版本改授權，但已經用舊版本的人仍按舊授權使用；若程式有外部貢獻，還得確認你有權這麼做。', order: 1 },
    { id: 'license-followup', text: '以後改授權不是完全不行，但不會把舊版本的使用權收回來；開始接受外部貢獻後，還多一層權利確認。', order: 2 },
  ]), 'license-followup');
  assert.equal(findRelatedSpeech('加速產出之後創作者仍沒有更多自由時間', [
    { id: 'one', text: 'AI加快產出，但創作者沒有得到更多自由時間。', order: 0 },
    { id: 'two', text: 'AI加速產出，創作者仍沒有得到更多自由時間。', order: 1 },
  ]), null);
  assert.equal(findRelatedSpeech('意外連結', targets), null);
  assert.equal(findRelatedSpeech('作品生產速度更快', [
    { id: 'earlier', text: '作品生產速度更快。', order: 0 },
    { id: 'later', text: '作品生產速度更快。', order: 1 },
  ]), 'earlier');
  assert.equal(findRelatedSpeech('今天摘要要討論親子講座如何安排時間', [
    { id: 'short-phrase', text: '親子講座', order: 0 },
  ]), null);
});
test('Coffee Tables deletion locks every view of a shared manager engine and retires it after removal', async () => {
  let calls = 0; const manager = new coffee.CoffeeManager(async () => { calls++; return 'not expected'; }, async () => {}); const session = coffeeSession(); session.status = 'completed'; const first = manager.open(session), second = manager.open(session); assert.equal(first, second);
  const locked = await manager.prepareDelete(session.id); await Promise.all([second.continueTable(), second.ask('continue?')]); assert.equal(calls, 0); assert.equal(manager.get(session.id), first); manager.completeDelete(session.id, locked); await Promise.all([first.start(), second.continueTable(), second.ask('late?')]); assert.equal(first.deleted, true); assert.equal(manager.get(session.id), undefined); assert.equal(calls, 0); assert.throws(() => manager.open(session), /being deleted or was deleted/); manager.restore(session.id); assert.equal(manager.open(session).session.id, session.id);
  const uncached = { ...coffeeSession(), id: 'uncached-delete-id' }; await manager.prepareDelete(uncached.id); assert.throws(() => manager.open(uncached), /being deleted or was deleted/); manager.cancelDelete(uncached.id, undefined); assert.equal(manager.open(uncached).session.id, uncached.id);
});
test('Coffee Tables copies legacy sessions without rewriting the source', () => {
  const legacy = { version: 1, id: 'old-session', topic: '舊桌', language: 'zh-TW', model: 'm', reasoning: 'low', createdAt: '2026-01-01', updatedAt: '2026-01-01', status: 'completed', participants: [{ id: 'host-a', name: '小安', role: '主持人', lens: '好奇' }], messages: [{ id: 'm1', speakerId: 'host-a', text: '保留這句', replyTo: null, move: 'opening', targetId: null, createdAt: '2026-01-01' }], nextSpeakerId: 'host-a', segmentStart: 0, notes: null, endReason: 'natural' };
  const copy = coffeeTypes.copyLegacySession(legacy);
  assert.equal(copy.version, 3); assert.match(copy.transcriptMarkdown, /保留這句/); assert.notEqual(copy.id, legacy.id); assert.equal(legacy.version, 1);
});
test('Coffee Tables restored visible built-in insights apply in all four modes without constraining custom styles', () => {
  for (const language of ['zh-TW', 'en']) {
    const session = coffeeSession(); session.language = language;
    session.guests.stylePrompt = language === 'zh-TW' ? coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT : coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT_EN;
    session.transcriptMarkdown = 'Earlier important exchange'; session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n\n- Earlier valuable insight: the exchange showed a concrete unresolved tradeoff.'];
    session.guests.referenceFiles = [{ name: 'context.md', content: 'Reference background' }];
    const prompts = [coffeePrompts.tablePrompt(session.topic, language, session.guests), coffeePrompts.tablePrompt(session.topic, language, session.guests, 'Saved draft', coffeePrompts.assembleCoffeeContext(session)), coffeePrompts.questionPrompt(session, 'New question'), coffeePrompts.observerOnlyPrompt(session)];
    for (const prompt of prompts) {
      assert.match(prompt, /原本五類每類整理 2–4|2–4 distinct, substantive insights in each of the first five categories/);
      assert.match(prompt, /沒有重新輸出的舊項目會由程式保留|the program retains old items you do not rewrite/); assert.match(prompt, /整合完整對談|use the complete saved conversation/);
      assert.match(prompt, /context.md/);
      assert.match(prompt, /程式會保留未提及項目|the program retains old items you do not rewrite/);
    }
    for (const prompt of prompts.slice(1)) { assert.match(prompt, /Earlier important exchange/); assert.match(prompt, /Earlier valuable insight/); }
    session.guests.stylePrompt = 'User-authored style only';
    for (const prompt of [coffeePrompts.tablePrompt(session.topic, language, session.guests), coffeePrompts.questionPrompt(session, 'Question'), coffeePrompts.observerOnlyPrompt(session)]) assert.doesNotMatch(prompt, /原本五類每類整理 2–4|2–4 distinct, substantive insights in each of the first five categories/);
  }
});
test('Coffee segment navigation sorts rounds and follow-ups without treating interventions as new segments', () => {
  const { coffeeSegments } = load('experiences/coffee-tables/segments.ts');
  const session = { id: 'table', createdAt: '2026-01-01', transcriptMarkdown: '', rounds: [{ id: 'a', createdAt: '2026-01-01', kind: 'initial', status: 'completed', markdown: 'A', summary: 'Opening.' }, { id: 'b', createdAt: '2026-01-03', kind: 'continuation', status: 'error', markdown: '', draftMarkdown: 'Draft' }], questions: [{ id: 'q', createdAt: '2026-01-02', question: 'Why?', answer: 'Because.', status: 'complete' }], interventions: [{ id: 'i', text: 'A turning question', roundId: 'a', afterTurn: 2, createdAt: '2026-01-02' }] };
  assert.deepEqual(plain(coffeeSegments(session)).map(x => [x.id,x.kind,x.status]), [['round:a','initial','completed'],['question:q','question','completed'],['round:b','continuation','error']]);
  assert.ok(coffeeSegments(session)[0].text.includes('A turning question'));
});
test('Coffee summary parsing removes metadata without damaging notes and ignores malformed summaries', () => {
  const { extractSegmentSummary, parseSummaryBatch } = load('experiences/coffee-tables/segments.ts');
  const result = extractSegmentSummary('### A｜Host\nHello.\n<!-- coffee-segment-summary: {"summary":"The debate shifted to responsibility."} -->\n# Observer’s notes\nNotes');
  assert.equal(result.summary, 'The debate shifted to responsibility.'); assert.ok(!result.markdown.includes('coffee-segment-summary')); assert.ok(result.markdown.includes('# Observer’s notes'));
  assert.equal(extractSegmentSummary('text\n<!-- coffee-segment-summary: bad -->').summary, undefined);
  assert.deepEqual(plain(parseSummaryBatch('{"summaries":[{"id":"round:a","summary":"One."},{"id":"foreign","summary":"Ignore."}]}', ['round:a'])), [{id:'round:a',summary:'One.'}]);
  assert.throws(() => parseSummaryBatch('{"summaries":[{"id":"round:a","summary":"One."},{"id":"round:a","summary":"Two."}]}', ['round:a']));
});
