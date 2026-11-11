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
    return C.text(r.truck_no) === t.filters.truck_no && r.break_source === 'mdc' &&
      (!C.text(r.mine_code) || C.text(r.mine_code) === t.filters.mine_code);
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
    return tagged(t, r) || !!(id && (t.transferControlRecords || []).some(x => x.recordNo === id));
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
    return records.some(r => recordId(r.record_no) === recordId(i.recordNo) || C.text(r.remarks).includes(marker(t, i)) ||
      r.filename === i.filename || C.text(r.msg).includes(i.filename) ||
      (!r.filename && i.batchId && C.text(r.remarks).includes(`[BagFlowBatch:${i.batchId}]`)));
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
    const known = new Map((t.transferControlRecords || []).map(r => [r.recordNo, r]));
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
      i.submissionLocked && (i.attempts || i.submittedAt) && !hasItemRecord(t, i, owned)).length;
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
  const api = { marker, recordId, inScope, tagged, owns, needsCommand, delay, needsSync, synchronize, message };
  root.TransferSwitch = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
