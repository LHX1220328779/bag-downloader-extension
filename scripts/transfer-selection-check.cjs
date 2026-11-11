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
  const immediate = await page.evaluate(id => { const button = document.querySelector(`[data-id="${id}"] [data-act="transfer"]`); button.click();
    return { pressed: button.getAttribute('aria-pressed'), busy: button.getAttribute('aria-busy'), spinner: button.querySelectorAll('.transfer-spinner').length }; }, id);
  await page.evaluate(() => { slowDirectory = false; slowReads.splice(0).forEach(resolve => resolve()); });
  await page.waitForFunction(() => !loading);
  const result = await state(page);
  if (process.argv.includes('--reproduce-old-race')) {
    console.log(JSON.stringify({ immediate, saved: result.tasks[0].transferEnabled, records: records.map(r => r.status) }));
    assert.equal(result.tasks[0].transferEnabled, false, '可见勾选为开启时点击应关闭，不能被异步任务快照反向开启');
  }
  assert.equal(immediate.pressed, 'false', '点击必须立即取消勾选'); assert.equal(immediate.busy, 'true'); assert.equal(immediate.spinner, 1);
  await settle(worker, page, false);
  await page.waitForFunction(id => document.querySelector(`[data-id="${id}"] [data-act="transfer"]`).getAttribute('aria-pressed') === 'false', id);
  await page.waitForFunction(id => document.querySelector(`[data-id="${id}"] [data-act="transfer"]`).getAttribute('aria-busy') === 'false', id);
  assert.equal(await page.locator('.transfer-spinner').count(), 0);
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
  const final = await state(page); assert.equal(final.tasks[0].runToken, 'preserved-run'); assert.equal(final.tasks[0].dirPath, 'D:\\数据\\车辆05\\rtfbag');
  assert(!requests.some(r => /\/api\/break\/remove|\/api\/bag\/mdcadd/.test(r.pathname)), '暂停恢复不能删除或重建原回传');
  await page.screenshot({ path: path.join(output, 'paused.png'), fullPage: true });
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, requests, records, final }, null, 2));
  console.log('选择持久化验收通过：立即勾选/取消、刷新标识、异步加载竞态、旧快照覆盖、心跳、重开、失败保持及后台版本不一致；仅暂停恢复原回传。\n' + output);
}
main().catch(e => { console.error(e); console.error(output); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close(); server.closeAllConnections(); server.close();
});
