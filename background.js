importScripts('task-core.js', 'coverage-core.js', 'transfer-switch.js', 'site-api.js', 'bag-header.js', 'dirstore.js', 'directory-health.js', 'directory-paths.js', 'task-directories.js', 'directory-access.js', 'download-ui.js', 'browser-location.js', 'browser-downloads.js');
const C = BagCore, API = SiteAPI;
const HEARTBEAT = 'bagtool-heartbeat', POLL_MS = 15000, MAX_ATTEMPTS = 3;
const WORKER_STARTED_AT = Date.now();
const active = (t) => C.ACTIVE.includes(t.status);
const load = async () => {
  const { tasks = [], taskTransferSelections = {} } = await chrome.storage.local.get(['tasks', 'taskTransferSelections']);
  return tasks.map(t => C.normalizeTask(C.applyTransferSelection(t, taskTransferSelections[t.id])));
};
const save = (tasks) => chrome.storage.local.set({ tasks });
const newId = () => crypto.randomUUID();
let queue = Promise.resolve();
let validationSession = '';
const directoryCheckCache = new Map();
const directoryAuthorizationEpoch = new Map();
function locked(fn) { const p = queue.then(fn); queue = p.catch(() => {}); return p; }
async function edit(id, token, fn) {
  return locked(async () => {
    const tasks = await load(), t = tasks.find((t) => t.id === id);
    if (!t || (token != null && (t.runToken !== token || !active(t)))) return null;
    const result = fn(t, tasks); t.updatedAt = Date.now(); await save(tasks); return result ?? t;
  });
}
const snapshot = async (id) => (await load()).find((t) => t.id === id);
const report = (e) => console.error('[BagFlow]', e);
async function directoryPermission(id) {
  const { dirs = [] } = await chrome.storage.local.get('dirs');
  if (dirs.some((d) => d.id === id && d.backend === 'browser')) return 'granted';
  return DirStore.permission(await DirStore.get(id));
}
let offChain = Promise.resolve();
function ensureOffscreen() {
  const p = offChain.then(async () => {
    if (!(await chrome.offscreen.hasDocument())) await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'], justification: '流式下载并写入所选目录，报告下载进度',
    });
  });
  offChain = p.catch(() => {}); return p;
}
async function getLookups() {
  const { lookups } = await chrome.storage.local.get('lookups');
  if (lookups?.reasons && Date.now() - lookups.at < 86400000) return lookups;
  const data = await API.lookups(); await chrome.storage.local.set({ lookups: data }); return data;
}
async function createTask(p) {
  const filters = Object.fromEntries(['truck_no', 'mine_code', 'bag_type', 'break_source'].map((k) => [k, C.text(p[k])]));
  if (!filters.truck_no || !filters.mine_code || !filters.bag_type) throw new Error('请在网页中选择车辆编号、矿区和包类型');
  if (!C.validTime(p.start) || !C.validTime(p.end) || p.start > p.end) throw new Error('时间范围无效');
  const operations = p.operations ? { transfer: p.operations.transfer === true, download: p.operations.download === true } : { transfer: p.kind === 'transfer', download: true };
  if (!operations.transfer && !operations.download) throw new Error('请选择回传或下载');
  const pathDirectory = p.operations && p.directory_mode === 'path';
  const directDirectory = p.operations && (p.directory_mode === 'selected' || pathDirectory);
  const requestedPath = operations.download ? DirPaths.normalize(p.download_path) : '';
  if (pathDirectory && operations.download && !requestedPath) throw Error('请填写完整的本地保存路径');
  const kind = operations.transfer ? 'transfer' : 'download';
  if (kind === 'transfer' && filters.break_source && filters.break_source !== 'mdc') {
    throw new Error('MDC 新建回传的任务来源固定为 mdc，请在网页中选 mdc 或不限；下载任务支持所有来源');
  }
  const { dirs = [], taskDirectoryBindings = {}, taskDirectoryHistory = [], tasks = [] } = await chrome.storage.local.get(['dirs', 'taskDirectoryBindings', 'taskDirectoryHistory', 'tasks']);
  const dir = operations.download ? (pathDirectory ? TaskDirectories.pathDirectory(requestedPath, taskDirectoryBindings, dirs, taskDirectoryHistory, tasks) : directDirectory || !p.operations ? dirs.find(d => d.id === p.dir_id && (!directDirectory || d.backend !== 'browser')) : await ensureBrowserDirectory()) : null;
  if (pathDirectory && operations.download && dir?.id !== p.dir_id) throw Error('此完整路径尚未绑定对应目录，请首次创建时选择该目录并允许写入');
  if (operations.download && (!dir || await directoryPermission(dir.id) !== 'granted')) throw new Error('保存目录不可用，请核查目录授权');
  const lk = await getLookups().catch(() => ({ mines: {}, reasons: [] }));
  if (kind === 'transfer' && !lk.reasons.some((r) => String(r.value) === p.reason)) throw new Error('请选择有效的回传原因');
  const browserPath = operations.download && dir?.backend === 'browser' ? await browserCurrentDirectory() : '';
  if (browserPath) await directoryLocked(async () => {
    const { dirs = [] } = await chrome.storage.local.get('dirs');
    const current = dirs.find(d => d.id === dir.id); if (current) { current.path = browserPath; await chrome.storage.local.set({ dirs }); }
  });
  const targetPath = browserPath ? TaskDirectories.resolve(browserPath, requestedPath) : operations.download ? (p.download_path == null ? dir?.displayPath || dir?.path || '' : requestedPath) : '';
  if (directDirectory && operations.download && targetPath) {
    const name = DirPaths.leaf(targetPath), windows = /^[a-z]:\\|^\\\\/i.test(targetPath);
    if (windows ? name.toLowerCase() !== dir.name.toLowerCase() : name !== dir.name) throw Error(`完整路径应以所选目录「${dir.name}」结尾；请核查对应的实际目录`);
  }
  const t = { id: newId(), kind, operations, transferEnabled: operations.transfer, transferControlRevision: 0, transferBatchIds: [], transferControlRecords: [],
    coverageMode: 'interval', strictFilenameTime: true, name: `${filters.truck_no} · ${filters.bag_type}`, filters,
    mineName: lk.mines[filters.mine_code] || filters.mine_code, start: p.start, end: p.end,
    reason: p.reason || '', bugId: C.text(p.bug_id), remarks: C.text(p.remarks),
    dirId: dir?.id || '', dirName: dir?.name || '', dirPath: targetPath, directorySnapshot: !!directDirectory && operations.download, downloadBackend: dir?.backend === 'browser' ? 'browser' : 'directory', directoryBlocked: false, browserRelativeDir: '', status: 'ready', items: [], transfers: [], runToken: '',
    createdAt: Date.now(), updatedAt: Date.now(), message: '已创建，点击「执行」开始', events: [],
  };
  await locked(async () => {
    const ts = await load(); ts.push(t);
    const { taskTransferSelections = {} } = await chrome.storage.local.get('taskTransferSelections');
    const data = { tasks: ts, taskTransferSelections: { ...taskTransferSelections,
      [t.id]: { enabled: t.transferEnabled, revision: 0, requestId: '', at: t.createdAt } } };
    if (operations.download) {
      const { taskDirectoryHistory = [] } = await chrome.storage.local.get('taskDirectoryHistory');
      if (browserPath) data.taskDirectoryHistory = TaskDirectories.remember(taskDirectoryHistory, filters, targetPath, t.createdAt);
      else {
        data.taskDirectoryHistory = [{ ...filters, path: targetPath, dir_id: dir.id, backend: 'directory', at: t.createdAt }, ...taskDirectoryHistory.filter(e => !(e.dir_id === dir.id && TaskDirectories.filterKey(e) === TaskDirectories.filterKey(filters)))].slice(0, 50);
      }
    }
    await chrome.storage.local.set(data);
  }); return t;
}
function event(t, message) {
  t.events ||= []; if (t.events.at(-1)?.message === message) return;
  t.events.push({ at: Date.now(), message }); t.events = t.events.slice(-40);
}
async function execute(id) {
  await edit(id, null, (t) => {
    if (active(t) || t.status === 'done') return;
    t.runToken = newId(); t.status = 'running'; t.message = '正在查询数据并核查时间覆盖…';
    t.queryAt = 0; t.vehicleCheckedAt = 0; t.discovered = false; t.searchReady = false; t.alert = '';
    t.localVerificationOnly = false;
    for (const i of t.items) if (i.state === 'done') i.needsValidation = true;
    for (const i of t.items) if (i.state === 'failed') { i.state = 'pending'; i.attempts = 0; }
    event(t, '执行任务');
  });
  tickTask(id).catch(report);
}
async function stopTask(id, expectedRunToken) {
  const jobs = [];
  await edit(id, null, (t) => {
    if (expectedRunToken != null && t.runToken !== expectedRunToken) throw new Error('任务状态已变化，请重新确认');
    t.runToken = newId(); t.status = 'stopped'; t.alert = '';
    for (const i of t.items) if (i.jobId) {
      jobs.push({ jobId: i.jobId, browserId: i.browserDownloadId, backend: t.downloadBackend }); browserTrackedJobs.delete(i.jobId); i.jobId = null; i.state = 'pending'; i.overwrite = true; i.attempts = Math.max(0, i.attempts - 1);
    }
    t.message = '已停止本地调度与下载；服务器回传由「回传」开关独立控制，再次执行会先核对结果'; event(t, t.message);
  });
  await Promise.allSettled(jobs.map((job) => job.backend === 'browser' ? browserDownloadCancel(job.browserId) : chrome.runtime.sendMessage({ type: 'offscreen:cancel', jobId: job.jobId })));
  await Promise.allSettled(jobs.filter(job => job.backend === 'browser' && job.browserId != null).map(job => DownloadUi.releaseJob(job.jobId)));
  await publishAlerts();
  wakeBrowserDownloads().catch(report);
}
async function deleteTask(id, expectedRunToken) {
  const jobs = [];
  await locked(async () => {
    const tasks = await load(), task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (expectedRunToken != null && task.runToken !== expectedRunToken) throw new Error('任务状态已变化，请重新确认');
    jobs.push(...task.items.filter((i) => i.jobId || (task.downloadBackend === 'browser' && i.state !== 'done' && i.browserDownloadId != null)).map((i) => ({ jobId: i.jobId, browserId: i.browserDownloadId, backend: task.downloadBackend })));
    for (const i of task.items) browserTrackedJobs.delete(i.jobId);
    const { taskTransferSelections = {} } = await chrome.storage.local.get('taskTransferSelections');
    delete taskTransferSelections[id];
    await chrome.storage.local.set({ tasks: tasks.filter((t) => t.id !== id), taskTransferSelections });
  });
  await Promise.allSettled(jobs.map((job) => job.backend === 'browser' ? browserDownloadCancel(job.browserId, true) : chrome.runtime.sendMessage({ type: 'offscreen:cancel', jobId: job.jobId })));
  await Promise.allSettled(jobs.filter(job => job.backend === 'browser' && job.browserId != null).map(job => DownloadUi.releaseJob(job.jobId)));
  await publishAlerts();
  wakeBrowserDownloads().catch(report);
}
async function changeDirectory(id, dirId) {
  const browserIds = [];
  const { dirs = [] } = await chrome.storage.local.get('dirs');
  const dir = dirs.find((d) => d.id === dirId);
  if (!dir || await directoryPermission(dirId) !== 'granted') throw new Error('当前目录尚未授权');
  await edit(id, null, (t) => {
    if (active(t)) throw new Error('请先停止任务再更换目录');
    if (t.dirId === dirId) return;
    if (t.downloadBackend === 'browser') browserIds.push(...t.items.filter((i) => i.state !== 'done' && i.browserDownloadId != null).map((i) => i.browserDownloadId));
    t.dirId = dirId; t.dirName = dir.name; t.dirPath = dir.displayPath || dir.path || ''; t.downloadBackend = dir.backend === 'browser' ? 'browser' : 'directory';
    // 完成记录属于旧目录；换目录后重新核对本地文件。
    for (const i of t.items) {
      Object.assign(i, { state: 'pending', attempts: 0, jobId: null, overwrite: false });
      for (const key of ['browserDownloadId', 'expectedBytes', 'browserUrl', 'browserIntentAt', 'browserIntentJobId', 'downloadPath']) delete i[key];
    }
    t.status = 'ready'; t.message = '保存目录已更新，执行时会检查新目录中的文件';
  });
  await Promise.allSettled(browserIds.map((id) => browserDownloadCancel(id, true)));
}
async function fillMissingTaskPaths(dirId, path) {
  if (!path) return;
  await locked(async () => {
    const tasks = await load(); let changed = false;
    for (const t of tasks) if (t.dirId === dirId && !t.dirPath && !t.directorySnapshot) { t.dirPath = path; changed = true; }
    if (changed) await save(tasks);
  });
}
async function authorizeDirectory(dirId) {
  if (await DirStore.permission(await DirStore.get(dirId)) !== 'granted') throw new Error('保存目录仍未获得写入权限，请在浏览器授权提示中允许');
  const directoryKey = directoryWriteKeys.get(dirId) || dirId;
  directoryCheckCache.delete(directoryKey);
  directoryAuthorizationEpoch.set(directoryKey, (directoryAuthorizationEpoch.get(directoryKey) || 0) + 1);
  const ids = await locked(async () => {
    const tasks = await load(), ids = [];
    const key = directoryWriteKeys.get(dirId) || dirId;
    for (const t of tasks) if ((directoryWriteKeys.get(t.dirId) || t.dirId) === key) {
      t.directoryBlocked = false; delete t.directoryAccess;
      if (active(t)) { t.message = '目录已授权，正在恢复下载'; ids.push(t.id); }
    }
    await save(tasks); return ids;
  });
  // 授权后立即恢复共享同一目录的活动队列，不更换运行代次或清空进度。
  ids.forEach((id) => { kick(id).catch(report); tickTask(id).catch(report); });
  return ids.length;
}
// 各网络操作独立占位，MDC 长时间 loading 不会阻塞车辆检测和下载。
const operations = new Map();
function once(key, fn) {
  if (operations.has(key)) return operations.get(key);
  const p = fn().finally(() => operations.delete(key)); operations.set(key, p); return p;
}
function setDirectoryAccess(t, access, confirmed = false) {
  const previous = t.lastDirectoryFailure || t.directoryAccess, wasBlocked = DirectoryHealth.blocked(t);
  t.directoryBlocked = access.state === 'permission';
  if (access.state === 'granted') {
    delete t.directoryAccess;
    if (confirmed && previous) { t.message = '保存目录已恢复，自动继续下载'; event(t, t.message); delete t.lastDirectoryFailure; }
    else if (wasBlocked) t.message = '目录检查已通过，继续处理原任务';
    return;
  }
  const retryDelay = access.code === 'DIRECTORY_RESTORE_PENDING' ? 5000 : access.state === 'permission' ? 60000 : 30000;
  t.directoryAccess = { ...access, checkedAt: Date.now(), retryAt: Date.now() + retryDelay };
  t.lastDirectoryFailure = { ...access };
  t.message = access.message;
  if (!previous || previous.state !== access.state || previous.code !== access.code || previous.permission !== access.permission || previous.detail !== access.detail || previous.errorCode !== access.errorCode || previous.restoreError?.code !== access.restoreError?.code) {
    const diagnostic = [access.code, access.permission && `权限=${access.permission}`, access.errorCode, access.detail,
      access.restoreError && `后台恢复=${access.restoreError.code}：${access.restoreError.message}`].filter(Boolean).join('；');
    event(t, `${access.message}（${diagnostic}）`);
  }
  if (access.code === 'DIRECTORY_RESTORE_PENDING') {
    const id = t.id, token = t.runToken;
    setTimeout(() => snapshot(id).then(s => { if (s && active(s) && s.runToken === token) return kick(id); }).catch(report), retryDelay);
  }
}
async function readDirectoryAccess(dirId, verify = false) {
  const key = directoryWriteKeys.get(dirId) || dirId, cached = directoryCheckCache.get(key);
  if (cached && Date.now() - cached.at < 3000 && (!verify || cached.verify)) return cached.access;
  return once(`directory:${key}`, async () => {
    const epoch = directoryAuthorizationEpoch.get(key) || 0;
    let access = await DirectoryHealth.check(DirStore, dirId);
    if (access.state !== 'granted' || verify) {
      // 在实际写入文档中重查，避免 worker 的临时读取失败误报，并尝试恢复持久授权。
      let timer;
      try {
        await ensureOffscreen();
        const r = await Promise.race([
          chrome.runtime.sendMessage({ type: 'offscreen:directory', dirId, verify }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('目录检查超时')), 10000); }),
        ]);
        access = r?.ok && r.access ? r.access : DirectoryHealth.failure('DIRECTORY_CHECK_FAILED', r?.error || '目录检查未返回');
      } catch (e) { access = DirectoryHealth.failure('DIRECTORY_CHECK_FAILED', e); }
      finally { clearTimeout(timer); }
    }
    // 授权成功后，较早开始的检查不能再次把任务标为受阻。
    if ((directoryAuthorizationEpoch.get(key) || 0) !== epoch) access = await DirectoryHealth.check(DirStore, dirId);
    directoryCheckCache.set(key, { at: Date.now(), verify, access });
    return access;
  });
}
async function refreshTaskDirectory(t) {
  if (t.directoryAccess?.retryAt > Date.now()) return false;
  const access = await readDirectoryAccess(t.dirId, t.directoryAccess?.state === 'unavailable');
  let allowed = false;
  await edit(t.id, t.runToken, (s) => {
    if (s.items.some(i => i.jobId)) return;
    setDirectoryAccess(s, access); allowed = access.state === 'granted';
  });
  return allowed;
}
function applyCoverage(task, plan, quiet = false) {
  task.coverage = { complete: plan.complete, targets: plan.targets, issues: plan.issues, evidence: plan.evidence, provisional: plan.provisional, excluded: plan.excluded, coveredStart: plan.coveredStart, coveredEnd: plan.coveredEnd };
  for (const i of [...task.items, ...task.transfers]) {
    if (plan.excluded?.includes(i.filename)) i.coverageExcluded = true;
    else if (plan.targets.includes(i.filename)) delete i.coverageExcluded;
  }
  for (const e of task.events || []) if (e.message.startsWith('末包 ') && plan.excluded?.some(name => e.message.includes(C.shortFilename(name)))) e.coverageCorrected = true;
  if (C.wantsDownload(task) && task.archiveCatalog) {
    const targets = new Map(plan.selected.map(r => [r.filename, r]));
    C.mergeDownloads(task, task.archiveCatalog.filter(r => targets.has(r.filename)).map(r => ({ ...r, recordingEnd: targets.get(r.filename).recordingEnd })));
  }
  const checkingTail = plan.issues.length && plan.issues.every(i => ['END_UNKNOWN','START_UNKNOWN'].includes(i.code) && task.archiveCatalog?.some(r => r.filename === i.filename && r.dirpath)) && (task.recordingPending || !task.recordingCheckedAt);
  const waitingForMdc = C.wantsTransfer(task) && !task.discovered && !plan.complete;
  task.coverageAlert = quiet || checkingTail || waitingForMdc ? '' : plan.issues.map(i => i.message).join('\n');
  if (plan.complete && task.message === '时间覆盖尚未确认，持续核查目标数据包') task.message = '时间覆盖已确认，持续核查目标数据包';
  task.coverageCheckedAt = Date.now();
}
async function notifyCoverage(id) {
  let message;
  await locked(async () => {
    const tasks = await load(), t = tasks.find(t => t.id === id);
    if (!t || !active(t) || t.localVerificationOnly) return;
    if (t.coverageAlert && t.coverageNotified !== t.coverageAlert) {
      t.coverageNotified = t.coverageAlert; message = `${t.name}：${t.coverageAlert}`; event(t, t.coverageAlert); await save(tasks);
    } else if (!t.coverageAlert && t.coverageNotified) { t.coverageNotified = ''; await save(tasks); }
  });
  if (message) await chrome.notifications.create('coverage:' + id, { type: 'basic', iconUrl: 'icons/alert.png', title: '数据包时间覆盖告警', message: message.slice(0, 900), priority: 2 }).catch(report);
  await publishAlerts();
}
async function scanSearch(t) {
  return once(`search:${t.id}`, async () => {
    try {
      const rows = await API.search(t);
      await edit(t.id, t.runToken, (s) => {
        let selected = rows;
        if (s.coverageMode === 'interval') {
          s.archiveCatalog = BagCoverage.catalog(rows, s);
          const plan = BagCoverage.plan([...(s.mdcCatalog || []), ...s.archiveCatalog], s);
          applyCoverage(s, plan, C.wantsTransfer(s) && !s.discovered && !plan.complete);
          const byName = new Map(plan.selected.map(r => [r.filename, r]));
          selected = rows.filter(r => byName.has(r.filename) || s.legacySelectedFilenames?.includes(r.filename)).map(r => ({ ...r, recordingEnd: byName.get(r.filename)?.recordingEnd || '' }));
        }
        if (C.wantsDownload(s)) C.mergeDownloads(s, selected);
        s.queryAt = Date.now(); s.searchReady = true; s.searchError = '';
        const known = new Set([...(s.coverage?.targets || []), ...(s.legacySelectedFilenames || [])]);
        const found = new Set(rows.filter(r => C.matches(r, s, false, s.coverageMode === 'interval' ? known : null)).map(r => r.filename));
        for (const i of s.transfers) if (found.has(i.filename)) { i.state = 'done'; i.percentage = 100; i.error = ''; }
      });
      await notifyCoverage(t.id);
      confirmRecordingEnd(t.id).catch(report);
      await kick(t.id);
    } catch (e) { await edit(t.id, t.runToken, (s) => { s.searchError = `查询失败，自动重试：${e.message}`; }); }
  });
}
async function confirmRecordingEnd(id) {
  return once(`recording-end:${id}`, async () => {
    const t = await snapshot(id);
    if (!t || !active(t) || t.coverageMode !== 'interval' || t.localVerificationOnly) return;
    const issue = t.coverage?.issues?.find(i => ['END_UNKNOWN','START_UNKNOWN'].includes(i.code));
    const row = t.archiveCatalog?.find(r => r.filename === issue?.filename && r.dirpath);
    if (!row || Date.now() - (t.recordingCheckedAt || 0) < 60000) return;
    await edit(id, t.runToken, s => { s.recordingCheckedAt = Date.now(); s.recordingPending = true; });
    try {
      const bounds = await BagHeader.read(row);
      await edit(id, t.runToken, s => {
        s.recordingBounds ||= {}; s.recordingBounds[row.filename] = bounds; s.recordingError = ''; s.recordingPending = false;
        applyCoverage(s, BagCoverage.plan([...(s.mdcCatalog || []), ...(s.archiveCatalog || [])], s));
      });
      await notifyCoverage(id); await kick(id); await finish(id);
    } catch (e) {
      await edit(id, t.runToken, s => {
        s.recordingError = `末包文件头核查失败，稍后重试：${e.message}`; s.recordingPending = false;
        applyCoverage(s, BagCoverage.plan([...(s.mdcCatalog || []), ...(s.archiveCatalog || [])], s));
      });
      await notifyCoverage(id);
    }
  });
}
async function scanVehicle(t) {
  return once(`vehicle:${t.id}`, async () => {
    let online = false, message;
    try {
      const trucks = await API.trucks(t.filters.mine_code), v = trucks.find((r) => String(r.value) === t.filters.truck_no);
      online = v?.status === true;
      message = v ? (v.connect_msg || (online ? 'MDC、NAS 在线' : 'MDC 或 NAS 不可用')) : '目标矿区中未找到该车辆';
    } catch (e) { message = `无法确认车辆状态：${e.message}`; }
    let notify = false;
    await edit(t.id, t.runToken, (s) => {
      const previous = s.vehicleOnline;
      notify = !online && (!s.alert || previous === true);
      s.vehicleOnline = online; s.vehicleMessage = message; s.vehicleCheckedAt = Date.now();
      s.status = online ? 'running' : 'waiting_vehicle'; s.alert = online ? '' : message;
      if (previous !== online || notify) event(s, online ? C.isTransferEnabled(s) ? '车辆恢复在线，自动继续回传' : '车辆恢复在线，回传开关仍关闭' : message);
    });
    if (notify) await notifyAlert(t.id, `${t.name}：${message}`);
    await publishAlerts();
  });
}
async function discover(t) {
  return once(`mdc:${t.id}`, async () => {
    try {
      await edit(t.id, t.runToken, (s) => { s.transferMessage = '正在加载车辆数据清单…'; });
      // 车辆清单可耗时超过 Chrome service worker 单次 fetch 的 30 秒上限。
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({ type: 'offscreen:mdc', task: { filters: t.filters } });
      if (!result?.ok) throw new Error(result?.error || '车辆清单请求未返回');
      const rows = result.rows;
      await edit(t.id, t.runToken, (s) => {
        s.discovered = true; s.discoveryError = '';
        let selected = rows;
        if (s.coverageMode === 'interval') {
          s.mdcCatalog = BagCoverage.catalog(rows, s, true); s.mdcCheckedAt = Date.now();
          const plan = BagCoverage.plan([...s.mdcCatalog, ...(s.archiveCatalog || [])], s);
          applyCoverage(s, plan); selected = plan.selected;
        }
        C.mergeTransfers(s, selected);
        s.transferMessage = `已筛选 ${s.transfers.length} 个包，按录制时间升序回传`;
        const found = new Set([...(s.archiveCatalog || []).map(r => r.filename), ...s.items.map(i => i.filename)]), onMdc = new Set(rows.map(r => r.filename));
        for (const i of s.transfers) {
          if (s.coverageMode === 'interval') i.mdcPresent = onMdc.has(i.filename);
          if (found.has(i.filename)) { i.state = 'done'; i.percentage = 100; }
        }
      });
      await notifyCoverage(t.id);
      const latest = await snapshot(t.id);
      if (latest && active(latest) && latest.runToken === t.runToken) await driveTransfer(latest);
      await kick(t.id); await finish(t.id);
    } catch (e) { await edit(t.id, t.runToken, (s) => { s.discoveryError = `加载车辆清单失败，自动重试：${e.message}`; }); }
  });
}
function marker(t, i) {
  return TransferSwitch.marker(t, i);
}
const transferControlWakes = new Set();
function readTransferRecords(t) { return once(`records-query:${t.id}`, () => API.records(t)); }
async function setTransferChoice(id, enabled, requestId = '') {
  if (typeof enabled !== 'boolean') throw new Error('回传开关状态无效');
  if (requestId && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))) throw new Error('回传选择请求编号无效');
  const selection = await locked(async () => {
    const { tasks = [], taskTransferSelections = {} } = await chrome.storage.local.get(['tasks', 'taskTransferSelections']);
    const ts = tasks.map(t => C.normalizeTask(C.applyTransferSelection(t, taskTransferSelections[t.id]))), t = ts.find(t => t.id === id);
    if (!t) throw new Error('任务不存在');
    if (!C.wantsTransfer(t)) throw new Error('仅下载任务没有可控制的回传');
    if (t.transferEnabled !== enabled) {
      t.transferEnabled = enabled; t.transferControlRevision++;
      t.transferControl = { enabled, revision: t.transferControlRevision, phase: 'pending', nextCheckAt: 0,
        message: enabled ? '正在恢复本任务回传…' : '已取消勾选，正在暂停本任务原回传记录…' };
      event(t, enabled ? '开启回传：恢复原记录，继续追加未提交数据包' : '暂停回传：保留本任务原记录，不再追加新回传');
    }
    const choice = { enabled, revision: t.transferControlRevision, requestId: requestId || newId(), at: Date.now() };
    t.updatedAt = Date.now();
    // 用户选择独立保存。进度、车辆状态或旧任务快照不能把暂停选择重置为默认开启。
    await chrome.storage.local.set({ tasks: ts, taskTransferSelections: { ...taskTransferSelections, [id]: choice } });
    return choice;
  });
  // 用户的选择先落盘并立即返回；远端慢请求不妨碍再切换、停止本地任务或关闭侧栏。
  reconcileTransferControl(id, true).catch(report);
  if (enabled) tickTask(id).catch(report);
  return selection;
}
async function setTransferEnabled(id, enabled) { return (await setTransferChoice(id, enabled)).enabled; }
async function commandTransferRecord(id, row, revision) {
  const recordNo = TransferSwitch.recordId(row.record_no); let plan;
  await edit(id, null, (t) => {
    if (t.transferControlRevision !== revision || !TransferSwitch.owns(t, row)) return;
    const entry = t.transferControlRecords.find(r => r.recordNo === recordNo), enabled = C.isTransferEnabled(t);
    if (!entry || !TransferSwitch.needsCommand(enabled, entry.status) ||
        (entry.commandRevision === revision && entry.commandEnabled === enabled && Date.now() < (entry.retryAt || 0))) return;
    const attempts = entry.commandRevision === revision && entry.commandEnabled === enabled ? (entry.attempts || 0) + 1 : 1;
    Object.assign(entry, { commandId: newId(), commandRevision: revision, commandEnabled: enabled, commandAt: Date.now(),
      attempts, retryAt: Date.now() + TransferSwitch.delay(attempts), pending: true, error: '', acknowledged: false });
    plan = { recordNo, enabled, commandId: entry.commandId, attempts };
  });
  if (!plan) return false;
  const latest = await snapshot(id);
  if (!latest || latest.transferControlRevision !== revision || C.isTransferEnabled(latest) !== plan.enabled) return false;
  let error;
  try { await (plan.enabled ? API.resumeTransfer(plan.recordNo) : API.pauseTransfer(plan.recordNo)); }
  catch (e) { error = e; }
  // 已发出请求必须记录真实结果。用户此时反向切换，由下一次查询补偿，不能覆盖新选择。
  await edit(id, null, (t) => {
    const entry = t.transferControlRecords.find(r => r.recordNo === plan.recordNo);
    if (!entry || entry.commandId !== plan.commandId) return;
    entry.acknowledged = !error; entry.error = error?.message || ''; entry.pending = true;
    entry.retryAt = Date.now() + (error ? TransferSwitch.delay(plan.attempts) : 30000);
    if (error) event(t, `回传${plan.enabled ? '恢复' : '暂停'}失败，将自动重试：${error.message}`);
  });
  return true;
}
function reconcileTransferControl(id, force = false) {
  if (force) transferControlWakes.add(id);
  return once(`transfer-control:${id}`, async () => {
    let verify = false;
    // 每次写后重新查服务器；快速反向切换则按新代次补偿，不并发向同一记录发送相反命令。
    for (let round = 0; round < 4; round++) {
      const requested = transferControlWakes.delete(id), t = await snapshot(id);
      if (!t || !C.wantsTransfer(t) || !t.transferControlRevision) return;
      if (!requested && !verify && !TransferSwitch.needsSync(t, Date.now())) return;
      const revision = t.transferControlRevision; let records;
      if (t.transferControl?.phase !== 'settled' || t.transferControl?.revision !== revision) {
        await edit(id, null, s => { if (s.transferControlRevision === revision && s.transferControl) s.transferControl.phase = 'checking'; });
      }
      // 不能复用在命令发出前已开始的进度查询；它可能在写请求之后才返回旧状态。
      try { records = await API.records(t); }
      catch (e) {
        await edit(id, null, (s) => {
          if (s.transferControlRevision !== revision) return;
          const error = `记录核对失败：${e.message}`;
          s.transferControl = { ...s.transferControl, enabled: C.isTransferEnabled(s), revision, phase: 'retry', error,
            message: `回传${C.isTransferEnabled(s) ? '恢复' : '暂停'}未完成，自动重试：${error}`, nextCheckAt: Date.now() + 30000 };
          event(s, s.transferControl.message);
        });
        const current = await snapshot(id);
        if (current && (current.transferControlRevision !== revision || transferControlWakes.has(id))) { verify = true; continue; }
        return;
      }
      let commands;
      await edit(id, null, (s) => {
        if (s.transferControlRevision !== revision) return;
        commands = TransferSwitch.synchronize(s, records, Date.now());
        if (commands.length) s.transferControl.phase = 'pending';
        for (const i of s.transfers) if (!i.coverageExcluded && i.state !== 'done') {
          const r = findRecord(s, i, records);
          if (r && (r.exact || r.ownBatch) && TransferSwitch.owns(s, r)) applyTransferRecord(s, i, r);
        }
      });
      if (!commands) { verify = true; continue; }
      let sent = false;
      for (let n = 0; n < commands.length; n += 4) {
        const results = await Promise.allSettled(commands.slice(n, n + 4).map(r => commandTransferRecord(id, r, revision)));
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          sent ||= result.value;
        }
        const current = await snapshot(id);
        if (!current || current.transferControlRevision !== revision) break;
      }
      const current = await snapshot(id);
      verify = sent || !!(current && current.transferControlRevision !== revision);
      if (!verify && !transferControlWakes.has(id)) return;
    }
    // 连续切换超出本轮时留给下一轮，持久开关和命令记录也可在 worker 重启后恢复。
    await edit(id, null, t => { if (t.transferControl) t.transferControl.nextCheckAt = 0; });
    setTimeout(() => reconcileTransferControl(id, true).catch(report), 0);
  });
}
function isTransferCapacityError(message) {
  return /\/api\/bag\/mdcadd[:：]\s*车辆回传任务较多/.test(message || '');
}
function queueTransferRetry(i, now) {
  // 仅用于服务器明确拒绝的容量限制；超时或未知结果仍保留提交锁。
  i.state = 'pending'; i.submissionLocked = false; i.accepted = false; i.submissionRejected = true;
  i.batchId = null; i.submittedAt = 0; i.recordNo = null; i.percentage = 0;
  delete i.serverStatus;
  i.capacityRetries = Math.min(5, (i.capacityRetries || 0) + 1);
  i.retryAt = now + Math.min(300000, 30000 * 2 ** (i.capacityRetries - 1));
  i.error = '车辆回传队列已满，稍后自动重试';
}
function clearTransferRetry(i) {
  delete i.retryAt; delete i.capacityRetries; delete i.submissionRejected;
}
function findRecord(t, i, records) {
  const relevant = records.filter((r) => String(r.truck_no) === t.filters.truck_no && r.break_source === 'mdc');
  const exact = relevant.filter((r) => C.text(r.remarks).includes(marker(t, i)) || r.filename === i.filename ||
    C.text(r.msg).includes(i.filename));
  // 后一次重复提交的失败不能覆盖已有的正常回传/成功记录。
  const rank = { succeed: 6, downloading: 5, waiting: 4, cancelpause: 3, pause: 2, failed: 1 };
  if (exact.length) return { ...exact.sort((a, b) => (rank[b.status] || 0) - (rank[a.status] || 0) || Number(b.record_no) - Number(a.record_no))[0], exact: true };
  const activeRecords = relevant.filter((r) => ['waiting', 'downloading', 'pause', 'cancelpause'].includes(r.status));
  const batch = activeRecords.find((r) => !r.filename && i.batchId && C.text(r.remarks).includes(`[BagFlowBatch:${i.batchId}]`) &&
    C.text(r.breaktime).slice(0, 16) === i.create_time.slice(0, 16));
  if (batch) {
    const peers = t.transfers.filter((x) => x.batchId === i.batchId && x.create_time.slice(0, 16) === i.create_time.slice(0, 16));
    return { ...batch, exact: peers.length === 1, ownBatch: true };
  }
  // 只有尚未公布文件名的活动记录需要按分钟保守等待。
  return activeRecords.find((r) => !r.filename &&
    C.text(r.breaktime).slice(0, 16) === i.create_time.slice(0, 16)) || null;
}
function applyTransferRecord(t, i, r) {
  i.submissionLocked = true; i.accepted = true; i.serverStatus = r.status; clearTransferRetry(i);
  if (r.exact) {
    if (r.status !== 'failed') i.coverageMissing = false;
    else if (/包.*不存在|包.*已删除|file.*not found|no such file/i.test(C.text(r.msg))) i.coverageMissing = true;
    i.recordNo = r.record_no;
    const progress = r.percentage == null ? i.percentage : r.percentage;
    i.percentage = r.status === 'succeed' && !C.wantsDownload(t) ? 100 : Math.min(99, Math.max(0, Number(progress) || 0));
    i.state = r.status === 'succeed' ? (C.wantsDownload(t) ? 'confirming' : 'done') : r.status === 'failed' ? 'server_failed' : 'submitted';
  } else i.state = 'submitted';
  i.error = r.status === 'failed' ? C.text(r.msg) || '服务器回传异常，持续核查' : r.status === 'pause' ? '服务器已暂停，持续核查' : '';
}
async function refreshTransferProgress(t, records) {
  const ids = [...new Set(t.transfers.filter((i) => i.state !== 'done').map((i) => findRecord(t, i, records))
    .filter((r) => r?.exact && r.status === 'downloading').map((r) => r.record_no))];
  if (!ids.length) return;
  const start = (Math.floor(Date.now() / POLL_MS) * 4) % ids.length;
  await Promise.allSettled(Array.from({ length: Math.min(4, ids.length) }, (_, n) => ids[(start + n) % ids.length]).map(async (id) => {
    const value = await API.post('/api/bag/progress/' + encodeURIComponent(id), {}, [200, 2000, 20000]);
    if (!Number.isFinite(Number(value))) return;
    await edit(t.id, t.runToken, (s) => {
      for (const i of s.transfers) if (i.recordNo === id && i.state !== 'done') i.percentage = Math.min(99, Math.max(0, Number(value)));
    });
  }));
}
async function submitTransferBatch(t, keys) {
  const batchId = newId(); let plan;
  await edit(t.id, t.runToken, (s, all) => {
    if (!C.isTransferEnabled(s) || !s.vehicleOnline || Date.now() - s.vehicleCheckedAt > 45000 || !s.searchReady || s.searchError) return;
    // 容量按矿区和车辆共享；同车的其他任务也等待，其他车辆继续提交。
    if (all.some((other) => other.filters.truck_no === s.filters.truck_no && other.filters.mine_code === s.filters.mine_code && other.transferRetryAt > Date.now())) return;
    const items = s.transfers.filter((i) => !i.coverageExcluded && keys.includes(i.key) && i.state === 'pending' && !i.submissionLocked && i.mdcPresent !== false && Date.now() >= (i.retryAt || 0) &&
      !all.some((other) => other.id !== s.id && other.filters.truck_no === s.filters.truck_no && other.filters.mine_code === s.filters.mine_code &&
        other.transfers.some((x) => C.fileKey(x) === C.fileKey(i) && x.submissionLocked)));
    if (!items.length) return;
    for (const i of items) {
      i.state = 'submitting'; i.submissionLocked = true; i.attempts = (i.attempts || 0) + 1;
      i.batchId = batchId; i.submittedAt = Date.now(); i.error = '';
    }
    s.transferBatchIds.push(batchId);
    s.transferMessage = `批量提交 ${items.length} 个包`;
    plan = { task: structuredClone(s), items: structuredClone(items) };
  });
  if (!plan) return;
  const latest = await snapshot(t.id);
  if (!latest || !active(latest) || latest.runToken !== t.runToken || !C.isTransferEnabled(latest) || !latest.vehicleOnline || Date.now() - latest.vehicleCheckedAt > 45000) {
    // 请求尚未发出时可恢复待提交；已发出且结果不明的请求保留提交锁。
    await edit(t.id, null, (s) => {
      for (const i of s.transfers) if (i.batchId === batchId && i.state === 'submitting') {
        i.state = 'pending'; i.submissionLocked = false; i.attempts = Math.max(0, i.attempts - 1); i.submittedAt = 0; i.batchId = null;
      }
    });
    reconcileTransferControl(t.id, true).catch(report); return;
  }
  let error;
  try {
    const tag = plan.items.length === 1 ? marker(plan.task, plan.items[0]) : `[BagFlowBatch:${batchId}]`;
    await API.submitBatch({ ...plan.task, remarks: `${plan.task.remarks || ''} ${tag} [BagFlowTask:${plan.task.id}]`.trim() }, plan.items);
  } catch (e) { error = e; }
  // 即使用户停止或插件轮次改变，仍保留已经发出请求的真实结果，不改任务运行状态。
  const capacityRejected = error?.rejected === true && isTransferCapacityError(error.message);
  await edit(t.id, null, (s) => {
    if (capacityRejected) s.transferRetryAt = Date.now() + 30000;
    for (const i of s.transfers) if (i.batchId === batchId && i.state !== 'done') {
      if (!error) { i.accepted = true; i.state = 'submitted'; i.error = ''; clearTransferRetry(i); }
      else if (capacityRejected && !i.accepted) queueTransferRetry(i, Date.now());
      else if (!i.accepted) {
        i.submissionRejected = error.rejected === true;
        i.state = 'uncertain'; i.error = `请求待核对：${error.message}`;
        if (/包.*不存在|包.*已删除|file.*not found|no such file/i.test(error.message)) i.coverageMissing = true;
      }
    }
    if (s.coverageMode === 'interval' && s.transfers.some(i => i.coverageMissing)) applyCoverage(s, BagCoverage.plan([...(s.mdcCatalog || []), ...(s.archiveCatalog || [])], s));
    if (capacityRejected) s.transferMessage = '车辆回传队列已满，等待空位后自动追加';
    event(s, capacityRejected ? `车辆队列已满，${plan.items.length} 个包等待自动重试：${error.message}` :
      error ? `批量提交结果待核对（${plan.items.length} 个）：${error.message}` : `已提交 ${plan.items.length} 个包`);
  });
  // 关闭开关时已经在途的提交可能晚到；本地停止或完成后也必须补查并暂停本任务的记录。
  reconcileTransferControl(t.id, true).catch(report);
  if (error) await notifyCoverage(t.id);
  return capacityRejected;
}
async function driveTransfer(t) {
  if (!t.transfers.some((i) => i.state !== 'done')) return;
  // 车辆掉线也继续核对服务器状态；只有创建新回传需要在线。
  return once(`records:${t.id}`, async () => {
    let records;
    try { records = await readTransferRecords(t); }
    catch (e) { await edit(t.id, t.runToken, (s) => { s.transferError = `回传记录核对失败，自动重试：${e.message}`; }); return; }
    let keys = [];
    await edit(t.id, t.runToken, (s, all) => {
      s.transferError = '';
      for (const i of s.transfers) {
        if (i.coverageExcluded || i.state === 'done') continue;
        const r = findRecord(s, i, records);
        if (r?.exact || r?.ownBatch) applyTransferRecord(s, i, r);
        else if (!i.accepted && i.state === 'uncertain' && i.submissionRejected !== false &&
            i.error?.startsWith('请求待核对：') && isTransferCapacityError(i.error)) {
          // 兼容旧版把明确的容量拒绝保存为 uncertain 的任务，先核查服务器再恢复。
          queueTransferRetry(i, Date.now()); s.transferRetryAt = Date.now() + 30000;
          event(s, `恢复旧版队列容量等待：${i.filename}`);
        } else if (i.submissionLocked) {
          // 含升级前已提交/失败的包：只监测，不在车辆重新上线时重建任务。
          if (i.accepted) i.state = 'submitted';
          else if (i.state !== 'submitting' || Date.now() - (i.submittedAt || 0) > 120000) i.state = 'uncertain';
        } else if (i.state === 'pending') {
          const owner = all.some((o) => o.id !== s.id && o.filters.truck_no === s.filters.truck_no && o.filters.mine_code === s.filters.mine_code &&
            o.transfers.some((x) => C.fileKey(x) === C.fileKey(i) && x.submissionLocked));
          if (owner) i.error = '其他任务已提交此包，等待回传结果';
          else if (r) i.error = '同一分钟有活动回传，等待确认文件名';
          else if (i.mdcPresent === false) i.error = '目标包已不在车辆清单中，等待核查';
          else if (!C.isTransferEnabled(s)) i.error = '';
          else if (Date.now() >= (i.retryAt || 0)) { i.error = ''; keys.push(i.key); }
        }
      }
      const targets = s.transfers.filter(i => !i.coverageExcluded), submitted = targets.filter((i) => i.accepted || i.state === 'done').length;
      const capacityWaiting = targets.filter(i => i.state === 'pending' && i.capacityRetries).length;
      s.transferMessage = `已提交 ${submitted} / ${targets.length}，${capacityWaiting ? `${capacityWaiting} 个包等待队列空位，自动重试` : '持续核查回传状态'}`;
      if (s.coverageMode === 'interval') applyCoverage(s, BagCoverage.plan([...(s.mdcCatalog || []), ...(s.archiveCatalog || [])], s));
    });
    reconcileTransferControl(t.id).catch(report);
    await notifyCoverage(t.id);
    refreshTransferProgress(t, records).catch(report);
    startBatchSubmission(t, keys).catch(report);
  });
}
function startBatchSubmission(t, keys) {
  // 同车串行提交，慢请求仍不阻塞文件查询、服务器状态和其他车辆。
  if (!keys.length) return Promise.resolve();
  return once(`submit:${t.filters.mine_code}:${t.filters.truck_no}`, async () => {
    const current = await snapshot(t.id);
    if (!current || !active(current) || current.runToken !== t.runToken || !C.isTransferEnabled(current)) return;
    const selected = new Set(keys);
    const ordered = [...current.transfers].sort(C.sort).filter((i) => selected.has(i.key));
    const batches = [];
    let fresh = [];
    for (const i of ordered) {
      if (i.capacityRetries) {
        if (fresh.length) { batches.push(fresh); fresh = []; }
        // 拒绝过的包逐个追加，少量空位也能使用，不再等待整批容量。
        batches.push([i.key]);
      } else {
        fresh.push(i.key);
        if (fresh.length === 10) { batches.push(fresh); fresh = []; }
      }
    }
    if (fresh.length) batches.push(fresh);
    for (const batch of batches) if (await submitTransferBatch(t, batch)) break;
  });
}
function availableDownloadItem(task, tasks = []) {
  return task.items.find(i => !i.coverageExcluded && (i.state === 'pending' || i.needsValidation) && Date.now() >= (i.retryAt || 0) &&
    !tasks.some(other => sameDownloadDestination(other, task) && other.items.some(x => x.jobId && x.filename === i.filename)));
}
function networkDownloadError(code, message) {
  return ['NETWORK_RETRY', 'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN', 'SERVER_UNREACHABLE', 'SERVER_FAILED', 'TIMEOUT', 'TimeoutError', 'NetworkError'].includes(code) ||
    /Failed to fetch|fetch failed|NetworkError|network error|网络中断|网络连接|HTTP (?:5\d\d|408|429)\b/i.test(message || '');
}
async function kick(id) {
  const preview = await load(), waiting = preview.find(t => t.id === id), candidate = waiting && availableDownloadItem(waiting, preview);
  if (waiting && active(waiting) && C.wantsDownload(waiting) && waiting.downloadBackend === 'browser' &&
      !waiting.items.some(i => i.jobId) && (!candidate || !await browserLocationReady(waiting, candidate))) return;
  if (waiting && active(waiting) && C.wantsDownload(waiting) && waiting.downloadBackend !== 'browser' &&
      !waiting.items.some(i => i.jobId) && candidate && !await refreshTaskDirectory(waiting)) return;
  let step;
  await edit(id, null, (t, tasks) => {
    if (!active(t) || !C.wantsDownload(t) || DirectoryHealth.blocked(t) || t.items.some((i) => i.jobId)) return;
    const i = availableDownloadItem(t, tasks);
    if (!i) return;
    if (i.state === 'done') i.attempts = 0;
    else i.state = 'downloading';
    i.jobId = newId(); i.phaseAt = Date.now(); i.attempts++; i.error = ''; t.lastDownloadStartedAt = Date.now();
    t.message = `${i.needsValidation ? '核验本地文件' : '下载中'}：${i.filename}`;
    step = { jobId: i.jobId, taskId: t.id, runToken: t.runToken, dirId: t.dirId, dirPath: t.dirPath, apiDirpath: i.dirpath,
      filename: i.filename, overwrite: i.overwrite, filesize: i.filesize, writeDirectoryKey: directoryWriteKeys.get(t.dirId) || t.dirId, browserRelativeDir: t.browserRelativeDir };
  });
  if (!step) return;
  const queuedTask = await snapshot(id);
  if (queuedTask?.downloadBackend === 'browser') { await browserDownloadStart(step); return; }
  try {
    await ensureOffscreen();
    const t = await snapshot(id);
    if (!t || !active(t) || !t.items.some((i) => i.jobId === step.jobId)) return;
    const r = await chrome.runtime.sendMessage({ type: 'offscreen:download', ...step });
    if (!r?.ok) throw new Error(r?.error || '下载器无响应');
  } catch (e) { await onJobResult({ jobId: step.jobId, ok: false, error: e.message }); }
}
// 一个包结束后重新分配可启动的任务，优先较久未获得下载机会的任务。
let browserWakeRequested = false;
function wakeBrowserDownloads() {
  browserWakeRequested = true;
  return once('browser:wake', async () => {
    do {
      browserWakeRequested = false;
      const all = await load(), tasks = all.filter(t => active(t) && C.wantsDownload(t) && !DirectoryHealth.blocked(t) &&
        !t.items.some(i => i.jobId) && availableDownloadItem(t, all))
        .sort((a,b) => (a.lastDownloadStartedAt || 0) - (b.lastDownloadStartedAt || 0) || a.createdAt - b.createdAt);
      if (!all.some(t => active(t) && t.downloadBackend === 'browser' && t.items.some(i => i.jobId)) && tasks.some(t => t.locationWait)) browserLocationCache = null;
      for (const t of tasks) await kick(t.id);
    } while (browserWakeRequested);
  });
}
async function onJobResult(msg) {
  browserTrackedJobs.delete(msg.jobId);
  let id, directoryWaiting = false;
  await locked(async () => {
    const tasks = await load();
    for (const t of tasks) {
      const i = t.items.find((i) => i.jobId === msg.jobId);
      if (!i) continue;
      id = t.id; i.jobId = null; i.phaseAt = 0;
      if (msg.ok) {
        setDirectoryAccess(t, { state: 'granted', permission: 'granted' }, true);
        if (Number.isSafeInteger(msg.bytes) && msg.bytes > 0 && msg.bytes === msg.totalBytes) { i.bytes = msg.bytes; i.totalBytes = msg.totalBytes; }
        i.coverageMissing = false;
        i.state = 'done'; i.overwrite = false; i.skipped = !!msg.skipped; i.error = '';
        i.needsValidation = false; i.validationSession = validationSession;
        delete i.networkRetries;
        t.message = `${msg.skipped ? '已验证本地文件，跳过' : '下载完成'}：${i.filename}`;
      } else if (msg.code === 'LOCATION_WAIT') {
        directoryWaiting = true;
        if (i.state !== 'done') i.state = 'pending';
        i.error = ''; i.attempts = Math.max(0, i.attempts - 1); delete i.retryAt;
        waitForBrowserLocation(t, msg.currentDirectory || '');
      } else if (msg.code === 'STALE_DOWNLOAD_REFERENCE') {
        i.state = 'pending'; i.error = ''; i.attempts = Math.max(0, i.attempts - 1); i.retryAt = Date.now() + 3000;
        t.locationBlocked = false; delete t.locationWait; t.message = '正在原任务目录恢复下载';
      } else if (networkDownloadError(msg.code, msg.error)) {
        i.state = 'pending'; i.error = '网络暂不可用，恢复后自动继续'; i.attempts = Math.max(0, i.attempts - 1);
        i.networkRetries = Math.min(5, (i.networkRetries || 0) + 1);
        i.retryAt = Date.now() + Math.min(60000, 3000 * 2 ** (i.networkRetries - 1));
        t.message = '等待网络恢复，继续使用原任务保存目录';
      } else {
        i.overwrite = true; i.error = msg.error || '下载失败';
        if (msg.code === 'TARGET_REMOVED') i.coverageMissing = true;
        if (msg.code === 'LOCATION_CHANGED') {
          i.state = 'pending'; i.attempts = Math.max(0, i.attempts - 1); i.retryAt = Date.now() + 15000;
          t.locationBlocked = true; t.message = i.error;
        } else if (t.downloadBackend !== 'browser' && (msg.directoryAccess || ['NEED_PERMISSION', 'NO_DIR', 'DIR_NOT_FOUND', 'DIRECTORY_CHECK_FAILED', 'DIRECTORY_WRITE_DENIED', 'DIRECTORY_ENTRY_MISSING', 'NotAllowedError', 'NotFoundError'].includes(msg.code))) {
          directoryWaiting = true;
          if (i.state !== 'done') i.state = 'pending';
          i.attempts = Math.max(0, i.attempts - 1); delete i.retryAt;
          const access = msg.directoryAccess || DirectoryHealth.failure(msg.code, msg.error);
          directoryCheckCache.delete(directoryWriteKeys.get(t.dirId) || t.dirId);
          setDirectoryAccess(t, access);
        } else {
          i.state = i.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'; i.retryAt = Date.now() + 3000;
          i.needsValidation = false;
          t.message = `${i.state === 'failed' ? '下载失败' : '稍后重试'}：${i.filename} · ${i.error}`;
        }
      }
      if (!t.localVerificationOnly && t.coverageMode === 'interval') applyCoverage(t, BagCoverage.plan([...(t.mdcCatalog || []), ...(t.archiveCatalog || [])], t));
      if (!directoryWaiting) event(t, t.message);
      t.updatedAt = Date.now(); await save(tasks); break;
    }
  });
  await DownloadUi.releaseJob(msg.jobId).catch(report);
  if (id) {
    await notifyCoverage(id);
    if (!directoryWaiting) setTimeout(() => kick(id).catch(report), msg.ok ? 0 : 3100);
    await finish(id);
    // 不等待此调用：原下载的完成回调需要先返回，才能释放同路径的启动互斥锁。
    if (msg.ok) wakeBrowserDownloads().catch(report);
  }
}
async function finish(id) {
  await edit(id, null, (t) => {
    if (!active(t) || !t.searchReady || t.searchError) return;
    const items = t.items.filter(i => !i.coverageExcluded), transfers = t.transfers.filter(i => !i.coverageExcluded);
    // 失败达到重试上限时提供执行入口，覆盖仍缺失不能把失败队列困在运行态。
    if (C.wantsDownload(t) && items.some(i => i.state === 'failed') &&
        !items.some(i => i.jobId || i.needsValidation || !['done', 'failed'].includes(i.state))) {
      t.status = 'error'; t.alert = ''; t.message = '仍有下载失败，点击执行可重试；时间覆盖告警保留'; event(t, t.message); return;
    }
    if (!t.localVerificationOnly && t.coverageMode === 'interval' && !t.coverage?.complete) { t.message = '时间覆盖尚未确认，持续核查目标数据包'; return; }
    if (!t.localVerificationOnly && t.kind === 'transfer' && (!t.discovered || transfers.some((i) => !['done', 'failed'].includes(i.state)))) return;
    if (t.items.some(i => i.jobId)) return;
    if (C.wantsDownload(t) && items.some((i) => i.needsValidation || !['done', 'failed'].includes(i.state))) return;
    const failed = items.filter((i) => i.state === 'failed').length + transfers.filter((i) => ['failed', 'server_failed'].includes(i.state)).length;
    t.status = failed ? 'error' : 'done'; t.alert = '';
    if (!failed) { t.locationBlocked = false; delete t.locationWait; t.directoryBlocked = false; delete t.directoryAccess; delete t.lastDirectoryFailure; delete t.transferRetryAt; t.localVerificationOnly = false; }
    t.message = failed ? `本轮结束，${failed} 项失败；点击执行可重试` : C.wantsDownload(t) ? `已完成，下载 ${items.length} 个包` : `已完成，回传 ${transfers.length} 个包`;
    if (!items.length && !transfers.length) t.message = '所选时间段内没有符合条件的数据包';
    event(t, t.message);
  });
}
async function tickTask(id) {
  return once(`tick:${id}`, async () => {
    let t = await snapshot(id);
    if (!t || !active(t)) return;
    // 只有真正要启动文件读写时才检查目录；活动流和等待数据的任务不重复要求授权。
    const jobs = [];
    if (!t.localVerificationOnly && (t.kind === 'transfer' || !t.searchReady || (t.coverageMode === 'interval' && !t.coverage?.complete))) jobs.push(scanSearch(t));
    if (!t.localVerificationOnly && t.kind === 'transfer') jobs.push(scanVehicle(t));
    await Promise.allSettled(jobs);
    t = await snapshot(id);
    if (!t || !active(t)) return;
    if (!t.localVerificationOnly && t.kind === 'transfer') {
      if (t.vehicleOnline && (!t.discovered || (t.coverageMode === 'interval' && !t.coverage?.complete && Date.now() - (t.mdcCheckedAt || 0) >= 60000))) discover(t).catch(report);
      if (t.transfers.length) await driveTransfer(t);
    }
    await kick(id); await finish(id);
  });
}
let reconcileBusy = false;
async function reconcile() {
  if (reconcileBusy) return;
  reconcileBusy = true;
  try {
    let runningJobs = new Set();
    if (await chrome.offscreen.hasDocument()) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'offscreen:status' });
        runningJobs = r?.ok ? new Set(r.active) : null;
      } catch (_) { runningJobs = null; } // 无响应不能证明下载已中断，车辆监测仍继续。
    }
    const { ids, transferIds } = await locked(async () => {
      const tasks = await load(); let changed = false;
      for (const t of tasks) if (active(t) && t.downloadBackend !== 'browser') {
        for (const i of t.items) if (runningJobs && i.jobId && !runningJobs.has(i.jobId) && (i.phaseAt <= WORKER_STARTED_AT || Date.now() - i.phaseAt > 45000)) {
          if (i.state !== 'done') i.state = 'pending';
          i.jobId = null; i.overwrite = true; i.attempts = Math.max(0, i.attempts - 1); changed = true;
        }
      }
      if (changed) await save(tasks);
      return { ids: tasks.filter(active).map((t) => t.id), transferIds: tasks.filter(t => TransferSwitch.needsSync(t, Date.now())).map(t => t.id) };
    });
    transferIds.forEach(id => reconcileTransferControl(id).catch(report));
    once('browser:reconcile', browserDownloadReconcile).catch(report);
    ids.forEach((id) => {
      // 即便另一类接口缓慢，独立检查车辆在线状态。
      snapshot(id).then((t) => { if (t?.kind === 'transfer' && !t.localVerificationOnly && active(t)) return scanVehicle(t); }).catch(report);
      tickTask(id).catch(report);
    });
    wakeBrowserDownloads().catch(report);
    await DownloadUi.refresh().catch(report);
    await publishAlerts();
  } catch (e) { report(e); } finally { reconcileBusy = false; }
}
async function notifyAlert(id, message) {
  try { await chrome.notifications.create('vehicle:' + id, { type: 'basic', iconUrl: 'icons/alert.png',
    title: '数据包回传已暂停', message, priority: 2 }); } catch (e) { report(e); }
}
async function publishAlerts() {
  const tasks = await load(), alerts = tasks.filter((t) => active(t) && (t.alert || t.coverageAlert));
  await chrome.action.setBadgeText({ text: alerts.length ? String(alerts.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  const notifications = await chrome.notifications.getAll();
  await Promise.allSettled(Object.keys(notifications).filter((id) =>
    (id.startsWith('vehicle:') && !tasks.some(t => active(t) && t.alert && id === 'vehicle:' + t.id)) ||
    (id.startsWith('coverage:') && !tasks.some(t => active(t) && t.coverageAlert && id === 'coverage:' + t.id))
  ).map((id) => chrome.notifications.clear(id)));
}
chrome.notifications.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }));
async function requestTabCapture(tabId) {
  return once(`capture:tab:${tabId}`, async () => { try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url?.startsWith(API.BASE + '/')) return;
    if (!['/table', '/search'].includes(new URL(tab.url).pathname.replace(/\/+$/, ''))) return;
    try { if ((await chrome.tabs.sendMessage(tabId, { type: 'capture:request' }))?.captureVersion === 2) return; } catch (_) {}
    if (!chrome.scripting) return;
    // 扩展重载后已打开的页面可能没有有效桥接，无需用户重新刷新网页。
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-bridge.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-main.js'], world: 'MAIN' });
    await chrome.tabs.sendMessage(tabId, { type: 'capture:request' });
  } catch (_) { /* 页面关闭或跳转时，下一次激活再核查。 */ } });
}
async function refreshActiveCapture() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id != null) await requestTabCapture(tab.id);
}
chrome.tabs.onActivated?.addListener(({ tabId }) => requestTabCapture(tabId));
chrome.tabs.onUpdated?.addListener((tabId, changes) => { if (changes.url || changes.status === 'complete') requestTabCapture(tabId); });
chrome.windows?.onFocusChanged?.addListener(() => refreshActiveCapture().catch(report));
let setupChain = Promise.resolve();
function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(report);
  chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 });
  // storage.session 跨 worker 休眠保留，重启后只核验仍在执行的任务。
  setupChain = setupChain.then(async () => {
    const { downloadSession } = await chrome.storage.session.get('downloadSession');
    validationSession = downloadSession || newId();
    if (!downloadSession) await chrome.storage.session.set({ downloadSession: validationSession });
    await directoryLocked(async () => {
      const { dirs = [] } = await chrome.storage.local.get('dirs');
      if (await indexDirectoryIdentities(dirs)) await chrome.storage.local.set({ dirs });
    });
    await locked(async () => {
      const tasks = await load();
      await DownloadUi.restoreJobs(tasks.filter(t => active(t) && t.downloadBackend === 'browser').flatMap(t => t.items.filter(i => i.jobId).map(i => i.jobId))).catch(report);
      const { dirs = [] } = await chrome.storage.local.get('dirs');
      for (const t of tasks) if (t.status !== 'done' && !t.localVerificationOnly && !t.coverageMode) {
        t.coverageMode = 'interval'; t.coverageLegacy = true;
        t.legacySelectedFilenames = [...new Set([...(t.legacySelectedFilenames || []), ...t.items.map(i => i.filename), ...t.transfers.map(i => i.filename)])];
        if (C.wantsTransfer(t)) t.discovered = false;
      }
      for (const t of tasks) if (!t.dirPath && !t.directorySnapshot) {
        if (t.downloadBackend === 'browser') {
          const first = [...t.items].filter(i => i.downloadPath).sort((a,b) => (a.browserDownloadId || 0) - (b.browserDownloadId || 0))[0];
          if (first) t.dirPath = DirPaths.splitFile(first.downloadPath).directory;
          continue;
        }
        const dir = dirs.find((d) => d.id === t.dirId);
        if (dir?.displayPath || dir?.path) t.dirPath = dir.displayPath || dir.path;
      }
      // 旧版将默认目录切换当作下载失败。仅迁移这类等待，不触碰原 job/下载 ID 或路径。
      for (const t of tasks) if (t.downloadBackend === 'browser' && t.locationBlocked &&
          t.message?.startsWith('浏览器下载位置已改变。请将下载位置切回 ')) {
        t.locationWait = { current: '', required: browserTaskRoot(t) }; t.message = LOCATION_WAIT_MESSAGE;
        for (const i of t.items) if (i.error?.startsWith('浏览器下载位置已改变。请将下载位置切回 ')) { i.error = ''; delete i.retryAt; }
      }
      for (const t of tasks) if (t.locationWait && t.message === '等待下载目录切换') t.message = LOCATION_WAIT_MESSAGE;
      // 已失败的文件仍需处理，不能在禁用“已完成”操作后把失败队列留成完成状态。
      for (const t of tasks) if (t.status === 'done' && [...t.items, ...t.transfers].some((i) => ['failed', 'server_failed'].includes(i.state))) {
        t.status = 'error'; t.message = '仍有失败文件需要处理，点击执行可重试下载；已提交回传继续按原记录核查';
      }
      for (const t of tasks) {
        if (t.downloadBackend === 'browser') { t.directoryBlocked = false; delete t.directoryAccess; delete t.lastDirectoryFailure; }
        // 修复旧版本已完成任务被自动拉起、尚未启动读写的核验等待。
        const completedVerification = active(t) && t.localVerificationOnly && t.items.some(i => !i.coverageExcluded) && !t.items.some(i => i.jobId) &&
          t.items.filter(i => !i.coverageExcluded).every(i => i.state === 'done') &&
          t.transfers.filter(i => !i.coverageExcluded).every(i => i.state === 'done');
        if (completedVerification) {
          t.status = 'done'; t.localVerificationOnly = false; t.alert = '';
          t.message = `已完成，下载 ${t.items.filter(i => !i.coverageExcluded).length} 个包`;
        }
        if (t.status === 'done') {
          t.directoryBlocked = false; delete t.directoryAccess; delete t.lastDirectoryFailure; t.localVerificationOnly = false;
          for (const i of t.items) if (i.state === 'done') i.needsValidation = false;
        } else if (active(t)) {
          for (const i of t.items) if (i.state === 'done' && i.validationSession !== validationSession) i.needsValidation = true;
        }
      }
      const { taskTransferSelections = {} } = await chrome.storage.local.get('taskTransferSelections');
      const selections = { ...taskTransferSelections };
      for (const t of tasks) if (!Object.hasOwn(selections, t.id)) selections[t.id] = {
        enabled: t.transferEnabled, revision: t.transferControlRevision, requestId: '', at: t.updatedAt || t.createdAt || Date.now(),
      };
      await chrome.storage.local.set({ tasks, taskTransferSelections: selections });
    });
    await reconcile();
    refreshActiveCapture().catch(report);
  }).catch(report);
  retireLegacyDirectoryProbe().catch(report);
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === HEARTBEAT) reconcile().catch(report); });
setInterval(() => reconcile().catch(report), POLL_MS);
let captureQueue = Promise.resolve();
function captureLocked(fn) { const p = captureQueue.then(fn); captureQueue = p.catch(() => {}); return p; }
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg.type?.startsWith('offscreen:')) return false; // 让下载文档回答，不能抢答。
  (async () => {
    if (msg.type === 'capture') return captureLocked(async () => {
      if (!sender.tab || !sender.url?.startsWith(API.BASE + '/')) throw new Error('无效页面');
      const page = new URL(msg.payload?.page || sender.url);
      if (page.origin !== API.BASE || !['/table', '/search'].includes(page.pathname.replace(/\/+$/, ''))) throw new Error('此页面不采集任务设置');
      if (page.pathname.replace(/\/+$/, '') !== new URL(sender.url).pathname.replace(/\/+$/, '')) return { ok: true, applied: false };
      const [tab] = await chrome.tabs.query({ active: true, windowId: sender.tab.windowId });
      if (tab?.id !== sender.tab.id) return { ok: true, applied: false };
      const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (focusedTab?.id != null && focusedTab.id !== sender.tab.id) return { ok: true, applied: false };
      const p = msg.payload || {}, capture = { page: page.href, capturedAt: Date.now(), tabId: sender.tab.id };
      const { captured: previous } = await chrome.storage.local.get('captured');
      if (p.documentToken && Number.isSafeInteger(p.sequence)) {
        if (previous?.tabId === sender.tab.id && previous.documentToken === p.documentToken && previous.sequence >= p.sequence) return { ok: true, applied: false };
        capture.documentToken = String(p.documentToken).slice(0, 120); capture.sequence = p.sequence;
      }
      for (const k of ['truck_no', 'mine_code', 'bag_type', 'break_source']) capture[k] = C.text(p[k]).slice(0, 200);
      capture.hasSource = p.hasSource === true;
      if (!capture.hasSource) capture.break_source = '';
      await chrome.storage.local.set({ captured: capture }); return { ok: true, applied: true };
    });
    if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('页面无权控制任务');
    switch (msg.type) {
      case 'capture:refresh': await refreshActiveCapture(); break;
      case 'directory:browser': return { ok: true, directory: await ensureBrowserDirectory(true) };
      case 'directory:draft':
        await directoryLocked(async () => {
          if (typeof msg.path !== 'string' || msg.path.length > 4096) throw Error('保存路径过长');
          const { taskDirectoryDrafts = {} } = await chrome.storage.local.get('taskDirectoryDrafts');
          taskDirectoryDrafts[TaskDirectories.filterKey(msg.filters)] = msg.path;
          await chrome.storage.local.set({ taskDirectoryDrafts });
        }); break;
      case 'directory:selection':
        await directoryLocked(async () => {
          const { dirs = [], taskDirectorySelections = {} } = await chrome.storage.local.get(['dirs','taskDirectorySelections']);
          if (!dirs.some(d => d.id === msg.dirId && d.backend !== 'browser')) throw Error('请选择保存目录');
          taskDirectorySelections[TaskDirectories.filterKey(msg.filters)] = msg.dirId;
          await chrome.storage.local.set({ taskDirectorySelections });
        }); break;
      case 'directory:label-draft':
        await directoryLocked(async () => {
          if (typeof msg.path !== 'string' || msg.path.length > 4096) throw Error('保存路径过长');
          const { taskDirectoryLabels = {} } = await chrome.storage.local.get('taskDirectoryLabels');
          taskDirectoryLabels[msg.dirId] = msg.path;
          await chrome.storage.local.set({ taskDirectoryLabels });
        }); break;
      case 'directory:select': return { ok: true, directory: await selectDirectory(msg.dirId) };
      case 'directory:bind': return { ok: true, directory: await bindDirectoryPath(msg.dirId, msg.path, msg.filters) };
      case 'directory:label': {
        const directory = await setDirectoryDisplayPath(msg.dirId, msg.path);
        await fillMissingTaskPaths(msg.dirId, directory.displayPath);
        return { ok: true, directory };
      }
      case 'directory:authorized': return { ok: true, resumed: await authorizeDirectory(msg.dirId) };
      case 'directory:resolve': return { ok: true, directory: await directoryLocked(() => resolveDirectoryInput(msg.path)) };
      // 兼容旧面板的请求，选择目录即生效，绝不再生成校验下载。
      case 'directory:probe': return { ok: true, directory: await selectDirectory(msg.dirId) };
      case 'directory:cancel': await retireLegacyDirectoryProbe(); break;
      case 'create': return { ok: true, task: await createTask(msg.payload) };
      case 'execute': await execute(msg.id); break;
      case 'transfer:set': {
        const selection = await setTransferChoice(msg.id, msg.enabled, msg.requestId);
        return { ok: true, enabled: selection.enabled, revision: selection.revision, requestId: selection.requestId };
      }
      case 'stop': await stopTask(msg.id, msg.expectedRunToken); break;
      case 'delete': await deleteTask(msg.id, msg.expectedRunToken); break;
      case 'change-dir': await changeDirectory(msg.id, msg.dirId); break;
      case 'retry-uncertain':
        await edit(msg.id, null, (t) => {
          if (active(t)) throw new Error('请先停止任务并在网站核实提交结果');
          for (const i of t.transfers) if (['uncertain', 'submitting', 'server_failed'].includes(i.state)) {
            i.state = 'pending'; i.submissionLocked = false; i.attempts = 0; i.submittedAt = 0; i.batchId = null; i.recordNo = null; i.accepted = false;
          }
          t.message = '已允许重试未确认的请求，点击执行前会再次核对服务器';
        }); break;
      case 'job:result': await onJobResult(msg); break;
      case 'job:progress':
        await locked(async () => {
          const tasks = await load();
          for (const t of tasks) { const i = t.items.find((i) => i.jobId === msg.jobId);
            if (i) { i.bytes = msg.bytes; i.totalBytes = msg.totalBytes; await save(tasks); break; } }
        }); break;
      case 'job:validate': {
        const t = await snapshot(msg.taskId);
        return { ok: !!t && active(t) && t.runToken === msg.runToken && t.items.some((i) => i.jobId === msg.jobId) };
      }
      case 'lookups':
        if (msg.refresh) await chrome.storage.local.remove('lookups');
        return { ok: true, data: await getLookups() };
      default: throw new Error('未知指令');
    }
    return { ok: true };
  })().then(reply, (e) => reply({ ok: false, error: e.message || String(e) }));
  return true;
});
setup();
chrome.downloads.onChanged.addListener((delta) => {
  load().then((tasks) => Promise.allSettled(tasks.filter(active).flatMap((t) => t.downloadBackend === 'browser' ?
    t.items.filter((i) => i.browserDownloadId === delta.id && i.jobId).map((i) => browserDownloadPoll(i.jobId)) : []))).catch(report);
});
setInterval(() => {
  if (browserTrackedJobs.size) Promise.allSettled([...browserTrackedJobs].map(browserDownloadPoll)).catch(report);
}, 1500);
