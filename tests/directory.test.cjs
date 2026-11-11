const test=require('node:test'),assert=require('node:assert/strict');
const {vm,source,clone}=require('./helpers.cjs');
const Paths=require('../directory-paths.js');
function directoryEnv() {
  const state={dirs:[]},records=new Map(),downloadItems=[],removed=[],erased=[],cancelled=[];
  const child={name:'child',async queryPermission(){return 'granted';}};
  const handle={name:'bags',async queryPermission(){return 'granted';},async getDirectoryHandle(name){if(name!=='child')throw Object.assign(Error('missing'),{name:'NotFoundError'});return child;}};
  records.set('root',{id:'root',name:'bags',handle});
  const context=vm.createContext({console,crypto:require('node:crypto').webcrypto,Date,
    DirStore:{async get(id){return records.get(id);},async put(rec){records.set(rec.id,rec);},async permission(rec){return rec?.handle?rec.handle.queryPermission():'missing';}},
    chrome:{runtime:{id:'test-extension'},storage:{local:{async get(key){return clone(Object.fromEntries((Array.isArray(key)?key:[key]).map(k=>[k,state[k]])));},async set(data){Object.assign(state,clone(data));},async remove(key){delete state[key];}}},downloads:{
      async download(){throw Error('不应创建任何 txt 下载');},
      async search(q){return clone(downloadItems.filter((d)=>q.id!=null?d.id===q.id:d.url===q.url));},
      async removeFile(id){removed.push(id);},async erase({id}){erased.push(id);},async cancel(id){cancelled.push(id);},
    }},
  });
  vm.runInContext(source('directory-paths.js'),context);vm.runInContext(source('directory-access.js'),context);
  const call=(fn,...args)=>{context.args=args;return vm.runInContext(`${fn}(...args)`,context);};
  return {context,state,records,downloadItems,removed,erased,cancelled,call};
}
test('Ubuntu、Windows 及 UNC 绝对路径保持完整，子目录匹配遵循平台大小写',()=>{
  assert.equal(Paths.normalize('/home/test/bags/'),'/home/test/bags');
  assert.equal(Paths.normalize('C:/Users/Test/Bags/'),'C:\\Users\\Test\\Bags');
  assert.deepEqual(Paths.relative('C:\\Users\\Test','c:\\users\\test\\Bags'),['Bags']);
  assert.equal(Paths.relative('/home/Test','/home/test/bags'),null);
  assert.deepEqual(Paths.relative('\\\\host\\share','\\\\host\\share\\bags'),['bags']);
  assert.deepEqual(Paths.splitFile('C:\\bags\\probe.txt'),{directory:'C:\\bags',name:'probe.txt'});
  assert.throws(()=>Paths.normalize('bags'),/绝对/);assert.throws(()=>Paths.normalize('/home/test/../bags'),/完整路径/);
});
test('选择已授权目录立即可用，不要求完整路径，不创建任何校验下载',async()=>{
  const e=directoryEnv();const selected=await e.call('selectDirectory','root');
  assert.equal(selected.name,'bags');assert.equal(e.state.lastDirId,'root');assert.equal(e.state.dirs[0].path,'');
  assert.equal(e.state.directoryProbe,undefined);assert.equal(e.downloadItems.length,0);
});
test('重新选择保留已有完整路径和目录 id，不影响原任务进度',async()=>{
  const e=directoryEnv();e.state.dirs=[{id:'root',name:'bags',path:'/home/test/bags'}];
  e.state.tasks=[{id:'task',dirId:'root',status:'running',runToken:'token',items:[{state:'done'}]}];
  const before=clone(e.state.tasks);await e.call('selectDirectory','root');
  assert.equal(e.state.dirs[0].path,'/home/test/bags');assert.deepEqual(e.state.tasks,before);
});
test('未授权目录仍需浏览器授权，不能靠文本路径绕过',async()=>{
  const e=directoryEnv();e.context.DirStore.permission=async()=> 'prompt';
  await assert.rejects(()=>e.call('selectDirectory','root'),/授权/);assert.equal(e.state.lastDirId,undefined);
});
test('已有完整路径可切换现有子目录，清空输入不修改已有任务和句柄',async()=>{
  const e=directoryEnv();e.state.dirs=[{id:'root',name:'bags',path:'/home/test/bags'}];
  e.state.tasks=[{id:'task',dirId:'root',status:'running'}];
  const child=await e.call('resolveDirectoryInput','/home/test/bags/child');assert.equal(child.path,'/home/test/bags/child');
  await assert.rejects(()=>e.call('resolveDirectoryInput','/home/test/bags/missing'),/missing/);
  await e.call('resolveDirectoryInput','');assert.equal(e.state.lastDirId,'');assert.equal(e.state.tasks[0].dirId,'root');assert(e.records.has('root'));
});
test('未知完整路径不按相同目录名称猜测，要求一次系统目录选择',async()=>{
  const e=directoryEnv();await e.call('selectDirectory','root');
  await assert.rejects(()=>e.call('resolveDirectoryInput','/another/bags'),/选择保存目录/);
  assert.equal(e.state.lastDirId,'root');assert.equal(e.state.dirs[0].path,'');
});
test('升级清除旧 txt 确认错误，不修改任务、已授权目录和文件进度',async()=>{
  const e=directoryEnv();await e.call('selectDirectory','root');
  e.state.tasks=[{id:'task',dirId:'root',status:'running',items:[{state:'done'}]}];
  e.state.directoryProbe={id:'old',status:'error',error:'请将校验文件保存到刚才选择的同一个目录'};
  const before=clone({dirs:e.state.dirs,tasks:e.state.tasks});await e.call('retireLegacyDirectoryProbe');
  assert.equal(e.state.directoryProbe,undefined);assert.deepEqual({dirs:e.state.dirs,tasks:e.state.tasks},before);
});
test('只清理旧版本本插件随机 URL 对应的 txt 下载，不清理 bag 或其他下载',async()=>{
  const e=directoryEnv(),url='data:text/plain;charset=utf-8,old-token';
  const probe={id:'old',filename:'BagFlow-path-old.txt',url,downloadId:9,status:'saving'};
  e.state.directoryProbe=probe;e.downloadItems.push({id:9,url,state:'complete',byExtensionId:'test-extension'});
  await e.call('retireLegacyDirectoryProbe');assert.deepEqual(e.removed,[9]);assert.deepEqual(e.erased,[9]);
  e.state.directoryProbe={...probe,id:'foreign',downloadId:10};
  e.downloadItems.push({id:10,url,state:'complete',byExtensionId:'other-extension'});
  await e.call('retireLegacyDirectoryProbe');assert.deepEqual(e.removed,[9]);
});
test('手动完整路径跨重新选择保留，显示标签不改变授权路径和任务进度',async()=>{
  const e=directoryEnv();await e.call('selectDirectory','root');
  e.state.tasks=[{id:'task',dirId:'root',runToken:'keep',items:[{state:'done'}]}];const before=clone(e.state.tasks);
  const label=await e.call('setDirectoryDisplayPath','root','/home/test/bags/');
  assert.equal(label.displayPath,'/home/test/bags');assert.equal(label.path,'');
  assert.equal(e.records.get('root').handle.name,'bags');assert.deepEqual(e.state.tasks,before);
  await e.call('selectDirectory','root');assert.equal(e.state.dirs[0].displayPath,'/home/test/bags');
  await assert.rejects(()=>e.call('resolveDirectoryInput','/home/test/bags/child'),/选择保存目录/);
  await assert.rejects(()=>e.call('setDirectoryDisplayPath','root','/home/test/other'),/结尾/);
  assert.equal(e.state.dirs[0].displayPath,'/home/test/bags');
});
test('Windows 手动路径规范化且目录名不区分大小写，授权仍来自句柄',async()=>{
  const e=directoryEnv();const r=await e.call('setDirectoryDisplayPath','root','C:/Users/Test/BAGS');
  assert.equal(r.displayPath,'C:\\Users\\Test\\BAGS');assert.equal(r.path,'');
  e.context.DirStore.permission=async()=> 'prompt';
  await assert.rejects(()=>e.call('setDirectoryDisplayPath','root','C:/Users/Test/BAGS'),/授权/);
});
test('首次创建绑定完整路径和已授权句柄，不改任务、不生成校验文件',async()=>{
  const e=directoryEnv();e.state.tasks=[{id:'keep',dirId:'root',dirPath:'/old/bags',runToken:'keep',items:[{jobId:'keep-job',bytes:10}]}];
  const before=clone(e.state.tasks);
  const dir=await e.call('bindDirectoryPath','root','/data/new/bags/',{mine_code:'WH',truck_no:'05'});
  assert.equal(dir.id,'root');assert.equal(e.state.taskDirectoryBindings['/data/new/bags'].dirId,'root');
  assert.deepEqual(e.state.tasks,before);assert.equal(e.downloadItems.length,0);
  await assert.rejects(()=>e.call('bindDirectoryPath','root','/data/wrong',{}),/请选择/);
  e.context.DirStore.permission=async()=> 'prompt';
  await assert.rejects(()=>e.call('bindDirectoryPath','root','/another/bags',{}),/允许/);
  assert.equal(Object.keys(e.state.taskDirectoryBindings).length,1);
});
test('已绑定路径不能被不同的同名实际目录覆盖',async()=>{
  const e=directoryEnv();await e.call('bindDirectoryPath','root','/data/bags',{});
  await assert.rejects(()=>e.call('bindDirectoryPath','root','/another/bags',{}),/与输入路径不同/);
  e.records.set('other',{id:'other',name:'bags',handle:{name:'bags',async queryPermission(){return 'granted';},async isSameEntry(){return false;}}});
  await assert.rejects(()=>e.call('bindDirectoryPath','other','/data/bags',{}),/另一个实际目录/);
  assert.equal(e.state.taskDirectoryBindings['/data/bags'].dirId,'root');
});
