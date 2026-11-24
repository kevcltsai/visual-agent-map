const assert = require('node:assert/strict');
const { attachTopicRuns } = require('../support.cjs');
const { test, integrationTest, load, core, map, withExpansionCoordinator, obsidian, DEFAULT_SETTINGS, fixture, topicNote, deferred, until } = require('../support.cjs');
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
integrationTest('Root research and decomposition use Thinking Origin and preserve it across writeback', async () => {
  const {repo,app}=fixture('en'), n=await topicNote(repo,'Research source');
  const mapPath='Agent Workspace/Topics/map-a/Map.md', doc={...map([n]),id:'map-a'};await app.vault.create(mapPath,core.serializeMap(doc));
  await repo.updateNote(n.path,{prompt:'Research',detail:'Initial context',thinkingOrigin:'Unverified analogy. Important conditions and alternatives.'});
  const {VisualAgentMapView}=load('main.ts',{obsidian});let view;const modes=[],languages=[];
  const plugin=withExpansionCoordinator({repo,settings:{...DEFAULT_SETTINGS,language:'en'},running:new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {},activeTasks:new Map(),pendingSuggestions:new Map(),pendingResearchOptions:new Map(),mutate:work=>work(),views:()=>[view],askModel:async context=>{modes.push(context.mode);languages.push(context.outputLanguage);assert.match(context.sourceContext,/Important conditions/);assert.equal(context.rules,'');return {summary:'New understanding',detail:'Research findings',suggestions:[]};},rebuildDerivedData:async()=>{}});
  view=new VisualAgentMapView({app}, attachTopicRuns(plugin));view.path=mapPath;view.map=doc;view.render=()=>{};view.hydrate=async()=>{};view.contentEl={querySelector:()=>null};
  await view.runAgent(n,undefined,undefined,{outputLanguage:'zh-TW'});await until(()=>!plugin.running.size);assert.match((await repo.readNote(n.path)).thinkingOrigin,/Important conditions/);
  await view.proposeChildren(n,{researchMode:'local',researchDepth:'normal',visualMode:'off',referenceGroups:[]},'Explore',()=>{},()=>{});
  assert.deepEqual(modes,['task','decompose']);assert.equal(languages[0],'zh-TW');
});
integrationTest('Editing Thinking Origin during root research fences stale results', async () => {
  const {repo,app}=fixture('en'),n=await topicNote(repo,'Editable source');await repo.updateNote(n.path,{prompt:'Research',detail:'Keep',thinkingOrigin:'Old source'});
  const {VisualAgentMapView}=load('main.ts',{obsidian});const pending=deferred();let view,accepted=false;
  const plugin={repo,settings:{...DEFAULT_SETTINGS},running:new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {},activeTasks:new Map(),pendingSuggestions:new Map(),mutate:work=>work(),views:()=>[view],askModel:(_context,_model,_reasoning,_signal,_exchange,onAccepted)=>{onAccepted?.();accepted=true;return pending.promise;}};
  view=new VisualAgentMapView({app}, attachTopicRuns(plugin));view.map=map([n]);view.render=()=>{};view.hydrate=async()=>{};
  const handle=await view.runAgent(n);assert.ok(handle);assert.equal(accepted,true);await repo.updateNote(n.path,{thinkingOrigin:'User corrected source'});pending.resolve({summary:'Stale',detail:'Stale',suggestions:[]});await handle.finished;
  const note=await repo.readNote(n.path);assert.equal(note.detail,'Keep');assert.equal(note.thinkingOrigin,'User corrected source');
});
integrationTest('Text-only structured tasks disable tools on both provider adapters', async () => {
  const {EventEmitter}=require('node:events');const requests=[];
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
  const emit=message=>process.nextTick(()=>child.stdout.emit('data',Buffer.from(JSON.stringify(message)+'\n')));
  child.stdin={write:line=>{const m=JSON.parse(line);requests.push(m);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='config/read')emit({id:m.id,result:{config:{mcp_servers:{'inherited.server':{},enabledServer:{enabled:true}}}}});else if(m.method==='thread/start'){assert.equal(m.params.config.mcp_servers['inherited.server'].enabled,false);assert.equal(m.params.config.mcp_servers.enabledServer.enabled,false);for(const feature of ['apps','plugins','browser_use','computer_use','multi_agent','goals','code_mode_host'])assert.equal(m.params.config['features.'+feature],false);assert.equal(m.params.config['web_search'],'disabled');assert.equal(m.params.config['features.shell_tool'],false);assert.equal(m.params.config['features.unified_exec'],false);assert.doesNotMatch(m.params.baseInstructions,/only.*Markdown/);emit({id:m.id,result:{thread:{id:'reframe-thread'}}});}else if(m.method==='turn/start'){assert.equal(m.params.outputSchema.additionalProperties,false);emit({id:m.id,result:{turn:{id:'reframe-turn'}}});emit({method:'item/completed',params:{threadId:'reframe-thread',item:{id:'message',type:'agentMessage',text:'{"question":"Q?","context":"Unverified context","rationale":"R"}'}}});emit({method:'turn/completed',params:{threadId:'reframe-thread',turn:{status:'completed'}}});}else if(m.method==='thread/unsubscribe')emit({id:m.id,result:{}});}};
  const {CodexAppServerRuntime}=load('ai/runtime/codex-app-server.ts',{'node:child_process':{spawn:()=>child}});
  const runtime=new CodexAppServerRuntime({executable:'codex',cwd:'/plugin',env:{},clientVersion:'test',webSearchDisabled:true});
  const schema={type:'object',additionalProperties:false,properties:{question:{type:'string'},context:{type:'string'},rationale:{type:'string'}},required:['question','context','rationale']};
  try{const raw=await runtime.runTask('Return the requested structured data.','m','low',schema,{textOnly:true,searchBudget:0,signal:new AbortController().signal});assert.equal(JSON.parse(raw).question,'Q?');assert.ok(requests.some(r=>r.method==='turn/start'));}finally{runtime.stop();}
  const args=load('ai/runtime/claude-code-cli.ts').claudeTaskArgs('sonnet','low',schema,false);assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--json-schema'));
});
integrationTest('Oversized Thinking Origin is rejected before provider work without trimming', async () => {
  const {default:Plugin}=load('main.ts',{obsidian});const plugin=new Plugin();let calls=0;plugin.runtime=()=>{calls++;throw Error('must not run');};
  await assert.rejects(plugin.askModel({title:'Q',summary:'',detail:'',task:'Research',rules:'',ancestors:'',sourceContext:'x'.repeat(192001 /* SOURCE_CONTEXT_TOKEN_BUDGET (48_000) tokens * 4 chars + 1 */)},'m'),/budget|預算/i);assert.equal(calls,0);
});
integrationTest('Guided proposals fence Thinking Origin at publication and after persisted reload', async () => {
  for(const stage of ['publication','acceptance','reload']) {
    const {repo,app}=fixture('en'), n=await topicNote(repo,'Guided origin');
    await repo.updateNote(n.path,{thinkingOrigin:'Old analogy'});
    const {VisualAgentMapView}=load('main.ts',{obsidian});const deferredResult=deferred();let view,accept,error;
    const plugin=withExpansionCoordinator({repo,settings:{...DEFAULT_SETTINGS,language:'en'},running:new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {},activeTasks:new Map(),quickExpandPending:new Set(),pendingSuggestions:new Map(),pendingResearchOptions:new Map(),mutate:work=>work(),views:()=>[view],askModel:(_context,_model,_reasoning,_signal,_exchange,accepted)=>{accepted?.();return deferredResult.promise;},recordFailure:(_label,e)=>e.message});
    view=new VisualAgentMapView({app}, attachTopicRuns(plugin));view.map=map([n]);view.render=()=>{};view.hydrate=async()=>{};
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
