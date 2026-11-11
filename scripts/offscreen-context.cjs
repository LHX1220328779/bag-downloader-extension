// 新版 Playwright 不再枚举 background_page，使用公开 CDP 接口访问测试配置的 offscreen。
module.exports = async function offscreenContext(context, url) {
  const session = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await session.send('Target.getTargets');
  const target = targetInfos.find(t => t.url === url);
  if (!target) { await session.detach(); throw Error('测试下载文档未创建'); }
  const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  const pending = new Map(); let sequence = 0;
  session.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const reply = JSON.parse(event.message), request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id); clearTimeout(request.timer);
    if (reply.error) return request.reject(Error(reply.error.message));
    const exception = reply.result?.exceptionDetails;
    if (exception) return request.reject(Error(exception.exception?.description || exception.text));
    request.resolve(reply.result?.result?.value);
  });
  return {
    evaluate(fn, argument) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('测试下载文档调用超时')); }, 10000);
        pending.set(id, { resolve, reject, timer });
        const expression = `(${fn.toString()})(${argument === undefined ? '' : JSON.stringify(argument)})`;
        session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true, userGesture: false } }) }).catch(e => {
          pending.delete(id); clearTimeout(timer); reject(e);
        });
      });
    },
    async dispose() {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('测试下载文档已断开')); }
      pending.clear();
      await session.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      await session.detach();
    },
  };
};
