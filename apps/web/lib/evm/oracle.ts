import { CONTRACTS } from "@/config";
import { publicClient } from "./client";
import { oracleAbi } from "./abis";

/**
 * Fresh AVAX-PERP oracle observation straight from the adapter contract.
 * `timestamp` is the source feed timestamp reported by the contract — never
 * the time this client happened to fetch. Stale/invalid data returns null.
 */
export async function getOraclePrice(marketId = 1): Promise<{ price: bigint; timestamp: number } | null> {
  const oracle = CONTRACTS.oracle;
  if (!oracle.startsWith("0x")) return null;
  try {
    const result = await publicClient().readContract({
      address: oracle as `0x${string}`, abi: oracleAbi, functionName: "price", args: [marketId],
    });
    const now = Math.floor(Date.now() / 1000);
    if (result.price18 <= 0n) return null;
    // The adapter already reverts on stale/future data; guard anyway for transport drift.
    if (Number(result.sourceTimestamp) > now + 5 || now - Number(result.sourceTimestamp) > 120) return null;
    return { price: result.price18, timestamp: Number(result.sourceTimestamp) };
  } catch {
    return null; // Invalid, stale, future-dated or unavailable oracle — never substitute chart data.
  }
}
