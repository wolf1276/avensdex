"use client";

import { getAddress, type Abi, type EIP1193Provider, type WalletClient } from "viem";
import { FUJI_CHAIN_ID } from "@/config";

export const FUJI_CHAIN_HEX = `0x${FUJI_CHAIN_ID.toString(16)}`;
const PENDING_KEY = "avensdex-pending-transaction-v1";
const CONNECTION_KEY = "avensdex-readonly-wallet-v1";
let optedIn = false;
let revision = 0;
let connectionAttempt = 0;
type InjectedProvider = EIP1193Provider & {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};
export function getInjectedProvider(): InjectedProvider | null {
  if (typeof window === 'undefined') return null;
  const provider = (window as unknown as { ethereum?: InjectedProvider }).ethereum;
  return provider && typeof provider.request === 'function' ? provider : null;
}
function consented() {
  if (typeof window === 'undefined') return false;
  try { return optedIn || window.sessionStorage.getItem(CONNECTION_KEY) === '1'; } catch { return optedIn; }
}
function consent(value: boolean) {
  optedIn = value;
  try { if (value) window.sessionStorage.setItem(CONNECTION_KEY, '1'); else window.sessionStorage.removeItem(CONNECTION_KEY); } catch { /* Memory-only consent if storage is unavailable. */ }
}
function accounts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x0+$/i.test(v))) throw new Error('Wallet returned invalid accounts');
  return value.map(v => getAddress(v));
}
export function walletAvailable(): boolean { return getInjectedProvider() !== null; }

/** No signing client is exposed by this read-only release. */
export function injectedWalletClient(): WalletClient {
  throw new Error('Wallet signing is disabled in this read-only release.');
}
export async function getWalletAccount(): Promise<string | null> {
  const provider = getInjectedProvider();
  if (!provider || !consented()) return null;
  const captured = revision;
  const current = accounts(await provider.request({ method: 'eth_accounts' }));
  if (!consented()) return null;
  if (captured !== revision) throw new Error('Wallet state changed during refresh');
  return current[0] ?? null;
}
/** Explicit user-requested chain change only. Connecting never calls this automatically. */
export async function ensureFujiChain(): Promise<void> {
  const provider = getInjectedProvider(); if (!provider) throw new Error('No browser wallet found.');
  if (await isOnExpectedNetwork()) return;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: FUJI_CHAIN_HEX }] }); }
  catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: FUJI_CHAIN_HEX, chainName: 'Avalanche Fuji C-Chain',
      nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
      rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji-c-chain-rpc.publicnode.com'],
      blockExplorerUrls: ['https://testnet.snowtrace.io'] }] });
  }
}
export async function isOnExpectedNetwork(): Promise<boolean> {
  const provider = getInjectedProvider(); if (!provider) return false;
  const captured = revision;
  try { return String(await provider.request({ method: 'eth_chainId' })).toLowerCase() === FUJI_CHAIN_HEX && captured === revision; } catch { return false; }
}
export async function connectWallet(): Promise<string> {
  const provider = getInjectedProvider(); if (!provider) throw new Error('No browser wallet found. Install Core or MetaMask.');
  const attempt = ++connectionAttempt;
  const requested = accounts(await provider.request({ method: 'eth_requestAccounts' }));
  const current = accounts(await provider.request({ method: 'eth_accounts' }));
  if (attempt !== connectionAttempt) throw new Error('Wallet connection cancelled.');
  if (!requested[0] || requested[0] !== current[0]) throw new Error('Wallet account changed or connection was not approved.');
  consent(true); revision++;
  return current[0];
}
export async function disconnectWallet(): Promise<void> { consent(false); revision++; connectionAttempt++; }
export interface WalletEvents { onAccountsChanged(accounts: string[]): void; onChainChanged(chainId: string): void }
export function subscribeWallet(callback: WalletEvents): () => void {
  const provider = getInjectedProvider(); if (!provider?.on || !provider.removeListener) return () => {};
  const changed = (value: unknown) => {
    revision++; if (!consented()) return;
    let current: string[]; try { current = accounts(value); } catch { current = []; }
    if (!current.length) consent(false);
    callback.onAccountsChanged(current);
  };
  const chain = (value: unknown) => { revision++; if (consented()) callback.onChainChanged(String(value)); };
  provider.on('accountsChanged', changed); provider.on('chainChanged', chain);
  return () => { provider.removeListener?.('accountsChanged', changed); provider.removeListener?.('chainChanged', chain); };
}
export function pendingTransactionHash(): string | null {
  try { return (JSON.parse(localStorage.getItem(PENDING_KEY) || 'null') as { hash?: string } | null)?.hash ?? null; } catch { return null; }
}
export interface WriteSuccess { hash: `0x${string}` }
// shortcut: account access only until durable transaction recovery and the security warning are reviewed.
export async function writeWithWallet(_params: { expectedOwner: string; address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<WriteSuccess> {
  throw new Error('Fuji wallet transactions are disabled in this read-only release. Contracts remain paused.');
}
