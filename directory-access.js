// 文件写入只依赖已授权目录句柄。浏览器不直接提供其绝对路径；
// 保留以前已确认的路径，其余显示真实目录名，不生成 txt 或要求再次确认。
let directoryQueue = Promise.resolve();
const directoryWriteKeys = new Map();
async function indexDirectoryIdentities(dirs) {
  const groups = []; let changed = false;
  for (const dir of dirs.filter(d => d.backend !== 'browser').sort((a,b) => a.id.localeCompare(b.id))) {
    const rec = await DirStore.get(dir.id);
    if (!rec?.handle) continue;
    let group;
    for (const candidate of groups) if (typeof rec.handle.isSameEntry === 'function' && await rec.handle.isSameEntry(candidate.handle)) { group = candidate; break; }
    if (!group) { group = { id: dir.id, handle: rec.handle }; groups.push(group); }
    directoryWriteKeys.set(dir.id, group.id);
    if (dir.writeKey !== group.id) { dir.writeKey = group.id; changed = true; }
  }
  return changed;
}
function directoryLocked(fn) {
  const p = directoryQueue.then(fn); directoryQueue = p.catch(() => {}); return p;
}
async function selectDirectory(dirId) {
  return directoryLocked(async () => {
    const rec = await DirStore.get(dirId);
    if (!rec?.handle || await DirStore.permission(rec) !== 'granted') throw new Error('目录需要授权');
    const { dirs = [] } = await chrome.storage.local.get('dirs');
    const known = dirs.find((d) => d.id === dirId);
    const entry = { ...known, id: dirId, backend: 'directory', name: rec.handle.name || rec.name, path: known?.path || rec.path || '', displayPath: known?.displayPath || rec.displayPath || '', addedAt: known?.addedAt || rec.addedAt || Date.now() };
    const next = [entry, ...dirs.filter((d) => d.id !== dirId)]; await indexDirectoryIdentities(next);
    await chrome.storage.local.set({ dirs: next, lastDirId: dirId, directoryInput: entry.path });
    return entry;
  });
}
async function setDirectoryDisplayPath(dirId, value) {
  return directoryLocked(async () => {
    const rec = await DirStore.get(dirId);
    if (!rec?.handle || await DirStore.permission(rec) !== 'granted') throw new Error('请先选择并授权目录，再填写完整路径');
    const path = DirPaths.normalize(value), name = rec.handle.name || rec.name;
    const windows = /^[a-z]:\\|^\\\\/i.test(path), leaf = DirPaths.leaf(path);
    if (!path || (windows ? leaf.toLowerCase() !== name.toLowerCase() : leaf !== name)) throw new Error(`完整路径应以所选目录「${name}」结尾；更换目录请先选择该目录`);
    await DirStore.put({ ...rec, displayPath: path });
    const { dirs = [] } = await chrome.storage.local.get('dirs');
    const known = dirs.find((d) => d.id === dirId);
    const entry = { ...known, id: dirId, name, path: known?.path || rec.path || '', displayPath: path, addedAt: known?.addedAt || Date.now() };
    await chrome.storage.local.set({ dirs: [entry, ...dirs.filter((d) => d.id !== dirId)], lastDirId: dirId, directoryInput: path });
    return entry;
  });
}
async function bindDirectoryPath(dirId, value, filters) {
  return directoryLocked(async () => {
    if (typeof value !== 'string' || value.length > 4096) throw Error('请输入有效的完整保存路径');
    const rec = await DirStore.get(dirId);
    if (!rec?.handle || await DirStore.permission(rec) !== 'granted') throw Error('请在目录窗口中允许写入');
    const path = DirPaths.normalize(value), name = rec.handle.name || rec.name;
    const windows = /^[a-z]:\\|^\\\\/i.test(path), leaf = DirPaths.leaf(path);
    if (!path || (windows ? leaf.toLowerCase() !== name.toLowerCase() : leaf !== name)) throw Error(`请选择完整路径对应的「${leaf}」目录；当前选择的是「${name}」`);
    const { dirs = [], taskDirectoryBindings = {} } = await chrome.storage.local.get(['dirs', 'taskDirectoryBindings']);
    const otherPath = Object.values(taskDirectoryBindings).find(e => e.dirId === dirId && DirPaths.key(e.path) !== DirPaths.key(path));
    if (otherPath) throw Error(`当前选择的实际目录已经绑定 ${otherPath.path}，与输入路径不同；请选择输入路径对应的目录`);
    const previous = taskDirectoryBindings[DirPaths.key(path)];
    if (previous && previous.dirId !== dirId) {
      const old = await DirStore.get(previous.dirId);
      if (old?.handle && !await rec.handle.isSameEntry(old.handle)) throw Error('此完整路径已经关联另一个实际目录，请选择原目录或填写新目录的完整路径');
    }
    const known = dirs.find(d => d.id === dirId);
    const directory = { ...known, id: dirId, backend: 'directory', name, addedAt: known?.addedAt || rec.addedAt || Date.now() };
    const next = [directory, ...dirs.filter(d => d.id !== dirId)]; await indexDirectoryIdentities(next);
    taskDirectoryBindings[DirPaths.key(path)] = { dirId, path, filters: { mine_code: filters?.mine_code || '', truck_no: filters?.truck_no || '' }, at: Date.now() };
    await chrome.storage.local.set({ dirs: next, lastDirId: dirId, taskDirectoryBindings });
    return directory;
  });
}
async function registerDirectory(dirId, path) {
  const rec = await DirStore.get(dirId);
  if (!rec?.handle || await DirStore.permission(rec) !== 'granted') throw new Error('目录需要授权');
  const verifiedPath = DirPaths.normalize(path);
  await DirStore.put({ ...rec, path: verifiedPath });
  const { dirs = [] } = await chrome.storage.local.get('dirs');
  const entry = { id: dirId, name: rec.handle.name || rec.name, path: verifiedPath, addedAt: Date.now() };
  await chrome.storage.local.set({ dirs: [entry, ...dirs.filter((d) => d.id !== dirId)], lastDirId: dirId, directoryInput: verifiedPath });
  return entry;
}
async function resolveDirectoryInput(value) {
  const path = DirPaths.normalize(value);
  if (!path) { await chrome.storage.local.set({ lastDirId: '', directoryInput: '' }); return null; }
  const { dirs = [] } = await chrome.storage.local.get('dirs');
  const candidates = dirs.filter((d) => d.path && DirPaths.relative(d.path, path) !== null).sort((a, b) => b.path.length - a.path.length);
  for (const d of candidates) {
    const rec = await DirStore.get(d.id);
    if (!rec?.handle || await DirStore.permission(rec) !== 'granted') continue;
    const parts = DirPaths.relative(d.path, path);
    if (!parts.length) return registerDirectory(d.id, d.path);
    let handle = rec.handle;
    for (const part of parts) handle = await handle.getDirectoryHandle(part);
    const id = crypto.randomUUID(); await DirStore.put({ id, name: handle.name, handle });
    return registerDirectory(id, path);
  }
  throw new Error('浏览器无法按输入路径授权新目录，请点击「选择保存目录」选择该目录');
}
async function retireLegacyDirectoryProbe() {
  const { directoryProbe: p } = await chrome.storage.local.get('directoryProbe');
  if (!p) return;
  // 仅清理旧版本自己创建的校验下载；不触碰 bag 文件、任务或目录句柄。
  if (p.filename?.startsWith('BagFlow-path-') && p.url?.startsWith('data:text/plain;charset=utf-8,') && chrome.downloads?.search) {
    try {
      const found = await chrome.downloads.search(p.downloadId != null ? { id: p.downloadId } : { url: p.url });
      const d = found.find((x) => x.url === p.url && x.byExtensionId === chrome.runtime.id);
      if (d?.state === 'in_progress') await chrome.downloads.cancel(d.id).catch(() => {});
      if (d?.state === 'complete') await chrome.downloads.removeFile(d.id).catch(() => {});
      if (d) await chrome.downloads.erase({ id: d.id }).catch(() => {});
    } catch (_) { /* 旧下载记录已被清理时直接移除失效的确认状态。 */ }
  }
  await directoryLocked(async () => {
    const { directoryProbe: current } = await chrome.storage.local.get('directoryProbe');
    if (current?.id === p.id) await chrome.storage.local.remove('directoryProbe');
  });
}
