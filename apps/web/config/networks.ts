// Avalanche C-Chain Fuji only. Mainnet (43114) is explicitly disabled and this
// module refuses to boot for any other chain.
export const FUJI_CHAIN_ID = 43113 as const;

export const NETWORK_IDS = ["fuji"] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];

export function isNetworkId(value: unknown): value is NetworkId { return value === "fuji"; }
export const PRIMARY_NETWORK: NetworkId = "fuji";

const envChainId = process.env.NEXT_PUBLIC_FUJI_CHAIN_ID;
if (envChainId && envChainId !== String(FUJI_CHAIN_ID)) {
  throw new Error(`Avensdex supports Avalanche Fuji (${FUJI_CHAIN_ID}) only; received ${envChainId}. Mainnet is disabled.`);
}
const rpcUrl = process.env.NEXT_PUBLIC_FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc";
const secondaryRpcUrl = process.env.NEXT_PUBLIC_FUJI_SECONDARY_RPC_URL || "https://avalanche-fuji-c-chain-rpc.publicnode.com";
for (const [name, url] of [["NEXT_PUBLIC_FUJI_RPC_URL", rpcUrl], ["NEXT_PUBLIC_FUJI_SECONDARY_RPC_URL", secondaryRpcUrl]] as const) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${name} is not a valid URL`); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`${name} must be an https RPC endpoint`);
  }
}
export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}
const collateral = process.env.NEXT_PUBLIC_FUJI_COLLATERAL || "";
if (collateral && !isAddress(collateral)) {
  throw new Error("NEXT_PUBLIC_FUJI_COLLATERAL is not a valid EVM address");
}

function deploymentAddress(name: string, configured: string | undefined): string {
  const value = configured || "";
  if (value && !isAddress(value)) throw new Error(`${name} is not a valid EVM address`);
  return value;
}

export interface ContractSet { vault: string; settlement: string; oracle: string; }
export interface AssetSet { usdc: string; }
export interface CollateralAsset {
  code: string; contract: string; oracleSymbol: string; settlement: boolean;
  decimals: number; note?: string;
}
export interface NetworkConfig {
  id: NetworkId; label: string; shortLabel: string; chainId: number; rpcUrl: string; secondaryRpcUrl: string;
  explorerUrl: string; contracts: ContractSet; assets: AssetSet;
  collateral: readonly CollateralAsset[]; keepersExpected: boolean;
}
// Vault/settlement/oracle addresses are added after the paused Fuji deployment
// is verified. They stay empty (not placeholders) until then; every dependent
// read and write fails closed with "not configured".
const vault = deploymentAddress("NEXT_PUBLIC_FUJI_VAULT", process.env.NEXT_PUBLIC_FUJI_VAULT);
const settlement = deploymentAddress("NEXT_PUBLIC_FUJI_SETTLEMENT", process.env.NEXT_PUBLIC_FUJI_SETTLEMENT);
const oracle = deploymentAddress("NEXT_PUBLIC_FUJI_ORACLE", process.env.NEXT_PUBLIC_FUJI_ORACLE);

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  fuji: {
    id: "fuji", label: "Avalanche Fuji", shortLabel: "Fuji", chainId: FUJI_CHAIN_ID,
    rpcUrl, secondaryRpcUrl,
    explorerUrl: "https://testnet.snowtrace.io",
    contracts: { vault, settlement, oracle },
    assets: { usdc: collateral },
    collateral: [{ code: "USDC", contract: collateral, decimals: 6, oracleSymbol: "USDC", settlement: true }],
    keepersExpected: Boolean(vault && settlement && oracle && collateral),
  },
};
export function getNetworkConfig(id: NetworkId): NetworkConfig { return NETWORKS[id]; }
