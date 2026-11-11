const test=require('node:test'),assert=require('node:assert/strict');
const {background,flush}=require('./helpers.cjs');
test('临时位置探测期间关闭下载 UI，结束后恢复，目录核查成功',async()=>{
 const e=await background(),events=[];let enabled=true;
 e.chrome.downloads.setUiOptions=async o=>{enabled=o.enabled;events.push(o.enabled?'enable':'disable');};
 const download=e.chrome.downloads.download;e.chrome.downloads.download=async p=>{assert.equal(enabled,false);events.push('probe');return download(p);};
 assert.equal(await e.call('browserCurrentDirectory'),'/home/test/Downloads');assert.deepEqual(events,['disable','probe','enable']);assert.equal(enabled,true);assert.equal(e.state.browserLocationProbe,undefined);
});
test('临时下载失败仍恢复下载 UI，不遗留屏蔽状态',async()=>{
 const e=await background(),events=[];e.chrome.downloads.setUiOptions=async o=>events.push(o.enabled);
 e.chrome.downloads.download=async()=>{throw Error('探测下载失败');};await assert.rejects(e.call('browserCurrentDirectory'),/探测下载失败/);
 assert.deepEqual(events,[false,true]);assert.equal(e.state.browserLocationProbe,undefined);
});
test('缺少新增下载 UI 权限时不发探测下载，不能退回弹出列表的旧行为',async()=>{
 const e=await background();let downloads=0;
 e.chrome.downloads.setUiOptions=async o=>{if(!o.enabled)throw Error('downloads.ui permission required');};
 e.chrome.downloads.download=async()=>{downloads++;};await assert.rejects(e.call('browserCurrentDirectory'),/downloads.ui/);assert.equal(downloads,0);
});
test('扩展重新启动释放临时下载 UI 屏蔽，原任务记录保持',async()=>{
 const enabled=[],e=await background({}, {downloads:{setUiOptions:async o=>enabled.push(o.enabled)}});
 assert(enabled.includes(true));const before=structuredClone(e.state.tasks);await e.call('setup');await flush();assert.deepEqual(e.state.tasks,before);assert.equal(enabled.at(-1),true);
});
test('多个原生下载与探测共享静默开关，探测和单包结束不能提前恢复 UI',async()=>{
 const e=await background(),events=[];e.chrome.downloads.setUiOptions=async o=>events.push(o.enabled);
 await e.call('DownloadUi.holdJob','first');await e.call('DownloadUi.holdJob','second');await e.call('browserCurrentDirectory');
 assert.deepEqual(events,[false]);await e.call('DownloadUi.releaseJob','first');assert.deepEqual(events,[false]);
 await e.call('DownloadUi.releaseJob','second');assert.deepEqual(events,[false,true]);
});
test('活动下载期间重做启动核查不会恢复下载 UI，恢复失败可在下一次重试',async()=>{
 const e=await background();let enabled=true; e.chrome.downloads.setUiOptions=async o=>{enabled=o.enabled;};
 await e.call('DownloadUi.holdJob','inflight');await e.call('setup');await flush();assert.equal(enabled,false);
 let failures=1;e.chrome.downloads.setUiOptions=async o=>{if(o.enabled&&failures--)throw Error('恢复失败');enabled=o.enabled;};
 await assert.rejects(e.call('DownloadUi.releaseJob','inflight'),/恢复失败/);assert.equal(enabled,false);
 await e.call('reconcile');await flush();assert.equal(enabled,true);
});
