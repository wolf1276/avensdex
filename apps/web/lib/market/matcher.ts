import type { OrderIntent } from "./order-intent";
import { isOrderBook } from "./orderbook";
import { apiFetch } from "@/lib/api";
import { MARKETS, CONTRACTS } from "@/config";
import { getOraclePrice } from "@/lib/evm/oracle";
import { getVaultStatus, reserveOrder, signOrder, notional6, marginRequired6, openingFee6, settlementConfigured, vaultConfigured, type AvensOrder } from "@/lib/evm/contracts";
import { publicClient } from "@/lib/evm/client";
import { settlementAbi } from "@/lib/evm/abis";

// Limit-only admission: signed vanilla limit orders are escrowed on-chain via
// settlement.reserveOrder. Matching is a separate permissionless path; nothing
// here submits a trade that the chain cannot express.
export async function submitOrder(intent: OrderIntent): Promise<{ ok: boolean; error?: string }> {
  try {
    const market = Object.values(MARKETS).find(m => m.marketId === intent.marketId);
    if (!market) throw new Error("Unknown market");
    if (!vaultConfigured() || !settlementConfigured()) throw new Error("Fuji deployment is not configured — trading is unavailable");
    const [vault, activationReady, oracle, minimumNonce] = await Promise.all([
      getVaultStatus(),
      publicClient().readContract({ address: CONTRACTS.settlement as `0x${string}`, abi: settlementAbi, functionName: "activationReady" }),
      getOraclePrice(intent.marketId),
      publicClient().readContract({ address: CONTRACTS.settlement as `0x${string}`, abi: settlementAbi, functionName: "minimumNonce", args: [intent.owner as `0x${string}`] }),
    ]);
    if (!vault.depositsActive || vault.entriesPaused) throw new Error("Deposits or trading entries are paused on the Fuji deployment");
    if (!activationReady) throw new Error("Settlement is not activation-ready");
    if (!oracle) throw new Error("Oracle is stale or unavailable; wait for a fresh on-chain price");
    const nonce = BigInt(minimumNonce) > intent.nonce ? BigInt(minimumNonce) : intent.nonce;
    if (nonce > (1n << 64n) - 1n || intent.expiryTs > BigInt(Math.floor(Date.now() / 1000) + 86_400)) {
      throw new Error("Order nonce or expiry exceeds the on-chain bounds");
    }
    const notional = notional6(intent.size, intent.limitPrice);
    if (notional <= 0n) throw new Error("Order notional is below the minimum unit");
    const leverage = Math.max(1, Math.min(10, Math.floor(intent.leverage ?? 1)));
    const order: AvensOrder = {
      trader: intent.owner as `0x${string}`,
      marketId: intent.marketId,
      side: intent.isLong ? 0 : 1,
      kind: 0,
      size6: intent.size,
      limitPrice18: intent.limitPrice,
      leverage,
      maxFeeBps: 3,
      nonce,
      expiry: intent.expiryTs,
      reduceOnly: false,
      postOnly: false,
      ioc: false,
    };
    const signature = await signOrder(intent.owner, order);
    const amount6 = marginRequired6(notional, leverage) + openingFee6(notional);
    await reserveOrder(intent.owner, { order, signature, amount6 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchOrderBook(marketId: number, signal?: AbortSignal): Promise<OrderBook | null> {
  try {
    const timeout = AbortSignal.timeout(8000);
    const r = await apiFetch(`/api/markets/${marketId}/orderbook`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store',
    });
    if (!r.ok) return null;
    const book: unknown = await r.json();
    return isOrderBook(book) ? book : null;
  } catch { return null; }
}
export async function fetchRecentTrades(marketId: number): Promise<RecentTrade[]> {
  try { const r = await apiFetch(`/api/markets/${marketId}/trades`); return r.ok ? r.json() : []; } catch { return []; }
}
export interface OrderBookLevel { price: string; size: string; }
export interface OrderBook { bids: OrderBookLevel[]; asks: OrderBookLevel[]; timestamp: number; }
export interface RecentTrade { price: string; size: string; side: "buy" | "sell" | null; timestamp: number; }
