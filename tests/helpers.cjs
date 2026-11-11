const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const clone = (x) => structuredClone(x);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function row(name, time, extra = {}) {
  return { truck_no: 'WH-Truck05', filename: name, create_time: `2026-11-03 ${time}`, filesize: 1,
    dirpath: '/data/' + name, break_source: 'mdc', ...extra };
}
const a = row('Perception_2026-11-03-09-00-00_a.bag', '09:00:00'), b = row('Perception_2026-11-03-09-01-00_b.bag', '09:01:00');
const options = { truck_no: 'WH-Truck05', mine_code: 'WH', bag_type: 'Perception', break_source: 'mdc',
  start: '2026-11-03 00:00:00', end: '2026-11-03 23:59:59', kind: 'transfer', dir_id: 'dir1', reason: '01' };
async function background(overrides = {}, initial = {}) {
  let now = initial.now || Date.now();
  const state = { tasks: [], dirs: [{ id: 'dir1', name: 'bags', path: '/test/bags' }], ...clone(initial.state || {}) };
  // 原调度/恢复测试使用固定的旧队列；覆盖区间规则由 interval 专项用例验证。
  if (!initial.migrateCoverage) for (const t of state.tasks) t.coverageMode ||= 'legacy';
  const session = clone(initial.session || {}), activeJobs = new Set(initial.activeJobs || []), downloads = [], submissions = [], submissionBatches = [], transferCommands = [], notes = [];
  const server = { online: true, files: [], mdc: [b,a], records: [], downloadDirectory: initial.browserDefaultPath || '/home/test/Downloads', ...clone(initial.server || {}) };
  const ev = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const chrome = {
    storage: {
      local: { async get(keys) { if (typeof keys === 'string') keys = [keys]; return clone(Object.fromEntries(keys.map((k) => [k, state[k]]))); }, async set(data) { Object.assign(state,clone(data)); }, async remove(k) { delete state[k]; } },
      session: { async get(key) { return clone({ [key]: session[key] }); }, async set(data) { Object.assign(session,clone(data)); } },
    },
    runtime: { id: 'test-extension', onMessage: ev(), onInstalled: ev(), onStartup: ev(), getURL: (p) => 'chrome-extension://test-extension/' + p,
      async sendMessage(m) {
        if (m.type === 'offscreen:status') return { ok: true, active: [...activeJobs] };
        if (m.type === 'offscreen:download') { downloads.push(clone(m)); activeJobs.add(m.jobId); return { ok: true }; }
        if (m.type === 'offscreen:cancel') { activeJobs.delete(m.jobId); return { ok: true }; }
        if (m.type === 'offscreen:directory') return { ok: true, access: await context.DirectoryHealth.check(context.DirStore, m.dirId, { restore: true, verify: !!m.verify }) };
        if (m.type === 'offscreen:mdc') return { ok: true, rows: await context.SiteAPI.mdc(m.task) };
        throw Error('Unexpected message ' + m.type);
      } },
    offscreen: { async hasDocument() { return true; }, async createDocument() {} },
    sidePanel: { async setPanelBehavior() {} }, alarms: { onAlarm: ev(), async create() {} },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: { onActivated: ev(), onUpdated: ev(), async get() { return null; }, async query() { return []; }, async sendMessage() {}, async create() {} },
    windows: { onFocusChanged: ev() },
    notifications: { onClicked: ev(), async create(id, msg) { notes.push({ id,msg }); }, async getAll() { return {}; }, async clear() {} },
    downloads: { onChanged: ev(), async setUiOptions() {}, async search() { return []; }, ...(initial.downloads || {}) },
  };
  const probeRecords = new Map(); let probeId = -1;
  const nativeSearch = chrome.downloads.search.bind(chrome.downloads), nativeDownload = chrome.downloads.download?.bind(chrome.downloads);
  chrome.downloads.download = async p => {
    if (!p.url.startsWith('data:application/octet-stream,bagflow-')) return nativeDownload(p);
    const id = probeId--, sep = server.downloadDirectory.includes('\\') ? '\\' : '/';
    probeRecords.set(id,{id,byExtensionId:chrome.runtime.id,url:p.url,filename:server.downloadDirectory+sep+p.filename,state:'complete',exists:true});return id;
  };
  chrome.downloads.search = async q => q.id < 0 ? clone(probeRecords.has(q.id) ? [probeRecords.get(q.id)] : []) : q.url?.startsWith('data:application/octet-stream,bagflow-') ? clone([...probeRecords.values()].filter(d=>d.url===q.url)) : nativeSearch(q);
  chrome.downloads.removeFile ||= async id => { if(probeRecords.has(id))probeRecords.get(id).exists=false; };
  chrome.downloads.erase ||= async q => { probeRecords.delete(q.id);return [q.id]; };
  const context = vm.createContext({ chrome, console, URL, crypto: require('node:crypto').webcrypto, structuredClone,
    Date: class extends Date { static now() { return now; } }, setTimeout() {}, setInterval() {}, clearTimeout() {},
    AbortSignal, TextDecoder, fetch: initial.fetch || (() => { throw Error('Live network forbidden in tests'); }),
    importScripts(...names) { for (const name of names) {
      if (name === 'dirstore.js') { context.DirStore = { async get() { return { handle: {} }; }, async permission() { return 'granted'; }, ...initial.dirStore }; continue; }
      vm.runInContext(source(name), context, { filename: name });
      if (name === 'site-api.js') Object.assign(context.SiteAPI, {
        async lookups() { return { mines: { WH:'芜湖' }, types: {}, reasons: [{ value:'01',name:'问题分析' }], sources:[], at: now }; },
        async search() { return clone(server.files); }, async mdc() { return clone(server.mdc); },
        async trucks() { return [{ value: 'WH-Truck05', status: server.online, connect_msg: server.online ? '车辆mdc在线，且NAS在线' : '车辆mdc在线，但NAS网络不通' }]; },
        async records() { return clone(server.records); },
        async pauseTransfer(recordNo) {
          transferCommands.push({ recordNo: String(recordNo), enabled: false });
          const r = server.records.find(r => String(r.record_no) === String(recordNo));
          if (!r) throw Error('回传记录不存在');
          if (r.status !== 'succeed') r.status = 'pause';
        },
        async resumeTransfer(recordNo) {
          transferCommands.push({ recordNo: String(recordNo), enabled: true });
          const r = server.records.find(r => String(r.record_no) === String(recordNo));
          if (!r) throw Error('回传记录不存在');
          if (r.status === 'pause') r.status = 'cancelpause';
        },
        async submit(t, i) { submissions.push(clone(i)); server.records.push({ record_no: submissions.length, filename:i.filename, remarks:t.remarks, status:'waiting', break_source:'mdc', truck_no:'WH-Truck05' }); },
        async submitBatch(t, items) {
          submissionBatches.push(clone(items));
          for (const i of items) await context.SiteAPI.submit(t, i);
        },
        ...overrides,
      });
    } },
  });
  vm.runInContext(source('background.js'), context, { filename: 'background.js' }); await flush();
  const call = (fn, ...args) => { context.args = args; return vm.runInContext(`${fn}(...args)`, context); };
  const create = async (extra = {}) => {
    const t = await call('createTask', { ...options, ...extra });
    if (!extra.operations) { state.tasks.find(x => x.id === t.id).coverageMode = 'legacy'; t.coverageMode = 'legacy'; }
    return t;
  };
  const get = (id) => clone(state.tasks.find((t) => t.id === id));
  return { context, call, create, get, state, session, server, chrome, downloads, submissions, submissionBatches, transferCommands, notes, activeJobs, advance(ms) { now += ms; } };
}
module.exports = { vm, source, clone, flush, deferred, row, a, b, options, background };
