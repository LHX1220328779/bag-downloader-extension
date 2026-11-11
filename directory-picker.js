// 目录选择、写入授权及句柄持久化分步处理；AbortError 也可能来自权限拒绝或数据库中止。
(function (root) {
  const D = root.DirPaths || require('./directory-paths.js');
  function begin({ path, record, permission, pendingHandle, startIn, picker, claim, onPicked, onPhase } = {}) {
    const operation = { stage: 'validate', directorySelected: false, selectedName: '', permissionState: permission || 'unknown', promise: null };
    const phase = stage => { operation.stage = stage; onPhase?.(stage); };
    const validate = handle => {
      phase('validate');
      if (handle?.kind !== 'directory') throw Error('浏览器没有返回有效目录，请重新选择保存目录');
      operation.directorySelected = true; operation.selectedName = handle.name;
      const leaf = D.leaf(path), windows = /^[a-z]:\\|^\\\\/i.test(path);
      if (windows ? leaf.toLowerCase() !== handle.name.toLowerCase() : leaf !== handle.name) throw Error(`请选择 ${path}；当前选择的是「${handle.name}」`);
    };
    const authorize = handle => {
      phase('permission');
      // 新选择完成后浏览器会触发用户激活；旧句柄则在本次按钮点击中直接请求。
      const request = handle.requestPermission({ mode: 'readwrite' });
      return Promise.resolve(request).then(state => {
        operation.permissionState = state;
        if (state !== 'granted') {
          const error = Error(`浏览器未授予目录写入权限（${state}）`); error.name = 'NotAllowedError'; throw error;
        }
      });
    };
    const selected = handle => {
      validate(handle); onPicked?.(handle);
      return authorize(handle).then(() => {
        phase('persist'); return (claim || (h => DirStore.claim(h)))(handle);
      }).then(rec => { phase('ready'); return rec; });
    };
    try {
      if (record?.handle) {
        validate(record.handle);
        operation.promise = permission === 'granted' ? Promise.resolve(record) : authorize(record.handle).then(() => record);
        operation.promise = operation.promise.then(rec => { phase('ready'); return rec; });
      } else if (pendingHandle) operation.promise = selected(pendingHandle);
      else {
        phase('picker');
        const pick = picker || root.showDirectoryPicker?.bind(root);
        if (!pick) throw Error('此浏览器不支持目录选择，请使用新版 Chrome 或 Edge');
        // 先选目录，再明确请求写入，避免把组合读写选择失败误当成用户取消。
        operation.promise = Promise.resolve(pick({ id: 'bagflow-save', mode: 'read', ...(startIn ? { startIn } : {}) })).then(selected);
      }
    } catch (error) { operation.promise = Promise.reject(error); }
    return operation;
  }
  function failure(operation, error) {
    const stage = operation?.stage || 'create', code = error?.name || 'Error', message = error?.message || String(error || '未知错误');
    let displayMessage = message;
    if (stage === 'picker' && code === 'AbortError') {
      // API 将取消、敏感目录及指定模式授权未通过都映射为 AbortError。
      displayMessage = '浏览器未完成目录选择或拒绝访问该目录，未创建任务。请确认点击“选择文件夹”，并选择浏览器允许访问的数据目录。';
    } else if (stage === 'permission') {
      displayMessage = code === 'SecurityError'
        ? '目录已选中，但浏览器未允许请求写入授权。请再次点击“创建任务”，本侧栏会复用已选目录。'
        : '目录已选中，但未获得写入权限，未创建任务。请在浏览器提示中允许编辑文件后重试。';
    } else if (stage === 'persist') {
      displayMessage = '目录已选中且写入授权已通过，但保存目录记录失败。可再次点击“创建任务”重试，本侧栏会复用已选目录。';
    } else if (stage === 'bind') displayMessage = `绑定保存目录失败：${message}`;
    else if (stage === 'create') displayMessage = `创建任务失败：${message}`;
    return { stage, code, message, displayMessage, directorySelected: !!operation?.directorySelected,
      selectedName: operation?.selectedName || '', permissionState: operation?.permissionState || 'unknown' };
  }
  const api = { begin, failure };
  root.DirectoryPicker = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
