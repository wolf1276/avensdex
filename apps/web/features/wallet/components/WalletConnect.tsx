"use client";

import { useEffect } from "react";
import { WalletIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useWalletStore } from "@/stores/wallet";
import {
  connectWallet,
  disconnectWallet,
  getWalletAccount,
  isOnExpectedNetwork,
  subscribeWallet,
  walletAvailable,
  FUJI_CHAIN_HEX,
} from "@/lib/evm/wallet";
import { FUJI_CHAIN_ID } from "@/config";
import { shortenAddress } from "@/lib/format";
import { toast } from "sonner";
import { NETWORK_LABEL } from "@/config";

export function WalletConnect() {
  const {
    address,
    connected,
    connecting,
    walletDialogOpen,
    setWalletDialogOpen,
    wrongNetwork,
    setAddress,
    setConnected,
    setConnecting,
    setWrongNetwork,
    disconnect,
  } = useWalletStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    async function refreshWalletState() {
      const addr = await getWalletAccount();
      if (cancelled) return;
      if (addr) {
        setAddress(addr);
        setConnected(true);
        const ok = await isOnExpectedNetwork();
        if (!cancelled) setWrongNetwork(!ok);
      } else {
        setAddress(null);
        setConnected(false);
        setWrongNetwork(false);
      }
    }

    void refreshWalletState().catch(() => {});
    const id = setInterval(() => { void refreshWalletState().catch(() => {}); }, 3_000);

    // Account/chain invalidation is event-driven first: a wallet switching
    // accounts or chains must never leave stale market/account data on screen.
    const unsubscribe = subscribeWallet({
      onAccountsChanged: (accounts) => {
        if (cancelled) return;
        const next = accounts[0];
        setAddress(next ?? null);
        setConnected(!!next);
        setWrongNetwork(false);
        void queryClient.invalidateQueries();
      },
      onChainChanged: (chainId) => {
        if (cancelled) return;
        setWrongNetwork(String(chainId).toLowerCase() !== FUJI_CHAIN_HEX);
        void queryClient.invalidateQueries();
      },
    });
    return () => {
      cancelled = true;
      clearInterval(id);
      unsubscribe();
    };
  }, [setAddress, setConnected, setWrongNetwork, queryClient]);

  async function handleConnect() {
    if (connecting) return;
    setWalletDialogOpen(false);
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setAddress(addr);
      setConnected(true);
      const ok = await isOnExpectedNetwork();
      setWrongNetwork(!ok);
      void queryClient.invalidateQueries();
      if (!ok) toast.warning(`Switch your wallet to ${NETWORK_LABEL} (${FUJI_CHAIN_ID}).`);
      else toast.success("Wallet connected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  if (!connected) {
    const hasInjected = walletAvailable();
    return (
      <Dialog open={walletDialogOpen} onOpenChange={setWalletDialogOpen}>
        <DialogTrigger render={<Button disabled={connecting} className="shrink-0" />}>
          {connecting ? 'Connecting…' : 'Connect Wallet'}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a wallet</DialogTitle>
            <DialogDescription>
              Use the injected browser wallet for Avalanche Fuji. EVM transactions are signed locally in your wallet.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button variant="secondary" className="w-full justify-start" disabled={!hasInjected || connecting}
              onClick={() => void handleConnect()}>
              <WalletIcon data-icon="inline-start" />
              Browser wallet
            </Button>
            {!hasInjected && (
              <p role="status" className="text-sm text-muted-foreground">
                No injected browser wallet detected. Install Core or MetaMask, then reload this page.
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Test funds only. Connecting does not submit a trading order.</p>
        </DialogContent>
      </Dialog>
    );
  }

  async function handleDisconnect() {
    try {
      await disconnectWallet();
      disconnect();
      void queryClient.invalidateQueries();
      toast.success("Wallet disconnected");
    } catch (error) { toast.error(String(error)); }
  }

  return (
    <div className="flex items-center gap-1.5">
      {wrongNetwork && (
        <span className="hidden text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-semibold sm:inline">
          Wrong network
        </span>
      )}
      <button
        onClick={handleDisconnect}
        title={wrongNetwork ? "Wrong network — click to disconnect" : "Click to disconnect"}
        className={`flex shrink-0 items-center rounded-[7px] border bg-[#212128] px-3 py-2 transition-colors group sm:px-[18px] sm:py-[8px] ${
          wrongNetwork ? "border-amber-500/40" : "border-[#2A2A31] hover:border-red-500/40 hover:bg-red-500/5"
        }`}
      >
        {wrongNetwork && (
          <span className="mr-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 sm:hidden" />
        )}
        <span className="font-mono text-[12.5px] text-[#f5f5f5] group-hover:text-red-400 transition-colors sm:text-[14px]">
          {shortenAddress(address!)}
        </span>
      </button>
    </div>
  );
}
