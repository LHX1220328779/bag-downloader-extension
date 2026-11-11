const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../task-core.js'), T = require('../transfer-switch.js');
const { background, flush, deferred, a, b, row, vm, source } = require('./helpers.cjs');

async function start(e, extra = {}) {
  const t = await e.create({ operations: { transfer: true, download: false }, ...extra });
  e.state.tasks.find(s => s.id === t.id).coverageMode = 'legacy';
  await e.call('execute', t.id); await flush(); return t.id;
}
async function switchTo(e, id, enabled) {
  await e.call('setTransferEnabled', id, enabled); await flush();
  await e.call('reconcileTransferControl', id, true); await flush();
}
const catalog = n => Array.from({ length: n }, (_, i) => row(
  `Perception_2026-11-03-09-${String(i).padStart(2, '0')}-00_${i}.bag`, `09:${String(i).padStart(2, '0')}:00`,
));

test('新旧回传任务默认开启，明确关闭会保留；仅下载不可开启回传', async () => {
  const old = C.normalizeTask({ kind: 'transfer', transfers: [{ ...a, batchId: 'old-batch' }] });
  assert.equal(old.transferEnabled, true); assert.equal(old.transferControlRevision, 0);
  assert.deepEqual(old.transferBatchIds, ['old-batch']);
  old.transferEnabled = false; C.normalizeTask(old); assert.equal(old.transferEnabled, false);
  const e = await background(), transfer = await e.create(), download = await e.create({ kind: 'download' });
  assert.equal(transfer.transferEnabled, true); assert.equal(download.transferEnabled, false);
  await assert.rejects(e.call('setTransferEnabled', download.id, true), /仅下载/);
  await assert.rejects(e.call('setTransferEnabled', transfer.id, 'false'), /状态无效/);
  await assert.rejects(e.call('setTransferEnabled', 'missing', false), /任务不存在/);
});

test('归属必须由完整任务或批次标记证明，并核查矿区、车辆和来源', () => {
  const t = C.normalizeTask({ id: 'task-1', kind: 'transfer', filters: { truck_no: 'WH-Truck05', mine_code: 'WH' },
    transfers: [{ ...a, key: C.fileKey(a), batchId: 'old-batch' }], transferBatchIds: ['rejected-batch'] });
  const base = { record_no: 80, ...a, status: 'waiting', remarks: '' };
  assert(!T.owns(t, base)); assert(!T.owns(t, { ...base, remarks: '[BagFlow:task-10:deadbeef]' }));
  assert(!T.owns(t, { ...base, remarks: '[BagFlowTask:task-10]' }));
  assert(!T.owns(t, { ...base, remarks: '[BagFlow:task-1:invalidhash]' }));
  for (const remarks of [T.marker(t, t.transfers[0]), '[BagFlowTask:task-1]', '[BagFlowBatch:old-batch]', '[BagFlowBatch:rejected-batch]']) {
    assert(T.owns(t, { ...base, remarks }));
    assert(!T.owns(t, { ...base, remarks, truck_no: 'WH-Truck06' }));
    assert(!T.owns(t, { ...base, remarks, mine_code: 'OTHER' }));
    assert(!T.owns(t, { ...base, remarks, break_source: '手工' }));
  }
  t.transfers[0].recordNo = 80; assert(!T.owns(t, base), '匹配出的外部 recordNo 不能作为归属证据');
});

