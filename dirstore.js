// 保存目录句柄的持久化（IndexedDB）。
// 句柄本身无法放进 chrome.storage，因此存放在扩展源的 IndexedDB 中，
// 弹窗、授权窗口与 offscreen 文档共享同一数据库。
const DirStore = (() => {
  const DB_NAME = 'bagflow-dirs';
  const STORE = 'handles';
  let dbPromise = null;
  let connection = null;

  function reset(db) {
    if (connection === db) { connection = null; dbPromise = null; }
  }

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => {
          const db = connection = req.result;
          db.onversionchange = () => { db.close(); reset(db); };
          db.onclose = () => reset(db);
          resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  async function run(mode, fn, retry = true) {
    const db = await open();
    let tx;
    try { tx = db.transaction(STORE, mode); }
    catch (e) {
      if (e.name === 'InvalidStateError') {
        reset(db);
        // 事务尚未创建，重新打开一次不会重复提交写入。
        if (retry) return run(mode, fn, false);
      }
      throw e;
    }
    return new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE);
      const req = fn(store);
      let requestError;
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => { requestError = tx.error || req?.error; };
      tx.onabort = () => {
        const error = tx.error || requestError || Object.assign(new Error('目录数据库事务已中止'), { name: 'AbortError' });
        if (retry && error.name === 'AbortError') {
          // 确认事务中止后写入已回滚；关闭连接重试一次，不重复已提交的写入。
          reset(db); db.close(); run(mode, fn, false).then(resolve, reject);
        } else reject(error);
      };
    });
  }

  return {
    // record: { id, name, handle }
    put: (record) => run('readwrite', (s) => s.put(record)),
    get: (id) => run('readonly', (s) => s.get(id)),
    all: () => run('readonly', (s) => s.getAll()),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    async claim(handle) {
      if (handle?.kind !== 'directory') throw new Error('请选择保存目录');
      return navigator.locks.request('bagflow-directory-registry', async () => {
        for (const rec of await run('readonly', s => s.getAll())) {
          if (rec.handle && await handle.isSameEntry(rec.handle)) return rec;
        }
        const rec = { id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now() };
        await run('readwrite', s => s.put(rec)); return rec;
      });
    },
    // 权限检查（无需用户手势）
    async permission(record) {
      if (!record || !record.handle) return 'missing';
      return record.handle.queryPermission({ mode: 'readwrite' });
    },
  };
})();
