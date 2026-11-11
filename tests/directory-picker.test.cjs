const test = require('node:test'), assert = require('node:assert/strict');
const Picker = require('../directory-picker.js');
const { vm, source } = require('./helpers.cjs');
const handle = (name = 'rtfbag') => ({ kind: 'directory', name, async requestPermission() { return 'granted'; } });
const domError = (name, message = name) => Object.assign(new Error(message), { name });
async function failure(operation) {
  let error;
  try { await operation.promise; } catch (e) { error = e; }
  assert(error, '操作应拒绝'); return Picker.failure(operation, error);
}

test('先读模式选目录再明确写入授权，获得授权前不持久化目录', async () => {
  const order = [], h = handle();
  h.requestPermission = options => { order.push(['permission', options.mode]); return Promise.resolve('granted'); };
  const operation = Picker.begin({ path: 'D:\\数据\\rtfbag',
    picker(options) { order.push(['picker', options.mode]); return Promise.resolve(h); },
    claim(picked) { assert.equal(picked, h); order.push(['claim']); return { id: 'saved', handle: h }; },
  });
  assert.equal((await operation.promise).id, 'saved');
  assert.deepEqual(order, [['picker', 'read'], ['permission', 'readwrite'], ['claim']]);
  assert.equal(operation.permissionState, 'granted');
});
test('浏览器全局 const 目录存储对象能被默认登记流程访问，不要求它属于 window 属性', async () => {
  const h = handle(), context = vm.createContext({ DirPaths: require('../directory-paths.js'), showDirectoryPicker: () => h });
  vm.runInContext('const DirStore = { claim: handle => Promise.resolve({ id: "browser-directory", handle }) };', context);
  assert.equal(context.DirStore, undefined);
  vm.runInContext(source('directory-picker.js'), context);
  const operation = context.DirectoryPicker.begin({ path: 'D:\\数据\\rtfbag' });
  assert.equal((await operation.promise).id, 'browser-directory');
});

test('选中后拒绝写入不误报取消，重试复用目录且不再次打开选择窗口', async () => {
  const h = handle(); let picks = 0, claims = 0, requests = 0, selected;
  h.requestPermission = () => Promise.resolve(++requests === 1 ? 'denied' : 'granted');
  const options = { path: 'D:\\数据\\rtfbag', picker() { picks++; return h; },
    onPicked(value) { selected = value; }, claim(value) { claims++; return { id: 'same-directory', handle: value }; } };
  const first = Picker.begin(options), error = await failure(first);
  assert.equal(error.stage, 'permission'); assert.equal(error.code, 'NotAllowedError');
  assert.equal(error.directorySelected, true); assert.equal(error.permissionState, 'denied');
  assert.match(error.displayMessage, /未获得写入权限/); assert.doesNotMatch(error.displayMessage, /已取消/);
  assert.equal(claims, 0);
  const second = Picker.begin({ ...options, pendingHandle: selected });
  assert.equal((await second.promise).id, 'same-directory');
  assert.equal(picks, 1); assert.equal(claims, 1);
});

test('目录选择 API 的 AbortError 保留浏览器拒绝的可能性，不认定用户取消', async () => {
  let claims = 0;
  const operation = Picker.begin({ path: 'C:\\Windows', picker() { return Promise.reject(domError('AbortError', 'The user aborted a request.')); }, claim() { claims++; } });
  const error = await failure(operation);
  assert.equal(error.stage, 'picker'); assert.equal(error.directorySelected, false);
  assert.equal(error.message, 'The user aborted a request.');
  assert.match(error.displayMessage, /拒绝访问/); assert.doesNotMatch(error.displayMessage, /已取消目录选择/);
  assert.equal(claims, 0);
});

test('写入授权自身返回 AbortError 仍显示授权失败，保留已经选中的目录', async () => {
  const h = handle(); let selected, claims = 0;
  h.requestPermission = () => Promise.reject(domError('AbortError'));
  const operation = Picker.begin({ path: 'E:\\采集\\rtfbag', picker: () => h,
    onPicked(value) { selected = value; }, claim() { claims++; } });
  const error = await failure(operation);
  assert.equal(selected, h); assert.equal(error.stage, 'permission'); assert.equal(error.code, 'AbortError');
  assert.match(error.displayMessage, /未获得写入权限/); assert.doesNotMatch(error.displayMessage, /已取消/);
  assert.equal(claims, 0);
});

