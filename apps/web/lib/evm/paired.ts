// Server-side read path for the /api/fuji adapter. Both configured RPC
// endpoints must agree on chain identity; every contract read runs at one
// shared block number on both providers and must return identical results.
import { createPublicClient, http, type PublicClient } from "viem";
import { getNetworkConfig, PRIMARY_NETWORK, isAddress } from "@/config/networks";
import { FUJI_CHAIN_ID } from "@/config";
import { fujiChain } from "./client";

export interface PairedClients { primary: PublicClient; secondary: PublicClient; blockNumber: bigint; blockHash: string }

export async function pairedClients(): Promise<PairedClients> {
  const config = getNetworkConfig(PRIMARY_NETWORK);
  const primary = createPublicClient({ chain: fujiChain, transport: http(config.rpcUrl) });
  const secondary = createPublicClient({ chain: fujiChain, transport: http(config.secondaryRpcUrl) });
  const [primaryChain, secondaryChain] = await Promise.all([primary.getChainId(), secondary.getChainId()]);
  if (primaryChain !== FUJI_CHAIN_ID || secondaryChain !== FUJI_CHAIN_ID) {
    throw new Error(`RPC chain mismatch (primary ${primaryChain}, secondary ${secondaryChain}); expected Fuji ${FUJI_CHAIN_ID}`);
  }
  const [primaryBlock, secondaryBlock] = await Promise.all([primary.getBlockNumber(), secondary.getBlockNumber()]);
  // Read at the older of the two tips so both providers can serve every call.
  const tip = primaryBlock < secondaryBlock ? primaryBlock : secondaryBlock;
  if (tip < 2n) throw new Error("Insufficient confirmation history");
  const blockNumber = tip - 2n;
  const [a, b] = await Promise.all([primary.getBlock({ blockNumber }), secondary.getBlock({ blockNumber })]);
  const age = Math.floor(Date.now() / 1000) - Number(a.timestamp);
  if (!a.hash || a.hash !== b.hash || age < -30 || age > 120) throw new Error("RPC canonical head mismatch or stale head");
  return { primary, secondary, blockNumber, blockHash: a.hash };
}

export type PairedCall<T> = (client: PublicClient, blockNumber: bigint) => Promise<T>;

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** Run the same read against both providers at one block; fail closed on disagreement. */
export async function pairedRead<T>(clients: PairedClients, call: PairedCall<T>): Promise<T> {
  const [a, b] = await Promise.all([call(clients.primary, clients.blockNumber), call(clients.secondary, clients.blockNumber)]);
  if (stable(a) !== stable(b)) throw new Error("RPC providers disagree on chain state");
  const headers = await Promise.all([clients.primary.getBlock({ blockNumber: clients.blockNumber }), clients.secondary.getBlock({ blockNumber: clients.blockNumber })]);
  if (headers.some(header => header.hash !== clients.blockHash)) throw new Error("RPC canonical block changed during read");
  return a;
}

export function configuredAddresses() {
  const { contracts } = getNetworkConfig(PRIMARY_NETWORK);
  const addresses = [contracts.vault, contracts.settlement, contracts.oracle];
  return {
    vault: contracts.vault, settlement: contracts.settlement, oracle: contracts.oracle,
    configured: addresses.every(isAddress) ? { vault: contracts.vault, settlement: contracts.settlement, oracle: contracts.oracle } : null,
  };
}
