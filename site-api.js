// 依据站点当前前端与只读接口核对的协议。回传提交成功不等于文件已回传。
(function (root) {
  const BASE = 'http://10.198.92.173:8080';
  async function post(path, body = {}, codes = [20000], timeout = 25000) {
    let response;
    try {
      response = await fetch(BASE + path, {
        method: 'POST', credentials: 'include', signal: AbortSignal.timeout(timeout),
        ...(body == null ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok) { const e = new Error(`HTTP ${response.status}`); e.httpStatus = response.status; throw e; }
      const json = await response.json();
      if (!codes.includes(Number(json.code))) {
        const e = new Error(json.message || `接口返回码 ${json.code}`);
        e.rejected = true;
        throw e;
      }
      return json.data;
    } catch (e) {
      // 网络中断/HTTP 500 无法证明提交未被服务器接受，不能直接重发 mdcadd。
      e.message = `${path.split('?')[0]}：${e.message}`;
      throw e;
    }
  }
  function rows(data) {
    if (!Array.isArray(data)) throw new Error('接口未返回文件/车辆列表，将继续重试');
    return data;
  }
  function filterBody(t) {
    const body = { ...t.filters, bag_type: t.filters.bag_type.replace(/\*$/, ''), start_time: t.start, end_time: t.end };
    // 必须取得开始前和结束后的相邻包；接口 start_time/end_time 不是可靠的包录制区间。
    if (t.coverageMode === 'interval') return { ...body, start_time: '', end_time: '' };
    if (t.kind === 'transfer' && (!t.strictFilenameTime || t.legacySelectedFilenames?.length) && root.BagCore) {
      // 兼容旧任务已选文件的 MDC 时间与服务器录制时间不一致。
      const selected = t.strictFilenameTime ? new Set(t.legacySelectedFilenames) : null;
      for (const i of t.transfers || []) {
        if (selected && !selected.has(i.filename)) continue;
        const recorded = root.BagCore.recordingTime(i);
        if (!root.BagCore.validTime(recorded)) continue;
        if (recorded < body.start_time) body.start_time = recorded;
        if (recorded > body.end_time) body.end_time = recorded;
      }
    }
    return body;
  }
  function transferPath(action, recordNo) {
    const id = String(recordNo ?? '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('回传记录编号无效');
    return `/api/break/${action}/${encodeURIComponent(id)}`;
  }
  const api = {
    BASE, post,
    async lookups() {
      const paths = ['/api/truck/mine_list', '/api/truck/type_list', '/api/truck/source_list', '/api/bag/use_class'];
      const data = await Promise.all(paths.map((p) => post(p, {}, [200]).then(rows)));
      return { at: Date.now(), mines: Object.fromEntries(data[0].map((x) => [x.value, x.name])),
        types: Object.fromEntries(data[1].map((x) => [x.value, x.name])), sources: data[2], reasons: data[3] };
    },
    async search(t) {
      const body = filterBody(t);
      try { return rows(await post('/api/bag/search', body)); }
      catch (e) {
        if (e.httpStatus !== 500 || !body.truck_no || !body.mine_code || !body.bag_type) throw e;
        // 实测部分带日期的查询返回 500；仍限定车辆/矿区/类型/来源，本地二次过滤时间。
        return rows(await post('/api/bag/search', { ...body, start_time: '', end_time: '' }));
      }
    },
    async trucks(mine) { return rows(await post('/api/truck/info', { mine_code: mine })); },
    async mdc(t) { return rows(await post('/api/bag/mdcsearch?truck_no=' + encodeURIComponent(t.filters.truck_no), {}, [2000], 120000)); },
    async records(t) {
      // 网站的“任务日期”是提交时间，与数据包的录制时间不同。按车辆、矿区和类型限定。
      return rows(await post('/api/break/search', {
        truck_no: t.filters.truck_no, mine_code: t.filters.mine_code,
        bag_type: t.filters.bag_type.replace(/\*$/, ''), task_status: '', start_time: '', end_time: '',
      }));
    },
    // 与网站的暂停/恢复按钮使用同一协议；恢复保留原记录，不重新 mdcadd。
    async pauseTransfer(recordNo) { return post(transferPath('pause', recordNo), null, [200, 2000, 20000]); },
    async resumeTransfer(recordNo) { return post(transferPath('cancelpause', recordNo), null, [200, 2000, 20000]); },
    async submit(t, item) {
      return post('/api/bag/mdcadd', {
        truck_no: [t.filters.truck_no], bagtime: [item.create_time], filename: [item.filename], filesize: [item.filesize],
        use_class_code: t.reason, bug_id: t.bugId || '', remarks: t.remarks || '',
      }, [2000]);
    },
    async submitBatch(t, items) {
      if (!items.length || items.length > 10) throw new Error('每批回传需要 1–10 个文件');
      return post('/api/bag/mdcadd', {
        truck_no: items.map(() => t.filters.truck_no), bagtime: items.map((i) => i.create_time),
        filename: items.map((i) => i.filename), filesize: items.map((i) => i.filesize),
        use_class_code: t.reason, bug_id: t.bugId || '', remarks: t.remarks || '',
      }, [2000]);
    },
  };
  root.SiteAPI = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
