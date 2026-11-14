// Read-only canonical chain adapter for the /api/fuji routes (and the legacy
// /api alias). No signers, no keys, no mutation paths — paired public RPC
// reads pinned to one block, failing closed on disagreement or an
// unconfigured deployment.
import { pairedClients, pairedRead, configuredAddresses, type PairedClients } from "./paired";
import { vaultAbi, settlementAbi, oracleAbi } from "./abis";
import { ACTIVE_MARKETS, FUJI_CHAIN_ID } from "@/config";

const ok = (body: unknown) => ({ status: 200, body });
const unavailable = (feature: string) => ({ status: 503, body: {
  error: `${feature} is not available until the paused Fuji deployment is activated and an indexer serves it`,
  code: "UNAVAILABLE",
} });
const notConfigured = { status: 503, body: {
  error: "The Fuji deployment is not configured on this host (vault/settlement/oracle addresses are absent)",
  code: "NOT_CONFIGURED",
} };
const badRequest = (error: string) => ({ status: 400, body: { error } });

interface ReadyState {
  configured: boolean; depositsActive: boolean; entriesPaused: boolean; activationReady: boolean;
  price18: bigint | null; priceSourceTimestamp: number | null; asOf: number; blockNumber: bigint;
}

async function readReady(clients: PairedClients): Promise<ReadyState> {
  const { vault, settlement, oracle } = configuredAddresses().configured!;
  const block = await pairedRead(clients, (c, blockNumber) => c.getBlock({ blockNumber }));
  const asOf = Number(block.timestamp);
  const [depositsActive, entriesPaused, activationReady] = await Promise.all([
    pairedRead(clients, (c, blockNumber) => c.readContract({ address: vault as `0x${string}`, abi: vaultAbi, functionName: "depositsActive", blockNumber })),
    pairedRead(clients, (c, blockNumber) => c.readContract({ address: vault as `0x${string}`, abi: vaultAbi, functionName: "entriesPaused", blockNumber })),
    pairedRead(clients, (c, blockNumber) => c.readContract({ address: settlement as `0x${string}`, abi: settlementAbi, functionName: "activationReady", blockNumber })),
  ]);
  let price: { price18: bigint; sourceTimestamp: bigint } | null = null;
  try {
    price = await pairedRead(clients, (c, blockNumber) =>
      c.readContract({ address: oracle as `0x${string}`, abi: oracleAbi, functionName: "price", args: [1], blockNumber }));
  } catch {
    price = null; // Stale/invalid/future-dated oracle: adapters revert; never substitute a quote.
  }
  return {
    configured: true, depositsActive, entriesPaused, activationReady,
    price18: price?.price18 ?? null,
    priceSourceTimestamp: price === null ? null : Number(price.sourceTimestamp),
    asOf, blockNumber: clients.blockNumber,
  };
}

function readyBody(state: ReadyState) {
  const fresh = state.price18 !== null && state.priceSourceTimestamp !== null
    && state.priceSourceTimestamp <= state.asOf; // The deployed oracle enforces its 600/86400 per-feed policy.
  const chainReady = state.depositsActive && !state.entriesPaused && state.activationReady && fresh;
  const ready = false; // No public signed-order admission service is connected to this read-only host.
  return {
    ready, chainReady, orderAdmissionReady: false, code: "ORDER_ADMISSION_UNAVAILABLE", configured: true, chainId: FUJI_CHAIN_ID,
    depositsActive: state.depositsActive, entriesPaused: state.entriesPaused, activationReady: state.activationReady,
    oracleFresh: fresh, oraclePrice18: state.price18?.toString() ?? null, oracleSourceTimestamp: state.priceSourceTimestamp,
    asOf: state.asOf, readyUntil: state.asOf + 30, blockNumber: state.blockNumber.toString(),
  };
}

