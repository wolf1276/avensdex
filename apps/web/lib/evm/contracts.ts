"use client";

import { CONTRACTS, ASSETS } from "@/config";
import { publicClient } from "./client";
import { vaultAbi, erc20Abi, settlementAbi } from "./abis";
import { writeWithWallet, getWalletAccount, isOnExpectedNetwork, injectedWalletClient } from "./wallet";
import { requireAccountId } from "./account";
import { FUJI_CHAIN_ID } from "@/config";
import { hashTypedData } from "viem";

const vaultAddress = (): `0x${string}` | null => (CONTRACTS.vault.startsWith("0x") ? (CONTRACTS.vault as `0x${string}`) : null);
const settlementAddress = (): `0x${string}` | null => (CONTRACTS.settlement.startsWith("0x") ? (CONTRACTS.settlement as `0x${string}`) : null);
const oracleAddress = (): `0x${string}` | null => (CONTRACTS.oracle.startsWith("0x") ? (CONTRACTS.oracle as `0x${string}`) : null);
export const oracleConfigured = () => oracleAddress() !== null;

export function vaultConfigured(): boolean { return vaultAddress() !== null && ASSETS.usdc.startsWith("0x"); }
export function settlementConfigured(): boolean { return settlementAddress() !== null; }
function requireVault(): `0x${string}` { const v = vaultAddress(); if (!v) throw new Error("Fuji vault is not configured — the deployment has not been published yet"); return v; }
function requireSettlement(): `0x${string}` { const s = settlementAddress(); if (!s) throw new Error("Fuji settlement is not configured — the deployment has not been published yet"); return s; }
function collateralAddress(): `0x${string}` { const c = ASSETS.usdc; if (!c.startsWith("0x")) throw new Error("Fuji collateral token is not configured — the deployment has not been published yet"); return c as `0x${string}`; }

export interface RawAccountHealth {
  /** On-chain free collateral in USDC units (6 decimals). */
  freeCollateral: bigint;
  /** true while the settlement module is bound and the deployment is not paused. */
  configured: boolean;
}

// Reads that require deployment configuration throw when it is absent; callers
// use react-query error states and show "unavailable", never invented numbers.
export async function getAccountHealth(accountId: string): Promise<RawAccountHealth> {
  requireAccountId(accountId);
  const vault = requireVault();
  const free = await publicClient().readContract({
    address: vault, abi: vaultAbi, functionName: "freeBalance", args: [accountId as `0x${string}`],
  });
  return { freeCollateral: free, configured: true };
}

/** Vault (unlocked, unencumbered) collateral balance for the configured USDC asset. */
export async function getBalance(accountId: string, tokenId = ASSETS.usdc): Promise<bigint> {
  requireAccountId(accountId);
  if (tokenId.toLowerCase() !== collateralAddress().toLowerCase()) throw new Error("Only the configured USDC collateral asset is supported");
  return publicClient().readContract({
    address: requireVault(), abi: vaultAbi, functionName: "freeBalance", args: [accountId as `0x${string}`],
  });
}

/** Wallet balance of the configured collateral token. */
export async function getTokenBalance(accountId: string, tokenId = ASSETS.usdc): Promise<bigint> {
  requireAccountId(accountId);
  return publicClient().readContract({
    address: tokenId as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [accountId as `0x${string}`],
  });
}

export interface VaultStatus { depositsActive: boolean; entriesPaused: boolean; depositCap6: bigint; totalLiabilities6: bigint; }

export async function getVaultStatus(): Promise<VaultStatus> {
  const vault = requireVault();
  const client = publicClient();
  const [depositsActive, entriesPaused, depositCap6, totalLiabilities6] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: "depositsActive" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "entriesPaused" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "depositCap6" }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "totalLiabilities6" }),
  ]);
  return { depositsActive, entriesPaused, depositCap6, totalLiabilities6 };
}

