const test = require('node:test'), assert = require('node:assert/strict');
const { background, flush, a } = require('./helpers.cjs');
const T = require('../task-directories.js');
const selected = { directory_mode: 'selected', operations: { transfer: false, download: true }, dir_id: 'dir1', download_path: '' };
test('目录选择模式只用目标句柄，与浏览器根目录无关，不启动原生探测', async () => {
  const e = await background(); e.chrome.downloads.download = async () => { throw Error('不应下载探测文件'); };
  const t = await e.create(selected);
  assert.equal(t.downloadBackend, 'directory'); assert.equal(t.dirId, 'dir1'); assert.equal(t.dirPath, ''); assert(t.directorySnapshot);
  assert.equal(e.state.taskDirectoryHistory[0].dir_id, 'dir1');
});
test('无句柄/浏览器目录/权限未允许时拦截，文本不能代替目录授权', async () => {
  const e = await background(); await e.call('ensureBrowserDirectory');
  for (const dir_id of ['', 'missing', 'browser-downloads:bags']) await assert.rejects(() => e.create({ ...selected, dir_id, download_path: '/any/bags' }), /授权|不可用/);
  e.context.DirStore.permission = async () => 'prompt';
  await assert.rejects(() => e.create(selected), /授权/); assert.equal(e.state.tasks.length, 0);
});
test('创建时冻结完整显示路径；更换选择及编辑标签不改原任务目录和 job', async () => {
  const e = await background();
  const one = await e.create({ ...selected, download_path: '/home/first/bags' });
  e.state.tasks[0].items = [{ ...a, state: 'downloading', attempts: 1, bytes: 12, jobId: 'inflight' }]; e.state.tasks[0].runToken = 'keep';
  const before = e.get(one.id); e.state.dirs.push({ id: 'dir2', name: 'bags' });
  const two = await e.create({ ...selected, dir_id: 'dir2', download_path: '/mnt/other/bags' });
  assert.deepEqual(e.get(one.id), before); assert.equal(two.dirPath, '/mnt/other/bags'); assert.equal(two.dirId, 'dir2');
  await assert.rejects(() => e.create({ ...selected, download_path: '/home/other-name' }), /结尾/);
  const noPath = await e.create(selected);
  await e.call('fillMissingTaskPaths', 'dir1', '/home/new-label/bags'); assert.equal(e.get(noPath.id).dirPath, '');
});
test('两个不同目录同名包可同时下载；停止一个只取消自身 job', async () => {
  const e = await background(); e.state.dirs.push({ id: 'dir2', name: 'bags' }); e.server.files = [a];
  const one = await e.create(selected), two = await e.create({ ...selected, dir_id: 'dir2' });
  for (const id of [one.id,two.id]) await e.call('edit',id,null,t=>{t.coverageMode='legacy';});
  await e.call('execute',one.id); await e.call('execute',two.id); await flush();
  assert.equal(e.downloads.length, 2); assert.deepEqual(new Set(e.downloads.map(d => d.dirId)), new Set(['dir1','dir2']));
  const secondJob = e.get(two.id).items[0].jobId; await e.call('stopTask',one.id);
  assert.equal(e.get(two.id).items[0].jobId,secondJob); assert(e.activeJobs.has(secondJob));
});
test('相同实际目录的历史别名只分配一个写入者，完成后及时唤醒另一任务', async () => {
  const e = await background(); e.state.dirs.push({ id: 'alias', name: 'bags' });
  const handle = { async isSameEntry() { return true; } };
  e.context.DirStore.get = async () => ({ handle });
  await e.call('indexDirectoryIdentities', e.state.dirs); e.server.files = [a];
  const one = await e.create(selected), two = await e.create({ ...selected, dir_id: 'alias' });
  for (const id of [one.id,two.id]) await e.call('edit',id,null,t=>{t.coverageMode='legacy';});
  await e.call('execute',one.id); await e.call('execute',two.id); await flush(); assert.equal(e.downloads.length,1);
  await e.call('onJobResult',{jobId:e.downloads[0].jobId,ok:true}); await flush();
  assert.equal(e.downloads.length,2); assert.equal(e.downloads[0].writeDirectoryKey,e.downloads[1].writeDirectoryKey);
});
test('旧原生任务和新目录任务保留各自后端、原下载 ID 与运行代次', async () => {
  const e = await background(); const old = await e.create({ operations: { transfer: false, download: true } });
  const stored = e.state.tasks.find(t => t.id === old.id);
  Object.assign(stored,{runToken:'native-keep',items:[{...a,state:'downloading',attempts:1,jobId:'native-job',browserDownloadId:77}]});
  const before = e.get(old.id); const fresh = await e.create(selected);
  assert.deepEqual(e.get(old.id),before); assert.equal(fresh.downloadBackend,'directory');
});
test('目录历史以 ID 区分同名目录，不包含旧浏览器根；按车辆记忆选择', () => {
  const dirs = [{id:'a',name:'rtfbag'},{id:'b',name:'rtfbag'},{id:'native',name:'浏览器下载目录',backend:'browser'}];
  const filters={truck_no:'05',mine_code:'HNMZ'},history=[{...filters,dir_id:'b',path:'/mnt/b/rtfbag',at:3},{truck_no:'06',mine_code:'HNMZ',dir_id:'a',path:'/home/a/rtfbag',at:4}];
  const options=T.handleChoices(filters,dirs,history,[]);
  assert.deepEqual(options.map(e=>e.id),['b','a']); assert.equal(options[0].displayPath,'/mnt/b/rtfbag');
  assert(T.handleChoices({truck_no:'new',mine_code:'HNMZ'},dirs,history,[]).every(e=>!e.matching));
});
test('完整路径精确绑定；修改路径不复用相同末级目录，也不信任显示草稿', () => {
  const dirs = [{ id: 'a', name: 'rtfbag', displayPath: '/wrong/rtfbag' }, { id: 'b', name: 'rtfbag' }];
  const bindings = { '/data/A/rtfbag': { dirId: 'a', path: '/data/A/rtfbag' }, '/data/B/rtfbag': { dirId: 'b', path: '/data/B/rtfbag' } };
  assert.equal(T.pathDirectory('/data/A//rtfbag/', bindings, dirs).id, 'a');
  assert.equal(T.pathDirectory('/data/B/rtfbag', bindings, dirs).id, 'b');
  assert.equal(T.pathDirectory('/data/C/rtfbag', bindings, dirs), null);
  assert.equal(T.pathDirectory('/wrong/rtfbag', bindings, dirs), null);
  const windows = { 'c:/data/a/rtfbag': { dirId: 'a', path: 'C:\\Data\\A\\rtfbag' } };
  assert.equal(T.pathDirectory('c:\\DATA\\a\\RTFBAG', windows, dirs).id, 'a');
});
test('旧任务成功创建的完整路径可复用，历史指向不同句柄时要求重新选择', () => {
  const dirs = [{ id: 'a', name: 'rtfbag' }, { id: 'b', name: 'rtfbag' }];
  const history = [{ dir_id: 'a', path: '/A/rtfbag', backend: 'directory' }];
  assert.equal(T.pathDirectory('/A/rtfbag', {}, dirs, history).id, 'a');
  history.push({ dir_id: 'b', path: '/A/rtfbag', backend: 'directory' });
  assert.equal(T.pathDirectory('/A/rtfbag', {}, dirs, history), null);
});
test('路径模式创建核查绑定和权限，冻结原目录，不改已在下载的任务', async () => {
  const e = await background();
  e.state.dirs.push({ id: 'dir2', name: 'bags' });
  e.state.taskDirectoryBindings = { '/A/bags': { dirId: 'dir1', path: '/A/bags' }, '/B/bags': { dirId: 'dir2', path: '/B/bags' } };
  const pathMode = { ...selected, directory_mode: 'path', download_path: '/A/bags' };
  const one = await e.create(pathMode);
  Object.assign(e.state.tasks[0], { status: 'running', runToken: 'keep', items: [{ ...a, state: 'downloading', jobId: 'keep-job', bytes: 123, attempts: 0 }] });
  const before = e.get(one.id);
  const two = await e.create({ ...pathMode, dir_id: 'dir2', download_path: '/B/bags' });
  assert.equal(two.dirId, 'dir2'); assert.equal(two.dirPath, '/B/bags'); assert(two.directorySnapshot);
  assert.deepEqual(e.get(one.id), before);
  await assert.rejects(() => e.create({ ...pathMode, download_path: '/C/bags' }), /绑定/);
  await assert.rejects(() => e.create({ ...pathMode, dir_id: 'dir2' }), /绑定/);
  await assert.rejects(() => e.create({ ...pathMode, download_path: '' }), /完整/);
  e.context.DirStore.permission = async () => 'prompt';
  await assert.rejects(() => e.create(pathMode), /授权/); assert.equal(e.state.tasks.length, 2);
});
