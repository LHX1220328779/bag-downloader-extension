const test=require('node:test'),assert=require('node:assert/strict');
const {vm,source,flush,deferred}=require('./helpers.cjs');
async function writer({oldBytes=null, payload=new Uint8Array([1,2,3,4]), expected=4, receipt=null, fail=false, permission='granted', valid=true, slow=false,
  overwrite=false, getLength=expected, headLength=expected, encoding='', status=200, restore=null, directoryMissing=false, writeError=null, storageError=null}={}) {
  const sent=[], requests=[], store=new Map(), gate=deferred();let content=oldBytes, removed=false, aborted=false, commits=0, permissionRequests=0;
  const file=()=>content===null?null:{size:content.length,lastModified:42};
  const fileHandle={async getFile(){return file();},async createWritable(){let chunks=[];return new WritableStream({
    write(chunk){chunks.push(chunk);if(fail)throw Error('disk full');},
    close(){content=Buffer.concat(chunks.map((x)=>Buffer.from(x)));commits++;},abort(){aborted=true;}
  });}};
  const dir={async queryPermission(){return permission;},async getFileHandle(name,opts){
    if(directoryMissing)throw Object.assign(Error('directory missing'),{name:'NotFoundError'});
    if(opts?.create&&writeError)throw writeError;
    if(content===null){if(!opts?.create)throw Object.assign(Error('missing'),{name:'NotFoundError'});content=new Uint8Array();}return fileHandle;
  },async removeEntry(){removed=true;content=null;},values(){return {async next(){if(directoryMissing)throw Object.assign(Error('directory missing'),{name:'NotFoundError'});return {done:true};}};}};
  if(restore)dir.requestPermission=async()=>{permissionRequests++;if(restore instanceof Error)throw restore;permission=restore;return permission;};
  store.set('dir',{handle:dir});if(receipt)store.set('file:dir:test.bag',receipt);
  const context=vm.createContext({console,URL,AbortSignal,AbortController,TransformStream,ReadableStream,WritableStream,
    setInterval(){},clearInterval(){},Date,
    navigator:{locks:{async request(_name,_options,fn){return fn();}}},
    DirStore:{async get(id){if(id==='dir'&&storageError)throw storageError;return store.get(id);},async put(r){store.set(r.id,r);}},
    fetch:async(url,init={})=>{
      requests.push(init.method||'GET');
      if(init.method==='POST')return {ok:true,json:async()=>({code:20000,data:'/file/test.bag'})};
      if(init.method==='HEAD')return {ok:true,status:200,headers:new Headers(headLength==null?{}:{'Content-Length':String(headLength)})};
      const body=new ReadableStream({async start(c){c.enqueue(payload);if(slow)await gate.promise;c.close();}});
      return {ok:true,status,body,headers:new Headers({'Content-Type':'application/octet-stream',...(getLength==null?{}:{'Content-Length':String(getLength)}),...(encoding?{'Content-Encoding':encoding}:{})})};
    },
    chrome:{runtime:{id:'test',onMessage:{addListener(){}},async sendMessage(m){sent.push(m);return {ok:m.type==='job:validate'?valid:true};}}},
  });
  vm.runInContext(source('directory-health.js'),context);vm.runInContext(source('offscreen.js'),context);
  const ctrl=new AbortController();context.job={jobId:'job',taskId:'task',runToken:'token',dirId:'dir',filename:'test.bag',apiDirpath:'/data/test.bag',overwrite};context.ctrl=ctrl;
  const promise=vm.runInContext('runJob(job,ctrl)',context);
  if(slow){await flush();ctrl.abort();gate.resolve();}
  await promise;await flush();
  return {content,removed,aborted,commits,requests,store,permissionRequests,result:sent.find((x)=>x.type==='job:result')};
}
test('完整小文件原子提交，并写入可验证的完成凭据',async()=>{
  const r=await writer();assert(r.result.ok);assert.equal(r.commits,1);assert.equal(r.content.length,4);assert.equal(r.store.get('file:dir:test.bag').size,4);assert.equal(r.result.bytes,4);assert.equal(r.result.totalBytes,4);
});
test('同名零字节文件必须下载，不能被跳过',async()=>{
  const r=await writer({oldBytes:new Uint8Array()});assert(r.result.ok);assert.equal(r.commits,1);assert(r.requests.includes('GET'));
});
test('有精确凭据的完成文件无需网络；旧文件需服务器精确长度验证',async()=>{
  const r=await writer({oldBytes:new Uint8Array(4),receipt:{dirpath:'/data/test.bag',size:4,modified:42}});
  assert(r.result.skipped);assert.equal(r.requests.length,0);
  const legacy=await writer({oldBytes:new Uint8Array(4)});assert(legacy.result.skipped);assert.deepEqual(legacy.requests,['POST','HEAD']);
});
test('截断流不能提交，清除新建的零字节占位',async()=>{
  const r=await writer({expected:10});assert.equal(r.result.ok,false);assert.equal(r.commits,0);assert(r.removed);assert.equal(r.content,null);
});
test('下载失败/停止保留已有内容，不把部分数据替换进去',async()=>{
  const original=new Uint8Array([9,9]);const r=await writer({oldBytes:original,expected:8});
  assert.equal(r.result.ok,false);assert.deepEqual(r.content,original);assert.equal(r.commits,0);
  const cancelled=await writer({oldBytes:original,slow:true});assert.equal(cancelled.result.ok,false);assert.equal(cancelled.commits,0);assert.deepEqual(cancelled.content,original);
});
test('权限错误和已停止任务在写入之前拒绝',async()=>{
  const r=await writer({permission:'denied'});assert.equal(r.result.code,'NEED_PERMISSION');assert.equal(r.requests.length,0);
  const stopped=await writer({valid:false});assert.equal(stopped.result.code,'CANCELLED');assert.equal(stopped.commits,0);
});
test('已保留的持久权限可在后台静默恢复并完整下载',async()=>{
  const r=await writer({permission:'prompt',restore:'granted'});
  assert(r.result.ok);assert.equal(r.permissionRequests,1);assert.equal(r.commits,1);assert.equal(r.content.length,4);
});
test('没有持久授权时保留真实权限状态，后台拒绝不会被误报为目录丢失',async()=>{
  const r=await writer({permission:'prompt',restore:Object.assign(Error('User activation is required'),{name:'SecurityError'})});
  assert.equal(r.result.code,'NEED_PERMISSION');assert.equal(r.result.directoryAccess.state,'permission');
  assert.equal(r.result.directoryAccess.permission,'prompt');assert.equal(r.result.directoryAccess.restoreError.code,'SecurityError');
  assert.equal(r.requests.length,0);assert.equal(r.commits,0);
});
test('保存目录消失、系统拒绝写入和数据库故障分别记录，不提示浏览器重新授权',async()=>{
  const missing=await writer({directoryMissing:true});
  assert.equal(missing.result.code,'DIR_NOT_FOUND');assert.equal(missing.result.directoryAccess.state,'unavailable');
  const denied=await writer({writeError:Object.assign(Error('OS access denied'),{name:'NotAllowedError'})});
  assert.equal(denied.result.code,'DIRECTORY_WRITE_DENIED');assert.equal(denied.result.directoryAccess.state,'unavailable');
  const database=await writer({storageError:Object.assign(Error('database disconnected'),{name:'InvalidStateError'})});
  assert.equal(database.result.code,'DIRECTORY_CHECK_FAILED');assert.equal(database.result.directoryAccess.state,'unavailable');assert.equal(database.requests.length,0);
});
test('磁盘写入失败不提交文件、不生成完成凭据',async()=>{
  const r=await writer({fail:true});assert.equal(r.result.ok,false);assert.equal(r.commits,0);assert(!r.store.has('file:dir:test.bag'));assert(r.removed);
});
test('兼容实测 8099 文件服务，拒绝其他地址',async()=>{
  let returned='http://10.198.92.173:8099/bags/test.bag';
  const context=vm.createContext({URL,Set,chrome:{runtime:{onMessage:{addListener(){}}}},setInterval(){},
    fetch:async()=>({ok:true,json:async()=>({code:20000,data:returned})})});
  vm.runInContext(source('offscreen.js'),context);
  assert.equal(await vm.runInContext("resolveLink('/data/test',undefined)",context),returned);
  returned='http://other.invalid/file';await assert.rejects(()=>vm.runInContext("resolveLink('/data/test',undefined)",context),/授权/);
});