test('关闭暂停本任务全部未完成记录，重叠任务和手工回传不受影响，成功包不重传', async () => {
  const e = await background(); e.server.mdc = catalog(7); const id = await start(e), original = e.get(id);
  e.server.records.forEach((r, n) => r.status = ['waiting', 'downloading', 'cancelpause', 'failed', 'pause', 'succeed', 'waiting'][n]);
  const foreign = [
    { ...e.server.records[0], record_no: 90, remarks: '[BagFlowTask:other-task]' },
    { ...e.server.records[0], record_no: 91, remarks: '' },
    { ...e.server.records[0], record_no: 92, mine_code: 'OTHER' },
    { ...e.server.records[0], record_no: 93, truck_no: 'OTHER' },
    { ...e.server.records[0], record_no: 94, break_source: '手工' },
  ];
  e.server.records.push(...foreign);
  const overlapping = await start(e); assert.equal(e.submissions.length, 7);
  await switchTo(e, overlapping, false); assert.equal(e.transferCommands.length, 0, '共享完成结果的任务不能控制原任务建立的回传');
  await switchTo(e, id, false);
  assert.deepEqual(e.transferCommands.map(c => c.recordNo).sort(), ['1', '2', '3', '4', '7']);
  assert(e.server.records.slice(0, 7).every(r => ['pause', 'succeed'].includes(r.status)));
  assert.deepEqual(e.server.records.slice(7), foreign);
  assert.equal(e.get(id).transferControl.phase, 'settled'); assert.equal(e.get(id).transferControl.paused, 6);
  assert.equal(e.get(id).runToken, original.runToken); assert.equal(e.get(id).dirPath, original.dirPath);
  await switchTo(e, id, true);
  assert.deepEqual(e.transferCommands.filter(c => c.enabled).map(c => c.recordNo).sort(), ['1', '2', '3', '4', '5', '7']);
  assert.equal(e.submissions.length, 7); assert.equal(e.server.records[5].status, 'succeed');
  assert(e.get(id).transfers.every(i => i.submissionLocked));
});

test('多批次全部控制，记录无文件名时仍按本任务批次标记暂停、恢复', async () => {
  const e = await background(); e.server.mdc = catalog(35); const id = await start(e);
  assert.equal(e.get(id).transferBatchIds.length, 4);
  e.server.records.forEach(r => { delete r.filename; r.remarks = r.remarks.replace(/ \[BagFlowTask:[^\]]+\]/, ''); });
  await switchTo(e, id, false); assert.equal(e.transferCommands.length, 35);
  assert(e.server.records.every(r => r.status === 'pause'));
  await switchTo(e, id, true); assert.equal(e.transferCommands.length, 70);
  assert(e.server.records.every(r => r.status === 'cancelpause')); assert.equal(e.submissions.length, 35);
});

test('开关未操作时保留网站手工暂停，升级默认开启不会自动恢复远端记录', async () => {
  const e = await background(), id = await start(e); e.server.records.forEach(r => r.status = 'pause');
  await e.call('tickTask', id); await flush(); await e.call('reconcile'); await flush();
  assert.equal(e.transferCommands.length, 0);
  const reboot = await background({}, { state: e.state, server: e.server, now: e.context.Date.now() + 60000 });
  await flush(); assert.equal(reboot.get(id).transferEnabled, true); assert.equal(reboot.get(id).transferControlRevision, 0);
  assert.equal(reboot.transferCommands.length, 0); assert(reboot.server.records.every(r => r.status === 'pause'));
});

test('关闭期间发现的新包不提交，重新开启恢复原 ID 并追加剩余包', async () => {
  const e = await background(); e.server.mdc = [a]; const id = await start(e);
  await switchTo(e, id, false);
  e.server.mdc = [a, b]; await e.call('discover', e.get(id)); await flush();
  assert.equal(e.submissions.length, 1); assert.equal(e.get(id).transfers[1].state, 'pending');
  assert.equal(e.get(id).transfers[1].submissionLocked, false);
  const recordNo = e.server.records[0].record_no;
  await switchTo(e, id, true); await e.call('tickTask', id); await flush();
  assert.deepEqual(e.submissions.map(i => i.filename), [a.filename, b.filename]);
  assert.equal(e.server.records[0].record_no, recordNo);
  assert.equal(e.server.records[0].status, 'cancelpause'); assert.equal(e.get(id).transfers[0].attempts, 1);
});

test('首次轮询前关闭也立即显示各包暂停，恢复时保留已取得的百分比和原记录', async () => {
  const e = await background(), id = await start(e);
  assert(e.get(id).transfers.every(i => !i.recordNo));
  e.state.tasks[0].transfers.forEach(i => i.percentage = 42);
  await switchTo(e, id, false);
  assert(e.get(id).transfers.every(i => i.serverStatus === 'pause' && i.percentage === 42 && i.recordNo));
  await switchTo(e, id, true);
  assert(e.get(id).transfers.every(i => i.serverStatus === 'cancelpause' && i.percentage === 42));
  assert.equal(e.submissions.length, 2);
});

