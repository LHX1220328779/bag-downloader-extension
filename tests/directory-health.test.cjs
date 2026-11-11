const test=require('node:test'),assert=require('node:assert/strict');
const Health=require('../directory-health.js');
const {background,flush,deferred,a,b,vm,source}=require('./helpers.cjs');
const error=(name,message)=>Object.assign(Error(message),{name});
async function start(e){const t=await e.create({kind:'download'});await e.call('execute',t.id);await flush();return t.id;}

test('句柄缺失和查询失败与真实权限不足分开，临时存储故障恢复后可以重查',async()=>{
  assert.equal((await Health.inspect(null)).state,'missing');
  assert.equal((await Health.inspect({handle:{queryPermission:async()=> 'prompt'}})).state,'permission');
  const failed=await Health.inspect({handle:{queryPermission:async()=>{throw error('InvalidStateError','storage disconnected');}}});
  assert.equal(failed.state,'unavailable');assert.equal(failed.code,'DIRECTORY_CHECK_FAILED');assert.equal(failed.errorCode,'InvalidStateError');
  let unavailable=true;
  const store={async get(){if(unavailable)throw error('InvalidStateError','database closed');return {handle:{queryPermission:async()=> 'granted'}};}};
  assert.equal((await Health.check(store,'same-dir')).state,'unavailable');unavailable=false;
  assert.equal((await Health.check(store,'same-dir')).state,'granted');
});
test('有效授权直接复用，明确拒绝不自动请求；持久授权恢复失败保留 prompt',async()=>{
  let calls=0;
  const handle={queryPermission:async()=> 'granted',async requestPermission(){calls++;return 'granted';}};
  assert.equal((await Health.inspect({handle},{restore:true})).state,'granted');assert.equal(calls,0);
  handle.queryPermission=async()=> 'denied';
  assert.equal((await Health.inspect({handle},{restore:true})).state,'permission');assert.equal(calls,0);
  handle.queryPermission=async()=> 'prompt';handle.requestPermission=async()=>{calls++;throw error('SecurityError','User activation is required');};
  const access=await Health.inspect({handle},{restore:true});
  assert.equal(access.permission,'prompt');assert.equal(access.restoreError.code,'SecurityError');assert.equal(calls,1);
});
test('等待传播的点击状态消失后才静默恢复，持续活跃时延后重试而不请求授权',async()=>{
  async function inspectPage(remainActive){
    const activation={isActive:true},calls=[];let time=0;
    const context=vm.createContext({console,navigator:{userActivation:activation},Date:class extends Date{static now(){return time;}},
      setTimeout(fn,delay){time+=delay;if(!remainActive)activation.isActive=false;queueMicrotask(fn);}});
    vm.runInContext(source('directory-health.js'),context);
    context.record={handle:{async queryPermission(){return 'prompt';},async requestPermission(){calls.push(activation.isActive);return 'granted';}}};
    return {access:await vm.runInContext('DirectoryHealth.inspect(record,{restore:true})',context),calls,time};
  }
  const ready=await inspectPage(false);assert.equal(ready.access.state,'granted');assert.deepEqual(ready.calls,[false]);assert(ready.time>0);
  const waiting=await inspectPage(true);assert.equal(waiting.access.code,'DIRECTORY_RESTORE_PENDING');assert.equal(waiting.access.state,'unavailable');
  assert.equal(waiting.calls.length,0);assert.equal(waiting.time,6000);
});
test('权限 granted 不等于目录存在，断开的实际目录单独识别',async()=>{
  const handle={queryPermission:async()=> 'granted',values(){return {async next(){throw error('NotFoundError','volume disconnected');}};}};
  const access=await Health.inspect({handle},{verify:true});
  assert.equal(access.state,'unavailable');assert.equal(access.code,'DIR_NOT_FOUND');
});
test('已完成、已停止、待执行和原生任务不显示目录授权，活动任务只按真实故障显示',()=>{
  const base={downloadBackend:'directory',directoryBlocked:true,directoryAccess:Health.fromPermission('prompt')};
  for(const status of ['done','stopped','ready','error'])assert.equal(Health.taskIssue({...base,status},'prompt'),null);
  assert.equal(Health.taskIssue({...base,status:'running',downloadBackend:'browser'},'prompt'),null);
  assert.equal(Health.taskIssue({...base,status:'running'},'prompt').state,'permission');
  assert.equal(Health.taskIssue({...base,status:'running',directoryAccess:Health.failure('NO_DIR')},'missing').state,'missing');
  assert.equal(Health.taskIssue({status:'running',directoryBlocked:true},'unavailable').state,'unavailable');
  assert.equal(Health.taskIssue({status:'running',directoryBlocked:true},'granted'),null);
});
test('升级恢复旧版本误拉起的完成核验，保持任务 ID、完整目录和运行代次',async()=>{
  const old={id:'completed-task',status:'running',kind:'download',localVerificationOnly:true,dirId:'dir1',dirPath:'D:\\one\\rtfbag',
    runToken:'original-token',searchReady:true,directoryBlocked:true,items:[{...a,state:'done',needsValidation:true},{...b,state:'done',needsValidation:true}],transfers:[]};
  let queries=0;
  const e=await background({}, {state:{tasks:[old]},dirStore:{async permission(){queries++;return 'prompt';}}});
  const t=e.get(old.id);
  assert.equal(t.status,'done');assert.equal(t.localVerificationOnly,false);assert.equal(t.directoryBlocked,false);
  assert.equal(t.dirId,old.dirId);assert.equal(t.dirPath,old.dirPath);assert.equal(t.runToken,old.runToken);
  assert(t.items.every(i=>i.state==='done'&&!i.needsValidation));assert.equal(queries,0);assert.equal(e.downloads.length,0);
});
test('用户停止的旧核验任务不会在升级时改为完成或重新开始',async()=>{
  const t={id:'stopped',status:'stopped',kind:'download',localVerificationOnly:true,dirId:'dir1',runToken:'stopped-token',items:[{...a,state:'done',needsValidation:true}],transfers:[]};
  const e=await background({}, {state:{tasks:[t]}});
  assert.equal(e.get(t.id).status,'stopped');assert.equal(e.get(t.id).runToken,t.runToken);assert.equal(e.downloads.length,0);
});
test('目录记录暂不可读会自动重试，恢复后继续原目录且不消耗下载失败次数',async()=>{
  const e=await background();e.server.files=[a];
  const t=await e.create({kind:'download'}),get=e.context.DirStore.get;
  e.context.DirStore.get=async()=>{throw error('InvalidStateError','database unavailable');};
  await e.call('execute',t.id);await flush();
  let blocked=e.get(t.id);
  assert.equal(blocked.directoryBlocked,false);assert.equal(blocked.directoryAccess.state,'unavailable');
  assert.equal(blocked.items[0].attempts,0);assert.equal(e.downloads.length,0);
  const token=blocked.runToken;e.context.DirStore.get=get;e.advance(31000);await e.call('tickTask',t.id);await flush();
  blocked=e.get(t.id);assert.equal(blocked.directoryAccess,undefined);assert.equal(e.downloads.length,1);
  assert.equal(blocked.dirId,t.dirId);assert.equal(blocked.dirPath,t.dirPath);assert.equal(blocked.runToken,token);
});
test('缺失目录句柄不显示授权，原记录恢复后自动继续且其他任务目录不变',async()=>{
  const e=await background();e.server.files=[a];const t=await e.create({kind:'download'}),get=e.context.DirStore.get;
  const other=await e.create({kind:'download'});e.state.tasks.find(x=>x.id===other.id).dirId='other-dir';
  const before=e.get(other.id);e.context.DirStore.get=async id=>id===t.dirId?null:get(id);
  await e.call('execute',t.id);await flush();assert.equal(e.get(t.id).directoryAccess.state,'missing');assert.equal(e.get(t.id).directoryBlocked,false);
  e.context.DirStore.get=get;e.advance(31000);await e.call('tickTask',t.id);await flush();
  assert.equal(e.downloads.length,1);assert.deepEqual(e.get(other.id),before);assert.equal(e.get(t.id).dirId,t.dirId);
});
test('后台恢复已有持久授权，无需用户操作即可开始原目录下载',async()=>{
  let permission='granted',restores=0;
  const record={handle:{async queryPermission(){return permission;},async requestPermission(){restores++;permission='granted';return permission;}}};
  const e=await background({}, {dirStore:{async get(){return record;},async permission(r){return r.handle.queryPermission();}}});
  e.server.files=[a];const t=await e.create({kind:'download'});permission='prompt';
  await e.call('execute',t.id);await flush();
  assert.equal(restores,1);assert.equal(e.downloads.length,1);assert.equal(e.get(t.id).directoryBlocked,false);assert.equal(e.get(t.id).dirId,t.dirId);
});
test('延后的静默恢复自动重试，不提前显示授权且保留原目录与运行代次',async()=>{
  const e=await background();e.server.files=[a];const t=await e.create({kind:'download'}),send=e.chrome.runtime.sendMessage;let ready=false;
  e.context.DirStore.permission=async()=> 'prompt';
  e.chrome.runtime.sendMessage=async msg=>msg.type==='offscreen:directory'?{ok:true,access:ready?{state:'granted',permission:'granted'}:Health.failure('DIRECTORY_RESTORE_PENDING')}:send(msg);
  await e.call('execute',t.id);await flush();const waiting=e.get(t.id);
  assert.equal(waiting.directoryBlocked,false);assert.equal(waiting.directoryAccess.code,'DIRECTORY_RESTORE_PENDING');assert.equal(waiting.items[0].attempts,0);
  assert.equal(waiting.directoryAccess.retryAt-waiting.updatedAt,5000);assert.equal(e.downloads.length,0);
  ready=true;e.advance(5100);await e.call('tickTask',t.id);await flush();const restored=e.get(t.id);
  assert.equal(restored.directoryAccess,undefined);assert.equal(restored.dirId,t.dirId);assert.equal(restored.dirPath,t.dirPath);
  assert.equal(restored.runToken,waiting.runToken);assert.equal(e.downloads.length,1);
});
test('等待数据和正在写入的任务不被心跳反复检查授权，后续新文件才重查',async()=>{
  const e=await background(),created=await e.create();await e.call('execute',created.id);await flush();const id=created.id;let queries=0;
  e.context.DirStore.permission=async()=>{queries++;return 'prompt';};
  await e.call('tickTask',id);await flush();assert.equal(queries,0);assert.equal(e.get(id).status,'running');assert.equal(!!e.get(id).directoryBlocked,false);
  e.context.DirStore.permission=async()=> 'granted';e.server.files=[a,b];await e.call('tickTask',id);await flush();
  e.context.DirStore.permission=async()=>{queries++;return 'prompt';};
  e.advance(16000);await e.call('tickTask',id);await flush();assert.equal(queries,0);assert.equal(e.get(id).directoryBlocked,false);assert.equal(e.downloads.length,1);
  await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true});await e.call('kick',id);await flush();
  assert(queries>0);assert.equal(e.get(id).directoryAccess.state,'permission');assert.equal(e.downloads.length,1);
});
test('真实权限等待按间隔自动重查，同一原因只记录一次且保留已完成文件状态',async()=>{
  const e=await background();e.server.files=[a,b];const id=await start(e);
  await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true});
  e.context.DirStore.permission=async()=> 'prompt';e.advance(4000);await e.call('kick',id);await flush();
  let t=e.get(id);assert.equal(t.directoryAccess.state,'permission');assert.equal(t.items[0].state,'done');
  const count=()=>e.get(id).events.filter(x=>x.message.includes('NEED_PERMISSION')).length;
  assert.equal(count(),1);e.advance(61000);await e.call('tickTask',id);await flush();assert.equal(count(),1);
  e.context.DirStore.permission=async()=> 'granted';e.advance(61000);await e.call('tickTask',id);await flush();
  t=e.get(id);assert.equal(t.directoryBlocked,false);assert.equal(t.directoryAccess,undefined);assert.equal(e.downloads.length,2);
});
test('停止发生在权限检查期间时，迟到的恢复结果不重新开始任务',async()=>{
  const gate=deferred();let permission='granted';
  const record={handle:{queryPermission:async()=>permission,async requestPermission(){await gate.promise;permission='granted';return permission;}}};
  const e=await background({}, {dirStore:{async get(){return record;},async permission(r){return r.handle.queryPermission();}}});
  e.server.files=[a];const t=await e.create({kind:'download'});permission='prompt';await e.call('execute',t.id);await flush();
  await e.call('stopTask',t.id);const stopped=e.get(t.id);gate.resolve();await flush();
  assert.equal(e.get(t.id).status,'stopped');assert.equal(e.get(t.id).runToken,stopped.runToken);assert.equal(e.downloads.length,0);
});
test('较早的权限检查迟到时不会覆盖已成功授权或再次阻塞下载',async()=>{
  const e=await background();e.server.files=[a];const t=await e.create({kind:'download'}),gate=deferred(),send=e.chrome.runtime.sendMessage;
  let permission='prompt';e.context.DirStore.permission=async()=>permission;
  e.chrome.runtime.sendMessage=async m=>m.type==='offscreen:directory'?gate.promise:send(m);
  await e.call('execute',t.id);await flush();permission='granted';await e.call('authorizeDirectory',t.dirId);
  gate.resolve({ok:true,access:{state:'permission',code:'NEED_PERMISSION',permission:'prompt',message:'stale permission'}});await flush();
  assert.equal(e.get(t.id).directoryBlocked,false);assert.equal(e.get(t.id).directoryAccess,undefined);assert.equal(e.downloads.length,1);
});
