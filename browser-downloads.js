// 使用浏览器下载管理器。任务与下载 ID 持久保存，重载不会取消浏览器中的下载。
const BROWSER_DIR_ID = 'browser-downloads:bags';
const browserStarts = new Map();
const browserTrackedJobs = new Set();
const browserOrigins = new Set(['http://10.198.92.173:8080', 'http://10.198.92.173:8099']);
const browserError = (code, message) => Object.assign(new Error(message), { code });
async function ensureBrowserDirectory(select = false) {
  return directoryLocked(async () => {
    const { dirs = [] } = await chrome.storage.local.get('dirs');
    const old = dirs.find((d) => d.id === BROWSER_DIR_ID);
    const dir = old || { id: BROWSER_DIR_ID, backend: 'browser', path: '', addedAt: Date.now() };
    const migrated = dir.browserRelativeDir == null;
    if (old && migrated && dir.path) dir.path = DirPaths.splitFile(dir.path).directory;
    dir.name = '浏览器下载目录'; dir.browserRelativeDir = '';
    if (!old || select || migrated) await chrome.storage.local.set({ dirs: old ? dirs : [dir, ...dirs], ...(select ? { lastDirId: dir.id } : {}) });
    return dir;
  });
}
async function browserValid(job) {
  const t = await snapshot(job.taskId);
  return !!t && active(t) && t.runToken === job.runToken && t.items.some((i) => i.jobId === job.jobId);
}
function browserOwned(d, name) {
  if (!d || d.byExtensionId !== chrome.runtime.id) return false;
  try {
    if (!browserOrigins.has(new URL(d.finalUrl || d.url).origin)) return false;
    return !d.filename || DirPaths.splitFile(d.filename).name === name;
  } catch (_) { return false; }
}
function browserComplete(d, expected) {
  return d.state === 'complete' && d.exists === true && Number.isSafeInteger(expected) && expected > 0 &&
    d.fileSize === expected && d.bytesReceived === expected && d.totalBytes === expected;
}
function browserAtTaskDirectory(d, task) {
  return !task?.dirPath || !!d?.filename && sameDirectory(task.dirPath, DirPaths.splitFile(d.filename).directory);
}
async function browserFind(item, name, task) {
  if (item.browserDownloadId != null) {
    const [d] = await chrome.downloads.search({ id: item.browserDownloadId });
    if (browserOwned(d, name) && (!d.filename || browserAtTaskDirectory(d, task))) return d;
  }
  // API 启动后、下载 ID 写回前恰好重载时，从持久化意图找回原下载。
  if (item.browserUrl && item.browserIntentAt) {
    const found = await chrome.downloads.search({ url: item.browserUrl, startedAfter: new Date(item.browserIntentAt - 1000).toISOString() });
    return found.filter((d) => browserOwned(d, name) && d.filename && browserAtTaskDirectory(d, task)).sort((a,b) => b.id - a.id)[0];
  }
}
async function browserPriorDownload(task, item) {
  let d = await browserFind(item, item.filename, task), expected = item.expectedBytes;
  if (!d) {
    const { browserFiles = {} } = await chrome.storage.local.get('browserFiles');
    const receipt = browserFiles[browserFileKey(task, item.filename)] || browserFiles['file:' + (task.browserRelativeDir ? task.browserRelativeDir + '/' : '') + item.filename] || (task.browserRelativeDir === 'bags' ? browserFiles[item.filename] : null);
    if (receipt?.apiDirpath === item.dirpath && (!task.dirPath || (receipt.downloadPath && sameDirectory(task.dirPath, DirPaths.splitFile(receipt.downloadPath).directory)))) {
      d = await browserFind(receipt, item.filename, task); expected = receipt.expectedBytes;
    }
  }
  return { d, expected };
}
async function forgetMisplacedBrowserReference(job, item) {
  if (item.browserDownloadId == null) return;
  const [d] = await chrome.downloads.search({ id: item.browserDownloadId });
  if (!d?.filename || browserAtTaskDirectory(d, job)) return;
  await edit(job.taskId, job.runToken, t => {
    const current = t.items.find(i => i.jobId === job.jobId && i.browserDownloadId === item.browserDownloadId);
    if (!current) return;
    current.misplacedDownload = { id: d.id, path: d.filename }; current.error = '';
    delete current.browserDownloadId; delete current.downloadPath;
    // 保留原启动意图：丢失/误关联 ID 后仍可按原 URL 和任务目录找回正确的在途文件。
    if (t.message?.startsWith('文件保存位置与任务固定目录 ')) { t.locationBlocked = false; t.message = '正在原任务目录恢复下载'; }
  });
  // 只解除本任务的错误关联，不暂停或取消可能属于其他任务的原下载。
}
function sameDownloadDestination(a, b) {
  if (a.downloadBackend === 'browser' && b.downloadBackend === 'browser' && a.dirPath && b.dirPath) return sameDirectory(a.dirPath, b.dirPath);
  // 旧原生下载与目录句柄不能按文本标签证明是两个实际位置，同名包保守串行。
  if ((a.downloadBackend === 'browser') !== (b.downloadBackend === 'browser')) return true;
  return (directoryWriteKeys.get(a.dirId) || a.dirId) === (directoryWriteKeys.get(b.dirId) || b.dirId);
}
async function browserRemember(job, d, expected) {
  let accepted = false;
  await locked(async () => {
    const tasks = await load(), t = tasks.find((t) => t.id === job.taskId);
    const i = t?.items.find((i) => i.jobId === job.jobId || i.browserIntentJobId === job.jobId);
    if (!i) return;
    if (d.filename && browserOwned(d, job.filename)) {
      const actual = DirPaths.splitFile(d.filename).directory;
      if (t.dirPath && !sameDirectory(t.dirPath, actual)) {
        const error = browserError('LOCATION_CHANGED', `文件保存位置与任务固定目录 ${t.dirPath} 不一致，已暂停该文件`);
        throw error;
      }
      if (!t.dirPath) t.dirPath = actual;
      i.downloadPath = d.filename;
    }
    i.browserDownloadId = d.id; i.expectedBytes = expected;
    accepted = active(t) && t.runToken === job.runToken && i.jobId === job.jobId;
    await save(tasks);
  });
  return accepted;
}
function browserFileKey(task, name) { return task.dirPath ? 'path:' + DirPaths.key(task.dirPath) + ':' + name : 'file:' + (task.browserRelativeDir ? task.browserRelativeDir + '/' : '') + name; }
async function browserReceipt(job, d, expected) {
  await locked(async () => {
    const task = (await load()).find(t => t.id === job.taskId);
    if (!task) return;
    const { browserFiles = {} } = await chrome.storage.local.get('browserFiles');
    browserFiles[browserFileKey(task, job.filename)] = { browserDownloadId: d.id, expectedBytes: expected, apiDirpath: job.apiDirpath, downloadPath: d.filename };
    await chrome.storage.local.set({ browserFiles });
  });
}
async function browserHeaders(link) {
  const head = await fetch(link, { method: 'HEAD', credentials: 'include', signal: AbortSignal.timeout(15000) });
  if (head.status === 404 || head.status === 410) throw browserError('TARGET_REMOVED', '服务器报告目标数据包已不存在');
  const size = Number(head.headers.get('Content-Length'));
  if (!head.ok || head.status !== 200 || !browserOrigins.has(new URL(head.url || link).origin) ||
      head.headers.get('Content-Encoding') || head.headers.get('Content-Range') || !Number.isSafeInteger(size) || size <= 0 ||
      /text\/html|application\/json/i.test(head.headers.get('Content-Type') || '')) {
    throw browserError('BAD_LENGTH', '服务器未返回可核验的完整文件长度，将重试');
  }
  return { size, link: head.url || link };
}
async function browserDownloadStart(job) {
  browserTrackedJobs.add(job.jobId);
  const key = (job.dirPath ? 'path:' + DirPaths.key(job.dirPath) : job.dirId + ':' + (job.browserRelativeDir || '')) + ':' + job.filename, previous = browserStarts.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    try {
      if (!await browserValid(job)) { browserTrackedJobs.delete(job.jobId); return; }
      if (!job.filename || /[\\/:*?"<>|\x00-\x1f]/.test(job.filename) || !job.filename.endsWith('.bag')) throw browserError('BAD_NAME', '服务器文件名无效');
      await DownloadUi.holdJob(job.jobId);
      const t = await snapshot(job.taskId), item = t.items.find((i) => i.jobId === job.jobId);
      let { d, expected } = await browserPriorDownload(t, item);
      if (!d) await forgetMisplacedBrowserReference(job, item);
      if (!d && item.browserIntentAt && item.browserIntentJobId === job.jobId && Date.now() - item.browserIntentAt < 45000) return;
      if (d && expected > 0) {
        if (!await browserRemember(job, d, expected)) return;
        if (browserComplete(d, expected)) {
          await browserReceipt(job, d, expected);
          await onJobResult({ jobId: job.jobId, ok: true, skipped: true }); return;
        }
        if (d.state === 'in_progress' || (d.state === 'interrupted' && d.canResume)) {
          if (d.paused || d.state === 'interrupted') {
            try { await chrome.downloads.resume(d.id); }
            catch (e) {
              const [latest] = await chrome.downloads.search({ id: d.id });
              if (latest?.state === 'in_progress' && latest.paused) throw e;
              d = latest && ['in_progress', 'complete'].includes(latest.state) ? latest : null;
            }
          }
          if (d) { await browserDownloadPoll(job.jobId); return; }
        }
      }
      if (!await assertBrowserLocation(job)) return;
      let url = await SiteAPI.post('/api/bag/download', { address: new URL(SiteAPI.BASE).host, dirpath: job.apiDirpath }, [200,2000,20000]);
      if (url && typeof url === 'object') url = url.url || url.href || url.path || url.download_url;
      if (typeof url !== 'string' || !url) throw new Error('下载接口未返回有效链接');
      url = new URL(url, SiteAPI.BASE).href;
      if (!browserOrigins.has(new URL(url).origin)) throw new Error('下载链接不在已授权的数据服务器内');
      const head = await browserHeaders(url); expected = head.size; url = head.link;
      const reserved = await edit(job.taskId, job.runToken, (t) => {
        const i = t.items.find((i) => i.jobId === job.jobId); if (!i) return false;
        Object.assign(i, { browserUrl: url, browserIntentAt: Date.now(), browserIntentJobId: job.jobId, expectedBytes: expected }); return true;
      });
      if (!reserved || !await browserValid(job)) return;
      const id = await chrome.downloads.download({ url, filename: job.browserFilename, conflictAction: 'overwrite', saveAs: false });
      const [created] = await chrome.downloads.search({ id });
      let accepted;
      try { accepted = await browserRemember(job, created || { id }, expected); }
      catch (e) {
        // 路径在探测后、API 启动前被改变时，停止新建的错误位置传输。完整文件保留，不盲目重下。
        await chrome.downloads.pause(id).catch(() => {});
        if (created?.state !== 'complete') {
          await chrome.downloads.cancel(id).catch(() => {});
          await edit(job.taskId, job.runToken, t => {
            const i = t.items.find(i => i.jobId === job.jobId); if (!i) return;
            i.misplacedPath = created?.filename || ''; delete i.browserDownloadId; delete i.browserUrl; delete i.browserIntentAt; delete i.browserIntentJobId;
          });
        }
        throw e;
      }
      if (!accepted) {
        browserTrackedJobs.delete(job.jobId);
        const current = await snapshot(job.taskId);
        await (current ? chrome.downloads.pause(id) : chrome.downloads.cancel(id)).catch(() => {}); return;
      }
      await browserDownloadPoll(job.jobId);
    } catch (e) { await onJobResult({ jobId: job.jobId, ok: false, code: typeof e.code === 'string' ? e.code : e.name, error: e.message || String(e), currentDirectory: e.currentDirectory }); }
    finally {
      if (!await browserValid(job)) browserTrackedJobs.delete(job.jobId);
      if (!browserTrackedJobs.has(job.jobId)) await DownloadUi.releaseJob(job.jobId).catch(report);
    }
  });
  browserStarts.set(key, next);
  try { await next; } finally { if (browserStarts.get(key) === next) browserStarts.delete(key); }
}
async function browserDownloadPoll(jobId) {
  return once('browser:poll:' + jobId, async () => {
    const tasks = await load(), t = tasks.find((t) => t.downloadBackend === 'browser' && t.items.some((i) => i.jobId === jobId));
    if (!t || !active(t)) { browserTrackedJobs.delete(jobId); await DownloadUi.releaseJob(jobId).catch(report); return; }
    const i = t.items.find((i) => i.jobId === jobId);
    if (i.browserDownloadId == null) return;
    const [d] = await chrome.downloads.search({ id: i.browserDownloadId });
    if (!browserOwned(d, i.filename)) { await onJobResult({ jobId, ok: false, error: '原下载记录已丢失或来源不匹配，将重新核验下载' }); return; }
    const job = { jobId, taskId: t.id, runToken: t.runToken, filename: i.filename, apiDirpath: i.dirpath, browserRelativeDir: t.browserRelativeDir };
    try { await browserRemember(job, d, i.expectedBytes); }
    catch (e) {
      if (e.code !== 'LOCATION_CHANGED') throw e;
      await forgetMisplacedBrowserReference({ ...job, dirPath: t.dirPath }, i);
      await onJobResult({ jobId, ok: false, code: 'STALE_DOWNLOAD_REFERENCE', error: '已排除其他位置的下载记录，正在原目录重新核查' }); return;
    }
    await edit(t.id, t.runToken, (task) => { const item = task.items.find((x) => x.jobId === jobId); if (item) { item.bytes = d.bytesReceived; item.totalBytes = i.expectedBytes; } });
    if (d.state === 'complete') {
      if (!browserComplete(d, i.expectedBytes)) { await onJobResult({ jobId, ok: false, error: '文件长度不符或文件已移除，不能标记完成' }); return; }
      await browserReceipt(job, d, i.expectedBytes);
      await onJobResult({ jobId, ok: true });
    } else if (d.state === 'interrupted') {
      await onJobResult({ jobId, ok: false, code: d.error || 'NETWORK_FAILED', error: '浏览器下载中断：' + (d.error || '网络中断') });
    }
  });
}
async function browserDownloadReconcile() {
  const jobs = [];
  for (const t of await load()) if (active(t) && t.downloadBackend === 'browser') for (const i of t.items) if (i.jobId) {
    const job = { jobId: i.jobId, taskId: t.id, runToken: t.runToken, dirId: t.dirId, dirPath: t.dirPath, filename: i.filename, apiDirpath: i.dirpath, browserRelativeDir: t.browserRelativeDir };
    jobs.push(browserDownloadStart(job));
  }
  await Promise.allSettled(jobs);
}
async function browserDownloadCancel(id, remove = false) {
  if (id == null) return;
  await (remove ? chrome.downloads.cancel(id) : chrome.downloads.pause(id)).catch(() => {});
}
