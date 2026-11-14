import { createPublicClient, http, fallback, defineChain } from "viem";
import { NETWORK, FUJI_CHAIN_ID } from "@/config";
import { getNetworkConfig, PRIMARY_NETWORK } from "@/config/networks";

export const fujiChain = defineChain({
  id: FUJI_CHAIN_ID,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: [NETWORK.rpcUrl] } },
  testnet: true,
});

const transport = fallback([http(NETWORK.rpcUrl), http(getNetworkConfig(PRIMARY_NETWORK).secondaryRpcUrl)], { rank: false });

export function publicClient() {
  return createPublicClient({ chain: fujiChain, transport });
}
