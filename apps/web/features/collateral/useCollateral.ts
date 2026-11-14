"use client";

// One source of truth for "what collateral does this account hold, and what is
// it worth as margin". The AvensVault holds a single 6-decimal USDC collateral
// asset at 1:1 margin value — there is no haircut, no bridging and no oracle
// conversion to apply. Balances come straight from the vault ledger.

import { useQuery } from "@tanstack/react-query";
import { getBalance, getTokenBalance, vaultConfigured } from "@/lib/evm/contracts";
import { listVaultCollateral, type ListedCollateral } from "@/lib/evm/collateral";
import { amountToHuman } from "@/lib/format";

export interface CollateralPosition extends ListedCollateral {
  /** Vault balance in contract units. */
  raw: bigint;
  /** Vault balance, human units. */
  balance: number;
  /** Wallet (undeposited) balance, human units. */
  walletBalance: number;
  /** USDC is the settlement unit; valued 1:1 by the vault's own accounting. */
  price: number;
  /** balance × price — what the collateral is worth. */
  value: number;
  /** value — the vault applies no haircut. */
  marginValue: number;
}

export function useCollateral(address: string | null | undefined) {
  const { data: listed } = useQuery({
    queryKey: ["vaultCollateral"],
    queryFn: listVaultCollateral,
    staleTime: 5 * 60_000,
  });

  return useQuery({
    queryKey: ["collateralPositions", address, (listed ?? []).map((l) => l.code).join(",")],
    enabled: !!address && !!listed?.length && vaultConfigured(),
    refetchInterval: 15_000,
    queryFn: async (): Promise<CollateralPosition[]> =>
      Promise.all(
        (listed ?? []).map(async (asset) => {
          const [raw, wallet] = await Promise.all([
            getBalance(address!, asset.contract),
            getTokenBalance(address!, asset.contract).catch(() => 0n),
          ]);
          const value = amountToHuman(raw);
          return {
            ...asset,
            raw,
            balance: amountToHuman(raw),
            walletBalance: amountToHuman(wallet),
            price: 1,
            value,
            marginValue: value,
          };
        })
      ),
  });
}