export async function getCollateralConfig(tokenId: string) {
  // The AvensVault holds one 6-decimal collateral asset at 1:1 margin value;
  // there is no haircut or per-asset oracle in the frozen vault.
  if (!vaultAddress() || tokenId.toLowerCase() !== collateralAddress().toLowerCase()) return null;
  return { oracleSymbol: "USDC", haircutBps: 0, active: true };
}

export async function getDepositCap(): Promise<bigint | null> {
  return publicClient().readContract({ address: requireVault(), abi: vaultAbi, functionName: "depositCap6" });
}
export async function getTotalDeposited(): Promise<bigint> {
  return publicClient().readContract({ address: requireVault(), abi: vaultAbi, functionName: "totalLiabilities6" });
}

/** EIP-712 order payload exactly as AvensSettlement/ClobAuth encodes it. */
export interface AvensOrder {
  trader: `0x${string}`;
  marketId: number;
  side: 0 | 1;
  kind: 0;
  size6: bigint;
  limitPrice18: bigint;
  leverage: number;
  maxFeeBps: number;
  nonce: bigint;
  expiry: bigint;
  reduceOnly: false;
  postOnly: false;
  ioc: false;
}

export const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" }, { name: "marketId", type: "uint32" },
    { name: "side", type: "uint8" }, { name: "kind", type: "uint8" },
    { name: "size6", type: "uint128" }, { name: "limitPrice18", type: "uint128" },
    { name: "leverage", type: "uint32" }, { name: "maxFeeBps", type: "uint16" },
    { name: "nonce", type: "uint64" }, { name: "expiry", type: "uint64" },
    { name: "reduceOnly", type: "bool" }, { name: "postOnly", type: "bool" }, { name: "ioc", type: "bool" },
  ],
} as const;

export function orderDomain(settlement: `0x${string}`, chainId: number) {
  return { name: "Avensdex", version: "1", chainId, verifyingContract: settlement } as const;
}

/** ceil(notional * 3 / 10_000), matching RiskMath.openingFee6. */
export const openingFee6 = (notional6: bigint): bigint => (notional6 * 3n + 9999n) / 10000n;
/** Size (6dp) × price (18dp) → USDC notional (6dp), floor, matching AssetUnits.mulDiv. */
export const notional6 = (size6: bigint, price18: bigint): bigint => (size6 * price18) / 10n ** 18n;
export const marginRequired6 = (notional: bigint, leverage: number): bigint => (notional + BigInt(leverage) - 1n) / BigInt(leverage);

export async function deposit(accountId: string, amount6: bigint, tokenId = ASSETS.usdc) {
  if (amount6 <= 0n) throw new Error("Amount must be positive");
  requireAccountId(accountId);
  const vault = requireVault();
  const token = collateralAddress();
  if (tokenId.toLowerCase() !== token.toLowerCase()) throw new Error("Only the configured USDC collateral asset is supported");
  const client = publicClient();
  const allowance = await client.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [accountId as `0x${string}`, vault],
  });
  if (allowance < amount6) {
    // Exact-amount approval: no unlimited allowances are granted.
    await writeWithWallet({ expectedOwner: accountId, address: token, abi: erc20Abi, functionName: "approve", args: [vault, amount6] });
  }
  return writeWithWallet({ expectedOwner: accountId, address: vault, abi: vaultAbi, functionName: "deposit", args: [amount6] });
}

export function withdraw(accountId: string, amount6: bigint, tokenId = ASSETS.usdc) {
  if (amount6 <= 0n) throw new Error("Amount must be positive");
  if (tokenId.toLowerCase() !== collateralAddress().toLowerCase()) throw new Error("Only the configured USDC collateral asset is supported");
  return writeWithWallet({ expectedOwner: accountId, address: requireVault(), abi: vaultAbi, functionName: "withdraw", args: [amount6] });
}

