// One-market offchain matcher. No collateral, transaction submission or settlement authority.
export interface Order {
  id: string; trader: string; nonce: string; marketId: number; side: 'buy' | 'sell'; kind: 'limit' | 'market';
  size6: string; limitPrice18: string; expiry: number; reduceOnly: boolean; postOnly: boolean; ioc: boolean;
}
export interface StoredOrder extends Order {
  arrival: number; remaining6: string; matched6: string; cancelled6: string; resting: boolean;
  status: 'open' | 'partially_matched' | 'matched' | 'cancelled' | 'expired';
}
export type TradeSettlementStatus = 'blocked' | 'confirmed' | 'reverted' | 'unknown' | 'pending' | 'reorged';
export interface Trade {
  id: string; maker: string; taker: string; makerTrader: string; takerTrader: string;
  side: 'buy' | 'sell'; price18: string; size6: string; settlement: TradeSettlementStatus;
  settlementIntentId?: string;
}
export interface Event {
  streamId: string; marketId: number; seq: number; at: number; type: 'order' | 'level' | 'bbo' | 'trade' | 'settlement' | 'settlementOutcome' | 'positions';
  data: Record<string, unknown>;
}
export interface Positions {
  blockNumber: string; blockHash: string; sourceTime: number; values: Record<string, string>;
}
export type Command = { type: 'submit'; at: number; order: Order }
  | { type: 'cancel'; at: number; id: string; trader: string }
  | { type: 'tick'; at: number }
  // Trusted reconciler input only, never a public API. No live producer exists yet.
  | { type: 'positions'; at: number; snapshot: Positions }
  // Trusted canonical outcome input only, never a public API.
  | { type: 'settlementOutcome'; at: number; tradeId: string; intentId: string;
      status: Exclude<TradeSettlementStatus, 'blocked'>; reason: string | null };
export interface State {
  streamId: string; marketId: number; seq: number; clock: number; arrival: number; tradeId: number;
  orders: Map<string, StoredOrder>; nonces: Map<string, string>; trades: Trade[];
  positions: Positions | null; pendingReductions: Map<string, bigint>;
}
export const LIMITS = { activeOrders: 256, retainedOrders: 8704, traders: 1000, pendingMatches: 4096 } as const;
// Retain terminal identities for reorg downgrades; exhausting history stops admission, never drops evidence.
export const MAX_RETAINED_TRADES = 8192;
export const MAX_FEED_BYTES = 8 * 1024 * 1024;
export const terminalSettlement = (status: TradeSettlementStatus) => status === 'confirmed' || status === 'reverted';
export const pendingSettlements = (trades: readonly Trade[]) => trades.filter(t => !terminalSettlement(t.settlement)).length;
const orderKeys = ['id', 'trader', 'nonce', 'marketId', 'side', 'kind', 'size6', 'limitPrice18', 'expiry', 'reduceOnly', 'postOnly', 'ioc'];
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw Error('INVALID_SCHEMA');
}
export function decimal(value: unknown, max: bigint, zero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw Error('INVALID_QUANTITY');
  const n = BigInt(value); if (n > max || n < (zero ? 0n : 1n)) throw Error('QUANTITY_BOUNDS'); return n;
}
export function trader(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value) || /^0x0+$/.test(value)) throw Error('INVALID_TRADER');
}
function time(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4_294_967_295) throw Error('INVALID_TIME');
}
function validateOrder(o: Order, marketId: number, now: number) {
  exact(o, orderKeys); trader(o.trader);
  if (typeof o.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(o.id) || o.marketId !== marketId
    || !['buy', 'sell'].includes(o.side) || !['limit', 'market'].includes(o.kind)
    || [o.reduceOnly, o.postOnly, o.ioc].some(v => typeof v !== 'boolean')) throw Error('INVALID_ORDER');
  decimal(o.nonce, (1n << 64n) - 1n); decimal(o.size6, 10n ** 15n); decimal(o.limitPrice18, 10n ** 27n);
  time(o.expiry);
  if (o.expiry <= now || o.expiry > now + 86400) throw Error('INVALID_EXPIRY');
  if (o.postOnly && (o.kind === 'market' || o.ioc)) throw Error('INVALID_FLAGS');
}
const crosses = (a: Order, b: Order) => a.side === 'buy'
  ? BigInt(a.limitPrice18) >= BigInt(b.limitPrice18) : BigInt(a.limitPrice18) <= BigInt(b.limitPrice18);
