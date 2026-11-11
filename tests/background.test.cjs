const test = require('node:test'), assert = require('node:assert/strict');
const { background, flush, deferred, a, b } = require('./helpers.cjs');
async function start(env, extra) { const t = await env.create(extra); await env.call('execute',t.id); await flush(); return t.id; }
test('回传按时间升序批量提交，不等待入库；下载仍按时间逐包执行', async () => {
  const e=await background(), id=await start(e);
  await e.call('tickTask',id); await flush(); assert.deepEqual(e.submissions.map((i)=>i.filename),[a.filename,b.filename]); assert.equal(e.downloads.length,0);
  assert.equal(e.submissionBatches.length,1);
  await e.call('tickTask',id); await flush(); assert.equal(e.submissions.length,2);
  e.server.files=[a]; await e.call('tickTask',id);
  assert.equal(e.downloads[0].filename,a.filename); assert.equal(e.submissions[1].filename,b.filename);
  e.server.files=[a,b]; await e.call('tickTask',id); assert.equal(e.downloads.length,1);
  await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true}); await e.call('kick',id);
  assert.equal(e.downloads[1].filename,b.filename);
  await e.call('onJobResult',{jobId:e.downloads[1].jobId,ok:true});
  assert.equal(e.get(id).status,'done'); assert(e.get(id).transfers.every((i)=>i.state==='done'));
});
test('初始 NAS 离线标红，只通知一次；恢复后自动回传；离线期间已入库包继续下载',async()=>{
  const e=await background();e.server.online=false; const id=await start(e);
  assert.equal(e.get(id).status,'waiting_vehicle'); assert.equal(e.notes.length,1);
  await e.call('tickTask',id);assert.equal(e.notes.length,1);assert.equal(e.submissions.length,0);
  e.server.online=true;await e.call('tickTask',id);await flush();await e.call('tickTask',id);assert.equal(e.submissions.length,2);
  e.server.online=false;e.server.files=[a];await e.call('tickTask',id);
  assert.equal(e.submissions.length,2);assert.equal(e.downloads.length,1);assert.equal(e.get(id).status,'waiting_vehicle');
  e.server.online=true;await e.call('tickTask',id);assert.equal(e.submissions.length,2);assert.equal(e.get(id).alert,'');
});
test('慢 MDC 清单不会阻塞离线检测；旧清单响应不会恢复已停止任务', async()=>{
  const slow=deferred(),e=await background({mdc:()=>slow.promise});const id=await start(e);
  e.server.online=false;await e.call('tickTask',id);assert.equal(e.get(id).status,'waiting_vehicle');
  await e.call('stopTask',id);slow.resolve([a]);await flush();assert.equal(e.get(id).status,'stopped');assert.equal(e.get(id).transfers.length,0);
});
test('停止/重新执行使旧查询结果失效；新一轮可正常恢复',async()=>{
  const slow=deferred(),e=await background({search:()=>slow.promise}); const id=await start(e,{kind:'download'});
  await e.call('stopTask',id);await e.call('execute',id);slow.resolve([a]);await flush();
  assert.equal(e.downloads.length,0);
  e.context.SiteAPI.search=async()=>[b];await e.call('tickTask',id);assert.equal(e.downloads[0].filename,b.filename);
});
test('提交超时保持待核对，重启/离线恢复都不会盲目重复提交',async()=>{
  let submits=0;const e=await background({submitBatch:async()=>{submits++;throw Error('timeout');}}),id=await start(e);
  await e.call('tickTask',id);assert.equal(e.get(id).transfers[0].state,'uncertain');
  e.advance(300000);await e.call('tickTask',id);await e.call('stopTask',id);await e.call('execute',id);await flush();await e.call('tickTask',id);
  assert.equal(submits,1);
});
test('服务器失败只核查，掉线/上线/停止后执行都不自动重复回传',async()=>{
  const e=await background(),id=await start(e);await e.call('tickTask',id);
  e.server.records[0].status='failed';await e.call('tickTask',id);assert.equal(e.submissions.length,2);
  assert.equal(e.get(id).transfers[0].state,'server_failed');
  e.server.online=false;await e.call('tickTask',id);e.server.online=true;
  e.advance(16000);await e.call('tickTask',id);await e.call('stopTask',id);await e.call('execute',id);await flush();
  assert.equal(e.submissions.length,2);
  e.server.records.push({...e.server.records[0],record_no:99,status:'downloading'});
  await e.call('tickTask',id);assert.equal(e.get(id).transfers[0].state,'submitted');
});
test('同一分钟的外部任务只阻塞，不误认目标文件已完成',async()=>{
  const e=await background();e.server.records=[{record_no:1,truck_no:'WH-Truck05',break_source:'mdc',breaktime:'2026-11-03 09:00',status:'downloading'}];
  const id=await start(e);await e.call('tickTask',id);await flush();assert.deepEqual(e.submissions.map((i)=>i.filename),[b.filename]);assert.equal(e.get(id).transfers[0].state,'pending');
  e.server.records[0].status='succeed';await e.call('tickTask',id);await flush();assert.equal(e.submissions.length,2);
});
test('重复任务不并发写同一文件，合并排序后结果按 jobId 更新',async()=>{
  const e=await background();e.server.files=[b];const id=await start(e,{kind:'download'}),id2=await start(e,{kind:'download'});
  assert.equal(e.downloads.length,1);
  e.server.files=[a,b];await e.call('scanSearch',e.get(id));
  await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true});
  assert.equal(e.get(id).items.find((i)=>i.filename===b.filename).state,'done');assert.equal(e.get(id).items.find((i)=>i.filename===a.filename).state,'pending');
  await e.call('kick',id2);assert.equal(e.downloads.length,2);
});
test('旧下载结果不会污染停止后的任务；目录更换重置下载而保留回传',async()=>{
  const e=await background();e.server.files=[a];const id=await start(e,{kind:'download'}),jobId=e.downloads[0].jobId;
  await e.call('stopTask',id);await e.call('onJobResult',{jobId,ok:true});assert.equal(e.get(id).items[0].state,'pending');
  e.state.dirs.push({id:'dir2',name:'new'});await e.call('changeDirectory',id,'dir2');assert.equal(e.get(id).dirId,'dir2');assert.equal(e.get(id).status,'ready');
});
test('目录拒绝授权、非法回传来源和错误时间在创建前拦截',async()=>{
  const e=await background();await assert.rejects(()=>e.create({break_source:'手工'}),/mdc/);
  await assert.rejects(()=>e.create({start:'2026-02-30 00:00:00'}),/时间/);
  e.context.DirStore.permission=async()=> 'denied';await assert.rejects(()=>e.create(),/授权/);
});
test('service worker 唤醒保留活跃下载，恢复孤立 job；offscreen 消息不抢答',async()=>{
  const e=await background();e.server.files=[a];const id=await start(e,{kind:'download'});
  e.advance(60000);await e.call('reconcile');await flush();assert.equal(e.downloads.length,1);
  e.activeJobs.clear();await e.call('reconcile');await flush();assert.equal(e.downloads.length,2);
  let replied=false;const listener=e.chrome.runtime.onMessage.listeners[0];
  assert.equal(listener({type:'offscreen:status'},{id:'test-extension'},()=>{replied=true;}),false);assert.equal(replied,false);
});
test('网页捕获忽略手动缓存，table 缺少来源时回到不限，其他路由不覆盖',async()=>{
  const e=await background();
  e.state.draftFilters={truck_no:'MANUAL',mine_code:'OTHER',bag_type:'Camera',break_source:'手工'};
  e.chrome.tabs.query=async(query)=>query.active?[{id:7}]:[];
  const listener=e.chrome.runtime.onMessage.listeners[0];
  const capture=(path,payload)=>new Promise((resolve)=>listener({type:'capture',payload},{id:'test-extension',url:'http://10.198.92.173:8080'+path,tab:{id:7,windowId:1}},resolve));
  assert((await capture('/search',{truck_no:'WH-Truck05',mine_code:'WH',bag_type:'PC',break_source:'mdc',hasSource:true})).ok);
  assert.equal(e.state.captured.truck_no,'WH-Truck05');assert.equal(e.state.captured.break_source,'mdc');
  assert((await capture('/table',{truck_no:'WH-Truck03',mine_code:'WH',bag_type:'Perception',hasSource:false})).ok);
  assert.equal(e.state.captured.break_source,'');
  assert.equal((await capture('/mdc',{truck_no:'OTHER'})).ok,false);assert.equal(e.state.captured.truck_no,'WH-Truck03');
});

