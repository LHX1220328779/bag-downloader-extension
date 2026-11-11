// 可独立测试的筛选和队列规则；后台与页面不依赖彼此的生命周期。
(function (root) {
  const ACTIVE = ['fetching', 'running', 'waiting_vehicle'];
  const text = (v) => v == null ? '' : String(v).trim();
  function time(v) {
    return text(v).replace('T', ' ').replace(/\.\d+(?:Z)?$/, '').slice(0, 19);
  }
  function validTime(v) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v || '')) return false;
    const d = new Date(v.replace(' ', 'T'));
    return Number.isFinite(+d) && localTime(d) === v;
  }
  function localTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function filenameTime(filename) {
    // MDC create_time 可能是写入/修改时间；以文件名末尾的完整录制时间为准。
    const dates = [...text(filename).matchAll(/(20\d{2})[-_](\d{2})[-_](\d{2})[-_T](\d{2})[-_:](\d{2})[-_:](\d{2})(?=[_.-]|$)/g)];
    for (const d of dates.reverse()) {
      const value = `${d[1]}-${d[2]}-${d[3]} ${d[4]}:${d[5]}:${d[6]}`;
      if (validTime(value)) return value;
    }
    return '';
  }
  function recordingTime(row) {
    return filenameTime(row.filename) || time(row.create_time);
  }
  const sort = (a, b) => recordingTime(a).localeCompare(recordingTime(b)) || text(a.filename).localeCompare(text(b.filename));
  function typeMatches(filename, type) {
    const name = text(filename).toLowerCase(), prefix = text(type).toLowerCase();
    if (prefix.endsWith('*')) return name.startsWith(prefix.slice(0, -1));
    return name.split(/[_\.]/)[0] === prefix;
  }
  function matches(row, task, mdc = false, knownFiles = null) {
    const selected = (task.coverageMode === 'interval' && (knownFiles ? knownFiles.has(row.filename) : task.coverage?.targets?.includes(row.filename))) || (!mdc && (task.strictFilenameTime
      ? !!task.legacySelectedFilenames && (knownFiles ? knownFiles.has(row.filename) : task.legacySelectedFilenames.includes(row.filename))
      : task.kind === 'transfer' && (knownFiles ? knownFiles.has(row.filename) : (task.transfers || []).some((i) => i.filename === row.filename))));
    const f = task.filters, t = task.strictFilenameTime && !selected ? filenameTime(row.filename) : recordingTime(row);
    if (!row.filename || !validTime(t) || (!selected && (t < task.start || t > task.end))) return false;
    if (row.truck_no && text(row.truck_no) !== f.truck_no) return false;
    if (row.mine_code && text(row.mine_code) !== f.mine_code) return false;
    if (!typeMatches(row.filename, f.bag_type)) return false;
    if (!mdc && f.break_source && text(row.break_source) !== f.break_source) return false;
    return true;
  }
  const fileKey = (r) => `${text(r.filename)}|${recordingTime(r)}`;
  const wantsTransfer = (t) => t.operations ? t.operations.transfer === true : t.kind === 'transfer';
  const wantsDownload = (t) => t.operations ? t.operations.download === true : true;
  const isTransferEnabled = (t) => wantsTransfer(t) && t.transferEnabled !== false;
  function applyTransferSelection(t, selection) {
    if (selection && typeof selection.enabled === 'boolean' && Number.isSafeInteger(selection.revision) && selection.revision >= 0) {
      t.transferEnabled = wantsTransfer(t) && selection.enabled;
      t.transferControlRevision = selection.revision;
    }
    return t;
  }
  function mergeDownloads(task, rows) {
    const byPath = new Map((task.items || []).map((i) => [i.dirpath, i]));
    const knownFiles = new Set([...(task.strictFilenameTime ? task.legacySelectedFilenames || [] : (task.transfers || []).map((i) => i.filename)), ...(task.coverage?.targets || [])]);
    for (const r of rows) {
      if (!r.dirpath || !matches(r, task, false, knownFiles)) continue;
      if (!byPath.has(r.dirpath)) byPath.set(r.dirpath, {
        dirpath: r.dirpath, filename: r.filename, filesize: r.filesize, create_time: recordingTime(r),
        state: 'pending', attempts: 0, jobId: null, phaseAt: 0, overwrite: false, recordingEnd: r.recordingEnd || '',
      });
    }
    task.items = [...byPath.values()].sort(sort);
  }
  function mergeTransfers(task, rows) {
    const prev = new Map((task.transfers || []).map((i) => [fileKey(i), i]));
    for (const r of rows) {
      if (!matches(r, task, true, new Set(task.coverage?.targets || []))) continue;
      const key = fileKey(r);
      if (!prev.has(key)) prev.set(key, {
        key, truck_no: task.filters.truck_no, filename: r.filename, create_time: recordingTime(r),
        filesize: r.filesize, state: 'pending', attempts: 0, percentage: 0, recordingEnd: r.recordingEnd || '',
      });
    }
    task.transfers = [...prev.values()].sort(sort);
  }
  function normalizeTask(t) {
    t.kind ||= 'download'; t.items ||= []; t.transfers ||= []; t.runToken ||= '';
    t.operations ||= { transfer: t.kind === 'transfer', download: true };
    t.transferEnabled = isTransferEnabled(t);
    if (!Number.isSafeInteger(t.transferControlRevision) || t.transferControlRevision < 0) t.transferControlRevision = 0;
    // 旧批次和容量拒绝后被清空的条目仍需保留归属证据，开关不能按同名文件控制其他任务。
    t.transferBatchIds = [...new Set([...(Array.isArray(t.transferBatchIds) ? t.transferBatchIds : []), ...t.transfers.map(i => i.batchId)]
      .filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
    if (!Array.isArray(t.transferControlRecords)) t.transferControlRecords = [];
    if (t.downloadBackend === 'browser' && t.browserRelativeDir == null) t.browserRelativeDir = 'bags';
    // 旧任务后续发现也使用严格包名时间；已经进入原队列的文件继续处理，不撤销进度。
    if (t.strictFilenameTime !== true) {
      t.legacySelectedFilenames ||= [...new Set([...t.items, ...t.transfers].map((i) => i.filename).filter(Boolean))];
      t.strictFilenameTime = true;
    }
    // v1.2 按数组下标定位下载；v2 始终通过 jobId 定位，合并、排序不会错配。
    delete t.inflightIndex;
    for (const i of t.items) {
      i.attempts ||= 0;
      if (i.state === 'downloading' && !i.jobId) i.state = 'pending';
    }
    // 升级只补全字段：已尝试的回传不能因重载/掉线被重置为“未提交”。
    for (const i of t.transfers) {
      i.key ||= fileKey(i);
      if (i.submissionLocked == null) i.submissionLocked = !!(i.attempts || i.submittedAt || i.recordNo || ['submitting', 'submitted', 'confirming', 'uncertain', 'done'].includes(i.state));
      if (i.submissionLocked && i.state === 'pending') i.state = 'uncertain';
      if (i.submissionLocked && i.state === 'failed') i.state = 'server_failed';
      if (i.accepted == null) i.accepted = !!(i.recordNo || ['submitted', 'confirming', 'done'].includes(i.state));
    }
    // 完成任务不再占用同车容量冷却，旧时间戳也不能在系统时钟回拨后挡住新任务。
    if (t.status === 'done') delete t.transferRetryAt;
    return t;
  }
  function inputTime(v) {
    const s = text(v).replace('T', ' ');
    const full = s.length === 16 ? s + ':00' : s;
    return validTime(full) ? full : '';
  }
  function shortFilename(name) {
    const s = text(name);
    const dates = [...s.matchAll(/20\d{2}-\d{2}-\d{2}(?:[-_T]\d{2}[-_:]\d{2}[-_:]\d{2})?/g)];
    return dates.length ? s.slice(dates.at(-1).index) : s;
  }
  const api = { ACTIVE, text, time, validTime, localTime, filenameTime, recordingTime, sort, typeMatches, matches, fileKey, wantsTransfer, wantsDownload, isTransferEnabled, applyTransferSelection, mergeDownloads, mergeTransfers, normalizeTask, inputTime, shortFilename };
  root.BagCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