test('关闭时已经在途的批次晚到也全部补暂停，下一批阻止发送，开启后只追加未提交包', async () => {
  const gate = deferred(); let e;
  e = await background({ submitBatch: async (t, items) => {
    await gate.promise; e.submissionBatches.push(structuredClone(items));
    for (const i of items) await e.context.SiteAPI.submit(t, i);
  } });
  e.server.mdc = catalog(12); const id = await start(e), original = e.get(id);
  assert.equal(original.transfers.filter(i => i.state === 'submitting').length, 10);
  await switchTo(e, id, false); assert.equal(e.get(id).transferControl.awaitingRecords, 10);
  assert.match(e.get(id).transferControl.message, /在途/);
  gate.resolve(); await flush(); await e.call('reconcileTransferControl', id, true); await flush();
  assert.equal(e.submissions.length, 10); assert.equal(e.transferCommands.length, 10);
  assert(e.server.records.every(r => r.status === 'pause'));
  assert(e.get(id).transfers.slice(10).every(i => i.state === 'pending' && !i.submissionLocked));
  await switchTo(e, id, true); await e.call('tickTask', id); await flush();
  assert.equal(e.submissions.length, 12); assert.equal(new Set(e.submissions.map(i => i.filename)).size, 12);
  assert.equal(e.transferCommands.filter(c => c.enabled).length, 10); assert.equal(e.get(id).runToken, original.runToken);
});

test('提交计划落盘但请求未发出时关闭开关，恢复未提交状态并保留归属历史', async () => {
  const e = await background(); e.server.mdc = [a]; const t = await e.create({ operations: { transfer: true, download: false } });
  const s = e.state.tasks[0];
  Object.assign(s, { coverageMode: 'legacy', status: 'running', runToken: 'plan-token', searchReady: true, discovered: true,
    vehicleOnline: true, vehicleCheckedAt: e.context.Date.now() });
  C.mergeTransfers(s, [a]);
  const blocked = deferred(), release = deferred(), get = e.chrome.storage.local.get; let held = false;
  e.chrome.storage.local.get = async keys => {
    if (!held && (keys === 'tasks' || Array.isArray(keys) && keys.includes('tasks')) && s !== e.state.tasks[0] && e.state.tasks[0].transfers[0]?.state === 'submitting') {
      held = true; blocked.resolve(); await release.promise;
    }
    return get(keys);
  };
  const submitting = e.call('submitTransferBatch', e.get(t.id), [s.transfers[0].key]);
  await blocked.promise; await e.call('setTransferEnabled', t.id, false); release.resolve();
  await submitting; await flush();
  const result = e.get(t.id);
  assert.equal(e.submissions.length, 0); assert.equal(result.transfers[0].state, 'pending');
  assert.equal(result.transfers[0].attempts, 0); assert.equal(result.transfers[0].submissionLocked, false);
  assert.equal(result.transferBatchIds.length, 1); assert.equal(result.runToken, 'plan-token');
});

test('快速关闭再开启补偿已发出的暂停，最终恢复同一记录，不重复 mdcadd', async () => {
  const gate = deferred(), seen = deferred(); let e;
  e = await background({ pauseTransfer: async id => {
    e.transferCommands.push({ recordNo: String(id), enabled: false }); seen.resolve(); await gate.promise;
    e.server.records.find(r => String(r.record_no) === String(id)).status = 'pause';
  } });
  e.server.mdc = [a]; const id = await start(e), token = e.get(id).runToken;
  await e.call('setTransferEnabled', id, false); await seen.promise;
  await e.call('setTransferEnabled', id, true); assert.equal(e.get(id).transferEnabled, true);
  gate.resolve(); await flush(); await e.call('reconcileTransferControl', id, true); await flush();
  assert.deepEqual(e.transferCommands, [{ recordNo: '1', enabled: false }, { recordNo: '1', enabled: true }]);
  assert.equal(e.server.records[0].status, 'cancelpause'); assert.equal(e.get(id).transferControl.phase, 'settled');
  assert.equal(e.submissions.length, 1); assert.equal(e.get(id).runToken, token);
});

