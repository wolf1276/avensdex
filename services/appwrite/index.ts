// Appwrite Function entrypoint, not a listening server. Never loads a wallet or local journal.
import { createPublicClient, http } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { createAdmissionGate, type AdmissionDeployment } from '../clob/admission-gate.ts';
import { DatabaseJournal, type AppendStore, type DatabaseIdentity } from '../clob/database-journal.ts';
import { digest } from '../../packages/clob/journal.ts';
import { verifyAdmission, type Cancellation } from '../../packages/clob/admission.ts';
import { appwriteStore } from './store.ts';

interface Context {
  req: { method: string; path?: string; url?: string; bodyText?: string; body?: string; headers: Record<string, string | undefined> };
  res: { json(body: unknown, status?: number, headers?: Record<string, string>): unknown };
  error?(message: string): void;
}
interface Runtime {
  store: AppendStore; identity: DatabaseIdentity;
  gate: { check(envelope?: unknown): Promise<unknown> };
  realtime: { endpoint: string; projectId: string; channel: string };
}
export function createFunction(runtime: () => Runtime, clock = () => Math.floor(Date.now() / 1000), origin = 'https://avensdex.vercel.app') {
  const allowed = new URL(origin); if (allowed.origin !== origin || allowed.protocol !== 'https:') throw Error('INVALID_ALLOWED_ORIGIN');
  return async (context: Context) => {
    const { req, res } = context;
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' };
    const send = (status: number, body: unknown) => res.json(body, status, headers);
    if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'ORIGIN_REFUSED' });
    if (req.headers.origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'; headers['Access-Control-Allow-Headers'] = 'Content-Type';
    }
    if (req.method === 'OPTIONS') return send(204, {});
    try {
      const path = new URL(req.path ?? req.url ?? '/', 'https://function.invalid').pathname;
      if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'METHOD_REFUSED' });
      if (req.method === 'POST' && !['/orders', '/cancel'].includes(path)) return send(404, { error: 'NOT_FOUND' });
      const r = runtime();
      if (req.method === 'GET' && path === '/admission/ready') return send(200, { orderAdmission: 'available', ready: false, settlement: 'unavailable', source: await r.gate.check() });
      if (req.method === 'GET' && path === '/realtime') return send(200, r.realtime);
      const journal = await DatabaseJournal.load(r.store, r.identity);
      const now = clock(), snapshot = journal.snapshot();
      if (!Number.isSafeInteger(now) || now < snapshot.clock) throw Error('CLOCK_REGRESSION');
      if (snapshot.orders.some(order => order.resting && order.expiry <= now)) await journal.apply({ type: 'tick', at: now });
      if (req.method === 'GET') {
        if (path === '/health' || path === '/ready') return send(path === '/ready' ? 503 : 200, {
          chainId: 43113, marketId: 1, storage: 'database_append_log', seq: journal.snapshot().seq,
          orderAdmission: 'canonically_gated', ready: false, settlement: 'unavailable',
        });
        if (path === '/snapshot' || path === '/orderbook') {
          const data = journal.snapshot();
          return send(200, { type: 'snapshot', streamId: data.streamId, marketId: 1, seq: data.seq, at: data.clock, data, observedAt: now });
        }
        if (path === '/orders') return send(200, { orders: journal.snapshot().orders, filled: false });
        if (path === '/trades') return send(200, { trades: journal.snapshot().trades, provisional: true });
        return send(404, { error: 'NOT_FOUND' });
      }
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return send(415, { error: 'JSON_REQUIRED' });
      const text = req.bodyText ?? req.body;
      if (typeof text !== 'string' || Buffer.byteLength(text) > 8192) return send(413, { error: 'BODY_LIMIT' });
      let envelope: unknown;
      try { envelope = JSON.parse(text); } catch { return send(400, { error: 'INVALID_JSON' }); }
      if (!envelope || typeof envelope !== 'object' || (envelope as { type?: unknown }).type !== (path === '/orders' ? 'order' : 'cancel')) return send(400, { error: 'INVALID_ENVELOPE' });
      await r.gate.check(envelope);
      const verified = await verifyAdmission(r.identity.binding, envelope, clock());
      if (verified.command.type === 'cancel') {
        const command = verified.command;
        const target = journal.snapshot().orders.find(order => order.id === command.id);
        const cancel = verified.proof.envelope.cancel as Cancellation;
        if (!target || target.nonce !== cancel.nonce || target.trader !== cancel.trader) throw Error('CANCEL_TARGET_MISMATCH');
      }
      const events = await journal.apply(verified.command, verified.proof);
      return send(202, { status: path === '/orders' ? 'accepted_provisional' : 'removed_offchain',
        seq: journal.snapshot().seq, events, filled: false, settlement: 'unavailable', onchainCancellationRequired: path === '/cancel' });
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'APPWRITE_CLOB_REQUEST_REFUSED';
      context.error?.(code);
      return send(503, { error: 'BACKEND_UNAVAILABLE_OR_CONFLICT', retryRequiresStateReconciliation: true });
    }
  };
}

export default async function main(context: Context) {
  return createFunction(() => {
    const endpoint = process.env.APPWRITE_ENDPOINT ?? process.env.APPWRITE_FUNCTION_API_ENDPOINT ?? '';
    const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID ?? '';
    const databaseId = process.env.CLOB_DATABASE_ID ?? '', collectionId = process.env.CLOB_COLLECTION_ID ?? '';
    const config = JSON.parse(process.env.CLOB_DEPLOYMENT_JSON ?? '') as AdmissionDeployment;
    const clients = ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com']
      .map(url => createPublicClient({ chain: avalancheFuji, transport: http(url, { timeout: 5000, retryCount: 0 }), cacheTime: 0 }));
    const gate = createAdmissionGate(clients[0]!, clients[1]!, config);
    const store = appwriteStore({ endpoint, projectId, databaseId, collectionId, apiKey: context.req.headers['x-appwrite-key'] ?? '' });
    return { store, gate, identity: { binding: gate.binding, deploymentId: config.deploymentId, configDigest: digest(config) },
      realtime: { endpoint, projectId, channel: `databases.${databaseId}.collections.${collectionId}.documents` } };
  })(context);
}
