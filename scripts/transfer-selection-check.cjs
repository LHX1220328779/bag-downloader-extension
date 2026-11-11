// 用隔离 Chromium 验证按钮的用户选择，所有服务器请求由本地夹具处理。
const { chromium } = require(process.env.BAGFLOW_PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'bagflow-transfer-selection-'));
const id = 'selection-check-task', requests = [], records = [0, 1].map(n => ({ record_no: n + 11,
  truck_no: 'WH-Truck05', mine_code: 'WH', break_source: 'mdc', status: 'downloading', percentage: 23,
  filename: `Perception_2026-11-03-09-0${n}-00_${n}.bag`, remarks: `[BagFlowTask:${id}]` }));
let context, extensionRoot, pauseFailures = 0;
const json = (res, data, code = 20000, message = '') => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, data, message })); };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture.invalid').pathname, chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ pathname, method: req.method });
  const command = pathname.match(/^\/api\/break\/(pause|cancelpause)\/(\d+)$/);
  if (command) {
    assert.equal(req.method, 'POST'); assert.equal(chunks.length, 0);
    if (command[1] === 'pause' && pauseFailures) { pauseFailures--; return json(res, null, 4000, 'fixture pause unavailable'); }
    const row = records.find(r => String(r.record_no) === command[2]);
    if (!row) return json(res, null, 4000, 'fixture record missing');
    row.status = command[1] === 'pause' ? 'pause' : 'cancelpause'; return json(res, 'ok', 2000);
  }
  if (pathname === '/api/break/search') return json(res, records);
  if (pathname === '/api/truck/info') return json(res, [{ value: 'WH-Truck05', status: false, connect_msg: 'fixture vehicle offline' }]);
  if (pathname === '/api/bag/search') return json(res, []);
  if (pathname.startsWith('/api/bag/progress/')) return json(res, 23, 2000);
  const lookups = { '/api/truck/mine_list': [{ value: 'WH', name: '芜湖' }], '/api/truck/type_list': [{ value: 'Perception', name: '感知' }],
    '/api/truck/source_list': [{ value: 'mdc', name: 'mdc' }], '/api/bag/use_class': [{ value: '01', name: '问题分析' }] };
  if (lookups[pathname]) return json(res, lookups[pathname], 200);
  res.writeHead(404); res.end();
});
async function launch() {
  context = await chromium.launchPersistentContext(path.join(output, 'profile'), { headless: true,
    executablePath: process.env.BAGFLOW_BROWSER_EXECUTABLE || chromium.executablePath(),
    ignoreDefaultArgs: ['--disable-extensions'], viewport: { width: 380, height: 1000 }, locale: 'zh-CN',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', `--disable-extensions-except=${root}`, `--load-extension=${root}`, `--proxy-server=http://127.0.0.1:${server.address().port}`] });
  const worker = context.serviceWorkers().find(w => w.url().endsWith('/background.js')) || await context.waitForEvent('serviceworker');
  extensionRoot ||= worker.url().replace(/background\.js$/, '');
  const page = await context.newPage(); page.on('pageerror', e => { throw e; }); await page.goto(extensionRoot + 'popup.html');
  await page.waitForFunction(() => typeof renderTasks === 'function' && !loading); return { worker, page };
}
const state = page => page.evaluate(() => chrome.storage.local.get(['tasks', 'taskTransferSelections']));
async function wait(page, predicate) {
  for (let n = 0; n < 250; n++) { const s = await state(page); if (predicate(s)) return s; await page.waitForTimeout(20); }
  throw Error('选择状态超时: ' + JSON.stringify(await state(page)));
}
async function settle(worker, page, enabled) {
  await worker.evaluate(id => reconcileTransferControl(id, true), id);
  return wait(page, s => s.tasks[0]?.transferEnabled === enabled && s.tasks[0]?.transferControl?.phase === 'settled');
}
async function seed(page) {
  await page.evaluate(async ({ id, records }) => {
    const task = { id, kind: 'transfer', operations: { transfer: true, download: false }, transferEnabled: true, transferControlRevision: 0,
      filters: { truck_no: 'WH-Truck05', mine_code: 'WH', bag_type: 'Perception', break_source: 'mdc' }, name: '选择持久化验证',
      start: '2026-11-03 09:00:00', end: '2026-11-03 09:02:00', status: 'stopped', runToken: 'preserved-run',
      coverageMode: 'legacy', dirId: 'slow-dir', dirPath: 'D:\\数据\\车辆05\\rtfbag', items: [], events: [], createdAt: Date.now(),
      transfers: records.map(r => ({ key: BagCore.fileKey({ filename: r.filename }), filename: r.filename, recordNo: r.record_no,
        state: 'submitted', accepted: true, submissionLocked: true, attempts: 1, submittedAt: Date.now(), percentage: 23 })) };
    await chrome.storage.local.set({ tasks: [task], dirs: [], taskTransferSelections: {}, setupExpanded: false }); await load();
  }, { id, records });
  await page.waitForFunction(id => document.querySelector(`[data-id="${id}"] [data-act="transfer"]`)?.getAttribute('aria-pressed') === 'true', id);
}
async function slowLoadRace(worker, page) {
  await page.evaluate(() => {
    window.slowDirectory = true; window.slowReads = []; window.previousGetDirectory = DirStore.get;
    DirStore.get = async id => { if (id === 'slow-dir' && slowDirectory) await new Promise(resolve => slowReads.push(resolve)); return previousGetDirectory(id); };
  });
  await worker.evaluate(id => setTransferEnabled(id, false), id);
  await page.waitForFunction(id => tasks.find(t => t.id === id)?.transferEnabled === false && slowReads.length > 0 &&
    document.querySelector(`[data-id="${id}"] [data-act="transfer"]`).getAttribute('aria-pressed') === 'true', id);
  // 保持这次保存请求等待，避免本地夹具过快确认导致加载截图提前结束。
  await page.evaluate(() => {
    window.selectionOriginalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.selectionGate = new Promise(resolve => { window.releaseSelection = resolve; });
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'transfer:set') await selectionGate;
      return selectionOriginalSend(message);
    };
  });
  const immediate = await page.evaluate(id => { const button = document.querySelector(`[data-id="${id}"] [data-act="transfer"]`), card = button.closest('.task');
    const width = button.getBoundingClientRect().width, height = card.getBoundingClientRect().height, idleColor = getComputedStyle(button).color;
    button.click();
    return { requestId: pendingTransferChoices.get(id)?.requestId, pressed: button.getAttribute('aria-pressed'), busy: button.getAttribute('aria-busy'), spinner: button.querySelectorAll('svg.transfer-spinner').length,
      widthChange: button.getBoundingClientRect().width - width, heightChange: card.getBoundingClientRect().height - height,
      idleColor, busyColor: getComputedStyle(button).color, visibleNotes: card.querySelectorAll('.transfer-control-note').length }; }, id);
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [300, 380, 720]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.evaluate(() => {
        const button = document.querySelector('[data-act="transfer"]'), card = button.closest('.task');
        const actions = [...card.querySelectorAll('.actions > button')].map(b => b.getBoundingClientRect());
        const style = getComputedStyle(button), status = card.querySelector('.transfer-status')?.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, sameRow: new Set(actions.map(r => r.top)).size === 1,
          actionOverflow: actions.some(r => r.x < 0 || r.right > innerWidth), background: style.backgroundColor,
          statusHeight: status?.height || 0, spinner: button.querySelectorAll('svg.transfer-spinner').length, disabled: button.disabled };
      });
      assert(!layout.overflow && !layout.actionOverflow && layout.sameRow, '加载时所有操作按钮应在可见范围内同一行');
      assert(layout.statusHeight <= 1, '常规回传状态应仅供辅助技术读取，不占视觉空间');
      const alpha = Number(layout.background.match(/,\s*([\d.]+)\)$/)?.[1]);
      assert(alpha > 0 && alpha < .08, '明暗主题的加载按钮均使用淡色背景');
      assert.equal(layout.spinner, 1); assert.equal(layout.disabled, false, '等待期间仍可改变回传选择');
      await page.screenshot({ path: path.join(output, `busy-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  assert.equal(await page.locator('.transfer-spinner').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.setViewportSize({ width: 380, height: 1000 });
  await page.evaluate(() => {
    chrome.runtime.sendMessage = selectionOriginalSend; releaseSelection();
    slowDirectory = false; slowReads.splice(0).forEach(resolve => resolve());
  });
  await wait(page, s => s.taskTransferSelections[id]?.requestId === immediate.requestId);
  await page.waitForFunction(() => !loading);
  const result = await state(page);
  if (process.argv.includes('--reproduce-old-race')) {
    console.log(JSON.stringify({ immediate, saved: result.tasks[0].transferEnabled, records: records.map(r => r.status) }));
    assert.equal(result.tasks[0].transferEnabled, false, '可见勾选为开启时点击应关闭，不能被异步任务快照反向开启');
  }
  assert.equal(immediate.pressed, 'false', '点击必须立即取消勾选'); assert.equal(immediate.busy, 'true'); assert.equal(immediate.spinner, 1);
  assert(Math.abs(immediate.widthChange) < 1, '加载时按钮宽度应保持稳定');
  assert(Math.abs(immediate.heightChange) < 1, '常规回传状态不应新增卡片行高');
  assert.notEqual(immediate.busyColor, immediate.idleColor, '等待时按钮使用柔和颜色'); assert.equal(immediate.visibleNotes, 0);
  await settle(worker, page, false);
  await page.waitForFunction(id => document.querySelector(`[data-id="${id}"] [data-act="transfer"]`).getAttribute('aria-pressed') === 'false', id);
  await page.waitForFunction(id => document.querySelector(`[data-id="${id}"] [data-act="transfer"]`).getAttribute('aria-busy') === 'false', id);
  assert.equal(await page.locator('.transfer-spinner').count(), 0);
  assert.equal(await page.locator('.transfer-control-note').count(), 0, '服务器确认后不显示占位状态文字');
}
async function sharedRecordConfirmation(worker, page) {
  const shared = { record_no: 13, truck_no: 'WH-Truck05', mine_code: 'WH', break_source: 'mdc', task_type: 'Perception',
    filename: 'Perception_2026-11-03-09-00-30_shared.bag', create_time: '2026-11-03 09:00:30',
    remarks: '[BagFlowTask:other-task]', status: 'waiting' };
  records.push(shared);
  await page.evaluate(async shared => {
    const { tasks } = await chrome.storage.local.get('tasks'), t = tasks[0];
    t.transfers.push({ key: BagCore.fileKey(shared), filename: shared.filename, create_time: shared.create_time, recordNo: shared.record_no,
      state: 'submitted', accepted: true, submissionLocked: true, attempts: 1, submittedAt: 0, batchId: null });
    t.transferControl = { ...t.transferControl, phase: 'waiting', awaitingRecords: 1, nextCheckAt: Date.now() + 60000 };
    await chrome.storage.local.set({ tasks }); await load();
  }, shared);
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-busy'), 'true');
  await settle(worker, page, true);
  await page.waitForFunction(() => document.querySelector('[data-act="transfer"]').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('.transfer-spinner').count(), 0);
  assert.equal(await page.locator('.transfer-control-note').count(), 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-act="transfer"]')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-act="transfer"]').click(); await settle(worker, page, false);
  await page.locator('[data-act="transfer"]').click(); await settle(worker, page, true);
  assert.equal(shared.status, 'waiting');
  assert(!requests.some(r => /\/api\/break\/(pause|cancelpause)\/13$/.test(r.pathname)), '共享回传只能复用结果，不能取得控制权');
  // 真正在途的本任务提交仍显示加载，服务器返回对应原记录后才结束确认。
  const inflight = { filename: 'Perception_2026-11-03-09-01-30_inflight.bag', create_time: '2026-11-03 09:01:30', record_no: 14,
    truck_no: 'WH-Truck05', mine_code: 'WH', break_source: 'mdc', remarks: `[BagFlowTask:${id}]`, status: 'cancelpause' };
  await page.evaluate(async inflight => {
    const { tasks } = await chrome.storage.local.get('tasks'), t = tasks[0];
    t.transfers.push({ key: BagCore.fileKey(inflight), filename: inflight.filename, create_time: inflight.create_time, state: 'submitting',
      accepted: false, submissionLocked: true, attempts: 1, submittedAt: Date.now(), batchId: 'inflight-local-batch' });
    t.transferControl.nextCheckAt = 0;
    await chrome.storage.local.set({ tasks });
  }, inflight);
  await worker.evaluate(id => reconcileTransferControl(id, true), id);
  await page.evaluate(() => load());
  assert.equal((await state(page)).tasks[0].transferControl.awaitingRecords, 1);
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-busy'), 'true');
  records.push(inflight); await settle(worker, page, true);
  await page.waitForFunction(() => document.querySelector('[data-act="transfer"]').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('.transfer-spinner').count(), 0);
  await page.screenshot({ path: path.join(output, 'shared-records-confirmed.png'), fullPage: true });
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let { worker, page } = await launch(); await seed(page); await slowLoadRace(worker, page);
  assert(records.every(r => r.status === 'pause')); assert.deepEqual(records.map(r => r.record_no), [11, 12]);
  // 旧进度快照甚至丢掉开关字段时，独立用户选择仍保持关闭。
  await page.evaluate(async () => {
    const { tasks } = await chrome.storage.local.get('tasks'); const old = structuredClone(tasks);
    for (const t of old) { delete t.transferEnabled; delete t.transferControlRevision; delete t.transferControl; }
    await chrome.storage.local.set({ tasks: old }); await load();
  });
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-pressed'), 'false');
  await settle(worker, page, false); assert(records.every(r => r.status === 'pause'));
  // 多轮后台心跳和浏览器关闭重开均不能改变用户选择。
  await worker.evaluate(async () => { const original = Date.now; let offset = 0; Date.now = () => original() + offset;
    try { for (let n = 0; n < 6; n++) { offset += 60000; await reconcileTransferControl('selection-check-task'); await reconcile(); } }
    finally { Date.now = original; } });
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-pressed'), 'false');
  await context.close(); context = null; ({ worker, page } = await launch());
  await page.waitForFunction(() => document.querySelector('[data-act="transfer"]')?.getAttribute('aria-pressed') === 'false');
  // 开启后恢复原记录，快速点击立即表现当前用户选择。
  const immediate = await page.evaluate(() => { const b = document.querySelector('[data-act="transfer"]'); b.click(); return b.getAttribute('aria-pressed'); });
  assert.equal(immediate, 'true'); await settle(worker, page, true); assert(records.every(r => r.status === 'cancelpause'));
  await page.waitForFunction(() => [...document.querySelectorAll('.bag-detail')].length === 2 &&
    [...document.querySelectorAll('.bag-detail')].every(el => el.textContent.includes('等待回传')));
  assert.deepEqual(records.map(r => r.record_no), [11, 12]);
  pauseFailures = 2; await page.locator('[data-act="transfer"]').click();
  await wait(page, s => s.tasks[0]?.transferControl?.phase === 'retry');
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-pressed'), 'false');
  await page.waitForFunction(() => document.querySelector('[data-act="transfer"]').getAttribute('aria-busy') === 'false');
  await page.screenshot({ path: path.join(output, 'pause-retry.png'), fullPage: true });
  pauseFailures = 0;
  await worker.evaluate(id => { const original = Date.now; Date.now = () => original() + 300000;
    return reconcileTransferControl(id, true).finally(() => { Date.now = original; }); }, id);
  await settle(worker, page, false); assert(records.every(r => r.status === 'pause'));
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-pressed'), 'false');
  // 页面文件更新而后台仍不支持开关时，不能假报保存或反向恢复选择。
  await page.evaluate(() => { window.originalSelectionSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => message.type === 'transfer:set' ? { ok: false, error: '未知指令' } : originalSelectionSend(message); });
  await page.locator('[data-act="transfer"]').click();
  await page.waitForFunction(() => document.querySelector('.transfer-control-note')?.textContent.includes('插件后台尚未更新'));
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-act="transfer"]').getAttribute('aria-busy'), 'false');
  assert.equal((await state(page)).taskTransferSelections[id].enabled, false, '旧后台失败不能假报选择已保存');
  assert(records.every(r => r.status === 'pause'), '未被后台接受的恢复不能误报服务器已恢复');
  await page.screenshot({ path: path.join(output, 'version-mismatch.png'), fullPage: true });
  await page.evaluate(() => { chrome.runtime.sendMessage = originalSelectionSend; });
  await page.locator('[data-act="transfer"]').click(); await settle(worker, page, false);
  await page.waitForFunction(() => !document.querySelector('.transfer-control-note')?.textContent.includes('尚未更新'));
  await page.screenshot({ path: path.join(output, 'paused.png'), fullPage: true });
  // 旧任务已绑定原编号与批次，但服务器备注丢失；车辆离线也必须恢复原记录。
  for (const r of records) { r.msg = `同步失败:['${r.filename}任务暂停']`; r.remarks = ''; delete r.filename; }
  await page.evaluate(async () => {
    const { tasks } = await chrome.storage.local.get('tasks'), t = tasks[0];
    t.status = 'waiting_vehicle'; t.vehicleOnline = false; t.discovered = true; t.searchReady = true;
    t.transferControlRecords = []; t.transferBatchIds = ['offline-legacy-batch'];
    for (const i of t.transfers) { i.batchId = 'offline-legacy-batch'; i.serverStatus = 'pause'; i.error = '服务器已暂停，持续核查'; }
    await chrome.storage.local.set({ tasks }); await load();
  });
  const beforeResume = requests.length;
  await page.locator('[data-act="transfer"]').click(); await settle(worker, page, true);
  await page.waitForFunction(() => tasks[0]?.status === 'waiting_vehicle' &&
    [...document.querySelectorAll('.bag-detail')].every(el => el.textContent.includes('等待回传')));
  await page.waitForFunction(() => document.querySelector('[data-act="transfer"]').getAttribute('aria-busy') === 'false');
  if (await page.locator('.task-fold').getAttribute('open') === null) await page.locator('.task-top').click();
  assert(records.every(r => r.status === 'cancelpause'));
  assert.equal(requests.slice(beforeResume).filter(r => r.pathname.startsWith('/api/break/cancelpause/')).length, 2);
  assert.equal(await page.locator('.transfer-control-note').count(), 0);
  assert.equal(await page.locator('.bags .error-text').count(), 0, '解除暂停后必须清除每包的旧暂停提示');
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: path.join(output, `offline-restored-${theme}.png`), fullPage: true });
  }
  await sharedRecordConfirmation(worker, page);
  const final = await state(page); assert.equal(final.tasks[0].runToken, 'preserved-run'); assert.equal(final.tasks[0].dirPath, 'D:\\数据\\车辆05\\rtfbag');
  assert.equal(final.tasks[0].vehicleOnline, false); assert.equal(final.tasks[0].transferEnabled, true);
  assert(!requests.some(r => /\/api\/break\/remove|\/api\/bag\/mdcadd/.test(r.pathname)), '暂停恢复不能删除或重建原回传');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, requests, records, final }, null, 2));
  console.log('选择与离线恢复验收通过：共享回传不误报在途提交，确认后结束加载，真实在途仍待确认；旧任务备注缺失、原记录恢复及暂停提示清除；即时勾选、淡色圆弧、六种布局、竞态、心跳、重开、失败及版本不一致。\n' + output);
}
main().catch(e => { console.error(e); console.error(output); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close(); server.closeAllConnections(); server.close();
});
