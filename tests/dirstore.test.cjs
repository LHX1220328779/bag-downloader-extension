const test=require('node:test'),assert=require('node:assert/strict');
const {vm,source}=require('./helpers.cjs');
function database({alwaysClosed=false}={}){
  const records=new Map(),connections=[],faults=[];let writes=0,commits=0;
  const indexedDB={open(){
    const db={closed:alwaysClosed,close(){this.closed=true;},createObjectStore(){},transaction(_store,mode){
      if(this.closed)throw Object.assign(Error('connection closed'),{name:'InvalidStateError'});
      const fault=faults[0]?.mode===mode?faults.shift():null;
      const finish=(req,commit)=>queueMicrotask(()=>{
        if(fault){const error=Object.assign(Error('transaction interrupted'),{name:fault.name});req.error=error;if(fault.errorFirst)tx.onerror?.();tx.error=error;tx.onabort?.();}
        else {commit?.();tx.oncomplete?.();}
      });
      const tx={objectStore(){return {
        get(id){const req={result:records.get(id)};finish(req);return req;},
        put(record){writes++;const req={result:record.id};finish(req,()=>{commits++;records.set(record.id,record);});return req;},
      };}};
      return tx;
    }};
    connections.push(db);const req={result:db};queueMicrotask(()=>req.onsuccess?.());return req;
  }};
  const context=vm.createContext({indexedDB,console});vm.runInContext(source('dirstore.js'),context);
  const call=(fn,...args)=>{context.args=args;return vm.runInContext(`DirStore.${fn}(...args)`,context);};
  return {call,records,connections,get writes(){return writes;},get commits(){return commits;},abortNext(mode,name='AbortError',errorFirst=false){faults.push({mode,name,errorFirst});}};
}
test('目录数据库连接意外关闭后自动重开，原目录记录不需要人工恢复',async()=>{
  const e=database(),record={id:'original-dir',name:'rtfbag',handle:{identity:'original-directory'}};
  await e.call('put',record);e.connections[0].closed=true;
  assert.deepEqual(await e.call('get',record.id),record);assert.equal(e.connections.length,2);assert.equal(e.writes,1);
});
test('关闭事件和版本变化释放坏连接，后续写入只提交一次且保留旧记录',async()=>{
  const e=database();await e.call('put',{id:'first'});
  e.connections[0].closed=true;e.connections[0].onclose();await e.call('put',{id:'second'});
  e.connections[1].onversionchange();assert.deepEqual(await e.call('get','first'),{id:'first'});
  assert.equal(e.connections.length,3);assert.equal(e.writes,2);assert(e.records.has('second'));
});
test('持续失效的连接只重开一次后报告故障，不能无限循环或重复写入',async()=>{
  const e=database({alwaysClosed:true});
  await assert.rejects(()=>e.call('put',{id:'never-written'}),{name:'InvalidStateError'});
  assert.equal(e.connections.length,2);assert.equal(e.writes,0);assert.equal(e.records.size,0);
});
test('只读事务暂时中止后重开一次，原目录记录仍可读取',async()=>{
  const e=database();await e.call('put',{id:'existing'});e.abortNext('readonly');
  assert.deepEqual(await e.call('get','existing'),{id:'existing'});
  assert.equal(e.connections.length,2);assert.equal(e.commits,1);
});
test('写入事务确认中止后只重试一次，回滚的记录不重复提交且旧目录保留',async()=>{
  const e=database();await e.call('put',{id:'existing'});e.abortNext('readwrite');
  await e.call('put',{id:'new-directory'});
  assert.equal(e.writes,3);assert.equal(e.commits,2);assert.equal(e.records.size,2);
  assert.deepEqual(await e.call('get','existing'),{id:'existing'});assert.equal(e.connections.length,2);
});
test('两次事务中止最终保留 AbortError，只读写尝试有限且没有提交记录',async()=>{
  const e=database();e.abortNext('readwrite');e.abortNext('readwrite');
  await assert.rejects(()=>e.call('put',{id:'not-saved'}),{name:'AbortError'});
  assert.equal(e.connections.length,2);assert.equal(e.writes,2);assert.equal(e.commits,0);
});
test('请求错误在事务中止前到达时保留真实错误，不把约束错误误重试',async()=>{
  const e=database();e.abortNext('readwrite','ConstraintError',true);
  await assert.rejects(()=>e.call('put',{id:'invalid'}),{name:'ConstraintError'});
  assert.equal(e.connections.length,1);assert.equal(e.writes,1);assert.equal(e.commits,0);
});
