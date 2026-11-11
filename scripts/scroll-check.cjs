// 独立配置中的真实滚轮 + 进度更新验收；只使用本地 OPFS 和模拟队列。
const { chromium } = require(process.env.BAGFLOW_PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = process.env.BAGFLOW_EXTENSION_ROOT || path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bagflow-scroll-check-'));
let context;
async function main() {
  context = await chromium.launchPersistentContext(path.join(output, 'profile'), { channel: 'chromium', headless: true,
    ...(process.env.BAGFLOW_BROWSER_EXECUTABLE ? { executablePath: process.env.BAGFLOW_BROWSER_EXECUTABLE } : {}),
    ignoreDefaultArgs: ['--disable-extensions'], viewport: { width: 380, height: 1000 }, timezoneId: 'Asia/Shanghai',
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--proxy-server=http://127.0.0.1:9', '--disable-background-networking'] });
  const matches = w => w.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(matches) || await context.waitForEvent('serviceworker', { predicate: matches });
  await worker.evaluate(() => chrome.storage.local.set({ lookups: { at: Date.now(), mines: {}, types: {}, sources: [], reasons: [{ value: '01', name: '测试原因' }] } }));
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(worker.url().replace('background.js', 'popup.html')); await page.bringToFront();
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('bags', { create: true });
    await DirStore.put({ id: 'scroll-dir', name: 'bags', handle: dir });
    const { downloadSession } = await chrome.storage.session.get('downloadSession');
    const tasks = Array.from({ length: 6 }, (_, k) => ({ id: `scroll-${k}`, name: `WH-Truck0${k + 1} · Perception`, kind: 'transfer',
      filters: { truck_no: `WH-Truck0${k + 1}`, mine_code: 'WH', bag_type: 'Perception', break_source: 'mdc' }, strictFilenameTime: true,
      status: 'running', runToken: `run-${k}`, localVerificationOnly: true, searchReady: false, dirId: 'scroll-dir', dirPath: '/fixture/bags', dirName: 'bags',
      start: '2026-11-05 09:00:00', end: '2026-11-05 10:00:00', createdAt: Date.now() - k, events: [{ at: Date.now(), message: '滚动验收' }],
      items: Array.from({ length: 160 }, (_, n) => { const time = BagCore.localTime(new Date(2026, 10, 5, 9, 0, n)); return {
        filename: `Perception_${time.replaceAll(' ', '-').replaceAll(':', '-')}_${n}.bag`, create_time: time, dirpath: `/fixture/${k}/${n}.bag`,
        state: n ? 'pending' : 'downloading', bytes: 0, totalBytes: 1048576, attempts: 0, validationSession: downloadSession,
        jobId: n ? null : `fixture-job-${k}`, phaseAt: Date.now() + 1000000 }; }), transfers: [] }));
    for (const t of tasks) t.transfers = t.items.map(i => ({ ...i, state: 'submitted', jobId: null, attempts: 1, submissionLocked: true }));
    await chrome.storage.local.set({ tasks, dirs: [{ id: 'scroll-dir', name: 'bags', displayPath: '/fixture/bags' }], lastDirId: 'scroll-dir',
      taskExpansion: Object.fromEntries(tasks.map(t => [t.id, true])), setupExpanded: false });
  });
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 6 && document.querySelectorAll('.bags').length === 12);
  const list = page.locator('[data-list="scroll-0:download"]'); await list.scrollIntoViewIfNeeded();
  await page.locator('[data-id="scroll-0"] .task-more').evaluate(el => { el.open = true; });
  await list.scrollIntoViewIfNeeded(); await list.evaluate(el => { el.scrollTop = 400; });
  const rect = await list.boundingBox(); await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.evaluate(() => {
    window.scrollProbe = { list: document.querySelector('[data-list="scroll-0:download"]'), task: document.querySelector('[data-id="scroll-0"]'),
      unrelated: document.querySelector('[data-id="scroll-1"]'), removedScrollers: 0, renderTimes: [], frames: [], measuring: true };
    const original = renderTasks;
    renderTasks = function() { const start = performance.now(); original(); if (scrollProbe.measuring) scrollProbe.renderTimes.push(performance.now() - start); };
    const observer = new MutationObserver(records => { for (const r of records) for (const node of r.removedNodes) {
      if (node.nodeType === 1) scrollProbe.removedScrollers += Number(node.matches('.bags')) + node.querySelectorAll('.bags').length;
    } }); observer.observe(document.querySelector('#tasks'), { childList: true, subtree: true }); scrollProbe.observer = observer;
    let previous; function frame(now) { if (!scrollProbe.measuring) return; if (previous) scrollProbe.frames.push(now - previous); previous = now; requestAnimationFrame(frame); } requestAnimationFrame(frame);
  });
  for (let n = 0; n < 24; n++) {
    await page.evaluate(async n => { const { tasks } = await chrome.storage.local.get('tasks'); tasks[0].items[0].bytes = (n + 1) * 20000;
      tasks[0].message = `下载进度 ${n + 1}`; await chrome.storage.local.set({ tasks }); }, n);
    await page.mouse.wheel(0, n < 12 ? 100 : -100); await page.waitForTimeout(55);
  }
  await page.waitForFunction(() => document.querySelector('[data-list="scroll-0:download"] .bag-detail').textContent.includes('0.5 MB'));
  const report = await page.evaluate(() => {
    scrollProbe.measuring = false; scrollProbe.observer.disconnect();
    const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { samples: values.length,
      median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: Math.max(...values) }; };
    return { taskRetained: scrollProbe.task === document.querySelector('[data-id="scroll-0"]'), listRetained: scrollProbe.list === document.querySelector('[data-list="scroll-0:download"]'),
      unrelatedRetained: scrollProbe.unrelated === document.querySelector('[data-id="scroll-1"]'), removedScrollers: scrollProbe.removedScrollers,
      detailsOpen: document.querySelector('[data-id="scroll-0"] .task-more').open, renderMs: summary(scrollProbe.renderTimes), frameMs: summary(scrollProbe.frames),
      scrollTop: document.querySelector('[data-list="scroll-0:download"]').scrollTop };
  });
  if (!process.argv.includes('--report-only')) {
    assert(report.taskRetained); assert(report.listRetained); assert(report.unrelatedRetained); assert.equal(report.removedScrollers, 0); assert(report.detailsOpen);
    // 分页时仍复用同一个容器，主动翻页回到顶部。
    await page.locator('[data-id="scroll-0"] [data-act="bag-page"][data-phase="download"][data-page="1"]').click();
    await page.waitForFunction(() => document.querySelector('[data-list="scroll-0:download"]').dataset.page === '1');
    assert(await page.evaluate(() => scrollProbe.list === document.querySelector('[data-list="scroll-0:download"]')));
    assert.equal(await list.evaluate(el => el.scrollTop), 0);
    // 已完成任务的执行和停止均禁用。
    await page.evaluate(async () => { const { tasks } = await chrome.storage.local.get('tasks'); tasks[0].status = 'done';
      for (const i of tasks[0].items) { i.state = 'done'; i.jobId = null; } for (const i of tasks[0].transfers) i.state = 'done'; await chrome.storage.local.set({ tasks }); });
    await page.waitForFunction(() => document.querySelector('[data-id="scroll-0"] [data-act="stop"]').disabled);
    assert(await page.locator('[data-id="scroll-0"] [data-act="execute"]').isDisabled());
    assert(await page.locator('[data-id="scroll-0"] [data-act="stop"]').isDisabled());
    assert.deepEqual(errors, []);
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); console.log('滚动验收记录: ' + output);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (context) await context.close(); });