test('多批回传按时间排序同车串行，慢提交不阻塞车辆状态查询',async()=>{
  const gate=deferred(),calls=[];
  const e=await background({submitBatch:async(_t,items)=>{calls.push(structuredClone(items));await gate.promise;}});
  e.server.mdc=Array.from({length:35},(_,i)=>({...a,filename:`Perception_2026-11-03-09-${String(i).padStart(2,'0')}-00_${i}.bag`,create_time:`2026-11-03 09:${String(i).padStart(2,'0')}:00`})).reverse();
  const id=await start(e);await flush();
  assert.deepEqual(calls.map((xs)=>xs.length),[10]);
  assert.deepEqual(calls.flat().map((x)=>x.create_time),e.server.mdc.slice().reverse().slice(0,10).map((x)=>x.create_time));
  e.server.online=false;await e.call('tickTask',id);
  assert.equal(e.get(id).status,'waiting_vehicle');
  gate.resolve();await flush();assert.equal(calls.length,1);
  e.server.online=true;await e.call('tickTask',id);await flush();
  assert.equal(calls.length,4);assert.equal(calls[3].length,5);
  assert.deepEqual(calls.flat().map((x)=>x.create_time),e.server.mdc.slice().reverse().map((x)=>x.create_time));
  await e.call('tickTask',id);await flush();assert.equal(calls.length,4);
});
test('批量回传备注及分钟时间可核查自己的任务，不把同批其他包的成功当成已入库',async()=>{
  const e=await background();e.server.mdc=[a,{...b,filename:b.filename.replace('09-01-00','09-00-30'),create_time:'2026-11-03 09:00:30'}];
  const id=await start(e);const batchId=e.get(id).transfers[0].batchId;
  e.server.records=[{record_no:99,truck_no:'WH-Truck05',break_source:'mdc',remarks:`[BagFlowBatch:${batchId}]`,breaktime:'2026-11-03 09:00',status:'succeed'}];
  await e.call('tickTask',id);assert(e.get(id).transfers.every((i)=>i.state==='submitted'));
  assert.equal(e.downloads.length,0);assert.equal(e.submissions.length,2);
});
test('重叠回传任务只创建一次服务器回传',async()=>{
  const e=await background();const one=await start(e),two=await start(e);
  await e.call('tickTask',one);await e.call('tickTask',two);await flush();
  assert.equal(e.submissions.length,2);
  assert(e.get(two).transfers.every((i)=>i.submissionLocked));
});
test('浏览器重启保留任务、回传进度和运行代次，恢复未完成下载',async()=>{
  const e=await background();e.server.files=[a,b];const id=await start(e),token=e.get(id).runToken;
  await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true});await e.call('kick',id);
  assert.equal(e.get(id).items[0].state,'done');
  const reboot=await background({}, {state:e.state,server:e.server,now:Date.now()+60000});await flush();
  assert.equal(reboot.get(id).runToken,token);assert.equal(reboot.submissions.length,0);
  assert(reboot.get(id).transfers.every((i)=>i.state==='done'));
  assert.equal(reboot.get(id).items[0].state,'done');assert.equal(reboot.get(id).items[0].needsValidation,true);
  assert.equal(reboot.downloads[0].filename,a.filename);
  await reboot.call('onJobResult',{jobId:reboot.downloads[0].jobId,ok:true,skipped:true});await reboot.call('kick',id);
  assert.equal(reboot.downloads[1].filename,b.filename);
  await reboot.call('onJobResult',{jobId:reboot.downloads[1].jobId,ok:true});
  assert.equal(reboot.get(id).status,'done');
});
test('浏览器重启后旧失败回传只监测，未提交的旧队列直接采用批量规则',async()=>{
  const e=await background();const t=await e.create();
  e.state.tasks[0]={...t,status:'running',runToken:'preserved',discovered:true,searchReady:true,transfers:[
    {...a,state:'failed',attempts:3}, {...b,state:'pending',attempts:0},
  ]};
  const reboot=await background({}, {state:e.state,server:e.server});await flush();
  assert.equal(reboot.get(t.id).status,'running');assert.equal(reboot.get(t.id).runToken,'preserved');
  assert.deepEqual(reboot.submissions.map((x)=>x.filename),[b.filename]);
  assert.equal(reboot.get(t.id).transfers[0].submissionLocked,true);
});
test('已完成任务重启、重载和 worker 唤醒后保持完成，不读目录或再次要求授权',async()=>{
  const e=await background();e.server.files=[a];e.server.mdc=[a];const id=await start(e);
  await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true});assert.equal(e.get(id).status,'done');
  let checks=0;
  const reboot=await background({}, {state:e.state,server:{...e.server,online:false},dirStore:{async permission(){checks++;return 'prompt';}}});await flush();
  assert.equal(reboot.get(id).items[0].state,'done');assert.equal(reboot.notes.length,0);assert.equal(reboot.submissions.length,0);
  assert.equal(reboot.downloads.length,0);assert.equal(reboot.get(id).status,'done');assert.equal(checks,0);
  assert.equal(reboot.get(id).directoryBlocked,false);assert.equal(reboot.get(id).items[0].needsValidation,false);
  await reboot.call('execute',id);await flush();assert.equal(reboot.get(id).status,'done');assert.equal(checks,0);
  const wake=await background({}, {state:reboot.state,session:reboot.session,server:reboot.server});
  assert.equal(wake.downloads.length,0);assert.equal(wake.get(id).status,'done');
});
test('下载器未响应时保留活动 job，车辆监测仍可告警',async()=>{
  const e=await background();e.server.files=[a];const id=await start(e);const job=e.downloads[0].jobId;
  const original=e.chrome.runtime.sendMessage;
  e.chrome.runtime.sendMessage=async(msg)=>msg.type==='offscreen:status'?{ok:false}:original(msg);
  e.server.online=false;e.advance(60000);await e.call('reconcile');await flush();
  assert.equal(e.get(id).status,'waiting_vehicle');assert.equal(e.get(id).items[0].jobId,job);assert.equal(e.downloads.length,1);
});

