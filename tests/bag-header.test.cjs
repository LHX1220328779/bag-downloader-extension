const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../task-core.js'),B=require('../coverage-core.js'),H=require('../bag-header.js');
const {background,flush,vm,source,deferred}=require('./helpers.cjs');
const rows=require('./fixtures/kushan-boundary.json'),last=rows.find(r=>r.filename.endsWith('15-19-50_39.bag'));
const header=fs.readFileSync(path.join(__dirname,'fixtures/kushan-39-header.bin'));
const task=()=>({filters:{truck_no:'WHKS-Truck25',mine_code:'WHKS',bag_type:'Perception',break_source:''},start:'2026-10-22 15:10:00',end:'2026-10-22 15:19:59',items:[],transfers:[]});
test('库山实测文件头：39 包实际录制至 15:20:20.512，覆盖请求末端',()=>{
 const bounds=H.parse(header,last.filename);assert.equal(bounds.start,1792653590564);assert.equal(bounds.stop,1792653620512);
 const t=task(),p=B.plan(B.catalog(rows,t),t);assert.equal(p.complete,false);assert(p.issues.some(i=>i.code==='END_UNKNOWN'));
 assert(p.issues.every(i=>!i.message.includes('2026-10-29')));
 t.recordingBounds={[last.filename]:bounds};const confirmed=B.plan(B.catalog(rows,t),t);
 assert.equal(confirmed.complete,true);assert.equal(confirmed.selected.length,21);assert.equal(confirmed.coveredStart,'2026-10-22 15:09:50');
 assert.equal(confirmed.coveredEnd,'2026-10-22 15:20:20');assert(!confirmed.targets.some(n=>n.includes('2026-10-29')));
});
test('末包实际结束早于用户终点仍告警；文件头不能掩盖范围内缺包',()=>{
 const t=task(),bounds=H.parse(header,last.filename);t.recordingBounds={[last.filename]:{...bounds,stop:+new Date('2026-10-22T15:19:55')}};
 assert(B.plan(rows,t).issues.some(i=>i.code==='END_MISSING'));
 t.recordingBounds[last.filename]=bounds;
 assert(B.plan(rows.filter(r=>!r.filename.endsWith('_30.bag')),t).issues.some(i=>i.code==='PACKAGES_MISSING'));
});
test('完成文件的真实头部边界跨重启保留，远期文件不作为连续证据',()=>{
 const t=task();t.recordingBounds={[last.filename]:H.parse(header,last.filename)};const p=B.plan(rows,t);t.coverage=p;t.items=p.selected.map(r=>({...r,state:'done'}));
 assert.equal(B.plan([],t).complete,true);
});
test('不完整/错误文件名/错误 magic/op/无结束时间不接受为覆盖证据',()=>{
 assert.equal(H.parse(header.subarray(0,100),last.filename),null);assert.equal(H.parse(header,last.filename.replace('15-19-50','15-19-51')),null);
 const wrong=Buffer.from(header);wrong[0]=0;assert.equal(H.parse(wrong,last.filename),null);
 const bad=Buffer.from(header);bad[bad.indexOf(Buffer.from('op='))+3]=0;assert.equal(H.parse(bad,last.filename),null);
 const missing=Buffer.from(header);for(const name of ['stopRecordRealTime=','stopRecordVirtualTime=']){const offset=missing.indexOf(name)+name.length;missing.fill(0,offset,offset+8);}assert.equal(H.parse(missing,last.filename),null);
});
test('远端只读取限定 Range；拒绝 200 全包响应、重定向及截断头部',async()=>{
 let request;
 const context=vm.createContext({BagCore:C,TextDecoder,URL,AbortSignal,SiteAPI:{BASE:'http://10.198.92.173:8080',post:async()=> 'http://10.198.92.173:8099/test.bag'},fetch:async(url,options)=>{request=options;return new Response(header,{status:206,headers:{'Content-Range':`bytes 0-270/719885925`}});}});
 vm.runInContext(source('bag-header.js'),context);assert.equal((await context.BagHeader.read(last)).stop,1792653620512);assert.equal(request.headers.Range,'bytes=0-4095');
 let cancelled=false;context.fetch=async()=>({status:200,headers:new Headers(),body:{cancel:async()=>{cancelled=true;}}});
 await assert.rejects(context.BagHeader.read(last),/受限/);assert(cancelled);
 context.fetch=async()=>new Response(header.subarray(0,100),{status:206,headers:{'Content-Range':'bytes 0-270/719885925'}});
 await assert.rejects(context.BagHeader.read(last),/不完整/);
});
test('库山真实清单通过后台文件头核查清除误告警，不选择 10 月 29 日包',async()=>{
 const e=await background({}, {server:{files:rows}});e.context.BagHeader.read=async()=>H.parse(header,last.filename);
 const t=await e.create({...task().filters,start:task().start,end:task().end,operations:{transfer:false,download:true}});
 e.state.tasks[0].downloadBackend='directory';e.state.tasks[0].dirId='dir1';await e.call('execute',t.id);await flush();
 assert.equal(e.get(t.id).coverage.complete,true);assert.equal(e.get(t.id).coverageAlert,'');assert.equal(e.get(t.id).items.length,21);
 assert.equal(e.get(t.id).recordingBounds[last.filename].stop,1792653620512);assert(!e.get(t.id).items.some(i=>i.filename.includes('2026-10-29')));
 assert.equal(e.notes.filter(n=>n.id.startsWith('coverage:')).length,0);
});
test('末包文件头迟到响应不能改写已停止任务的覆盖与运行状态',async()=>{
 const waiting=deferred(),e=await background({}, {server:{files:rows}});e.context.BagHeader.read=()=>waiting.promise;
 const t=await e.create({...task().filters,start:task().start,end:task().end,operations:{transfer:false,download:true}});
 e.state.tasks[0].downloadBackend='directory';e.state.tasks[0].dirId='dir1';await e.call('execute',t.id);await flush();await e.call('stopTask',t.id);
 const token=e.get(t.id).runToken;waiting.resolve(H.parse(header,last.filename));await flush();assert.equal(e.get(t.id).status,'stopped');assert.equal(e.get(t.id).runToken,token);assert.equal(e.get(t.id).recordingBounds,undefined);
});
