import { getNetworkConfig, PRIMARY_NETWORK, type NetworkId } from "./networks";
export { NETWORKS, NETWORK_IDS, PRIMARY_NETWORK, FUJI_CHAIN_ID, getNetworkConfig, isNetworkId, isAddress } from "./networks";
export type { NetworkId, NetworkConfig, ContractSet, AssetSet, CollateralAsset } from "./networks";
export const ACTIVE_NETWORK_ID: NetworkId = PRIMARY_NETWORK;
const active = getNetworkConfig(ACTIVE_NETWORK_ID);
export const NETWORK = { name: active.id, rpcUrl: active.rpcUrl, chainId: active.chainId };
export const CONTRACTS = active.contracts;
export const ASSETS = active.assets;
export const COLLATERAL = active.collateral;
export const SETTLEMENT_ASSET = COLLATERAL[0];
export const PRICE_PRECISION = 10n ** 18n;
export const AMOUNT_PRECISION = 10n ** 6n;
export const BPS_PRECISION = 10000;
export const EXPLORER_URL = active.explorerUrl;
export const NETWORK_LABEL = active.label;
export interface MarketConfig {
  marketId: number; symbol: string; displayName: string; baseAsset: string; quoteAsset: string;
  oracleSymbol: string; priceSourceSymbol: string; settlementAsset: string; tvSymbol: string;
  maxLeverageBps: number; initialMarginBps: number; maintenanceMarginBps: number; liquidationFeeBps: number;
  priceDecimals: number; sizeDecimals: number; tickSizes: number[]; maxOpenInterestBase: number; maxOpenInterestUsd: number;
}
// One isolated, bilateral AVAX-PERP market. The settlement contract binds a
// single marketId at construction; additional markets require a new deployment.
const definitions: Array<[string, number, number, number[], number, number]> = [
  ["AVAX", 2, 2, [0.01, 0.1, 1], 1000, 1000],
];
export const MARKETS: Record<string, MarketConfig> = Object.fromEntries(definitions.map(([base, priceDecimals, sizeDecimals, tickSizes, maxOpenInterestBase, initialMarginBps], i) => {
  const symbol = `${base}-PERP`;
  return [symbol, { marketId: i + 1, symbol, displayName: symbol, baseAsset: base, quoteAsset: "USDC", oracleSymbol: base,
    priceSourceSymbol: `${base}USDT`, settlementAsset: ASSETS.usdc, tvSymbol: `BINANCE:${base}USDT`,
    maxLeverageBps: Math.floor(10000 / initialMarginBps) * 10000, initialMarginBps, maintenanceMarginBps: initialMarginBps / 2,
    liquidationFeeBps: 50, priceDecimals, sizeDecimals, tickSizes, maxOpenInterestBase, maxOpenInterestUsd: 10000 }];
}));
export const ACTIVE_MARKET_SYMBOLS = [...new Set((process.env.NEXT_PUBLIC_ACTIVE_MARKETS || "AVAX-PERP").split(",").map(s => s.trim().toUpperCase()))];
if (!ACTIVE_MARKET_SYMBOLS.length || ACTIVE_MARKET_SYMBOLS.some(s => !MARKETS[s])) throw new Error("Invalid active market configuration");
export const ACTIVE_MARKETS = Object.fromEntries(ACTIVE_MARKET_SYMBOLS.map(s => [s, MARKETS[s]]));
export const DEFAULT_MARKET_SYMBOL = ACTIVE_MARKET_SYMBOLS[0];