export function closePosition(accountId: string, pairId: bigint, closeSize6: bigint) {
  if (closeSize6 <= 0n) throw new Error("Close size must be positive");
  if (pairId <= 0n || pairId > (1n << 64n) - 1n) throw new Error("Invalid pair id");
  return writeWithWallet({ expectedOwner: accountId, address: requireSettlement(), abi: settlementAbi, functionName: "closePair", args: [pairId, closeSize6] });
}

export function cancelOrder(accountId: string, orderHash: `0x${string}`, nonce: bigint) {
  if (nonce <= 0n || nonce > (1n << 64n) - 1n) throw new Error("Invalid order nonce");
  return writeWithWallet({ expectedOwner: accountId, address: requireSettlement(), abi: settlementAbi, functionName: "cancelOrder", args: [orderHash, nonce] });
}

export interface ReserveOrderParams {
  order: AvensOrder;
  signature: `0x${string}`;
  amount6: bigint;
}
export function reserveOrder(accountId: string, { order, signature, amount6 }: ReserveOrderParams) {
  return writeWithWallet({
    expectedOwner: accountId, address: requireSettlement(), abi: settlementAbi,
    functionName: "reserveOrder", args: [
      { trader: order.trader, marketId: order.marketId, side: order.side, kind: 0, size6: order.size6, limitPrice18: order.limitPrice18, leverage: order.leverage, maxFeeBps: order.maxFeeBps, nonce: order.nonce, expiry: order.expiry, reduceOnly: false, postOnly: false, ioc: false },
      signature, amount6,
    ],
  });
}

/** Sign the EIP-712 order with the injected browser wallet; never leaves the browser. */
export async function signOrder(accountId: string, order: AvensOrder): Promise<`0x${string}`> {
  requireAccountId(accountId);
  const settlement = requireSettlement();
  if (!(await isOnExpectedNetwork())) throw new Error(`Wallet is not on Avalanche Fuji (${FUJI_CHAIN_ID}). Switch networks and try again.`);
  const account = await getWalletAccount();
  if (!account || account.toLowerCase() !== accountId.toLowerCase()) throw new Error("Connected wallet does not match the action owner");
  const client = injectedWalletClient();
  return client.signTypedData({
    account: account as `0x${string}`,
    domain: orderDomain(settlement, FUJI_CHAIN_ID),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  });
}

/** Rebuild the exact signed order payload from a locally tracked intent. */
export function avensOrderFromIntent(intent: {
  owner: string; marketId: number; isLong: boolean; size: bigint; limitPrice: bigint;
  leverage?: number; nonce: bigint; expiryTs: bigint;
}): AvensOrder {
  return {
    trader: intent.owner as `0x${string}`,
    marketId: intent.marketId,
    side: intent.isLong ? 0 : 1,
    kind: 0,
    size6: intent.size,
    limitPrice18: intent.limitPrice,
    leverage: Math.max(1, Math.min(10, Math.floor(intent.leverage ?? 1))),
    maxFeeBps: 3,
    nonce: intent.nonce,
    expiry: intent.expiryTs,
    reduceOnly: false,
    postOnly: false,
    ioc: false,
  };
}

/** EIP-712 digest of the order — identical to ClobAuth.orderHash on-chain. */
export function orderHash(order: AvensOrder): `0x${string}` {
  return hashTypedData({
    domain: orderDomain(requireSettlement(), FUJI_CHAIN_ID),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  });
}

export interface RawPosition {
  pairId: bigint;
  marketId: number;
  isLong: boolean;
  size: bigint;          // size6
  entryPrice: bigint;    // price18
  margin: bigint;        // collateral6
  unrealizedPnl: bigint; // collateral6
  liquidationPrice: bigint;
}

/**
 * There is no on-chain view that enumerates an owner's pairs, and the indexer
 * that will serve this is not deployed. Returning an empty list would fabricate
 * "no positions", so this always throws until that feed exists.
 */
export async function getPositions(): Promise<RawPosition[]> {
  throw new Error("Position listing is unavailable until the Fuji admission backend and indexer are live");
}
