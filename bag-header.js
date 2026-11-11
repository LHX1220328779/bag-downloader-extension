// 只读前 4 KB 的 RTFBAG 文件头；不拉取整个数据包，也不推断固定录制时长。
(function(root) {
  const LIMIT = 4096, decoder = new TextDecoder(), origins = new Set(['http://10.198.92.173:8080', 'http://10.198.92.173:8099']);
  function parse(bytes, filename) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const newline = data.indexOf(10);
    if (newline < 0 || newline > 40 || !/^#RTFBAG V2\.\d+\n$/.test(decoder.decode(data.subarray(0, newline + 1)))) return null;
    let pos = newline + 1;
    if (pos + 4 > data.length) return null;
    const length = view.getUint32(pos, true); pos += 4;
    const end = pos + length, fields = new Map();
    if (end > data.length || length > LIMIT) return null;
    while (pos < end) {
      if (pos + 4 > end) return null;
      const n = view.getUint32(pos, true); pos += 4;
      if (n < 3 || pos + n > end) return null;
      const field = data.subarray(pos, pos + n), eq = field.indexOf(61);
      if (eq < 1) return null;
      const name = decoder.decode(field.subarray(0, eq));
      if (fields.has(name)) return null;
      fields.set(name, field.subarray(eq + 1)); pos += n;
    }
    if (fields.get('op')?.length !== 1 || fields.get('op')[0] !== 3) return null;
    const number = name => {
      const value = fields.get(name); if (value?.length !== 8) return NaN;
      const n = Number(new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0, true));
      return Number.isSafeInteger(n) ? n : NaN;
    };
    for (const clock of ['Real', 'Virtual']) {
      const start = number(`startRecord${clock}Time`), stop = number(`stopRecord${clock}Time`);
      if (start > 0 && stop > start && Number.isFinite(+new Date(stop)) && root.BagCore.localTime(new Date(start)) === root.BagCore.filenameTime(filename)) {
        return { filename, start, stop, format: 'RTFBAG', clock };
      }
    }
    return null;
  }
  async function read(row) {
    let url = await root.SiteAPI.post('/api/bag/download', { address: new URL(root.SiteAPI.BASE).host, dirpath: row.dirpath }, [200,2000,20000]);
    if (url && typeof url === 'object') url = url.url || url.href || url.path || url.download_url;
    url = new URL(url, root.SiteAPI.BASE).href;
    if (!origins.has(new URL(url).origin)) throw Error('文件头地址不在数据服务器内');
    const response = await fetch(url, { headers: { Range: `bytes=0-${LIMIT - 1}` }, credentials: 'include', signal: AbortSignal.timeout(15000) });
    const range = response.headers.get('Content-Range')?.match(/^bytes 0-(\d+)\/(\d+)$/);
    if (response.status !== 206 || !range || Number(range[1]) >= LIMIT || Number(range[2]) <= Number(range[1]) ||
        response.headers.get('Content-Encoding') || !origins.has(new URL(response.url || url).origin)) {
      await response.body?.cancel().catch(() => {}); throw Error('服务器不支持受限文件头读取');
    }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > LIMIT) throw Error('文件头响应超出读取上限'); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (size !== Number(range[1]) + 1) throw Error('文件头响应不完整');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const bounds = parse(bytes, row.filename);
    if (!bounds) throw Error('文件头没有有效的录制起止时间');
    return { ...bounds, checkedAt: Date.now(), fileSize: Number(range[2]) };
  }
  root.BagHeader = { parse, read, LIMIT };
  if (typeof module !== 'undefined') module.exports = root.BagHeader;
})(globalThis);