test('恢复途中再关闭时，写前开始的旧进度查询不能掩盖补暂停命令', async () => {
  const resumeSeen = deferred(), resumeRelease = deferred(), oldQuerySeen = deferred(), oldQueryRelease = deferred();
  let e, holdNextQuery = false;
  e = await background({ resumeTransfer: async id => {
    e.transferCommands.push({ recordNo: String(id), enabled: true }); resumeSeen.resolve(); await resumeRelease.promise;
    e.server.records.find(r => String(r.record_no) === String(id)).status = 'cancelpause';
  } });
  e.server.mdc = [a]; const id = await start(e); await switchTo(e, id, false); await e.call('stopTask', id);
  const read = e.context.SiteAPI.records;
  e.context.SiteAPI.records = async t => {
    const rows = await read(t);
    if (holdNextQuery) { holdNextQuery = false; oldQuerySeen.resolve(); await oldQueryRelease.promise; }
    return rows;
  };
  await e.call('setTransferEnabled', id, true); await resumeSeen.promise;
  holdNextQuery = true; const oldQuery = e.call('readTransferRecords', e.get(id)); await oldQuerySeen.promise;
  await e.call('setTransferEnabled', id, false); resumeRelease.resolve(); oldQueryRelease.resolve();
  assert.equal((await oldQuery)[0].status, 'pause', '查询确实带回写前的旧状态');
  await flush(); await e.call('reconcileTransferControl', id, true); await flush();
  assert.deepEqual(e.transferCommands.map(c => c.enabled), [false, true, false]);
  assert.equal(e.server.records[0].status, 'pause'); assert.equal(e.get(id).transferControl.phase, 'settled');
  assert.equal(e.get(id).status, 'stopped'); assert.equal(e.submissions.length, 1);
});

test('关闭后本地下载及目录继续，停止后再开启只恢复远端，不自动执行本地队列', async () => {
  const e = await background(); e.server.mdc = [a]; const id = await start(e, { operations: { transfer: true, download: true },
    directory_mode: 'selected', dir_id: 'dir1', download_path: '/test/bags' });
  const original = e.get(id); await switchTo(e, id, false);
  e.server.files = [a]; await e.call('tickTask', id); await flush();
  assert.equal(e.downloads.length, 1); assert.equal(e.get(id).dirPath, original.dirPath);
  assert.equal(e.get(id).runToken, original.runToken);
  await e.call('stopTask', id); const stopped = e.get(id), jobs = e.downloads.length;
  e.server.mdc = [a, b]; await switchTo(e, id, true);
  assert.equal(e.get(id).status, 'stopped'); assert.equal(e.get(id).runToken, stopped.runToken);
  assert.equal(e.get(id).dirId, original.dirId); assert.equal(e.downloads.length, jobs); assert.equal(e.submissions.length, 1);
  assert.equal(e.server.records[0].status, 'cancelpause');
});

test('暂停接口成功但远端状态未改变时继续等待确认，不能假报全部暂停', async () => {
  let calls = 0;
  const e = await background({ pauseTransfer: async () => { calls++; } }); e.server.mdc = [a]; const id = await start(e);
  await switchTo(e, id, false);
  assert.equal(calls, 1); assert.equal(e.get(id).transferControl.phase, 'pending');
  assert.equal(e.get(id).transferControl.paused, 0); assert.match(e.get(id).transferControl.message, /等待服务器确认/);
  await e.call('reconcileTransferControl', id, true); assert.equal(calls, 1, '请求确认期间节流，不每次查询都重发');
});

test('暂停已生效但响应断网，查询确认后清除错误并避免重复命令', async () => {
  let e, calls = 0;
  e = await background({ pauseTransfer: async id => {
    calls++; e.server.records.find(r => String(r.record_no) === String(id)).status = 'pause'; throw Error('Failed to fetch');
  } });
  e.server.mdc = [a]; const id = await start(e); await switchTo(e, id, false);
  assert.equal(calls, 1); assert.equal(e.get(id).transferControl.phase, 'settled'); assert.equal(e.get(id).transferControl.error, '');
  e.advance(60000); await e.call('reconcile'); await flush(); assert.equal(calls, 1);
});

