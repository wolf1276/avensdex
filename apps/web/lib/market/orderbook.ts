import { parsePrice } from '@/lib/evm/units';

export interface BookLevel { price: string; size: string }

/** Bucket decimal prices exactly; binary floats can move an on-tick bid/ask by a full tick. */
export function groupByTick(levels: BookLevel[], tick: number, isBid: boolean): { price: number; size: number }[] {
  if (!Number.isFinite(tick) || tick <= 0) return [];
  let step: bigint;
  try { step = parsePrice(tick.toFixed(18)); } catch { return []; }
  const buckets = new Map<bigint, number>();
  for (const level of levels) {
    const size = Number(level.size);
    if (!Number.isFinite(size) || size <= 0 || level.price.length > 80) continue;
    try {
      const price = parsePrice(level.price);
      const bucket = (isBid ? price / step : (price + step - 1n) / step) * step;
      if (bucket > 0n) buckets.set(bucket, (buckets.get(bucket) ?? 0) + size);
    } catch { /* Ignore invalid presentation levels, never coerce them into a price. */ }
  }
  return [...buckets.entries()].sort(([a], [b]) => a === b ? 0 : (a > b) === isBid ? -1 : 1)
    .map(([price, size]) => ({ price: Number(price) / 1e18, size }));
}

export function isOrderBook(value: unknown): value is { bids: BookLevel[]; asks: BookLevel[]; timestamp: number } {
  if (!value || typeof value !== 'object') return false;
  const book = value as Record<string, unknown>;
  const decimal = (value: unknown) => typeof value === 'string' && value.length <= 80 && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
  const levels = (rows: unknown) => Array.isArray(rows) && rows.every(row => {
    if (!row || typeof row !== 'object' || !decimal(row.price) || !decimal(row.size)) return false;
    try { parsePrice(row.price); return true; } catch { return false; }
  });
  return levels(book.bids) && levels(book.asks) && Number.isSafeInteger(book.timestamp) && (book.timestamp as number) >= 0;
}
