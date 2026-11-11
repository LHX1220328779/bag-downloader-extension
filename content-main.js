// 在 MAIN world 只读 /table、/search 当前网页的 Vue 表单。
(() => {
  if (window.__bagToolMainVersion === 2) { window.__bagToolCapture?.(); return; }
  window.__bagToolMainCleanup?.(); window.__bagToolMainVersion = 2;
  const events = new AbortController(), documentToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let last = '', lastSentAt = 0, lastPage = '', watchedVM, unwatch, sequence = 0;
  function findForm(vm, path, depth = 0) {
    if (!vm || vm._inactive || vm._isDestroyed || depth > 40) return null;
    if (vm.$el?.getClientRects && vm.$el.getClientRects().length === 0) return null;
    const f = vm.form;
    const api = path === '/search' ? '/api/bag/search' : '/api/break/search';
    if ((!vm.regeditForm?.url || vm.regeditForm.url === api) && f &&
      ('mine' in f || 'mine_code' in f) && ('type' in f || 'bag_type' in f) && ('truck_no' in f || 'name' in f)) return vm;
    for (const child of vm.$children || []) { const found = findForm(child, path, depth + 1); if (found) return found; }
    return null;
  }
  function tick(force = false) {
    if (document.visibilityState !== 'visible') return;
    try {
      if (lastPage !== location.href) { lastPage = location.href; last = ''; force = true; }
      const path = new URL(location.href).pathname.replace(/\/+$/, '');
      if (!['/table', '/search'].includes(path)) return;
      const component = findForm(document.querySelector('#app')?.__vue__, path);
      if (!component) return;
      if (component !== watchedVM) {
        unwatch?.(); watchedVM = component;
        unwatch = component.$watch?.(() => JSON.stringify([component.form?.truck_no, component.form?.name, component.form?.mine_code, component.form?.mine, component.form?.bag_type, component.form?.type, component.form?.break_source]), () => tick(true));
      }
      const form = component.form;
      if (!form) return; // 切到 MDC/其他路由时保留上次条件。
      const payload = {
        truck_no: form.truck_no ?? form.name ?? '', mine_code: form.mine_code ?? form.mine ?? '',
        bag_type: form.bag_type ?? form.type ?? '', break_source: form.break_source ?? '',
        hasSource: 'break_source' in form, page: location.href,
      };
      const key = JSON.stringify(payload);
      if (!force && key === last && Date.now() - lastSentAt < 10000) return;
      last = key; lastSentAt = Date.now();
      window.postMessage({ __bagTool: 'form', payload: { ...payload, captureVersion: 2, documentToken, sequence: ++sequence } }, location.origin);
    } catch (_) { /* 页面切换时下轮重新读取 */ }
  }
  const interval = setInterval(tick, 500);
  const on = (target, name, fn) => target.addEventListener(name, fn, { signal: events.signal });
  on(document, 'visibilitychange', () => tick(true));
  for (const name of ['focus', 'pageshow', 'popstate', 'hashchange']) on(window, name, () => tick(true));
  for (const name of ['input', 'change', 'click']) on(document, name, () => setTimeout(() => tick(), 0));
  on(window, 'message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.__bagTool === 'capture-request') tick(true);
  });
  const originals = {};
  for (const method of ['pushState', 'replaceState']) if (window.history?.[method]) {
    const original = window.history[method]; originals[method] = original;
    window.history[method] = function (...args) { const result = original.apply(this, args); tick(true); return result; };
  }
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => tick()) : null;
  if (document.documentElement) observer?.observe(document.documentElement, { childList: true, subtree: true });
  window.__bagToolCapture = () => tick(true);
  window.__bagToolMainCleanup = () => {
    events.abort(); clearInterval(interval); unwatch?.(); observer?.disconnect();
    for (const [method, original] of Object.entries(originals)) window.history[method] = original;
  };
  tick(true);
})();
