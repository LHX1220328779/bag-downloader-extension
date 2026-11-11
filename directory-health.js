// 目录句柄、浏览器权限和文件系统故障分别处理；检查失败不等于需要授权。
(function (root) {
  function failure(code, error, permission) {
    const detail = typeof error === 'string' ? error : error?.message || '';
    let state = 'unavailable', message = '保存目录暂时无法访问，正在自动重试';
    if (code === 'NEED_PERMISSION') {
      state = 'permission'; message = '保存目录写入权限需要恢复，授权后自动继续';
    } else if (code === 'NO_DIR') {
      state = 'missing'; message = '原任务的目录记录不可用，任务进度已保留';
    } else if (code === 'DIR_NOT_FOUND' || code === 'NotFoundError') {
      code = 'DIR_NOT_FOUND'; message = '原任务保存目录不存在或已断开，恢复后自动继续';
    } else if (code === 'DIRECTORY_WRITE_DENIED' || code === 'NotAllowedError') {
      code = 'DIRECTORY_WRITE_DENIED'; message = '系统暂时拒绝访问原任务目录，正在自动重试';
    } else if (code === 'DIRECTORY_ENTRY_MISSING') {
      message = '原目录中的写入目标发生变化，正在自动重试';
    } else if (code === 'DIRECTORY_CHECK_FAILED') {
      message = '目录访问检查暂时失败，正在自动重试';
    } else if (code === 'DIRECTORY_RESTORE_PENDING') {
      message = '正在恢复原目录的访问权限，稍后自动继续';
    }
    return { state, code, message, ...(detail ? { detail } : {}), ...(error?.name ? { errorCode: error.name } : {}), ...(permission ? { permission } : {}) };
  }
  function fromPermission(permission) {
    if (permission === 'granted') return { state: 'granted', permission };
    if (permission === 'prompt' || permission === 'denied') return failure('NEED_PERMISSION', '', permission);
    return failure('DIRECTORY_CHECK_FAILED', `无法确认目录权限：${permission || 'unknown'}`);
  }
  async function inspect(record, { restore = false, verify = false, query } = {}) {
    if (!record?.handle) return failure('NO_DIR');
    const readPermission = () => query ? query(record) : record.handle.queryPermission({ mode: 'readwrite' });
    try {
      let permission = await readPermission(), restoreError;
      // 此分支只供没有用户手势的后台文档使用。浏览器已有持久授权时可静默恢复；
      // 普通授权仍由浏览器拒绝，不在定时器中弹出系统授权框。
      if (restore && permission === 'prompt' && typeof record.handle.requestPermission === 'function') {
        // 扩展消息也会传播点击状态。等其消失，再尝试无需确认的恢复。
        const activated = () => !!root.navigator?.userActivation?.isActive;
        const now = () => root.performance?.now ? root.performance.now() : Date.now();
        const deadline = now() + 6000; let waited = false;
        while (activated() && now() < deadline) {
          waited = true; await new Promise(resolve => root.setTimeout(resolve, 200));
        }
        if (waited) permission = await readPermission();
        if (permission === 'prompt') {
          if (activated()) return failure('DIRECTORY_RESTORE_PENDING', '', permission);
          try {
            permission = await record.handle.requestPermission({ mode: 'readwrite' });
          } catch (e) {
            restoreError = { code: e.name || 'Error', message: e.message || String(e) };
            permission = await readPermission();
          }
        }
      }
      const access = fromPermission(permission);
      if (restoreError && access.state !== 'granted') access.restoreError = restoreError;
      if (access.state === 'granted' && verify && typeof record.handle.values === 'function') {
        // 只取一个条目，空目录也有效。queryPermission 本身不能证明目录仍存在。
        const entries = record.handle.values();
        try { await entries.next(); }
        finally { try { await entries.return?.(); } catch (_) {} }
      }
      return access;
    } catch (e) {
      return failure(e.name === 'NotFoundError' ? 'DIR_NOT_FOUND' : 'DIRECTORY_CHECK_FAILED', e);
    }
  }
  async function check(store, id, options = {}) {
    try {
      return await inspect(await store.get(id), { ...options, query: store.permission ? record => store.permission(record) : undefined });
    } catch (e) { return failure('DIRECTORY_CHECK_FAILED', e); }
  }
  function blocked(task) {
    if (task.downloadBackend === 'browser') return false;
    return !!task.directoryBlocked || !!(task.directoryAccess && task.directoryAccess.state !== 'granted');
  }
  function taskIssue(task, permission) {
    if (!['fetching', 'running', 'waiting_vehicle'].includes(task.status) || task.downloadBackend === 'browser' || task.operations?.download === false) return null;
    if (task.directoryAccess) return task.directoryAccess.state === 'granted' ? null : task.directoryAccess;
    // 兼容旧任务；查询异常、缺失句柄不会被当成授权不足。
    if (task.directoryBlocked) {
      const access = fromPermission(permission);
      return access.state === 'granted' ? null : access;
    }
    return null;
  }
  const api = { failure, fromPermission, inspect, check, blocked, taskIssue };
  root.DirectoryHealth = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
