import { formatUnits } from 'viem';

// Server-only configured target. Request parameters cannot select a backend or RPC.
export async function readBackendBook(url = process.env.CLOB_BACKEND_URL, request: typeof fetch = fetch, now = Math.floor(Date.now() / 1000)) {
  if (!url) throw new Error('BACKEND_NOT_CONFIGURED');
  const target = new URL(url);
  if (target.origin !== 'https://avensdex-api.sgp.appwrite.run' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('BACKEND_TARGET_REFUSED');
  const response = await request(new URL('/snapshot', target), { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok || !response.body) throw new Error('BACKEND_UNAVAILABLE');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    bytes += part.value.byteLength; if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('BACKEND_RESPONSE_CAPACITY'); }
    chunks.push(part.value);
  }
  const frame = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!frame || frame.type !== 'snapshot' || frame.marketId !== 1 || !Number.isSafeInteger(frame.seq) || frame.seq < 0
    || !Number.isSafeInteger(frame.observedAt) || frame.observedAt > now + 30 || now - frame.observedAt > 60
    || !frame.data || frame.data.marketId !== 1 || frame.data.seq !== frame.seq || frame.data.streamId !== frame.streamId
    || frame.data.settlement !== 'unavailable') throw new Error('INVALID_BACKEND_SNAPSHOT');
  const levels = (rows: unknown, buy: boolean) => {
    if (!Array.isArray(rows) || rows.length > 256) throw new Error('INVALID_BACKEND_LEVELS');
    let previous: bigint | null = null;
    return rows.map(row => {
      if (!row || typeof row.price18 !== 'string' || !/^[1-9][0-9]{0,27}$/.test(row.price18)
        || typeof row.size6 !== 'string' || !/^[1-9][0-9]{0,17}$/.test(row.size6)
        || !Number.isInteger(row.orders) || row.orders < 1 || row.orders > 256) throw new Error('INVALID_BACKEND_LEVEL');
      const price = BigInt(row.price18);
      if (previous !== null && (buy ? price >= previous : price <= previous)) throw new Error('INVALID_BACKEND_SORT');
      previous = price;
      return { price: formatUnits(price, 18), size: formatUnits(BigInt(row.size6), 6) };
    });
  };
  const bids = levels(frame.data.bids, true), asks = levels(frame.data.asks, false);
  if (frame.data.bestBid !== (frame.data.bids[0]?.price18 ?? null) || frame.data.bestAsk !== (frame.data.asks[0]?.price18 ?? null)
    || (bids.length && asks.length && BigInt(frame.data.bids[0].price18) >= BigInt(frame.data.asks[0].price18))) throw new Error('INVALID_BACKEND_BBO');
  // Observation time only: not a fabricated last-trade timestamp or settlement confirmation.
  return { bids, asks, timestamp: frame.observedAt * 1000, provisional: true, streamId: frame.streamId, seq: frame.seq };
}