test('网络故障持久保留关闭意图和重试时限，重载后自动补暂停，恢复接口失败也可重试', async () => {
  let calls = 0;
  const e = await background({ pauseTransfer: async () => { calls++; throw Error('network offline'); } });
  e.server.mdc = [a]; const id = await start(e); await switchTo(e, id, false);
  assert.equal(calls, 1); assert.equal(e.get(id).transferControl.phase, 'retry');
  assert.match(e.get(id).transferControl.message, /自动重试.*network offline/);
  const deadline = e.get(id).transferControlRecords[0].retryAt, original = e.get(id);
  const reboot = await background({}, { state: e.state, server: e.server, now: deadline - 1 }); await flush();
  assert.equal(reboot.transferCommands.length, 0); assert.equal(reboot.get(id).transferEnabled, false);
  reboot.advance(1); await reboot.call('reconcile'); await flush();
  assert.deepEqual(reboot.transferCommands, [{ recordNo: '1', enabled: false }]);
  assert.equal(reboot.get(id).transferControl.phase, 'settled'); assert.equal(reboot.get(id).runToken, original.runToken);
  let resumes = 0; const resume = reboot.context.SiteAPI.resumeTransfer;
  reboot.context.SiteAPI.resumeTransfer = async () => { resumes++; throw Error('resume offline'); };
  await switchTo(reboot, id, true); assert.equal(resumes, 1); assert.equal(reboot.get(id).transferControl.phase, 'retry');
  reboot.context.SiteAPI.resumeTransfer = resume; reboot.advance(30000); await reboot.call('reconcile'); await flush();
  assert.equal(reboot.server.records[0].status, 'cancelpause'); assert.equal(reboot.submissions.length, 0);
});

test('本地任务停止后，关闭开关的网络恢复仍由心跳处理，完成包保持完成', async () => {
  let e;
  e = await background({ pauseTransfer: async () => { throw Error('offline'); } });
  e.server.mdc = [a, b]; const id = await start(e); e.server.records[1].status = 'succeed';
  await e.call('tickTask', id); await e.call('stopTask', id); await switchTo(e, id, false);
  const stopped = e.get(id);
  const reboot = await background({}, { state: e.state, server: e.server, now: e.context.Date.now() + 60000 }); await flush();
  assert.equal(reboot.get(id).status, 'stopped'); assert.equal(reboot.get(id).runToken, stopped.runToken);
  assert.equal(reboot.server.records[0].status, 'pause'); assert.equal(reboot.server.records[1].status, 'succeed');
  assert.equal(reboot.get(id).transfers[1].state, 'done'); assert.equal(reboot.submissions.length, 0);
});

test('容量拒绝清空条目批次后仍保留归属，旧批次升级也可控制且不开启新提交', async () => {
  const error = Object.assign(Error('/api/bag/mdcadd：车辆回传任务较多'), { rejected: true });
  const e = await background({ submitBatch: async () => { throw error; } }); e.server.mdc = [a]; const id = await start(e);
  const t = e.get(id); assert.equal(t.transfers[0].batchId, null); assert.equal(t.transferBatchIds.length, 1);
  e.server.records = [{ record_no: 90, truck_no: t.filters.truck_no, break_source: 'mdc', status: 'waiting',
    remarks: `[BagFlowBatch:${t.transferBatchIds[0]}]` }];
  await switchTo(e, id, false); assert.equal(e.server.records[0].status, 'pause');
  e.advance(600000); await e.call('tickTask', id); await flush(); assert.equal(e.submissions.length, 0);
  assert.equal(e.get(id).transfers[0].submissionLocked, false);
  const legacy = C.normalizeTask({ ...t, transferBatchIds: undefined, transfers: [{ ...t.transfers[0], batchId: 'legacy' }] });
  assert(T.owns(legacy, { ...e.server.records[0], remarks: '[BagFlowBatch:legacy]' }));
});

test('确认过的归属可在后续备注不返回时继续控制，未确认的外部 ID 不控制', async () => {
  const e = await background(); e.server.mdc = [a]; const id = await start(e); await switchTo(e, id, false);
  delete e.server.records[0].remarks;
  e.server.records.push({ ...e.server.records[0], record_no: 90, status: 'pause' });
  await switchTo(e, id, true);
  assert.equal(e.server.records[0].status, 'cancelpause'); assert.equal(e.server.records[1].status, 'pause');
  assert.deepEqual(e.transferCommands.map(c => c.recordNo), ['1', '1']);
});

