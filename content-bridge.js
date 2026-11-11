// 页面只允许提交筛选值；新版本忽略旧 MAIN 脚本的过期快照。
(() => {
  const requestCapture = () => window.postMessage({ __bagTool: 'capture-request' }, location.origin);
  if (window.__bagToolBridgeVersion === 2) { requestCapture(); return; }
  const events = new AbortController();
  window.__bagToolBridgeVersion = 2;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.__bagTool !== 'form') return;
    const payload = event.data.payload;
    if (!payload || typeof payload !== 'object' || payload.captureVersion !== 2) return;
    try { chrome.runtime.sendMessage({ type: 'capture', payload }).catch(() => {}); }
    catch (_) { /* 插件重载后由新后台补注入桥接，避免旧上下文抛错。 */ }
  }, { signal: events.signal });
  document.addEventListener('visibilitychange', requestCapture, { signal: events.signal });
  window.addEventListener('focus', requestCapture, { signal: events.signal });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === 'capture:request') { requestCapture(); reply?.({ ok: true, captureVersion: 2 }); }
  });
  requestCapture();
})();
