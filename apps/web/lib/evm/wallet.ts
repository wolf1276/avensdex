"use client";

import { createWalletClient, custom, getAddress, type Abi, type EIP1193Provider } from "viem";
import { fujiChain } from "./client";
import { FUJI_CHAIN_ID } from "@/config";
import { getNetworkConfig, PRIMARY_NETWORK } from "@/config/networks";

export const FUJI_CHAIN_HEX = `0x${FUJI_CHAIN_ID.toString(16)}`;
const PENDING_KEY = "avensdex-pending-transaction-v1";

type InjectedProvider = EIP1193Provider & {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

export function getInjectedProvider(): InjectedProvider | null {
  // Do not access a wallet provider while the reported MetaMask warning is under review.
  return null;
}

export function walletAvailable(): boolean { return getInjectedProvider() !== null; }

export function injectedWalletClient() {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("No browser wallet found. Install an EIP-1193 wallet such as Core or MetaMask to continue.");
  return createWalletClient({ chain: fujiChain, transport: custom(provider) });
}

export async function getWalletAccount(): Promise<string | null> {
  const provider = getInjectedProvider();
  if (!provider) return null;
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  const account = accounts?.[0];
  return account ? getAddress(account) : null;
}

/** Switch the wallet to Fuji, adding the chain if the wallet does not know it. */
export async function ensureFujiChain(): Promise<void> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("No browser wallet found.");
  const current = ((await provider.request({ method: "eth_chainId" })) as string)?.toLowerCase();
  if (current === FUJI_CHAIN_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: FUJI_CHAIN_HEX }] });
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code !== 4902) throw error;
    const config = getNetworkConfig(PRIMARY_NETWORK);
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: FUJI_CHAIN_HEX, chainName: "Avalanche Fuji C-Chain",
        nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
        rpcUrls: [config.rpcUrl, config.secondaryRpcUrl],
        blockExplorerUrls: [config.explorerUrl],
      }],
    });
  }
}

export async function isOnExpectedNetwork(): Promise<boolean> {
  const provider = getInjectedProvider();
  if (!provider) return false;
  try {
    return ((await provider.request({ method: "eth_chainId" })) as string)?.toLowerCase() === FUJI_CHAIN_HEX;
  } catch { return false; }
}

export async function connectWallet(): Promise<string> {
  throw new Error("Wallet connection is disabled while the reported MetaMask security warning is investigated. Do not bypass the warning.");
}

export async function disconnectWallet(): Promise<void> { /* Account access is revoked inside the wallet; there is nothing to revoke here. */ }

export interface WalletEvents {
  onAccountsChanged(accounts: string[]): void;
  onChainChanged(chainId: string): void;
}
/** Subscribe to injected-wallet invalidation. Returns an unsubscribe function. */
export function subscribeWallet({ onAccountsChanged, onChainChanged }: WalletEvents): () => void {
  const provider = getInjectedProvider();
  if (!provider?.on || !provider.removeListener) return () => {};
  const accounts = (value: unknown) => onAccountsChanged(Array.isArray(value) ? value : []);
  const chain = (value: unknown) => onChainChanged(String(value));
  provider.on("accountsChanged", accounts);
  provider.on("chainChanged", chain);
  return () => {
    provider.removeListener?.("accountsChanged", accounts);
    provider.removeListener?.("chainChanged", chain);
  };
}

export function pendingTransactionHash(): string | null {
  try { return (JSON.parse(localStorage.getItem(PENDING_KEY) || "null") as { hash?: string } | null)?.hash ?? null; } catch { return null; }
}

export interface WriteSuccess { hash: `0x${string}` }

// shortcut: read-only publication until durable unknown-outcome recovery is reviewed.
export async function writeWithWallet(_params: {
  expectedOwner: string;
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}): Promise<WriteSuccess> {
  throw new Error("Fuji wallet transactions are disabled in this read-only release. Contracts remain paused.");
}
