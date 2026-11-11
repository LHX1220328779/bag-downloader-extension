// Chrome 不提供默认下载目录读取 API。自动创建并清理一个随机小探测文件，不弹出目录选择或 txt 保存窗口。
let locationProbePromise = null;
let browserLocationCache = null;
const LOCATION_WAIT_MESSAGE = '浏览器下载目录尚未包含本任务保存位置';
function ownedLocationProbe(d, probe) {
  return d?.byExtensionId === chrome.runtime.id && d.url === probe.url && (!d.filename || DirPaths.splitFile(d.filename).name === probe.name);
}
async function cleanupLocationProbe(probe) {
  if (!probe) return;
  const found = await chrome.downloads.search(probe.id != null ? { id: probe.id } : { url: probe.url });
  for (const d of found.filter(d => ownedLocationProbe(d, probe))) {
    if (d.state !== 'complete') await chrome.downloads.cancel(d.id).catch(() => {});
    await chrome.downloads.removeFile(d.id).catch(() => {});
    await chrome.downloads.erase({ id: d.id }).catch(() => {});
  }
}
async function browserCurrentDirectory({ maxAge = 0 } = {}) {
  if (maxAge > 0 && browserLocationCache && Date.now() - browserLocationCache.at < maxAge) return browserLocationCache.path;
  if (locationProbePromise) return locationProbePromise;
  const promise = (async () => {
    const { browserLocationProbe } = await chrome.storage.local.get('browserLocationProbe');
    await cleanupLocationProbe(browserLocationProbe);
    const uuid = crypto.randomUUID(), probe = { name: 'bagflow-location-' + uuid + '.tmp', url: 'data:application/octet-stream,bagflow-' + uuid };
    await chrome.storage.local.set({ browserLocationProbe: probe });
    try {
      await DownloadUi.holdProbe(probe.name);
      probe.id = await chrome.downloads.download({ url: probe.url, filename: probe.name, saveAs: false, conflictAction: 'overwrite' });
      await chrome.storage.local.set({ browserLocationProbe: probe });
      for (let n = 0; n < 60; n++) {
        const [d] = await chrome.downloads.search({ id: probe.id });
        if (!ownedLocationProbe(d, probe)) throw Error('无法确认浏览器实际下载位置');
        if (d.state === 'complete' && d.filename && d.exists === true) {
          const path = DirPaths.normalize(DirPaths.splitFile(d.filename).directory);
          browserLocationCache = { path, at: Date.now() }; return path;
        }
        if (d.state === 'interrupted') throw Error('浏览器下载位置核查中断：' + (d.error || '未知原因'));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('浏览器下载位置核查超时');
    } finally {
      try {
        await cleanupLocationProbe(probe);
        await chrome.storage.local.remove('browserLocationProbe');
      } finally { await DownloadUi.releaseProbe(probe.name).catch(report); }
    }
  })();
  locationProbePromise = promise;
  try { return await promise; } finally { if (locationProbePromise === promise) locationProbePromise = null; }
}
function browserDestination(rootPath, relativeDir = '') {
  return DirPaths.normalize(rootPath + (relativeDir ? (/\\/.test(rootPath) ? '\\' : '/') + relativeDir : ''));
}
function sameDirectory(a, b) {
  try { return DirPaths.key(a) === DirPaths.key(b); } catch (_) { return false; }
}
function browserTaskRoot(task) {
  return task.browserRelativeDir ? DirPaths.splitFile(task.dirPath).directory : task.dirPath;
}
function browserRelativeDestination(task, current) {
  return task.dirPath ? DirPaths.relative(current, task.dirPath) : (task.browserRelativeDir ? [task.browserRelativeDir] : []);
}
function waitForBrowserLocation(task, current) {
  const first = !task.locationWait;
  task.locationBlocked = true;
  task.locationWait = { current, required: browserTaskRoot(task) };
  task.message = LOCATION_WAIT_MESSAGE;
  if (first) event(task, LOCATION_WAIT_MESSAGE);
}
function releaseBrowserLocation(task) {
  const waiting = !!task.locationWait;
  task.locationBlocked = false; delete task.locationWait;
  if (waiting) { task.message = '下载目录已匹配，继续下载'; event(task, task.message); }
}
// 等待任务只核查共享目录状态，不反复创建失败 job。原下载/完整记录可独立于默认目录继续。
async function browserLocationReady(task, candidate) {
  if (!task.locationWait) return true;
  const item = candidate || availableDownloadItem(task);
  if (!item) return true;
  const { d, expected } = await browserPriorDownload(task, item);
  if (d?.filename && sameDirectory(task.dirPath, DirPaths.splitFile(d.filename).directory) && expected > 0 &&
      (browserComplete(d, expected) || d.state === 'in_progress' || (d.state === 'interrupted' && d.canResume))) return true;
  const current = await browserCurrentDirectory({ maxAge: 15000 });
  if (browserRelativeDestination(task, current) === null) {
    if (task.locationWait.current !== current) await edit(task.id, task.runToken, t => waitForBrowserLocation(t, current));
    return false;
  }
  return !!await edit(task.id, task.runToken, releaseBrowserLocation);
}
async function assertBrowserLocation(job) {
  const current = await browserCurrentDirectory(), task = await snapshot(job.taskId);
  if (!task || !await browserValid(job)) return false;
  const actual = browserDestination(current, task.browserRelativeDir);
  if (!task.dirPath) await edit(task.id, job.runToken, t => { if (!t.dirPath) t.dirPath = actual; });
  const relative = browserRelativeDestination(task, current);
  if (relative === null) {
    throw Object.assign(browserError('LOCATION_WAIT', LOCATION_WAIT_MESSAGE), { currentDirectory: current });
  }
  job.browserFilename = [...relative, job.filename].join('/');
  await edit(task.id, job.runToken, releaseBrowserLocation);
  return true;
}
