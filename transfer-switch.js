// 回传开关的归属、确认和重试规则。文件名/分钟时间只能核查进度，不能证明记录由本任务创建。
(function (root) {
  const C = root.BagCore;
  const PAUSABLE = ['waiting', 'downloading', 'cancelpause', 'failed'];
  const STATES = [...PAUSABLE, 'pause', 'succeed'];
  function recordId(value) {
    const id = String(value ?? '');
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
  }
  function marker(t, i) {
    let hash = 2166136261;
    for (const ch of i.key || C.fileKey(i)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    return `[BagFlow:${t.id}:${hash.toString(16)}]`;
  }
  function inScope(t, r) {
    const type = C.text(r.bag_type || r.task_type);
    return C.text(r.truck_no) === t.filters.truck_no && r.break_source === 'mdc' &&
      (!C.text(r.mine_code) || C.text(r.mine_code) === t.filters.mine_code) &&
      (!type || !t.filters.bag_type || C.typeMatches(type, t.filters.bag_type));
  }
  function tagged(t, r) {
    const remarks = C.text(r.remarks);
    if (remarks.includes(`[BagFlowTask:${t.id}]`)) return true;
    // 兼容单包旧标记，必须是完整的 ID 和十六进制哈希。
    if ([...remarks.matchAll(/\[BagFlow:([^\]\s:]+):([a-f0-9]{1,8})\]/g)].some(m => m[1] === t.id)) return true;
    const batches = new Set([...(t.transferBatchIds || []), ...(t.transfers || []).map(i => i.batchId)].filter(Boolean));
    return [...remarks.matchAll(/\[BagFlowBatch:([A-Za-z0-9_-]{1,128})\]/g)].some(m => batches.has(m[1]));
  }
  function owns(t, r) {
    if (!inScope(t, r)) return false;
    const id = recordId(r.record_no);
    return tagged(t, r) || !!(id && (t.transferControlRecords || []).some(x => x.recordNo === id)) || !!binding(t, r);
  }
  function matchesFile(i, r) {
    const filename = C.text(i.filename);
    if (!filename) return false;
    if (C.text(r.filename)) return C.text(r.filename) === filename;
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`).test(C.text(r.msg));
  }
  function binding(t, r) {
    const id = recordId(r.record_no);
    if (!id || !inScope(t, r) || C.text(r.remarks).includes('[BagFlow')) return null;
    // 兼容旧任务：必须同时保留原编号、已保存的提交批次、提交时间、接受状态及完整包名。
    // 进度查询匹配到的同名外部记录，只有 recordNo 或分钟时间，不能取得控制权。
    const batches = new Set(t.transferBatchIds || []);
    const item = (t.transfers || []).find(i => recordId(i.recordNo) === id && i.accepted === true &&
      i.submissionLocked === true && Number(i.attempts) > 0 && Number.isFinite(i.submittedAt) && i.submittedAt > 0 &&
      (!t.createdAt || i.submittedAt >= t.createdAt) && !i.submissionRejected &&
      recordId(i.batchId) && batches.has(i.batchId) && matchesFile(i, r));
    const original = item && (t.transferControlRecords || []).some(x => x.recordNo !== id && x.provenance?.filename === item.filename);
    return item && !original ? { kind: 'legacy-binding', filename: item.filename, batchId: item.batchId, submittedAt: item.submittedAt } : null;
  }
  function remember(t, rows, now) {
    const known = new Map((t.transferControlRecords || []).map(r => [r.recordNo, r]));
    const store = (row, proof) => {
      const id = recordId(row.record_no);
      const entry = known.get(id) || { recordNo: id };
      entry.provenance ||= proof;
      if (proof.filename) entry.provenance.filename ||= proof.filename;
      entry.status = C.text(row.status); entry.seenAt = now;
      known.set(id, entry);
    };
    // 先登记有标记或已确认的原记录，再补历史绑定，防止旧进度命中的同名外部记录取代原记录。
    for (const row of rows) {
      const id = recordId(row.record_no), marked = tagged(t, row);
      if (!id || !inScope(t, row) || (!marked && !known.has(id))) continue;
      const items = (t.transfers || []).filter(i => matchesFile(i, row));
      store(row, { kind: marked ? 'server-marker' : 'confirmed-record', ...(items.length === 1 ? { filename: items[0].filename } : {}) });
    }
    t.transferControlRecords = [...known.values()];
    for (const row of rows) {
      const id = recordId(row.record_no);
      if (!id || known.has(id)) continue;
      const proof = binding(t, row);
      if (proof) store(row, proof);
    }
    t.transferControlRecords = [...known.values()];
    return known;
  }
  function needsCommand(enabled, status) {
    return enabled ? status === 'pause' : PAUSABLE.includes(status);
  }
  function delay(attempts) { return Math.min(300000, 30000 * 2 ** Math.min(4, Math.max(0, attempts - 1))); }
  function needsSync(t, now) {
    if (!C.wantsTransfer(t) || !t.transferControlRevision) return false;
    if (t.transferControl?.revision !== t.transferControlRevision) return true;
    if (now < (t.transferControl?.nextCheckAt || 0)) return false;
    if (t.transferControl?.phase !== 'settled') return true;
    const unfinished = (t.transferControlRecords || []).some(r => r.status !== 'succeed');
    return unfinished || (t.status !== 'done' && (t.transfers || []).some(i => !i.coverageExcluded && i.state !== 'done'));
  }
  function hasItemRecord(t, i, records) {
    const id = recordId(i.recordNo);
    if (id) return records.some(r => recordId(r.record_no) === id);
    if (records.some(r => C.text(r.remarks).includes(marker(t, i)) || matchesFile(i, r))) return true;
    if (!i.batchId) return false;
    const peers = (t.transfers || []).filter(x => x.batchId === i.batchId);
    const ids = new Set(records.filter(r => !r.filename && C.text(r.remarks).includes(`[BagFlowBatch:${i.batchId}]`))
      .map(r => recordId(r.record_no)).filter(Boolean));
    // 没有单包编号的旧批次也要核对记录数量，不能用一条同批记录代表所有包。
    return peers.length > 0 && ids.size >= peers.length;
  }
  function hasSharedItemRecord(t, i, records) {
    const id = recordId(i.recordNo);
    if (!id || i.accepted !== true || i.batchId || i.submittedAt || ['submitting', 'uncertain'].includes(i.state)) return false;
    // 容量拒绝会保留 attempts；后来复用其他任务的结果时，没有本任务在途提交。
    // 本次查询必须确认原编号、完整包名和作用域；共享引用不取得暂停/恢复控制权。
    return records.some(r => recordId(r.record_no) === id && inScope(t, r) && matchesFile(i, r) && !owns(t, r));
  }
  function message(control) {
    const action = control.enabled ? '恢复' : '暂停';
    if (control.error) return `回传${action}未完成，自动重试：${control.error}`;
    if (control.remaining) return control.enabled ? `正在恢复回传：${control.remaining} 条记录等待服务器确认` :
      `正在暂停回传：已暂停 ${control.paused} / ${control.total} 条，等待服务器确认`;
    if (control.awaitingRecords) return `回传已${control.enabled ? '开启' : '关闭'}，正在核对 ${control.awaitingRecords} 个在途或待确认的提交`;
    return control.enabled ? '回传已开启，继续处理剩余数据包' : control.total ?
      `回传已关闭，${control.paused} 条未完成回传已暂停，不再追加新回传` : '回传已关闭，不再追加新回传';
  }
  function synchronize(t, rows, now) {
    const enabled = C.isTransferEnabled(t), revision = t.transferControlRevision;
    const known = remember(t, rows, now);
    const visible = new Map(); let invalid = 0;
    for (const r of rows) {
      if (!owns(t, r)) continue;
      const id = recordId(r.record_no);
      if (!id) { if (r.status !== 'succeed') invalid++; continue; }
      visible.set(id, r);
      const entry = known.get(id) || { recordNo: id };
      entry.status = C.text(r.status); entry.seenAt = now;
      if (!needsCommand(enabled, entry.status) && STATES.includes(entry.status)) {
        // 以服务器查询结果确认；即使上一次 RPC 超时，也不能继续显示失败或盲目重发。
        entry.error = ''; entry.pending = false; entry.attempts = 0; entry.retryAt = 0;
        entry.confirmedRevision = revision;
      }
      known.set(id, entry);
    }
    t.transferControlRecords = [...known.values()];
    const unfinished = t.transferControlRecords.filter(r => r.status !== 'succeed');
    const missing = unfinished.filter(r => !visible.has(r.recordNo)).length;
    const unknown = unfinished.filter(r => visible.has(r.recordNo) && !STATES.includes(r.status)).length;
    const remaining = unfinished.filter(r => !visible.has(r.recordNo) || !STATES.includes(r.status) || needsCommand(enabled, r.status));
    const commands = remaining.filter(r => visible.has(r.recordNo) && needsCommand(enabled, r.status) &&
      (r.commandRevision !== revision || r.commandEnabled !== enabled || now >= (r.retryAt || 0))).map(r => visible.get(r.recordNo));
    const owned = [...visible.values()];
    const awaitingRecords = (t.transfers || []).filter(i => !i.coverageExcluded && i.state !== 'done' &&
      i.submissionLocked && (i.attempts || i.submittedAt) && !hasItemRecord(t, i, owned) && !hasSharedItemRecord(t, i, rows)).length;
    const failed = remaining.find(r => r.commandRevision === revision && r.error);
    const error = invalid ? `${invalid} 条本任务回传的记录编号无效` : unknown ? `${unknown} 条回传状态未知` :
      missing ? `${missing} 条已确认属于本任务的记录暂未返回，持续核查` : failed?.error || '';
    t.transferControl = { enabled, revision, total: unfinished.length + invalid, paused: unfinished.filter(r => r.status === 'pause').length,
      remaining: remaining.length + invalid, awaitingRecords, error, checkedAt: now,
      phase: error ? 'retry' : remaining.length || invalid ? 'pending' : awaitingRecords ? 'waiting' : 'settled',
      nextCheckAt: now + (C.ACTIVE.includes(t.status) ? 15000 : 60000) };
    for (const r of remaining) if (r.commandRevision === revision && r.retryAt > now) {
      t.transferControl.nextCheckAt = Math.min(t.transferControl.nextCheckAt, r.retryAt);
    }
    t.transferControl.message = message(t.transferControl);
    return commands;
  }
  const api = { marker, recordId, inScope, tagged, owns, matchesFile, binding, remember, needsCommand, delay, needsSync, synchronize, message };
  root.TransferSwitch = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