test('未确认的记录查询失败和未知状态不能假报成功，不发不支持的控制请求', async () => {
  const e = await background(); e.server.mdc = [a]; const id = await start(e);
  e.context.SiteAPI.records = async () => { throw Error('records offline'); };
  await switchTo(e, id, false); assert.equal(e.get(id).transferControl.phase, 'retry');
  assert.equal(e.transferCommands.length, 0); assert.match(e.get(id).transferControl.error, /记录核对失败/);
  e.server.records[0].status = 'new-status'; e.context.SiteAPI.records = async () => structuredClone(e.server.records);
  await e.call('reconcileTransferControl', id, true); await flush();
  assert.equal(e.transferCommands.length, 0); assert.equal(e.get(id).transferControl.phase, 'retry');
  assert.match(e.get(id).transferControl.error, /状态未知/);
});

test('任务完成后切换不重启下载、不重复成功回传；明确关闭执行时不会默认重开', async () => {
  const e = await background(); e.server.mdc = [a]; const id = await start(e);
  e.server.records[0].status = 'succeed'; await e.call('tickTask', id); await flush(); assert.equal(e.get(id).status, 'done');
  const completed = e.get(id); await switchTo(e, id, false); await switchTo(e, id, true);
  assert.equal(e.transferCommands.length, 0); assert.equal(e.get(id).status, 'done'); assert.equal(e.get(id).runToken, completed.runToken);
  const t = await e.create({ operations: { transfer: true, download: false } });
  await switchTo(e, t.id, false); await e.call('execute', t.id); await flush();
  assert.equal(e.get(t.id).transferEnabled, false); assert.equal(e.submissions.length, 1);
});

test('后台消息使用明确开关目标，重复请求幂等；网页不能控制回传', async () => {
  const e = await background(); e.server.mdc = [a]; const id = await start(e), listener = e.chrome.runtime.onMessage.listeners[0];
  const message = (enabled, sender = { id: e.chrome.runtime.id }) => new Promise(resolve => listener({ type: 'transfer:set', id, enabled }, sender, resolve));
  const first = await message(false);
  assert.equal(first.ok, true); assert.equal(first.enabled, false); assert(Number.isSafeInteger(first.revision)); assert(first.requestId); await flush();
  const revision = e.get(id).transferControlRevision;
  const repeated = await message(false);
  assert.equal(repeated.ok, true); assert.equal(repeated.enabled, false); assert.equal(repeated.revision, first.revision); await flush();
  assert.equal(e.get(id).transferControlRevision, revision); assert.equal(e.transferCommands.length, 1);
  assert.equal((await message(true, { id: e.chrome.runtime.id, tab: { id: 1 }, url: 'http://10.198.92.173:8080/table' })).ok, false);
  assert.equal(e.get(id).transferEnabled, false);
});

test('独立保存的暂停选择优先于旧任务快照，字段丢失和多轮心跳不能重新开启', async () => {
  const e = await background(), id = await start(e), old = structuredClone(e.state.tasks);
  await switchTo(e, id, false); const choice = structuredClone(e.state.taskTransferSelections[id]);
  assert.equal(choice.enabled, false); assert.equal(choice.revision, 1);
  for (let n = 0; n < 6; n++) {
    e.state.tasks = structuredClone(old);
    if (n % 2) { delete e.state.tasks[0].transferEnabled; delete e.state.tasks[0].transferControlRevision; }
    e.advance(60000); await e.call('reconcile'); await flush();
    assert.equal((await e.call('snapshot', id)).transferEnabled, false);
    assert.equal(e.get(id).transferEnabled, false); assert.deepEqual(e.state.taskTransferSelections[id], choice);
    assert(e.server.records.every(r => r.status === 'pause'));
  }
  assert.equal(e.submissions.length, 2); assert.equal(e.transferCommands.filter(c => c.enabled).length, 0);
});

