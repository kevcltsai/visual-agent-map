const assert = require('node:assert/strict');
const { test, integrationTest, load, plain, plannerReview, savedEvidenceNeedsSearch, aimPhase, auditEcho, obsidian, DEFAULT_SETTINGS, fixture, aimMapFixture } = require('../support.cjs');
integrationTest('topic rename restores the original folder and exact Map.md when derived-data rebuild fails', async () => {
  const { repo, app } = fixture();
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  const originalPath = await repo.createMap('Rollback source');
  const originalRoot = repo.topicRoot(originalPath), destination = 'Agent Workspace/AIM/Rollback target';
  const originalContent = await app.vault.read(repo.file(originalPath));
  const rebuild = repo.rebuildDerivedData.bind(repo); let failOnce = true;
  repo.rebuildDerivedData = async (...args) => { if (failOnce) { failOnce = false; throw new Error('simulated rebuild failure'); } return rebuild(...args); };
  await assert.rejects(repo.renameTopic(originalPath, 'Rollback target'), /simulated rebuild failure/);
  assert.ok(app.vault.getAbstractFileByPath(originalRoot));
  assert.equal(app.vault.getAbstractFileByPath(destination), undefined);
  assert.equal(await app.vault.read(repo.file(originalPath)), originalContent);
});
integrationTest('AIM freezes each answer/input branch snapshot and fences late attempts', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const answer = { selections: ['鑄鐵鍋'], freeText: '沒有烤箱' };
  const input = { topic: '在家煎牛排', conditions: { doneness: 'medium-rare' }, upstreamResults: [{ notePath: 'existing/report.md', version: 1 }] };
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: answer, inputSnapshot: input });
  answer.selections[0] = '不應回寫'; input.conditions.doneness = 'well-done';
  const first = await store.startAttempt(mapPath, branch.id, 'run-1');
  const oldDraft = (await store.createResultDraft(mapPath, first, '舊 attempt 診斷', 'gpt-6-luna')).draft;
  const retry = await store.startAttempt(mapPath, branch.id, 'run-1');
  assert.equal(first.inputSnapshotHash, retry.inputSnapshotHash);
  const retiredDraft = await repo.readNote(oldDraft.notePath);
  assert.equal(retiredDraft.status, 'error'); assert.match(retiredDraft.summary, /is not a valid research result/);
  assert.equal((await repo.readMap(mapPath)).nodes.some(node => node.id === oldDraft.nodeId), false);
  assert.deepEqual(plain(await store.createResultDraft(mapPath, first, '舊 attempt 不得產生結果', 'gpt-6-luna')), { status: 'stale', runId: 'run-1', attemptId: 'attempt-1' });
  const result = (await store.createResultDraft(mapPath, retry, '研究結果', 'gpt-6-luna')).draft;
  assert.deepEqual(plain((await repo.readMap(mapPath)).aim.branches[0].answerSnapshot), { selections: ['鑄鐵鍋'], freeText: '沒有烤箱' });
  assert.equal((await store.commitResult(mapPath, first, result.id, { summary: 'late result', detail: 'must not publish' })).status, 'stale');
  assert.equal((await repo.readNote(result.notePath)).summary.includes('late result'), false);
  assert.deepEqual(plain(await store.commitResult(mapPath, retry, result.id, { summary: 'current result', detail: 'current attempt only' })), { status: 'committed', resultId: 'result-run-1-attempt-2', notePath: result.notePath });
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(result.notePath);
  assert.equal(savedMap.aim.runs[0].attempts[0].status, 'superseded');
  assert.equal(savedMap.aim.runs[0].attempts[1].status, 'completed');
  assert.equal(savedMap.aim.branches[0].results.length, 1);
  assert.equal(savedMap.aim.branches[0].results[0].nodeId, result.nodeId);
  assert.equal(savedMap.aim.resultDrafts.length, 0);
  assert.equal(savedNote.summary, 'current result'); assert.equal(savedNote.detail, 'current attempt only');
});
integrationTest('AIM start creates a typed mother topic through the production Map/Note Repository', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'aim-start-test-1', topic: '如何安排一週的居家運動？', context: '每次不超過 30 分鐘；家中沒有器材。', model: 'gpt-6-luna', reasoning: 'low' });
  const savedMap = await repo.readMap(created.mapPath), savedNote = await repo.readNote(created.root.path);
  assert.equal(savedMap.title, '如何安排一週的居家運動？');
  assert.deepEqual(plain(savedMap.aim), { version: 1, creationId: 'aim-start-test-1', contentLanguage: 'zh-TW', minimumAnswersBeforeConclusion: 3, branches: [], runs: [], resultDrafts: [], pendingCommits: [] });
  assert.equal(savedMap.nodes.length, 1);
  assert.equal(savedMap.nodes[0].aimKind, 'topic');
  assert.equal(savedMap.nodes[0].id, created.root.id);
  assert.equal(savedNote.title, '如何安排一週的居家運動？');
  assert.equal(savedNote.summary, '如何安排一週的居家運動？');
  assert.match(savedNote.detail, /每次不超過 30 分鐘；家中沒有器材。/);
  assert.equal(savedNote.model, 'gpt-6-luna'); assert.equal(savedNote.reasoning, 'low');
  assert.equal(savedNote.status, 'idea');
});
integrationTest('AIM start locks submitted input and reuses its request identity after failure', async () => {
  const makeElement = (tag, options = {}) => ({ tag, text: options.text ?? '', value: options.value ?? '', cls: options.cls ?? '', children: [], disabled: false, style: {},
    createEl(name, value) { const child = makeElement(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = makeElement('span', value); this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, toggleClass(name, enabled) { this.cls = enabled ? `${this.cls} ${name}`.trim() : this.cls.split(' ').filter(item => item !== name).join(' '); },
    addEventListener(name, handler) { this[name] = handler; }, focus() {},
    querySelector(selector) { return selector === 'button:last-child' ? this.children.filter(child => child.tag === 'button').at(-1) : undefined; }
  });
  class Modal { constructor() { this.titleEl = makeElement('title'); this.contentEl = makeElement('content'); } close() { this.closed = true; } }
  class Setting { constructor(root) { this.controlEl = makeElement('setting'); root.children.push(this.controlEl); }
    addButton(configure) { const button = makeElement('button'); button.setButtonText = value => { button.text = value; return button; }; button.setCta = () => button; button.onClick = handler => { button.click = handler; return button; }; this.controlEl.children.push(button); configure(button); return this; }
  }
  const { AimStartModal } = load('ui/modals/aim-start-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  let rejectSubmit; const submissions = [];
  const modal = new AimStartModal({}, input => { submissions.push(input); if (submissions.length === 1) return new Promise((_resolve, reject) => { rejectSubmit = reject; }); return Promise.resolve(); }, [{ id: 'gpt-5.6-luna', label: 'old default' }, { id: 'gpt-6-luna', label: 'approved model' }], 'gpt-6-luna', 'low');
  modal.onOpen();
  const topic = modal.contentEl.children.find(child => child.cls === 'vam-field').children[1];
  const context = modal.contentEl.children.filter(child => child.cls === 'vam-field')[1].children[1];
  const model = modal.contentEl.children.filter(child => child.cls === 'vam-field').flatMap(child => child.children).find(child => child['aria-label'] === 'Model' || child['aria-label'] === '使用模型');
  const reasoning = modal.contentEl.children.filter(child => child.cls === 'vam-field').flatMap(child => child.children).find(child => child['aria-label'] === 'Reasoning level' || child['aria-label'] === '推理等級');
  assert.equal(model.value, 'gpt-6-luna'); assert.equal(reasoning.value, 'low');
  topic.value = '牛排'; context.value = '鑄鐵鍋';
  const create = modal.contentEl.children.at(-1).children.at(-1);
  const cancel = modal.contentEl.children.at(-1).children.at(-2);
  create.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(topic.disabled, true); assert.equal(context.disabled, true); assert.equal(create.disabled, true); assert.equal(cancel.disabled, true);
  const originalRequestId = submissions[0].requestId;
  rejectSubmit(new Error('temporary failure')); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(topic.disabled, false); assert.equal(context.disabled, false); assert.equal(create.disabled, false); assert.equal(cancel.disabled, false);
  create.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(submissions[1].requestId, originalRequestId);
  assert.equal(submissions[1].topic, '牛排'); assert.equal(submissions[1].context, '鑄鐵鍋'); assert.equal(modal.closed, true);
  assert.equal(submissions[1].model, 'gpt-6-luna'); assert.equal(submissions[1].reasoning, 'low');
});
integrationTest('AIM answer modal supports multiple choices, exclusive unknown, free text, and retry', async () => {
  const makeElement = (tag, options = {}) => ({ tag, type: options.type, text: options.text ?? '', value: options.value ?? '', cls: options.cls ?? '', checked: false, disabled: false, children: [],
    createDiv(value) { const child = makeElement('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value) { const child = makeElement(name, value); this.children.push(child); return child; }, createSpan(value) { const child = makeElement('span', value); this.children.push(child); return child; },
    setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; }, focus() {}, addEventListener(name, handler) { this[name] = handler; },
    querySelector(selector) { return selector === 'button:last-child' ? this.children.filter(child => child.tag === 'button').at(-1) : undefined; }
  });
  class Modal { constructor() { this.titleEl = makeElement('title'); this.contentEl = makeElement('content'); } open() { this.onOpen(); } close() { this.closed = true; } }
  class Setting { constructor(root) { this.controlEl = makeElement('setting'); root.children.push(this.controlEl); } addButton(configure) { const button = makeElement('button'); button.setButtonText = value => { button.text = value; return button; }; button.setCta = () => button; button.onClick = handler => { button.click = handler; return button; }; this.controlEl.children.push(button); configure(button); return this; } }
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const { AimAnswerModal } = load('ui/modals/aim-answer-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  const answers = []; let rejectFirst;
  const modal = new AimAnswerModal({}, '偏好的熟度？', [{ id: 'red', label: '偏紅' }, { id: 'done', label: '較熟' }, { id: '__aim_unknown__', label: '未知／無偏好' }], input => {
    answers.push(input); if (answers.length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; }); return Promise.resolve();
  });
  modal.open(); const boxes = all(modal.contentEl, item => item.tag === 'input'), free = all(modal.contentEl, item => item.tag === 'textarea')[0];
  assert.equal(boxes.length, 3); assert.equal(boxes[0]['aria-label'], '偏紅'); assert.equal(free['aria-label'], 'Add details or another answer');
  boxes[0].checked = true; boxes[0].change(); boxes[1].checked = true; boxes[1].change(); boxes[2].checked = true; boxes[2].change();
  assert.equal(boxes[0].checked, false); assert.equal(boxes[1].checked, false); assert.equal(boxes[2].checked, true);
  free.value = '暫時不確定'; free.input(); const button = modal.contentEl.children.at(-1).children.at(-1);
  button.click(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(button.disabled, true);
  assert.equal(modal.closed, true, 'submitting closes the blocking modal while research continues in the background');
  rejectFirst(new Error('temporary persistence failure')); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(modal.closed, true, 'a failed background submission does not reopen the modal'); assert.deepEqual(plain(answers[0].selections), ['__aim_unknown__']); assert.equal(answers[0].freeText, '暫時不確定');
  const firstRequestId = answers[0].requestId;
  const retry = new AimAnswerModal({}, '偏好的熟度？', [{ id: 'red', label: '偏紅' }, { id: 'done', label: '較熟' }, { id: '__aim_unknown__', label: '未知／無偏好' }], input => { answers.push(input); return Promise.resolve(); }, firstRequestId);
  retry.open(); const retryBoxes = all(retry.contentEl, item => item.tag === 'input'), retryButton = retry.contentEl.children.at(-1).children.at(-1);
  retryBoxes[2].checked = true; retryButton.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(retry.closed, true); assert.equal(answers[1].requestId, firstRequestId, 'reopening after an error can safely retry the same submission identity');
  assert.deepEqual(plain(answers[1].selections), ['__aim_unknown__']);
});
integrationTest('AIM start resumes the same Map and Note after a final Map write interruption', async () => {
  const { repo, files } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const input = { requestId: 'aim-start-retry-1', topic: '建立家庭緊急聯絡計畫', context: '優先確認離線時可用的聯絡方式。' };
  const saveMap = repo.saveMap.bind(repo); let mapSaves = 0;
  repo.saveMap = async (...args) => { mapSaves++; if (mapSaves === 2) throw new Error('simulated interruption after the root Note was created'); return saveMap(...args); };
  await assert.rejects(createAimMap(repo, 'gpt-6-luna', input), /simulated interruption/);
  repo.saveMap = saveMap;
  const incomplete = (await repo.mapFiles()).map(file => file.path);
  assert.equal(incomplete.length, 1);
  const pendingMap = await repo.readMap(incomplete[0]);
  assert.equal(pendingMap.nodes.length, 0);
  assert.equal(pendingMap.aim.rootDraft.title, input.topic);
  assert.ok(files.has(pendingMap.aim.rootDraft.notePath));

  const resumed = await createAimMap(repo, 'gpt-6-luna', input);
  assert.equal(resumed.mapPath, incomplete[0]);
  assert.equal((await repo.mapFiles()).length, 1);
  const savedMap = await repo.readMap(resumed.mapPath);
  assert.equal(savedMap.nodes.length, 1);
  assert.equal(savedMap.nodes[0].id, pendingMap.aim.rootDraft.nodeId);
  assert.equal(savedMap.aim.rootDraft, undefined);
  const rootNotes = Array.from(files.keys()).filter(path => path.startsWith(`${repo.topicRoot(resumed.mapPath)}/Notes/`));
  assert.equal(rootNotes.length, 1);
  assert.equal((await repo.readNote(resumed.root.path)).detail, `## 使用者提供的背景\n\n${input.context}`);
});
integrationTest('AIM start reuses only its empty topic folder after the first Map write fails', async () => {
  const { repo, app, files } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const input = { requestId: 'aim-empty-folder-retry', topic: '牛排熟度決策', context: '條件會影響建議。' };
  const create = app.vault.create.bind(app.vault); let failMapWrite = true;
  app.vault.create = async (path, content) => {
    if (failMapWrite && path.endsWith('/Map.md')) { failMapWrite = false; throw new Error('simulated first Map write failure'); }
    return create(path, content);
  };
  await assert.rejects(createAimMap(repo, 'gpt-6-luna', input), /simulated first Map write failure/);
  const stranded = files.get('Agent Workspace/AIM/牛排熟度決策');
  assert.ok(stranded); assert.equal(stranded.children.length, 0);
  const resumed = await createAimMap(repo, 'gpt-6-luna', input);
  assert.equal(resumed.mapPath, 'Agent Workspace/AIM/牛排熟度決策/Map.md');
  assert.equal((await repo.mapFiles()).length, 1);
  assert.equal((await repo.readNote(resumed.root.path)).detail, `## 使用者提供的背景\n\n${input.context}`);
});
integrationTest('AIM recovers a question note written before its Map node commit without rerunning Planner', async () => {
  const { repo, files } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'question-recovery-map', topic: '牛排熟度', context: '' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let plannerCalls = 0, saves = 0, nextId = 0; const saveMap = repo.saveMap.bind(repo);
  repo.saveMap = async (...args) => { saves++; if (saves === 2) throw new Error('injected interruption after question Note creation'); return saveMap(...args); };
  const flow = new AimManualFlow(repo, new AimRunStore(repo), async () => { plannerCalls++; return { summary: '想要什麼熟度？', detail: '熟度會改變建議。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }; }, () => `question-recovery-${++nextId}`);
  await assert.rejects(flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'question-request-1'), /injected interruption/);
  repo.saveMap = saveMap;
  const pending = await repo.readMap(created.mapPath), draft = pending.aim.questionDraft;
  assert.ok(draft); assert.ok(files.has(draft.notePath)); assert.equal(pending.nodes.some(node => node.id === draft.nodeId), false);
  assert.equal(await flow.recoverQuestionDraft(created.mapPath), true);
  const recovered = await repo.readMap(created.mapPath);
  assert.equal(recovered.aim.questionDraft, undefined); assert.equal(recovered.nodes.filter(node => node.aimKind === 'question').length, 1);
  assert.equal(recovered.nodes.find(node => node.id === draft.nodeId).path, draft.notePath); assert.equal(plannerCalls, 1);
});
integrationTest('opening a map recovers questionDraft and post-report asks without re-entering the mutation queue', async () => {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian });
  const openThroughSerialQueue = async (repo, mapPath) => {
    let queue = Promise.resolve(), mutationCalls = 0, aiCalls = 0;
    const plugin = {
      repo, settings: { ...DEFAULT_SETTINGS, cliModel: 'gpt-6-luna' }, closeStaleDetails() {}, syncOutline() {}, releaseOutline() {},
      askModel: async () => { aiCalls++; throw new Error('opening a persisted map must recover without Planner work'); },
      mutate: work => { mutationCalls++; const current = queue.then(work); queue = current.catch(() => {}); return current; }
    };
    const view = new VisualAgentMapView({ app: { workspace: { requestSaveLayout() {} } } }, plugin);
    view.render = () => {};
    let deadline;
    await Promise.race([view.openMap(mapPath), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('openMap re-entered its serialized mutation queue')), 250); })]);
    clearTimeout(deadline);
    assert.equal(mutationCalls, 1, 'openMap enters the repository mutation queue once');
    assert.equal(aiCalls, 0, 'both recovery paths are deterministic and do not rerun Planner');
    return view;
  };

  const questionDraftData = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const questionDraftCreated = await createAimMap(questionDraftData.repo, 'gpt-6-luna', { requestId: 'queue-question-draft-map', topic: 'Question draft recovery', context: '' });
  const questionDraftMapPath = questionDraftCreated.mapPath;
  const questionDraftMap = await questionDraftData.repo.readMap(questionDraftMapPath), questionParent = questionDraftMap.nodes.find(node => node.id === questionDraftCreated.root.id);
  questionDraftMap.aim.questionDraft = {
    requestId: 'queue-question-draft', nodeId: 'queue-question-node', parentId: questionParent.id, parentBranchId: null,
    notePath: `${questionDraftData.repo.topicRoot(questionDraftMapPath)}/Notes/Recovered question.md`,
    title: 'Recovered question', summary: 'Which synthetic option applies?', detail: 'Fixture only.', prompt: 'Fixture only.', model: 'gpt-6-luna',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  };
  await questionDraftData.repo.saveMap(questionDraftMapPath, questionDraftMap);
  const questionDraftView = await openThroughSerialQueue(questionDraftData.repo, questionDraftMapPath);
  assert.equal(questionDraftView.map.aim.questionDraft, undefined);
  assert.ok(questionDraftView.map.nodes.some(node => node.id === 'queue-question-node' && node.aimKind === 'question'));

  const postAsk = await aimMapFixture();
  let saved = await postAsk.repo.readMap(postAsk.mapPath);
  const question = saved.nodes.find(node => node.id === postAsk.question.id);
  question.aimKind = 'question';
  question.aimQuestion = { requestId: 'queue-postask-parent', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
  await postAsk.repo.saveMap(postAsk.mapPath, saved);
  const branch = await postAsk.store.createAnswerBranch(postAsk.mapPath, { requestId: 'queue-postask-answer', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: '' }, inputSnapshot: { topic: saved.title, conditions: {}, upstreamResults: [] } });
  const attempt = await postAsk.store.startAttempt(postAsk.mapPath, branch.id, 'queue-postask-run');
  await postAsk.store.recordResearchTurn(postAsk.mapPath, attempt);
  await postAsk.store.recordPlannerReview(postAsk.mapPath, attempt, { decision: 'ask_user', rationale: 'This saved decision changes the answer.', researchTurn: 1, question: 'Which synthetic direction?', answerOptions: ['Option A', 'Option B'] }, 'Waiting for the follow-up answer.');
  const resultDraft = (await postAsk.store.createResultDraft(postAsk.mapPath, attempt, 'Saved interim report', 'gpt-6-luna', undefined, { kind: 'synthesis' })).draft;
  await postAsk.store.updateResultDraftReport(postAsk.mapPath, attempt, resultDraft.id, 'Synthetic interim report.', 'Synthetic report retained for post-ask recovery.');
  await postAsk.store.commitResult(postAsk.mapPath, attempt, resultDraft.id, { summary: 'Synthetic interim report.', detail: 'Synthetic report retained for post-ask recovery.' });
  postAsk.store.releaseAttempt(postAsk.mapPath, attempt);
  const postAskView = await openThroughSerialQueue(postAsk.repo, postAsk.mapPath);
  const recoveredPostAsk = postAskView.map.nodes.find(node => node.aimQuestion?.parentBranchId === branch.id);
  assert.ok(recoveredPostAsk, 'openMap materializes the persisted post-report ask_user decision');
  assert.equal(recoveredPostAsk.parentId, resultDraft.nodeId);
  assert.equal(postAskView.map.aim.questionDraft, undefined);
});
integrationTest('AIM Planner request identity prevents duplicate Map questions across Flow instances', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'planner-race-map', topic: '牛排', context: '' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const resolvers = []; let call = 0, sequence = 0;
  const ask = () => { call++; return new Promise(resolve => resolvers.push(() => resolve({ summary: '熟度偏好？', detail: '需要使用者回答。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }))); };
  let queue = Promise.resolve(); const persist = work => { const current = queue.then(work); queue = current.catch(() => {}); return current; };
  const flowA = new AimManualFlow(repo, new AimRunStore(repo), ask, () => `planner-race-a-${++sequence}`, persist);
  const flowB = new AimManualFlow(repo, new AimRunStore(repo), ask, () => `planner-race-b-${++sequence}`, persist);
  const first = flowA.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'same-planner-request');
  const second = flowB.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'same-planner-request');
  while (resolvers.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
  resolvers[0]();
  const [left, right] = await Promise.all([first, second]); const saved = await repo.readMap(created.mapPath);
  assert.equal(call, 1, 'same-process Flow instances share one Planner request and one model dispatch');
  assert.equal(left.status, 'question'); assert.equal(right.status, 'question'); assert.equal(left.node.id, right.node.id);
  assert.equal(saved.nodes.filter(node => node.aimQuestion?.requestId === 'same-planner-request').length, 1);
});
integrationTest('AIM Planner close cancels only its View subscriber and fences late results', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'planner-close-map', topic: '牛排', context: '' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let resolvePlanner, call = 0;
  const ask = (_context, _model, _reasoning, signal) => { call++; return new Promise(resolve => { resolvePlanner = () => resolve({ summary: '熟度偏好？', detail: '需要本人回答。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }); ask.signal = signal; }); };
  const flowA = new AimManualFlow(repo, new AimRunStore(repo), ask), flowB = new AimManualFlow(repo, new AimRunStore(repo), ask);
  const owner = new AbortController(), otherView = new AbortController();
  const first = flowA.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'shared-close-question', null, owner.signal);
  const second = flowB.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'shared-close-question', null, otherView.signal);
  while (!resolvePlanner) await new Promise(resolve => setTimeout(resolve, 0));
  owner.abort(); await assert.rejects(first, error => error?.name === 'AbortError');
  assert.equal(ask.signal.aborted, false, 'closing one View leaves a coalesced Planner turn alive for its other subscriber');
  resolvePlanner(); const shared = await second;
  assert.equal(call, 1); assert.equal(shared.status, 'question');
  assert.equal((await repo.readMap(created.mapPath)).nodes.filter(node => node.aimQuestion?.requestId === 'shared-close-question').length, 1);

  const lateController = new AbortController(); let resolveLate;
  const lateFlow = new AimManualFlow(repo, new AimRunStore(repo), async (_context, _model, _reasoning, signal) => {
    return new Promise(resolve => { resolveLate = () => resolve({ summary: '不應發布的問題？', detail: 'late', suggestions: [{ title: 'A' }, { title: 'B' }], visualReferences: [] }); ask.lateSignal = signal; });
  });
  const late = lateFlow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'late-close-question', null, lateController.signal);
  while (!resolveLate) await new Promise(resolve => setTimeout(resolve, 0));
  lateController.abort(); await assert.rejects(late, error => error?.name === 'AbortError');
  assert.equal(ask.lateSignal.aborted, true);
  resolveLate(); await new Promise(resolve => setTimeout(resolve, 0));
  let saved = await repo.readMap(created.mapPath);
  assert.equal(saved.nodes.some(node => node.aimQuestion?.requestId === 'late-close-question'), false, 'an abort-ignoring late model completion cannot commit a question');
  const retry = new AimManualFlow(repo, new AimRunStore(repo), async () => ({ summary: '重新規劃？', detail: '新 turn。', suggestions: [{ title: 'A', task: '', contribution: '', parentTitle: '' }, { title: 'B', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }));
  assert.equal((await retry.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'late-close-question')).status, 'question', 'the request registry is released after cancellation');
  saved = await repo.readMap(created.mapPath);
  assert.equal(saved.nodes.filter(node => node.aimQuestion?.requestId === 'late-close-question').length, 1);
});
integrationTest('Visual Map close fences late Planner rendering and reopen starts a fresh lifecycle', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'view-close-map', topic: '牛排', context: '' });
  await repo.updateNote(created.root.path, { detail: `${(await repo.readNote(created.root.path)).detail}\n\n<!-- aim-intake-complete -->` });
  let resolvePlanner, call = 0, renders = 0;
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, ready: Promise.resolve(), mutate: async work => work(),
    askModel: async () => { call++; if (call === 1) return new Promise(resolve => { resolvePlanner = () => resolve({ summary: '晚到問題？', detail: '不應寫回關閉的 View。', suggestions: [{ title: 'A', task: '', contribution: '', parentTitle: '' }, { title: 'B', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }); }); return { summary: '重新開啟後的問題？', detail: '新生命週期。', suggestions: [{ title: 'A', task: '', contribution: '', parentTitle: '' }, { title: 'B', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }; },
    syncOutline() {}, releaseOutline() {}, consumeFirstInstallSample: () => false };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app: {} }, plugin);
  view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {};
  view.path = created.mapPath; view.map = created.map; view.notes.set(created.root.id, await repo.readNote(created.root.path)); view.selected = created.root.id; view.render = () => { renders++; };
  await view.onOpen(); const work = view.planAimFromSelection();
  while (!resolvePlanner) await new Promise(resolve => setTimeout(resolve, 0));
  await view.onClose(); const rendersAtClose = renders;
  resolvePlanner(); await work;
  assert.equal(renders, rendersAtClose, 'late Planner completion cannot render after close');
  assert.equal((await repo.readMap(created.mapPath)).nodes.some(node => node.aimKind === 'question'), false);
  await view.onOpen(); view.selected = created.root.id;
  await view.planAimFromSelection();
  assert.equal(call, 2); assert.equal((await repo.readMap(created.mapPath)).nodes.some(node => node.aimKind === 'question'), true);
});
integrationTest('Visual Map close during Planner question save lets the started Note/Map commit finish without late rendering', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'planner-save-close-map', topic: '牛排', context: '' });
  await repo.updateNote(created.root.path, { detail: `${(await repo.readNote(created.root.path)).detail}\n\n<!-- aim-intake-complete -->` });
  let releaseNote, announceNote; const noteStarted = new Promise(resolve => { announceNote = resolve; });
  const createNoteAt = repo.createNoteAt.bind(repo);
  repo.createNoteAt = async (...args) => { announceNote(); await new Promise(resolve => { releaseNote = resolve; }); return createNoteAt(...args); };
  const realSaveMap = repo.saveMap.bind(repo); let mapWrites = 0, announceMapCommit;
  const mapCommitted = new Promise(resolve => { announceMapCommit = resolve; });
  repo.saveMap = async (...args) => { const result = await realSaveMap(...args); if (++mapWrites === 2) announceMapCommit(); return result; };
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, mutate: async work => work(), syncOutline() {}, releaseOutline() {},
    askModel: async () => ({ summary: '偏好熟度？', detail: '請使用者選擇。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }) };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app: {} }, plugin);
  view.path = created.mapPath; view.map = created.map; view.notes.set(created.root.id, await repo.readNote(created.root.path)); view.selected = created.root.id;
  let renders = 0; view.render = () => { renders++; };
  const work = view.planAimFromSelection(); await noteStarted; await view.onClose(); const rendersAtClose = renders;
  releaseNote(); await work; await mapCommitted;
  const saved = await repo.readMap(created.mapPath);
  assert.equal(saved.aim.questionDraft, undefined);
  assert.equal(saved.nodes.filter(node => node.aimKind === 'question').length, 1);
  assert.equal(renders, rendersAtClose, 'the already-started persistence can complete without publishing to the closed View');
});
integrationTest('AIM answer modal from an older View lifecycle cannot submit after reopen', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'stale-modal-map', topic: '牛排', context: '' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const planner = new AimManualFlow(repo, new AimRunStore(repo), async () => ({ summary: '偏好熟度？', detail: '本人回答。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }));
  const planned = await planner.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'stale-modal-question');
  let modal, modelCalls = 0;
  class CapturingModal { constructor(app) { this.app = app; } open() { modal = this; } close() {} }
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, ready: Promise.resolve(), mutate: async work => work(), syncOutline() {}, releaseOutline() {},
    askModel: async () => { modelCalls++; return { summary: '不應啟動', detail: 'stale modal', suggestions: [], visualReferences: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: CapturingModal } });
  const view = new VisualAgentMapView({ app: {} }, plugin); view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {};
  view.path = created.mapPath; view.map = await repo.readMap(created.mapPath); view.notes.set(planned.node.id, await repo.readNote(planned.node.path)); view.render = () => {};
  await view.onOpen(); view.openAimAnswer(planned.node);
  const staleSubmit = modal.submit;
  await view.onClose(); await view.onOpen();
  await staleSubmit({ requestId: 'stale-modal-answer', selections: [planned.options[0].id], freeText: '' });
  const saved = await repo.readMap(created.mapPath);
  assert.equal(modelCalls, 0); assert.equal(saved.aim.branches.length, 0);
});
integrationTest('AIM start modal from an older View lifecycle cannot create or render after reopen', async () => {
  const { repo } = fixture(); let modal, createCalls = 0, rebuildCalls = 0, renders = 0;
  class CapturingModal { constructor(app, ...args) { this.app = app; this.args = args; } open() { modal = this; } close() {} }
  const realCreate = repo.createMap.bind(repo);
  repo.createMap = async (...args) => { createCalls++; return realCreate(...args); };
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-5.6-luna', cliReasoning: 'medium' }, availableModels: () => ['gpt-6-luna'], ready: Promise.resolve(), mutate: async work => work(), closeStaleDetails() {}, syncOutline() {}, releaseOutline() {},
    rebuildDerivedData: async () => { rebuildCalls++; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: CapturingModal } });
  const view = new VisualAgentMapView({ app: { workspace: { requestSaveLayout() {} } } }, plugin);
  view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {}; view.path = 'existing/Map.md'; view.render = () => { renders++; };
  await view.onOpen(); view.openAimStart(); const staleSubmit = modal.submit; const beforeClose = renders;
  assert.deepEqual(plain(modal.models.map(choice => choice.id)), ['gpt-5.6-luna', 'gpt-6-luna']);
  assert.equal(modal.defaultModel, 'gpt-5.6-luna', 'AIM honors the workspace-selected model rather than silently overriding it.');
  assert.equal(modal.defaultReasoning, 'medium', 'AIM honors the workspace reasoning setting.');
  await view.onClose(); await view.onOpen(); const afterReopen = renders;
  await staleSubmit({ requestId: 'stale-start', topic: '不應建立', context: '' });
  assert.equal(createCalls, 0); assert.equal(rebuildCalls, 0);
  assert.equal((await repo.mapFiles()).length, 0); assert.equal(renders, afterReopen); assert.ok(afterReopen >= beforeClose);
});
integrationTest('Visual Map ignores an earlier asynchronous open after close and a newer open', async () => {
  const { repo } = fixture(); const stalePath = await repo.createMap('舊圖載入'); const currentPath = await repo.createMap('新圖載入');
  const readMap = repo.readMap.bind(repo); let releaseStale, signalStaleRead;
  const staleReadStarted = new Promise(resolve => { signalStaleRead = resolve; });
  repo.readMap = async path => { if (path === stalePath) { signalStaleRead(); await new Promise(resolve => { releaseStale = resolve; }); } return readMap(path); };
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, ready: Promise.resolve(), mutate: async work => work(), closeStaleDetails() {}, syncOutline() {}, releaseOutline() {} };
  const app = { workspace: { requestSaveLayout() {} } };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, plugin);
  view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {}; view.path = currentPath; let renders = 0; view.render = () => { renders++; };
  const staleOpen = view.openMap(stalePath); await staleReadStarted;
  await view.onClose(); await view.onOpen(); await view.openMap(currentPath);
  const rendersAfterCurrentOpen = renders;
  releaseStale(); await staleOpen;
  assert.equal(view.path, currentPath); assert.equal(view.map.title, '新圖載入'); assert.equal(renders, rendersAfterCurrentOpen);
});
integrationTest('AIM shares active run reservation across Manual Flow instances', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'multi-flow-map', topic: '牛排', context: '' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const question = await new AimManualFlow(repo, new AimRunStore(repo), async () => ({ summary: '熟度？', detail: '個人條件。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] })).planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'multi-q');
  let queued = Promise.resolve(); const persist = work => { const current = queued.then(work); queued = current.catch(() => {}); return current; };
  let calls = 0, researchCalls = 0, flowAIds = 0, flowBIds = 0, release; const ask = async context => { calls++; if (aimPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch(); if (aimPhase(context, 'decision-quality-review')) return auditEcho(context); if (aimPhase(context, 'research-plan')) return { summary: '兩個研究面向', detail: '<!-- aim-plan {"subtopics":[{"id":"a","title":"研究 A","task":"查詢 A","expectedValue":"補足 A"},{"id":"b","title":"研究 B","task":"查詢 B","expectedValue":"補足 B"}]} -->', suggestions: [], visualReferences: [] }; if (aimPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: '兩份研究完成後，使用者仍需選擇要採用的實作方向。', question: '下一步想深入哪一項？' }, '熟度條件式結果已整理。', '有依據的條件式報告。', ['研究 A', '研究 B']); researchCalls++; if (researchCalls === 1) return new Promise(resolve => { release = () => resolve({ summary: '條件式結果', detail: '有依據的報告。', suggestions: [], visualReferences: [] }); }); return { summary: '第二份研究結果', detail: '補充有依據的報告', suggestions: [], visualReferences: [] }; };
  const flowA = new AimManualFlow(repo, new AimRunStore(repo), ask, () => `flow-a-${++flowAIds}`, persist);
  const flowB = new AimManualFlow(repo, new AimRunStore(repo), ask, () => `flow-b-${++flowBIds}`, persist);
  const answer = { requestId: 'multi-answer-one', selections: [question.options[0].id], freeText: '' };
  const first = flowA.answerAndResearch(created.mapPath, question.node.id, answer, 'gpt-6-luna', 'low');
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const second = await flowB.answerAndResearch(created.mapPath, question.node.id, answer, 'gpt-6-luna', 'low');
  assert.equal(second.status, 'in-progress'); assert.equal(researchCalls, 1);
  release(); const completed = await first; assert.equal(completed.status, 'waiting-user'); assert.equal(researchCalls, 2);
  const [reservedA, reservedB] = await Promise.all([
    persist(() => new AimRunStore(repo).startAttempt(created.mapPath, completed.branchId)),
    persist(() => new AimRunStore(repo).startAttempt(created.mapPath, completed.branchId))
  ]);
  assert.deepEqual([reservedA.dispatch, reservedB.dispatch].sort(), [false, true]);
});
integrationTest('Visual Map protects the AIM root and allows recoverable question-node removal', async () => {
  const { repo, app } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'protect-map', topic: '牛排', context: '' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const flow = new AimManualFlow(repo, new AimRunStore(repo), async context => aimPhase(context, 'saved-evidence-review') ? savedEvidenceNeedsSearch() : aimPhase(context, 'decision-quality-review') ? auditEcho(context) : context.task.includes('Decide whether one missing user condition') ? { summary: '熟度？', detail: '', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] } : aimPhase(context, 'research-plan') ? { summary: '研究規劃', detail: '<!-- aim-plan {"subtopics":[{"id":"a","title":"食安溫度","task":"查詢安全溫度","expectedValue":"確認安全條件"},{"id":"b","title":"烹調方法","task":"查詢烹調方式","expectedValue":"提供操作步驟"}]} -->', suggestions: [], visualReferences: [] } : aimPhase(context, 'report-review') ? plannerReview('ask_user', { rationale: '完成研究後，使用者的偏好仍會影響實際做法。', question: '下一步想深入哪一項？' }, '研究已整理。', '保留條件式建議。', ['食安溫度', '烹調方法']) : { summary: '研究結果', detail: '報告', suggestions: [], visualReferences: [] });
  const question = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'protect-q');
  await flow.answerAndResearch(created.mapPath, question.node.id, { requestId: 'protect-a', selections: [question.options[0].id], freeText: '' }, 'gpt-6-luna', 'low');
  const map = await repo.readMap(created.mapPath), original = plain(map);
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = created.mapPath; view.map = map; view.render = () => {}; view.hydrate = async () => {}; view.multiSelected = new Set([created.root.id]);
  await assert.rejects(view.removeSelected(), /referenced by saved branches/);
  assert.deepEqual(plain(await repo.readMap(created.mapPath)), original);
  assert.equal((await repo.collectionFiles(created.mapPath, 'Unassigned')).length, 0);
  const questionNode = map.nodes.find(node => node.id === map.aim.branches[0].questionNodeId);
  await view.removeToUnassigned(questionNode, false);
  const after = await repo.readMap(created.mapPath);
  assert.ok(!after.nodes.some(node => node.id === questionNode.id));
  assert.equal(after.aim.branches.length, 0, 'deleting a question removes its stale answer-branch index');
  assert.ok(after.nodes.filter(node => original.nodes.find(item => item.id === node.id)?.parentId === questionNode.id).every(node => node.parentId === null), 'children are kept as roots when only the question is removed');
  const unassigned = await repo.collectionFiles(created.mapPath, 'Unassigned');
  assert.equal(unassigned.length, 1, 'the Markdown note is preserved in Unassigned');
  assert.equal((await repo.readNote(unassigned[0].path)).summary, '熟度？', 'the original question content remains readable after removal');
});
integrationTest('Visual Map wires Manual Planner and answer submissions through the plugin AI and outline refresh boundary', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'manual-wiring-map-1', topic: '如何選擇牛排熟度？', context: '有溫度計。' });
  let askCalls = 0; const outlinedMaps = [];
  const plugin = {
    repo,
    mutate: async work => work(),
    syncOutline: (map, notes) => outlinedMaps.push({ map: plain(map), noteIds: [...notes.keys()] }),
    releaseOutline() {},
    askModel: async (context, _model, _reasoning, _signal, _onExchange, _onAccepted, onWebSearchEvent) => {
      askCalls++;
      if (aimPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
      if (context.task.includes('Decide whether one missing user condition')) return { summary: '偏好熟度為何？', detail: '熟度是使用者條件。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] };
      if (aimPhase(context, 'research-plan')) return { summary: '拆成食安與口感兩個研究面向。', detail: '<!-- aim-plan {"subtopics":[{"id":"safety","title":"安全溫度","task":"查詢牛排安全溫度","expectedValue":"釐清食安下限"},{"id":"texture","title":"口感差異","task":"比較熟度口感","expectedValue":"呈現口感取捨"}]} -->\n兩項互補研究。', suggestions: [], visualReferences: [] };
      if (aimPhase(context, 'decision-quality-review')) return auditEcho(context);
      if (aimPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: '報告可以支持條件式答案，但使用者還需選擇偏好的方向。', question: '接下來想深入哪一項？' }, '依本人熟度偏好提供條件式建議。', '來源與限制依 Agent 報告記錄。', ['安全溫度', '口感差異']);
      onWebSearchEvent?.({ method: 'item/completed', params: { item: { id: 'fixture-search', type: 'webSearch', action: { type: 'search' } } } });
      return { summary: '依本人熟度偏好提供條件式建議。', detail: '來源與限制依 Agent 報告記錄。', suggestions: [], visualReferences: [] };
    }
  };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.path = created.mapPath; view.map = created.map; view.notes.set(created.root.id, await repo.readNote(created.root.path));
  view.render = () => {};
  const planned = await view.planAimQuestion(created.root.id, 'manual-wiring-question-1');
  assert.equal(planned.status, 'question');
  const answered = await view.submitAimAnswer(planned.node.id, { requestId: 'manual-wiring-answer-1', selections: [planned.options[0].id], freeText: '約 1.5 吋。' });
  assert.equal(answered.status, 'waiting-user'); assert.equal(askCalls, 5); assert.ok(outlinedMaps.length >= 2);
  assert.equal(view.map.aim.branches.length, 1);
  const branch = view.map.aim.branches[0], researchRefs = branch.results.filter(item => item.kind === 'research');
  const conclusionRef = branch.results.find(item => item.kind === 'synthesis');
  assert.equal(researchRefs.length, 2);
  assert.equal(view.map.nodes.find(node => node.id === conclusionRef.nodeId).aimKind, 'synthesis');
  assert.ok(view.map.nodes.some(node => node.id === answered.questionNodeId && node.parentId === conclusionRef.nodeId && !node.aimConvergesFromNodeIds?.length), 'the next question is a child of synthesis without dashed convergence edges');
  assert.ok(outlinedMaps.some(entry => researchRefs.every(ref => entry.map.nodes.some(node => node.id === ref.nodeId && node.aimKind === 'research'))));
});
integrationTest('Visual Map permits telemetry gaps but keeps an explicit no-search Agent report incomplete', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const makeCase = async (suffix, report, shouldComplete) => {
    const created = await createAimMap(repo, 'gpt-6-luna', { requestId: `search-status-map-${suffix}`, topic: `牛排熟度 ${suffix}`, context: '' });
    const planner = new AimManualFlow(repo, new AimRunStore(repo), async () => ({ summary: '想要哪種熟度？', detail: '', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }));
    const planned = await planner.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', `search-status-question-${suffix}`);
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, mutate: async work => work(), syncOutline() {}, releaseOutline() {}, askModel: async context => aimPhase(context, 'saved-evidence-review') ? savedEvidenceNeedsSearch() : aimPhase(context, 'decision-quality-review') ? auditEcho(context) : aimPhase(context, 'research-plan')
      ? { summary: '兩個研究面向', detail: '<!-- aim-plan {"subtopics":[{"id":"safety","title":"食安依據","task":"查詢安全溫度","expectedValue":"確認安全條件"},{"id":"method","title":"操作方法","task":"查詢料理方式","expectedValue":"補足操作步驟"}]} -->', suggestions: [], visualReferences: [] }
      : aimPhase(context, 'report-review') ? plannerReview('ask_user', { rationale: '牛排厚度會改變加熱時間和溫度控制，無法從已提供的偏好推斷。', question: '牛排大約有多厚？' }, '來源報告提供熟度限制；請補充厚度以細化操作建議。', '在得知厚度前不推定固定時間。', ['薄於 2 公分', '約 2–4 公分', '厚於 4 公分'])
      : context.researchMode === 'local' ? plannerReview('conclude', { rationale: '既有條件足夠。', stopReason: '不需要新增問題。' }, '條件式結論', '保留限制。') : report };
    const view = new VisualAgentMapView({ app: {} }, plugin);
    view.path = created.mapPath; view.map = await repo.readMap(created.mapPath); view.notes.set(planned.node.id, await repo.readNote(planned.node.path)); view.render = () => {};
    const input = { requestId: `search-status-answer-${suffix}`, selections: [planned.options[0].id], freeText: '' };
    let diagnosticPath = '';
    const updateNote = repo.updateNote.bind(repo);
    if (!shouldComplete) repo.updateNote = async (notePath, patch) => {
      if (patch.status === 'error' && patch.detail?.includes('AIM incomplete-attempt diagnostic')) diagnosticPath = notePath;
      return updateNote(notePath, patch);
    };
    if (shouldComplete) {
      const outcome = await view.submitAimAnswer(planned.node.id, input); assert.equal(outcome.status, 'waiting-user');
    } else {
      await assert.rejects(view.submitAimAnswer(planned.node.id, input), /explicitly says no web search succeeded/);
      repo.updateNote = updateNote;
    }
    const saved = await repo.readMap(created.mapPath), branch = saved.aim.branches[0];
    if (shouldComplete) { assert.equal(branch.results.filter(item => item.kind === 'research').length, 2); assert.equal(branch.results.find(item => item.kind === 'synthesis').kind, 'synthesis'); assert.ok(saved.aim.runs.every(run => run.attempts[0].status === 'completed')); }
    else {
      assert.equal(branch.results.length, 0); assert.equal(saved.aim.runs[0].attempts[0].status, 'failed'); assert.equal(saved.aim.resultDrafts.length, 0);
      assert.ok(diagnosticPath, 'the unusable report remains visible as a Repository error diagnostic');
      const diagnostic = await repo.readNote(diagnosticPath); assert.equal(diagnostic.status, 'error'); assert.match(diagnostic.detail, /incomplete-attempt diagnostic/); assert.match(diagnostic.detail, /Research status: not searched/);
    }
  };
  await makeCase('explicit-miss', { summary: 'Research status: not searched — the search service was unavailable.', detail: 'No external search was completed.', suggestions: [], visualReferences: [] }, false);
  await makeCase('telemetry-gap', { summary: 'Useful report with conditional findings.', detail: 'The report contains useful findings and limits but no status telemetry was delivered.', suggestions: [], visualReferences: [] }, true);
});
integrationTest('AIM persists cancellation and fences late draft/result writes', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-cancelled');
  const draft = (await store.createResultDraft(mapPath, attempt, '待取消結果', 'gpt-6-luna')).draft;
  assert.equal(await store.cancelAttempt(mapPath, attempt, 'User cancelled after runtime interrupt.'), true);
  let savedMap = await repo.readMap(mapPath);
  assert.equal(savedMap.aim.runs[0].attempts[0].status, 'cancelled');
  assert.equal(savedMap.aim.runs[0].attempts[0].stopReason, 'User cancelled after runtime interrupt.');
  assert.equal(savedMap.aim.resultDrafts.length, 0);
  assert.equal(savedMap.aim.branches[0].results.length, 0);
  assert.equal(savedMap.nodes.some(node => node.id === draft.nodeId), false);
  const diagnostic = await repo.readNote(draft.notePath);
  assert.equal(diagnostic.status, 'error');
  assert.match(diagnostic.detail, /User cancelled after runtime interrupt/);
  assert.deepEqual(plain(await store.createResultDraft(mapPath, attempt, '晚到結果不得建立', 'gpt-6-luna')), { status: 'stale', runId: 'run-cancelled', attemptId: 'attempt-1' });
  assert.deepEqual(plain(await store.commitResult(mapPath, attempt, draft.id, { summary: 'late result', detail: 'must not publish' })), { status: 'stale', runId: 'run-cancelled', attemptId: 'attempt-1' });
  savedMap = await repo.readMap(mapPath);
  assert.equal(savedMap.aim.runs[0].attempts[0].status, 'cancelled');
  assert.equal(savedMap.aim.branches[0].results.length, 0);
  assert.notEqual((await repo.readNote(draft.notePath)).summary, 'late result');
});
integrationTest('Visual Map reopen recovers a pending Note/Map commit and marks a stopped runtime as failed without rerunning', async () => {
  const { repo, app, mapPath, question, store } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-reopen-save');
  const draft = (await store.createResultDraft(mapPath, attempt, '重開後提交修復', 'gpt-6-luna')).draft;
  const saveMap = repo.saveMap.bind(repo); let saveCalls = 0;
  repo.saveMap = async (...args) => { if (++saveCalls === 2) throw new Error('injected interruption after pending Note write'); return saveMap(...args); };
  await assert.rejects(store.commitResult(mapPath, attempt, draft.id, { summary: 'saved summary', detail: 'Searcher report and Planner conclusion.' }), /injected interruption/);
  repo.saveMap = saveMap; store.releaseAttempt(mapPath, attempt);
  app.workspace = { requestSaveLayout() {} };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, mutate: async work => work(), closeStaleDetails() {}, syncOutline() {}, releaseOutline() {} };
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.hydrate = async () => {};
  await view.openMap(mapPath);
  let saved = await repo.readMap(mapPath), committed = saved.aim.branches[0].results[0];
  assert.ok(committed); assert.equal(saved.aim.runs[0].attempts[0].status, 'completed');
  assert.equal(saved.aim.pendingCommits.length, 0); assert.equal((await repo.readNote(committed.notePath)).detail, 'Searcher report and Planner conclusion.');

  const interrupted = await store.startAttempt(mapPath, branch.id, 'run-app-exit');
  const interruptedDraft = (await store.createResultDraft(mapPath, interrupted, 'App 結束前未完成', 'gpt-6-luna')).draft;
  store.releaseAttempt(mapPath, interrupted);
  await view.openMap(mapPath);
  saved = await repo.readMap(mapPath);
  const stopped = saved.aim.runs.find(run => run.id === 'run-app-exit').attempts[0];
  assert.equal(stopped.status, 'failed'); assert.match(stopped.stopReason, /Retry is available/);
  assert.equal(saved.aim.resultDrafts.some(item => item.id === interruptedDraft.id), false);
  assert.equal(saved.nodes.some(node => node.id === interruptedDraft.nodeId), false);
  assert.equal((await repo.readNote(interruptedDraft.notePath)).status, 'error');
});
integrationTest('Visual Map close cancels unfinished AIM work but lets an already-started subtopic commit finish', async () => {
  const makeQuestion = async () => {
    const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
    const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'close-save-map', topic: '牛排熟度', context: '' });
    const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
    const planner = new AimManualFlow(repo, new AimRunStore(repo), async () => ({ summary: '偏好熟度？', detail: '由使用者決定。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }));
    const planned = await planner.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'close-save-question');
    return { repo, mapPath: created.mapPath, question: planned.node };
  };
  const { repo, mapPath, question } = await makeQuestion();
  let releaseSearcher, searcherStarted; const searcherReady = new Promise(resolve => { searcherStarted = resolve; });
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, mutate: async work => work(), syncOutline() {}, releaseOutline() {},
    askModel: async (context, _model, _reasoning, _signal, _onExchange, _onAccepted, onWebSearchEvent) => {
      if (aimPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
      if (aimPhase(context, 'research-plan')) return { summary: '安全與操作面向', detail: '<!-- aim-plan {"subtopics":[{"id":"a","title":"安全溫度","task":"查詢安全溫度","expectedValue":"保留安全條件"},{"id":"b","title":"烹調方法","task":"查詢烹調方法","expectedValue":"提供實作方式"}]} -->', suggestions: [], visualReferences: [] };
      if (aimPhase(context, 'decision-quality-review')) return auditEcho(context);
      if (aimPhase(context, 'report-review')) return plannerReview('conclude', { rationale: '兩份報告足以整理本次答案。', stopReason: '完成指定收斂。' }, '條件式結論', '保存邊界測試。');
      if (context.researchMode === 'research') { onWebSearchEvent?.({ method: 'item/completed', params: { item: { id: 'fixture-search', type: 'webSearch', action: { type: 'search' } } } }); searcherStarted(); return new Promise(resolve => { releaseSearcher = () => resolve({ summary: '晚到研究摘要', detail: '關閉後不應發布的報告。', suggestions: [], visualReferences: [] }); }); }
      return plannerReview('conclude', { rationale: 'The report supports the controlled persistence conclusion.', stopReason: 'The answer is sufficiently supported.' }, '條件式結論', '保存邊界測試。');
    } };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app: {} }, plugin);
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.notes.set(question.id, await repo.readNote(question.path)); view.render = () => {};
  const controller = new AbortController(); view.aimController = controller; view.aimBusy = true;
  const cancelled = view.submitAimAnswer(question.id, { requestId: 'close-during-searcher', selections: [question.aimQuestion.options[0].id], freeText: '' }, controller.signal);
  await searcherReady; await view.onClose(); releaseSearcher();
  await assert.rejects(cancelled, error => error?.name === 'AbortError');
  let saved = await repo.readMap(mapPath);
  assert.equal(saved.aim.runs[0].attempts[0].status, 'cancelled');
  assert.equal(saved.aim.branches[0].results.length, 0);
  assert.equal(saved.aim.resultDrafts.length, 0);

  const second = await makeQuestion(); let releaseCommit, commitStarted;
  const commitReady = new Promise(resolve => { commitStarted = resolve; });
  const updateNote = second.repo.updateNote.bind(second.repo);
  second.repo.updateNote = async (path, patch) => {
    if (patch.status === 'completed') { commitStarted(); await new Promise(resolve => { releaseCommit = resolve; }); }
    return updateNote(path, patch);
  };
  const commitPlugin = { repo: second.repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, mutate: async work => work(), syncOutline() {}, releaseOutline() {},
    askModel: async (context, _model, _reasoning, _signal, _onExchange, _onAccepted, onWebSearchEvent) => aimPhase(context, 'saved-evidence-review') ? savedEvidenceNeedsSearch() : aimPhase(context, 'research-plan')
      ? { summary: '安全與操作面向', detail: '<!-- aim-plan {"subtopics":[{"id":"a","title":"安全溫度","task":"查詢安全溫度","expectedValue":"保留安全條件"},{"id":"b","title":"烹調方法","task":"查詢烹調方法","expectedValue":"提供實作方式"}]} -->', suggestions: [], visualReferences: [] }
      : aimPhase(context, 'decision-quality-review') ? auditEcho(context)
      : aimPhase(context, 'report-review') ? plannerReview('conclude', { rationale: '兩份報告足以整理本次答案。', stopReason: '完成原子提交。' }, '保存中的結論', '完成原子提交。')
      : (onWebSearchEvent?.({ method: 'item/completed', params: { item: { id: 'fixture-search', type: 'webSearch', action: { type: 'search' } } } }), { summary: '已回傳報告', detail: 'Searcher report。', suggestions: [], visualReferences: [] }) };
  const savingView = new VisualAgentMapView({ app: {} }, commitPlugin); savingView.path = second.mapPath; savingView.map = await second.repo.readMap(second.mapPath); savingView.notes.set(second.question.id, await second.repo.readNote(second.question.path)); savingView.render = () => {};
  const saveController = new AbortController(); savingView.aimController = saveController; savingView.aimBusy = true;
  const saving = savingView.submitAimAnswer(second.question.id, { requestId: 'close-during-result-commit', selections: [second.question.aimQuestion.options[0].id], freeText: '' }, saveController.signal);
  await commitReady; await savingView.onClose(); releaseCommit();
  await assert.rejects(saving, error => error?.name === 'AbortError'); saved = await second.repo.readMap(second.mapPath);
  assert.equal(saved.aim.runs[0].attempts[0].status, 'completed', 'closing does not revoke a subtopic save already in its commit section');
  assert.equal(saved.aim.pendingCommits.length, 0); assert.equal(saved.aim.branches[0].results.length, 1);
});
integrationTest('AIM serializes cancellation against an in-flight runtime result save', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-cancel-save-race');
  const draft = (await store.createResultDraft(mapPath, attempt, '受控 runtime 結果', 'gpt-6-luna')).draft;
  let releaseWrite;
  let announceWrite;
  const writeStarted = new Promise(resolve => { announceWrite = resolve; });
  const holdWrite = new Promise(resolve => { releaseWrite = resolve; });
  const updateNote = repo.updateNote.bind(repo);
  repo.updateNote = async (...args) => { announceWrite(); await holdWrite; return updateNote(...args); };
  const runtimeResult = Promise.resolve({ summary: 'controlled runtime result', detail: 'A result returned before cancellation acquired the store lock.' });
  const commit = runtimeResult.then(result => store.commitResult(mapPath, attempt, draft.id, result));
  await writeStarted;
  const cancel = store.cancelAttempt(mapPath, attempt, 'Cancellation requested while result save was in progress.');
  releaseWrite();
  const committed = await commit;
  const cancelled = await cancel;
  repo.updateNote = updateNote;

  assert.equal(committed.status, 'committed');
  assert.equal(cancelled, false, 'the store treats a save already in its commit section as committed before cancellation takes effect');
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(draft.notePath);
  assert.equal(savedMap.aim.runs[0].attempts[0].status, 'completed');
  assert.equal(savedMap.aim.pendingCommits.length, 0);
  assert.equal(savedMap.aim.resultDrafts.length, 0);
  assert.equal(savedMap.aim.branches[0].results.length, 1);
  assert.equal(savedMap.aim.branches[0].results[0].notePath, draft.notePath);
  assert.equal(savedNote.status, 'completed');
  assert.equal(savedNote.summary, 'controlled runtime result');
  assert.equal(savedNote.detail, 'A result returned before cancellation acquired the store lock.');
});
integrationTest('AIM persists a runtime initialization blocker as failed and fences late publication', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '合成答案' }, inputSnapshot: { topic: '牛排', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-runtime-blocked');
  const beforeRuntime = await repo.readMap(mapPath);
  assert.equal(beforeRuntime.nodes.length, 1, 'the answer remains on the question; no answer pivot is created');
  assert.equal(beforeRuntime.nodes[0].aimKind, undefined);
  const unrelated = await repo.createNote('既有無關筆記', 'gpt-6-luna', await repo.readMap(mapPath), mapPath, 'workspace', { summary: '保留原內容' });
  await repo.updateNote(unrelated.path, { detail: '既有正文不可覆蓋' });
  await assert.rejects(store.commitResult(mapPath, attempt, unrelated.path, { summary: 'must stay absent', detail: 'no publication after startup block' }), /fresh, registered result draft/);
  assert.equal(await store.failAttempt(mapPath, attempt, 'Codex runtime 初始化被執行環境拒絕；未 dispatch thread/turn。'), true);
  assert.equal((await store.commitResult(mapPath, attempt, unrelated.path, { summary: 'late output', detail: 'must remain fenced' })).status, 'stale');
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(unrelated.path);
  assert.equal(savedMap.aim.runs[0].attempts[0].status, 'failed');
  assert.match(savedMap.aim.runs[0].attempts[0].stopReason, /未 dispatch thread\/turn/);
  assert.equal(savedNote.summary, '保留原內容'); assert.equal(savedNote.detail, '既有正文不可覆蓋');
});
integrationTest('AIM recovers an interrupted result-draft creation idempotently', async () => {
  const { repo, mapPath, question, store, files } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '合成答案' }, inputSnapshot: { topic: '牛排', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-draft-recovery');
  const realSaveMap = repo.saveMap.bind(repo); let mapWrites = 0;
  repo.saveMap = async (...args) => { mapWrites++; if (mapWrites === 2) throw new Error('simulated interruption after draft Note creation'); return realSaveMap(...args); };
  await assert.rejects(store.createResultDraft(mapPath, attempt, '結果草稿', 'gpt-6-luna'), /simulated interruption/);
  repo.saveMap = realSaveMap;
  store.releaseAttempt(mapPath, attempt);
  const pending = await repo.readMap(mapPath), draft = pending.aim.resultDrafts[0];
  assert.equal(draft.status, 'creating'); assert.ok(files.has(draft.notePath));
  let expensiveResearchRuns = 1;
  const recovered = plain(await store.recoverPending(mapPath));
  assert.deepEqual(recovered, { recovered: [draft.id], stale: [] });
  assert.equal(expensiveResearchRuns, 1);
  assert.equal((await repo.readMap(mapPath)).aim.resultDrafts[0].status, 'ready');
  assert.equal(Array.from(files.keys()).filter(path => path === draft.notePath).length, 1);
  assert.deepEqual(plain(await store.recoverPending(mapPath)), { recovered: [], stale: [] });
  const retry = await store.startAttempt(mapPath, branch.id, 'run-draft-recovery');
  assert.equal(retry.attemptId, 'attempt-2');
  const retired = await repo.readNote(draft.notePath);
  assert.equal(retired.status, 'error'); assert.match(retired.detail, /stale-attempt diagnostic/);
  assert.equal((await repo.readMap(mapPath)).nodes.some(node => node.id === draft.nodeId), false);
});
integrationTest('AIM retires an attempt-scoped draft if another store supersedes it after Note creation', async () => {
  const { repo, mapPath, question, store, files } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-concurrent-supersede');
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const secondStore = new AimRunStore(repo, () => 'other-store-id');
  const createNoteAt = repo.createNoteAt.bind(repo);
  repo.createNoteAt = async (...args) => { const node = await createNoteAt(...args); await secondStore.startAttempt(mapPath, branch.id, 'run-concurrent-supersede'); return node; };
  const creation = await store.createResultDraft(mapPath, attempt, '舊回覆', 'gpt-6-luna');
  repo.createNoteAt = createNoteAt;
  assert.equal(creation.status, 'stale');
  const notePath = Array.from(files.keys()).find(item => item.endsWith('/Notes/舊回覆.md'));
  assert.ok(notePath);
  const diagnostic = await repo.readNote(notePath), savedMap = await repo.readMap(mapPath);
  assert.equal(diagnostic.status, 'error'); assert.match(diagnostic.detail, /stale-attempt diagnostic/);
  assert.equal(savedMap.nodes.some(node => node.path === notePath), false);
  assert.equal(savedMap.aim.branches[0].results.length, 0);
  assert.equal(savedMap.aim.resultDrafts.length, 0);
});
integrationTest('AIM recovers a Map commit interrupted after its Note was written without rerunning research', async () => {
  const { repo, mapPath, question, store, files } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['鑄鐵鍋'], freeText: '沒有烤箱' }, inputSnapshot: { topic: '在家煎牛排', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-recovery');
  const result = (await store.createResultDraft(mapPath, attempt, '研究結果', 'gpt-6-luna')).draft;
  const realSaveMap = repo.saveMap.bind(repo); let mapWrites = 0;
  repo.saveMap = async (...args) => { mapWrites++; if (mapWrites === 2) throw new Error('simulated interruption after Note persistence'); return realSaveMap(...args); };
  await assert.rejects(store.commitResult(mapPath, attempt, result.id, { summary: 'stored result', detail: 'conditional report' }), /simulated interruption/);
  repo.saveMap = realSaveMap;
  const pending = await repo.readMap(mapPath);
  assert.equal(pending.aim.pendingCommits.length, 1);
  assert.equal((await repo.readNote(result.notePath)).summary, 'stored result');
  let expensiveResearchRuns = 1;
  const recovered = plain(await store.recoverPending(mapPath));
  assert.deepEqual(recovered, { recovered: ['result-run-recovery-attempt-1'], stale: [] });
  assert.equal(expensiveResearchRuns, 1);
  const repeated = plain(await store.recoverPending(mapPath)); assert.deepEqual(repeated, { recovered: [], stale: [] });
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(result.notePath);
  assert.equal(savedMap.aim.pendingCommits.length, 0);
  assert.equal(savedMap.aim.branches[0].results.length, 1);
  assert.equal(savedNote.summary, 'stored result'); assert.equal(savedNote.detail, 'conditional report');
  assert.equal(Array.from(files.keys()).filter(path => path === result.notePath).length, 1);
});

