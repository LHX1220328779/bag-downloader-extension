const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../task-core.js');
const {vm,source,background,flush}=require('./helpers.cjs');
const filename='Perception_huaining_06_ConchPilot6.1_2026.09.04_V6.1.1_hotfix08_2026-11-05-09-06-05_261.bag';
const file={filename,truck_no:'HNMZ-Truck06',create_time:'2026-11-05 09:06:05',dirpath:'/data/bags/HNMZ-Truck06/2026-11-05/09/'+filename,filesize:'758.88',break_source:'mdc'};
function legacyTask(){return {id:'legacy-task',kind:'transfer',name:'HNMZ-Truck06 · Perception',filters:{truck_no:'HNMZ-Truck06',mine_code:'HNMZ',bag_type:'Perception',break_source:''},start:'2026-11-05 09:08:00',end:'2026-11-05 09:11:59',status:'running',runToken:'old-run',dirId:'dir1',items:[],discovered:true,searchReady:true,
 transfers:[{...file,dirpath:undefined,create_time:'2026-11-05 09:08:18',key:filename+'|2026-11-05 09:08:18',state:'confirming',attempts:1,recordNo:100282,percentage:99}],events:[]};}
test('怀宁实测包：MDC 写入时间与文件录制时间不同，排序/筛选/匹配采用录制时间',()=>{
 const mdc={...file,create_time:'2026-11-05 16:19:06'};
 assert.equal(C.recordingTime(mdc),'2026-11-05 09:06:05');
 const t={...legacyTask(),start:'2026-11-05 09:06:00',end:'2026-11-05 09:06:59',transfers:[]};
 C.mergeTransfers(t,[mdc]);assert.equal(t.transfers.length,1);assert.equal(t.transfers[0].create_time,file.create_time);
 assert.equal(C.fileKey(t.transfers[0]),C.fileKey(file));
});
test('旧任务保留原 key/回传记录，可匹配范围外的已选包；其他车辆/未选包仍严格过滤',()=>{
 const t=legacyTask(),oldKey=t.transfers[0].key;
 C.mergeDownloads(t,[file,{...file,filename:filename.replace('_261.bag','_unselected.bag')},{...file,truck_no:'OTHER'}]);
 assert.equal(t.items.length,1);assert.equal(t.transfers[0].key,oldKey);assert.equal(t.transfers[0].recordNo,100282);
 assert.equal(C.matches({...file,truck_no:'OTHER'},t),false);
 C.mergeTransfers(t,[{...file,create_time:'2026-11-05 16:19:06'}]);assert.equal(t.transfers.length,1);
});
test('旧任务服务端查询覆盖已选包的真实时间，入库后自动下载且不重复回传',async()=>{
 const calls=[],apiContext=vm.createContext({BagCore:C,URL,AbortSignal,fetch:async(url,init)=>{
  const body=JSON.parse(init.body);calls.push(body);
  assert(url.endsWith('/api/bag/search'));
  return {ok:true,json:async()=>({code:20000,data:file.create_time>=body.start_time&&file.create_time<=body.end_time?[file]:[]})};
 }});
 vm.runInContext(source('site-api.js'),apiContext);
 const e=await background({search:(t)=>apiContext.SiteAPI.search(t)}, {state:{tasks:[legacyTask()]},server:{mdc:[],files:[file]}});await flush();
 assert.equal(calls[0].start_time,'2026-11-05 09:06:05');assert.equal(calls[0].end_time,'2026-11-05 09:11:59');
 assert.equal(calls[0].truck_no,'HNMZ-Truck06');assert.equal(calls[0].mine_code,'HNMZ');
 assert.equal(e.downloads[0].filename,filename);assert.equal(e.get('legacy-task').transfers[0].state,'done');assert.equal(e.submissions.length,0);
 await e.call('tickTask','legacy-task');await flush();assert.equal(e.downloads.length,1);
 await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true});assert.equal(e.get('legacy-task').status,'done');
});

test('旧 MDC 时间 key 与新录制时间 key 不同，重叠任务仍避免重复回传',async()=>{
 const e=await background({trucks:async()=>[{value:'HNMZ-Truck06',status:true}]}, {state:{tasks:[legacyTask()]},server:{mdc:[{...file,create_time:'2026-11-05 16:19:06'}],files:[],records:[]}});
 const t=await e.create({...legacyTask().filters,start:'2026-11-05 09:06:00',end:'2026-11-05 09:06:59'});
 await e.call('execute',t.id);await flush();await e.call('tickTask',t.id);await flush();
 assert.notEqual(e.get(t.id).transfers[0].key,e.get('legacy-task').transfers[0].key);
 assert.equal(e.submissions.length,0);assert.match(e.get(t.id).transfers[0].error,/其他任务已提交/);
});
test('新任务严格以包名录制时间按秒闭区间筛选，接口时间和已选标记不能绕过',async()=>{
 const e=await background();const t=await e.create({kind:'download',start:'2026-11-03 09:00:01',end:'2026-11-03 09:00:59'});
 assert.equal(t.strictFilenameTime,true);
 const r=(second,create_time='2026-11-03 16:00:00')=>({filename:`Perception_2026-11-03-09-00-${second}_x.bag`,truck_no:t.filters.truck_no,create_time,break_source:'mdc'});
 for(const second of ['01','30','59'])assert(C.matches(r(second),t));
 for(const second of ['00','60'])assert.equal(C.matches(r(second,'2026-11-03 09:00:30'),t),false);
 assert.equal(C.matches({...r('30'),filename:'Perception_without-time.bag',create_time:'2026-11-03 09:00:30'},t),false);
 t.kind='transfer';t.transfers=[r('00')];assert.equal(C.matches(r('00'),t),false);
});
test('升级后的旧任务保留原队列与运行代次，后续新增文件采用严格包名时间',()=>{
 const t=C.normalizeTask(legacyTask()), before=structuredClone(t.transfers[0]);
 assert.equal(t.strictFilenameTime,true);assert.equal(t.runToken,'old-run');assert.equal(t.status,'running');
 assert(t.legacySelectedFilenames.includes(file.filename));C.mergeDownloads(t,[file]);assert.equal(t.items.length,1);
 const newFile={...file,filename:'Perception_unknown.bag',create_time:'2026-11-05 09:09:00'};
 C.mergeTransfers(t,[newFile]);C.mergeDownloads(t,[newFile]);
 assert.equal(t.transfers.length,1);assert.equal(t.items.length,1);assert.deepEqual(t.transfers[0],before);
 assert.equal(C.matches({...file,filename:filename.replace('09-06-05','09-09-00')},t),true);
});
