// 文件写入仅在完整接收后提交。任务停止、网络中断和长度不符均丢弃临时内容。
const API_BASE = 'http://10.198.92.173:8080';
const DOWNLOAD_ORIGINS = new Set([API_BASE, 'http://10.198.92.173:8099']);
const jobs = new Map(), results = new Map(), mdcRequests = new Map();
const coded = (code, message) => Object.assign(new Error(message), { code });
function fileName(name) {
  if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.+$/.test(name)) throw coded('BAD_NAME', '服务器文件名无效');
  return name;
}
async function resolveLink(dirpath, signal) {
  const res = await fetch(API_BASE + '/api/bag/download', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: new URL(API_BASE).host, dirpath }), signal,
  });
  if (!res.ok) throw new Error(`下载接口 HTTP ${res.status}`);
  const json = await res.json();
  if (![200, 2000, 20000].includes(Number(json.code))) throw new Error(json.message || '下载接口返回失败');
  let u = json.data;
  if (u && typeof u === 'object') u = u.url || u.href || u.path || u.download_url;
  if (typeof u !== 'string' || !u) throw new Error('下载接口未返回有效链接');
  const url = new URL(u, API_BASE);
  if (!DOWNLOAD_ORIGINS.has(url.origin)) throw new Error('下载链接不在已授权的数据服务器内');
  return url.href;
}
async function getDirHandle(id) {
  let rec;
  try { rec = await DirStore.get(id); }
  catch (e) { const access = DirectoryHealth.failure('DIRECTORY_CHECK_FAILED', e); throw Object.assign(coded(access.code, access.message), { directoryAccess: access }); }
  const access = await DirectoryHealth.inspect(rec, { restore: true });
  if (access.state !== 'granted') throw Object.assign(coded(access.code, access.message), { directoryAccess: access });
  return rec.handle;
}
async function existingFile(dir, name) {
  try { return await (await dir.getFileHandle(name)).getFile(); }
  catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
}
async function validJob(job) {
  const r = await chrome.runtime.sendMessage({ type: 'job:validate', jobId: job.jobId, taskId: job.taskId, runToken: job.runToken });
  if (!r?.ok) throw coded('CANCELLED', '任务已停止或重新执行');
}
async function acknowledgeResults() {
  for (const [id, result] of results) {
    try { if ((await chrome.runtime.sendMessage(result))?.ok) results.delete(id); } catch (_) { /* 后台唤醒后重发 */ }
  }
}
async function runJob(job, ctrl) {
  let idleTimer, touchedAt = Date.now(), result;
  const touch = () => { touchedAt = Date.now(); };
  try {
    idleTimer = setInterval(() => {
      if (Date.now() - touchedAt > 90000) ctrl.abort(coded('TIMEOUT', '下载超过 90 秒没有新数据'));
    }, 10000);
    const name = fileName(job.filename);
    await navigator.locks.request(`bagflow:${job.writeDirectoryKey || job.dirId}:${name}`, { signal: ctrl.signal }, async () => {
      await validJob(job); touch();
      const dir = await getDirHandle(job.dirId), old = await existingFile(dir, name);
      const receiptId = `file:${job.dirId}:${name}`;
      const receipt = await DirStore.get(receiptId);
      // 重启可能丢失进度回执，但原子提交和完成凭据已经落盘；此时也必须跳过完整文件。
      if (old?.size > 0 && receipt?.dirpath === job.apiDirpath && receipt.size === old.size && receipt.modified === old.lastModified) {
        result = { ok: true, skipped: true, bytes: old.size, totalBytes: old.size }; return;
      }
      const link = await resolveLink(job.apiDirpath, ctrl.signal); touch();
      if (old?.size > 0) {
        // 旧版本没有完成凭据，只能用服务器的精确长度验证，不能只凭“同名”。
        try {
          const head = await fetch(link, { method: 'HEAD', signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(15000)]) });
          const size = Number(head.headers.get('Content-Length'));
          if (head.ok && (head.status == null || head.status === 200) && Number.isSafeInteger(size) && size > 0 && size === old.size && !head.headers.get('Content-Encoding') && !head.headers.get('Content-Range')) {
            await DirStore.put({ id: receiptId, dirpath: job.apiDirpath, size, modified: old.lastModified });
            result = { ok: true, skipped: true, bytes: old.size, totalBytes: old.size }; return;
          }
        } catch (e) { if (ctrl.signal.aborted) throw e; }
      }
      await validJob(job); ctrl.signal.throwIfAborted(); touch();
      const res = await fetch(link, { signal: ctrl.signal });
      if (!res.ok || !res.body || (res.status != null && res.status !== 200) || res.headers.get('Content-Range')) throw new Error(`文件下载 HTTP ${res.status}，未返回完整文件`);
      if (/text\/html|application\/json/.test(res.headers.get('Content-Type') || '')) throw new Error('下载返回了错误页面，而非文件');
      if (res.headers.get('Content-Encoding')) throw new Error('下载响应经过压缩，无法核验文件完整长度');
      let length = Number(res.headers.get('Content-Length')) || 0;
      if (!length) {
        const head = await fetch(link, { method: 'HEAD', signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(15000)]) });
        if (head.ok && (head.status == null || head.status === 200) && !head.headers.get('Content-Encoding') && !head.headers.get('Content-Range')) length = Number(head.headers.get('Content-Length')) || 0;
      }
      if (!Number.isSafeInteger(length) || length <= 0) throw new Error('服务器未提供精确文件长度，无法确认完整性，将重试');
      const handle = await dir.getFileHandle(name, { create: true });
      let writable, bytes = 0, lastProgress = 0;
      try {
        writable = await handle.createWritable();
        const meter = new TransformStream({
          transform(chunk, controller) {
            touch(); bytes += chunk.byteLength; controller.enqueue(chunk);
            if (Date.now() - lastProgress > 1500) {
              lastProgress = Date.now();
              chrome.runtime.sendMessage({ type: 'job:progress', jobId: job.jobId, bytes, totalBytes: length }).catch(() => {});
            }
          },
          async flush() {
            if (!bytes || (length && bytes !== length)) throw new Error(`文件不完整：接收 ${bytes} / ${length} 字节`);
            await validJob(job); ctrl.signal.throwIfAborted();
          },
        });
        await res.body.pipeThrough(meter).pipeTo(writable, { signal: ctrl.signal });
      } catch (e) {
        if (writable) await writable.abort().catch(() => {});
        // getFileHandle(create:true) 可能留下零字节占位，不能让后续任务误跳过。
        if (!old) { const f = await existingFile(dir, name).catch(() => null); if (f?.size === 0) await dir.removeEntry(name).catch(() => {}); }
        throw e;
      }
      const file = await handle.getFile();
      if (file.size !== length) throw new Error(`落盘文件不完整：${file.size} / ${length} 字节`);
      await DirStore.put({ id: receiptId, dirpath: job.apiDirpath, size: file.size, modified: file.lastModified });
      result = { ok: true, bytes: file.size, totalBytes: file.size };
    });
  } catch (e) {
    const reason = ctrl.signal.aborted ? ctrl.signal.reason : e;
    result = { ok: false, code: typeof reason?.code === 'string' ? reason.code : reason?.name || e.name,
      error: ctrl.signal.aborted ? (ctrl.signal.reason?.message || '已取消') : e.message || String(e) };
    if (!ctrl.signal.aborted) {
      let access = e.directoryAccess;
      if (!access && ['NotAllowedError', 'NotFoundError'].includes(e.name)) {
        access = await DirectoryHealth.check(DirStore, job.dirId, { restore: true, verify: true });
        if (access.state === 'granted') access = DirectoryHealth.failure(e.name === 'NotAllowedError' ? 'DIRECTORY_WRITE_DENIED' : 'DIRECTORY_ENTRY_MISSING', e);
      }
      if (access) { result.code = access.code; result.directoryAccess = access; }
    }
  } finally {
    if (!ctrl.signal.aborted) ctrl.abort();
    clearInterval(idleTimer); jobs.delete(job.jobId);
    results.set(job.jobId, { type: 'job:result', jobId: job.jobId, ...result });
    acknowledgeResults();
  }
}
setInterval(acknowledgeResults, 5000);
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg.type) {
    case 'offscreen:directory':
      DirectoryHealth.check(DirStore, msg.dirId, { restore: true, verify: !!msg.verify }).then(
        access => reply({ ok: true, access }), e => reply({ ok: false, error: e.message }));
      return true;
    case 'offscreen:mdc': {
      const key = msg.task?.filters?.truck_no;
      if (!key) { reply({ ok: false, error: '缺少车辆编号' }); return false; }
      if (!mdcRequests.has(key)) mdcRequests.set(key, SiteAPI.mdc(msg.task).finally(() => mdcRequests.delete(key)));
      mdcRequests.get(key).then((rows) => reply({ ok: true, rows }), (e) => reply({ ok: false, error: e.message }));
      return true;
    }
    case 'offscreen:download':
      if (!jobs.has(msg.jobId)) {
        const ctrl = new AbortController(); jobs.set(msg.jobId, ctrl); runJob(msg, ctrl);
      }
      reply({ ok: true }); return false;
    case 'offscreen:cancel': jobs.get(msg.jobId)?.abort(); reply({ ok: true }); return false;
    case 'offscreen:status': reply({ ok: true, active: [...jobs.keys(), ...results.keys()] }); acknowledgeResults(); return false;
    default: return false;
  }
});
