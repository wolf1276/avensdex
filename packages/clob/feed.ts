// Browser-safe sequence reducer for the existing terminal. No signing, balances or execution authority.
import { decimal, exact, trader, LIMITS, MAX_FEED_BYTES, type Event, type StoredOrder, type Trade, type Positions, type Matcher } from './engine.ts';
export type Snapshot = ReturnType<Matcher['snapshot']>;
const id = (v: unknown) => { if (typeof v !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(v)) throw Error('INVALID_ID'); };
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw Error('INVALID_INTEGER');
}
function checkOrder(input: unknown): StoredOrder {
  exact(input, ['id', 'trader', 'nonce', 'marketId', 'side', 'kind', 'size6', 'limitPrice18', 'expiry', 'reduceOnly', 'postOnly', 'ioc',
    'arrival', 'remaining6', 'matched6', 'cancelled6', 'resting', 'status']);
  id(input.id); trader(input.trader); integer(input.marketId, 1, 8); integer(input.arrival, 1); integer(input.expiry, 0, 4_294_967_295);
  decimal(input.nonce, (1n << 64n) - 1n); decimal(input.limitPrice18, 10n ** 27n);
  const size = decimal(input.size6, 10n ** 15n), remaining = decimal(input.remaining6, size, true);
  const matched = decimal(input.matched6, size, true), cancelled = decimal(input.cancelled6, size, true);
  if (!['buy', 'sell'].includes(input.side as string) || !['limit', 'market'].includes(input.kind as string)
    || [input.reduceOnly, input.postOnly, input.ioc, input.resting].some(v => typeof v !== 'boolean')
    || !['open', 'partially_matched', 'matched', 'cancelled', 'expired'].includes(input.status as string)
    || remaining + matched + cancelled !== size
    || (input.resting && (remaining === 0n || input.kind !== 'limit' || input.ioc))
    || (['cancelled', 'expired', 'matched'].includes(input.status as string) && (remaining !== 0n || input.resting))) throw Error('INVALID_ORDER_STATE');
  return structuredClone(input) as unknown as StoredOrder;
}
function checkTrade(input: unknown): Trade {
  exact(input, ['id', 'maker', 'taker', 'makerTrader', 'takerTrader', 'side', 'price18', 'size6', 'settlement']);
  id(input.id); id(input.maker); id(input.taker); trader(input.makerTrader); trader(input.takerTrader);
  decimal(input.size6, 10n ** 15n); decimal(input.price18, 10n ** 27n);
  if (!['buy', 'sell'].includes(input.side as string) || input.settlement !== 'blocked'
    || input.makerTrader === input.takerTrader || input.maker === input.taker) throw Error('INVALID_TRADE');
  return structuredClone(input) as unknown as Trade;
}
function checkPositions(input: unknown, clock: number): Positions {
  exact(input, ['blockNumber', 'blockHash', 'sourceTime', 'values']);
  decimal(input.blockNumber, (1n << 64n) - 1n, true); integer(input.sourceTime, 0, clock);
  if (typeof input.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(input.blockHash) || /^0x0+$/.test(input.blockHash)
    || !input.values || typeof input.values !== 'object' || Array.isArray(input.values)
    || Object.keys(input.values).length > LIMITS.traders) throw Error('INVALID_POSITION_SNAPSHOT');
  for (const [owner, value] of Object.entries(input.values)) {
    trader(owner);
    if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,15})$/.test(value) || value === '-0'
      || BigInt(value) < -(10n ** 15n) || BigInt(value) > 10n ** 15n) throw Error('INVALID_POSITION');
  }
  return structuredClone(input) as unknown as Positions;
}
function checkLevel(input: unknown) {
  exact(input, ['price18', 'size6', 'orders']); decimal(input.price18, 10n ** 27n);
  decimal(input.size6, 256n * 10n ** 15n); integer(input.orders, 1, LIMITS.activeOrders);
  return { price18: input.price18 as string, size6: input.size6 as string, orders: input.orders };
}
function sorted(levels: Snapshot['bids'], buy: boolean) {
  for (let i = 1; i < levels.length; i++) if (buy ? BigInt(levels[i - 1]!.price18) <= BigInt(levels[i]!.price18)
    : BigInt(levels[i - 1]!.price18) >= BigInt(levels[i]!.price18)) throw Error('INVALID_DEPTH_ORDER');
}
function checkSnapshot(input: unknown, marketId: number): Snapshot {
  exact(input, ['streamId', 'marketId', 'seq', 'clock', 'bids', 'asks', 'bestBid', 'bestAsk', 'orders', 'trades',
    'pendingSettlements', 'settlement', 'confirmedPositionsAvailable', 'confirmedPositions']);
  if (typeof input.streamId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.streamId) || input.marketId !== marketId
    || input.settlement !== 'unavailable' || typeof input.confirmedPositionsAvailable !== 'boolean') throw Error('INVALID_SNAPSHOT_IDENTITY');
  integer(input.seq); integer(input.clock, 0, 4_294_967_295); integer(input.pendingSettlements, 0, LIMITS.pendingMatches);
  for (const [value, max] of [[input.bids, 256], [input.asks, 256], [input.orders, LIMITS.retainedOrders], [input.trades, 128]] as const) {
    if (!Array.isArray(value) || value.length > max) throw Error('SNAPSHOT_CAPACITY');
  }
  const bids = (input.bids as unknown[]).map(checkLevel), asks = (input.asks as unknown[]).map(checkLevel);
  sorted(bids, true); sorted(asks, false);
  if (input.bestBid !== (bids[0]?.price18 ?? null) || input.bestAsk !== (asks[0]?.price18 ?? null)
    || (bids[0] && asks[0] && BigInt(bids[0].price18) >= BigInt(asks[0].price18))) throw Error('INVALID_BBO');
  const orders = (input.orders as unknown[]).map(checkOrder), trades = (input.trades as unknown[]).map(checkTrade);
  if (new Set(orders.map(o => o.id)).size !== orders.length || orders.some(o => o.marketId !== marketId)
    || new Set(trades.map(t => t.id)).size !== trades.length) throw Error('DUPLICATE_OR_FOREIGN_DATA');
  const positions = input.confirmedPositions === null ? null : checkPositions(input.confirmedPositions, input.clock);
  if (input.confirmedPositionsAvailable !== (positions !== null && input.clock - positions.sourceTime <= 60)) throw Error('POSITION_FRESHNESS_MISMATCH');
  return { streamId: input.streamId, marketId, seq: input.seq, clock: input.clock, bids, asks,
    bestBid: input.bestBid as string | null, bestAsk: input.bestAsk as string | null, orders, trades,
    pendingSettlements: input.pendingSettlements, settlement: 'unavailable', confirmedPositions: positions,
    confirmedPositionsAvailable: input.confirmedPositionsAvailable };
}
export class MarketDataFeed {
  private state: Snapshot | null = null;
  private needsSnapshot = true;
  private requested = false;
  private readonly marketId: number;
  constructor(marketId = 1) { integer(marketId, 1, 8); this.marketId = marketId; }
  view() { return { stale: this.needsSnapshot, snapshot: structuredClone(this.state) }; }
  disconnected() { this.needsSnapshot = true; this.requested = false; }
  private gap(): 'resync' | 'waiting' {
    this.needsSnapshot = true;
    if (this.requested) return 'waiting'; this.requested = true; return 'resync';
  }
  receiveText(text: string) {
    try { if (text.length > MAX_FEED_BYTES) return this.gap(); return this.receive(JSON.parse(text)); }
    catch { return this.gap(); }
  }
  receive(input: unknown): 'applied' | 'duplicate' | 'resync' | 'waiting' {
    try {
      exact(input, ['streamId', 'marketId', 'seq', 'at', 'type', 'data']);
      integer(input.seq); integer(input.at, 0, 4_294_967_295);
      if (input.type === 'snapshot') {
        const s = checkSnapshot(input.data, this.marketId);
        if (input.streamId !== s.streamId || input.marketId !== s.marketId || input.seq !== s.seq || input.at !== s.clock) return this.gap();
        if (this.state?.streamId === s.streamId && s.seq < this.state.seq) return this.needsSnapshot ? this.gap() : 'duplicate';
        this.state = s; this.needsSnapshot = false; this.requested = false; return 'applied';
      }
      if (this.needsSnapshot || !this.state) return this.gap();
      if (input.streamId !== this.state.streamId || input.marketId !== this.marketId) return this.gap();
      if (input.seq <= this.state.seq) return 'duplicate';
      if (input.seq !== this.state.seq + 1 || input.at < this.state.clock) return this.gap();
      const s = structuredClone(this.state), data = input.data;
      switch (input.type as Event['type']) {
        case 'order': {
          const order = checkOrder(data); if (order.marketId !== this.marketId) return this.gap();
          const i = s.orders.findIndex(v => v.id === order.id);
          if (i >= 0) s.orders[i] = order; else s.orders.push(order);
          if (s.orders.length > LIMITS.retainedOrders) return this.gap(); break;
        }
        case 'level': {
          exact(data, ['side', 'price18', 'size6', 'orders']);
          if (data.side !== 'buy' && data.side !== 'sell') return this.gap();
          decimal(data.price18, 10n ** 27n); const size = decimal(data.size6, 256n * 10n ** 15n, true);
          integer(data.orders, 0, 256); if ((size === 0n) !== (data.orders === 0)) return this.gap();
          const rows = (data.side === 'buy' ? s.bids : s.asks).filter(v => v.price18 !== data.price18);
          if (size > 0n) rows.push({ price18: data.price18 as string, size6: data.size6 as string, orders: data.orders });
          rows.sort((a, b) => a.price18 === b.price18 ? 0 : ((BigInt(a.price18) > BigInt(b.price18)) === (data.side === 'buy') ? -1 : 1));
          if (rows.length > 256) return this.gap();
          if (data.side === 'buy') s.bids = rows; else s.asks = rows; break;
        }
        case 'bbo': {
          exact(data, ['bestBid', 'bestAsk']);
          if (data.bestBid !== (s.bids[0]?.price18 ?? null) || data.bestAsk !== (s.asks[0]?.price18 ?? null)) return this.gap();
          s.bestBid = data.bestBid as string | null; s.bestAsk = data.bestAsk as string | null; break;
        }
        case 'trade': {
          const trade = checkTrade(data); if (s.trades.some(t => t.id === trade.id)) return this.gap();
          s.trades.push(trade); s.trades = s.trades.slice(-128); s.pendingSettlements++;
          if (s.pendingSettlements > LIMITS.pendingMatches) return this.gap(); break;
        }
        case 'settlement':
          exact(data, ['tradeId', 'status', 'reason']); id(data.tradeId);
          if (data.status !== 'blocked' || data.reason !== 'SETTLEMENT_UNAVAILABLE') return this.gap(); break;
        case 'positions': s.confirmedPositions = checkPositions(data, input.at); break;
        default: return this.gap();
      }
      s.bestBid = s.bids[0]?.price18 ?? null; s.bestAsk = s.asks[0]?.price18 ?? null;
      s.seq = input.seq; s.clock = input.at;
      s.confirmedPositionsAvailable = s.confirmedPositions !== null && s.clock - s.confirmedPositions.sourceTime <= 60;
      this.state = s; return 'applied';
    } catch { return this.gap(); }
  }
}
