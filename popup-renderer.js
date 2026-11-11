// 对已连接的任务节点做增量更新，保留滚动容器、焦点和原生滚动惯性。
const PanelDOM = (() => {
  const key = (node) => node.nodeType === Node.ELEMENT_NODE ? node.dataset.nodeKey : null;
  const compatible = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== Node.ELEMENT_NODE || a.tagName === b.tagName);
  function order(parent, nodes) {
    const keep = new Set(nodes); let cursor = parent.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
    for (const node of [...parent.childNodes]) if (!keep.has(node)) node.remove();
  }
  function patch(current, next) {
    if (current === next) return current;
    if (!compatible(current, next)) { current.replaceWith(next); return next; }
    if (current.nodeType !== Node.ELEMENT_NODE) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return current;
    }
    // 日志/恢复展开由用户控制，进度刷新不改它；主任务折叠按持久化状态同步。
    const preserveOpen = current.tagName === 'DETAILS' && current.hasAttribute('data-key');
    for (const attr of [...current.attributes]) {
      if (!(preserveOpen && attr.name === 'open') && !next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of [...next.attributes]) {
      if (!(preserveOpen && attr.name === 'open') && current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    const keyed = new Map(), plain = [];
    for (const child of current.childNodes) { const id = key(child); if (id) keyed.set(id, child); else plain.push(child); }
    let index = 0;
    const children = [...next.childNodes].map((child) => {
      const id = key(child), old = id ? keyed.get(id) : plain[index++];
      return old ? patch(old, child) : child;
    });
    order(current, children); return current;
  }
  return { patch, order };
})();
