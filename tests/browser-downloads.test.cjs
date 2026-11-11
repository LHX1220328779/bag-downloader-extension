const test = require('node:test'), assert = require('node:assert/strict');
const { background, a, b, flush, clone, deferred } = require('./helpers.cjs');
async function browserEnv({ state, records = new Map(), missingLength = false, resume = [], calls = [], pendingStart, defaultPath = '/home/test/Downloads' } = {}) {
  let currentDirectory = defaultPath;
  let uiEnabled=true;const uiEvents=[];
  const downloads = {
    async setUiOptions(o){uiEnabled=o.enabled;uiEvents.push(o.enabled);},
    async search(q) { return clone([...records.values()].filter(d => q.id != null ? d.id === q.id : !q.url || d.url === q.url)); },
    async download(p) {
      assert.equal(uiEnabled,false,'数据包必须在下载 UI 关闭时启动');
      calls.push(clone(p)); const id = records.size + 1;
      const sep=currentDirectory.includes('\\')?'\\':'/';
      records.set(id, { id, byExtensionId: 'test-extension', url: p.url, filename: currentDirectory + sep + p.filename.replaceAll('/',sep),
        state: 'in_progress', paused: false, exists: true, bytesReceived: 0, totalBytes: 4, fileSize: 4 });
      if (pendingStart) await pendingStart.promise;
      return id;
    },
    async pause(id) { records.get(id).paused = true; },
    async resume(id) { assert.equal(uiEnabled,false,'恢复原下载前关闭下载 UI');resume.push(id); Object.assign(records.get(id), { paused: false, state: 'in_progress' }); },
    async cancel(id) { Object.assign(records.get(id), { state: 'interrupted', error: 'USER_CANCELED' }); },
  };
  const e = await background({ async post() { return 'http://10.198.92.173:8099/files/0'; } }, {
    state, downloads, browserDefaultPath: defaultPath, fetch: async url => ({ ok: true, status: 200, url,
      headers: { get(name) { return name === 'Content-Length' && !missingLength ? '4' : null; } } }),
    server: { files: [a] },
  });
  e.context.DirStore.permission = async () => { throw Error('浏览器下载不能请求目录句柄权限'); };
  const create = async () => {
    await e.call('ensureBrowserDirectory', true);
    const t = await e.create({ kind: 'download', dir_id: 'browser-downloads:bags' });
    await e.call('execute', t.id); await flush(); return t.id;
  };
  return { ...e, records, resume, calls, uiEvents,get uiEnabled(){return uiEnabled;},start: create, setDirectory(path) { currentDirectory=path;e.server.downloadDirectory=path; } };
}
test('浏览器下载无需目录句柄，真实路径与下载 ID 持久保存，完整长度才完成', async () => {
  const e = await browserEnv(), id = await e.start();
  assert.equal(e.calls.length, 1); assert.equal(e.calls[0].saveAs, false);
  assert.equal(e.calls[0].filename, a.filename);
  const t = e.get(id), item = t.items[0];
  assert.equal(t.downloadBackend, 'browser'); assert.equal(t.directoryBlocked, false);
  assert.equal(item.browserDownloadId, 1); assert.equal(item.expectedBytes, 4);
  assert.equal(item.downloadPath, '/home/test/Downloads/' + a.filename);
  assert.equal(e.state.dirs[0].path, '/home/test/Downloads');
  Object.assign(e.records.get(1), { state: 'complete', bytesReceived: 4 });
  await e.call('browserDownloadPoll', item.jobId);
  assert.equal(e.get(id).status, 'done');
  const completed=e.get(id);
  await e.call('execute', id); await flush();
  assert.equal(e.calls.length, 1); assert.equal(e.get(id).runToken,completed.runToken);
  assert.deepEqual(e.get(id).items,completed.items);
});
test('浏览器重载恢复同一个下载，不新建 GET，不重置运行代次和旧任务目录', async () => {
  const e = await browserEnv(), id = await e.start(), original = e.get(id);
  e.state.tasks.push({ ...original, id: 'old-task', downloadBackend: 'directory', dirId: 'old-dir', status: 'stopped' });
  const before = clone(e.state.tasks[1]);
  const reboot = await browserEnv({ state: clone(e.state), records: e.records, calls: e.calls });
  await reboot.call('browserDownloadReconcile'); await flush();
  assert.equal(reboot.calls.length, 1); assert.equal(reboot.get(id).runToken, original.runToken);
  assert.equal(reboot.get(id).items[0].browserDownloadId, 1); assert.deepEqual(reboot.get('old-task'), before);
});
test('停止暂停原下载，再次执行恢复原 ID；删除才取消，迟到结果不影响其他任务', async () => {
  const e = await browserEnv(), id = await e.start();
  await e.call('stopTask', id); assert.equal(e.records.get(1).paused, true);
  await e.call('execute', id); await flush();
  assert.equal(e.calls.length, 1); assert.deepEqual(e.resume, [1]); assert.equal(e.records.get(1).paused, false);
  await e.call('deleteTask', id); assert.equal(e.records.get(1).error, 'USER_CANCELED'); assert.equal(e.get(id), undefined);
});
test('截断、长度未知及本地文件缺失不能误记完成或跳过', async () => {
  const unknown = await browserEnv({ missingLength: true }), id = await unknown.start();
  assert.equal(unknown.calls.length, 0); assert.equal(unknown.get(id).items[0].state, 'pending');
  const e = await browserEnv(), task = await e.start(), item = e.get(task).items[0];
  Object.assign(e.records.get(1), { state: 'complete', bytesReceived: 2, fileSize: 2 });
  await e.call('browserDownloadPoll', item.jobId);
  assert.notEqual(e.get(task).status, 'done'); assert.equal(e.get(task).items[0].state, 'pending');
  e.advance(4000); await e.call('kick', task); assert.equal(e.calls.length, 2);
  Object.assign(e.records.get(2), { state: 'complete', bytesReceived: 4, exists: false });
  await e.call('browserDownloadPoll', e.get(task).items[0].jobId); assert.notEqual(e.get(task).status, 'done');
});
test('任务启动与下载 ID 写回之间停止，迟到的下载被暂停而非继续写入', async () => {
  const start = deferred(), e = await browserEnv({ pendingStart: start });
  await e.call('ensureBrowserDirectory', true); const t = await e.create({ kind: 'download', dir_id: 'browser-downloads:bags' });
  await e.call('execute', t.id); await flush(); assert.equal(e.calls.length, 1);
  await e.call('stopTask', t.id); start.resolve(); await flush();
  assert.equal(e.get(t.id).status, 'stopped'); assert.equal(e.records.get(1).paused, true);
  assert.equal(e.get(t.id).items[0].browserDownloadId, 1);
});
test('丢失下载 ID 但保存了启动意图时找回原浏览器下载，重叠任务复用完成记录', async () => {
  const e = await browserEnv(), id = await e.start();
  delete e.state.tasks[0].items[0].browserDownloadId;
  await e.call('browserDownloadReconcile'); assert.equal(e.calls.length, 1);
  assert.equal(e.get(id).items[0].browserDownloadId, 1);
  Object.assign(e.records.get(1), { state: 'complete', bytesReceived: 4 });
  await e.call('browserDownloadPoll', e.get(id).items[0].jobId);
  const second = await e.start(); assert.equal(e.calls.length, 1); assert.equal(e.get(second).status, 'done');
});
test('浏览器声称可恢复但恢复失败时重试未完成文件，不永久卡住原 ID', async () => {
  const e = await browserEnv(), id = await e.start();
  Object.assign(e.records.get(1), { state: 'interrupted', canResume: true });
  e.chrome.downloads.resume = async () => { throw Error('原下载无法恢复'); };
  await e.call('browserDownloadReconcile');
  assert.equal(e.calls.length, 2); assert.equal(e.get(id).items[0].browserDownloadId, 2);
});
test('Windows 完整路径由浏览器回报并原样持久保存', async () => {
  const e = await browserEnv({defaultPath:'C:\\Users\\Tester\\Downloads\\bags'}), id = await e.start();
  await e.call('browserDownloadPoll', e.get(id).items[0].jobId);
  assert.equal(e.get(id).items[0].downloadPath, e.records.get(1).filename);
  assert.equal(e.state.dirs[0].path, 'C:\\Users\\Tester\\Downloads\\bags');
});
test('启动回执暂未返回且尚无下载记录时等待原启动，不立即提交重复下载', async () => {
  const e = await browserEnv(), id = await e.start();
  e.records.clear(); delete e.state.tasks[0].items[0].browserDownloadId;
  await e.call('browserDownloadReconcile'); assert.equal(e.calls.length, 1);
  e.advance(46000); await e.call('browserDownloadReconcile'); assert.equal(e.calls.length, 2);
  assert.equal(e.get(id).items[0].state, 'downloading');
});
test('创建时固定完整目录；新任务改下载位置不改变旧任务或复用其他目录凭据',async()=>{
  const e=await browserEnv(),first=await e.start();const firstItem=e.get(first).items[0];
  Object.assign(e.records.get(1),{state:'complete',bytesReceived:4});await e.call('browserDownloadPoll',firstItem.jobId);
  e.setDirectory('/home/test/Kushan');const second=await e.start();
  assert.equal(e.get(first).dirPath,'/home/test/Downloads');assert.equal(e.get(second).dirPath,'/home/test/Kushan');
  assert.equal(e.calls.length,2,'相同包在其他任务目录不能复用错误路径凭据');assert.equal(e.get(second).items[0].downloadPath,'/home/test/Kushan/'+a.filename);
});
test('任务创建后下载位置切换时阻止新下载；切回原位置原任务自动继续',async()=>{
  const e=await browserEnv();await e.call('ensureBrowserDirectory',true);const t=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
  assert.equal(e.get(t.id).dirPath,'/home/test/Downloads');e.setDirectory('/home/test/Kushan');
  await e.call('execute',t.id);await flush();assert.equal(e.calls.length,0);assert.equal(e.get(t.id).locationBlocked,true);assert.equal(e.get(t.id).items[0].attempts,0);assert.equal(e.get(t.id).dirPath,'/home/test/Downloads');
  e.setDirectory('/home/test/Downloads');e.advance(16000);await e.call('tickTask',t.id);await flush();
  assert.equal(e.calls.length,1);assert.equal(e.get(t.id).locationBlocked,false);assert.equal(e.get(t.id).items[0].downloadPath,'/home/test/Downloads/'+a.filename);
});
test('全局目录变化不妨碍已启动的原 ID 续传，也不能覆盖任务目录',async()=>{
  const e=await browserEnv(),id=await e.start();e.setDirectory('/home/test/Kushan');await e.call('browserDownloadReconcile');
  assert.equal(e.calls.length,1);assert.equal(e.get(id).items[0].browserDownloadId,1);assert.equal(e.get(id).dirPath,'/home/test/Downloads');
});
test('探测后发生路径竞态，错误目录新传输停止且原路径不被改写',async()=>{
  const wait=deferred(),e=await browserEnv({pendingStart:wait});const start=e.start();await flush();e.records.get(1).filename='/home/test/Kushan/'+a.filename;wait.resolve();const id=await start;
  assert.equal(e.get(id).dirPath,'/home/test/Downloads');assert.equal(e.get(id).locationBlocked,true);assert.equal(e.records.get(1).error,'USER_CANCELED');
  assert.equal(e.get(id).items[0].browserDownloadId,undefined);assert.equal(e.get(id).items[0].state,'pending');
});
test('不同完整目录的同名包可同时运行，切到 B 不阻塞或取消 A 的原下载',async()=>{
  const e=await browserEnv(),first=await e.start(),firstJob=e.get(first).items[0].jobId;
  e.setDirectory('/home/test/Kushan');const second=await e.start();
  assert.equal(e.calls.length,2);assert.equal(e.records.get(1).paused,false);assert.equal(e.get(first).items[0].jobId,firstJob);
  assert.equal(e.get(first).dirPath,'/home/test/Downloads');assert.equal(e.get(second).dirPath,'/home/test/Kushan');
  await e.call('browserDownloadReconcile');assert.equal(e.calls.length,2);assert.equal(e.get(first).items[0].browserDownloadId,1);assert.equal(e.get(second).items[0].browserDownloadId,2);
  for(const id of [first,second]){const item=e.get(id).items[0];Object.assign(e.records.get(item.browserDownloadId),{state:'complete',bytesReceived:4});await e.call('browserDownloadPoll',item.jobId);assert.equal(e.get(id).status,'done');}
  assert.equal(e.calls.length,2);assert.equal(Object.keys(e.state.browserFiles).filter(k=>k.startsWith('path:')).length,2);
});
test('相同完整目录同名包仍只有一个写入者，第二任务复用完整原文件',async()=>{
  const e=await browserEnv(),first=await e.start(),second=await e.start();assert.equal(e.calls.length,1);assert.equal(e.get(second).items[0].jobId,null);
  Object.assign(e.records.get(1),{state:'complete',bytesReceived:4});await e.call('browserDownloadPoll',e.get(first).items[0].jobId);
  await flush();assert.equal(e.calls.length,1);assert.equal(e.get(second).status,'done');assert.equal(e.get(second).items[0].skipped,true);
});
test('目录等待不作为下载失败，多任务共享核查且不反复创建 job 或错误日志',async()=>{
  const e=await browserEnv();await e.call('ensureBrowserDirectory',true);
  const one=await e.create({kind:'download',dir_id:'browser-downloads:bags'}),two=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
  e.setDirectory('/home/test/Kushan');for(const t of [one,two]){await e.call('execute',t.id);await flush();}
  const before=clone(e.state.tasks);let probes=0;const download=e.chrome.downloads.download;
  e.chrome.downloads.download=async p=>{if(p.url.startsWith('data:'))probes++;return download(p);};
  for(let n=0;n<10;n++)for(const t of [one,two])await e.call('kick',t.id);
  assert.equal(probes,0);e.advance(16000);for(const t of [one,two])await e.call('kick',t.id);assert.equal(probes,1);
  for(const t of [one,two]){const result=e.get(t.id),previous=before.find(r=>r.id===t.id);assert.equal(result.status,'running');assert.equal(result.runToken,previous.runToken);assert.equal(result.dirPath,'/home/test/Downloads');assert.equal(result.items[0].jobId,null);assert.equal(result.items[0].attempts,0);assert.equal(result.items[0].error,'');assert.equal(result.items[0].overwrite,false);assert.equal(result.locationWait.current,'/home/test/Kushan');assert.equal(result.locationWait.required,'/home/test/Downloads');assert.equal(result.events.filter(r=>r.message==='浏览器下载目录尚未包含本任务保存位置').length,1);}
  assert.equal(e.calls.length,0);assert.equal(e.notes.length,0);
});
test('迁移旧目录报错为等待，保留原目录、运行代次和下载记录',async()=>{
  const e=await browserEnv();await e.call('ensureBrowserDirectory',true);const t=await e.create({kind:'download',dir_id:'browser-downloads:bags'}),saved=e.state.tasks[0];
  Object.assign(saved,{status:'running',runToken:'original-token',locationBlocked:true,message:'浏览器下载位置已改变。请将下载位置切回 /home/test/Downloads，此任务将自动继续',items:[{...a,state:'pending',attempts:0,browserDownloadId:42,expectedBytes:4,error:'浏览器下载位置已改变。请将下载位置切回 /home/test/Downloads，此任务将自动继续',retryAt:Date.now()+15000}]});
  const reboot=await browserEnv({state:clone(e.state),defaultPath:'/home/test/Kushan'}),result=reboot.get(t.id);
  assert.equal(result.runToken,'original-token');assert.equal(result.dirPath,'/home/test/Downloads');assert.equal(result.items[0].browserDownloadId,42);assert.equal(result.items[0].expectedBytes,4);assert.equal(result.items[0].error,'');assert.equal(result.locationWait.required,'/home/test/Downloads');assert.equal(reboot.calls.length,0);
});
test('等待其他目录时仍可核验已完整文件，不要求切换目录或重新下载',async()=>{
  const e=await browserEnv(),id=await e.start();Object.assign(e.records.get(1),{state:'complete',bytesReceived:4});await e.call('browserDownloadPoll',e.get(id).items[0].jobId);
  e.setDirectory('/home/test/Kushan');await e.call('browserCurrentDirectory');
  const saved=e.state.tasks[0];saved.status='running';saved.locationBlocked=true;saved.locationWait={current:'/home/test/Kushan',required:saved.dirPath};saved.items[0].needsValidation=true;
  await e.call('kick',id);assert.equal(e.calls.length,1);assert.equal(e.get(id).items[0].skipped,true);assert.equal(e.get(id).status,'done');assert.equal(e.get(id).locationBlocked,false);assert.equal(e.get(id).locationWait,undefined);
});
test('默认目录为共同上级时自动分配原 A/B 目录，不改路径、不追加 bags',async()=>{
  const e=await browserEnv();await e.call('ensureBrowserDirectory',true);
  const one=await e.create({kind:'download',dir_id:'browser-downloads:bags'});e.setDirectory('/home/test/Kushan');const two=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
  e.setDirectory('/home/test');for(const t of [one,two]){await e.call('execute',t.id);await flush();}
  assert.equal(e.calls.length,2);assert.equal(e.calls[0].filename,'Downloads/'+a.filename);assert.equal(e.calls[1].filename,'Kushan/'+a.filename);
  assert.equal(e.get(one.id).dirPath,'/home/test/Downloads');assert.equal(e.get(two.id).dirPath,'/home/test/Kushan');
  assert.equal(e.records.get(1).filename,'/home/test/Downloads/'+a.filename);assert.equal(e.records.get(2).filename,'/home/test/Kushan/'+a.filename);
  assert.equal(e.get(one.id).locationBlocked,false);assert.equal(e.get(two.id).locationBlocked,false);
});
test('共同上级可恢复等待任务，同名前缀的旁边目录仍不能绕过路径隔离',async()=>{
  const e=await browserEnv();await e.call('ensureBrowserDirectory',true);const t=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
  e.setDirectory('/home/test/Download');await e.call('execute',t.id);await flush();assert.equal(e.calls.length,0);assert(e.get(t.id).locationWait);
  e.setDirectory('/home/test');e.advance(16000);await e.call('kick',t.id);
  assert.equal(e.calls.length,1);assert.equal(e.calls[0].filename,'Downloads/'+a.filename);assert.equal(e.get(t.id).dirPath,'/home/test/Downloads');assert.equal(e.get(t.id).locationWait,undefined);
});
test('历史 bags 任务从共同上级调度时保留原目录，不能生成第二层 bags',async()=>{
  const e=await browserEnv();await e.call('ensureBrowserDirectory',true);const t=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
  Object.assign(e.state.tasks[0],{dirPath:'/home/test/Downloads/bags',browserRelativeDir:'bags'});
  e.setDirectory('/home/test');await e.call('execute',t.id);await flush();
  assert.equal(e.calls[0].filename,'Downloads/bags/'+a.filename);assert.equal(e.get(t.id).dirPath,'/home/test/Downloads/bags');assert.equal(e.get(t.id).items[0].downloadPath,'/home/test/Downloads/bags/'+a.filename);
});
test('Windows 与 UNC 共同上级支持相对下载，原完整路径及大小写仍保留',async()=>{
  for(const [target,root,relative] of [['C:\\Data\\Haibo\\Huaining\\06\\rtfbag','c:\\Data\\Haibo','Huaining/06/rtfbag'],['\\\\server\\share\\Haibo\\Huaining\\06','\\\\SERVER\\SHARE\\Haibo','Huaining/06']]){
    const e=await browserEnv({defaultPath:target});await e.call('ensureBrowserDirectory',true);const t=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
    e.setDirectory(root);await e.call('execute',t.id);await flush();assert.equal(e.calls.length,1);assert.equal(e.calls[0].filename,relative+'/'+a.filename);assert.equal(e.get(t.id).dirPath,target);assert.equal(e.get(t.id).locationBlocked,false);
  }
});
test('真实下载、探测和重载保持静默，最后一个包结束才恢复浏览器下载 UI',async()=>{
  const e=await browserEnv(),one=await e.start();assert.equal(e.uiEnabled,false);await e.call('browserCurrentDirectory');assert.equal(e.uiEnabled,false);
  e.setDirectory('/home/test/Kushan');const two=await e.start();assert.equal(e.uiEnabled,false);
  const reboot=await browserEnv({state:clone(e.state),records:e.records,calls:e.calls,defaultPath:'/home/test/Kushan'});assert.equal(reboot.uiEvents[0],false);assert.equal(reboot.uiEnabled,false);assert.equal(reboot.calls.length,2);
  Object.assign(reboot.records.get(1),{state:'complete',bytesReceived:4});await reboot.call('browserDownloadPoll',reboot.get(one).items[0].jobId);assert.equal(reboot.uiEnabled,false);
  Object.assign(reboot.records.get(2),{state:'complete',bytesReceived:4});await reboot.call('browserDownloadPoll',reboot.get(two).items[0].jobId);await flush();assert.equal(reboot.uiEnabled,true);assert.equal(reboot.calls.length,2);
});
test('停止与删除只释放对应下载的静默占用，执行恢复原 ID 仍静默',async()=>{
  const e=await browserEnv(),one=await e.start();e.setDirectory('/home/test/Kushan');const two=await e.start();
  await e.call('stopTask',one);assert.equal(e.uiEnabled,false);assert.equal(e.records.get(1).paused,true);
  await e.call('deleteTask',two);assert.equal(e.uiEnabled,true);assert.equal(e.records.get(2).error,'USER_CANCELED');
  await e.call('execute',one);await flush();assert.equal(e.uiEnabled,false);assert.equal(e.calls.length,2);assert.deepEqual(e.resume,[1]);
  await e.call('stopTask',one);assert.equal(e.uiEnabled,true);
});
test('启动 API 回执迟到时停止任务，不在原生传输被暂停前恢复 UI',async()=>{
  const wait=deferred(),e=await browserEnv({pendingStart:wait}),start=e.start();await flush();const id=e.state.tasks[0].id;
  await e.call('stopTask',id);assert.equal(e.uiEnabled,false);wait.resolve();await start;await flush();assert.equal(e.records.get(1).paused,true);assert.equal(e.uiEnabled,true);
});
test('首包等待失败重试时可下载后面的就绪包，但不能绕过未完整首包标记完成',async()=>{
  const e=await browserEnv();e.server.files=[a,b];await e.call('ensureBrowserDirectory',true);const t=await e.create({kind:'download',dir_id:'browser-downloads:bags'}),saved=e.state.tasks[0];
  Object.assign(saved,{status:'running',runToken:'same-run',searchReady:true,items:[{...a,state:'pending',attempts:1,retryAt:Date.now()+60000},{...b,state:'pending',attempts:0}]});
  await e.call('kick',t.id);assert.equal(e.calls[0].filename,b.filename);assert.equal(e.get(t.id).items[0].state,'pending');
  Object.assign(e.records.get(1),{state:'complete',bytesReceived:4});await e.call('browserDownloadPoll',e.get(t.id).items[1].jobId);await flush();assert.equal(e.get(t.id).status,'running');assert.equal(e.calls.length,1);
  e.advance(61000);await e.call('wakeBrowserDownloads');assert.equal(e.calls[1].filename,a.filename);assert.equal(e.get(t.id).runToken,'same-run');
});
test('全局空闲时强制核查新的共同根目录，不因旧缓存继续空等',async()=>{
  const e=await browserEnv();await e.call('ensureBrowserDirectory',true);const t=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
  e.setDirectory('/home/test/Kushan');await e.call('execute',t.id);await flush();assert.equal(e.calls.length,0);assert(e.get(t.id).locationWait);
  e.setDirectory('/home/test');await e.call('wakeBrowserDownloads');await flush();assert.equal(e.calls.length,1);assert.equal(e.get(t.id).locationWait,undefined);assert.equal(e.get(t.id).dirPath,'/home/test/Downloads');
});
test('分配期间再次唤醒不会丢失新就绪任务，不等下一次轮询才下载',async()=>{
  const e=await browserEnv(),wait=deferred();await e.call('ensureBrowserDirectory',true);
  const one=await e.create({kind:'download',dir_id:'browser-downloads:bags'}),two=await e.create({kind:'download',dir_id:'browser-downloads:bags'});
  Object.assign(e.state.tasks.find(t=>t.id===one.id),{status:'running',runToken:'run-one',searchReady:true,items:[{...a,state:'pending',attempts:0}]});
  e.context.SiteAPI.post=()=>wait.promise;const firstWake=e.call('wakeBrowserDownloads');await flush();assert.equal(e.calls.length,0);
  Object.assign(e.state.tasks.find(t=>t.id===two.id),{status:'running',runToken:'run-two',searchReady:true,items:[{...b,state:'pending',attempts:0}]});
  const secondWake=e.call('wakeBrowserDownloads');wait.resolve('http://10.198.92.173:8099/files/0');await Promise.all([firstWake,secondWake]);
  assert.equal(e.calls.length,2);assert.equal(e.calls[0].filename,a.filename);assert.equal(e.calls[1].filename,b.filename);
  assert(e.get(one.id).items[0].jobId);assert(e.get(two.id).items[0].jobId);
});
test('同一 URL 的两个目录重连，丢失 ID 时按原目录找回，不误用较新的其他任务记录',async()=>{
  const e=await browserEnv(),first=await e.start(),token=e.get(first).runToken;
  e.setDirectory('/home/test/Kushan');const second=await e.start();
  delete e.state.tasks.find(t=>t.id===first).items[0].browserDownloadId;
  await e.call('browserDownloadReconcile');await flush();
  assert.equal(e.calls.length,2);assert.equal(e.get(first).items[0].browserDownloadId,1);assert.equal(e.get(second).items[0].browserDownloadId,2);
  assert.equal(e.get(first).runToken,token);assert.equal(e.records.get(1).paused,false);assert.equal(e.records.get(2).paused,false);
});
test('旧任务误关联根目录的残缺记录，排除该 ID 后按原完整路径恢复，不再循环报错',async()=>{
  const target='/home/test/haibo/huaining/06/20261105/rtfbag',root='/home/test/haibo';
  const e=await browserEnv({defaultPath:target}),id=await e.start(),original=e.get(id);
  Object.assign(e.records.get(1),{filename:root+'/'+a.filename,state:'interrupted',canResume:true,paused:true,error:'NETWORK_FAILED',bytesReceived:2});
  const stored=e.state.tasks.find(t=>t.id===id),item=stored.items[0];
  stored.locationBlocked=true;stored.message=`文件保存位置与任务固定目录 ${target} 不一致，已暂停该文件`;
  Object.assign(item,{state:'pending',jobId:null,error:stored.message});
  e.setDirectory(root);await e.call('kick',id);await flush();
  const current=e.get(id);
  assert.equal(current.dirPath,target);assert.equal(current.runToken,original.runToken);assert.equal(current.locationBlocked,false);
  assert.equal(current.items[0].browserDownloadId,2);assert.equal(current.items[0].downloadPath,target+'/'+a.filename);
  assert.equal(e.calls[1].filename,'huaining/06/20261105/rtfbag/'+a.filename);assert.equal(e.records.get(1).paused,true);
  assert.deepEqual(e.resume,[]);assert.equal(current.items[0].error,'');assert.equal(current.items[0].misplacedDownload.id,1);
});
test('误关联另一目录的活动 ID 不暂停其他任务，重新找回本任务原 ID',async()=>{
  const e=await browserEnv(),first=await e.start();e.setDirectory('/home/test/Kushan');const second=await e.start();
  const stored=e.state.tasks.find(t=>t.id===first);stored.items[0].browserDownloadId=2;
  await e.call('browserDownloadPoll',stored.items[0].jobId);await flush();
  assert.equal(e.records.get(2).paused,false);assert.equal(e.get(second).items[0].browserDownloadId,2);
  e.advance(4000);await e.call('kick',first);await flush();
  assert.equal(e.get(first).items[0].browserDownloadId,1);assert.equal(e.calls.length,2);
});
test('多次网络中断不耗尽任务重试次数，恢复原 ID 时不受默认目录切换影响',async()=>{
  const e=await browserEnv(),id=await e.start(),original=e.get(id);e.setDirectory('/home/test/Kushan');
  for(let n=0;n<6;n++){
    Object.assign(e.records.get(1),{state:'interrupted',canResume:true,error:'NETWORK_FAILED'});
    await e.call('browserDownloadPoll',e.get(id).items[0].jobId);await flush();
    assert.equal(e.get(id).status,'running');assert.equal(e.get(id).items[0].state,'pending');
    e.advance(65000);await e.call('kick',id);await flush();
    assert.equal(e.get(id).items[0].browserDownloadId,1);assert.equal(e.get(id).dirPath,original.dirPath);assert.equal(e.get(id).runToken,original.runToken);
  }
  assert.equal(e.calls.length,1);assert.equal(e.resume.length,6);
  Object.assign(e.records.get(1),{state:'complete',exists:true,bytesReceived:4,totalBytes:4,fileSize:4});
  await e.call('browserDownloadPoll',e.get(id).items[0].jobId);assert.equal(e.get(id).status,'done');
});