function ordered(s: State, side: Order['side']) {
  return [...s.orders.values()].filter(o => o.resting && o.side === side).sort((a, b) => {
    const x = BigInt(a.limitPrice18), y = BigInt(b.limitPrice18);
    return x === y ? a.arrival - b.arrival : (side === 'buy' ? x > y : x < y) ? -1 : 1;
  });
}
function levels(s: State, side: Order['side']) {
  const result: { price18: string; size6: string; orders: number }[] = [];
  for (const o of ordered(s, side)) {
    const last = result.at(-1);
    if (last?.price18 === o.limitPrice18) { last.size6 = (BigInt(last.size6) + BigInt(o.remaining6)).toString(); last.orders++; }
    else result.push({ price18: o.limitPrice18, size6: o.remaining6, orders: 1 });
  }
  return result;
}
export function snapshot(s: State) {
  const bids = levels(s, 'buy'), asks = levels(s, 'sell');
  return { streamId: s.streamId, marketId: s.marketId, seq: s.seq, clock: s.clock, bids, asks,
    bestBid: bids[0]?.price18 ?? null, bestAsk: asks[0]?.price18 ?? null,
    orders: [...s.orders.values()].map(o => ({ ...o })), trades: s.trades.slice(-128),
    pendingSettlements: pendingSettlements(s.trades), settlement: 'unavailable',
    confirmedPositionsAvailable: s.positions !== null && s.clock - s.positions.sourceTime <= 60,
    confirmedPositions: s.positions ? structuredClone(s.positions) : null };
}
export class Matcher {
  private state: State;
  constructor(streamId: string, marketId = 1) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(streamId) || !Number.isInteger(marketId) || marketId < 1 || marketId > 8) throw Error('INVALID_MARKET');
    this.state = { streamId, marketId, seq: 0, clock: 0, arrival: 0, tradeId: 0, orders: new Map(), nonces: new Map(),
      trades: [], positions: null, pendingReductions: new Map() };
  }
  snapshot() { return snapshot(this.state); }
  trade(id: string) { const value = this.state.trades.find(t => t.id === id); return value ? structuredClone(value) : null; }
  // Prepare on a copy: rejected commands, including resource-limit failures, cannot partially mutate the book.
  prepare(command: Command) {
    const next = structuredClone(this.state), events = execute(next, command);
    return { state: next, events, baseSeq: this.state.seq };
  }
  commit(prepared: { state: State; events: Event[]; baseSeq: number }) {
    if (prepared.baseSeq !== this.state.seq) throw Error('STALE_COMMAND_PLAN');
    this.state = prepared.state; return prepared.events;
  }
  apply(command: Command) { return this.commit(this.prepare(command)); }
}
export function settlementTransitionAllowed(from: TradeSettlementStatus, to: TradeSettlementStatus): boolean {
  if (to === 'blocked') return false;
  return !terminalSettlement(from) || from === to || !terminalSettlement(to);
}
function execute(s: State, c: Command): Event[] {
  exact(c, c.type === 'submit' ? ['type', 'at', 'order'] : c.type === 'cancel' ? ['type', 'at', 'id', 'trader']
    : c.type === 'positions' ? ['type', 'at', 'snapshot']
    : c.type === 'settlementOutcome' ? ['type', 'at', 'tradeId', 'intentId', 'status', 'reason'] : ['type', 'at']);
  time(c.at); if (c.at < s.clock || s.seq > Number.MAX_SAFE_INTEGER - 10000) throw Error('CLOCK_OR_SEQUENCE_BOUNDS');
  s.clock = c.at;
  const events: Event[] = [];
  const emit = (type: Event['type'], data: Record<string, unknown>) => events.push({ streamId: s.streamId, marketId: s.marketId, seq: ++s.seq, at: s.clock, type, data });
  const orderEvent = (o: StoredOrder) => emit('order', { ...o });
  const levelEvent = (o: StoredOrder) => {
    const rows = [...s.orders.values()].filter(v => v.resting && v.side === o.side && v.limitPrice18 === o.limitPrice18);
    emit('level', { side: o.side, price18: o.limitPrice18,
      size6: rows.reduce((sum, v) => sum + BigInt(v.remaining6), 0n).toString(), orders: rows.length });
  };
  const cancel = (o: StoredOrder, status: 'cancelled' | 'expired') => {
    const wasResting = o.resting;
    o.cancelled6 = (BigInt(o.cancelled6) + BigInt(o.remaining6)).toString(); o.remaining6 = '0'; o.resting = false; o.status = status;
    orderEvent(o); if (wasResting) levelEvent(o);
  };
  const capacity = (o: Order) => {
    if (!o.reduceOnly) return BigInt(o.size6);
    const p = s.positions;
    if (!p || p.sourceTime > c.at || c.at - p.sourceTime > 60) return 0n;
    const position = BigInt(p.values[o.trader] ?? '0');
    const reducible = o.side === 'sell' && position > 0n ? position : o.side === 'buy' && position < 0n ? -position : 0n;
    const left = reducible - (s.pendingReductions.get(`${o.trader}/${o.side}`) ?? 0n);
    return left > 0n ? left : 0n;
  };
  for (const o of s.orders.values()) if (o.resting && o.expiry <= c.at) cancel(o, 'expired');
  if (c.type === 'positions') {
    const p = c.snapshot;
    exact(p, ['blockNumber', 'blockHash', 'sourceTime', 'values']);
    decimal(p.blockNumber, (1n << 64n) - 1n, true); time(p.sourceTime);
    if (!/^0x[0-9a-f]{64}$/.test(p.blockHash) || /^0x0+$/.test(p.blockHash) || p.sourceTime > c.at || c.at - p.sourceTime > 60
      || (s.positions && (BigInt(p.blockNumber) <= BigInt(s.positions.blockNumber) || p.sourceTime < s.positions.sourceTime))) throw Error('INVALID_POSITION_SOURCE');
    if (!p.values || typeof p.values !== 'object' || Array.isArray(p.values) || Object.keys(p.values).length > LIMITS.traders) throw Error('POSITION_LIMIT');
    for (const [owner, value] of Object.entries(p.values)) {
      trader(owner); if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,15})$/.test(value) || value === '-0'
        || BigInt(value) < -(10n ** 15n) || BigInt(value) > 10n ** 15n) throw Error('INVALID_POSITION');
    }
    s.positions = structuredClone(p); emit('positions', structuredClone(p) as unknown as Record<string, unknown>);
  } else if (c.type === 'cancel') {
    trader(c.trader); const o = s.orders.get(c.id);
    if (!o || o.trader !== c.trader || !o.resting) throw Error('ORDER_NOT_CANCELLABLE'); cancel(o, 'cancelled');
  } else if (c.type === 'submit') {
    const input = c.order; validateOrder(input, s.marketId, c.at);
    if (s.orders.has(input.id) || BigInt(input.nonce) <= BigInt(s.nonces.get(input.trader) ?? '0')) throw Error('ORDER_OR_NONCE_REPLAY');
    if (!s.nonces.has(input.trader) && s.nonces.size >= LIMITS.traders) throw Error('TRADER_LIMIT');
    if (input.reduceOnly) {
      const reserved = [...s.orders.values()].filter(v => v.resting && v.reduceOnly && v.trader === input.trader && v.side === input.side)
        .reduce((sum, v) => sum + BigInt(v.remaining6), 0n);
      if (BigInt(input.size6) > capacity(input) - reserved) throw Error('CONFIRMED_REDUCTION_UNAVAILABLE');
    }
    const makers = ordered(s, input.side === 'buy' ? 'sell' : 'buy');
    if (input.postOnly && makers.some(o => crosses(input, o))) throw Error('POST_ONLY_WOULD_CROSS');
    const o: StoredOrder = { ...input, arrival: ++s.arrival, remaining6: input.size6, matched6: '0', cancelled6: '0', resting: false, status: 'open' };
    s.orders.set(o.id, o); s.nonces.set(o.trader, o.nonce); orderEvent(o);
    for (const maker of makers) {
      if (o.remaining6 === '0' || !crosses(o, maker)) break;
      if (maker.trader === o.trader) { cancel(o, 'cancelled'); break; }
      const makerCapacity = capacity(maker), takerCapacity = capacity(o);
      if (makerCapacity === 0n) { cancel(maker, 'cancelled'); continue; }
      if (takerCapacity === 0n) { cancel(o, 'cancelled'); break; }
      const size = [BigInt(o.remaining6), BigInt(maker.remaining6), makerCapacity, takerCapacity].reduce((a, b) => a < b ? a : b);
      for (const leg of [maker, o]) {
        leg.remaining6 = (BigInt(leg.remaining6) - size).toString(); leg.matched6 = (BigInt(leg.matched6) + size).toString();
        leg.status = leg.remaining6 === '0' ? 'matched' : 'partially_matched';
        if (leg.remaining6 === '0') leg.resting = false;
        if (leg.reduceOnly) {
          const key = `${leg.trader}/${leg.side}`; s.pendingReductions.set(key, (s.pendingReductions.get(key) ?? 0n) + size);
        }
        orderEvent(leg);
      }
      levelEvent(maker);
      const trade: Trade = { id: `${s.streamId}:${++s.tradeId}`, maker: maker.id, taker: o.id,
        makerTrader: maker.trader, takerTrader: o.trader, side: o.side, price18: maker.limitPrice18, size6: size.toString(), settlement: 'blocked' };
      s.trades.push(trade); emit('trade', { ...trade });
      emit('settlement', { tradeId: trade.id, status: 'blocked', reason: 'SETTLEMENT_UNAVAILABLE' });
      if (pendingSettlements(s.trades) > LIMITS.pendingMatches) throw Error('PENDING_SETTLEMENT_LIMIT');
      if (s.trades.length > MAX_RETAINED_TRADES) throw Error('TRADE_HISTORY_CAPACITY');
    }
    if (o.remaining6 !== '0') {
      if (o.kind === 'market' || o.ioc || (o.reduceOnly && capacity(o) === 0n)) cancel(o, 'cancelled');
      else { o.resting = true; orderEvent(o); levelEvent(o); }
    }
    if ([...s.orders.values()].filter(v => v.resting).length > LIMITS.activeOrders) throw Error('BOOK_CAPACITY');
    // Never prune signed-order identities needed by unsettled trades.
    const pending = new Set(s.trades.flatMap(t => [t.maker, t.taker]));
    for (const [id, old] of s.orders) {
      if (s.orders.size <= LIMITS.retainedOrders) break;
      if (!old.resting && !pending.has(id)) s.orders.delete(id);
    }
    if (s.orders.size > LIMITS.retainedOrders) throw Error('HISTORY_CAPACITY');
  } else if (c.type === 'settlementOutcome') {
    if (!/^[0-9a-f]{64}$/.test(c.intentId) || !['confirmed', 'reverted', 'unknown', 'pending', 'reorged'].includes(c.status)
      || (c.reason !== null && (typeof c.reason !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(c.reason)))) throw Error('INVALID_OUTCOME');
    const trade = s.trades.find(t => t.id === c.tradeId);
    if (!trade) throw Error('UNKNOWN_TRADE');
    if (trade.settlementIntentId !== undefined && trade.settlementIntentId !== c.intentId) throw Error('SETTLEMENT_INTENT_CONFLICT');
    if (!settlementTransitionAllowed(trade.settlement, c.status)) throw Error('CONFLICTING_SETTLEMENT_OUTCOME');
    // Unsupported flags must never release reduce-only reservations against a stale position snapshot.
    for (const id of [trade.maker, trade.taker]) {
      const order = s.orders.get(id);
      if (!order || order.kind !== 'limit' || order.reduceOnly || order.postOnly || order.ioc) throw Error('UNSUPPORTED_SETTLEMENT_ORDER');
    }
    const previousStatus = trade.settlement;
    trade.settlementIntentId = c.intentId;
    trade.settlement = c.status;
    emit('settlementOutcome', { tradeId: trade.id, intentId: c.intentId, previousStatus, status: c.status,
      reason: c.reason, pendingSettlements: pendingSettlements(s.trades) });
  } else if (c.type !== 'tick') throw Error('UNKNOWN_COMMAND');
  const reductionReservations = new Map<string, bigint>();
  for (const o of [...s.orders.values()].filter(v => v.resting && v.reduceOnly).sort((a, b) => a.arrival - b.arrival)) {
    const key = `${o.trader}/${o.side}`, reserved = reductionReservations.get(key) ?? 0n;
    if (BigInt(o.remaining6) > capacity(o) - reserved) cancel(o, 'cancelled');
    else reductionReservations.set(key, reserved + BigInt(o.remaining6));
  }
  const top = snapshot(s);
  emit('bbo', { bestBid: top.bestBid, bestAsk: top.bestAsk });
  return events;
}
