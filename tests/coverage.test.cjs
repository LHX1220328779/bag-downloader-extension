const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../task-core.js'), B = require('../coverage-core.js');
const { background, flush, clone, deferred, vm, source } = require('./helpers.cjs');
const filters = { truck_no: 'WH-Truck05', mine_code: 'WH', bag_type: 'Perception', break_source: 'mdc' };
const task = (extra = {}) => ({ filters, start: '2026-11-06 08:39:20', end: '2026-11-06 08:42:50', items: [], transfers: [], ...extra });
const bag = (time, index, extra = {}) => ({ ...filters, filename: `Perception_wuhu_05_2026-11-06-${time.replaceAll(':', '-')}_${index}.bag`, create_time: '2026-11-06 19:00:00', dirpath: `/data/${index}.bag`, ...extra });
const rows = ['08:38:55','08:39:25','08:39:55','08:40:25','08:40:55','08:41:25','08:41:55','08:42:25','08:42:55'].map((time,n) => bag(time,193+n));
const mode = (transfer, download) => ({ operations: { transfer, download }, start: task().start, end: task().end });
test('用户回归：08:39:20–08:42:50 选择前包 193 至 200，201 仅证明尾边界', () => {
  const p = B.plan(B.catalog([...rows].reverse(), task()), task());
  assert.equal(p.complete, true); assert.deepEqual(p.selected.map(r => B.sequence(r.filename).index), [193,194,195,196,197,198,199,200]);
  assert.equal(p.coveredStart, '2026-11-06 08:38:55'); assert.equal(p.coveredEnd, '2026-11-06 08:42:55');
  assert(!p.targets.includes(rows.at(-1).filename));
});
test('相邻包起点恰好等于任务起点时只选该包，结束秒上的包必须包含', () => {
  const t = task({ start: '2026-11-06 08:39:25', end: '2026-11-06 08:39:55' }), p = B.plan(rows,t);
  assert.equal(p.complete,true); assert.deepEqual(p.selected.map(r => B.sequence(r.filename).index),[194,195]);
});
test('空清单、头部清理、尾部无后继包、中间缺包均不能声称完整覆盖', () => {
  assert.equal(B.plan([],task()).complete,false);
  assert(B.plan(rows.slice(1),task()).issues.some(i => i.code === 'START_MISSING'));
  assert(B.plan(rows.slice(0,-1),task()).issues.some(i => i.code === 'END_UNKNOWN'));
  assert(B.plan(rows.filter((_,n) => n !== 3),task()).issues.some(i => i.code === 'PACKAGES_MISSING' && i.missing === 1));
});
test('重复/无序清单不影响结果；其他车辆、矿区、类型和来源不能证明边界', () => {
  const wrong = [{ ...rows[0], truck_no: 'OTHER' },{ ...rows[0], mine_code: 'OTHER' },{ ...rows[0], filename: rows[0].filename.replace('Perception','Camera') },{ ...rows[0], break_source: 'manual' }];
  assert.equal(B.plan([...rows,rows[0]].reverse(),task()).selected.length,8);
  assert(B.plan([...wrong,...rows.slice(1)],task()).issues.some(i => i.code === 'START_MISSING'));
});
test('无序号、序号重置或录制流切换需要告警，不能把陈旧包推断为连续覆盖', () => {
  for (const first of [rows[0].filename.replace('_193.bag','_x.bag'),rows[0].filename.replace('_193.bag','_999.bag'),rows[0].filename.replace('wuhu','other')]) {
    assert(B.plan([{ ...rows[0],filename:first },...rows.slice(1)],task({start:'2026-11-06 08:38:55'})).issues.some(i => i.code === 'SEQUENCE_UNKNOWN'));
  }
});
test('跨日范围保留两侧边界且以包名时间为准', () => {
  const t = task({ start:'2026-11-05 23:59:59',end:'2026-11-06 00:00:00' });
  const rs = [bag('23:59:40',1),bag('00:00:10',2)].map((r,n) => n ? r : { ...r,filename:r.filename.replace('2026-11-06','2026-11-05') });
  const p = B.plan(rs,t); assert.equal(p.complete,true); assert.equal(p.selected.length,1);
});
test('先前确认的待处理目标消失告警；已经回传/下载的证明持久保留', () => {
  const first = B.plan(rows,task()), t = task({ coverage:first, transfers: first.selected.map(r => ({ ...r,state:'submitted',accepted:true })) });
  const p = B.plan([],t); assert.equal(p.complete,true); assert.equal(p.selected.length,8);
  t.transfers[2].accepted = false; t.transfers[2].state = 'pending';
  assert(B.plan([],t).issues.some(i => i.code === 'TARGET_REMOVED' && i.filename === rows[2].filename));
});
test('归档查询必须取时间边界外的邻包，接口处理时间不作为录制时间', async () => {
  let body;
  const cx = vm.createContext({ BagCore:C, URL, AbortSignal, fetch:async(_,init) => { body=JSON.parse(init.body); return {ok:true,json:async()=>({code:20000,data:rows})}; } });
  vm.runInContext(source('site-api.js'),cx);
  await cx.SiteAPI.search(task({ coverageMode:'interval' }));
  assert.equal(body.start_time,''); assert.equal(body.end_time,''); assert.equal(body.truck_no,filters.truck_no);
});
test('仅回传无需目录权限、下载 API 或文件 HEAD/GET，批量包含边界前包', async () => {
  const e = await background({}, { server:{mdc:rows,files:[]} });
  e.context.DirStore.permission = async() => { throw Error('不得请求目录权限'); };
  e.chrome.downloads.download = async() => { throw Error('不得下载'); };
  const t = await e.create(mode(true,false)); await e.call('execute',t.id); await flush();
  assert.equal(e.get(t.id).coverage.complete,true); assert.deepEqual(e.submissions.map(r=>r.filename),rows.slice(0,-1).map(r=>r.filename));
  assert.equal(e.get(t.id).items.length,0); assert.equal(e.downloads.length,0);
  e.server.records.forEach(r=>r.status='succeed'); await e.call('tickTask',t.id); await flush();
  assert.equal(e.get(t.id).status,'done');
});
test('仅下载不回传，新建任务不追加 bags，零操作拒绝', async () => {
  const records=new Map(),calls=[];
  const e = await background({ post:async()=> 'http://10.198.92.173:8099/files/test' }, { server:{files:rows},browserDefaultPath:'/test/downloads',
    downloads:{async download(p){calls.push(p);records.set(1,{id:1,byExtensionId:'test-extension',url:p.url,filename:'/test/downloads/'+p.filename,state:'in_progress',exists:true,bytesReceived:0,totalBytes:4,fileSize:4});return 1;},async search(){return clone([...records.values()]);}},
    fetch:async url=>({ok:true,status:200,url,headers:{get:n=>n==='Content-Length'?'4':null}}) });
  await assert.rejects(e.create(mode(false,false)),/请选择回传或下载/);
  const t=await e.create(mode(false,true));await e.call('execute',t.id);await flush();
  assert.equal(e.submissions.length,0);assert.equal(e.get(t.id).items.length,8);assert.equal(calls[0].filename,rows[0].filename);
  assert.equal(e.get(t.id).dirPath,'/test/downloads');assert.equal(e.get(t.id).browserRelativeDir,'');
});
test('组合模式归档前包直接下载、未归档包回传，尾部证据不执行',async()=>{
  const e=await background({}, {server:{mdc:rows,files:[rows[0]]}});
  // 使用真实 interval 模式，隔离文件写入后端以检查队列。
  const t=await e.create(mode(true,true));e.state.tasks[0].downloadBackend='directory';e.state.tasks[0].dirId='dir1';
  await e.call('execute',t.id);await flush();
  assert.equal(e.get(t.id).coverage.complete,true);assert.equal(e.downloads[0].filename,rows[0].filename);
  assert.deepEqual(e.submissions.map(r=>r.filename),rows.slice(1,-1).map(r=>r.filename));
});
test('缺头包保持告警并持续发现，头包恢复后告警清除且不重复提交',async()=>{
  const e=await background({}, {server:{mdc:rows.slice(1),files:[]}}), t=await e.create(mode(true,false));
  await e.call('execute',t.id);await flush();assert.equal(e.get(t.id).coverage.complete,false);assert.match(e.get(t.id).coverageAlert,/开始时刻/);
  const count=e.submissions.length;e.server.mdc=rows;e.advance(61000);await e.call('tickTask',t.id);await flush();
  assert.equal(e.get(t.id).coverage.complete,true);assert.equal(e.get(t.id).coverageAlert,'');assert.equal(e.submissions.length,count+1);
});
test('重载迁移原活动任务时保留运行代次、已提交记录和在途下载 job',async()=>{
  const old={...task(),id:'old',kind:'transfer',status:'running',runToken:'original',dirId:'dir1',items:[{...rows[1],state:'downloading',jobId:'existing',attempts:1}],transfers:[{...rows[1],state:'submitted',attempts:1,accepted:true,recordNo:9}],events:[]};
  const waiting=deferred(),e=await background({mdc:()=>waiting.promise},{migrateCoverage:true,activeJobs:['existing'],state:{tasks:[old]},server:{online:false}});
  assert.equal(e.get('old').runToken,'original');assert.equal(e.get('old').transfers[0].recordNo,9);assert.equal(e.submissions.length,0);
  assert.equal(e.get('old').coverageMode,'interval');assert.equal(e.get('old').items[0].jobId,'existing');
  assert.equal(e.get('old').items[0].filename,old.items[0].filename);waiting.resolve(rows);await flush();
});
test('覆盖缺失且下载失败上限时进入可重试状态，不误标完成',async()=>{
  const e=await background(),t=await e.create(mode(false,true));const s=e.state.tasks[0];
  Object.assign(s,{status:'running',searchReady:true,coverage:{complete:false},items:[{...rows[0],state:'failed',attempts:3}]});
  await e.call('finish',t.id);assert.equal(e.get(t.id).status,'error');
});
test('升级未执行/已停止的旧任务也补齐覆盖规则，保留原状态、目录及回传记录',async()=>{
  const tasks=['ready','stopped'].map((status,n)=>({...task(),id:'old-'+n,kind:'transfer',status,runToken:'saved-'+n,dirId:'dir1',transfers:[{...rows[1],state:'submitted',attempts:1,recordNo:9}],events:[]}));
  const e=await background({}, {migrateCoverage:true,state:{tasks}});
  for(const t of tasks){const s=e.get(t.id);assert.equal(s.coverageMode,'interval');assert.equal(s.status,t.status);assert.equal(s.runToken,t.runToken);assert.equal(s.dirId,t.dirId);assert.equal(s.transfers[0].recordNo,9);}
  assert.equal(e.submissions.length,0);assert.equal(e.downloads.length,0);
});
test('文件 HEAD 404 告警，不能标记已完成或实际启动下载',async()=>{
  const e=await background({post:async()=> 'http://10.198.92.173:8099/files/gone'}, {server:{files:rows},fetch:async()=>({ok:false,status:404,headers:{get:()=>null}})});
  const t=await e.create(mode(false,true));await e.call('execute',t.id);await flush();
  assert.equal(e.get(t.id).items[0].coverageMissing,true);assert.match(e.get(t.id).coverageAlert,/目标包不存在/);assert.notEqual(e.get(t.id).status,'done');
});
test('服务器明确报告已确认包不存在时保持覆盖告警，而查询异常不伪造缺包',async()=>{
  const e=await background(),t=await e.create(mode(false,true));const s=e.state.tasks[0];
  Object.assign(s,{status:'running',searchReady:true,archiveCatalog:B.catalog(rows,task()),coverage:B.plan(rows,task()),items:[{...rows[0],state:'downloading',jobId:'lost',attempts:1}]});
  await e.call('onJobResult',{jobId:'lost',ok:false,code:'TARGET_REMOVED',error:'包不存在'});assert.match(e.get(t.id).coverageAlert,/目标包不存在/);
  e.context.SiteAPI.search=async()=>{throw Error('网络暂不可用');};const before=e.get(t.id).coverageAlert;
  await e.call('scanSearch',e.get(t.id));assert.equal(e.get(t.id).coverageAlert,before);assert.match(e.get(t.id).searchError,/查询失败/);
});