async function marketBody(clients: PairedClients) {
  const { oracle } = configuredAddresses().configured!;
  const block = await pairedRead(clients, (c, blockNumber) => c.getBlock({ blockNumber }));
  const asOf = Number(block.timestamp);
  const [symbol] = Object.keys(ACTIVE_MARKETS);
  let price: { price18: bigint; sourceTimestamp: bigint } | null = null;
  let funding: readonly [bigint, bigint] | null = null;
  let ratePerSecond: bigint | null = null;
  try {
    price = await pairedRead(clients, (c, blockNumber) =>
      c.readContract({ address: oracle as `0x${string}`, abi: oracleAbi, functionName: "price", args: [1], blockNumber }));
    funding = await pairedRead(clients, (c, blockNumber) =>
      c.readContract({ address: oracle as `0x${string}`, abi: oracleAbi, functionName: "fundingIndex", args: [1], blockNumber }));
  } catch {
    price = null;
  }
  try {
    // The published rate is optional context; its absence must not take down the price read.
    ratePerSecond = await pairedRead(clients, (c, blockNumber) =>
      c.readContract({ address: oracle as `0x${string}`, abi: oracleAbi, functionName: "ratePrice18PerSecond", blockNumber }));
  } catch {
    ratePerSecond = null;
  }
  return {
    market_id: 1, symbol, price: price ? price.price18.toString() : null,
    price_timestamp: price ? Number(price.sourceTimestamp) : null, as_of: asOf,
    funding_index: funding ? funding[0].toString() : null,
    funding_valid_until: funding ? Number(funding[1]) : null,
    funding_expired: funding ? Number(funding[1]) <= asOf : null,
    funding_rate_per_second_18: ratePerSecond?.toString() ?? null,
    // No on-chain aggregate source exists yet; these stay explicitly null rather than fabricated.
    last_price: null, long_open_interest: null, short_open_interest: null, volume: null,
  };
}

export async function fujiGet(url: URL): Promise<{ status: number; body: unknown }> {
  const q = url.searchParams, path = url.pathname.replace(/^\/api\/(fuji\/)?/, "").split("/").filter(Boolean);
  if (q.has("network") && q.get("network") !== "fuji") return badRequest("Only Avalanche Fuji (43113) is supported");
  try {
    const { configured } = configuredAddresses();
    if (path[0] === "health") {
      if (!configured) return ok({ ...notConfigured.body, ready: false, configured: false });
      return ok(readyBody(await readReady(await pairedClients())));
    }
    if (path[0] === "ready") {
      if (!configured) return notConfigured;
      const body = readyBody(await readReady(await pairedClients()));
      return body.ready ? ok(body) : { status: 503, body };
    }
    if (path[0] === "markets") {
      if (!configured) return notConfigured;
      const clients = await pairedClients();
      if (!path[1]) return ok([await marketBody(clients)]);
      const marketId = Number(path[1]);
      if (!Number.isSafeInteger(marketId) || marketId !== 1) return badRequest("Only market 1 (AVAX-PERP) exists on this deployment");
      if (path[2] === "orderbook") return unavailable("The order book");
      if (path[2] === "trades") return unavailable("Trade history");
      if (path[2] === "candles") return unavailable("Candles");
      if (path[2]) return { status: 404, body: { error: "Unknown market endpoint" } };
      return ok(await marketBody(clients));
    }
    if (path[0] === "orders") {
      if (path[1] && path[1] !== "list") return { status: 405, body: { error: "Authorize order changes directly in your wallet" } };
      return unavailable("Order listing");
    }
    if (path[0] === "positions") return unavailable("Position listing");
    if (path[0] === "fills") return unavailable("Fill history");
    if (path[0] === "funding") return unavailable("Funding history");
    if (path[0] === "portfolio") return unavailable("Portfolio analytics");
    if (path[0] === "leaderboard") return unavailable("The leaderboard");
    if (path[0] === "settlements") return { status: 410, body: { error: "Settlement is atomic on-chain; there is no secondary authorization endpoint" } };
    return { status: 404, body: { error: "Unknown API endpoint" } };
  } catch (error) {
    console.error("Fuji chain read failed:", error);
    return { status: 503, body: { error: "Fuji RPC is unavailable or the providers disagree", code: "RPC_UNAVAILABLE" } };
  }
}
