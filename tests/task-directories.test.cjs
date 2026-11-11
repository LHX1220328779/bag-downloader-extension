const test = require('node:test'), assert = require('node:assert/strict');
const T = require('../task-directories.js'), D = require('../directory-paths.js');
const { background, flush, a } = require('./helpers.cjs');
const filters = { mine_code: 'WH', truck_no: 'WH-Truck05' };
test('目录草稿按矿区及车辆记忆，删除保留为空，不自动采用其他车辆历史', () => {
  const history = [{ ...filters, path: '/data/05/rtfbag', at: 1 }];
  assert.equal(T.preferred(filters, {}, history, [], '/data'), '/data/05/rtfbag');
  assert.equal(T.preferred({ ...filters, truck_no: 'WH-Truck06' }, {}, history, [], '/data'), '/data');
  assert.equal(T.preferred({ ...filters, truck_no: 'WH-Truck06' }, {}, history, []), '');
  assert.equal(T.resolve('/actual-browser-root', T.preferred({ ...filters, truck_no: 'WH-Truck06' }, {}, history, [])), '/actual-browser-root');
  assert.equal(T.preferred({ ...filters, mine_code: 'OTHER' }, {}, history, [], '/data'), '/data');
  assert.equal(T.preferred(filters, { [T.filterKey(filters)]: '' }, history, [], '/data'), '');
});
test('恢复旧任务目录，历史显示完整路径且去重；只回传任务不提供目录', () => {
  const tasks = [{ filters, dirPath: '/data/05/完整目录', createdAt: 3 }, { filters, dirPath: '/data/transfer', operations: { download: false }, createdAt: 4 }];
  const history = [{ ...filters, path: '/data/05/完整目录', at: 1 }, { mine_code: 'OTHER', truck_no: 'OTHER', path: '/data/other', at: 5 }];
  assert.equal(T.preferred(filters, {}, history, tasks, '/data'), '/data/05/完整目录');
  assert.deepEqual(T.choices(filters, history, tasks).map(e => e.path), ['/data/05/完整目录', '/data/other']);
  const remembered = T.remember(history, filters, '/data/05/完整目录/', 9);
  assert.equal(remembered.length, 2); assert.equal(remembered[0].at, 9);
});
test('目标路径在根目录之内，Linux/Windows/UNC 均保持准确，不额外追加 bags', () => {
  assert.equal(T.resolve('/data', '/data//怀宁/rtfbag/'), '/data/怀宁/rtfbag');
  assert.equal(T.resolve('/data', ''), '/data');
  assert.equal(T.resolve('C:\\Data', 'c:\\data\\怀宁\\rtfbag'), 'c:\\data\\怀宁\\rtfbag');
  assert.equal(T.resolve('\\\\server\\share', '\\\\server\\share\\A'), '\\\\server\\share\\A');
  assert.deepEqual(D.relative('/data', '/data//A'), ['A']);
  assert.throws(() => T.resolve('/data/A', '/data/B'), /一次设为 \/data/);
  assert.throws(() => T.resolve('C:\\Data', 'D:\\Data'), /不在/);
  for (const value of ['relative/path','/data/../B','/data/./A','/data/A\nB']) assert.throws(() => T.resolve('/data', value));
});
test('同一浏览器根创建两个独立目录，原任务及下载 ID 不变，全局元数据仍是根目录', async () => {
  const e = await background({}, { browserDefaultPath: '/data/haibo' });
  const operations = { transfer: false, download: true };
  const one = await e.create({ operations, download_path: '/data/haibo/huaining/05/rtfbag' });
  e.state.tasks[0].items = [{ ...a, state: 'downloading', attempts: 0, jobId: 'existing-job', browserDownloadId: 17, bytes: 2048 }];
  e.state.tasks[0].runToken = 'existing-token';
  const before = e.get(one.id);
  const two = await e.create({ operations, download_path: '/data/haibo/kushan/25/rtfbag' });
  assert.deepEqual(e.get(one.id), before);
  assert.equal(two.dirPath, '/data/haibo/kushan/25/rtfbag'); assert.equal(two.browserRelativeDir, '');
  assert.equal(e.state.dirs.find(d => d.backend === 'browser').path, '/data/haibo');
  assert.equal(e.server.downloadDirectory, '/data/haibo'); assert.equal(e.state.taskDirectoryHistory.length, 2);
  assert.equal(e.state.taskDirectoryHistory[0].path, two.dirPath);
});
test('非法/越界目标不创建任务，不覆盖历史；旧创建协议仍保存到浏览器实际目录', async () => {
  const e = await background({}, { browserDefaultPath: '/data/A' });
  const operations = { transfer: true, download: true };
  await assert.rejects(() => e.create({ operations, download_path: '/data/B' }), /一次设为 \/data/);
  await assert.rejects(() => e.create({ operations, download_path: 'relative' }), /绝对路径/);
  assert.equal(e.state.tasks.length, 0); assert.equal(e.state.taskDirectoryHistory, undefined);
  const t = await e.create({ operations }); assert.equal(t.dirPath, '/data/A');
});
test('仅回传忽略下载路径，不探测、不要求授权、不改变下载根或目录历史', async () => {
  const e = await background();
  e.context.DirStore.permission = async () => { throw Error('不应该请求目录权限'); };
  e.chrome.downloads.download = async () => { throw Error('不应该探测目录'); };
  const dirs = structuredClone(e.state.dirs);
  const t = await e.create({ operations: { transfer: true, download: false }, download_path: '任意未填写路径' });
  assert.equal(t.dirPath, ''); assert.equal(t.dirId, ''); assert.deepEqual(e.state.dirs, dirs);
  assert.equal(e.state.taskDirectoryHistory, undefined);
});
test('多个车辆的目录草稿串行保存，重启仍可读，写入不影响任务目录', async () => {
  const e = await background();
  const listener = e.chrome.runtime.onMessage.listeners[0];
  const draft = (filters, path) => new Promise(resolve => listener({ type: 'directory:draft', filters, path }, { id: e.chrome.runtime.id }, resolve));
  const other = { mine_code: 'HNMZ', truck_no: 'HNMZ-Truck06' };
  const results = await Promise.all([draft(filters, '/data/05'), draft(other, '/data/06'), draft(filters, '')]);
  assert(results.every(r => r.ok));
  const reboot = await background({}, { state: e.state }); await flush();
  assert.equal(T.preferred(filters, reboot.state.taskDirectoryDrafts, [], [], '/data'), '');
  assert.equal(T.preferred(other, reboot.state.taskDirectoryDrafts, [], [], '/data'), '/data/06');
  assert.deepEqual(reboot.state.tasks, []);
});