test('已授权目录没有绝对路径也能创建任务，兼容旧目录且不重置现有进度',async()=>{
  const e=await background();e.state.dirs[0].path='';
  const t=await e.create({kind:'download'});assert.equal(t.dirId,'dir1');assert.equal(t.status,'ready');
  e.server.files=[a];await e.call('execute',t.id);await flush();assert.equal(e.downloads.length,1);
});
test('停止、删除校验确认时的运行代次，陈旧确认不影响任务或其他下载',async()=>{
 const e=await background();e.server.files=[a];const one=await start(e,{kind:'download'}),two=await start(e,{kind:'download'});
 const token=e.get(one).runToken;
 await assert.rejects(()=>e.call('stopTask',one,'stale'),/重新确认/);
 await assert.rejects(()=>e.call('deleteTask',one,'stale'),/重新确认/);
 assert.equal(e.get(one).runToken,token);const before=e.get(two);
 await e.call('deleteTask',one,token);await flush();assert.equal(e.get(one),undefined);
 const resumed=e.get(two);assert.equal(resumed.runToken,before.runToken);assert.equal(resumed.dirId,before.dirId);assert.equal(resumed.items[0].filename,before.items[0].filename);
 assert.equal(e.downloads.length,2);assert(e.activeJobs.has(resumed.items[0].jobId),'删除原写入者后应立即给等待任务分配下载');
 assert(!e.activeJobs.has(e.downloads[0].jobId));
 await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true});assert.deepEqual(e.get(two),resumed);
});
test('激活、导航和窗口聚焦主动请求当前目标页面捕获，后台窗口不能覆盖',async()=>{
 const e=await background(),sent=[];
 e.chrome.tabs.get=async id=>({id,url:id===7?'http://10.198.92.173:8080/search':'http://10.198.92.173:8080/mdc'});
 e.chrome.tabs.query=async q=>q.active?[{id:q.lastFocusedWindow?7:8}]:[];
 e.chrome.tabs.sendMessage=async(id,msg)=>{sent.push({id,msg});};
 e.chrome.tabs.onActivated.listeners[0]({tabId:7});e.chrome.tabs.onUpdated.listeners[0](7,{status:'complete'});e.chrome.windows.onFocusChanged.listeners[0](1);await flush();
 assert.equal(sent.length,1);assert(sent.every(x=>x.id===7&&x.msg.type==='capture:request'),'同一帧的激活/导航/聚焦合并为一次当前快照请求');
 await e.call('requestTabCapture',8);assert.equal(sent.length,1);
 const listener=e.chrome.runtime.onMessage.listeners[0];
 const result=await new Promise(resolve=>listener({type:'capture',payload:{page:'http://10.198.92.173:8080/search',truck_no:'inactive'}},{id:'test-extension',url:'http://10.198.92.173:8080/search',tab:{id:8,windowId:2}},resolve));
 assert.equal(result.applied,false);assert.equal(e.state.captured,undefined);
});
test('创建时保存完整路径快照，修改目录标签不覆盖旧任务，仅补全缺失路径',async()=>{
 const e=await background();e.state.dirs[0].displayPath='/home/first/bags';
 const t=await e.create({kind:'download'});assert.equal(t.dirPath,'/home/first/bags');
 e.state.tasks.push({...t,id:'legacy',dirPath:'',runToken:'preserved',items:[{...a,state:'done',bytes:4,attempts:0}]});
 const before=structuredClone(e.state.tasks[1]);e.state.dirs[0].displayPath='/home/second/bags';
 await e.call('fillMissingTaskPaths','dir1','/home/second/bags');
 assert.equal(e.get(t.id).dirPath,'/home/first/bags');assert.equal(e.get('legacy').dirPath,'/home/second/bags');
 assert.equal(e.get('legacy').runToken,before.runToken);assert.deepEqual(e.get('legacy').items,before.items);
 await e.call('fillMissingTaskPaths','dir1','/home/third/bags');assert.equal(e.get('legacy').dirPath,'/home/second/bags');
});
test('授权核查真实目录权限，立即解除共享目录阻塞并恢复下载，不重置任务',async()=>{
 const e=await background(),one=await e.create({kind:'download'}),two=await e.create({kind:'download'}),other=await e.create({kind:'download'});
 for(const t of e.state.tasks){t.status='running';t.runToken=t.id;t.searchReady=true;t.directoryBlocked=true;t.items=[{...a,state:'pending',attempts:0}];}
 e.state.tasks[2].dirId='other-dir';
 const before=e.get(other.id);e.context.DirStore.permission=async()=> 'prompt';
 await assert.rejects(()=>e.call('authorizeDirectory','dir1'),/写入权限/);assert(e.get(one.id).directoryBlocked);assert.equal(e.downloads.length,0);
 e.context.DirStore.permission=async()=> 'granted';assert.equal(await e.call('authorizeDirectory','dir1'),2);await flush();
 assert.equal(e.get(one.id).runToken,one.id);assert.equal(e.get(two.id).runToken,two.id);
 assert.equal(e.get(one.id).directoryBlocked,false);assert.equal(e.get(two.id).directoryBlocked,false);
 assert.equal(e.downloads.length,1);assert.deepEqual(e.get(other.id),before);assert.equal(e.submissions.length,0);
});
test('移除网页告警广播后仍保留浏览器通知和扩展角标',async()=>{
 const e=await background(),messages=[],badges=[];
 e.chrome.tabs.query=async()=>[{id:7}];e.chrome.tabs.sendMessage=async(_id,msg)=>{messages.push(msg);};
 e.chrome.action.setBadgeText=async msg=>{badges.push(msg.text);};e.server.online=false;
 await start(e);await e.call('publishAlerts');
 assert.equal(e.notes.length,1);assert(badges.includes('1'));assert.equal(messages.some(msg=>msg.type==='alerts'),false);
});
test('全部下载成功才完成；达到失败次数上限的任务保留需处理状态并可重试',async()=>{
 const e=await background();e.server.files=[a];const id=await start(e,{kind:'download'});
 for(let n=0;n<3;n++) {
   await e.call('onJobResult',{jobId:e.downloads[n].jobId,ok:false,error:'写入失败'});
   e.advance(4000);await e.call('kick',id);
 }
 assert.equal(e.get(id).status,'error');assert.equal(e.get(id).items[0].state,'failed');
 await e.call('execute',id);await flush();assert.equal(e.downloads.length,4);
 await e.call('onJobResult',{jobId:e.downloads[3].jobId,ok:true});assert.equal(e.get(id).status,'done');
});
test('目录任务多次断网后仍待自动重试，其他目录和原任务运行代次保留',async()=>{
 const e=await background();e.server.files=[a];const id=await start(e,{kind:'download'}),original=e.get(id);
 for(let n=0;n<5;n++){
   await e.call('onJobResult',{jobId:e.get(id).items[0].jobId,ok:false,code:'TypeError',error:'Failed to fetch'});
   assert.equal(e.get(id).status,'running');assert.equal(e.get(id).items[0].state,'pending');
   e.advance(65000);await e.call('kick',id);assert.equal(e.get(id).dirId,original.dirId);assert.equal(e.get(id).dirPath,original.dirPath);assert.equal(e.get(id).runToken,original.runToken);
 }
 await e.call('onJobResult',{jobId:e.get(id).items[0].jobId,ok:true,bytes:4,totalBytes:4});assert.equal(e.get(id).status,'done');
});
test('重载后的目标页缺失桥接时补注入，其他网址不注入，正常桥接不重复注入',async()=>{
 const e=await background(),scripts=[],sent=[];
 e.chrome.tabs.get=async id=>({id,url:id===7?'http://10.198.92.173:8080/search':'http://10.198.92.173:8080/mdc'});
 e.chrome.scripting={async executeScript(options){scripts.push(options);}};
 let connected=false;
 e.chrome.tabs.sendMessage=async id=>{sent.push(id);if(!connected){connected=true;throw Error('Receiving end does not exist');}return {ok:true,captureVersion:2};};
 await e.call('requestTabCapture',7);assert.deepEqual(scripts.map(x=>x.files[0]),['content-bridge.js','content-main.js']);assert.equal(scripts[1].world,'MAIN');
 await e.call('requestTabCapture',7);await e.call('requestTabCapture',8);assert.equal(scripts.length,2);assert(sent.every(id=>id===7));
});
test('过期序号、路由快照和后台页面不能覆盖当前最新筛选',async()=>{
 const e=await background();e.chrome.tabs.query=async()=>[{id:7}];
 const listener=e.chrome.runtime.onMessage.listeners[0],sender={id:e.chrome.runtime.id,url:'http://10.198.92.173:8080/search',tab:{id:7,windowId:1}};
 const send=(sequence,truck_no,page=sender.url)=>new Promise(resolve=>listener({type:'capture',payload:{sequence,documentToken:'same-document',truck_no,mine_code:'WH',bag_type:'Perception',page}},sender,resolve));
 const responses=await Promise.all([send(2,'new'),send(1,'old')]);assert(responses[0].applied);assert.equal(responses[1].applied,false);assert.equal(e.state.captured.truck_no,'new');
 assert.equal((await send(3,'wrong-route','http://10.198.92.173:8080/table')).applied,false);assert.equal(e.state.captured.truck_no,'new');
});
