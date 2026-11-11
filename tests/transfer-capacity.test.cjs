const test = require('node:test'), assert = require('node:assert/strict');
const { background, flush, deferred, a, b, row } = require('./helpers.cjs');

const capacityError = () => Object.assign(new Error('/api/bag/mdcadd：车辆回传任务较多，请稍后再试'), { rejected: true });
const catalog = n => Array.from({ length: n }, (_, i) => row(
  `Perception_2026-11-03-09-${String(i).padStart(2, '0')}-00_${i}.bag`,
  `09:${String(i).padStart(2, '0')}:00`,
));
async function start(e, extra = {}) {
  const t = await e.create({ operations: { transfer: true, download: false }, ...extra });
  e.state.tasks.find(s => s.id === t.id).coverageMode = 'legacy';
  await e.call('execute', t.id); await flush(); return t.id;
}
function record(t, i, id, status = 'waiting') {
  return { record_no: id, filename: i.filename, truck_no: t.filters.truck_no, mine_code: t.filters.mine_code,
    break_source: 'mdc', breaktime: i.create_time.slice(0, 16), status };
}

test('容量释放少于整批时逐包追加，已接受包不重复提交，最终完成全部回传', async () => {
  const calls = [], accepted = [], files = catalog(12); let occupied = 0, e;
  e = await background({ submitBatch: async (t, items) => {
    calls.push(items.map(i => i.filename));
    if (occupied + items.length > 3) throw capacityError();
    for (const i of items) {
      occupied++; accepted.push(i.filename); e.server.records.push(record(t, i, accepted.length));
    }
  } });
  e.server.mdc = files.slice().reverse(); const id = await start(e), token = e.get(id).runToken;
  assert.deepEqual(calls.map(xs => xs.length), [10]);
  assert(e.get(id).transfers.every(i => i.state === 'pending' && !i.submissionLocked));
  assert.equal(e.get(id).transfers.filter(i => i.capacityRetries).length, 10);
  await e.call('tickTask', id); await flush();
  assert.equal(calls.length, 1); assert.match(e.get(id).transferMessage, /已提交 0 \/ 12/);
  for (let cycle = 1; cycle <= 4; cycle++) {
    e.server.records.forEach(r => r.status = 'succeed'); occupied = 0;
    e.advance(cycle === 1 ? 30000 : 60000); await e.call('tickTask', id); await flush();
    assert.equal(accepted.length, cycle * 3);
    assert.equal(new Set(accepted).size, accepted.length);
  }
  assert.deepEqual(accepted, files.map(i => i.filename));
  assert(calls.slice(1).every(xs => xs.length <= 2), '拒绝过的包应逐包重试，末尾新包可成批追加');
  e.server.records.forEach(r => r.status = 'succeed'); await e.call('tickTask', id); await flush();
  assert.equal(e.get(id).status, 'done'); assert.equal(e.get(id).runToken, token);
  assert(e.get(id).transfers.every(i => i.state === 'done' && !i.retryAt && !i.capacityRetries));
  assert.equal(e.downloads.length, 0);
});

test('容量重试持久保存，重启保留任务和退避时间，恢复时改为单包提交', async () => {
  const e = await background({ submitBatch: async () => { throw capacityError(); } });
  const id = await start(e), original = e.get(id), deadline = original.transfers[0].retryAt;
  const reboot = await background({}, { state: e.state, server: e.server, now: deadline - 1000 }); await flush();
  assert.equal(reboot.submissions.length, 0); assert.equal(reboot.get(id).runToken, original.runToken);
  assert.equal(reboot.get(id).dirPath, original.dirPath);
  assert(reboot.get(id).transfers.every(i => i.state === 'pending' && i.retryAt === deadline && !i.submissionLocked));
  reboot.advance(1000); await reboot.call('tickTask', id); await flush();
  assert.deepEqual(reboot.submissionBatches.map(xs => xs.length), [1, 1]);
  assert.deepEqual(reboot.submissions.map(i => i.filename), [a.filename, b.filename]);
  assert(reboot.get(id).transfers.every(i => i.accepted && !i.retryAt && !i.capacityRetries));
});

test('持续满队列按退避重试，超过下载失败次数上限仍不终止回传', async () => {
  let calls = 0;
  const e = await background({ submitBatch: async () => { calls++; throw capacityError(); } });
  e.server.mdc = [a]; const id = await start(e);
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    const item = e.get(id).transfers[0];
    assert.equal(item.retryAt - e.context.Date.now(), delay);
    const before = calls;
    e.advance(delay - 1); await e.call('tickTask', id); await flush(); assert.equal(calls, before);
    e.advance(1); await e.call('tickTask', id); await flush(); assert.equal(calls, before + 1);
    assert.equal(e.get(id).status, 'running'); assert.equal(e.get(id).transfers[0].state, 'pending');
    assert.equal(e.get(id).transfers[0].submissionLocked, false);
  }
  assert.equal(calls, 7); assert(e.get(id).transfers[0].attempts > 3);
});

