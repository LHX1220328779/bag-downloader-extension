(function (root) {
  const D = root.DirPaths || require('./directory-paths.js');
  const filterKey = f => JSON.stringify([f?.mine_code || '', f?.truck_no || '']);
  function entries(history = [], tasks = []) {
    return [...history, ...tasks.filter(t => t.operations?.download !== false).map(t => ({
      path: t.dirPath, ...t.filters, at: t.createdAt || 0,
    }))].flatMap(e => {
      try { const path = D.normalize(e.path); return path ? [{ ...e, path }] : []; } catch (_) { return []; }
    }).sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  function choices(filters, history, tasks) {
    const key = filterKey(filters), seen = new Set();
    return entries(history, tasks).sort((a, b) => Number(filterKey(b) === key) - Number(filterKey(a) === key)).filter(e => {
      const key = D.key(e.path); if (seen.has(key)) return false; seen.add(key); return true;
    });
  }
  function preferred(filters, drafts = {}, history, tasks, browserRoot = '') {
    const key = filterKey(filters);
    // 空字符串也是用户保存的草稿；删除输入后不能被刷新或历史记录重新填上。
    if (Object.hasOwn(drafts, key)) return drafts[key];
    return entries(history, tasks).find(e => filterKey(e) === key)?.path || browserRoot;
  }
  function remember(history, filters, path, at) {
    const entry = { path: D.normalize(path), truck_no: filters.truck_no, mine_code: filters.mine_code, at };
    return [entry, ...entries(history).filter(e => !(filterKey(e) === filterKey(entry) && D.key(e.path) === D.key(entry.path)))].slice(0, 50);
  }
  function resolve(browserRoot, input) {
    const base = D.normalize(browserRoot), target = D.normalize(input) || base;
    if (!base) throw Error('无法确认浏览器下载位置');
    if (D.relative(base, target) === null) {
      const common = D.commonAncestor([base, target]);
      throw Error(common ? `请将浏览器下载位置一次设为 ${common}，再创建任务` : `保存目录 ${target} 不在浏览器下载位置 ${base} 下，请调整浏览器下载位置`);
    }
    return target;
  }
  function handleChoices(filters, dirs = [], history = [], tasks = []) {
    const usage = [...history.filter(e => e.dir_id), ...tasks.filter(t => t.downloadBackend !== 'browser' && t.operations?.download !== false).map(t => ({ ...t.filters, dir_id: t.dirId, at: t.createdAt || 0 }))];
    return dirs.filter(d => d.backend !== 'browser').map(dir => {
      const uses = usage.filter(e => e.dir_id === dir.id), same = uses.filter(e => filterKey(e) === filterKey(filters));
      const labelled = uses.filter(e => Object.hasOwn(e, 'path')).sort((a,b) => b.at - a.at)[0];
      return { ...dir, ...(labelled ? { displayPath: labelled.path } : {}), matching: same.length > 0, usedAt: Math.max(0, ...uses.map(e => e.at || 0)), truck_no: same[0]?.truck_no || uses.sort((a,b) => b.at - a.at)[0]?.truck_no || '' };
    }).sort((a,b) => Number(b.matching) - Number(a.matching) || b.usedAt - a.usedAt || (b.addedAt || 0) - (a.addedAt || 0));
  }
  function pathDirectory(input, bindings = {}, dirs = [], history = [], tasks = []) {
    const path = D.normalize(input); if (!path) return null;
    const key = D.key(path), binding = bindings[key];
    const find = id => dirs.find(d => d.id === id && d.backend !== 'browser') || null;
    if (binding) return find(binding.dirId);
    // 只复用成功创建时的完整路径；输入草稿、相同末级目录名不能成为绑定。
    const uses = [...history.filter(e => e.dir_id && e.backend !== 'browser').map(e => ({ path: e.path, id: e.dir_id })),
      ...tasks.filter(t => t.downloadBackend !== 'browser' && t.operations?.download !== false).map(t => ({ path: t.dirPath, id: t.dirId }))];
    const ids = new Set(uses.filter(e => { try { return e.path && D.key(e.path) === key && find(e.id); } catch (_) { return false; } }).map(e => e.id));
    return ids.size === 1 ? find([...ids][0]) : null;
  }
  function pathChoices(filters, bindings = {}, dirs = [], history = [], tasks = []) {
    const bound = Object.values(bindings).map(e => ({ path: e.path, dir_id: e.dirId, at: e.at, ...e.filters }));
    return choices(filters, [...history, ...bound], tasks).flatMap(e => {
      const dir = pathDirectory(e.path, bindings, dirs, history, tasks);
      return dir ? [{ ...e, id: dir.id, name: dir.name }] : [];
    });
  }
  root.TaskDirectories = { filterKey, entries, choices, preferred, remember, resolve, handleChoices, pathDirectory, pathChoices };
  if (typeof module !== 'undefined') module.exports = root.TaskDirectories;
})(globalThis);