test('目录已选中后数据库中止不会误报取消，下次创建复用选择再保存', async () => {
  const h = handle(); let selected, picks = 0, saves = 0;
  const options = { path: '/data/rtfbag', picker() { picks++; return h; }, onPicked(value) { selected = value; },
    claim(value) { if (++saves === 1) throw domError('AbortError', 'transaction aborted'); return { id: 'original', handle: value }; } };
  const first = Picker.begin(options), error = await failure(first);
  assert.equal(error.stage, 'persist'); assert.equal(error.permissionState, 'granted');
  assert.match(error.displayMessage, /保存目录记录失败/); assert.doesNotMatch(error.displayMessage, /已取消/);
  const second = Picker.begin({ ...options, pendingHandle: selected });
  assert.equal((await second.promise).id, 'original'); assert.equal(picks, 1); assert.equal(saves, 2);
});

test('已保存且授权有效的目录直接创建，不重复选择、授权或登记', async () => {
  const h = handle(), rec = { id: 'kept', handle: h }; let requests = 0;
  h.requestPermission = () => { requests++; throw Error('不应再次授权'); };
  const operation = Picker.begin({ path: 'D:\\数据\\RTFBAG', record: rec, permission: 'granted',
    picker() { throw Error('不应再次选目录'); }, claim() { throw Error('不应再次登记'); } });
  assert.equal(await operation.promise, rec); assert.equal(requests, 0);
});

test('旧句柄和选中后保留的句柄在按钮点击中直接请求，不先等待数据库或权限查询', async () => {
  for (const saved of [true, false]) {
    let clicked = true, requested = false;
    const h = handle(); h.requestPermission = () => { assert(clicked); requested = true; return Promise.resolve('granted'); };
    const rec = { id: 'same', handle: h };
    const operation = Picker.begin({ path: 'D:\\数据\\rtfbag', ...(saved ? { record: rec, permission: 'prompt' } : { pendingHandle: h }),
      claim() { return rec; } });
    clicked = false; assert.equal(requested, true); assert.equal(await operation.promise, rec);
  }
});

test('浏览器丢失激活而拒绝授权时可通过下一次点击复用句柄恢复', async () => {
  const h = handle(); let selected, requests = 0, picks = 0;
  h.requestPermission = () => { if (++requests === 1) throw domError('SecurityError', 'User activation is required'); return Promise.resolve('granted'); };
  const options = { path: 'D:\\数据\\rtfbag', picker() { picks++; return h; }, onPicked(value) { selected = value; }, claim: value => ({ id: 'saved', handle: value }) };
  const first = Picker.begin(options), error = await failure(first);
  assert.equal(error.stage, 'permission'); assert.equal(error.code, 'SecurityError');
  assert.match(error.displayMessage, /再次点击/);
  await Picker.begin({ ...options, pendingHandle: selected }).promise; assert.equal(picks, 1);
});

test('Windows 和 UNC 目录名大小写兼容，错误目录在授权或持久化前拦截', async () => {
  for (const path of ['D:\\Data\\RTFBAG', '\\\\server\\share\\RTFBAG']) {
    const h = handle(); await Picker.begin({ path, picker: () => h, claim: value => ({ id: 'saved', handle: value }) }).promise;
  }
  let requests = 0, selected = false;
  const h = handle('wrong'); h.requestPermission = () => { requests++; };
  const error = await failure(Picker.begin({ path: 'D:\\数据\\rtfbag', picker: () => h,
    onPicked() { selected = true; }, claim() { throw Error('不应保存错误目录'); } }));
  assert.equal(error.stage, 'validate'); assert.match(error.displayMessage, /wrong/);
  assert.equal(requests, 0); assert.equal(selected, false);
});