test('文件已落盘但回执丢失，重启恢复仍跳过已验证完整文件，不重复 GET',async()=>{
  const r=await writer({overwrite:true,oldBytes:new Uint8Array(4),receipt:{dirpath:'/data/test.bag',size:4,modified:42}});
  assert(r.result.skipped);assert.equal(r.requests.length,0);assert.equal(r.commits,0);
  const noReceipt=await writer({overwrite:true,oldBytes:new Uint8Array(4)});
  assert(noReceipt.result.skipped);assert.deepEqual(noReceipt.requests,['POST','HEAD']);assert.equal(noReceipt.commits,0);
});
test('旧版本同名部分文件和过期凭据不能跳过，重新完整下载',async()=>{
  const r=await writer({oldBytes:new Uint8Array([9,9]),receipt:{dirpath:'/data/test.bag',size:4,modified:42}});
  assert(r.result.ok);assert.equal(r.result.skipped,undefined);assert.equal(r.commits,1);assert.equal(r.content.length,4);
  assert(r.requests.includes('GET'));
});
test('缺少响应长度时必须用 HEAD 精确核验，无法取得长度不提交文件',async()=>{
  const good=await writer({getLength:null});assert(good.result.ok);assert.equal(good.commits,1);assert(good.requests.includes('HEAD'));
  const unknown=await writer({getLength:null,headLength:null});assert.equal(unknown.result.ok,false);assert.equal(unknown.commits,0);
  assert.equal(unknown.content,null);assert.match(unknown.result.error,/精确文件长度/);
});
test('部分响应或压缩响应不能误记为完整数据包',async()=>{
  for(const opts of [{status:206},{encoding:'gzip'}]) {
    const r=await writer(opts);assert.equal(r.result.ok,false);assert.equal(r.commits,0);assert.equal(r.content,null);
  }
});
