import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { JournaledMatcher } from '../../packages/clob/journal.ts';
import { MAX_FEED_BYTES, exact, type Command, type Event } from '../../packages/clob/engine.ts';
import { admitSigned } from '../../packages/clob/admission.ts';
import { SettlementOutcomeBridge } from '../../packages/clob/settlement-bridge.ts';
import { readPolicyConfirmedPositions } from '../../packages/clob/settlement-reader.ts';
import type { SettlementIdentity } from '../../packages/clob/settlement-journal.ts';
import type { PublicClient } from 'viem';
import { readFundingSnapshot } from '../../packages/clob/funding-reader.ts';

export const MAX_CLIENTS = 16;
export const MAX_BUFFERED_BYTES = MAX_FEED_BYTES;
export function sendBounded(socket: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'close' | 'terminate' | 'send'>, text: string) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount + Buffer.byteLength(text) > MAX_BUFFERED_BYTES) {
    socket.close(1013, 'resynchronize'); const timer = setTimeout(() => socket.terminate(), 1000); timer.unref(); return false;
  }
  try { socket.send(text); return true; }
  catch { socket.terminate(); return false; }
}
function allowedOrigin(origin: string | undefined) {
  if (!origin) return true; // CLI/native local clients do not send a browser Origin.
  try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname); }
  catch { return false; }
}
export async function startMarketData(journal: JournaledMatcher, port = 8787, clock = () => Math.floor(Date.now() / 1000)) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('INVALID_PORT');
  const startup = journal.snapshot();
  const at = () => Math.max(startup.clock, clock());
  if (journal.hasTerminalSettlements) journal.apply({ type: 'invalidateSettlements', at: at(), reason: 'RESTART_RECONCILIATION_REQUIRED' });
  if (startup.confirmedPositions !== null) journal.apply({ type: 'invalidatePositions', at: at(), reason: 'RESTART_RECONCILIATION_REQUIRED' });
  let funding: Awaited<ReturnType<typeof readFundingSnapshot>> | null = null;
  function fundingView() {
    const now = clock();
    if (!funding || !Number.isSafeInteger(now) || now < funding.sourceTime || now - funding.sourceTime > 60
      || now < funding.indexSourceTime || now - funding.indexSourceTime > Number(funding.parameters[8])
      || now < funding.markSourceTime || now - funding.markSourceTime > Number(funding.parameters[9])) return null;
    return { ...funding, fundingAvailable: now < funding.rateValidUntil };
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!allowedOrigin(req.headers.origin)) { res.writeHead(403).end('{"error":"ORIGIN_REFUSED"}'); return; }
    if (req.method !== 'GET') {
      // No unverified order/cancel/position/admin write API, demo mode or private signer.
      res.setHeader('Connection', 'close'); res.writeHead(503).end('{"error":"FUJI_ADMISSION_AND_SETTLEMENT_UNAVAILABLE"}'); return;
    }
    if (req.url === '/snapshot') { res.end(JSON.stringify(frame())); return; }
    if (req.url === '/funding') {
      const data = fundingView();
      if (!data) { res.writeHead(503).end('{"error":"CANONICAL_FUNDING_UNAVAILABLE"}'); return; }
      res.end(JSON.stringify({ funding: data, lastProvisionalTradePrice18: journal.snapshot().trades.at(-1)?.price18 ?? null })); return;
    }
    if (req.url === '/health' || req.url === '/ready') {
      res.writeHead(req.url === '/ready' ? 503 : 200).end(JSON.stringify({ chainId: 43113,
        marketId: journal.binding.marketId, streamId: journal.snapshot().streamId, seq: journal.snapshot().seq,
        journalWritable: journal.writable, orderAdmission: 'unavailable', settlement: 'unavailable', confirmedPositions: 'unavailable', ready: false })); return;
    }
    res.writeHead(404).end('{"error":"NOT_FOUND"}');
  });
  server.maxConnections = 64; server.maxRequestsPerSocket = 100; server.keepAliveTimeout = 5000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const frame = () => {
    const data = journal.snapshot();
    return { type: 'snapshot', streamId: data.streamId, marketId: data.marketId, seq: data.seq, at: data.clock, data };
  };
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/stream' || !allowedOrigin(req.headers.origin) || wss.clients.size >= MAX_CLIENTS) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', socket => {
    let lastResync = 0;
    sendBounded(socket, JSON.stringify(frame()));
    socket.on('error', () => { /* Per-client errors cannot stop the journal writer. */ });
    socket.on('message', data => {
      try {
        const message: unknown = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)
          || Object.keys(message).length !== 1 || (message as { type?: unknown }).type !== 'resync') throw Error('INVALID_SUBSCRIPTION');
        const now = Date.now();
        if (now - lastResync < 1000) { socket.close(1008, 'resync-rate-limit'); return; }
        lastResync = now; sendBounded(socket, JSON.stringify(frame()));
      } catch { socket.close(1008, 'invalid-subscription'); }
    });
  });
  // Trusted in-process producer boundary only. Network clients cannot call this or inject confirmed positions.
  function publish(events: Event[]) {
    for (const event of events) {
      const text = JSON.stringify(event);
      for (const client of wss.clients) sendBounded(client, text);
    }
    return { seq: journal.snapshot().seq, events };
  }
  function apply(command: Command, proof: unknown = null) { return publish(journal.apply(command, proof)); }
  async function applySigned(envelope: unknown) {
    const result = await admitSigned(journal, envelope, clock());
    return { ...publish(result.events), settlement: 'unavailable' as const };
  }
  async function reconcileSettlement(bridge: SettlementOutcomeBridge, tradeId: string, intentId: string) {
    if (!(bridge instanceof SettlementOutcomeBridge) || bridge.matcher !== journal) throw Error('SETTLEMENT_MATCHER_MISMATCH');
    try { return await bridge.reconcileTrade(tradeId, intentId, clock()); }
    finally {
      // Other producers may run while RPC reads await. Publish a coherent latest snapshot, not reordered deltas.
      const text = JSON.stringify(frame());
      for (const client of wss.clients) sendBounded(client, text);
    }
  }
  let positionQueue: Promise<void> = Promise.resolve();
  function refreshPositions(primary: PublicClient, secondary: PublicClient, identity: SettlementIdentity,
    policy: { confirmations: number; maxPairs: number }) {
    const capturedIdentity = structuredClone(identity), capturedPolicy = structuredClone(policy);
    const run = positionQueue.then(() => refreshPositionsNow(primary, secondary, capturedIdentity, capturedPolicy));
    positionQueue = run.then(() => undefined, () => undefined);
    return run;
  }
  async function refreshPositionsNow(primary: PublicClient, secondary: PublicClient, identity: SettlementIdentity,
    policy: { confirmations: number; maxPairs: number }) {
    exact(policy, ['confirmations', 'maxPairs']);
    if (identity.chainId !== journal.binding.chainId || identity.settlementContract !== journal.binding.settlementContract) throw Error('POSITION_MATCHER_MISMATCH');
    apply({ type: 'invalidatePositions', at: clock(), reason: 'CANONICAL_REFRESH_REQUIRED' });
    const snapshot = await readPolicyConfirmedPositions(primary, secondary, identity, { ...policy, now: clock() });
    // Revalidate source-block age at publication, not only when the potentially slow RPC read began.
    return apply({ type: 'positions', at: clock(), snapshot });
  }
  let fundingQueue: Promise<void> = Promise.resolve();
  function refreshFunding(primary: PublicClient, secondary: PublicClient, input: unknown) {
    const captured = structuredClone(input);
    const run = fundingQueue.then(async () => {
      if (!captured || typeof captured !== 'object' || Array.isArray(captured)) throw Error('INVALID_FUNDING_INPUT');
      const identity = captured as Record<string, unknown>;
      if (identity.chainId !== journal.binding.chainId || identity.settlementContract !== journal.binding.settlementContract) throw Error('FUNDING_MATCHER_MISMATCH');
      funding = null;
      funding = await readFundingSnapshot(primary, secondary, { ...identity, now: clock() });
      const current = fundingView();
      if (!current) throw Error('STALE_FUNDING_OBSERVATION');
      return current;
    });
    fundingQueue = run.then(() => undefined, () => undefined);
    return run;
  }
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !journal.writable) return;
    const s = journal.snapshot(), now = clock();
    const due = s.orders.some(o => o.resting && o.expiry <= now)
      || (s.confirmedPositionsAvailable && s.confirmedPositions !== null && now - s.confirmedPositions.sourceTime > 60);
    if (due) {
      try { apply({ type: 'tick', at: now }); }
      catch { stopped = true; for (const client of wss.clients) client.close(1011, 'writer-unavailable'); }
    }
  }, 100); timer.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { clearInterval(timer); wss.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw Error('LISTEN_FAILED');
  return { port: address.port, apply, applySigned, reconcileSettlement, refreshPositions, refreshFunding,
    async close() {
      stopped = true; clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    } };
}
