const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../task-core.js');
const { vm, source, a, b, options } = require('./helpers.cjs');
const task = () => ({ filters: options, start: options.start, end: options.end, items: [], transfers: [] });
test('精确包类型、显式前缀、时间边界及来源过滤', () => {
  assert.equal(C.typeMatches('PCD_1.bag', 'PC'), false);
  assert.equal(C.typeMatches('PCD_1.bag', 'PC*'), true);
  const t = task();
  assert(C.matches(a,t)); assert(!C.matches({ ...a, break_source:'手工' },t));
  assert(!C.matches({ ...a, truck_no:'OTHER' },t));
  assert(!C.matches({ ...a, filename:a.filename.replace('2026-11-03','2026-11-04') },t));
  assert(!C.validTime('2026-02-30 00:00:00'));
  assert(C.matches({ ...a, create_time:options.end },t));
});
test('增量查询不丢失已完成/下载中状态；按稳定 ID 排序，不使用数组下标', () => {
  const t = task(); C.mergeDownloads(t,[b,b]); t.items[0].state='downloading'; t.items[0].jobId='job';
  C.mergeDownloads(t,[a]); assert.equal(t.items.length,2); assert.equal(t.items[1].jobId,'job');
  C.mergeDownloads(t,[]); assert.equal(t.items.length,2);
  C.mergeTransfers(t,[b,a,a]); assert.deepEqual(t.transfers.map((i) => i.filename),[a.filename,b.filename]);
});
test('站点接口协议：HTTP 500 回退仍保留所有非时间条件；MDC 提交使用单包数组', async () => {
  const calls=[];
  const context=vm.createContext({ URL, AbortSignal, fetch:async (url,init) => {
    calls.push({url, body:JSON.parse(init.body)});
    if (calls.length===1) return {ok:false,status:500};
    return {ok:true,json:async()=>({code:url.endsWith('mdcadd')?2000:20000,data:[]})};
  }});
  vm.runInContext(source('site-api.js'),context);
  await context.SiteAPI.search(task());
  assert.equal(calls[1].body.start_time,''); assert.equal(calls[1].body.truck_no,options.truck_no);
  assert.equal(calls[1].body.mine_code,'WH'); assert.equal(calls[1].body.break_source,'mdc');
  await context.SiteAPI.submit({ ...task(),reason:'01',remarks:'test' },a);
  assert.deepEqual(calls[2].body.filename,[a.filename]); assert.equal(calls[2].body.bagtime[0],a.create_time);
  assert.equal(calls[2].body.use_class_code,'01');
});
test('异常返回不能当成空列表/成功回传；不对普通错误做全量回退', async () => {
  let calls=0; const context=vm.createContext({ URL,AbortSignal,fetch:async()=>{calls++;return {ok:true,json:async()=>({code:400,message:'bad'})};} });
  vm.runInContext(source('site-api.js'),context);
  await assert.rejects(()=>context.SiteAPI.search(task()), /bad/); assert.equal(calls,1);
});
test('回传容量的业务拒绝与网络未知结果保留不同证据',async()=>{
  const context=vm.createContext({URL,AbortSignal,fetch:async()=>({ok:true,json:async()=>({code:4000,message:'车辆回传任务较多，请稍后再试'})})});
  vm.runInContext(source('site-api.js'),context);
  await assert.rejects(()=>context.SiteAPI.submitBatch({...task(),reason:'01'},[a]),e=>e.rejected===true&&/\/api\/bag\/mdcadd：车辆回传任务较多/.test(e.message));
  context.fetch=async()=>{throw Error('Failed to fetch');};
  await assert.rejects(()=>context.SiteAPI.submitBatch({...task(),reason:'01'},[a]),e=>e.rejected!==true&&/Failed to fetch/.test(e.message));
});

test('输入时间保留秒；旧分钟输入兼容为 :00；文件名仅显示末尾录制时间',()=>{
  assert.equal(C.inputTime('2026-11-03T09:00:07'),'2026-11-03 09:00:07');
  assert.equal(C.inputTime('2026-11-03T09:00'),'2026-11-03 09:00:00');
  assert.equal(C.inputTime('2026-11-03T09:00:60'),'');
  assert.equal(C.shortFilename('Perception_wuhu_05_2026.10.08_hotfix_2026-11-03-09-00-07_862.bag'),'2026-11-03-09-00-07_862.bag');
  assert.equal(C.shortFilename('Perception_unknown.bag'),'Perception_unknown.bag');
  const t=task();t.start='2026-11-03 09:00:07';t.end='2026-11-03 09:00:08';
  assert(C.matches({...a,filename:a.filename.replace('09-00-00','09-00-08')},t));assert(!C.matches({...a,filename:a.filename.replace('09-00-00','09-00-09')},t));
});
test('批量回传接口使用对应数组，保留秒级时间',async()=>{
  let body;const context=vm.createContext({URL,AbortSignal,fetch:async(_url,init)=>{body=JSON.parse(init.body);return {ok:true,json:async()=>({code:2000,data:[]})};}});
  vm.runInContext(source('site-api.js'),context);
  await context.SiteAPI.submitBatch({...task(),reason:'01',bugId:'bug',remarks:'batch'},[a,b]);
  assert.deepEqual(body.filename,[a.filename,b.filename]);assert.deepEqual(body.bagtime,[a.create_time,b.create_time]);
  assert.deepEqual(body.truck_no,[options.truck_no,options.truck_no]);assert.equal(body.remarks,'batch');
  await assert.rejects(()=>context.SiteAPI.submitBatch(task(),[]),/1–10/);
});