test('升级自动释放旧版容量拒绝的锁，网络未知结果及已接受回传保持原锁', async () => {
  const e = await background(), t = await e.create(), c = catalog(3)[2];
  Object.assign(e.state.tasks[0], { status: 'running', runToken: 'original-run', discovered: true, searchReady: true,
    transfers: [
      { ...a, state: 'uncertain', attempts: 3, submissionLocked: true, batchId: 'legacy-full-batch', error: '请求待核对：/api/bag/mdcadd：车辆回传任务较多，请稍后再试' },
      { ...b, state: 'uncertain', attempts: 1, submissionLocked: true, submissionRejected: false, error: '请求待核对：/api/bag/mdcadd：车辆回传任务较多' },
      { ...c, state: 'submitted', attempts: 1, submissionLocked: true, accepted: true, error: '请求待核对：/api/bag/mdcadd：车辆回传任务较多' },
    ] });
  e.server.records = [{ record_no: 80, truck_no: 'WH-Truck05', break_source: 'mdc', breaktime: '2026-11-03 09:00',
    status: 'failed', remarks: '[BagFlowBatch:legacy-full-batch]', msg: '车辆回传任务较多' }];
  const reboot = await background({}, { state: e.state, server: e.server }); await flush();
  const restored = reboot.get(t.id);
  assert.equal(restored.transfers[0].state, 'pending'); assert.equal(restored.transfers[0].submissionLocked, false);
  assert.equal(restored.transfers[1].state, 'uncertain'); assert.equal(restored.transfers[1].submissionLocked, true);
  assert.equal(restored.transfers[2].state, 'submitted'); assert.equal(restored.transfers[2].accepted, true);
  assert.equal(reboot.submissions.length, 0); assert.equal(restored.runToken, 'original-run');
  reboot.advance(30000); await reboot.call('tickTask', t.id); await flush();
  assert.deepEqual(reboot.submissions.map(i => i.filename), [a.filename]);
  assert.equal(reboot.get(t.id).runToken, 'original-run');
});

test('旧容量报错批次已有部分精确记录时，只追加同分钟尚未接受的包', async () => {
  const e = await background(), t = await e.create();
  const second = { ...b, filename: b.filename.replace('09-01-00', '09-00-30'), create_time: '2026-11-03 09:00:30' };
  e.server.mdc = [a, second];
  Object.assign(e.state.tasks[0], { status: 'running', runToken: 'partial-run', discovered: true, searchReady: true,
    transfers: [a, second].map(i => ({ ...i, state: 'uncertain', attempts: 1, submissionLocked: true, batchId: 'partial-batch',
      error: '请求待核对：/api/bag/mdcadd：车辆回传任务较多' })) });
  e.server.records = [{ ...record(e.state.tasks[0], a, 99), remarks: '[BagFlowBatch:partial-batch]' }];
  const reboot = await background({}, { state: e.state, server: e.server }); await flush();
  assert.equal(reboot.get(t.id).transfers[0].accepted, true);
  assert.equal(reboot.get(t.id).transfers[1].state, 'pending');
  assert.equal(reboot.get(t.id).transfers[1].submissionLocked, false);
  reboot.advance(30000); await reboot.call('tickTask', t.id); await flush();
  assert.deepEqual(reboot.submissions.map(i => i.filename), [second.filename]);
  assert.equal(reboot.get(t.id).runToken, 'partial-run');
});

test('重试前已有精确服务器记录时恢复原回传，不因容量拒绝重新提交', async () => {
  let calls = 0;
  const e = await background({ submitBatch: async () => { calls++; throw capacityError(); } });
  e.server.mdc = [a]; const id = await start(e);
  e.server.records = [record(e.get(id), a, 99)];
  await e.call('tickTask', id); await flush();
  assert.equal(e.get(id).transfers[0].accepted, true); assert.equal(e.get(id).transfers[0].recordNo, 99);
  assert.equal(e.get(id).transfers[0].capacityRetries, undefined);
  e.server.records[0].status = 'failed'; e.server.records[0].msg = '服务器回传失败';
  e.advance(600000); await e.call('tickTask', id); await flush();
  assert.equal(calls, 1); assert.equal(e.get(id).transfers[0].state, 'server_failed');
});

