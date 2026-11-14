// Trusted in-process reconciliation only. No signer, broadcast, admission or collateral authority.
import { JournaledMatcher } from './journal.ts';
import { SettlementJournal, type SettlementView } from './settlement-journal.ts';
import { terminalSettlement, type Event, type Trade, type TradeSettlementStatus } from './engine.ts';

export class SettlementOutcomeBridge {
  readonly matcher: JournaledMatcher;
  readonly journal: SettlementJournal;
  #queue: Promise<void> = Promise.resolve();

  constructor(matcher: JournaledMatcher, journal: SettlementJournal, deploymentId: string) {
    if (!(matcher instanceof JournaledMatcher) || !(journal instanceof SettlementJournal)) throw Error('INVALID_BRIDGE_ARGUMENTS');
    const identity = journal.binding();
    if (matcher.binding.chainId !== identity.chainId || matcher.binding.settlementContract !== identity.settlementContract
      || !/^0x[0-9a-f]{64}$/.test(deploymentId) || identity.deploymentId !== deploymentId) throw Error('INVALID_BRIDGE_BINDING');
    this.matcher = matcher;
    this.journal = journal;
  }

  private checkedTrade(tradeId: string, view: SettlementView): Trade {
    const trade = this.matcher.trade(tradeId);
    if (!trade) throw Error('UNKNOWN_TRADE');
    const intent = view.intent;
    const long = trade.side === 'buy' ? trade.taker : trade.maker;
    const short = trade.side === 'buy' ? trade.maker : trade.taker;
    if (intent.longOrderHash !== long || intent.shortOrderHash !== short || long === short
      || intent.size6 !== trade.size6 || intent.price18 !== trade.price18
      || (trade.settlementIntentId !== undefined && trade.settlementIntentId !== intent.intentId)) throw Error('TRADE_INTENT_MISMATCH');
    const orders = this.matcher.snapshot().orders;
    for (const [orderId, owner, side] of [[trade.maker, trade.makerTrader, trade.side === 'buy' ? 'sell' : 'buy'],
      [trade.taker, trade.takerTrader, trade.side]] as const) {
      const order = orders.find(o => o.id === orderId);
      if (!order || order.trader !== owner || order.side !== side || order.marketId !== this.matcher.binding.marketId) throw Error('TRADE_ORDER_MISMATCH');
      if (order.kind !== 'limit' || order.reduceOnly || order.postOnly || order.ioc) throw Error('UNSUPPORTED_SETTLEMENT_ORDER');
    }
    return trade;
  }

  reconcileTrade(tradeId: string, intentId: string, at: number): Promise<{ view: SettlementView; events: Event[] }> {
    const run = this.#queue.then(() => this.reconcileNow(tradeId, intentId, at));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async reconcileNow(tradeId: string, intentId: string, at: number) {
    if (!Number.isSafeInteger(at) || at < this.matcher.snapshot().clock || at > 4_294_967_295) throw Error('INVALID_TIME');
    const stored = this.journal.intent(intentId);
    if (!stored) throw Error('UNKNOWN_SETTLEMENT_INTENT');
    const trade = this.checkedTrade(tradeId, stored);
    const events: Event[] = [];
    const apply = (status: Exclude<TradeSettlementStatus, 'blocked'>, reason: string | null) => {
      const current = this.checkedTrade(tradeId, stored);
      if (current.settlement === status && current.settlementIntentId === intentId) return;
      events.push(...this.matcher.apply({ type: 'settlementOutcome', at: Math.max(at, this.matcher.snapshot().clock),
        tradeId, intentId, status, reason }, { version: 1, settlementIntentId: intentId }));
    };
    // Invalidate persisted terminal evidence before awaiting a fresh chain read.
    if (terminalSettlement(trade.settlement)) apply('unknown', 'RECONCILIATION_REQUIRED');
    else if (trade.settlement === 'blocked') apply('unknown', 'RECONCILIATION_REQUIRED');
    const view = await this.journal.reconcile(intentId);
    this.checkedTrade(tradeId, view);
    if (view.status === 'intent' || view.status === 'broadcast') throw Error('UNRECONCILED_SETTLEMENT_STATUS');
    apply(view.status, view.reason);
    return { view, events };
  }
}
