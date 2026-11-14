// Avensdex limit-order intent. Only the plain, vanilla-limit shape the
// settlement contract admits exists here: no reduce-only, post-only, IOC or
// market variants, because the chain rejects them as UnsupportedOrder.

export interface OrderIntent {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;       // uint128 size6 (1e6 USDC-denominated contracts)
  limitPrice: bigint; // uint128 price18
  leverage?: number;  // uint32, 1..10 (settlement MAX_LEVERAGE)
  nonce: bigint;      // uint64
  expiryTs: bigint;   // uint64 unix seconds; > now and <= now + 86_400
}

export const MAX_ORDER_LIFETIME_SECONDS = 86_400;
export const MAX_LEVERAGE = 10;

// Local candidate nonce; submission also checks the settlement contract's
// monotonic per-trader floor. The chain rejects duplicates across tabs or sessions.
let nonceCounter = 0;
let lastNonce = 0n;

export function nextOrderNonce(): bigint {
  const candidate = BigInt(Date.now()) * 1000n + BigInt(nonceCounter++ % 1000);
  lastNonce = candidate > lastNonce ? candidate : lastNonce + 1n;
  return lastNonce;
}

export function buildOrderIntent(params: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  leverage?: number;
  ttlSeconds?: number;
}): OrderIntent {
  const leverage = Math.max(1, Math.min(MAX_LEVERAGE, Math.floor(params.leverage ?? 1)));
  const ttl = Math.max(1, Math.min(MAX_ORDER_LIFETIME_SECONDS, Math.floor(params.ttlSeconds ?? 3600)));
  return {
    owner: params.owner,
    marketId: params.marketId,
    isLong: params.isLong,
    size: params.size,
    limitPrice: params.limitPrice,
    leverage,
    nonce: nextOrderNonce(),
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + ttl),
  };
}
