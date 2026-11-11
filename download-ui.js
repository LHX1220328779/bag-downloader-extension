// Chrome 的下载界面开关是全局的。只在本插件探测/传输期间关闭，所有传输结束后恢复。
const DownloadUi = (() => {
  const jobs = new Set(), probes = new Set();
  let queue = Promise.resolve(), enabled = null;
  function sync() {
    const next = queue.then(async () => {
      const desired = !jobs.size && !probes.size;
      if (enabled !== desired) { await chrome.downloads.setUiOptions({ enabled: desired }); enabled = desired; }
    });
    queue = next.catch(() => {}); return next;
  }
  async function hold(set, key) {
    set.add(key);
    try { await sync(); }
    catch (e) { set.delete(key); await sync().catch(() => {}); throw e; }
  }
  function release(set, key) { set.delete(key); return sync(); }
  return {
    refresh: sync,
    holdJob: key => hold(jobs, key), releaseJob: key => release(jobs, key),
    holdProbe: key => hold(probes, key), releaseProbe: key => release(probes, key),
    restoreJobs(keys) { for (const key of keys) jobs.add(key); return sync(); },
  };
})();
