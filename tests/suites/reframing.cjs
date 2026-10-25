const assert = require('node:assert/strict');
const { test, integrationTest, load, core, map, withExpansionCoordinator, obsidian, DEFAULT_SETTINGS, fixture, topicNote, coffeeSession, deferred, until, coffeeFind, reframingModalFixture } = require('../support.cjs');
test('Reframing validates structured output and rejects whole-request over-budget without truncation', async () => {
  const { ReframingService, buildReframePrompt, REFRAME_SCHEMA, REFRAME_TOKEN_BUDGET } = load('core/reframing-service.ts');
  const calls = [];
  const service = new ReframingService(async (request) => { calls.push(request); return JSON.stringify({ question: 'What evidence distinguishes these explanations?', context: 'Simulated analogy; alternatives and uncertainty remain.', rationale: 'Test the key tension.' }); });
  const request = { targetCore: 'understand', source: 'Candidate insight, not evidence', question: 'Explore this', context: '', language: 'en', model: 'model-a', reasoning: 'low' };
  const result = await service.reframe(request, new AbortController().signal);
  assert.match(result.context, /uncertainty/); assert.equal(calls.length, 1);
  assert.match(buildReframePrompt(request), /Candidate insight/); assert.equal(REFRAME_SCHEMA.additionalProperties, false);
  await assert.rejects(service.reframe({ ...request, source: 'x'.repeat(REFRAME_TOKEN_BUDGET * 4 + 1) }, new AbortController().signal), /budget|large/i); assert.equal(calls.length, 1);
  const invalid = new ReframingService(async () => '{"question":"q","context":"c","rationale":"r","path":"invented"}');
  await assert.rejects(invalid.reframe(request, new AbortController().signal), /invalid/i);
});
test('Coffee reframing snapshots exclude drafts/style and never turn ambiguous excerpts into provenance', () => {
  const { buildCoffeeSource, coffeeCommittedKey } = load('experiences/coffee-tables/handoff-source.ts');
  const session = { ...coffeeSession(), status: 'completed', rounds: [{id:'r1',status:'completed',createdAt:'now',markdown:'Unique line. Repeat phrase.',notes:''}, {id:'r2',status:'completed',createdAt:'now',markdown:'Repeat phrase.',notes:''}], transcriptMarkdown:'Unique line. Repeat phrase.\nRepeat phrase.', draftMarkdown:'UNFINISHED', observerDraftMarkdown:'DRAFT NOTES', dirtyNotes:true, guests: {...coffeeSession().guests,background:'Provided background',stylePrompt:'STYLE INSTRUCTION',customPrompt:'CUSTOM STYLE'}, observerNotes:['# Observer’s notes\n\n## Unexpected connections\n- Candidate analogy <!-- coffee-insight:v1:id=idea --> <!-- source: Unique line. -->\n  - Context: Important limits'] };
  const whole = buildCoffeeSource(session); assert.match(whole.content, /Provided background/); assert.match(whole.content, /Unique line/); assert.doesNotMatch(whole.content, /UNFINISHED|DRAFT NOTES|STYLE INSTRUCTION|CUSTOM STYLE/); assert.match(whole.sourceSnapshot, /Important limits/);
  const single = buildCoffeeSource(session, 'idea'); assert.match(single.content, /Unique line/); assert.match(single.content, /not.*updated|stale/i);
  const changed = {...session, observerNotes:[session.observerNotes[0].replace('Unique line.', 'Repeat phrase.')]}; const ambiguous = buildCoffeeSource(changed, 'idea'); assert.match(ambiguous.content, /unresolved|not.*located/i);
  assert.notEqual(coffeeCommittedKey(session), coffeeCommittedKey(changed));
});
integrationTest('Thinking Origin survives managed updates and hostile Markdown headings', async () => {
  const { repo } = fixture('en');
  const mapPath = await repo.createMap('Origin'); const map = await repo.readMap(mapPath);
  const origin = 'Original framing\n\n## Detail\n```md\n<!-- visual-agent-map:detail:end -->\n```\n### Limits\nNot verified';
  const n = await repo.createNote('Question', 'm', map, mapPath, 'manual', {detail:'Editable framing',thinkingOrigin:origin});
  assert.equal((await repo.readNote(n.path)).thinkingOrigin, origin);
  await repo.updateNote(n.path,{detail:'New research',summary:'Updated summary',preview:'User preview'});
  assert.equal((await repo.readNote(n.path)).thinkingOrigin,origin); assert.equal((await repo.readNote(n.path)).detail,'New research');
});
test('Visual Map origin is source context including decomposition and rejects silent omission', () => {
  const { withThinkingOrigin } = load('experiences/visual-map/thinking-origin.ts');
  const context = {title:'Question',summary:'',detail:'',task:'Expand',ancestors:'',rules:'',mode:'decompose',sourceContext:'Selected sources'};
  const joined = withThinkingOrigin(context, {thinkingOrigin:'Candidate analogy with limits'});
  assert.match(joined.sourceContext, /Selected sources/); assert.match(joined.sourceContext,/Candidate analogy/); assert.equal(joined.rules,'');
  const prepared = load('ai/context-builder.ts').buildPreparedTaskContext(joined,'m'); assert.match(prepared.context.sourceContext,/Candidate analogy/);
});
// Owner decision 2026-10-19: the dialog hides once AI starts; Stop moves to the status bar; late results are dropped.
const handoffField=(modal,label)=>coffeeFind(modal.contentEl,e=>e.attrs['aria-label']===label);
const organizeButton=modal=>coffeeFind(modal.contentEl,e=>e.text==='Organize with AI');
integrationTest('Coffee reframing: the dialog hides once AI starts, Stop drops late results and reopening keeps the original inputs', async () => {
  const data=await reframingModalFixture('idea'),{modal,plugin,handoff,notices,modals}=data;const pending=deferred();let request;
  plugin.core.reframing={reframe:(input,signal)=>{request={input,signal};return pending.promise;}};
  const context=handoffField(modal,'Research context'),old=context.value,question=handoffField(modal,'Research question'),oldQuestion=question.value;
  organizeButton(modal).onclick();await until(()=>request);
  // The dialog is hidden, hiding it does not abort, and the plugin task (not the dialog) owns the run.
  assert.equal(modal.didClose,true);assert.equal(request.signal.aborted,false);assert.equal(plugin.activeTasks.size,1);
  const task=handoff.coffeeHandoffTask(plugin,data.session.id);assert.equal(task.state,'running');assert.equal(task.inputs.question,oldQuestion);
  handoff.stopCoffeeHandoff(plugin,task);
  assert.equal(request.signal.aborted,true);assert.equal(plugin.activeTasks.size,0);assert.equal(task.state,'stopped');
  pending.resolve({question:'late',context:'late result',rationale:'late'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(task.draft,undefined);assert.equal(context.value,old);assert.equal(notices.length,0);assert.equal(data.opened.length,0);assert.equal(modals.length,1);
  // Reopening after Stop restores the original inputs and says it stopped; nothing was written.
  const reopened=await handoff.reopenCoffeeHandoff(plugin,task);
  assert.equal(modals.length,2);assert.equal(handoffField(reopened,'Research context').value,old);assert.equal(handoffField(reopened,'Research question').value,oldQuestion);assert.match(reopened.status.text,/Stopped/);
  assert.equal(handoff.coffeeHandoffTask(plugin,data.session.id),undefined);assert.equal((await data.repo.mapFiles()).length,0);
  // A failure after the dialog hid becomes a Notice and a failed entry; the reopened dialog keeps the inputs.
  plugin.core.reframing={reframe:async()=>{throw Error('invalid response');}};
  organizeButton(reopened).onclick();await until(()=>handoff.coffeeHandoffTask(plugin,data.session.id)?.state==='failed');
  assert.equal(notices.length,1);assert.match(notices[0],/invalid response/);assert.equal(plugin.activeTasks.size,0);
  const again=await handoff.reopenCoffeeHandoff(plugin,handoff.coffeeHandoffTask(plugin,data.session.id));
  assert.equal(handoffField(again,'Research context').value,old);assert.equal(handoffField(again,'Research question').value,oldQuestion);assert.match(again.status.text,/invalid/);
});
integrationTest('Coffee reframing checks Markdown/sidecar changes and busy state before creating', async () => {
  for (const kind of ['markdown','sidecar','busy']) {
    const data=await reframingModalFixture();
    if(kind==='markdown')data.contents.set(data.path,data.contents.get(data.path)+'\nExternal edit');
    if(kind==='sidecar'){const p=data.store.sidecarPath(data.session.id);data.contents.set(p,data.contents.get(p)+' ');}
    if(kind==='busy')data.plugin.coffeeManager={get:()=>({busy:true})};
    coffeeFind(data.modal.contentEl,e=>e.text==='Create research map').onclick();await until(()=>!data.modal.creating);
    assert.equal((await data.repo.mapFiles()).length,0);assert.equal(data.opened.length,0);assert.match(data.modal.status.text,/changed|generating/);
  }
});
integrationTest('Visual Map handoff separates synchronization/navigation failure from durable completion', async () => {
  const {receiveVisualMapHandoff}=load('experiences/visual-map/handoff.ts',{obsidian});const {repo,files}=fixture('en');let navigations=0;
  const artifact={version:1,id:'operation',kind:'question',title:'Question',content:'Context',sourceSnapshot:'Idea',origin:{experience:'coffee-tables'},sources:[]};
  const result=await receiveVisualMapHandoff(artifact,{repo,defaultModel:()=> 'm',exists:p=>files.has(p),mutate:async work=>{await work();throw Error('sync failed');},navigate:async()=>{navigations++;throw Error('open failed');}});
  assert.match(result.navigationError,/sync failed/);assert.match(result.navigationError,/open failed/);assert.ok(files.has(result.targetPath));assert.equal((await repo.readMap(result.targetPath)).nodes.length,1);assert.equal(navigations,1);
});
integrationTest('Visual Map handoff exposes exact partial paths at every persistence stage', async () => {
  const {receiveVisualMapHandoff}=load('experiences/visual-map/handoff.ts',{obsidian});
  for(const stage of ['folders','map','note','saveMap']){
    const {repo,app,files}=fixture('en');
    if(stage==='folders'){const fn=repo.ensureTopicFolders.bind(repo);repo.ensureTopicFolders=async root=>{await fn(root);throw Error('folder failed');};}
    if(stage==='map'||stage==='note'){const fn=app.vault.create;app.vault.create=async(p,s)=>{if(stage==='map'?p.endsWith('/Map.md'):p.includes('/Notes/'))throw Error(stage+' failed');return fn(p,s);};}
    if(stage==='saveMap')repo.saveMap=async()=>{throw Error('save failed');};
    const artifact={version:1,id:stage,kind:'question',title:'Question',content:'Context',origin:{experience:'coffee-tables'},sources:[]};
    await assert.rejects(receiveVisualMapHandoff(artifact,{repo,defaultModel:()=> 'm',exists:p=>files.has(p),mutate:work=>work(),navigate:async()=>{throw Error('should not navigate');}}),e=>{assert.equal(e.name,'HandoffWriteError');assert.ok(e.paths.length>=1);assert.ok(e.paths.every(p=>files.has(p)));return true;});
  }
});
integrationTest('Coffee handoff partial writes disable creation; saved navigation failures retry only opening', async () => {
  const partial=await reframingModalFixture();partial.repo.saveMap=async()=>{throw Error('save failed');};
  const create=coffeeFind(partial.modal.contentEl,e=>e.text==='Create research map');create.onclick();await until(()=>!partial.modal.creating);assert.equal(create.disabled,true);const paths=[...partial.files.keys()];create.onclick();await Promise.resolve();assert.deepEqual([...partial.files.keys()],paths);assert.match(partial.modal.status.text,/Some files/);
  const saved=await reframingModalFixture();saved.plugin.activateView=async()=>{throw Error('navigation failed');};
  const open=coffeeFind(saved.modal.contentEl,e=>e.text==='Create research map');open.onclick();await until(()=>!saved.modal.creating);assert.equal(open.text,'Open saved map');assert.equal((await saved.repo.mapFiles()).length,1);open.onclick();await until(()=>saved.opened.length===1);assert.equal((await saved.repo.mapFiles()).length,1);
});
integrationTest('Root research and decomposition use Thinking Origin and preserve it across writeback', async () => {
  const {repo,app}=fixture('en'), n=await topicNote(repo,'Research source');
  const mapPath='Agent Workspace/Topics/map-a/Map.md', doc={...map([n]),id:'map-a'};await app.vault.create(mapPath,core.serializeMap(doc));
  await repo.updateNote(n.path,{prompt:'Research',detail:'Initial context',thinkingOrigin:'Unverified analogy. Important conditions and alternatives.'});
  const {VisualAgentMapView}=load('main.ts',{obsidian});let view;const modes=[],languages=[];
  const plugin=withExpansionCoordinator({repo,settings:{...DEFAULT_SETTINGS,language:'en'},running:new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {},activeTasks:new Map(),pendingSuggestions:new Map(),pendingResearchOptions:new Map(),mutate:work=>work(),views:()=>[view],askModel:async context=>{modes.push(context.mode);languages.push(context.outputLanguage);assert.match(context.sourceContext,/Important conditions/);assert.equal(context.rules,'');return {summary:'New understanding',detail:'Research findings',suggestions:[]};},rebuildDerivedData:async()=>{}});
  view=new VisualAgentMapView({app},plugin);view.path=mapPath;view.map=doc;view.render=()=>{};view.hydrate=async()=>{};view.contentEl={querySelector:()=>null};
  await view.runAgent(n,undefined,undefined,{outputLanguage:'zh-TW'});await until(()=>!plugin.running.size);assert.match((await repo.readNote(n.path)).thinkingOrigin,/Important conditions/);
  await view.proposeChildren(n,{researchMode:'local',researchDepth:'normal',visualMode:'off',referenceGroups:[]},'Explore',()=>{},()=>{});
  assert.deepEqual(modes,['task','decompose']);assert.equal(languages[0],'zh-TW');
});
integrationTest('Editing Thinking Origin during root research fences stale results', async () => {
  const {repo,app}=fixture('en'),n=await topicNote(repo,'Editable source');await repo.updateNote(n.path,{prompt:'Research',detail:'Keep',thinkingOrigin:'Old source'});
  const {VisualAgentMapView}=load('main.ts',{obsidian});const pending=deferred();let view,accepted=false;
  const plugin={repo,settings:{...DEFAULT_SETTINGS},running:new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {},activeTasks:new Map(),pendingSuggestions:new Map(),mutate:work=>work(),views:()=>[view],askModel:(_context,_model,_reasoning,_signal,_exchange,onAccepted)=>{onAccepted?.();accepted=true;return pending.promise;}};
  view=new VisualAgentMapView({app},plugin);view.map=map([n]);view.render=()=>{};view.hydrate=async()=>{};
  const handle=await view.runAgent(n);assert.ok(handle);assert.equal(accepted,true);await repo.updateNote(n.path,{thinkingOrigin:'User corrected source'});pending.resolve({summary:'Stale',detail:'Stale',suggestions:[]});await handle.finished;
  const note=await repo.readNote(n.path);assert.equal(note.detail,'Keep');assert.equal(note.thinkingOrigin,'User corrected source');
});
integrationTest('Reframing hides only after usage is confirmed; decline or closing first starts nothing; a runtime reset ends the background run as stopped', async () => {
  // Decline: the dialog stays open and no request is made.
  const declined=await reframingModalFixture();let calls=0;
  declined.plugin.core.reframing={reframe:()=>{calls++;return new Promise(()=>{});}};declined.plugin.confirmAiUsage=async()=>false;
  organizeButton(declined.modal).onclick();await until(()=>!declined.modal.controller);
  assert.equal(calls,0);assert.equal(declined.modal.didClose,undefined);assert.match(declined.modal.status.text,/did not run/);assert.equal(declined.handoff.coffeeHandoffTask(declined.plugin,declined.session.id),undefined);
  // The usage notice is still open: the dialog is still visible; closing it before confirming cancels.
  const early=await reframingModalFixture();const gate=deferred();let earlyCalls=0;
  early.plugin.core.reframing={reframe:()=>{earlyCalls++;return new Promise(()=>{});}};
  early.plugin.confirmAiUsage=async(_m,run)=>{const ok=await gate.promise;if(ok)await run();return ok;};
  organizeButton(early.modal).onclick();await until(()=>early.plugin.activeTasks.size===1);
  assert.equal(early.modal.didClose,undefined);assert.equal(early.handoff.coffeeHandoffTask(early.plugin,early.session.id),undefined);
  early.modal.close();gate.resolve(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(earlyCalls,0);assert.equal(early.plugin.activeTasks.size,0);assert.equal(early.handoff.coffeeHandoffTask(early.plugin,early.session.id),undefined);
  // Confirmed: hides; a runtime reset aborts and the late draft is never applied.
  const data=await reframingModalFixture(),{modal,plugin,handoff,notices}=data;const pending=deferred();let request;
  plugin.core.reframing={reframe:(input,signal)=>{request={input,signal};return pending.promise;}};
  const question=handoffField(modal,'Research question'),before=question.value;
  organizeButton(modal).onclick();await until(()=>request);
  assert.equal(modal.didClose,true);plugin.resetCodexRuntime();
  assert.equal(request.signal.aborted,true);pending.resolve({question:'Late',context:'Late',rationale:'Late'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(question.value,before);assert.equal(data.opened.length,0);assert.equal(plugin.activeTasks.size,0);assert.equal(notices.length,0);
  const task=handoff.coffeeHandoffTask(plugin,data.session.id);assert.equal(task.state,'stopped');assert.equal(task.draft,undefined);
  // Pressing again while a run is in the background is refused with the existing running text.
  const busy=await reframingModalFixture();busy.plugin.core.reframing={reframe:()=>new Promise(()=>{})};
  organizeButton(busy.modal).onclick();await until(()=>busy.handoff.coffeeHandoffTask(busy.plugin,busy.session.id)?.state==='running');
  await assert.rejects(busy.handoff.openCoffeeResearchHandoff(busy.plugin,busy.store,busy.displayed,busy.path),/AI running/);
});
integrationTest('Reframing completion while the dialog is hidden gives one Notice with a Review button; reopening restores inputs and the AI result; a changed source writes nothing', async () => {
  const data=await reframingModalFixture(),{modal,plugin,handoff,notices,modals,Notice}=data;
  plugin.core.reframing={reframe:async()=>({question:'Which evidence separates access from affordability?',context:'AI context',rationale:'AI rationale'})};
  plugin.settings.language='en';
  handoffField(modal,'Output language').value='zh-TW';handoffField(modal,'Research question').value='My own question';
  organizeButton(modal).onclick();await until(()=>handoff.coffeeHandoffTask(plugin,data.session.id)?.state==='done');
  // Exactly one Notice with one button; no dialog opened by itself.
  assert.equal(notices.length,1);assert.equal(Notice.all.length,1);assert.deepEqual(Notice.all[0].actions.map(b=>b.text),['Review']);assert.equal(modals.length,1);
  // The source changes after the run: reopening shows the existing error, opens nothing, writes nothing, keeps the entry.
  const task=handoff.coffeeHandoffTask(plugin,data.session.id);
  data.contents.set(data.path,data.contents.get(data.path)+'\nChanged while hidden');
  Notice.all[0].actions[0].click();await until(()=>notices.length===2);
  assert.equal(modals.length,1);assert.equal((await data.repo.mapFiles()).length,0);assert.equal(handoff.coffeeHandoffTask(plugin,data.session.id),task);
  // Source restored: the Notice button reopens the dialog with the AI result and the prior model / reasoning / language.
  data.contents.set(data.path,data.contents.get(data.path).replace('\nChanged while hidden',''));
  Notice.all[0].actions[0].click();await until(()=>modals.length===2);
  const reopened=modals[1];
  assert.equal(handoffField(reopened,'Research question').value,'Which evidence separates access from affordability?');assert.equal(handoffField(reopened,'Research context').value,'AI context');
  assert.equal(handoffField(reopened,'Output language').value,'zh-TW');assert.equal(handoffField(reopened,'Model').value,task.inputs.model);assert.equal(reopened.rationale,'AI rationale');assert.equal(reopened.method,'ai');
  assert.equal(handoff.coffeeHandoffTask(plugin,data.session.id),undefined);
});
integrationTest('The handoff asks for the regional variant of the interface language: zh-CN UI writes Simplified, zh-TW and en are unchanged', async () => {
  const { buildReframePrompt } = load('core/reframing-service.ts');
  const run = async (uiLanguage, choice) => {
    const data = await reframingModalFixture(), { modal, plugin, handoff } = data; let seen;
    plugin.core.reframing = { reframe: async input => { seen = input; return { question: 'Q?', context: 'C', rationale: 'R' }; } };
    plugin.settings.language = uiLanguage;
    handoffField(modal, 'Output language').value = choice; organizeButton(modal).onclick();
    await until(() => handoff.coffeeHandoffTask(plugin, data.session.id)?.state === 'done');
    return { seen, stored: handoff.coffeeHandoffTask(plugin, data.session.id).inputs.language, modal };
  };
  const cn = await run('zh-CN', 'zh-TW');
  assert.equal(cn.seen.language, 'zh-CN'); assert.equal(cn.stored, 'zh-TW'); assert.match(buildReframePrompt(cn.seen), /简体中文|Simplified Chinese/);
  const tw = await run('zh-TW', 'zh-TW');
  assert.equal(tw.seen.language, 'zh-TW'); assert.match(buildReframePrompt(tw.seen), /繁體中文|Traditional Chinese/); assert.doesNotMatch(buildReframePrompt(tw.seen), /简体中文|Simplified Chinese/);
  const en = await run('en', 'en');
  assert.equal(en.seen.language, 'en'); assert.match(buildReframePrompt(en.seen), /English/); assert.doesNotMatch(buildReframePrompt(en.seen), /Simplified Chinese/);
  const cnEnglish = await run('zh-CN', 'en');
  assert.equal(cnEnglish.seen.language, 'en');
  const select = handoffField((await reframingModalFixture()).modal, 'Output language');
  assert.deepEqual(select.children.map(o => [o.value, o.text]), [['zh-TW', '繁體中文'], ['en', 'English']]);
});
integrationTest('Starting a handoff for another insight announces the discarded finished AI draft', async () => {
  const data=await reframingModalFixture(),{modal,plugin,handoff,notices}=data;
  plugin.core.reframing={reframe:async()=>({question:'Q?',context:'C',rationale:'R'})};plugin.settings.language='en';
  organizeButton(modal).onclick();await until(()=>handoff.coffeeHandoffTask(plugin,data.session.id)?.state==='done');
  const before=notices.length;
  await handoff.openCoffeeResearchHandoff(plugin,data.store,data.displayed,data.path,'idea');
  assert.equal(notices.length,before+1);assert.match(notices.at(-1),/discarded/i);
});
integrationTest('Coffee handoff rechecks source after waiting in the write queue', async () => {
  const data=await reframingModalFixture();const gate=deferred();data.plugin.mutate=async work=>{await gate.promise;await work();};
  coffeeFind(data.modal.contentEl,e=>e.text==='Create research map').onclick();await until(()=>data.modal.creating);
  data.contents.set(data.path,data.contents.get(data.path)+'\nChanged while queued');gate.resolve();await until(()=>!data.modal.creating);assert.equal((await data.repo.mapFiles()).length,0);assert.equal(data.opened.length,0);
});
integrationTest('Reframing runner uses structured output and disabled tools on both provider adapters', async () => {
  const {EventEmitter}=require('node:events');const requests=[];
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
  const emit=message=>process.nextTick(()=>child.stdout.emit('data',Buffer.from(JSON.stringify(message)+'\n')));
  child.stdin={write:line=>{const m=JSON.parse(line);requests.push(m);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='config/read')emit({id:m.id,result:{config:{mcp_servers:{'inherited.server':{},enabledServer:{enabled:true}}}}});else if(m.method==='thread/start'){assert.equal(m.params.config.mcp_servers['inherited.server'].enabled,false);assert.equal(m.params.config.mcp_servers.enabledServer.enabled,false);for(const feature of ['apps','plugins','browser_use','computer_use','multi_agent','goals','code_mode_host'])assert.equal(m.params.config['features.'+feature],false);assert.equal(m.params.config['web_search'],'disabled');assert.equal(m.params.config['features.shell_tool'],false);assert.equal(m.params.config['features.unified_exec'],false);assert.doesNotMatch(m.params.baseInstructions,/only.*Markdown/);emit({id:m.id,result:{thread:{id:'reframe-thread'}}});}else if(m.method==='turn/start'){assert.equal(m.params.outputSchema.additionalProperties,false);emit({id:m.id,result:{turn:{id:'reframe-turn'}}});emit({method:'item/completed',params:{threadId:'reframe-thread',item:{id:'message',type:'agentMessage',text:'{"question":"Q?","context":"Unverified context","rationale":"R"}'}}});emit({method:'turn/completed',params:{threadId:'reframe-thread',turn:{status:'completed'}}});}else if(m.method==='thread/unsubscribe')emit({id:m.id,result:{}});}};
  const {CodexAppServerRuntime}=load('ai/runtime/codex-app-server.ts',{'node:child_process':{spawn:()=>child}});const {ReframingService}=load('core/reframing-service.ts');
  const runtime=new CodexAppServerRuntime({executable:'codex',cwd:'/plugin',env:{},clientVersion:'test',webSearchDisabled:true});
  try{const service=new ReframingService((request,prompt,schema,signal)=>runtime.runTask(prompt,request.model,request.reasoning,schema,{textOnly:true,searchBudget:0,signal}));await service.reframe({targetCore:'understand',source:'Unverified idea',question:'Q',context:'',model:'m',reasoning:'low',language:'en'},new AbortController().signal);assert.ok(requests.some(r=>r.method==='turn/start'));}finally{runtime.stop();}
  const args=load('ai/runtime/claude-code-cli.ts').claudeTaskArgs('sonnet','low',load('core/reframing-service.ts').REFRAME_SCHEMA,false);assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--json-schema'));
});
integrationTest('Oversized Thinking Origin is rejected before provider work without trimming', async () => {
  const {default:Plugin}=load('main.ts',{obsidian});const plugin=new Plugin();let calls=0;plugin.runtime=()=>{calls++;throw Error('must not run');};
  await assert.rejects(plugin.askModel({title:'Q',summary:'',detail:'',task:'Research',rules:'',ancestors:'',sourceContext:'x'.repeat(128001 /* 32_000 tokens * 4 chars + 1: the hardcoded limit in core/ai-task-service.ts:124 */)},'m'),/budget|預算/i);assert.equal(calls,0);
});
integrationTest('Coffee becoming busy during the final snapshot read blocks handoff writes', async () => {
  const data=await reframingModalFixture();let checks=0;const read=data.store.assertHandoffSnapshot.bind(data.store);
  data.store.assertHandoffSnapshot=async s=>{await read(s);if(++checks===2)data.plugin.coffeeManager={get:()=>({busy:true})};};
  coffeeFind(data.modal.contentEl,e=>e.text==='Create research map').onclick();await until(()=>!data.modal.creating);assert.equal((await data.repo.mapFiles()).length,0);assert.match(data.modal.status.text,/generating/);
});
integrationTest('Reframing exchange logs record validation failure and clean active controllers', async () => {
  const {providerReframeRunner,ReframingService}=load('core/reframing-service.ts');const states=[];const active=new Map();
  const log={milestones:()=>{},begin:()=>states.push('begin'),sent:()=>{},received:()=>states.push('received'),parsed:()=>states.push('parsed'),completed:()=>states.push('completed'),failed:()=>states.push('failed')};
  const options={pluginDirectory:()=>'/plugin',exchangeLoggingEnabled:()=>true,exchanges:()=>log,codexRuntime:()=>({runTask:async()=>'{"question":"Q?","context":"","rationale":"r"}'})};
  const service=new ReframingService(providerReframeRunner(options,active));
  await assert.rejects(service.reframe({targetCore:'understand',source:'idea',question:'Q?',context:'',language:'en',model:'m',reasoning:'low'},new AbortController().signal),/Invalid/);assert.deepEqual(states,['begin','received','failed']);assert.equal(active.size,0);
});
integrationTest('Guided proposals fence Thinking Origin at publication and after persisted reload', async () => {
  for(const stage of ['publication','acceptance','reload']) {
    const {repo,app}=fixture('en'), n=await topicNote(repo,'Guided origin');
    await repo.updateNote(n.path,{thinkingOrigin:'Old analogy'});
    const {VisualAgentMapView}=load('main.ts',{obsidian});const deferredResult=deferred();let view,accept,error;
    const plugin=withExpansionCoordinator({repo,settings:{...DEFAULT_SETTINGS,language:'en'},running:new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {},activeTasks:new Map(),quickExpandPending:new Set(),pendingSuggestions:new Map(),pendingResearchOptions:new Map(),mutate:work=>work(),views:()=>[view],askModel:(_context,_model,_reasoning,_signal,_exchange,accepted)=>{accepted?.();return deferredResult.promise;},recordFailure:(_label,e)=>e.message});
    view=new VisualAgentMapView({app},plugin);view.map=map([n]);view.render=()=>{};view.hydrate=async()=>{};
    const modalController=new AbortController(); let accepted=false;
    const task=view.proposeChildren(n,{referenceGroups:[],shallowResearch:true,signal:modalController.signal,onProgress:()=>assert.fail('closed modal progress callback used')},'Explore',(_items,create)=>{accept=create;},message=>{error=message;},()=>{accepted=true;});
    await until(()=>accepted);
    assert.equal(accepted,true); assert.equal(modalController.signal.aborted,false); assert.ok(plugin.activeTasks.has(n.path));
    if(stage==='publication')await repo.updateNote(n.path,{thinkingOrigin:'Corrected source'});
    deferredResult.resolve({summary:'',detail:'',suggestions:[{title:'Proposal',task:'Explore',contribution:'Understanding'}]});await task;
    assert.equal(plugin.activeTasks.has(n.path),false);
    if(stage==='publication'){assert.equal(accept,undefined);assert.equal(plugin.pendingSuggestions.size,0);assert.ok(error);continue;}
    const proposals=plugin.pendingSuggestions.get(n.path);
    const savedOptions=plugin.pendingResearchOptions.get(n.path);
    assert.equal(savedOptions.signal,undefined); assert.equal(savedOptions.onProgress,undefined);
    if(stage==='reload')plugin.pendingSuggestions.set(n.path,JSON.parse(JSON.stringify(proposals)));
    await repo.updateNote(n.path,{thinkingOrigin:'Corrected source'});
    if(stage==='reload')await view.proposeChildren(n,undefined,'',(_items,create)=>{accept=create;});
    await assert.rejects(accept(plugin.pendingSuggestions.get(n.path)),/changed|變更/);
    assert.equal(view.map.nodes.length,1);assert.equal(plugin.pendingSuggestions.size,0);
  }
});
