// 包名表示录制开始。只有连续下一包的开始时间，才能确认当前包的结束边界。
(function(root) {
  const C = root.BagCore;
  function identity(row, task, mdc = false) {
    const f = task.filters;
    return !!C.filenameTime(row.filename) && (!row.truck_no || C.text(row.truck_no) === f.truck_no) &&
      (!row.mine_code || C.text(row.mine_code) === f.mine_code) && C.typeMatches(row.filename, f.bag_type) &&
      (mdc || !f.break_source || C.text(row.break_source) === f.break_source);
  }
  function sequence(name) {
    const n = String(name).match(/[_-](\d+)\.bag$/i);
    const dates = [...String(name).matchAll(/20\d{2}[-_]\d{2}[-_]\d{2}[-_T]\d{2}[-_:]\d{2}[-_:]\d{2}/g)];
    return { index: n && Number.isSafeInteger(Number(n[1])) ? Number(n[1]) : null, stream: dates.length ? name.slice(0, dates.at(-1).index) : '' };
  }
  function endExclusive(task) { return C.localTime(new Date(+new Date(task.end.replace(' ', 'T')) + 1000)); }
  function catalog(rows, task, mdc = false) {
    const all = [...new Map(rows.filter(r => identity(r, task, mdc)).map(r => [r.filename, {
      filename: r.filename, create_time: C.filenameTime(r.filename), filesize: r.filesize,
      truck_no: r.truck_no, mine_code: r.mine_code, break_source: r.break_source, coverageOrigin: mdc ? 'mdc' : 'archive',
      ...(r.dirpath ? { dirpath: r.dirpath } : {}),
    }])).values()].sort(C.sort);
    const end = endExclusive(task), keep = new Set([...(task.items || []), ...(task.transfers || [])].map(i => i.filename));
    const before = all.filter(r => r.create_time <= task.start).at(-1), after = all.find(r => r.create_time >= end);
    return all.filter(r => r === before || r === after || (r.create_time > task.start && r.create_time < end) || keep.has(r.filename));
  }
  function plan(rows, task) {
    const actual = rows.filter(r => identity(r, task, r.coverageOrigin === 'mdc'));
    // 已接受回传或下载完成的包可沿用先前证明的边界，清理服务端清单不撤销成功记录。
    const protectedNames = new Set([...(task.transfers || []).filter(i => i.accepted || i.state === 'done'),
      ...(task.items || []).filter(i => i.state === 'done')].map(i => i.filename));
    const evidence = (task.coverage?.evidence || []).filter(r => protectedNames.has(r.filename) && r.recordingEnd);
    const remembered = evidence.flatMap(r => r.nextFilename ? [r, { filename: r.nextFilename, create_time: r.recordingEnd, coverageOrigin: 'mdc' }] : [r]);
    const all = [...new Map([...remembered, ...actual].map(r => [r.filename, r])).values()].sort(C.sort);
    const end = endExclusive(task), startMillis = +new Date(task.start.replace(' ', 'T')), issues = [], selected = [], provisional = [];
    const boundStop = name => {
      const b = task.recordingBounds?.[name];
      return b?.filename === name && C.localTime(new Date(b.start)) === C.filenameTime(name) && Number.isSafeInteger(b.stop) && b.stop > b.start ? b.stop : 0;
    };
    const excluded = new Set([...(task.coverage?.targets || []), ...all.map(r => r.filename), ...(task.items || []).map(i => i.filename)].filter(name =>
      !task.legacySelectedFilenames?.includes(name) && C.filenameTime(name) < task.start && boundStop(name) && boundStop(name) <= startMillis));
    let coversStart = false;
    let first = -1;
    for (let n = 0; n < all.length; n++) if (C.filenameTime(all[n].filename) <= task.start) first = n;
    if (first < 0) {
      issues.push({ code: 'START_MISSING', message: `未找到覆盖开始时刻 ${task.start} 的数据包` });
      first = all.findIndex(r => C.filenameTime(r.filename) < end);
    }
    if (first >= 0) for (let n = first; n < all.length; n++) {
      const r = all[n], start = C.filenameTime(r.filename), next = all[n + 1], stop = next ? C.filenameTime(next.filename) : '';
      if (start >= end) break;
      if (excluded.has(r.filename) || (stop && stop <= task.start)) continue;
      const a = sequence(r.filename), b = next && sequence(next.filename);
      const adjacent = next && a.index != null && b.index === a.index + 1 && a.stream === b.stream;
      const tail = !next || stop >= end, verifiedStop = boundStop(r.filename);
      // 起点之前的包只是候选，必须证明它实际与任务重叠，才能进入执行队列。
      if (start < task.start && !adjacent && !verifiedStop) {
        provisional.push(r.filename);
        issues.push({ code: 'START_UNKNOWN', filename: r.filename, message: `尚未确认覆盖开始时刻 ${task.start} 的数据包，正在核查录制边界` });
        continue;
      }
      if (start < task.start && verifiedStop && verifiedStop <= startMillis) continue;
      if (start <= task.start) coversStart = true;
      let proven = !!adjacent, recordingEnd = proven ? stop : '';
      if (tail && !adjacent) {
        if (verifiedStop >= +new Date(end.replace(' ', 'T'))) { proven = true; recordingEnd = C.localTime(new Date(verifiedStop)); }
        else issues.push({ code: verifiedStop ? 'END_MISSING' : 'END_UNKNOWN', filename: r.filename,
          message: verifiedStop ? `末包 ${C.shortFilename(r.filename)} 实际录制结束于 ${C.localTime(new Date(verifiedStop))}，未覆盖至 ${task.end}` : `末包 ${C.shortFilename(r.filename)} 的录制结束时间尚未确认，正在核查是否覆盖至 ${task.end}` });
      } else if (!adjacent && (a.index == null || b.index == null || a.stream !== b.stream || b.index <= a.index)) {
        proven = false; issues.push({ code: 'SEQUENCE_UNKNOWN', filename: r.filename, message: `${C.shortFilename(r.filename)} → ${C.shortFilename(next.filename)} 的连续性无法确认` });
      } else if (!adjacent) {
        proven = false; issues.push({ code: 'PACKAGES_MISSING', filename: r.filename, missing: b.index - a.index - 1,
          message: `包序号 ${a.index} → ${b.index} 缺少 ${b.index - a.index - 1} 个包（${start} → ${stop}）` });
      }
      selected.push({ ...r, create_time: start, recordingEnd, nextFilename: adjacent ? next.filename : '' });
    }
    if (!coversStart && !issues.some(i => i.code.startsWith('START_'))) issues.push({ code: 'START_MISSING', message: `尚未找到覆盖开始时刻 ${task.start} 的数据包` });
    const present = new Set(actual.map(r => r.filename));
    for (const name of task.coverage?.targets || []) {
      if (excluded.has(name)) continue;
      const transferred = (task.transfers || []).some(i => i.filename === name && (i.accepted || i.state === 'done'));
      const downloaded = (task.items || []).some(i => i.filename === name && i.state === 'done');
      if (!present.has(name) && !transferred && !downloaded) issues.push({ code: 'TARGET_REMOVED', filename: name, message: `已确认的目标包缺失：${C.shortFilename(name)}` });
    }
    for (const i of [...(task.items || []), ...(task.transfers || [])]) if (!excluded.has(i.filename) && i.coverageMissing && i.state !== 'done' &&
        !issues.some(issue => issue.code === 'TARGET_REMOVED' && issue.filename === i.filename)) {
      issues.push({ code: 'TARGET_REMOVED', filename: i.filename, message: `服务器报告目标包不存在：${C.shortFilename(i.filename)}` });
    }
    return { complete: selected.length > 0 && issues.length === 0, selected,
      targets: [...new Set([...(task.coverage?.targets || []), ...selected.map(r => r.filename)])].filter(name => !excluded.has(name)), issues, provisional, excluded: [...excluded],
      evidence: selected.filter(r => r.recordingEnd).map(r => ({ filename: r.filename, recordingEnd: r.recordingEnd, nextFilename: r.nextFilename, coverageOrigin: 'mdc' })),
      coveredStart: selected[0]?.create_time || '', coveredEnd: selected.at(-1)?.recordingEnd || '' };
  }
  root.BagCoverage = { identity, sequence, endExclusive, catalog, plan };
  if (typeof module !== 'undefined') module.exports = root.BagCoverage;
})(globalThis);
