import { DATABASE_RECORD_BYTES, DATABASE_RECORD_LIMIT, type AppendStore, type JournalDocument } from '../clob/database-journal.ts';

export interface StoreConfig { endpoint: string; projectId: string; databaseId: string; collectionId: string; apiKey: string }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
export function appwriteStore(input: StoreConfig, request: typeof fetch = fetch): AppendStore {
  const config = Object.freeze({ ...input }), endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)?cloud\.appwrite\.io$/.test(endpoint.hostname)
    || endpoint.pathname !== '/v1' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || endpoint.port) throw Error('INVALID_APPWRITE_ENDPOINT');
  for (const id of [config.projectId, config.databaseId, config.collectionId]) if (!idPattern.test(id)) throw Error('INVALID_APPWRITE_ID');
  if (typeof config.apiKey !== 'string' || !config.apiKey || config.apiKey.length > 8192 || /[\r\n]/.test(config.apiKey)) throw Error('APPWRITE_SERVER_KEY_REQUIRED');
  const base = `${config.endpoint}/databases/${encodeURIComponent(config.databaseId)}/collections/${encodeURIComponent(config.collectionId)}/documents`;
  async function call(url: string, method = 'GET', body?: unknown): Promise<unknown> {
    let response: Response;
    try { response = await request(url, { method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'X-Appwrite-Project': config.projectId, 'X-Appwrite-Key': config.apiKey, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw Error('APPWRITE_IO_OUTCOME_UNKNOWN'); }
    if (response.status === 404 && method === 'GET' && !url.includes('?')) return null;
    if (!response.ok) { await response.body?.cancel(); throw Error(response.status === 409 ? 'APPWRITE_CREATE_CONFLICT' : 'APPWRITE_REQUEST_REFUSED'); }
    const reader = response.body?.getReader(); if (!reader) throw Error('APPWRITE_RESPONSE_UNAVAILABLE');
    let bytes = 0; const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw Error('APPWRITE_RESPONSE_CAPACITY'); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('INVALID_APPWRITE_RESPONSE'); }
  }
  function row(value: unknown): JournalDocument {
    if (!value || typeof value !== 'object') throw Error('INVALID_APPWRITE_DOCUMENT');
    const v = value as Record<string, unknown>;
    if (typeof v.$id !== 'string' || !/^\d{8}$/.test(v.$id) || typeof v.payload !== 'string'
      || Buffer.byteLength(v.payload) > DATABASE_RECORD_BYTES) throw Error('INVALID_APPWRITE_DOCUMENT');
    return { id: v.$id, payload: v.payload };
  }
  return {
    async list() {
      const result: JournalDocument[] = []; let cursor: string | undefined;
      for (let page = 0; page < 12; page++) {
        const query = new URLSearchParams();
        query.append('queries[]', JSON.stringify({ method: 'orderAsc', attribute: '$id', values: [] }));
        query.append('queries[]', JSON.stringify({ method: 'limit', values: [100] }));
        if (cursor) query.append('queries[]', JSON.stringify({ method: 'cursorAfter', values: [cursor] }));
        const response = await call(`${base}?${query}`) as { documents?: unknown; total?: unknown } | null;
        if (!response || !Array.isArray(response.documents) || response.documents.length > 100
          || !Number.isSafeInteger(response.total) || (response.total as number) > DATABASE_RECORD_LIMIT + 1) throw Error('INVALID_APPWRITE_LIST');
        const rows = response.documents.map(row);
        if (rows.some((r, i) => r.id <= (i ? rows[i - 1]!.id : cursor ?? ''))) throw Error('APPWRITE_LIST_SEQUENCE');
        result.push(...rows);
        if (result.length > DATABASE_RECORD_LIMIT + 1) throw Error('DATABASE_JOURNAL_CAPACITY');
        if (rows.length < 100) return result;
        cursor = rows.at(-1)!.id;
      }
      throw Error('APPWRITE_PAGE_CAPACITY');
    },
    async get(id) {
      if (!/^\d{8}$/.test(id)) throw Error('INVALID_DOCUMENT_ID');
      const value = await call(`${base}/${id}`); if (value === null) return null;
      const result = row(value); if (result.id !== id) throw Error('APPWRITE_DOCUMENT_ID_MISMATCH'); return result;
    },
    async create(document) {
      if (!/^\d{8}$/.test(document.id) || typeof document.payload !== 'string' || Buffer.byteLength(document.payload) > DATABASE_RECORD_BYTES) throw Error('INVALID_APPEND_DOCUMENT');
      const result = row(await call(base, 'POST', { documentId: document.id, data: { payload: document.payload }, permissions: [] }));
      if (result.id !== document.id || result.payload !== document.payload) throw Error('APPWRITE_CREATE_UNCONFIRMED');
    },
  };
}
