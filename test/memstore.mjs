// In-memory stand-in for a Netlify Blobs store (same methods the app uses).
export function memStore() {
  const m = new Map(); let v = 0;
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k).data) : null; },
    async getWithMetadata(k) { return m.has(k) ? { data: structuredClone(m.get(k).data), etag: m.get(k).etag } : null; },
    async setJSON(k, data, o = {}) {
      const cur = m.get(k);
      if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
      if (o.onlyIfNew && cur) return { modified: false };
      const etag = `e${++v}`; m.set(k, { data: structuredClone(data), etag }); return { modified: true, etag };
    },
    _dump: () => m,
  };
}