test('容量冷却作用于同矿区同车其他任务，其他车辆和矿区继续提交', async () => {
  const calls = [], e = await background({
    trucks: async () => ['WH-Truck05', 'WH-Truck06'].map(value => ({ value, status: true, connect_msg: '车辆mdc在线，且NAS在线' })),
    submitBatch: async (t, items) => {
      calls.push({ mine: t.filters.mine_code, truck: t.filters.truck_no, names: items.map(i => i.filename) });
      if (t.filters.mine_code === 'WH' && t.filters.truck_no === 'WH-Truck05') throw capacityError();
    },
  });
  e.server.mdc = [a]; await start(e);
  e.server.mdc = [b]; const sameVehicle = await start(e); assert.equal(calls.length, 1);
  assert.equal(e.get(sameVehicle).transfers[0].state, 'pending');
  e.server.mdc = [{ ...catalog(3)[2], mine_code: 'OTHER' }]; await start(e, { mine_code: 'OTHER' });
  assert.equal(calls.length, 2); assert.equal(calls[1].mine, 'OTHER');
  e.server.mdc = [{ ...catalog(4)[3], truck_no: 'WH-Truck06' }]; await start(e, { truck_no: 'WH-Truck06' });
  assert.equal(calls.length, 3); assert.equal(calls[2].truck, 'WH-Truck06');
  e.advance(30000); await e.call('tickTask', sameVehicle); await flush();
  assert.equal(calls.length, 4); assert.deepEqual(calls[3].names, [b.filename]);
});

test('完成任务的旧容量冷却在时钟回拨后不阻塞同车新任务', async () => {
  const e = await background(), t = await e.create({ operations: { transfer: true, download: false } });
  Object.assign(e.state.tasks[0], { status: 'done', transferRetryAt: e.context.Date.now() + 300000,
    transfers: [{ ...a, state: 'done', accepted: true, submissionLocked: true }] });
  e.server.mdc = [b]; const id = await start(e);
  assert.deepEqual(e.submissions.map(i => i.filename), [b.filename]); assert.equal(e.get(id).transfers[0].accepted, true);
  assert.equal(e.get(t.id).status, 'done'); assert.equal(e.get(t.id).transferRetryAt, undefined);
});

test('同分钟已经公布其他文件名的活动记录不阻塞待回传包', async () => {
  const e = await background(); e.server.mdc = [a];
  e.server.records = [{ ...record({ filters: { truck_no: 'WH-Truck05' } }, a, 99), filename: 'other-file.bag' }];
  const id = await start(e);
  assert.deepEqual(e.submissions.map(i => i.filename), [a.filename]);
  assert.equal(e.get(id).transfers[0].accepted, true);
});

test('没有业务拒绝证据的相同报错和其他业务错误都不自动释放提交锁', async () => {
  for (const error of [new Error('/api/bag/mdcadd：车辆回传任务较多'), Object.assign(new Error('/api/bag/mdcadd：参数错误'), { rejected: true })]) {
    let calls = 0;
    const e = await background({ submitBatch: async () => { calls++; throw error; } });
    e.server.mdc = [a]; const id = await start(e);
    e.advance(600000); await e.call('tickTask', id); await flush();
    assert.equal(calls, 1); assert.equal(e.get(id).transfers[0].state, 'uncertain');
    assert.equal(e.get(id).transfers[0].submissionLocked, true);
  }
});

test('重试前服务器记录查询失败时继续核查，查询恢复后才能追加', async () => {
  let calls = 0;
  const e = await background({ submitBatch: async () => { if (++calls === 1) throw capacityError(); } });
  e.server.mdc = [a]; const id = await start(e);
  e.context.SiteAPI.records = async () => { throw Error('records offline'); };
  e.advance(30000); await e.call('tickTask', id); await flush();
  assert.equal(calls, 1); assert.match(e.get(id).transferError, /records offline/);
  e.context.SiteAPI.records = async () => []; await e.call('tickTask', id); await flush();
  assert.equal(calls, 2); assert.equal(e.get(id).transfers[0].accepted, true);
});

test('用户停止后才收到容量拒绝仍保持停止，重新执行后沿原任务重试', async () => {
  const gate = deferred(); let calls = 0;
  const e = await background({ submitBatch: async () => { calls++; await gate.promise; } });
  e.server.mdc = [a]; const id = await start(e);
  await e.call('stopTask', id); const stopped = e.get(id);
  gate.reject(capacityError()); await flush();
  assert.equal(e.get(id).status, 'stopped'); assert.equal(e.get(id).runToken, stopped.runToken);
  assert.equal(e.get(id).transfers[0].state, 'pending');
  e.advance(60000); await e.call('tickTask', id); await flush(); assert.equal(calls, 1);
  e.context.SiteAPI.submitBatch = async (t, items) => { calls++; for (const i of items) await e.context.SiteAPI.submit(t, i); };
  await e.call('execute', id); await flush();
  assert.equal(calls, 2); assert.equal(e.get(id).transfers[0].accepted, true);
});
