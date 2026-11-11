const $ = (s) => document.querySelector(s);
const LIVE = ['fetching', 'running', 'waiting_vehicle'];
const STATUS = { ready: ['待执行', 'idle'], fetching: ['查询中', 'run'], running: ['执行中', 'run'],
  waiting_vehicle: ['离线告警', 'err'], stopped: ['已停止', 'warn'], done: ['已完成', 'ok'], error: ['需处理', 'err'] };
const BAG_STATE = { pending: '待处理', downloading: '下载中', done: '完成', failed: '失败',
  submitting: '正在提交', submitted: '回传中', confirming: '等待入库', uncertain: '提交待确认', server_failed: '服务器回传异常' };
let tasks = [], dirs = [], lastDirId, captured, lookups = { mines: {}, types: {}, sources: [], reasons: [] };
let loading = false, loadAgain = false;
let taskExpansion = {}, operationsInitialized = false;
let setupExpanded = true;
let directoryLabels = {}, directorySelections = {}, directoryHistory = [], directoryDrafts = {}, directoryBindings = {}, directoryKey = null, selectedDirectoryId = '';
let creating = false, selectingDirectory = false;
let creationPhase = '', pendingDirectory = null, creationFailure = null;
let directoryMeasurement = {};
const pendingConfirm = new Map();
let transferSelections = {};
const pendingTransferChoices = new Map();
const handles = new Map();
const dirPermissions = new Map(), authorizing = new Set();
const bagPages = new Map();
const taskRenderKeys = new Map();
const send = async (msg) => { try { return await chrome.runtime.sendMessage(msg) || { ok: false, error: '后台无响应' }; }
  catch (e) { return { ok: false, error: e.message }; } };
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const keyed = (e, key) => { e.dataset.nodeKey = key; return e; };
const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const toInput = (d) => BagCore.localTime(d).replace(' ', 'T');
const bytesText = (n) => `${((n || 0) / 1048576).toFixed(1)} MB`;
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4000); }
function formMsg(text, tone = '') { $('#formMsg').textContent = text; $('#formMsg').className = 'formmsg ' + tone; }
function preset(kind) {
  const end = new Date(), start = new Date();
  if (kind === 'yesterday') { end.setDate(end.getDate()-1); start.setDate(start.getDate()-1); }
  if (kind === 'week') start.setDate(start.getDate()-6);
  start.setHours(0,0,0,0); end.setHours(23,59,59,0); PanelUI.setDate('start', toInput(start)); PanelUI.setDate('end', toInput(end));
  document.querySelectorAll('[data-preset]').forEach((b) => {
    const selected = b.dataset.preset === kind;
    b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected));
  });
}
function filterValues() {
  const c = captured || {};
  return { truck_no: c.truck_no || '', mine_code: c.mine_code || '', bag_type: c.bag_type || '', break_source: c.break_source || '' };
}
function renderCaptured() {
  const f = filterValues();
  $('#capTruck').textContent = f.truck_no || '未选择';
  $('#capMine').textContent = lookups.mines[f.mine_code] || f.mine_code || '未选择';
  $('#capType').textContent = f.bag_type || '未选择';
  $('#capSource').textContent = lookups.sources.find((s) => s.value === f.break_source)?.name || f.break_source || '不限';
  for (const [id, value] of [['chipTruck', f.truck_no], ['chipMine', f.mine_code], ['chipType', f.bag_type], ['chipSource', f.break_source]]) $('#' + id).classList.toggle('on', !!value);
  $('#capTime').textContent = captured?.capturedAt ? `捕获于 ${clock(captured.capturedAt)}` : '';
  $('#setupPreview').textContent = [f.truck_no, f.bag_type].filter(Boolean).join(' · ');
}
function selectedOperations() { return { transfer: $('#modeTransfer').checked, download: $('#modeDownload').checked }; }
function resizeDirectoryInput() {
  const input = $('#taskDirectory');
  const width = input.offsetWidth;
  if (!width || (directoryMeasurement.width === width && directoryMeasurement.value === input.value)) return;
  directoryMeasurement = { width, value: input.value };
  input.style.height = 'auto'; input.style.height = Math.max(49, input.scrollHeight + 2) + 'px';
}
function directoryInputError() {
  try { DirPaths.normalize($('#taskDirectory').value); return ''; } catch (e) { return e.message; }
}
function rememberDirectoryInput() {
  const filters = filterValues(), key = TaskDirectories.filterKey(filters), path = $('#taskDirectory').value;
  directoryDrafts[key] = path;
  send({ type: 'directory:draft', filters, path }).then(r => { if (!r.ok) toast(r.error); });
}
function directoryOptions() {
  return TaskDirectories.pathChoices(filterValues(), directoryBindings, dirs, directoryHistory, tasks).filter(d => handles.has(d.id));
}
function pendingDirectoryFor(path, filters) {
  return pendingDirectory && pendingDirectory.pathKey === DirPaths.key(path) && pendingDirectory.filterKey === TaskDirectories.filterKey(filters) ? pendingDirectory : null;
}
function clearCreationFailure() {
  creationFailure = null; $('#createErrorTools').hidden = true;
}
async function reportCreationFailure(operation, error, path, filters) {
  const failure = DirectoryPicker.failure(operation, error);
  creationFailure = { at: new Date().toISOString(), version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent, path, filters, ...failure };
  formMsg(failure.displayMessage, 'err'); $('#createErrorTools').hidden = false;
  await chrome.storage.local.set({ lastTaskCreationFailure: creationFailure }).catch(() => {});
}
async function useDirectory(rec, path, filters) {
  const key = TaskDirectories.filterKey(filters);
  const r = await send({ type: 'directory:bind', dirId: rec.id, path, filters }); if (!r.ok) throw Error(r.error);
  dirs = [r.directory, ...dirs.filter(d => d.id !== rec.id)]; handles.set(rec.id, rec); dirPermissions.set(rec.id, 'granted');
  directoryBindings[DirPaths.key(path)] = { dirId: rec.id, path, filters, at: Date.now() };
  directorySelections[key] = rec.id;
  const remembered = await send({ type: 'directory:selection', filters, dirId: rec.id }); if (!remembered.ok) throw Error(remembered.error);
  // 创建另一个任务不触碰已有任务。仅明确受阻的原任务需要唤醒。
  if (tasks.some(t => t.dirId === rec.id && DirectoryHealth.blocked(t))) {
    const authorized = await send({ type: 'directory:authorized', dirId: rec.id }); if (!authorized.ok) throw Error(authorized.error);
  }
  return rec.id;
}
function renderTaskDirectory() {
  const filters = filterValues(), key = TaskDirectories.filterKey(filters);
  if (key !== directoryKey) {
    if ($('#directoryHistory').matches(':popover-open')) $('#directoryHistory').hidePopover();
    directoryKey = key;
    const previousId = directorySelections[key];
    const previous = dirs.find(d => d.id === previousId && d.backend !== 'browser');
    $('#taskDirectory').value = TaskDirectories.preferred(filters, directoryDrafts, directoryHistory, tasks) ||
      (Object.hasOwn(directoryDrafts, key) ? '' : directoryLabels[previousId] || previous?.displayPath || previous?.path || '');
  }
  let path = '', dir;
  if (!directoryInputError()) {
    path = DirPaths.normalize($('#taskDirectory').value);
    dir = TaskDirectories.pathDirectory(path, directoryBindings, dirs, directoryHistory, tasks);
  }
  selectedDirectoryId = dir?.id || '';
  const available = dir && handles.has(dir.id), granted = available && dirPermissions.get(dir.id) === 'granted';
  const pending = pendingDirectoryFor(path, filters);
  $('#directoryAccess').hidden = !path;
  $('#directoryAccessText').textContent = creating ? (selectingDirectory ? `请在系统窗口选择 ${path}` : creationPhase === 'permission' ? '目录已选中，请在浏览器提示中允许编辑文件' : '正在创建任务…') :
    granted ? '已授权，创建时直接使用此目录' : pending ? '目录已选中，再次创建会复用本次选择' : available ? '创建时允许写入此目录' : '首次创建时选择此目录并允许写入';
  $('#taskDirectory').disabled = creating;
  $('#directoryHistoryButton').disabled = creating || !directoryOptions().length;
  resizeDirectoryInput();
}
function renderCreateState() {
  const f = filterValues(), o = selectedOperations();
  const error = o.download ? directoryInputError() : '';
  $('#directoryError').textContent = error; $('#directoryError').hidden = !error;
  $('#taskDirectory').setAttribute('aria-invalid', String(!!error));
  $('#createBtn').disabled = creating || !!error || (o.download && !$('#taskDirectory').value.trim()) || !f.truck_no || !f.mine_code || !f.bag_type || (!o.transfer && !o.download) || (o.transfer && !$('#reason').value);
}
function renderModeSelection() {
  $('#transferOptions').hidden = !$('#modeTransfer').checked;
  $('#directorySection').hidden = !$('#modeDownload').checked;
  if (!$('#modeDownload').checked && $('#directoryHistory').matches(':popover-open')) $('#directoryHistory').hidePopover();
  if (!$('#modeTransfer').checked && $('#reasonPopover').matches(':popover-open')) $('#reasonPopover').hidePopover();
  renderCreateState();
}
function taskDirectoryPath(t) {
  let path = t.dirPath;
  if (!path) {
    const item = [...t.items].reverse().find(i => i.downloadPath);
    if (item) path = DirPaths.splitFile(item.downloadPath).directory;
    else {
      const dir = t.downloadBackend === 'browser' || t.directorySnapshot ? null : dirs.find(d => d.id === t.dirId);
      path = dir?.displayPath || dir?.path || '';
    }
  }
  try { return path ? DirPaths.normalize(path) : ''; } catch (_) { return ''; }
}
function authorize(id) {
  const rec = handles.get(id);
  if (authorizing.has(id)) return;
  if (!rec?.handle) { toast('原任务目录不可用，无法恢复目录写入权限'); return; }
  // 句柄提前缓存，requestPermission 保持直接用户手势。
  let request;
  try { request = rec.handle.requestPermission({ mode: 'readwrite' }); } catch (e) { toast(e.message); return; }
  authorizing.add(id); renderTasks();
  request.then(async (perm) => {
    if (perm !== 'granted') return toast('未获得写入权限');
    const r = await send({ type: 'directory:authorized', dirId: id });
    if (!r.ok) throw new Error(r.error);
    await chrome.storage.local.set({ lastAuthAt: Date.now() });
    toast(`已授权 ${rec.name}，任务将自动继续`);
  }).catch((e) => toast(e.message)).finally(async () => { authorizing.delete(id); await load(); });
}
function progressCard(t, transfer) {
  const items = [...(transfer ? t.transfers || [] : t.items || [])].sort(BagCore.sort);
  const done = items.filter((i) => i.state === 'done').length, failed = items.filter((i) => ['failed', 'server_failed'].includes(i.state)).length;
  const card = keyed(h('section', 'phase-card'), transfer ? 'transfer-phase' : 'download-phase');
  const title = keyed(h('div', 'phase-title'), 'title'); title.append(h('strong', '', transfer ? '↑ 回传进度' : '↓ 下载进度'), h('span', 'muted', `${done} / ${items.length}`)); card.append(title);
  const progress = keyed(h('div', 'progress'), 'progress'), bar = h('div', 'bar'); bar.style.width = `${items.length ? done/items.length*100 : 0}%`; progress.append(bar); card.append(progress);
  if (failed) card.append(keyed(h('p', 'error-text', transfer ? `${failed} 个服务器异常，持续核查` : `${failed} 个下载失败`), 'error'));
  const note = transfer ? t.discoveryError || t.transferError || t.transferMessage : t.searchError || (/^(下载中|核验本地文件|下载完成|已验证本地文件，跳过)：/.test(t.message || '') ? '' : t.message);
  if (note) card.append(keyed(h('p', 'phase-note', note), 'note'));
  const phase = transfer ? 'transfer' : 'download', key = `${t.id}:${phase}`, pageSize = 80;
  const currentIndex = items.findIndex((i) => !['done', 'failed'].includes(i.state));
  const lastPage = Math.max(0, Math.ceil(items.length / pageSize) - 1);
  const page = Math.min(lastPage, bagPages.has(key) ? bagPages.get(key) : Math.floor(Math.max(0, currentIndex) / pageSize));
  const list = keyed(h('ul', 'bags'), 'list'); list.dataset.list = key; list.dataset.page = String(page);
  for (const i of items.slice(page * pageSize, (page + 1) * pageSize)) {
    const li = keyed(h('li', `bag s-${i.state}`), i.dirpath || i.key || BagCore.fileKey(i)), name = h('div', 'bag-name', BagCore.shortFilename(i.filename));
    let status = BAG_STATE[i.state] || i.state;
    if (i.skipped) status = '本地文件已验证';
    if (transfer && i.state !== 'done' && i.serverStatus === 'pause') status = '回传已暂停';
    else if (transfer && i.state !== 'done' && ['waiting', 'cancelpause'].includes(i.serverStatus)) status = '等待回传';
    else if (transfer && i.state === 'pending' && !BagCore.isTransferEnabled(t)) status = '等待开启回传';
    else if (transfer && t.status === 'waiting_vehicle' && ['pending', 'submitted'].includes(i.state)) status = '等待车辆上线';
    if (transfer && ['submitted', 'confirming'].includes(i.state)) status += ` · ${Math.round(i.percentage || 0)}%`;
    if (!transfer && i.needsValidation && i.jobId) status = '核验完整文件';
    else if (!transfer && i.state === 'downloading') status += ` · ${bytesText(i.bytes)}${i.totalBytes ? ' / ' + bytesText(i.totalBytes) : ''}`;
    li.append(name, h('div', 'bag-detail', `${status} · ${BagCore.recordingTime(i)}`));
    if (i.error) li.append(keyed(h('div', 'error-text', i.error), 'error'));
    li.title = `${i.filename}\n${status}\n${i.error || ''}`; list.append(li);
  }
  card.append(list);
  if (items.length > pageSize) {
    const pager = keyed(h('div', 'bag-pager'), 'pager');
    pager.append(h('span', 'muted', `第 ${page + 1} / ${lastPage + 1} 页`));
    for (const [label, target, disabled] of [['上一页', page - 1, page === 0], ['下一页', page + 1, page === lastPage], ['跟随当前', 'auto', !bagPages.has(key)]]) {
      const button = h('button', 'link-btn', label); button.dataset.act = 'bag-page'; button.dataset.phase = phase; button.dataset.page = String(target); button.disabled = disabled; pager.append(button);
    }
    card.append(pager);
  }
  return card;
}
function transferTaskView(task) {
  const selection = transferSelections[task.id];
  const t = BagCore.normalizeTask(BagCore.applyTransferSelection({ ...task }, selection));
  const pending = pendingTransferChoices.get(t.id);
  if (!pending) return t;
  if (pending.revision != null && selection && Number.isSafeInteger(selection.revision) &&
      (selection.revision > pending.revision || selection.revision === pending.revision && selection.enabled === pending.enabled)) {
    pendingTransferChoices.delete(t.id); return t;
  }
  // 旧 load() 的目录检查晚返回，也不能覆盖刚点击的选择；等待看到对应持久化确认。
  t.transferEnabled = pending.enabled;
  t.transferControlRevision = pending.revision ?? t.transferControlRevision + 1;
  t.transferUiPending = !pending.error; t.transferUiError = pending.error || '';
  return t;
}
async function chooseTransfer(id, enabled) {
  const pending = { enabled, requestId: crypto.randomUUID(), revision: null, error: '' };
  pendingTransferChoices.set(id, pending); renderTasks();
  const result = await send({ type: 'transfer:set', id, enabled, requestId: pending.requestId });
  if (pendingTransferChoices.get(id) !== pending) return;
  if (result.ok && result.enabled === enabled && result.requestId === pending.requestId && Number.isSafeInteger(result.revision)) {
    pending.revision = result.revision;
  } else {
    pending.error = result.error === '未知指令' ? '插件后台尚未更新，请在扩展管理页重新加载插件后重试' :
      result.error || '后台版本不一致，请重新加载插件后重试';
    toast(pending.error);
  }
  renderTasks(); await load();
}
function transferSpinner() {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'transfer-spinner'); svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
  for (const track of [true, false]) {
    const circle = document.createElementNS(ns, 'circle');
    for (const [key, value] of Object.entries({ cx: 8, cy: 8, r: 5.5, stroke: 'currentColor', 'stroke-width': 1.5 })) circle.setAttribute(key, value);
    if (track) circle.setAttribute('opacity', '.16');
    else { circle.setAttribute('stroke-dasharray', '14 21'); circle.setAttribute('stroke-linecap', 'round'); }
    svg.append(circle);
  }
  return svg;
}
function taskCard(t, sharedDownloadRoot = '') {
  t = BagCore.normalizeTask(t);
  t = { ...t, items: t.items.filter(i => !i.coverageExcluded), transfers: t.transfers.filter(i => !i.coverageExcluded) };
  const live = LIVE.includes(t.status), transfer = BagCore.wantsTransfer(t), download = BagCore.wantsDownload(t);
  const card = h('article', `task${(t.alert || t.coverageAlert) && live ? ' task-alert' : ''}`); card.dataset.id = t.id;
  const permission = dirPermissions.get(t.dirId), directoryIssue = download ? DirectoryHealth.taskIssue(t, permission) : null;
  const needsAuth = directoryIssue?.state === 'permission';
  let [label,tone] = STATUS[t.status] || ['未知','idle'];
  if (live && needsAuth) { label = '下载待授权'; tone = 'warn'; }
  else if (live && directoryIssue) { label = '目录待恢复'; tone = 'warn'; }
  if (live && t.coverageAlert) { label = '覆盖告警'; tone = 'warn'; }
  if (live && t.locationBlocked && !t.coverageAlert && !needsAuth && !t.alert) { label = t.locationWait ? '等待目录' : '目录不匹配'; tone = t.locationWait ? 'idle' : 'warn'; }
  if (t.status === 'done' && [...t.items, ...(t.transfers || [])].some((i) => ['failed', 'server_failed'].includes(i.state))) { label = '完成（有失败）'; tone = 'warn'; }
  if (live && t.localVerificationOnly && !directoryIssue) label = '核验文件';
  const fold = keyed(h('details', 'task-fold'), 'fold'); fold.dataset.taskFold = t.id; fold.open = !!taskExpansion[t.id];
  const top = h('summary', 'task-top'), info = h('div'), heading = h('div', 'task-heading');
  heading.append(h('h3', '', t.name), h('span', `pill ${tone}`, label));
  const range = h('p', 'task-range'); range.append(h('span', '', t.start), h('span', 'range-separator', '→'), h('span', '', t.end));
  info.append(heading, h('p', 'meta', `${transfer ? (download ? '回传 + 下载' : '仅回传') : '仅下载'} · ${t.mineName || t.filters.mine_code} · 来源：${t.filters.break_source || '不限'}`), range);
  const savedPath = taskDirectoryPath(t);
  if (download && (savedPath || t.dirName)) info.append(keyed(h('p', 'task-save-path', savedPath || t.dirName), 'save-path'));
  const progress = [transfer ? `回传 ${(t.transfers || []).filter((i) => i.state === 'done').length}/${(t.transfers || []).length}` : '', download ? `下载 ${t.items.filter((i) => i.state === 'done').length}/${t.items.length}` : ''].filter(Boolean).join(' · ');
  info.append(h('p', 'compact-progress', progress));
  top.append(info);
  const body = h('div', 'task-body');
  if (t.alert && live) body.append(keyed(h('div', 'alert-box', t.alert), 'vehicle-alert'));
  if (transfer && t.vehicleCheckedAt) body.append(keyed(h('p', 'meta', `${t.vehicleMessage} · ${clock(t.vehicleCheckedAt)}`), 'vehicle'));
  if (t.queryAt) body.append(keyed(h('p', 'meta', `文件查询 ${clock(t.queryAt)}`), 'query'));
  if (transfer) body.append(progressCard(t, true));
  if (download) body.append(progressCard(t, false));
  fold.append(top, body); card.append(fold);
  if (t.coverageAlert) card.append(keyed(h('div', 'alert-box coverage-alert', t.coverageAlert), 'coverage-alert'));
  if (live && t.locationWait) {
    const waiting = keyed(h('div', 'task-location-wait'), 'location-wait'); waiting.setAttribute('role', 'status');
    waiting.append(h('span', '', '浏览器下载目录尚未包含本任务保存位置'));
    if (t.locationWait.current) waiting.append(h('span', 'muted', `当前下载目录：${t.locationWait.current}`));
    waiting.append(h('span', '', `请将浏览器下载位置设为：${sharedDownloadRoot || t.locationWait.required}`));
    card.append(waiting);
  } else if (live && t.locationBlocked) card.append(keyed(h('div', 'alert-box coverage-alert', t.message), 'location-alert'));
  if (needsAuth) {
    const authPanel = keyed(h('div', 'task-auth'), 'auth'); authPanel.setAttribute('role', 'status');
    authPanel.append(h('strong', '', '保存目录需要授权'), h('p', '', '浏览器需要重新允许写入此任务的目录。任务与已完成进度已保留，授权后自动继续。'));
    const auth = h('button', 'ghost-btn', authorizing.has(t.dirId) ? '正在授权…' : '授权本任务目录');
    auth.dataset.act = 'auth-dir'; auth.disabled = authorizing.has(t.dirId); authPanel.append(auth); card.append(authPanel);
  } else if (directoryIssue) {
    const panel = keyed(h('div', 'task-directory-issue'), 'directory-issue'); panel.setAttribute('role', 'status');
    panel.append(h('strong', '', directoryIssue.code === 'DIRECTORY_RESTORE_PENDING' ? '正在恢复目录访问' : directoryIssue.state === 'missing' ? '目录记录不可用' : '保存目录暂时不可用'), h('p', '', directoryIssue.message));
    card.append(panel);
  }
  const actions = keyed(h('div', 'actions'), 'actions');
  for (const [act,text,cls,disabled] of [['execute','执行','primary-sm',live || t.status === 'done'],['stop','停止','stop',!live],
    ['transfer','回传','transfer-toggle',!transfer],['delete','删除','text',false]]) {
    const button = keyed(h('button', `btn ${cls}`, text), act); button.type = 'button'; button.dataset.act = act; button.disabled = disabled || pendingConfirm.has(t.id);
    if (act === 'transfer') {
      const selected = BagCore.isTransferEnabled(t);
      const control = t.transferControl, current = control?.revision === t.transferControlRevision && control?.enabled === selected;
      const busy = !!t.transferUiPending || !!(current && ['pending', 'checking', 'waiting'].includes(control.phase));
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-busy', String(busy));
      button.title = !transfer ? '仅下载任务没有回传' : selected ? '点击暂停本任务原回传记录' : '点击继续本任务原回传记录';
      if (busy) button.title += '；正在同步服务器状态，可再次点击改变选择';
      else if (t.transferUiError) button.title += `；选择尚未保存：${t.transferUiError}`;
      else if (current && control?.message) button.title += `；${control.message}`;
      if (t.status === 'stopped' && selected) button.title += '；本地调度仍已停止，执行后才追加新回传';
      const icon = h('span', 'transfer-icon'); icon.setAttribute('aria-hidden', 'true');
      icon.append(h('span', 'transfer-check', selected ? '✓' : ''));
      button.prepend(icon);
      const indicator = h('span', 'transfer-indicator'); indicator.setAttribute('aria-hidden', 'true');
      if (busy) indicator.append(transferSpinner()); button.append(indicator);
    }
    actions.append(button);
  }
  card.append(actions);
  if (transfer && t.transferControlRevision > 0) {
    const control = t.transferControl, selected = BagCore.isTransferEnabled(t), current = control?.revision === t.transferControlRevision && control?.enabled === selected;
    const error = t.transferUiError || current && control?.error;
    const note = keyed(h(error ? 'p' : 'span', error ? 'transfer-control-note error-text' : 'sr-only transfer-status'), 'transfer-control');
    note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
    note.textContent = t.transferUiError ? `回传选择尚未保存：${t.transferUiError}` : t.transferUiPending ?
      selected ? '已勾选，正在保存继续回传的选择…' : '已取消勾选，正在保存暂停回传的选择…' :
      current && control.message ? control.message : selected ? '正在继续本任务原回传记录…' : '正在暂停本任务原回传记录…';
    if (t.status === 'stopped' && BagCore.isTransferEnabled(t)) note.textContent += '；本地任务仍已停止，点击「执行」后才追加新回传';
    card.append(note);
  }
  const confirmation = pendingConfirm.get(t.id);
  if (confirmation) {
    const panel = keyed(h('div', 'task-confirm'), 'confirm'); panel.setAttribute('role', 'alertdialog'); panel.setAttribute('aria-labelledby', `confirm-${t.id}`);
    const title = h('strong', '', confirmation.act === 'stop' ? '停止此任务？' : confirmation.act === 'delete' ? '删除此任务？' : '重试未确认的回传？'); title.id = `confirm-${t.id}`;
    const description = confirmation.act === 'stop' ? '暂停本地调度和下载。服务器回传由「回传」开关独立控制。' : confirmation.act === 'delete' ? '删除本地任务记录，保留已下载文件。' : '请先在网站核实没有正在执行的回传，重试可能重复提交。';
    panel.append(title, h('p', 'confirm-target', t.name), h('p', 'confirm-description', description));
    const buttons = h('div', 'confirm-actions');
    for (const [act, text, cls] of [['confirm-cancel', '取消', ''], ['confirm-apply', confirmation.act === 'stop' ? '确认停止' : confirmation.act === 'delete' ? '确认删除' : '确认重试', 'danger']]) {
      const button = h('button', `btn ${cls}`, text); button.dataset.act = act; buttons.append(button);
    }
    panel.append(buttons); card.append(panel);
  }
  const more = keyed(h('details', 'task-more'), 'more'); more.dataset.key = t.id + ':more'; more.append(h('summary', '', '日志与恢复'));
  if ((t.transfers || []).some((i) => ['uncertain','submitting','server_failed'].includes(i.state))) {
    const retry = h('button', 'link-btn', '重试未确认的回传'); retry.dataset.act = 'retry-uncertain'; retry.disabled = live; more.append(retry);
  }
  const logs = h('ul', 'event-log');
  for (const e of [...(t.events || [])].reverse()) logs.append(h('li', '', `${clock(e.at)} ${e.message}${e.coverageCorrected ? '（已纠正：该包不在任务时间范围）' : ''}`));
  more.append(logs); body.append(more); return card;
}
function renderTasks() {
  const sharedDownloadRoot = DirPaths.commonAncestor(tasks.filter(task => (LIVE.includes(task.status) || task.status === 'ready') && BagCore.wantsDownload(task) && task.downloadBackend === 'browser').map(task => task.dirPath));
  const focused = document.activeElement, focusedTask = focused?.closest('.task')?.dataset.id, focusedAction = focused?.dataset.act;
  for (const [id, confirmation] of pendingConfirm) {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.runToken !== confirmation.token || (confirmation.act === 'stop' && !LIVE.includes(task.status))) pendingConfirm.delete(id);
  }
  const box = $('#tasks'), existing = new Map([...box.children].map((card) => [card.dataset.id, card]));
  const nodes = [...tasks].sort((a,b) => b.createdAt-a.createdAt).map((t) => {
    t = transferTaskView(t);
    const key = JSON.stringify([t, dirPermissions.get(t.dirId), authorizing.has(t.dirId),
      !!taskExpansion[t.id], taskDirectoryPath(t), t.locationWait ? sharedDownloadRoot : '', pendingConfirm.get(t.id), bagPages.get(t.id + ':transfer'), bagPages.get(t.id + ':download')]);
    let card = existing.get(t.id);
    if (!card || taskRenderKeys.get(t.id) !== key) {
      const next = taskCard(t, sharedDownloadRoot);
      const pages = new Map([...card?.querySelectorAll('.bags') || []].map((list) => [list.dataset.list, list.dataset.page]));
      card = card ? PanelDOM.patch(card, next) : next;
      for (const list of card.querySelectorAll('.bags')) if (pages.has(list.dataset.list) && pages.get(list.dataset.list) !== list.dataset.page) list.scrollTop = 0;
      taskRenderKeys.set(t.id, key);
    }
    return card;
  });
  PanelDOM.order(box, nodes);
  const ids = new Set(tasks.map((t) => t.id));
  for (const id of taskRenderKeys.keys()) if (!ids.has(id)) taskRenderKeys.delete(id);
  for (const id of pendingTransferChoices.keys()) if (!ids.has(id)) pendingTransferChoices.delete(id);
  $('#taskCount').textContent = `${tasks.length} 个`; $('#empty').hidden = tasks.length > 0;
  const alarms = tasks.filter((t) => LIVE.includes(t.status) && (t.alert || t.coverageAlert));
  $('#alertSummary').hidden = !alarms.length;
  $('#alertSummary').textContent = [alarms.some(t => t.alert) ? `${alarms.filter(t => t.alert).length} 个任务等待车辆在线` : '', alarms.some(t => t.coverageAlert) ? `${alarms.filter(t => t.coverageAlert).length} 个任务需要核查数据覆盖` : ''].filter(Boolean).join(' · ');
  if (focusedTask && focusedAction) {
    const target = box.querySelector(`[data-id="${focusedTask}"] [data-act="${focusedAction}"]`);
    if (target && target !== document.activeElement) target.focus({ preventScroll: true });
  }
}
async function load() {
  if (loading) { loadAgain = true; return; } loading = true;
  try {
    const st = await chrome.storage.local.get(['tasks','taskTransferSelections','captured','dirs','lastDirId','taskExpansion','setupExpanded','taskOperations','taskDirectoryLabels','taskDirectorySelections','taskDirectoryHistory','taskDirectoryDrafts','taskDirectoryBindings']);
    tasks = st.tasks || []; dirs = st.dirs || []; lastDirId = st.lastDirId;
    transferSelections = st.taskTransferSelections || {};
    tasks = tasks.map(t => BagCore.normalizeTask(BagCore.applyTransferSelection(t, transferSelections[t.id])));
    // 正在输入的值由当前侧栏持有，进度刷新不改写它或移动光标。
    directoryLabels = { ...(st.taskDirectoryLabels || {}), ...directoryLabels }; directorySelections = { ...(st.taskDirectorySelections || {}), ...directorySelections }; directoryHistory = st.taskDirectoryHistory || []; directoryDrafts = { ...(st.taskDirectoryDrafts || {}), ...directoryDrafts }; directoryBindings = st.taskDirectoryBindings || {};
    taskExpansion = st.taskExpansion || {};
    setupExpanded = st.setupExpanded !== false; $('#taskSetup').open = setupExpanded;
    if (!operationsInitialized) { $('#modeTransfer').checked = st.taskOperations?.transfer !== false; $('#modeDownload').checked = st.taskOperations?.download !== false; operationsInitialized = true; }
    renderModeSelection();
    await Promise.all([...new Set([...dirs.map((d) => d.id), ...tasks.map((t) => t.dirId)])].filter(Boolean).map(async (id) => {
      if (dirs.some((d) => d.id === id && d.backend === 'browser')) { dirPermissions.set(id, 'granted'); return; }
      let rec;
      try { rec = await DirStore.get(id); }
      catch (_) { dirPermissions.set(id, 'unavailable'); return; }
      if (rec) handles.set(id, rec); else handles.delete(id);
      const access = await DirectoryHealth.inspect(rec, { query: record => DirStore.permission(record) });
      dirPermissions.set(id, access.state === 'granted' ? 'granted' : access.permission || access.state);
    }));
    // 浏览器已恢复授权时自动通知后台，不让陈旧的任务标记再次要求人工确认。
    const restored = [...new Set(tasks.filter(t => LIVE.includes(t.status) && BagCore.wantsDownload(t) && t.downloadBackend !== 'browser' &&
      dirPermissions.get(t.dirId) === 'granted' && (t.directoryAccess?.state === 'permission' || (!t.directoryAccess && t.directoryBlocked))).map(t => t.dirId))];
    await Promise.all(restored.map(async dirId => {
      const r = await send({ type: 'directory:authorized', dirId });
      if (r.ok) for (const t of tasks) if (t.dirId === dirId) { t.directoryBlocked = false; delete t.directoryAccess; }
    }));
    captured = st.captured || null;
    renderCaptured(); renderTaskDirectory();
    renderCreateState(); renderTasks();
  } finally { loading = false; if (loadAgain) { loadAgain = false; load(); } }
}
async function loadLookups() {
  const r = await send({ type: 'lookups' });
  if (!r.ok) { toast(`选项加载失败：${r.error}`); return; }
  lookups = r.data;
  renderCaptured();
  PanelUI.renderReasons(lookups.reasons);
}
async function create() {
  if (creating) return;
  clearCreationFailure(); formMsg('');
  const operations = selectedOperations();
  const start = BagCore.inputTime($('#start').value), end = BagCore.inputTime($('#end').value);
  if (!start || !end || start > end) return formMsg('请选择有效时间范围', 'err');
  if (!operations.transfer && !operations.download) return formMsg('请选择回传或下载', 'err');
  if (operations.transfer && !$('#reason').value) return formMsg('请选择回传原因', 'err');
  if (operations.download && directoryInputError()) return formMsg(directoryInputError(), 'err');
  const path = operations.download ? DirPaths.normalize($('#taskDirectory').value) : '';
  if (operations.download && !path) return formMsg('请填写完整的本地保存路径', 'err');
  const filters = filterValues();
  const payload = { ...filters, operations, start, end, directory_mode: 'path', dir_id: '', download_path: path,
    reason: $('#reason').value, bug_id: $('#bugId').value, remarks: $('#remarks').value };
  let directoryRequest, operation = { stage: 'create' };
  // 必须在点击事件里直接请求系统授权，不能先等待后台消息。
  if (operations.download) {
    const rec = handles.get(selectedDirectoryId), pending = pendingDirectoryFor(path, filters);
    const previous = handles.get(directorySelections[TaskDirectories.filterKey(filters)] || lastDirId);
    operation = DirectoryPicker.begin({ path, record: rec, permission: rec ? dirPermissions.get(rec.id) : '', pendingHandle: pending?.handle, startIn: previous?.handle,
      onPicked(handle) { pendingDirectory = { handle, pathKey: DirPaths.key(path), filterKey: TaskDirectories.filterKey(filters) }; },
      onPhase(phase) { creationPhase = phase; selectingDirectory = phase === 'picker'; if (creating) renderTaskDirectory(); },
    });
    directoryRequest = operation.promise;
  }
  creating = true; renderTaskDirectory(); renderCreateState();
  try {
    if (operations.download) {
      const rec = await directoryRequest;
      operation.stage = 'bind'; creationPhase = 'bind'; renderTaskDirectory();
      payload.dir_id = await useDirectory(rec, path, filters);
    }
    operation.stage = 'create'; creationPhase = 'create';
    const r = await send({ type: 'create', payload });
    if (!r.ok) throw Error(r.error);
    pendingDirectory = null; clearCreationFailure();
    formMsg('已创建任务，点击执行开始', 'ok'); toast('任务已创建，点击执行开始');
    await chrome.storage.local.remove('lastTaskCreationFailure').catch(() => {});
    await chrome.storage.local.set({ setupExpanded: false }).catch(() => {});
  } catch (e) { await reportCreationFailure(operation, e, path, filters); }
  finally { selectingDirectory = false; creationPhase = ''; creating = false; await load(); renderTaskDirectory(); renderCreateState(); }
}
$('#createBtn').addEventListener('click', create);
$('#copyCreateError').addEventListener('click', async () => {
  if (!creationFailure) return;
  try { await navigator.clipboard.writeText(JSON.stringify(creationFailure, null, 2)); toast('错误详情已复制'); }
  catch (_) { toast('复制失败，可选中错误提示复制；原始详情已保存在扩展本地存储'); }
});
for (const id of ['modeTransfer', 'modeDownload']) $('#' + id).addEventListener('change', () => { renderModeSelection(); chrome.storage.local.set({ taskOperations: selectedOperations() }); });
$('#taskDirectory').addEventListener('input', () => { rememberDirectoryInput(); renderTaskDirectory(); renderCreateState(); });
$('#taskDirectory').addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.preventDefault(); });
$('#directoryHistoryButton').addEventListener('click', () => {
  const popover = $('#directoryHistory');
  if (popover.matches(':popover-open')) { popover.hidePopover(); return; }
  const box = $('#directoryChoices'); box.replaceChildren();
  for (const entry of directoryOptions()) {
    const button = h('button', 'directory-choice'); button.type = 'button'; button.dataset.dirId = entry.id;
    button.setAttribute('aria-pressed', String(DirPaths.key(entry.path) === (directoryInputError() ? '' : DirPaths.key($('#taskDirectory').value))));
    button.append(h('span', '', entry.path));
    const used = entry.at ? new Date(entry.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    button.append(h('small', '', [entry.truck_no, used, dirPermissions.get(entry.id) === 'granted' ? '已授权' : '创建时授权'].filter(Boolean).join(' · ')));
    button.addEventListener('click', () => {
      $('#taskDirectory').value = entry.path; rememberDirectoryInput(); renderTaskDirectory(); renderCreateState();
      popover.hidePopover(); $('#taskDirectory').focus({ preventScroll: true });
    }); box.append(button);
  }
  popover.showPopover();
  const anchor = $('.directory-destination').getBoundingClientRect(), width = Math.min(440, innerWidth - 24);
  popover.style.width = width + 'px'; popover.style.maxHeight = Math.min(320, innerHeight - 24) + 'px';
  popover.style.left = Math.max(12, Math.min(anchor.left, innerWidth - width - 12)) + 'px';
  const height = popover.getBoundingClientRect().height;
  popover.style.top = (anchor.bottom + height + 7 <= innerHeight - 12 ? anchor.bottom + 7 : Math.max(12, anchor.top - height - 7)) + 'px';
  (box.querySelector('[aria-pressed="true"]') || box.firstElementChild)?.focus({ preventScroll: true });
});
$('#directoryHistory').addEventListener('toggle', ev => $('#directoryHistoryButton').setAttribute('aria-expanded', String(ev.newState === 'open')));
$('#directoryChoices').addEventListener('keydown', ev => {
  if (!['ArrowDown','ArrowUp','Home','End'].includes(ev.key)) return;
  const buttons = [...ev.currentTarget.children], index = buttons.indexOf(document.activeElement);
  ev.preventDefault(); buttons[ev.key === 'Home' ? 0 : ev.key === 'End' ? buttons.length - 1 : (index + (ev.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
});
let directoryWidth = 0;
new ResizeObserver(([entry]) => { if (entry.contentRect.width !== directoryWidth) { directoryWidth = entry.contentRect.width; requestAnimationFrame(resizeDirectoryInput); } }).observe($('#taskDirectory'));
$('#reason').addEventListener('change', renderCreateState);
$('#tasks').addEventListener('toggle', (ev) => {
  const id = ev.target.dataset.taskFold;
  if (!id || !ev.target.isConnected || !!taskExpansion[id] === ev.target.open) return;
  taskExpansion[id] = ev.target.open;
  chrome.storage.local.set({ taskExpansion });
}, true);
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => preset(b.dataset.preset)));
$('#taskSetup').addEventListener('toggle', () => {
  if ($('#taskSetup').open === setupExpanded) return;
  setupExpanded = $('#taskSetup').open; chrome.storage.local.set({ setupExpanded });
});
$('#tasks').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]'); if (!btn) return;
  const id = btn.closest('.task').dataset.id, t = tasks.find((t) => t.id === id), act = btn.dataset.act;
  if (act === 'bag-page') {
    const key = `${id}:${btn.dataset.phase}`;
    if (btn.dataset.page === 'auto') bagPages.delete(key); else bagPages.set(key, Number(btn.dataset.page));
    renderTasks(); return;
  }
  if (act === 'auth-dir') { authorize(t.dirId); return; }
  if (act === 'transfer') {
    // 以用户此刻看到的勾选为准，不用异步加载中可能尚未渲染的 tasks 快照反转。
    await chooseTransfer(id, btn.getAttribute('aria-pressed') !== 'true'); return;
  }
  if (['stop', 'delete', 'retry-uncertain'].includes(act)) {
    pendingConfirm.set(id, { act, token: t.runToken }); renderTasks();
    $('#tasks').querySelector(`[data-id="${id}"] [data-act="confirm-cancel"]`)?.focus({ preventScroll: true }); return;
  }
  if (act === 'confirm-cancel') { pendingConfirm.delete(id); renderTasks(); return; }
  let action = act, expectedRunToken;
  if (act === 'confirm-apply') {
    const confirmation = pendingConfirm.get(id);
    if (!confirmation || confirmation.token !== t.runToken) { pendingConfirm.delete(id); renderTasks(); return; }
    action = confirmation.act; expectedRunToken = confirmation.token; pendingConfirm.delete(id);
  }
  btn.disabled = true;
  const r = await send({ type: action, id, expectedRunToken });
  if (!r.ok) toast(r.error); else if (action === 'execute') toast('任务已启动，关闭侧栏后仍会继续');
  await load();
});
async function refreshConn() {
  const tabs = await chrome.tabs.query({ url: 'http://10.198.92.173:8080/*' }).catch(() => []);
  $('#conn').classList.toggle('on', !!tabs.length); $('#connText').textContent = tabs.length ? '站点已打开' : '站点未打开';
}
let loadScheduled = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !['tasks','taskTransferSelections','captured','dirs','lastDirId','lastAuthAt','taskExpansion','setupExpanded','taskDirectoryHistory','taskDirectoryBindings'].some((k) => changes[k]) || loadScheduled) return;
  loadScheduled = true;
  requestAnimationFrame(() => { loadScheduled = false; load().catch((e) => toast(e.message)); });
});
chrome.tabs.onUpdated.addListener(refreshConn); chrome.tabs.onRemoved.addListener(refreshConn);
document.addEventListener('keydown', (ev) => {
  const id = document.activeElement?.closest('.task')?.dataset.id;
  if (ev.key === 'Escape' && pendingConfirm.has(id)) { pendingConfirm.delete(id); renderTasks(); }
});
(async () => { PanelUI.init(); preset('today'); await load(); send({ type: 'capture:refresh' }); await loadLookups(); await refreshConn(); })().catch((e) => toast(e.message));
