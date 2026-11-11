// 可选的真实浏览器验收：需要外部安装 playwright-core 和 Chromium，扩展本身没有此依赖。
// 全部站点请求经过本地夹具代理，不访问真实车辆/文件服务，不修改用户浏览器配置。
const { chromium } = require(process.env.BAGFLOW_PLAYWRIGHT_MODULE || 'playwright-core');
const offscreenContext = require('./offscreen-context.cjs');
const browserExecutable = process.env.BAGFLOW_BROWSER_EXECUTABLE || chromium.executablePath();
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..'), output = fs.mkdtempSync(path.join(os.tmpdir(), 'bagflow-browser-check-'));
const profile = path.join(output, 'profile');
const browserFiles = path.join(output, 'browser-downloads');
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true }); fs.mkdirSync(browserFiles);
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: browserFiles, prompt_for_download: false } }));
const huainingFixture = require('../tests/fixtures/huaining-range.json');
const downloadUiAudits = [];
const actualBoundaryRows = require('../tests/fixtures/kushan-boundary.json');
const actualHeader = fs.readFileSync(path.join(root, 'tests/fixtures/kushan-39-header.bin'));
const actualTail = actualBoundaryRows.find(r => r.filename.endsWith('_39.bag'));
const filters = { truck_no: 'WH-Truck05', mine_code: 'WH', bag_type: 'Perception', break_source: 'mdc' };
const filename = (sec) => `Perception_wuhu_05_ConchPilot6.1_2026.10.08_hotfix_2026-11-05-09-00-${sec}_${sec === '01' ? 1 : 2}.bag`;
const files = ['01', '59'].map((sec, i) => ({ ...filters, filename: filename(sec), create_time: `2026-11-05 09:00:${sec}`,
  filesize: 0.01, dirpath: `/fixture/${i}.bag` }));