test('旧版已经暂停的任务升级时建立独立选择，重开保留原记录和暂停状态', async () => {
  const e = await background(), id = await start(e); await switchTo(e, id, false);
  const legacy = structuredClone(e.state); delete legacy.taskTransferSelections;
  const reboot = await background({}, { state: legacy, server: e.server, now: e.context.Date.now() + 60000 }); await flush();
  assert.equal(reboot.state.taskTransferSelections[id].enabled, false);
  assert.equal(reboot.state.taskTransferSelections[id].revision, e.get(id).transferControlRevision);
  assert.equal(reboot.get(id).transferEnabled, false); assert(reboot.server.records.every(r => r.status === 'pause'));
  assert.equal(reboot.transferCommands.length, 0); assert.equal(reboot.submissions.length, 0);
});

test('每个任务独立保存选择，暂停和删除一个任务不修改另一个任务的回传选择', async () => {
  const e = await background(); e.server.mdc = [a]; const first = await start(e);
  e.server.mdc = [b]; const second = await start(e), otherChoice = structuredClone(e.state.taskTransferSelections[second]);
  await switchTo(e, first, false);
  assert.equal(e.server.records[0].status, 'pause'); assert.equal(e.server.records[1].status, 'waiting');
  assert.equal(e.get(second).transferEnabled, true); assert.deepEqual(e.state.taskTransferSelections[second], otherChoice);
  await e.call('deleteTask', first); assert.equal(e.state.taskTransferSelections[first], undefined);
  assert.deepEqual(e.state.taskTransferSelections[second], otherChoice); assert.equal(e.server.records.length, 2);
});

test('请求确认绑定本次选择，重复关闭幂等，刷新和归一化只读取选择', async () => {
  const e = await background(), id = await start(e), listener = e.chrome.runtime.onMessage.listeners[0];
  const msg = (enabled, requestId) => new Promise(resolve => listener({ type: 'transfer:set', id, enabled, requestId }, { id: e.chrome.runtime.id }, resolve));
  const first = await msg(false, 'request-close-1'); await flush();
  assert.equal(first.requestId, 'request-close-1'); assert.equal(first.enabled, false);
  const again = await msg(false, 'request-close-2'); await flush();
  assert.equal(again.requestId, 'request-close-2'); assert.equal(again.revision, first.revision);
  const t = C.normalizeTask(C.applyTransferSelection({ ...e.get(id), transferEnabled: true }, e.state.taskTransferSelections[id]));
  assert.equal(t.transferEnabled, false); assert.equal(e.transferCommands.filter(c => c.enabled).length, 0);
  const invalid = await msg(true, '../invalid'); assert.equal(invalid.ok, false); assert.equal(e.state.taskTransferSelections[id].enabled, false);
  const resumed = await msg(true, 'request-open-3'); await flush();
  assert.equal(resumed.requestId, 'request-open-3'); assert.equal(resumed.revision, first.revision + 1);
  assert(e.server.records.every(r => r.status === 'cancelpause')); assert.equal(e.submissions.length, 2);
});

test('暂停恢复使用站点 POST 路径且无业务请求体，拒绝无效 ID 和失败返回', async () => {
  const calls = [], context = vm.createContext({ AbortSignal, fetch: async (url, init) => {
    calls.push({ url, init }); return { ok: true, json: async () => ({ code: calls.length === 1 ? 2000 : 20000, data: 'ok' }) };
  } });
  vm.runInContext(source('site-api.js'), context);
  await context.SiteAPI.pauseTransfer(42); await context.SiteAPI.resumeTransfer('43');
  assert.deepEqual(calls.map(c => c.url), ['http://10.198.92.173:8080/api/break/pause/42', 'http://10.198.92.173:8080/api/break/cancelpause/43']);
  assert(calls.every(c => c.init.method === 'POST' && c.init.body === undefined && c.init.credentials === 'include'));
  for (const id of [null, '', '../remove', '1?record=2', 'a/b', '1\n']) await assert.rejects(context.SiteAPI.pauseTransfer(id), /编号无效/);
  assert.equal(calls.length, 2);
  context.fetch = async () => ({ ok: true, json: async () => ({ code: 4000, message: 'pause denied' }) });
  await assert.rejects(context.SiteAPI.pauseTransfer(42), e => e.rejected === true && /pause denied/.test(e.message));
  context.fetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(context.SiteAPI.resumeTransfer(43), e => e.rejected !== true && /HTTP 500/.test(e.message));
});
