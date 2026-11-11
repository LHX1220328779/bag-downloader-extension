const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../task-core.js'),B=require('../coverage-core.js');
const {background,flush,deferred,clone}=require('./helpers.cjs');
const fixture=require('./fixtures/huaining-range.json'),old=fixture.archive.find(r=>r.filename.endsWith('_200.bag'));
const task=(extra={})=>({filters:fixture.filters,start:fixture.start,end:fixture.end,items:[],transfers:[],...extra});
test('仅有旧归档 200 时只是起点候选，不进入目标队列或误报末端',()=>{
 const t=task(),p=B.plan(B.catalog(fixture.archive,t),t);assert.equal(p.selected.length,0);assert.equal(p.targets.length,0);assert.deepEqual(p.provisional,[old.filename]);
 assert(p.issues.some(i=>i.code==='START_UNKNOWN'));assert(!p.issues.some(i=>i.code==='END_MISSING'));assert(p.issues.every(i=>!i.message.includes('_200.bag')));
});
test('200 实际在任务前结束，排除它且告警只针对请求起点，不说它是末包',()=>{
 const t=task({recordingBounds:fixture.oldBounds,coverage:{targets:[old.filename]}}),p=B.plan(fixture.archive,t);
 assert(p.excluded.includes(old.filename));assert.equal(p.targets.length,0);assert.equal(p.selected.length,0);assert(p.issues.some(i=>i.code==='START_MISSING'));assert(p.issues.every(i=>!i.message.includes('_200.bag')));
});
test('真实 MDC 清单只选择 210/211，212 仅证明边界，旧目标 200 被纠正',()=>{
 const t=task({recordingBounds:fixture.oldBounds,coverage:{targets:[old.filename]}});
 const p=B.plan([...B.catalog(fixture.mdc,t,true),...B.catalog(fixture.archive,t)],t);
 assert.equal(p.complete,true);assert.equal(p.coveredStart,'2026-11-06 08:47:25');assert.equal(p.coveredEnd,'2026-11-06 08:48:25');
 assert.deepEqual(p.targets,fixture.mdc.filter(r=>!r.filename.endsWith('_212.bag')).sort(C.sort).map(r=>r.filename));
});
test('慢 MDC 时归档查询和文件头先返回也不下载旧 200，不发错误覆盖通知',async()=>{
 const wait=deferred(),e=await background({mdc:()=>wait.promise,trucks:async()=>[{value:fixture.filters.truck_no,status:true}]},{server:{files:fixture.archive}});
 e.context.BagHeader.read=async()=>fixture.oldBounds[old.filename];
 const t=await e.create({...fixture.filters,start:fixture.start,end:fixture.end,operations:{transfer:true,download:true},reason:'01'});
 e.state.tasks[0].downloadBackend='directory';e.state.tasks[0].dirId='dir1';await e.call('execute',t.id);await flush();
 assert.equal(e.get(t.id).items.length,0);assert.equal(e.downloads.length,0);assert.equal(e.get(t.id).coverageAlert,'');assert.equal(e.notes.length,0);
 wait.resolve(fixture.mdc);await flush();const result=e.get(t.id);
 assert.equal(result.coverage.complete,true);assert.equal(result.coverageAlert,'');assert.equal(result.items.length,0);
 assert.deepEqual(result.transfers.map(r=>r.filename),fixture.mdc.filter(r=>!r.filename.endsWith('_212.bag')).sort(C.sort).map(r=>r.filename));assert.equal(e.submissions.length,2);
});
test('只下载且候选头部确认覆盖范围后才入队，不能误标零包完成',async()=>{
 const wait=deferred(),e=await background({}, {server:{files:[old]}});e.context.BagHeader.read=()=>wait.promise;
 const t=await e.create({...fixture.filters,start:'2026-11-06 08:42:30',end:'2026-11-06 08:42:50',operations:{transfer:false,download:true}});
 e.state.tasks[0].downloadBackend='directory';e.state.tasks[0].dirId='dir1';await e.call('execute',t.id);await flush();assert.equal(e.downloads.length,0);assert.equal(e.get(t.id).status,'running');
 wait.resolve(fixture.oldBounds[old.filename]);await flush();assert.equal(e.get(t.id).coverage.complete,true);assert.equal(e.get(t.id).items.length,1);assert.equal(e.downloads[0].filename,old.filename);
});
test('纠正已有任务保留旧包记录、运行代次和回传锁，历史误告警标记已纠正',async()=>{
 const e=await background(),t=await e.create({...fixture.filters,start:fixture.start,end:fixture.end,operations:{transfer:false,download:true}}),saved=e.state.tasks[0];
 Object.assign(saved,{status:'running',runToken:'same-run',message:'时间覆盖尚未确认，持续核查目标数据包',recordingBounds:clone(fixture.oldBounds),items:[{...old,state:'done',attempts:1}],coverage:{targets:[old.filename]},archiveCatalog:B.catalog(fixture.archive,task()),mdcCatalog:B.catalog(fixture.mdc,task(),true),events:[{at:Date.now(),message:'末包 '+C.shortFilename(old.filename)+' 实际录制结束于 2026-11-06 08:42:55，未覆盖至 '+fixture.end}]});
 await e.call('applyCoverage',saved,B.plan([...saved.mdcCatalog,...saved.archiveCatalog],saved));
 const result=e.get(t.id);assert.equal(result.runToken,'same-run');assert.equal(result.items[0].state,'done');assert.equal(result.items[0].coverageExcluded,true);assert.equal(result.events[0].coverageCorrected,true);assert.equal(result.coverage.complete,true);assert.equal(result.message,'时间覆盖已确认，持续核查目标数据包');
});
test('纠正目标不取消旧在途下载或回传锁，等待原 job 返回后按有效包完成',async()=>{
 const e=await background(),t=await e.create({...fixture.filters,start:fixture.start,end:fixture.end,operations:{transfer:true,download:true},reason:'01'}),saved=e.state.tasks[0];
 const targets=fixture.mdc.filter(r=>!r.filename.endsWith('_212.bag'));
 Object.assign(saved,{status:'running',runToken:'original-run',searchReady:true,discovered:true,recordingBounds:clone(fixture.oldBounds),archiveCatalog:B.catalog(fixture.archive,task()),mdcCatalog:B.catalog(fixture.mdc,task(),true),coverage:{targets:[old.filename]},
  items:[{...old,state:'downloading',jobId:'original-job',attempts:2},...targets.map(r=>({...r,dirpath:'/fixture/'+r.filename,state:'done',attempts:1}))],
  transfers:[{...old,key:C.fileKey(old),state:'submitted',submissionLocked:true,accepted:true,recordNo:100500,attempts:1},...targets.map(r=>({...r,key:C.fileKey(r),state:'done',submissionLocked:true,accepted:true}))]});
 e.activeJobs.add('original-job');await e.call('applyCoverage',saved,B.plan([...saved.mdcCatalog,...saved.archiveCatalog],saved));
 await e.call('kick',t.id);await e.call('finish',t.id);let result=e.get(t.id);
 assert.equal(result.status,'running');assert.equal(result.runToken,'original-run');assert.equal(result.items[0].jobId,'original-job');assert(e.activeJobs.has('original-job'));assert.equal(e.downloads.length,0);
 assert.equal(result.transfers[0].coverageExcluded,true);assert.equal(result.transfers[0].submissionLocked,true);assert.equal(result.transfers[0].recordNo,100500);
 await e.call('onJobResult',{jobId:'original-job',ok:true});result=e.get(t.id);
 assert.equal(result.status,'done');assert.equal(result.message,'已完成，下载 2 个包');assert.equal(result.items[0].state,'done');assert.equal(result.runToken,'original-run');assert.equal(result.transfers[0].recordNo,100500);assert.equal(e.submissions.length,0);
});
test('MDC 已返回且确实缺少目标包时立即告警，不再等待下一次归档查询',async()=>{
 const wait=deferred(),e=await background({mdc:()=>wait.promise,trucks:async()=>[{value:fixture.filters.truck_no,status:true}]},{server:{files:fixture.archive}});
 e.context.BagHeader.read=async()=>fixture.oldBounds[old.filename];
 const t=await e.create({...fixture.filters,start:fixture.start,end:fixture.end,operations:{transfer:true,download:true},reason:'01'});
 await e.call('execute',t.id);await flush();assert.equal(e.notes.length,0);
 wait.resolve([]);await flush();const result=e.get(t.id);
 assert.equal(result.discovered,true);assert(result.coverageAlert.includes(fixture.start));assert(!result.coverageAlert.includes('_200.bag'));assert(e.notes.some(n=>n.id==='coverage:'+t.id));assert.equal(e.downloads.length,0);
});
test('归档包先下载完成、MDC 后返回时立即完成原任务，不等下一次轮询或重复下载',async()=>{
 const wait=deferred(),archive=fixture.mdc.map(r=>({...r,break_source:'mdc',dirpath:'/fixture/'+r.filename}));
 const e=await background({mdc:()=>wait.promise,trucks:async()=>[{value:fixture.filters.truck_no,status:true}]},{server:{files:archive}});
 const t=await e.create({...fixture.filters,start:fixture.start,end:fixture.end,operations:{transfer:true,download:true},reason:'01'});
 e.state.tasks[0].downloadBackend='directory';e.state.tasks[0].dirId='dir1';await e.call('execute',t.id);await flush();
 assert.equal(e.get(t.id).items.length,2);
 for(let n=0;n<2;n++){await e.call('kick',t.id);const i=e.get(t.id).items.find(r=>r.jobId);assert(i);await e.call('onJobResult',{jobId:i.jobId,ok:true});}
 assert.equal(e.get(t.id).status,'running');assert.equal(e.get(t.id).discovered,false);
 wait.resolve(fixture.mdc);await flush();const result=e.get(t.id);
 assert.equal(result.status,'done');assert.equal(result.message,'已完成，下载 2 个包');assert.equal(e.downloads.length,2);assert.equal(e.submissions.length,0);
});