const boundary = { ...files[1], filename: files[1].filename.replace('09-00-59_2', '09-01-00_3'), dirpath: '/fixture/2.bag' };
let catalogRows = [...files,boundary];
let available = false, online = true, truncated = true, records = [], context, requests = [], batches = [];
let transferCapacity = null;
let transferCommandFailures = 0, holdTransferCommands = false;
const heldTransferCommands = [];
let holdMdc = false, heldMdc = [], mdcOverride = null;
const mdcRows = () => [...(mdcOverride || catalogRows)].reverse().map(f => ({ ...f, create_time:'2026-11-05 16:19:06' }));
let holdBrowser = false, browserHeld = false, browserMode = false;
const heldBrowserResponses = [];
let nativeBrowser = false, connectedBrowser, chromeProcess, targetExtensionRoot;
const json = (res, data, code = 20000, message) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, data, ...(message ? { message } : {}) })); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.invalid'), chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  requests.push({ method: req.method, path: url.pathname, body, bodyBytes: chunks.reduce((n, chunk) => n + chunk.length, 0), ...(req.headers.range ? { range:req.headers.range } : {}) });
  const transferMatch = url.pathname.match(/^\/api\/break\/(pause|cancelpause)\/([A-Za-z0-9_-]+)$/);
  if (transferMatch) {
    assert.equal(req.method, 'POST'); assert.equal(chunks.length, 0, '暂停恢复没有业务请求体');
    if (transferCommandFailures > 0) { transferCommandFailures--; return json(res, null, 4000, 'fixture transfer temporarily unavailable'); }
    const apply = () => {
      const record = records.find(r => String(r.record_no) === transferMatch[2]);
      if (!record) return json(res, null, 4000, 'fixture record missing');
      if (transferMatch[1] === 'pause' && record.status !== 'succeed') record.status = 'pause';
      if (transferMatch[1] === 'cancelpause' && record.status === 'pause') record.status = 'cancelpause';
      return json(res, 'ok', transferMatch[1] === 'pause' ? 2000 : 20000);
    };
    if (holdTransferCommands) { heldTransferCommands.push(apply); return; }
    return apply();
  }
  if(url.pathname === '/recording-header'){
    if(req.headers.range !== 'bytes=0-4095'){res.writeHead(416);return res.end();}
    res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':actualHeader.length,'Content-Range':`bytes 0-${actualHeader.length-1}/719885925`});return res.end(actualHeader);
  }
  if (url.pathname.startsWith('/files/')) {
    const n = Number(url.pathname.split('/')[2]), bytes = n && browserMode ? Buffer.alloc(8192, 2) : Buffer.from(n ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4]);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    if (req.method === 'HEAD') return res.end();
    if (n === 1 && holdBrowser) { browserHeld = true; res.write(bytes.subarray(0, 4096)); heldBrowserResponses.push({res,bytes}); return; }
    if (n === 1 && truncated) { res.write(bytes.subarray(0, 4)); setTimeout(() => res.destroy(), 60); return; }
    return res.end(bytes);
  }
  switch (url.pathname) {
    case '/api/truck/mine_list': return json(res, [{ value: 'WH', name: '芜湖' }], 200);
    case '/api/truck/type_list': return json(res, [{ value: 'Perception', name: '感知包' }], 200);
    case '/api/truck/source_list': return json(res, [{ value: 'mdc', name: 'mdc' }], 200);
    case '/api/bag/use_class': return json(res, [{ value: '01', name: '问题分析' }, { value: '02', name: '日常数据采集' }], 200);
    case '/api/truck/info': return json(res, [{ value: body.mine_code === 'HNMZ' ? huainingFixture.filters.truck_no : filters.truck_no, status: online, connect_msg: online ? 'MDC、NAS 在线' : '测试车辆离线' }]);
    case '/api/bag/search': return json(res, available ? catalogRows : []);
    case '/api/bag/mdcsearch': if(holdMdc){heldMdc.push(res);return;} return json(res,mdcRows(),2000);
    case '/api/break/search': return json(res, records);
    case '/api/bag/mdcadd':
      batches.push(body);
      if (transferCapacity !== null) {
        const occupied = records.filter(r => ['waiting', 'downloading', 'pause', 'cancelpause'].includes(r.status)).length;
        if (occupied + body.filename.length > transferCapacity) return json(res, null, 4000, '车辆回传任务较多，请稍后再试');
        const base = records.length;
        records.push(...body.filename.map((name, n) => ({ filename: name, truck_no: body.truck_no[n],
          break_source: 'mdc', status: 'waiting', record_no: base + n + 1, remarks: body.remarks })));
        return json(res, 'ok', 2000);
      }
      records = body.filename.map((name, n) => ({ filename: name, truck_no: body.truck_no[n],
        break_source: 'mdc', status: 'waiting', record_no: 1 + n, remarks: body.remarks }));
      return json(res, 'ok', 2000);
    case '/api/bag/download': if(body.dirpath===actualTail.dirpath)return json(res,'http://10.198.92.173:8099/recording-header'); return json(res, `http://10.198.92.173:8099/files/${body.dirpath.match(/(\d+)\.bag$/)[1]}`);
    case '/table': case '/search': case '/mdc':
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><body><div id="app">筛选页面夹具</div><script>
        const form={truck_no:'WH-Truck05',mine:'WH',type:'Perception',break_source:'mdc'};
        document.querySelector('#app').__vue__={$children:[{form}]};
      </script></body></html>`);
    default: res.writeHead(404); return res.end();
  }
});
async function installUiAudit(worker) {
  await worker.evaluate(async () => {
    if(globalThis.downloadUiAudit)return;
    const held=(await load()).some(t=>active(t)&&t.downloadBackend==='browser'&&t.items.some(i=>i.jobId))||(await chrome.storage.local.get('browserLocationProbe')).browserLocationProbe;
    const audit=globalThis.downloadUiAudit={enabled:!held,events:[]},ui=chrome.downloads.setUiOptions.bind(chrome.downloads),download=chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.setUiOptions=async options=>{await ui(options);audit.enabled=options.enabled;audit.events.push({kind:'ui',enabled:options.enabled});};
    chrome.downloads.download=async options=>{audit.events.push({kind:'download',probe:options.url.startsWith('data:application/octet-stream,bagflow-'),enabled:audit.enabled});return download(options);};
    chrome.downloads.onChanged.addListener(delta=>{if(delta.state?.current==='complete'){const enabled=audit.enabled;chrome.downloads.search({id:delta.id}).then(([d])=>{if(d?.byExtensionId===chrome.runtime.id)audit.events.push({kind:'complete',probe:d.url.startsWith('data:application/octet-stream,bagflow-'),enabled});});}});
  });
}
async function collectUiAudit(){
  const worker=context?.serviceWorkers().find(w=>w.url()===targetExtensionRoot+'background.js');
  if(worker)downloadUiAudits.push(...await worker.evaluate(()=>globalThis.downloadUiAudit?.events.splice(0)||[]));
}
async function launch() {
  if (nativeBrowser) {
    const portFile = path.join(profile, 'DevToolsActivePort'); fs.rmSync(portFile, { force: true });
    chromeProcess = spawn(browserExecutable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--lang=zh-CN', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      `--disable-extensions-except=${root}`, `--load-extension=${root}`, `--proxy-server=http://127.0.0.1:${server.address().port}`,
      '--disable-background-networking'], { stdio: 'ignore' });
    for (let n = 0; n < 200 && !fs.existsSync(portFile); n++) await new Promise(r => setTimeout(r, 50));
    if (!fs.existsSync(portFile)) throw Error('原生浏览器启动失败');
    const [debugPort, debugEndpoint] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    // 直接使用 Chrome 公布的 WebSocket，避免本机 HTTP 调试请求被环境代理转发。
    connectedBrowser = await chromium.connectOverCDP(`ws://127.0.0.1:${debugPort}${debugEndpoint}`, { noDefaults: true });
    context = connectedBrowser.contexts()[0];
  } else context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    executablePath: browserExecutable,
    ignoreDefaultArgs: ['--disable-extensions'],
    acceptDownloads: true, downloadsPath: browserFiles,
    viewport: { width: 380, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
      `--proxy-server=http://127.0.0.1:${server.address().port}`, '--disable-background-networking'] });
  const matches = w => targetExtensionRoot ? w.url() === targetExtensionRoot + 'background.js' : w.url().endsWith('/background.js');
  const worker = context.serviceWorkers().find(matches) || await context.waitForEvent('serviceworker', { predicate: matches });
  targetExtensionRoot ||= worker.url().replace(/background\.js$/, '');
  await installUiAudit(worker);
  const page = await context.newPage(), errors = [];
  await page.setViewportSize({ width: 380, height: 1000 });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(targetExtensionRoot + 'popup.html');
  await page.waitForFunction(() => document.querySelector('#reasonOptions')?.children.length === 3);
  return { worker, page, errors };
}
async function closeBrowser() {
  await collectUiAudit();
  if (!nativeBrowser) { await context.close(); context = null; return; }
  const stopped = chromeProcess.exitCode != null ? Promise.resolve() : new Promise(resolve => chromeProcess.once('exit', resolve));
  if (connectedBrowser) {
    try { const session = await connectedBrowser.newBrowserCDPSession(); await session.send('Browser.close'); }
    catch (_) { if (chromeProcess.exitCode == null) chromeProcess.kill('SIGTERM'); }
  } else if (chromeProcess.exitCode == null) chromeProcess.kill('SIGTERM');
  await stopped;
  if (connectedBrowser) await connectedBrowser.close().catch(() => {});
  context = null; connectedBrowser = null; chromeProcess = null;
}
const getState = page => page.evaluate(() => chrome.storage.local.get(['tasks', 'dirs', 'lastDirId', 'taskExpansion', 'setupExpanded', 'captured', 'taskDirectoryHistory', 'taskDirectorySelections', 'taskDirectoryLabels', 'taskDirectoryDrafts', 'taskDirectoryBindings', 'lastTaskCreationFailure']));
// 旧原生下载协议继续单独验证；新版界面的目录选择流程在末尾独立验收。
let legacyBrowserDestination='';
const setBrowserDraft = (page,value) => {legacyBrowserDestination=value;return page.evaluate(value=>{document.querySelector('#taskDirectory').value=value;},value);};
async function createLegacyBrowser(page) {
  return page.evaluate(async download_path=>{
    const r=await chrome.runtime.sendMessage({type:'create',payload:{...filterValues(),operations:selectedOperations(),start:BagCore.inputTime(document.querySelector('#start').value),end:BagCore.inputTime(document.querySelector('#end').value),download_path,reason:document.querySelector('#reason').value}});
    if(!r.ok)throw Error(r.error);await chrome.storage.local.set({setupExpanded:false});return r.task;
  },legacyBrowserDestination);
}
async function reloadExtension(page, errors) {
  await collectUiAudit();
  const extensionUrl = page.url(), previousSession = await page.evaluate(() => chrome.storage.session.get('downloadSession'));
  const manager = await context.newPage(); await manager.goto('chrome://extensions');
  if (await manager.locator('#devMode').getAttribute('aria-checked') !== 'true') await manager.locator('#devMode').click();
  const closedPage = page.waitForEvent('close');
  await manager.locator('extensions-item').getByRole('button', { name: /^(重新加载|Reload)$/ }).click();
  await closedPage;
  await manager.waitForFunction(async () => (await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true })).some(e => e.state === 'ENABLED' && !e.disableReasons.reloading));
  page = await context.newPage(); await page.setViewportSize({ width: 380, height: 1000 }); page.on('pageerror', e => errors.push(e.message)); await page.goto(extensionUrl);
  await page.waitForFunction(async previous => (await chrome.storage.session.get('downloadSession')).downloadSession !== previous, previousSession.downloadSession);
  const matches = w => w.url() === targetExtensionRoot + 'background.js';
  const worker = context.serviceWorkers().find(matches) || await context.waitForEvent('serviceworker', { predicate: matches });
  await installUiAudit(worker);
  const infos = await manager.evaluate(() => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }));
  assert.equal(infos[0].state, 'ENABLED'); assert.deepEqual(infos[0].manifestErrors, []); assert.deepEqual(infos[0].runtimeErrors, []);
  await manager.close(); return { worker, page };
}
async function waitState(page, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const state = await getState(page); if (predicate(state)) return state; await page.waitForTimeout(40); }
  const state=await getState(page);fs.writeFileSync(path.join(output,'wait-state.json'),JSON.stringify(state,null,2));
  throw Error('状态等待超时: ' + JSON.stringify(state.tasks.map(t=>({id:t.id,status:t.status,message:t.message,directoryAccess:t.directoryAccess,done:t.items.filter(i=>i.state==='done').length,total:t.items.length}))));
}
async function freshTick(worker, id) {
  // 重载会自动开始检测；先等旧请求结束，避免本次 tick 复用变化前的在线结果。
  await worker.evaluate(async id => {
    await operations.get(`tick:${id}`); await operations.get(`vehicle:${id}`); await tickTask(id);
  }, id);
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let { worker, page, errors } = await launch();
  // 实际 MAIN + ISOLATED content scripts 和后台消息同步。
  const site = await context.newPage(); await site.goto('http://10.198.92.173:8080/search');
  await waitState(page, s => s.captured?.bag_type === 'Perception');
  await site.evaluate(() => { history.pushState({}, '', '/mdc'); document.querySelector('#app').__vue__.$children[0].form.type = 'Camera'; history.pushState({}, '', '/search'); });
  await waitState(page, s => s.captured?.bag_type === 'Camera');
  await site.evaluate(() => { history.pushState({}, '', '/mdc'); history.pushState({}, '', '/search'); });
  await site.evaluate(() => { document.querySelector('#app').__vue__.$children[0].form.type = 'Perception'; });
  await waitState(page, s => s.captured?.bag_type === 'Perception');
  // 页面保持打开跨扩展重载：重新激活后自动补注入，不刷新网页也能捕获。
  const siteToken=await site.evaluate(()=>window.__bagToolMainVersion);
  assert.equal(siteToken,2);
  ({worker,page}=await reloadExtension(page,errors));await site.bringToFront();
  await site.evaluate(()=>{const f=document.querySelector('#app').__vue__.$children[0].form;Object.assign(f,{truck_no:'WH-Truck03',mine:'HNMZ',type:'PC',break_source:'nas'});document.dispatchEvent(new Event('change',{bubbles:true}));});
  await waitState(page,s=>s.captured?.truck_no==='WH-Truck03'&&s.captured.mine_code==='HNMZ'&&s.captured.bag_type==='PC'&&s.captured.break_source==='nas');
  assert.equal(await page.locator('#capTruck').textContent(),'WH-Truck03');assert.equal(await page.locator('#capType').textContent(),'PC');
  const tableSite=await context.newPage();await tableSite.goto('http://10.198.92.173:8080/table');
  await tableSite.evaluate(()=>{document.querySelector('#app').__vue__.$children=[{form:{name:'TABLE-Truck22',mine:'WHKS',type:'Perception'},regeditForm:{url:'/api/break/search'}}];document.dispatchEvent(new Event('change',{bubbles:true}));});
  await waitState(page,s=>s.captured?.truck_no==='TABLE-Truck22'&&s.captured.mine_code==='WHKS'&&s.captured.break_source==='');
  await site.evaluate(()=>{document.querySelector('#app').__vue__.$children[0].form.truck_no='BACKGROUND-Truck';document.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForTimeout(600);assert.equal((await getState(page)).captured.truck_no,'TABLE-Truck22');
  await site.bringToFront();await waitState(page,s=>s.captured?.truck_no==='BACKGROUND-Truck');
  await site.evaluate(f=>{Object.assign(document.querySelector('#app').__vue__.$children[0].form,{truck_no:f.truck_no,mine:f.mine_code,type:f.bag_type,break_source:f.break_source});document.dispatchEvent(new Event('change',{bubbles:true}));},filters);
  await waitState(page,s=>s.captured?.truck_no===filters.truck_no&&s.captured.bag_type==='Perception');
  await tableSite.close();
  await site.close(); await page.bringToFront();
  // 历史任务目录用真实 OPFS 句柄种入；新 UI 不要求 picker/授权。
  const dirId = 'legacy-test-dir', displayPath = '/home/test/完整本地路径/车辆数据/WH-Truck05/Perception/2026-11-05/bags';
  await page.evaluate(async ({dirId,displayPath}) => {
    const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('bags', { create: true });
    await DirStore.put({id:dirId,name:'bags',handle});
    const {dirs=[]} = await chrome.storage.local.get('dirs');
    await chrome.storage.local.set({dirs:[...dirs,{id:dirId,name:'bags',displayPath}]});
  }, {dirId,displayPath});
  assert.equal(await page.locator('#dirSettings, #directoryRoot, #browserDirBtn').count(), 0);
  await page.evaluate(dirId=>{window.pickerAudit=[];window.showDirectoryPicker=options=>{pickerAudit.push({options,gesture:navigator.userActivation.isActive});return DirStore.get(dirId).then(r=>r.handle);};},dirId);
  await page.locator('#taskDirectory').fill(displayPath);
  await page.evaluate(async({dirId,displayPath})=>useDirectory(await DirStore.get(dirId),displayPath,filterValues()),{dirId,displayPath});
  await page.waitForFunction(()=>document.querySelector('#directoryAccessText').textContent==='已授权，创建时直接使用此目录');
  assert.equal(await page.locator('#dirPick, #dirAuthorize, #directoryPathDetails').count(),0);
  assert.equal(await page.locator('#capType').textContent(), 'Perception');
  assert.equal(await page.locator('#capTruck').evaluate(el => getComputedStyle(el).textAlign), 'center');
  assert.equal(await page.locator('#capType').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert((await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily)).includes('-apple-system'));
  for (const id of ['createBtn']) assert.equal(await page.locator('#' + id).getAttribute('class'), 'ghost-btn');
  // 点击单一日期/时间段自动选中，只修改该段，只有日历按钮打开弹窗。
  await page.evaluate(() => PanelUI.setDate('start', '2026-11-05T01:02:03'));
  await page.locator('#startSecond').click();
  assert.deepEqual(await page.locator('#startSecond').evaluate(el => [el.selectionStart, el.selectionEnd]), [0, 2]);
  await page.keyboard.type('11'); assert.equal(await page.locator('#start').inputValue(), '2026-11-05T01:02:11');
  assert((await page.locator('#startButton').getAttribute('aria-label')).endsWith('01:02:11'));
  assert.equal(await page.locator('#datePopover').isVisible(), false);
  await page.locator('#startMinute').click(); await page.keyboard.type('42'); assert.equal(await page.locator('#start').inputValue(), '2026-11-05T01:42:11');
  await page.locator('#startMonth').click(); await page.keyboard.type('02'); await page.locator('#startDay').click(); await page.keyboard.type('30');
  await page.locator('#startHour').click(); assert.equal(await page.locator('#start').inputValue(), ''); assert(await page.locator('#startError').isVisible());
  await page.locator('#startDay').click(); await page.keyboard.type('28'); await page.locator('#startSecond').click(); await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('#start').inputValue(), '2026-02-28T01:42:12');
  await page.evaluate(() => PanelUI.setDate('start', '2026-11-05T00:00:00'));
  // 秒级日历、非法时间、取消和原因键盘选择。
  await page.locator('#startButton').click(); assert.equal(await page.locator('#calendarDays button').count(), 42);
  await page.locator('#calendarDays [aria-label="2026-11-05"]').click();
  await page.locator('#dateHour').fill('9'); await page.locator('#dateMinute').fill('0'); await page.locator('#dateSecond').fill('60');
  await page.locator('#dateApply').click(); assert(await page.locator('#dateError').isVisible());
  await page.locator('#dateSecond').fill('1'); await page.locator('#dateApply').click();
  assert.equal(await page.locator('#start').inputValue(), '2026-11-05T09:00:01');
  await page.locator('#endButton').click(); await page.locator('#calendarDays [aria-label="2026-11-05"]').click(); await page.locator('#dateHour').fill('9'); await page.locator('#dateMinute').fill('0'); await page.locator('#dateSecond').fill('59');
  await page.locator('#dateApply').click();
  await page.locator('#startButton').click(); await page.locator('#monthPrev').click(); await page.locator('#dateCancel').click();
  assert.equal(await page.locator('#start').inputValue(), '2026-11-05T09:00:01');
  await page.locator('#reasonButton').click(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#reason').inputValue(), '01');
  assert.equal(await page.locator('#transferOptions label[for="reasonButton"]').getAttribute('class'),'sr-only');
  assert.equal(await page.locator('#bugId').getAttribute('placeholder'),'Bug 号（可选）');assert.equal(await page.locator('#remarks').getAttribute('placeholder'),'备注（可选）');
  await page.locator('#reasonButton').click(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#reasonPopover').isVisible(), false);
  // 可折叠任务、卡片内确认、进度刷新保留确认、代次改变清除确认。
  await page.evaluate(async () => {
    const base = { id: 'ui1', name: 'WH-Truck05 · Perception', filters: { truck_no: 'WH-Truck05', mine_code: 'WH', bag_type: 'Perception', break_source: 'mdc' },
      mineName: '芜湖', kind: 'transfer', start: '2026-11-05 09:00:01', end: '2026-11-05 09:00:59', status: 'running', runToken: 'ui-token',
      localVerificationOnly: true, searchReady: false, dirId: 'legacy-test-dir', dirName: 'bags', dirPath: '/home/test/完整本地路径/车辆数据/WH-Truck05/Perception/2026-11-05/bags', createdAt: Date.now(), items: [], transfers: [] };
    await chrome.storage.local.set({ tasks: [base, { ...base, id: 'ui2', status: 'ready', dirPath: '', createdAt: base.createdAt - 1 }], taskExpansion: { ui1: true } });
  });
  await page.waitForFunction(() => document.querySelectorAll('.task').length === 2);
  const task = page.locator('[data-id="ui1"]');
  assert.deepEqual(await task.locator('.actions > button').evaluateAll(buttons => buttons.map(b => b.dataset.act)), ['execute', 'stop', 'transfer', 'delete']);
  assert.equal(await task.locator('[data-act="transfer"]').getAttribute('aria-pressed'), 'true');
  assert(await task.locator('[data-act="transfer"]').evaluate(el => el.classList.contains('selected')));
  assert.equal(await task.locator('.task-save-path').textContent(), displayPath);
  assert.equal(await page.locator('[data-act="edit-dir-path"]').count(), 0);
  assert(!(await page.locator('#tasks').textContent()).includes('完整路径未填写'));
  assert.equal(await page.locator('#tasks [data-act="auth-dir"]').count(), 0, '已授权目录不应显示额外授权入口');
  // 授权状态夹具；真正的后台授权消息、权限检查和队列更新仍使用 OPFS 句柄。
  await page.evaluate(async () => {
    window.authDecision = 'denied'; window.authPrompt = true; window.authCalls = [];
    const permission = DirStore.permission; DirStore.permission = rec => window.authPrompt ? Promise.resolve('prompt') : permission(rec);
    const request = FileSystemDirectoryHandle.prototype.requestPermission;
    FileSystemDirectoryHandle.prototype.requestPermission = async function(options) {
      authCalls.push({ options, gesture: navigator.userActivation.isActive });
      if (authDecision !== 'granted') return 'denied';
      const result = await request.call(this, options); window.authPrompt = false; return result;
    };
    const { tasks } = await chrome.storage.local.get('tasks'); for (const t of tasks) t.directoryBlocked = true;
    await chrome.storage.local.set({ tasks, taskExpansion: { ui1: false } });
  });
  await page.waitForFunction(() => document.querySelectorAll('.task-auth').length === 1);
  assert.equal(await page.locator('[data-id="ui2"] .task-auth').count(),0,'待执行任务不因进度刷新重复提示授权');
  await page.evaluate(async()=>{
    const {tasks}=await chrome.storage.local.get('tasks'),base=tasks[0];
    await chrome.storage.local.set({tasks:[...tasks,
      {...base,id:'ui-finished',status:'done'},
      {...base,id:'ui-stopped',status:'stopped'},
      {...base,id:'ui-missing',dirId:'missing-dir',directoryBlocked:false,directoryAccess:DirectoryHealth.failure('NO_DIR')},
    ]});
  });
  await page.waitForFunction(()=>document.querySelectorAll('.task').length===5&&document.querySelectorAll('.task-directory-issue').length===1);
  assert.equal(await page.locator('.task-auth').count(),1,'完成、停止和目录缺失都不能被误显示成需要授权');
  assert.equal(await page.locator('[data-id="ui-finished"] .pill').textContent(),'已完成');
  assert.equal(await page.locator('[data-id="ui-missing"] .pill').textContent(),'目录待恢复');
  assert.equal(await page.locator('[data-id="ui-missing"] [data-act="auth-dir"]').count(),0);
  await page.screenshot({path:path.join(output,'directory-errors.png'),fullPage:true});
  await page.evaluate(async()=>{const {tasks}=await chrome.storage.local.get('tasks');await chrome.storage.local.set({tasks:tasks.filter(t=>!['ui-finished','ui-stopped','ui-missing'].includes(t.id))});});
  await page.waitForFunction(()=>document.querySelectorAll('.task').length===2);
  assert(await task.locator('.task-auth [data-act="auth-dir"]').isVisible());
  await page.screenshot({ path: path.join(output, 'authorization.png'), fullPage: true });
  await task.locator('.task-auth [data-act="auth-dir"]').click(); await page.waitForTimeout(100);
  assert.equal((await getState(page)).tasks[0].directoryBlocked, true);
  await page.evaluate(() => { window.authDecision = 'granted'; });
  await task.locator('.task-auth [data-act="auth-dir"]').click(); await waitState(page, s => s.tasks.every(t => !t.directoryBlocked));
  assert.equal((await getState(page)).tasks[0].runToken, 'ui-token');
  assert(await page.evaluate(() => authCalls.length === 2 && authCalls.every(c => c.gesture && c.options.mode === 'readwrite')));
  await page.waitForFunction(() => !document.querySelector('#tasks [data-act="auth-dir"]'));
  await task.locator('.task-top').click();
  await page.evaluate(dirId => chrome.runtime.sendMessage({ type: 'directory:label', dirId, path: '/home/another-label/bags' }), dirId);
  await waitState(page, s => s.dirs.find(d => d.id === dirId)?.displayPath === '/home/another-label/bags');
  assert.equal((await getState(page)).tasks[0].dirPath, displayPath);
  assert.equal(await task.locator('.task-save-path').textContent(), displayPath);
  assert.equal(await page.locator('[data-act="edit-dir-path"]').count(), 0);
  await page.evaluate(({ dirId, displayPath }) => chrome.runtime.sendMessage({ type: 'directory:label', dirId, path: displayPath }), { dirId, displayPath });
  await task.locator('[data-act="stop"]').click(); assert(await task.locator('.task-confirm').isVisible());
  assert.equal((await getState(page)).tasks[0].status, 'running');
  await page.evaluate(async () => { const { tasks } = await chrome.storage.local.get('tasks'); tasks[0].message = '进度刷新'; await chrome.storage.local.set({ tasks }); });
  await page.waitForTimeout(100); assert(await task.locator('.task-confirm').isVisible());
  await task.locator('[data-act="confirm-cancel"]').click(); assert.equal((await getState(page)).tasks[0].status, 'running');
  await task.locator('[data-act="stop"]').click();
  await page.evaluate(async () => { const { tasks } = await chrome.storage.local.get('tasks'); tasks[0].runToken = 'new-token'; await chrome.storage.local.set({ tasks }); });
  await page.waitForFunction(() => !document.querySelector('.task-confirm'));
  await task.locator('[data-act="stop"]').click(); await task.locator('[data-act="confirm-apply"]').click();
  await waitState(page, s => s.tasks[0].status === 'stopped'); assert.equal((await getState(page)).tasks[1].status, 'ready');
  await task.locator('[data-act="delete"]').click(); await task.locator('[data-act="confirm-cancel"]').click(); assert.equal((await getState(page)).tasks.length, 2);
  await task.locator('.task-top').click(); await waitState(page, s => s.taskExpansion.ui1 === false);
  await task.locator('.task-top').click(); await waitState(page, s => s.taskExpansion.ui1 === true);
  // 布局与弹窗边界；截图由人/模型视觉核查。
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [300, 380, 720]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const actionRects = await task.locator('.actions > button').evaluateAll(buttons => buttons.map(b => { const r = b.getBoundingClientRect(); return { x:r.x, right:r.right, top:r.top }; }));
      assert(actionRects.every(r => r.x >= 0 && r.right <= width));
      assert.equal(new Set(actionRects.map(r => r.top)).size, 1, '执行、停止、回传、删除应在同一行');
      assert(await task.locator('.task-save-path').evaluate(el => el.scrollWidth <= el.clientWidth + 1), '完整路径被截断');
      assert(await task.locator('.task-save-path').evaluate(el => el.previousElementSibling.classList.contains('task-range')), '路径应在时间段正下方');
      assert(await task.locator('.task-range').evaluate(el => new Set([...el.children].map(c => c.getBoundingClientRect().top)).size === 1), '日期不在同一行');
      await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
      await page.locator('#startButton').click();
      const rect = await page.locator('#datePopover').boundingBox(); assert(rect.x >= 0 && rect.x + rect.width <= width && rect.y >= 0 && rect.y + rect.height <= 1000);
      if (width === 380) await page.screenshot({ path: path.join(output, `${theme}-calendar.png`) });
      await page.keyboard.press('Escape');
      if (width === 380) {
        await page.locator('#reasonButton').click(); await page.screenshot({ path: path.join(output, `${theme}-reason.png`) });
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.setViewportSize({ width: 380, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' });
  await task.locator('[data-act="delete"]').click(); await page.screenshot({ path: path.join(output, 'confirm.png'), fullPage: true });
  await task.locator('[data-act="confirm-apply"]').click(); await waitState(page, s => s.tasks.length === 1);
  await page.evaluate(() => chrome.storage.local.set({ tasks: [] }));
  // 实际创建 -> 批量回传 -> 自动下载 -> 截断失败 -> 浏览器退出 -> 自动恢复。
  await page.evaluate(async ({dirId,filters}) => { const r=await chrome.runtime.sendMessage({type:'create',payload:{...filters,kind:'transfer',dir_id:dirId,reason:'01',start:'2026-11-05 09:00:01',end:'2026-11-05 09:00:59'}}); if(!r.ok)throw Error(r.error); await chrome.storage.local.set({setupExpanded:false}); },{dirId,filters}); await waitState(page, s => s.tasks.length === 1 && s.setupExpanded === false);
  const taskId = (await getState(page)).tasks[0].id;
  await page.locator(`[data-id="${taskId}"] [data-act="execute"]`).click();
  await waitState(page, s => s.tasks[0].transfers?.length === 2 && s.tasks[0].transfers.every(i => i.state === 'submitted'));
  assert.equal(batches.length, 1); assert.deepEqual(batches[0].filename, files.map(f => f.filename));
  const runToken = (await getState(page)).tasks[0].runToken;
  ({ worker, page } = await reloadExtension(page, errors));
  await waitState(page, s => s.tasks[0].status === 'running' && s.tasks[0].transfers.every(i => i.state === 'submitted'));
  assert.equal((await getState(page)).tasks[0].runToken, runToken); assert.equal(batches.length, 1);
  const alertPage = await context.newPage(); await alertPage.goto('http://10.198.92.173:8080/search');
  online = false; await freshTick(worker, taskId); await waitState(page, s => s.tasks[0].status === 'waiting_vehicle');
  assert.equal(await alertPage.evaluate(() => document.documentElement.children.length), 2);
  assert.equal(await alertPage.locator('[style*="position:fixed"]').count(), 0);
  await alertPage.reload(); assert.equal(await alertPage.evaluate(() => document.documentElement.children.length), 2);
  await alertPage.close(); await page.bringToFront();
  online = true; await freshTick(worker, taskId); assert.equal(batches.length, 1);
  await page.evaluate(async ({ dirId, name }) => { const dir = (await DirStore.get(dirId)).handle; const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(new Uint8Array([9, 9])); await w.close(); }, { dirId, name: files[1].filename });
  available = true; records.forEach(r => r.status = 'succeed'); await worker.evaluate(id => tickTask(id), taskId);
  await waitState(page, s => s.tasks[0].items.length === 2 && s.tasks[0].items[0].state === 'done' && s.tasks[0].items[1].state === 'pending' && s.tasks[0].items[1].networkRetries > 0);
  assert.equal(await page.evaluate(async ({ dirId, name }) => (await (await (await DirStore.get(dirId)).handle.getFileHandle(name)).getFile()).size, { dirId, name: files[1].filename }), 2);
  assert.equal(requests.filter(r => r.method === 'GET' && r.path === '/files/0').length, 1);
  assert.deepEqual(errors, []);
  await closeBrowser(); truncated = false;
  ({ worker, page, errors } = await launch());
  const restored = await waitState(page, s => s.tasks?.[0]?.status === 'done', 22000);
  assert.equal(restored.tasks[0].runToken, runToken); assert.equal(restored.dirs.find(d => d.id === dirId).displayPath, displayPath);
  assert.equal(restored.tasks[0].dirPath, displayPath);
  assert(restored.tasks[0].items.every(i => i.state === 'done')); assert.equal(batches.length, 1);
  assert(await page.locator(`[data-id="${taskId}"] [data-act="execute"]`).isDisabled());
  assert(await page.locator(`[data-id="${taskId}"] [data-act="stop"]`).isDisabled());
  assert.equal(requests.filter(r => r.method === 'GET' && r.path === '/files/0').length, 1);
  assert.equal(requests.filter(r => r.method === 'GET' && r.path === '/files/1').length, 2);
  assert.equal(await page.evaluate(async ({ dirId, name }) => (await (await (await DirStore.get(dirId)).handle.getFileHandle(name)).getFile()).size, { dirId, name: files[1].filename }), 8);
  // 真正重新加载已解压扩展，再核验完整文件，无再次回传/GET。
  ({ worker, page } = await reloadExtension(page, errors));
  await waitState(page, s => s.tasks?.[0]?.status === 'done' && s.tasks[0].items.every(i => !i.needsValidation && !i.jobId));
  assert.equal(requests.filter(r => r.method === 'GET' && r.path === '/files/0').length, 1);
  assert.equal(requests.filter(r => r.method === 'GET' && r.path === '/files/1').length, 2);
  assert.equal(batches.length, 1);
  assert.deepEqual(errors, []); assert.equal(requests.filter(r => r.path.includes('.txt')).length, 0);
  // 后续下载使用浏览器原生默认行为；Playwright 的下载接管会改变路径及关闭时的恢复语义。
  await closeBrowser(); nativeBrowser = true; ({ worker, page, errors } = await launch());
  await waitState(page, s => s.tasks[0].status === 'done');
  // 浏览器下载模式使用真实 downloads API 与隔离磁盘目录，不使用 picker/目录权限。
  const original = (await getState(page)).tasks[0], beforeGets = requests.filter(r => r.method === 'GET' && r.path.startsWith('/files/')).length;
  await page.locator('#taskSetup > summary').click();
  await page.locator('#modeTransfer').uncheck();
  await page.locator('#modeDownload').check();
  await setBrowserDraft(page,browserFiles);
  assert.equal(await page.locator('#transferOptions').isVisible(), false);
  await page.evaluate(() => { PanelUI.setDate('start', '2026-11-05T09:00:01'); PanelUI.setDate('end', '2026-11-05T09:00:59'); });
  await page.evaluate(() => {
    const permission = DirStore.permission;
    DirStore.permission = async rec => { if (!rec?.handle) throw Error('浏览器下载不应请求目录权限'); return permission(rec); };
  });
  holdBrowser = true; browserMode = true;
  await createLegacyBrowser(page); await waitState(page, s => s.tasks.length === 2);
  const browserTaskId = (await getState(page)).tasks.find(t => t.id !== original.id).id;
  await page.locator(`[data-id="${browserTaskId}"] [data-act="execute"]`).click();
  await waitState(page, s => s.tasks.find(t => t.id === browserTaskId)?.items[1]?.browserDownloadId != null, 12000);
  assert(browserHeld); const browserTask = (await getState(page)).tasks.find(t => t.id === browserTaskId);
  const browserId = browserTask.items[1].browserDownloadId;
  await page.waitForFunction(({id,path}) => document.querySelector(`[data-id="${id}"] .task-save-path`)?.textContent === path, {id:browserTaskId,path:browserFiles});
  assert(!await page.locator(`[data-id="${browserTaskId}"] .task-auth`).count());
  ({ worker, page } = await reloadExtension(page, errors));
  await waitState(page, s => s.tasks.find(t => t.id === browserTaskId)?.items[1]?.browserDownloadId === browserId);
  assert.equal(requests.filter(r => r.method === 'GET' && r.path.startsWith('/files/')).length, beforeGets + 2, '扩展重载不能取消或重新创建浏览器下载');
  await closeBrowser(); holdBrowser = false;
  ({ worker, page, errors } = await launch());
  const browserRestored = await waitState(page, s => s.tasks.find(t => t.id === browserTaskId)?.status === 'done', 22000);
  const completeBrowser = browserRestored.tasks.find(t => t.id === browserTaskId);
  assert.equal(completeBrowser.runToken, browserTask.runToken); assert(completeBrowser.items.every(i => i.state === 'done'));
  assert.equal(completeBrowser.directoryBlocked, false);
  assert.equal(browserRestored.tasks.find(t => t.id === original.id).dirId, original.dirId);
  assert.equal(browserRestored.tasks.find(t => t.id === original.id).runToken, original.runToken);
  assert.equal(fs.readFileSync(path.join(browserFiles, files[0].filename)).length, 4);
  assert.equal(fs.readFileSync(path.join(browserFiles, files[1].filename)).length, 8192);
  assert.equal(completeBrowser.items[0].downloadPath, path.join(browserFiles, files[0].filename));
  if (!await page.locator('#taskSetup').evaluate(el => el.open)) await page.locator('#taskSetup > summary').click();
  assert.equal(await page.locator(`[data-id="${browserTaskId}"] .task-save-path`).textContent(), browserFiles);
  await page.screenshot({ path: path.join(output, 'browser-downloads.png'), fullPage: true });
  const completeGets = requests.filter(r => r.method === 'GET' && r.path.startsWith('/files/')).length;
  ({ worker, page } = await reloadExtension(page, errors));
  await waitState(page, s => s.tasks.find(t => t.id === browserTaskId)?.status === 'done');
  assert.equal(requests.filter(r => r.method === 'GET' && r.path.startsWith('/files/')).length, completeGets, '完整文件必须复用原下载记录');
  assert.deepEqual(errors, []);
  // 三种操作从新界面真实创建；组合模式复用完成文件，不能再次 GET。
  if (!await page.locator('#taskSetup').evaluate(el => el.open)) await page.locator('#taskSetup > summary').click();
  await page.locator('#modeDownload').uncheck(); assert(await page.locator('#createBtn').isDisabled());
  await page.locator('#modeTransfer').check(); assert(await page.locator('#transferOptions').isVisible());
  await page.locator('#reasonButton').click(); await page.locator('#reasonOptions [data-value="01"]').click();
  await page.locator('#modeDownload').check();
  await page.evaluate(() => { PanelUI.setDate('start','2026-11-05T09:00:01');PanelUI.setDate('end','2026-11-05T09:00:59'); });
  await createLegacyBrowser(page);
  const combo = (await waitState(page,s=>s.tasks.length===3)).tasks.at(-1);
  assert.deepEqual(combo.operations,{transfer:true,download:true});
  await page.locator(`[data-id="${combo.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===combo.id)?.status==='done');
  assert.equal(requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length,completeGets);
  // 用户给出的 08:39:20–08:42:50 时段：真实后台必须处理 193–200，201 只证明边界。
  catalogRows=['08:38:55','08:39:25','08:39:55','08:40:25','08:40:55','08:41:25','08:41:55','08:42:25','08:42:55'].map((time,n)=>({...filters,
    filename:`Perception_wuhu_05_2026-11-06-${time.replaceAll(':','-')}_${193+n}.bag`,create_time:'2026-11-06 19:00:00',dirpath:`/fixture/${193+n}.bag`}));
  available=false;records=[];
  await page.locator('#taskSetup > summary').click();await page.locator('#modeDownload').uncheck();
  await page.evaluate(()=>{PanelUI.setDate('start','2026-11-06T08:39:20');PanelUI.setDate('end','2026-11-06T08:42:50');});
  const beforeExampleBatches=batches.length;
  await createLegacyBrowser(page);const example=(await waitState(page,s=>s.tasks.length===4)).tasks.at(-1);
  await page.locator(`[data-id="${example.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===example.id)?.transfers.length===8&&s.tasks.find(t=>t.id===example.id).transfers.every(i=>i.state==='submitted'));
  const covered=(await getState(page)).tasks.find(t=>t.id===example.id);
  assert(covered.coverage.complete);assert.equal(covered.coverage.coveredStart,'2026-11-06 08:38:55');assert.equal(covered.coverage.coveredEnd,'2026-11-06 08:42:55');
  assert.equal(covered.items.length,0);assert.equal(batches.length,beforeExampleBatches+1);
  assert.deepEqual(batches.at(-1).filename,catalogRows.slice(0,-1).map(r=>r.filename));
  assert.equal(requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length,completeGets,'仅回传不能下载文件');
  await page.locator('#taskSetup > summary').click();await waitState(page,s=>s.setupExpanded===true);await page.reload();
  await page.waitForFunction(()=>document.querySelector('#modeTransfer').checked&&!document.querySelector('#modeDownload').checked);
  if(!await page.locator('#taskSetup').evaluate(el=>el.open))await page.locator('#taskSetup > summary').click();
  await page.locator('#reasonButton').click(); await page.locator('#reasonOptions [data-value="01"]').click();
  // 新任务缺起点边界时可见告警；数据恢复后原任务继续，已有回传不重复提交。
  await page.evaluate(()=>{PanelUI.setDate('start','2026-11-06T08:39:20');PanelUI.setDate('end','2026-11-06T08:42:50');});
  const allExampleRows=catalogRows;catalogRows=catalogRows.slice(1);
  await createLegacyBrowser(page);const missing=(await waitState(page,s=>s.tasks.length===5)).tasks.at(-1);
  await page.locator(`[data-id="${missing.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===missing.id)?.coverageAlert?.includes('开始时刻'));
  await page.locator(`[data-id="${missing.id}"] .coverage-alert`).waitFor({state:'visible'});
  await page.screenshot({path:path.join(output,'coverage-alert.png'),fullPage:true});
  catalogRows=allExampleRows;await worker.evaluate(async id=>{await edit(id,null,t=>{t.mdcCheckedAt=0;});await tickTask(id);},missing.id);
  await waitState(page,s=>s.tasks.find(t=>t.id===missing.id)?.coverage?.complete===true);
  assert.equal(batches.length,beforeExampleBatches+1);
  await page.locator('#taskSetup > summary').click();await page.locator('#modeDownload').check();
  await page.screenshot({path:path.join(output,'operations.png'),fullPage:true});
  await page.evaluate(async ids=>{for(const id of ids)await chrome.runtime.sendMessage({type:'stop',id});},[example.id,missing.id]);
  assert.deepEqual(errors,[]);
  // 浏览器真实 Range 请求解析库山头部，只读 271 字节，不下载车辆包。
  const verifiedBounds=await worker.evaluate(row=>BagHeader.read(row),actualTail);
  assert.equal(verifiedBounds.stop,1792653620512);
  const verifiedCoverage=await worker.evaluate(({rows,bounds})=>BagCoverage.plan(rows,{filters:{truck_no:'WHKS-Truck25',mine_code:'WHKS',bag_type:'Perception',break_source:''},start:'2026-10-22 15:10:00',end:'2026-10-22 15:19:59',items:[],transfers:[],recordingBounds:{[bounds.filename]:bounds}}),{rows:actualBoundaryRows,bounds:verifiedBounds});
  assert(verifiedCoverage.complete);assert.equal(verifiedCoverage.selected.length,21);assert(!verifiedCoverage.targets.some(n=>n.includes('2026-10-29')));
  assert.equal(requests.filter(r=>r.path==='/recording-header').length,1);
  // 使用隔离浏览器设置真实切换默认目录，A/B 任务各自固定，不串目录。
  const folderB=path.join(output,'second-download-directory');fs.mkdirSync(folderB);
  async function setDownloadFolder(folder){
    // 默认路径是 Chrome 受保护设置。只改本测试的关闭配置后重开，保留原生下载行为。
    await closeBrowser();const prefFile=path.join(profile,'Default','Preferences');const prefs=JSON.parse(fs.readFileSync(prefFile,'utf8'));
    prefs.download.default_directory=folder;fs.writeFileSync(prefFile,JSON.stringify(prefs));
    ({worker,page,errors}=await launch());await page.bringToFront();
  }
  catalogRows=[{...files[0],filename:files[0].filename.replace('wuhu','foldertest')},{...files[1],filename:files[1].filename.replace('wuhu','foldertest').replace('09-00-59_2','09-00-11_2')}];available=true;
  if(!await page.locator('#taskSetup').evaluate(el=>el.open))await page.locator('#taskSetup > summary').click();
  await page.locator('#modeTransfer').uncheck();await page.locator('#modeDownload').check();
  await page.evaluate(()=>{PanelUI.setDate('start','2026-11-05T09:00:01');PanelUI.setDate('end','2026-11-05T09:00:10');});
  await createLegacyBrowser(page);const folderTaskA=(await waitState(page,s=>s.tasks.length===6)).tasks.at(-1);assert.equal(folderTaskA.dirPath,browserFiles);
  const folderGets=requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length;
  await setDownloadFolder(folderB);await page.locator(`[data-id="${folderTaskA.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===folderTaskA.id)?.locationBlocked===true);
  const waitingCard=page.locator(`[data-id="${folderTaskA.id}"]`);await page.waitForTimeout(80);
  assert.equal(await waitingCard.locator('.pill').textContent(),'等待目录');assert.equal(await waitingCard.locator('.task-location-wait').count(),1);assert.equal(await waitingCard.locator('.alert-box').count(),0);
  const waitStateBefore=(await getState(page)).tasks.find(t=>t.id===folderTaskA.id),waitProbes=await worker.evaluate(()=>globalThis.downloadUiAudit.events.filter(e=>e.kind==='download'&&e.probe).length);
  await worker.evaluate(async id=>{for(let n=0;n<8;n++)await kick(id);},folderTaskA.id);
  const waitStateAfter=(await getState(page)).tasks.find(t=>t.id===folderTaskA.id);
  assert.equal(waitStateAfter.items[0].jobId,null);assert.equal(waitStateAfter.items[0].attempts,0);assert.equal(waitStateAfter.items[0].error,'');assert.equal(waitStateAfter.runToken,waitStateBefore.runToken);assert.equal(waitStateAfter.events.length,waitStateBefore.events.length);
  assert.equal(await worker.evaluate(()=>globalThis.downloadUiAudit.events.filter(e=>e.kind==='download'&&e.probe).length),waitProbes);
  assert.equal(requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length,folderGets);
  assert.equal((await getState(page)).tasks.find(t=>t.id===folderTaskA.id).dirPath,browserFiles);
  await page.screenshot({path:path.join(output,'directory-mismatch.png'),fullPage:true});
  await page.locator('#taskSetup > summary').click();await setBrowserDraft(page,folderB);await page.evaluate(()=>{PanelUI.setDate('start','2026-11-05T09:00:01');PanelUI.setDate('end','2026-11-05T09:00:10');});await createLegacyBrowser(page);const folderTaskB=(await waitState(page,s=>s.tasks.length===7)).tasks.at(-1);assert.equal(folderTaskB.dirPath,folderB);
  await waitingCard.locator('.task-location-wait').getByText(`请将浏览器下载位置设为：${output}`,{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'directory-suggestion.png'),fullPage:true});
  await page.locator(`[data-id="${folderTaskB.id}"] [data-act="execute"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===folderTaskB.id)?.status==='done');
  assert.equal(fs.readFileSync(path.join(folderB,catalogRows[0].filename)).length,4);assert(!fs.existsSync(path.join(browserFiles,catalogRows[0].filename)));
  await setDownloadFolder(browserFiles);await worker.evaluate(async id=>{await edit(id,null,t=>{for(const i of t.items)i.retryAt=0;});await tickTask(id);},folderTaskA.id);
  await waitState(page,s=>s.tasks.find(t=>t.id===folderTaskA.id)?.status==='done');assert.equal(fs.readFileSync(path.join(browserFiles,catalogRows[0].filename)).length,4);
  const folderState=(await getState(page)).tasks;assert.equal(folderState.find(t=>t.id===folderTaskA.id).dirPath,browserFiles);assert.equal(folderState.find(t=>t.id===folderTaskB.id).dirPath,folderB);
  for(const folder of [browserFiles,folderB])assert.deepEqual(fs.readdirSync(folder).filter(n=>n.startsWith('bagflow-location-')),[],'临时探测文件应已自动清理');
  const downloads=await worker.evaluate(()=>chrome.downloads.search({}));assert(!downloads.some(d=>d.filename.includes('bagflow-location-')),'临时下载记录也应清理');
  assert.deepEqual(errors,[]);
  // 复现怀宁的慢 MDC：归档旧 200 先返回，不进入新任务队列/告警。
  catalogRows=huainingFixture.archive;mdcOverride=huainingFixture.mdc;available=true;holdMdc=true;
  await worker.evaluate(bounds=>{const read=BagHeader.read;BagHeader.read=async row=>bounds[row.filename]||read(row);},huainingFixture.oldBounds);
  await page.evaluate(filters=>chrome.storage.local.set({captured:{...filters,hasSource:true,capturedAt:Date.now(),page:'http://10.198.92.173:8080/search'}}),huainingFixture.filters);
  await page.waitForFunction(()=>document.querySelector('#capTruck').textContent==='HNMZ-Truck06');
  await setBrowserDraft(page,browserFiles);
  if(!await page.locator('#taskSetup').evaluate(el=>el.open))await page.locator('#taskSetup > summary').click();
  await page.locator('#modeTransfer').check();await page.locator('#modeDownload').check();await page.locator('#reasonButton').click();await page.locator('#reasonOptions [data-value="01"]').click();
  await page.evaluate(()=>{PanelUI.setDate('start','2026-11-06T08:47:30');PanelUI.setDate('end','2026-11-06T08:48:20');});
  await createLegacyBrowser(page);const huainingTask=(await waitState(page,s=>s.tasks.length===8)).tasks.at(-1);
  const oldName=huainingFixture.archive.find(r=>r.filename.endsWith('_200.bag')).filename;
  await page.locator(`[data-id="${huainingTask.id}"] [data-act="execute"]`).click();
  const beforeMdc=await waitState(page,s=>s.tasks.find(t=>t.id===huainingTask.id)?.coverage?.excluded?.includes(oldName));
  assert.equal(beforeMdc.tasks.at(-1).items.length,0);assert.equal(beforeMdc.tasks.at(-1).coverageAlert,'');assert.equal(beforeMdc.tasks.at(-1).discovered,false);
  assert(!beforeMdc.tasks.at(-1).events.some(e=>e.message.startsWith('末包 ')&&e.message.includes('_200.bag')));
  assert.equal(requests.filter(r=>r.method==='GET'&&r.path==='/files/200').length,0);
  holdMdc=false;for(const res of heldMdc.splice(0))json(res,mdcRows(),2000);
  const huainingState=await waitState(page,s=>s.tasks.find(t=>t.id===huainingTask.id)?.coverage?.complete&&s.tasks.find(t=>t.id===huainingTask.id).transfers.every(i=>i.state==='submitted'));
  const huainingVerified=huainingState.tasks.find(t=>t.id===huainingTask.id);assert.equal(huainingVerified.transfers.length,2);assert(!huainingVerified.coverage.targets.includes(oldName));
  assert.equal(huainingVerified.coverage.coveredStart,'2026-11-06 08:47:25');assert.equal(huainingVerified.coverage.coveredEnd,'2026-11-06 08:48:25');assert.equal(huainingVerified.items.length,0);
  assert(!huainingVerified.message.includes('时间覆盖尚未确认'));
  await page.screenshot({path:path.join(output,'discovery-order.png'),fullPage:true});
  await page.evaluate(id=>chrome.runtime.sendMessage({type:'stop',id}),huainingTask.id);
  // 共同根目录：A 先等待，根目录调整后自动恢复；A/B 的同名包保存到各自固定目录。
  catalogRows=[{...files[0],filename:files[0].filename.replace('wuhu','sharedroot')},{...files[1],filename:files[1].filename.replace('wuhu','sharedroot').replace('09-00-59_2','09-00-11_2')}];available=true;
  await page.evaluate(f=>chrome.storage.local.set({captured:{...f,hasSource:true,capturedAt:Date.now(),page:'http://10.198.92.173:8080/search'}}),filters);
  async function createRootTask(count,destination,end='2026-11-05T09:00:10'){
    if(!await page.locator('#taskSetup').evaluate(el=>el.open))await page.locator('#taskSetup > summary').click();
    await page.locator('#modeTransfer').uncheck();await page.locator('#modeDownload').check();
    await setBrowserDraft(page,destination);
    await page.evaluate(end=>{PanelUI.setDate('start','2026-11-05T09:00:01');PanelUI.setDate('end',end);},end);
    await createLegacyBrowser(page);return (await waitState(page,s=>s.tasks.length===count)).tasks.at(-1);
  }
  const rootTaskA=await createRootTask(9,browserFiles);assert.equal(rootTaskA.dirPath,browserFiles);
  await setDownloadFolder(folderB);await page.locator(`[data-id="${rootTaskA.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===rootTaskA.id)?.locationWait);const rootRunToken=(await getState(page)).tasks.find(t=>t.id===rootTaskA.id).runToken;
  const rootTaskB=await createRootTask(10,folderB);assert.equal(rootTaskB.dirPath,folderB);
  await setDownloadFolder(output);
  await waitState(page,s=>s.tasks.find(t=>t.id===rootTaskA.id)?.status==='done');
  await page.locator(`[data-id="${rootTaskB.id}"] [data-act="execute"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===rootTaskB.id)?.status==='done');
  const commonState=(await getState(page)).tasks,commonRootTasks={root:output,a:commonState.find(t=>t.id===rootTaskA.id),b:commonState.find(t=>t.id===rootTaskB.id)};
  assert.equal(commonRootTasks.a.runToken,rootRunToken);assert.equal(commonRootTasks.a.dirPath,browserFiles);assert.equal(commonRootTasks.b.dirPath,folderB);
  for(const t of [commonRootTasks.a,commonRootTasks.b]){assert.equal(t.items.length,1);assert.equal(t.items[0].downloadPath,path.join(t.dirPath,catalogRows[0].filename));assert.equal(fs.readFileSync(t.items[0].downloadPath).length,4);assert(!t.locationBlocked);}
  assert.equal(await page.locator(`[data-id="${rootTaskA.id}"] .task-save-path`).textContent(),browserFiles);
  assert.equal(await page.locator(`[data-id="${rootTaskB.id}"] .task-save-path`).textContent(),folderB);
  await page.screenshot({path:path.join(output,'common-root.png'),fullPage:true});
  // 简化创建：根保持不变，插件直接输入两个尚不存在的完整目标目录，不切设置、不重开浏览器。
  catalogRows=[...files,boundary].map(f=>({...f,filename:f.filename.replace('wuhu','multitarget')}));
  const targetA=path.join(output,'huaining','05','20261106','rtfbag'),targetB=path.join(output,'kushan','25','20261106','rtfbag');
  const originalTasks=(await getState(page)).tasks;
  const independentA=await createRootTask(11,targetA,'2026-11-05T09:00:59');holdBrowser=true;
  await page.locator(`[data-id="${independentA.id}"] [data-act="execute"]`).click();
  const aActive=(await waitState(page,s=>s.tasks.find(t=>t.id===independentA.id)?.items[1]?.browserDownloadId!=null)).tasks.find(t=>t.id===independentA.id);
  const independentB=await createRootTask(12,targetB,'2026-11-05T09:00:59');
  const aPreserved=(await getState(page)).tasks.find(t=>t.id===independentA.id);
  assert.equal(aPreserved.runToken,aActive.runToken);assert.equal(aPreserved.items[1].browserDownloadId,aActive.items[1].browserDownloadId);assert.equal(aPreserved.items[1].jobId,aActive.items[1].jobId);
  assert.equal(await worker.evaluate(async id=>(await chrome.downloads.search({id}))[0].state,aActive.items[1].browserDownloadId),'in_progress');
  await page.locator(`[data-id="${independentB.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===independentB.id)?.items[1]?.browserDownloadId!=null);
  holdBrowser=false;for(const {res,bytes} of heldBrowserResponses.splice(0))if(!res.destroyed)res.end(bytes.subarray(4096));
  const independentState=await waitState(page,s=>s.tasks.find(t=>t.id===independentA.id)?.status==='done'&&s.tasks.find(t=>t.id===independentB.id)?.status==='done');
  for(const t of [independentA,independentB]){
    const stored=independentState.tasks.find(s=>s.id===t.id);assert.equal(stored.items.length,2);
    for(const [n,item]of stored.items.entries()){assert.equal(item.downloadPath,path.join(t.dirPath,catalogRows[n].filename));assert.equal(fs.readFileSync(item.downloadPath).length,n?8192:4);}
    assert(!fs.existsSync(path.join(t.dirPath,'bags')));
  }
  assert.equal(independentState.dirs.find(d=>d.backend==='browser').path,output);
  for(const t of originalTasks){const current=independentState.tasks.find(s=>s.id===t.id);assert.equal(current.dirPath,t.dirPath);assert.equal(current.runToken,t.runToken);}
  const independentTasks={root:output,a:independentState.tasks.find(t=>t.id===independentA.id),b:independentState.tasks.find(t=>t.id===independentB.id)};
  // 新模式：picker 入口模拟返回两个真实 OPFS 目录句柄；授权、身份、IndexedDB、后台与流写入使用真实浏览器 API。
  // 两个目录都名为 rtfbag，完整路径标签不属于浏览器根。这里不声称实测原生系统选择弹窗。
  catalogRows=[...files,boundary].map(f=>({...f,filename:f.filename.replace('wuhu','selecteddir')}));
  const displayA='/home/test/车辆数据/怀宁/05/20261106/rtfbag',displayB='/mnt/independent/库山/25/20261106/rtfbag';
  const nativeStartsBefore=await worker.evaluate(()=>globalThis.downloadUiAudit.events.filter(e=>e.kind==='download').length);
  await page.evaluate(async()=>{
    const root=await navigator.storage.getDirectory();window.testPickHandles={};
    for(const key of ['a','b'])testPickHandles[key]=await(await root.getDirectoryHandle('selected-'+key,{create:true})).getDirectoryHandle('rtfbag',{create:true});
    window.selectedPickerAudit=[];window.testPickerNext='a';
    window.showDirectoryPicker=options=>{
      selectedPickerAudit.push({key:testPickerNext,mode:options.mode,gesture:navigator.userActivation.isActive});
      return testPickerNext==='abort'?Promise.reject(new DOMException('cancelled','AbortError')):Promise.resolve(testPickHandles[testPickerNext]);
    };
  });
  async function pickSelected(key){
    if(!await page.locator('#taskSetup').evaluate(el=>el.open))await page.locator('#taskSetup > summary').click();
    await page.locator('#modeTransfer').uncheck();await page.locator('#modeDownload').check();
    await page.evaluate(key=>{testPickerNext=key;},key);
    await page.locator('#taskDirectory').fill(key==='a'?displayA:key==='b'?displayB:'/fixture/cancelled/rtfbag');
    if(key==='abort'){await page.locator('#createBtn').click();await page.waitForFunction(()=>!creating);}
    return page.evaluate(()=>selectedDirectoryId);
  }
  async function createSelected(count){
    await page.evaluate(()=>{PanelUI.setDate('start','2026-11-05T09:00:01');PanelUI.setDate('end','2026-11-05T09:00:59');});
    await page.locator('#createBtn').click();return(await waitState(page,s=>s.tasks.length===count)).tasks.at(-1);
  }
  await pickSelected('a');assert.equal(await page.evaluate(()=>selectedDirectoryId),'');
  const selectedA=await createSelected(13),selectedIdA=selectedA.dirId;assert.equal(selectedA.downloadBackend,'directory');assert.equal(selectedA.dirPath,displayA);
  holdBrowser=true;await page.locator(`[data-id="${selectedA.id}"] [data-act="execute"]`).click();
  const selectedAActive=(await waitState(page,s=>s.tasks.find(t=>t.id===selectedA.id)?.items[1]?.bytes===4096)).tasks.find(t=>t.id===selectedA.id);
  await pickSelected('b');assert.equal(await page.evaluate(()=>selectedDirectoryId),'');
  const selectedB=await createSelected(14),selectedIdB=selectedB.dirId;assert.notEqual(selectedIdB,selectedIdA);assert.equal(selectedB.dirPath,displayB);
  assert(await page.evaluate(()=>selectedPickerAudit.length===2&&selectedPickerAudit.every(e=>e.gesture&&e.mode==='read')));
  const preservedA=(await getState(page)).tasks.find(t=>t.id===selectedA.id);assert.equal(preservedA.runToken,selectedAActive.runToken);assert.equal(preservedA.items[1].jobId,selectedAActive.items[1].jobId);
  await page.locator(`[data-id="${selectedB.id}"] [data-act="execute"]`).click();
  const selectedBActive=(await waitState(page,s=>s.tasks.find(t=>t.id===selectedB.id)?.items[1]?.bytes===4096)).tasks.find(t=>t.id===selectedB.id);
  await page.locator(`[data-id="${selectedA.id}"] [data-act="stop"]`).click();await page.locator(`[data-id="${selectedA.id}"] [data-act="confirm-apply"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===selectedA.id)?.status==='stopped');
  assert.equal((await getState(page)).tasks.find(t=>t.id===selectedB.id).items[1].jobId,selectedBActive.items[1].jobId);
  holdBrowser=false;for(const {res,bytes}of heldBrowserResponses.splice(0))if(!res.destroyed)res.end(bytes.subarray(4096));
  await waitState(page,s=>s.tasks.find(t=>t.id===selectedB.id)?.status==='done');
  await page.locator(`[data-id="${selectedA.id}"] [data-act="execute"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===selectedA.id)?.status==='done');
  for(const [id,display]of[[selectedIdA,displayA],[selectedIdB,displayB]]){
    const sizes=await page.evaluate(async({id,names})=>{const dir=(await DirStore.get(id)).handle;return Promise.all(names.map(async name=>(await(await dir.getFileHandle(name)).getFile()).size));},{id,names:files.map(f=>f.filename.replace('wuhu','selecteddir'))});
    assert.deepEqual(sizes,[4,8192]);assert.equal(await page.evaluate(async id=>{try{await(await DirStore.get(id)).handle.getDirectoryHandle('bags');return true;}catch(e){if(e.name==='NotFoundError')return false;throw e;}},id),false);
  }
  assert.equal((await getState(page)).dirs.find(d=>d.backend==='browser').path,output);
  assert.equal(await worker.evaluate(()=>globalThis.downloadUiAudit.events.filter(e=>e.kind==='download').length),nativeStartsBefore,'目录直写不能启动探测/原生下载');
  const selectedGets=requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length;
  assert.equal(await pickSelected('a'),selectedIdA,'再次选择同一个目录复用原 ID');
  const pickerCountBeforeReuse=await page.evaluate(()=>selectedPickerAudit.length);
  const duplicateSelected=await createSelected(15);assert.equal(await page.evaluate(()=>selectedPickerAudit.length),pickerCountBeforeReuse,'已绑定路径创建不得再次打开目录窗口');await page.locator(`[data-id="${duplicateSelected.id}"] [data-act="execute"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===duplicateSelected.id)?.status==='done');
  assert.equal(requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length,selectedGets,'同目录完整包不能重复下载');
  const redundantNote=await page.evaluate(()=>{const card=progressCard({id:'compact',message:'下载中：Perception_2026-11-06-08-46-55_208.bag',items:[{filename:'Perception_2026-11-06-08-46-55_208.bag',create_time:'2026-11-06 08:46:55',dirpath:'/fixture/progress',state:'downloading',bytes:1024,totalBytes:8192}]},false);return {note:!!card.querySelector('.phase-note'),detail:card.querySelector('.bag-detail').textContent};});
  assert(!redundantNote.note);assert(redundantNote.detail.includes('下载中')); 
  const workerOnlyBlockedSelected=await pickSelected('a').then(()=>createSelected(16));
  // worker/侧栏误报时，以真正写入文档的权限为准，任务直接完成。
  await worker.evaluate(()=>{const permission=DirStore.permission;DirStore.permission=async rec=>(await chrome.storage.local.get('directoryTestBlocked')).directoryTestBlocked===rec?.id?'prompt':permission(rec);});
  await page.evaluate(async id=>{
    const permission=DirStore.permission;DirStore.permission=async rec=>(await chrome.storage.local.get('directoryTestBlocked')).directoryTestBlocked===rec?.id?'prompt':permission(rec);
    await chrome.storage.local.set({directoryTestBlocked:id});
  },selectedIdA);
  await page.locator(`[data-id="${workerOnlyBlockedSelected.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===workerOnlyBlockedSelected.id)?.status==='done');
  assert.equal((await getState(page)).tasks.find(t=>t.id===workerOnlyBlockedSelected.id).directoryBlocked,false);
  assert.equal(await page.locator(`[data-id="${workerOnlyBlockedSelected.id}"] [data-act="auth-dir"]`).count(),0);
  await page.evaluate(()=>chrome.storage.local.set({directoryTestBlocked:''}));
  const blockedSelected=await pickSelected('a').then(()=>createSelected(17));
  // 真正缺少权限且不能静默恢复的夹具覆盖 offscreen，A 等待时 B 仍可完成。
  const offscreenPage=await offscreenContext(context,targetExtensionRoot+'offscreen.html');
  await offscreenPage.evaluate(id=>{
    globalThis.directoryBlockedId=id;globalThis.silentAuthAudit=[];const get=DirStore.get;
    DirStore.get=async key=>{
      const rec=await get(key);
      if(rec?.handle&&key===directoryBlockedId){
        const query=rec.handle.queryPermission.bind(rec.handle),request=rec.handle.requestPermission.bind(rec.handle);
        rec.handle.queryPermission=options=>directoryBlockedId===key?Promise.resolve('prompt'):query(options);
        rec.handle.requestPermission=async options=>{
          silentAuthAudit.push({gesture:navigator.userActivation.isActive,options});
          if(directoryBlockedId===key)throw new DOMException('User activation is required','SecurityError');
          return request(options);
        };
      }
      return rec;
    };
    chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
      if(msg.type!=='offscreen:test-directory-grant')return false;
      if(msg.dirId===directoryBlockedId)directoryBlockedId='';reply({ok:true});return false;
    });
  },selectedIdA);
  await page.evaluate(async id=>{
    const request=FileSystemDirectoryHandle.prototype.requestPermission;window.selectedAuthAudit=[];
    FileSystemDirectoryHandle.prototype.requestPermission=function(options){selectedAuthAudit.push({gesture:navigator.userActivation.isActive,options});return chrome.storage.local.set({directoryTestBlocked:''}).then(()=>chrome.runtime.sendMessage({type:'offscreen:test-directory-grant',dirId:id})).then(()=>request.call(this,options));};
    await chrome.storage.local.set({directoryTestBlocked:id,lastAuthAt:Date.now()});
  },selectedIdA);
  await page.locator(`[data-id="${blockedSelected.id}"] [data-act="execute"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===blockedSelected.id)?.directoryBlocked);
  await pickSelected('b');const unblockedSelected=await createSelected(18);await page.locator(`[data-id="${unblockedSelected.id}"] [data-act="execute"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===unblockedSelected.id)?.status==='done');
  assert((await getState(page)).tasks.find(t=>t.id===blockedSelected.id).directoryBlocked);
  await page.locator(`[data-id="${blockedSelected.id}"] [data-act="auth-dir"]`).click();await waitState(page,s=>s.tasks.find(t=>t.id===blockedSelected.id)?.status==='done');
  assert(await page.evaluate(()=>selectedAuthAudit.length===1&&selectedAuthAudit[0].gesture&&selectedAuthAudit[0].options.mode==='readwrite'));
  assert(await offscreenPage.evaluate(()=>silentAuthAudit.length>0&&silentAuthAudit.every(a=>!a.gesture&&a.options.mode==='readwrite')),'后台恢复不能依赖用户手势');
  await offscreenPage.dispose();
  if(!await page.locator('#taskSetup').evaluate(el=>el.open))await page.locator('#taskSetup > summary').click();
  await page.locator('#directoryHistoryButton').click();await page.locator(`#directoryChoices [data-dir-id="${selectedIdA}"]`).click();await page.waitForFunction(()=>!selectingDirectory);
  assert.equal(await page.evaluate(()=>selectedDirectoryId),selectedIdA);
  const countBeforeCancel=(await getState(page)).tasks.length;await pickSelected('abort');assert.equal((await getState(page)).tasks.length,countBeforeCancel);assert((await page.locator('#formMsg').textContent()).includes('未创建任务'));await pickSelected('a');
  const selectedTasks={a:(await getState(page)).tasks.find(t=>t.id===selectedA.id),b:(await getState(page)).tasks.find(t=>t.id===selectedB.id),directories:[selectedIdA,selectedIdB]};
  for(const t of[selectedTasks.a,selectedTasks.b])assert.deepEqual(t.items.map(i=>[i.bytes,i.totalBytes]),[[4,4],[8192,8192]],'完成字节进度必须与真实文件一致');
  // 正在输入与删除后的空值不受进度刷新影响，光标保持；非法路径显示就地错误。
  await page.locator('#taskDirectory').fill('relative/path');assert(await page.locator('#createBtn').isDisabled());assert(await page.locator('#directoryError').isVisible());
  await page.locator('#taskDirectory').fill('');
  await page.evaluate(()=>chrome.storage.local.set({tasks:tasks.map(t=>({...t,updatedAt:Date.now()}))}));await page.waitForTimeout(80);assert.equal(await page.locator('#taskDirectory').inputValue(),'');
  await page.locator('#taskDirectory').fill(displayA);
  await page.locator('#taskDirectory').evaluate(el=>{el.focus();el.setSelectionRange(5,12);});
  await page.evaluate(()=>chrome.storage.local.set({tasks:tasks.map(t=>({...t,updatedAt:Date.now()}))}));await page.waitForTimeout(80);
  assert.deepEqual(await page.locator('#taskDirectory').evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,5,12]);
  // 新车辆不能沿用另一车辆目录；切回来恢复草稿，重载后继续保留。
  await page.evaluate(()=>chrome.storage.local.set({captured:{...captured,truck_no:'NEW-Truck07',capturedAt:Date.now()}}));await page.waitForFunction(()=>document.querySelector('#capTruck').textContent==='NEW-Truck07');
  assert.equal(await page.evaluate(()=>selectedDirectoryId),'');assert(await page.locator('#createBtn').isDisabled());
  await page.evaluate(f=>chrome.storage.local.set({captured:{...f,hasSource:true,capturedAt:Date.now()}}),filters);await page.waitForFunction(()=>document.querySelector('#taskDirectory').value.endsWith('/怀宁/05/20261106/rtfbag'));
  await waitState(page,s=>s.taskDirectoryDrafts?.[JSON.stringify([filters.mine_code,filters.truck_no])]===displayA);
  const independentGets=requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length;
  ({worker,page}=await reloadExtension(page,errors));
  assert.equal(await page.locator('#taskDirectory').inputValue(),displayA);
  await waitState(page,s=>s.tasks.find(t=>t.id===selectedA.id)?.status==='done'&&s.tasks.find(t=>t.id===selectedB.id)?.status==='done');
  await waitState(page,s=>s.tasks.find(t=>t.id===independentA.id)?.status==='done'&&s.tasks.find(t=>t.id===independentB.id)?.status==='done');
  assert.equal(requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length,independentGets);
  const selectedBeforeRestart=(await getState(page)).tasks.filter(t=>[selectedA.id,selectedB.id].includes(t.id));
  await closeBrowser();({worker,page,errors}=await launch());
  const selectedRestarted=await waitState(page,s=>[selectedA.id,selectedB.id].every(id=>{const t=s.tasks.find(t=>t.id===id);return t?.status==='done'&&t.items.every(i=>!i.jobId&&!i.needsValidation);}));
  for(const original of selectedBeforeRestart){const t=selectedRestarted.tasks.find(t=>t.id===original.id);assert.equal(t.runToken,original.runToken);assert.equal(t.dirId,original.dirId);assert.equal(t.dirPath,original.dirPath);}
  assert.equal(await page.evaluate(()=>selectedDirectoryId),selectedIdA);assert.equal(await page.locator('#taskDirectory').inputValue(),displayA);
  assert.equal(requests.filter(r=>r.method==='GET'&&r.path.startsWith('/files/')).length,independentGets,'新目录任务浏览器重开后不能重复完整包');
  for(const theme of ['light','dark'])for(const width of [300,380,720]){
    await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:1100});
    await page.waitForTimeout(50);
    assert(await page.locator('#taskDirectory').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'完整路径全部显示');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'目录输入不能撑宽布局');
    await page.screenshot({path:path.join(output,`task-directory-${theme}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:380,height:1000});await page.emulateMedia({colorScheme:'light'});
  await page.locator('#directoryHistoryButton').click();await page.screenshot({path:path.join(output,'task-directory-history.png'),fullPage:true});await page.keyboard.press('Escape');
  // 目录模式真实流在接收一半时断网；另一目录继续完成，原任务自动补完原位置。
  catalogRows=[...files,boundary].map(f=>({...f,filename:f.filename.replace('wuhu','networkdir')}));records=[];
  available=true;holdBrowser=true;browserHeld=false;
  const networkCount=(await getState(page)).tasks.length;
  await pickSelected('a');const networkA=await createSelected(networkCount+1);
  await page.locator(`[data-id="${networkA.id}"] [data-act="execute"]`).click();
  const networkAActive=(await waitState(page,s=>s.tasks.find(t=>t.id===networkA.id)?.items[1]?.bytes===4096)).tasks.find(t=>t.id===networkA.id);
  await pickSelected('b');const networkB=await createSelected(networkCount+2);
  await page.locator(`[data-id="${networkB.id}"] [data-act="execute"]`).click();
  await waitState(page,s=>s.tasks.find(t=>t.id===networkB.id)?.items[1]?.bytes===4096);
  assert.equal((await getState(page)).tasks.find(t=>t.id===networkA.id).items[1].jobId,networkAActive.items[1].jobId);
  const nativeBeforeNetwork=await worker.evaluate(()=>downloadUiAudit.events.filter(e=>e.kind==='download').length);
  heldBrowserResponses.shift().res.destroy();holdBrowser=false;
  for(const{res,bytes}of heldBrowserResponses.splice(0))if(!res.destroyed)res.end(bytes.subarray(4096));
  await waitState(page,s=>s.tasks.find(t=>t.id===networkB.id)?.status==='done');
  const networkDone=await waitState(page,s=>s.tasks.find(t=>t.id===networkA.id)?.status==='done',22000);
  const networkDirectoryTasks=networkDone.tasks.filter(t=>[networkA.id,networkB.id].includes(t.id));
  for(const [t,id,display]of[[networkDirectoryTasks.find(t=>t.id===networkA.id),selectedIdA,displayA],[networkDirectoryTasks.find(t=>t.id===networkB.id),selectedIdB,displayB]]){
    assert.equal(t.dirId,id);assert.equal(t.dirPath,display);assert.deepEqual(t.items.map(i=>[i.bytes,i.totalBytes]),[[4,4],[8192,8192]]);
    const sizes=await page.evaluate(async({id,names})=>{const dir=(await DirStore.get(id)).handle;return Promise.all(names.map(async name=>(await(await dir.getFileHandle(name)).getFile()).size));},{id,names:t.items.map(i=>i.filename)});
    assert.deepEqual(sizes,[4,8192]);
  }
  assert.equal(networkDirectoryTasks.find(t=>t.id===networkA.id).runToken,networkAActive.runToken);
  assert.equal(await worker.evaluate(()=>downloadUiAudit.events.filter(e=>e.kind==='download').length),nativeBeforeNetwork,'断网恢复不得转为原生下载或读取默认目录');
  assert(networkDirectoryTasks.find(t=>t.id===networkA.id).events.some(e=>e.message==='等待网络恢复，继续使用原任务保存目录'));
  // 真实 HTTP 业务拒绝：容量只有 3 个位置，先拒绝整批，再逐包利用每次释放的空位。
  await worker.evaluate(async()=>{for(const t of(await load()).filter(active))await stopTask(t.id);});
  catalogRows=Array.from({length:13},(_,i)=>({...files[0],filename:`Perception_capacity_2026-11-05-14-${String(i).padStart(2,'0')}-00_${i+1}.bag`,create_time:`2026-11-05 14:${String(i).padStart(2,'0')}:00`,dirpath:`/capacity/${i+1}.bag`}));
  available=false;online=true;mdcOverride=null;records=[];transferCapacity=3;
  const beforeCapacityBatches=batches.length;
  const capacityTask=await worker.evaluate(async f=>{
    const t=await createTask({...f,start:'2026-11-05 14:00:00',end:'2026-11-05 14:11:59',reason:'01',operations:{transfer:true,download:false}});
    await execute(t.id);return t;
  },filters);
  const capacityWaiting=(await waitState(page,s=>{
    const t=s.tasks.find(t=>t.id===capacityTask.id);return t?.transfers.length===12&&t.transfers.filter(i=>i.capacityRetries).length===10&&t.transfers.every(i=>i.state==='pending'&&!i.submissionLocked);
  })).tasks.find(t=>t.id===capacityTask.id);
  assert.equal(batches.length,beforeCapacityBatches+1);assert.equal(batches.at(-1).filename.length,10);
  assert.match(capacityWaiting.transferMessage,/自动追加|自动重试/);
  await page.locator(`[data-id="${capacityTask.id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(output,'transfer-capacity.png'),fullPage:true});
  await worker.evaluate(()=>{
    globalThis.capacityOriginalNow=Date.now;globalThis.capacityClockOffset=0;
    Date.now=()=>capacityOriginalNow()+capacityClockOffset;
  });
  let capacityRestored;
  try{
    for(let cycle=1;cycle<=4;cycle++){
      records.forEach(r=>r.status='succeed');
      await worker.evaluate(async({id,delay})=>{
        capacityClockOffset+=delay;await tickTask(id);
        await operations.get(`submit:${(await snapshot(id)).filters.mine_code}:${(await snapshot(id)).filters.truck_no}`);
      },{id:capacityTask.id,delay:cycle===1?30000:60000});
      await waitState(page,s=>s.tasks.find(t=>t.id===capacityTask.id)?.transfers.filter(i=>i.accepted).length===cycle*3);
      assert.equal(records.length,cycle*3);assert.equal(new Set(records.map(r=>r.filename)).size,records.length);
    }
    records.forEach(r=>r.status='succeed');await worker.evaluate(id=>tickTask(id),capacityTask.id);
    capacityRestored=(await waitState(page,s=>s.tasks.find(t=>t.id===capacityTask.id)?.status==='done')).tasks.find(t=>t.id===capacityTask.id);
    assert.equal(capacityRestored.runToken,capacityWaiting.runToken);assert.equal(capacityRestored.items.length,0);
    assert(capacityRestored.transfers.every(i=>i.state==='done'&&!i.retryAt&&!i.capacityRetries));
    assert.deepEqual(records.map(r=>r.filename),catalogRows.slice(0,12).map(r=>r.filename));
    assert(batches.slice(beforeCapacityBatches+1).every(b=>b.filename.length<=2));
  }finally{
    await worker.evaluate(()=>{Date.now=capacityOriginalNow;delete globalThis.capacityOriginalNow;delete globalThis.capacityClockOffset;});
    transferCapacity=null;
  }
  // 真实按钮 -> HTTP 暂停/恢复 -> 服务器确认；同名外部记录不影响，重载保持关闭意图。
  catalogRows=Array.from({length:3},(_,i)=>({...files[0],filename:`Perception_switch_2026-11-05-15-0${i}-00_${i+1}.bag`,create_time:`2026-11-05 15:0${i}:00`,dirpath:`/switch/${i+1}.bag`}));
  available=false;online=true;records=[];
  const beforeSwitchBatches=batches.length;
  const switchTask=await worker.evaluate(async f=>{
    const t=await createTask({...f,start:'2026-11-05 15:00:00',end:'2026-11-05 15:01:59',reason:'01',operations:{transfer:true,download:false}});
    await execute(t.id);return t;
  },filters);
  await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transfers.length===2&&s.tasks.find(t=>t.id===switchTask.id).transfers.every(i=>i.accepted));
  assert.equal(batches.length,beforeSwitchBatches+1);
  const switchRecordIds=records.map(r=>r.record_no), foreignRecord={...records[0],record_no:90001,remarks:'[BagFlowTask:external-task]'};
  records.push(foreignRecord);
  let switchCard=page.locator(`[data-id="${switchTask.id}"]`), switchButton=switchCard.locator('[data-act="transfer"]');
  assert.equal(await switchButton.getAttribute('aria-pressed'),'true');
  await switchButton.click();
  const switchPaused=(await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===false&&s.tasks.find(t=>t.id===switchTask.id).transferControl?.phase==='settled')).tasks.find(t=>t.id===switchTask.id);
  assert.equal(await switchButton.getAttribute('aria-pressed'),'false');
  assert.equal(await switchCard.locator('.task-confirm').count(),0,'回传开关不需要二次确认');
  assert(records.filter(r=>switchRecordIds.includes(r.record_no)).every(r=>r.status==='pause'));assert.equal(foreignRecord.status,'waiting');
  await switchCard.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'transfer-switch-paused.png'),fullPage:true});
  ({worker,page}=await reloadExtension(page,errors));
  const switchReloaded=(await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===false)).tasks.find(t=>t.id===switchTask.id);
  assert.equal(switchReloaded.runToken,switchPaused.runToken);assert.equal(batches.length,beforeSwitchBatches+1);
  switchCard=page.locator(`[data-id="${switchTask.id}"]`);switchButton=switchCard.locator('[data-act="transfer"]');
  assert.equal(await switchButton.getAttribute('aria-pressed'),'false');
  await switchButton.click();
  await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===true&&s.tasks.find(t=>t.id===switchTask.id).transferControl?.phase==='settled');
  assert(records.filter(r=>switchRecordIds.includes(r.record_no)).every(r=>r.status==='cancelpause'));assert.equal(foreignRecord.status,'waiting');
  assert.equal(batches.length,beforeSwitchBatches+1,'恢复应使用原记录，不重复提交');
  // 业务失败显示未完成，30 秒后恢复沿原 ID 重试。
  transferCommandFailures=1;await switchButton.click();
  await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferControl?.phase==='retry');
  assert.match(await switchCard.locator('.transfer-control-note').textContent(),/自动重试.*fixture transfer/);
  await page.screenshot({path:path.join(output,'transfer-switch-retry.png'),fullPage:true});
  await worker.evaluate(id=>{
    globalThis.transferOriginalNow=Date.now;Date.now=()=>transferOriginalNow()+30000;
    return reconcileTransferControl(id);
  },switchTask.id);
  await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferControl?.phase==='settled');
  await worker.evaluate(()=>{Date.now=transferOriginalNow;delete globalThis.transferOriginalNow;});
  assert(records.filter(r=>switchRecordIds.includes(r.record_no)).every(r=>r.status==='pause'));
  // HTTP 请求尚未返回时反向开启，先前暂停结束后补偿恢复。
  await switchButton.click();await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===true&&s.tasks.find(t=>t.id===switchTask.id).transferControl?.phase==='settled');
  holdTransferCommands=true;await switchButton.click();
  for(let n=0;n<200&&heldTransferCommands.length!==2;n++)await page.waitForTimeout(25);
  assert.equal(heldTransferCommands.length,2);await page.waitForFunction(id=>!document.querySelector(`[data-id="${id}"] [data-act="transfer"]`).disabled,switchTask.id);
  await switchButton.click();await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===true);
  holdTransferCommands=false;heldTransferCommands.splice(0).forEach(apply=>apply());
  await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===true&&s.tasks.find(t=>t.id===switchTask.id).transferControl?.phase==='settled');
  assert(records.filter(r=>switchRecordIds.includes(r.record_no)).every(r=>r.status==='cancelpause'));
  const localStopped=await worker.evaluate(async id=>{await stopTask(id);return snapshot(id);},switchTask.id);
  await switchButton.click();await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===false&&s.tasks.find(t=>t.id===switchTask.id).transferControl?.phase==='settled');
  await switchButton.click();
  const switchRestored=(await waitState(page,s=>s.tasks.find(t=>t.id===switchTask.id)?.transferEnabled===true&&s.tasks.find(t=>t.id===switchTask.id).transferControl?.phase==='settled')).tasks.find(t=>t.id===switchTask.id);
  assert.equal(switchRestored.status,'stopped');assert.equal(switchRestored.runToken,localStopped.runToken);assert.equal(batches.length,beforeSwitchBatches+1);
  const switchRequests=requests.filter(r=>/^\/api\/break\/(pause|cancelpause)\//.test(r.path));
  assert(switchRequests.length>0&&switchRequests.every(r=>r.method==='POST'&&r.bodyBytes===0&&switchRecordIds.includes(Number(r.path.split('/').at(-1)))));
  assert.equal(foreignRecord.status,'waiting');
  const transferSwitchVerified={paused:switchPaused,reloaded:switchReloaded,restored:switchRestored,recordIds:switchRecordIds,requests:switchRequests};
  await page.screenshot({path:path.join(output,'transfer-switch-restored.png'),fullPage:true});
  // Windows 路径创建：选择已成功后持久化/授权失败，错误分步显示，下一次点击不重选目录。
  await page.evaluate(async()=>{
    const root=await navigator.storage.getDirectory();window.edgeCreationHandles={};
    for(const key of['persist','permission'])edgeCreationHandles[key]=await(await root.getDirectoryHandle('edge-create-'+key,{create:true})).getDirectoryHandle('rtfbag',{create:true});
    window.edgeCreationCase='persist';window.edgeCreationFailure=true;window.edgeCreationPickAudit=[];
    window.edgePreviousPicker=window.showDirectoryPicker;
    window.showDirectoryPicker=options=>{edgeCreationPickAudit.push({key:edgeCreationCase,mode:options.mode,gesture:navigator.userActivation.isActive});return Promise.resolve(edgeCreationHandles[edgeCreationCase]);};
    window.edgePreviousClaim=DirStore.claim;
    DirStore.claim=async handle=>{if(edgeCreationCase==='persist'&&edgeCreationFailure)throw new DOMException('fixture directory transaction aborted','AbortError');return edgePreviousClaim(handle);};
    window.edgePreviousRequest=FileSystemDirectoryHandle.prototype.requestPermission;
    FileSystemDirectoryHandle.prototype.requestPermission=async function(options){
      if(edgeCreationCase==='permission'&&edgeCreationFailure&&await this.isSameEntry(edgeCreationHandles.permission))return 'denied';
      return edgePreviousRequest.call(this,options);
    };
    window.edgePreviousClipboardWrite=navigator.clipboard.writeText;
    navigator.clipboard.writeText=async text=>{window.edgeCopiedError=text;};
  });
  const edgeCreationRecovered=[];
  for(const [key,display]of[['persist','D:\\数据\\车辆05\\20261111\\rtfbag'],['permission','E:\\回传数据\\车辆05\\rtfbag']]){
    if(!await page.locator('#taskSetup').evaluate(el=>el.open))await page.locator('#taskSetup > summary').click();
    await page.locator('#modeTransfer').uncheck();await page.locator('#modeDownload').check();
    await page.evaluate(key=>{edgeCreationCase=key;edgeCreationFailure=true;PanelUI.setDate('start','2026-11-05T09:00:01');PanelUI.setDate('end','2026-11-05T09:00:59');},key);
    await page.locator('#taskDirectory').fill(display);
    const before=(await getState(page)).tasks.length,picks=await page.evaluate(()=>edgeCreationPickAudit.length);
    await page.locator('#createBtn').click();await page.waitForFunction(()=>!creating);
    assert.equal((await getState(page)).tasks.length,before);
    const message=await page.locator('#formMsg').textContent();assert(!message.includes('已取消目录选择'));
    assert(message.includes(key==='persist'?'保存目录记录失败':'未获得写入权限'));
    const diagnostic=await page.evaluate(async()=>(await chrome.storage.local.get('lastTaskCreationFailure')).lastTaskCreationFailure);
    assert.equal(diagnostic.stage,key);assert.equal(diagnostic.path,display);assert.equal(diagnostic.directorySelected,true);
    assert.equal(diagnostic.code,key==='persist'?'AbortError':'NotAllowedError');
    await page.locator('#copyCreateError').click();assert.deepEqual(await page.evaluate(()=>JSON.parse(edgeCopiedError)),diagnostic);
    await page.screenshot({path:path.join(output,'edge-create-'+key+'.png'),fullPage:true});
    await page.evaluate(()=>{edgeCreationFailure=false;});await page.locator('#createBtn').click();
    const created=(await waitState(page,s=>s.tasks.length===before+1)).tasks.at(-1);
    await page.waitForFunction(()=>!creating);
    assert.equal(created.status,'ready');assert.equal(created.dirPath,display);assert.equal(created.downloadBackend,'directory');
    const downloadTransferButton=page.locator(`[data-id="${created.id}"] [data-act="transfer"]`);
    assert(await downloadTransferButton.isDisabled());assert.equal(await downloadTransferButton.getAttribute('aria-pressed'),'false');
    assert.equal(await page.evaluate(()=>edgeCreationPickAudit.length),picks+1,'重试应复用已选择目录，不能再次弹出选择窗口');
    assert.equal(await page.locator('#createErrorTools').isVisible(),false);
    assert.equal(await page.evaluate(async()=>(await chrome.storage.local.get('lastTaskCreationFailure')).lastTaskCreationFailure),undefined);
    edgeCreationRecovered.push({diagnostic,task:created});
  }
  assert(await page.evaluate(()=>edgeCreationPickAudit.every(a=>a.gesture&&a.mode==='read')));
  await page.evaluate(()=>{window.showDirectoryPicker=edgePreviousPicker;DirStore.claim=edgePreviousClaim;FileSystemDirectoryHandle.prototype.requestPermission=edgePreviousRequest;navigator.clipboard.writeText=edgePreviousClipboardWrite;});
  await collectUiAudit();
  assert(downloadUiAudits.some(e=>e.kind==='download'&&e.probe));
  assert(downloadUiAudits.filter(e=>e.kind==='download'&&e.probe).every(e=>e.enabled===false),'目录探测下载不得触发下载 UI');
  assert(downloadUiAudits.filter(e=>e.kind==='download'&&!e.probe).every(e=>e.enabled===false),'真实 bag 下载静默启动');
  assert(downloadUiAudits.some(e=>e.kind==='complete'&&!e.probe));assert(downloadUiAudits.filter(e=>e.kind==='complete'&&!e.probe).every(e=>e.enabled===false),'真实 bag 完成时也不得触发下载 UI');
  assert.equal(downloadUiAudits.filter(e=>e.kind==='ui').at(-1).enabled,true);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, requests, batches, restored, browserRestored, covered, verifiedBounds, verifiedCoverage, folderTaskA, folderTaskB, huainingVerified, commonRootTasks, independentTasks, selectedTasks, networkDirectoryTasks, capacityRestored, transferSwitchVerified, edgeCreationRecovered, downloadUiAudits }, null, 2));
  console.log('真实 Chromium 验收通过：任务回传开关、原记录暂停恢复、外部记录隔离、快速反向切换、失败重试和重载保持；目录创建故障诊断、容量自动追加、目录隔离、授权恢复、完整性、六种布局及旧原生下载恢复。系统目录弹窗、权限和服务器业务采用本地夹具。');
  console.log('截图和验证记录: ' + output);
}
main().catch(async e => { console.error(e); console.error('验收输出: ' + output); if (context) {
  const page = context.pages().find(p => p.url().endsWith('popup.html')); if (page) {
    const debug=await page.evaluate(async()=>({directoryKey,directoryLabels,directorySelections,selectedDirectoryId,input:document.querySelector('#taskDirectory').value,filters:filterValues(),form:document.querySelector('#formMsg').textContent,failure:(await chrome.storage.local.get('lastTaskCreationFailure')).lastTaskCreationFailure})).catch(e=>({error:e.message}));
    console.error('目录状态: '+JSON.stringify(debug));
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
} process.exitCode = 1; }).finally(async () => { if (context || chromeProcess) await closeBrowser(); server.closeAllConnections(); server.close(); });