test('AIM content language detector follows the character rules; Japanese and Korean are detected, no signal falls back to the interface language', () => {
  const { detectAimContentLanguage, chooseAimContentLanguage, resolveAimContentLanguage } = load('experiences/aim/content-language.ts');
  const cases = [
    ['東京五天自由行怎麼排', 'zh-TW'], ['Plan a 5-day Taipei trip', 'same-as-input'], ['Python 的 async 怎麼用', 'zh-TW'],
    ['What does 侘寂 mean', 'same-as-input'], ['东京五天自由行怎么排', 'zh-CN'], ['東京ラーメンの旅', 'ja'], ['東京の旅行', 'zh-TW'], ['한국 여행', 'ko'], ['🍜', undefined], ['2026', undefined], ['', undefined]
  ];
  for (const [text, expected] of cases) assert.equal(detectAimContentLanguage(text), expected, text);
  for (const ui of ['en', 'zh-TW']) {
    assert.equal(chooseAimContentLanguage(ui, '東京ラーメンの旅'), 'ja');
    assert.equal(chooseAimContentLanguage(ui, '東京ラーメンの旅', '中文內容'), 'ja', 'Japanese topic must not fall through to a later source');
    assert.equal(chooseAimContentLanguage(ui, '🍜', ''), ui);
    assert.equal(chooseAimContentLanguage(ui, '2026', '中文背景'), 'zh-TW');
    assert.equal(chooseAimContentLanguage(ui, '2026', 'Some English context'), 'same-as-input');
    assert.equal(chooseAimContentLanguage(ui, 'Plan a trip', '中文背景'), 'same-as-input', 'topic wins over context');
  }
  // Stored value wins; maps without one (legacy and upgraded mindSearch maps) derive from the title; no map falls back to the UI language.
  assert.equal(resolveAimContentLanguage({ title: 'Plan a trip', aim: { contentLanguage: 'zh-TW' } }, 'en'), 'zh-TW');
  assert.equal(resolveAimContentLanguage({ title: '東京五天自由行', aim: { version: 1 } }, 'en'), 'zh-TW');
  assert.equal(resolveAimContentLanguage({ title: 'Plan a trip' }, 'zh-TW'), 'same-as-input');
  assert.equal(resolveAimContentLanguage({ title: '🍜' }, 'zh-TW'), 'zh-TW');
  assert.equal(resolveAimContentLanguage(undefined, 'en'), 'en');
});
integrationTest('AIM start stores the content language once and keeps it when the interface language changes', async () => {
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const cases = [
    { ui: 'en', topic: '東京五天自由行怎麼排', context: '', expected: 'zh-TW', heading: '## 使用者提供的背景' },
    { ui: 'zh-TW', topic: 'Plan a 5-day Taipei trip', context: '', expected: 'en', heading: '## User-provided context' },
    { ui: 'zh-TW', topic: '2026', context: 'Budget is limited', expected: 'en', heading: '## User-provided context' },
    { ui: 'en', topic: '東京の旅行', context: '', expected: 'en', heading: '## User-provided context' }
  ];
  for (const [index, item] of cases.entries()) {
    const { repo } = fixture(item.ui);
    const input = { requestId: `content-language-${index}`, topic: item.topic, context: item.context || 'Some details', model: 'gpt-6-luna', reasoning: 'low', outcomeExpectation: { goal: 'execute', description: '', formats: ['steps'] } };
    const created = await createAimMap(repo, 'gpt-6-luna', input);
    assert.equal((await repo.readMap(created.mapPath)).aim.contentLanguage, item.expected, item.topic);
    const note = await repo.readNote(created.root.path);
    assert.ok(note.detail.startsWith(item.heading), note.detail);
    assert.ok(note.detail.includes(item.expected === 'en' ? 'User-provided outcome expectation' : '使用者提供的成果期待'));
    repo.settings.language = item.ui === 'en' ? 'zh-TW' : 'en';
    const again = await createAimMap(repo, 'gpt-6-luna', input);
    assert.equal((await repo.readMap(again.mapPath)).aim.contentLanguage, item.expected, 'resume keeps the stored value');
  }
});
async function aimChildModel(rootModel, cliModel) {
  const { repo } = fixture(); repo.settings.cliModel = 'gpt-5.6-luna';
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, rootModel, { requestId: `aim-model-${rootModel}`, topic: '如何安排一週的居家運動？', context: '', model: rootModel, reasoning: 'low' });
  repo.settings.cliModel = cliModel;
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const question = await new AimManualFlow(repo, new AimRunStore(repo), async () => ({ summary: '熟度？', detail: '個人條件。', suggestions: [{ title: 'A' }, { title: 'B' }], visualReferences: [] })).planNextQuestion(created.mapPath, created.root.id, rootModel, 'low', 'model-q');
  const map = await repo.readMap(created.mapPath);
  return { repo, created, question, map, rootNote: await repo.readNote(created.root.path, map), childNote: await repo.readNote(question.node.path, map) };
}
integrationTest('AIM children follow a manually chosen AIM start model and otherwise the current workspace model', async () => {
  const manual = await aimChildModel('claude:opus', 'claude:sonnet');
  assert.equal(manual.rootNote.modelSource, 'manual'); assert.equal(manual.childNote.modelSource, 'inherited');
  assert.equal(manual.childNote.model, 'claude:opus', 'questions, retries and follow-ups run on the AIM start model');
  assert.equal((await manual.repo.readNote(manual.question.node.path)).model, 'claude:opus', 'also without a map in hand');
  const workspace = await aimChildModel('gpt-5.6-luna', 'claude:sonnet');
  assert.equal(workspace.rootNote.modelSource, 'workspace'); assert.equal(workspace.childNote.model, 'claude:sonnet');
});
integrationTest('AIM partial continuation runs on the question note model, not the old attempt model', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const calls = [];
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...DEFAULT_SETTINGS }, mutate: async work => work(), repo: { readMap: async () => { throw new Error('stop'); } } });
  view.path = 'Map.md'; view.closed = false; view.builtIn = false; view.aimViewEpoch = 1; view.render = () => {}; view.aimViewIsCurrent = () => false;
  view.map = { aim: { runs: [{ id: 'run-1', branchId: 'b1' }], branches: [{ id: 'b1', questionNodeId: 'q1' }] } };
  view.notes = new Map([['q1', { model: 'claude:sonnet', reasoning: 'high' }]]);
  view.aimManual = { continuePartial: async (...args) => { calls.push(args.slice(0, 4)); return { status: 'partial' }; } };
  await view.continueAimResearch('q1', 'run-1');
  assert.deepEqual(plain(calls), [['Map.md', 'run-1', 'claude:sonnet', 'high']]);
});
