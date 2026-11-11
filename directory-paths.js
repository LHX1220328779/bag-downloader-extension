(function (root) {
  // 仅处理路径字符串；浏览器下载用实际根目录约束，旧任务仍用授权目录句柄。
  function normalize(value) {
    let s = String(value || '').trim();
    if (!s) return '';
    if (/[\x00-\x1f]/.test(s)) throw new Error('目录路径包含无效字符');
    const windows = /^[a-z]:[\\/]/i.test(s) || /^\\\\/.test(s);
    if (windows) s = s.replace(/\\/g, '/');
    if (!windows && !s.startsWith('/')) throw new Error('请输入完整的本地绝对路径');
    if (s.split('/').some((x) => x === '.' || x === '..')) throw new Error('请使用不含 . 或 .. 的完整路径');
    if (windows && s.startsWith('//') && s.split('/').filter(Boolean).length < 2) throw new Error('网络路径需要服务器和共享目录');
    const unc = windows && s.startsWith('//');
    s = s.replace(/\/+/g, '/'); if (unc) s = '/' + s;
    s = s.replace(/\/+$/, '');
    if (!s) return '/';
    if (/^[a-z]:$/i.test(s)) s += '/';
    return windows ? s.replace(/\//g, '\\') : s;
  }
  const key = (value) => {
    const s = normalize(value);
    return /^[a-z]:\\|^\\\\/i.test(s) ? s.replace(/\\/g, '/').toLowerCase() : s;
  };
  function relative(base, target) {
    const a = key(base), b = key(target);
    if (!a || !b) return null;
    if (a === b) return [];
    const prefix = a.endsWith('/') ? a : a + '/';
    if (!b.startsWith(prefix)) return null;
    const normalized = normalize(target);
    return (/^[a-z]:\\|^\\\\/i.test(normalized) ? normalized.replace(/\\/g, '/') : normalized).slice(prefix.length).split('/').filter(Boolean);
  }
  function splitFile(value) {
    const path = normalize(value), windows = /^[a-z]:\\|^\\\\/i.test(path), s = windows ? path.replace(/\\/g, '/') : path, i = s.lastIndexOf('/');
    if (i < 0 || i === s.length - 1) throw new Error('无法读取浏览器保存路径');
    const parent = i === 0 ? '/' : s.slice(0, i) + (/^[a-z]:$/i.test(s.slice(0, i)) ? '/' : '');
    return { directory: normalize(windows ? parent.replace(/\//g, '\\') : parent), name: s.slice(i + 1) };
  }
  function leaf(value) {
    const normalized = normalize(value), windows = /^[a-z]:\\|^\\\\/i.test(normalized);
    const parts = (windows ? normalized.replace(/\\/g, '/') : normalized).split('/').filter(Boolean);
    return parts.at(-1) || '/';
  }
  function commonAncestor(values) {
    const paths = values.filter(Boolean).map(normalize);
    if (!paths.length) return '';
    let parent = paths[0];
    while (!paths.every(value => relative(parent, value) !== null)) {
      try { const next = splitFile(parent).directory; if (next === parent) return ''; parent = next; }
      catch (_) { return ''; }
    }
    return parent;
  }
  root.DirPaths = { normalize, key, relative, splitFile, leaf, commonAncestor };
  if (typeof module !== 'undefined') module.exports = root.DirPaths;
})(globalThis);
