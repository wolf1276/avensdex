import { COLLATERAL, type CollateralAsset } from "@/config";
import { getCollateralConfig, getDepositCap, getTotalDeposited, vaultConfigured } from "./contracts";
export interface ListedCollateral extends CollateralAsset {
  haircutBps: number; depositCap: bigint | null; totalDeposited: bigint; capHeadroom: bigint | null;
}

// Only the configured single collateral asset can be listed; anything else is
// never admitted, even if a token contract exists at the configured address.
export async function listVaultCollateral(): Promise<ListedCollateral[]> {
  if (!vaultConfigured()) return [];
  const rows = await Promise.all(COLLATERAL.filter(a => a.contract).map(async a => {
    const config = await getCollateralConfig(a.contract);
    if (!config?.active) return null;
    const [depositCap, totalDeposited] = await Promise.all([getDepositCap(), getTotalDeposited()]);
    return { ...a, haircutBps: config.haircutBps, depositCap, totalDeposited,
      capHeadroom: depositCap === null ? null : depositCap > totalDeposited ? depositCap - totalDeposited : 0n };
  }));
  return rows.filter((a): a is ListedCollateral => a !== null);
}

/** The EVM vault requires exact six-decimal USDC; no bridging rounding applies. */
export function roundToBridgeable(raw: bigint, asset: CollateralAsset): bigint {
  if (asset.decimals !== 6) throw new Error("Unsupported collateral precision");
  return raw;
}
