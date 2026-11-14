"use client";

import { useState, useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { MarketConfig, PRICE_PRECISION, ASSETS, NETWORK_LABEL } from "@/config";
import { buildOrderIntent } from "@/lib/market/order-intent";
import { submitOrder } from "@/lib/market/matcher";
import { useVenue } from "@/features/network/useVenue";
import { parseTokenAmount, parsePrice } from "@/lib/evm/units";
import { useLocalOrders } from "@/stores/orders";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBalance, getAccountHealth } from "@/lib/evm/contracts";
import { amountToHuman, formatMarketPrice, formatMarketUsd, priceToHuman, toPriceInput } from "@/lib/format";
import { isOnExpectedNetwork } from "@/lib/evm/wallet";
import { calcLiqPrice } from "@/lib/math";
import { UsdcLogo, logoFor } from "@/components/common/AssetLogos";
import { Shuffle } from "lucide-react";

/* ── Icons ── */

/* ── Main OrderEntry ── */
export function OrderEntry({
  market,
  side: sideProp,
  setSide: setSideProp,
}: {
  market: MarketConfig;
  /** Optional controlled side — lets the mobile bottom bar preset long/short. */
  side?: "buy" | "sell";
  setSide?: (v: "buy" | "sell") => void;
}) {
  const { address, connected, connecting, setWrongNetwork, setWalletDialogOpen } =
    useWalletStore();
  const queryClient = useQueryClient();
  const { data: venue } = useVenue();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const localOrders = useLocalOrders((s) => s.orders);
  const rawMarkPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const book = useMarketStore((s) => s.orderBooks[market.marketId]);
  const selectedPrice = useMarketStore((s) => s.selectedPrice[market.marketId]);

  const [sideState, setSideState] = useState<"buy" | "sell">("buy");
  const side = sideProp ?? sideState;
  const setSide = setSideProp ?? setSideState;
  // Only the vanilla limit order the settlement contract admits exists.
  const [size, setSize] = useState("");
  const [sizeInQuote, setSizeInQuote] = useState(false);
  const [limitPrice, setLimitPrice] = useState("");

  const sanitizeNumericInput = (val: string): string => {
    // Allow only digits and a single decimal point; strip leading zeros
    const cleaned = val.replace(/[^0-9.]/g, "").replace(/^0+(\d)/, "$1");
    const parts = cleaned.split(".");
    return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
  };
  const [leverage, setLeverage] = useState(3);
  const [loading, setLoading] = useState(false);
  const [fastPoll, setFastPoll] = useState(false);

  // Leverage cap always follows the market config (which mirrors the on-chain
  // engine limits) — degen mode must not advertise leverage the chain rejects.
  const maxLev = Math.round(market.maxLeverageBps / 10000);
  const effectiveLeverage = Math.min(leverage, maxLev);
  const levMarks = [1, 2, 5, 10, 25, 50, maxLev].filter(
    (v, i, arr) => v >= 1 && v <= maxLev && arr.indexOf(v) === i
  );

  // Picking a price in the order book / trades feed loads it as the limit price.
  useEffect(() => {
    if (selectedPrice != null && selectedPrice > 0) {
      queueMicrotask(() => setLimitPrice(toPriceInput(market, selectedPrice)));
    }
  }, [selectedPrice, market]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: fastPoll ? 2_000 : 10_000,
  });

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!),
    enabled: !!address && connected,
    refetchInterval: fastPoll ? 2_000 : 10_000,
  });

  // Available to trade = free collateral (balance minus locked margin).
  // Falls back to raw vault balance when no positions exist yet.
  const availableToTrade: bigint = health?.freeCollateral ?? balance ?? 0n;

  // ── Live mid price: oracle mark → orderbook mid → fallback 0 ───────────────
  const midPriceHuman: number | null = (() => {
    if (rawMarkPrice && rawMarkPrice > 0n) return priceToHuman(rawMarkPrice);
    if (book?.asks[0] && book?.bids[0]) {
      return (parseFloat(book.asks[0].price) + parseFloat(book.bids[0].price)) / 2;
    }
    return null;
  })();

  const sizeNum = parseFloat(size) || 0;
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const baseSymbol = market.baseAsset;
  const sizeUnit = sizeInQuote ? market.quoteAsset : baseSymbol;
  const midDisplay = midPriceHuman !== null ? formatMarketPrice(market, midPriceHuman) : "—";

  const execPrice = limitPriceNum;
  const baseSizeNum = sizeInQuote && execPrice > 0 ? sizeNum / execPrice : sizeNum;

  const orderValue = baseSizeNum > 0 && execPrice > 0
    ? (baseSizeNum * execPrice).toFixed(2)
    : "0.00";
  const marginRequired = baseSizeNum > 0 && execPrice > 0
    ? (baseSizeNum * execPrice / effectiveLeverage).toFixed(2)
    : "0.00";

  // Estimated liquidation price
  const liqPriceDisplay = (() => {
    if (baseSizeNum <= 0 || execPrice <= 0) return "—";
    const entryRaw = BigInt(Math.round(execPrice * Number(PRICE_PRECISION)));
    const liq = calcLiqPrice(
      side === "buy",
      entryRaw,
      effectiveLeverage,
      market.maintenanceMarginBps
    );
    if (liq <= 0n) return "—";
    return formatMarketUsd(market, liq);
  })();

  function handleConnect() {
    if (!connecting) setWalletDialogOpen(true);
  }

  async function handleSubmit() {
    if (!venue?.ready) { toast.error(venue?.reason || "Fuji venue is not ready"); return; }
    if (!address || !connected) { toast.error("Connect your wallet first"); return; }
    // Re-check live in case the wallet switched networks after connecting
    const onCorrectNetwork = await isOnExpectedNetwork();
    if (!onCorrectNetwork) {
      setWrongNetwork(true);
      toast.error(`Wallet is not on Avalanche Fuji — switch to ${NETWORK_LABEL} and try again.`);
      return;
    }
    setWrongNetwork(false);
    if (!size || sizeNum <= 0) { toast.error("Enter a valid size"); return; }
    if (execPrice <= 0) {
      toast.error("Enter a limit price"); return;
    }
    if (sizeInQuote && baseSizeNum <= 0) {
      toast.error("Enter a limit price to convert the order size");
      return;
    }

    // Self-trade heads-up: the matcher never matches two orders from the same
    // wallet, so an order that only crosses the user's own resting order will
    // sit unfilled until a different wallet takes the other side.
    const wouldSelfCross = localOrders.some((o) => {
      if (o.status !== "pending" || o.owner !== address || o.marketId !== market.marketId) return false;
      if (o.isLong === (side === "buy")) return false;
      const restingPrice = priceToHuman(o.limitPrice);
      return side === "buy" ? limitPriceNum >= restingPrice : limitPriceNum <= restingPrice;
    });
    if (wouldSelfCross) {
      toast.warning(
        "This order crosses your own resting order. Self-matches are skipped — it will only fill against another wallet."
      );
    }

    // Client-side margin check — prevents orders that would fail on-chain settlement
    const marginRequiredNum = parseFloat(marginRequired);
    if (marginRequiredNum > 0 && availableToTrade !== undefined) {
      const availableHuman = amountToHuman(availableToTrade);
      if (marginRequiredNum > availableHuman) {
        toast.error(
          `Insufficient balance — $${marginRequiredNum.toFixed(2)} required, $${availableHuman.toFixed(2)} available. Deposit more collateral or reduce size.`
        );
        return;
      }
    }

    setLoading(true);
    try {
      if (!rawMarkPrice || rawMarkPrice <= 0n) throw new Error("Fresh on-chain oracle price required");
      const rawPrice = parsePrice(limitPrice);
      const rawSize = sizeInQuote
        ? parseTokenAmount(size) * PRICE_PRECISION / rawPrice
        : parseTokenAmount(size);

      const intent = buildOrderIntent({
        owner: address,
        marketId: market.marketId,
        isLong: side === "buy",
        size: rawSize,
        limitPrice: rawPrice,
        leverage: effectiveLeverage,
        ttlSeconds: 3600,
      });
      const result = await submitOrder(intent);
      if (result.ok) {
        addOrder(intent);
        toast.success(`Limit ${side} order submitted for wallet signature`);
        // Immediately refetch all user-facing data and poll fast for 30s to catch on-chain settlement
        queryClient.invalidateQueries({ queryKey: ["balance", address] });
        queryClient.invalidateQueries({ queryKey: ["health", address] });
        queryClient.invalidateQueries({ queryKey: ["fills", address] });
        queryClient.invalidateQueries({ queryKey: ["positions", address] });
        setFastPoll(true);
        setTimeout(() => setFastPoll(false), 30_000);
      } else {
        toast.error(result.error ?? "Order rejected");
      }
      setSize("");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  const rowCls = "flex justify-between items-center text-[12px] text-[#a3a3a3]";
  const valCls = "text-[#737373] font-mono";

  return (
    <div className="relative flex flex-col">
      <div className="flex flex-col gap-[10px] p-3">
        {/* Long / Short */}
        <div className="grid grid-cols-2 rounded-[9px] overflow-hidden bg-[#212128] border border-[#334155]">
          <button
            onClick={() => setSide("buy")}
            className={`py-[9px] text-center text-[12.5px] font-semibold transition-colors ${
              side === "buy" ? "bg-[#1fae5b] text-white" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
            }`}
          >
            Long/Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className={`py-[9px] text-center text-[12.5px] font-semibold transition-colors ${
              side === "sell" ? "bg-[#e8716f] text-white" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
            }`}
          >
            Short/Sell
          </button>
        </div>

        {/* Order type: only vanilla limit orders exist on Fuji (kind=0). */}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(116px,1fr)] gap-2">
          <div className="grid h-[36px] grid-cols-2 rounded-[8px] bg-[#212128] p-[2px]">
            <button
              type="button"
              className="rounded-[6px] text-[11.5px] font-bold text-[#4b5563] cursor-not-allowed"
              disabled
              title="Market orders are not available — the settlement contract admits vanilla limit orders only"
            >
              Market
            </button>
            <div
              aria-current="true"
              className="grid place-items-center rounded-[6px] border border-[#46d985] bg-[#24332c] text-[11.5px] font-bold text-[#46d985]"
            >
              Limit
            </div>
          </div>
          <div className="flex h-[36px] min-w-0 items-center justify-end gap-2 rounded-[8px] bg-[#212128] px-3">
            <span className="font-mono text-[12.5px] font-medium text-[#8f98aa]">$</span>
            <input
              className="min-w-0 flex-1 bg-transparent text-right font-mono text-[12.5px] font-medium text-[#f5f5f5] outline-none placeholder:text-[#737373]"
              placeholder={midDisplay === "—" ? "0.0000" : midDisplay}
              value={limitPrice}
              onChange={(e) => setLimitPrice(sanitizeNumericInput(e.target.value))}
              aria-label="Limit price"
            />
            <span className="rounded-[5px] bg-[#2a2a31] px-2 py-[4px] text-[10.5px] font-semibold text-[#737373]">
              LIMIT
            </span>
          </div>
        </div>

        {/* Account info */}
        <div className={rowCls}>
          <span>Available to Trade</span>
          <span className={valCls}>
            {connected && (balance !== undefined || health !== undefined)
              ? `$${amountToHuman(availableToTrade).toFixed(2)}`
              : "—"}
          </span>
        </div>
        <div className={rowCls}>
          <span>Position</span>
          <span className={valCls}>—</span>
        </div>

        {/* Order size field */}
        <div className="bg-[#212128] border border-[#334155] rounded-[9px] p-2 flex flex-col gap-1">
          <div className="flex items-center justify-between text-[12px] text-[#a3a3a3]">
            <div className="flex items-center gap-[5px]">
              <span>Order Size</span>

            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <input
              className="flex-1 bg-transparent border-0 outline-none text-[#f5f5f5] font-mono text-[17px] font-medium text-right w-full"
              placeholder="0"
              value={size}
              onChange={(e) => setSize(sanitizeNumericInput(e.target.value))}
            />
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setSizeInQuote((v) => !v)}
              className="flex items-center gap-1.5 px-2 py-[3px] bg-[#212128] border border-[#334155] rounded-[6px] text-[#f5f5f5] text-[12px] font-medium transition-colors hover:border-[#475569]"
              title="Toggle order size denomination"
            >
              {sizeInQuote ? <UsdcLogo size={15} /> : logoFor(baseSymbol, 15)}
              {sizeUnit}
              <Shuffle size={13} className="text-[#a3a3a3]" />
            </button>
            <span className="font-mono text-[11px] text-[#737373]">
              ${sizeNum > 0 && execPrice > 0 ? (baseSizeNum * execPrice).toFixed(2) : "0.00"}
            </span>
          </div>
        </div>

        {/* Order leverage — inline slider */}
        <div className="px-[2px] py-[2px]">
          <div className="flex items-center justify-between mb-[7px]">
            <span className="flex items-center gap-[6px] text-[12px] text-[#a3a3a3]">
              Order Leverage
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 7h8M8 12h2M12 12h2M16 12h.01M8 16h2M12 16h2M16 16h.01" />
              </svg>
            </span>
            <span className="font-mono text-[14px] font-medium text-[#f5f5f5]">{effectiveLeverage}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={maxLev}
            step={1}
            value={effectiveLeverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full h-[4px] cursor-pointer accent-[#f5f5f5]"
            aria-label="Order leverage"
          />
          <div className="flex justify-between font-mono text-[10.5px] text-[#737373] mt-[6px]">
            {levMarks.map((m) => (
              <span
                key={m}
                className={effectiveLeverage === m ? "text-[#f5f5f5]" : ""}
              >
                {m}x
              </span>
            ))}
          </div>
        </div>

        {/* Order flags: reduce-only, post-only, IOC and TP/SL are not admitted by the settlement contract. */}

        {/* Place order button */}
        {!connected ? (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full py-[13px] rounded-[9px] text-[13.5px] font-semibold text-[#19191A] transition-colors disabled:opacity-50"
            style={{ background: "#f5f5f5", letterSpacing: ".01em" }}
            onMouseOver={(e) => (e.currentTarget.style.background = "#e5e7eb")}
            onMouseOut={(e) => (e.currentTarget.style.background = "#f5f5f5")}
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={loading || !venue?.ready || !rawMarkPrice}
            title={!venue?.ready ? venue?.reason : undefined}
            className={`w-full py-[13px] rounded-[9px] text-[13.5px] font-semibold text-white transition-colors disabled:opacity-50 ${
              side === "buy"
                ? "bg-[#1fae5b] hover:brightness-110"
                : "bg-[#e8716f] hover:brightness-110"
            }`}
          >
            {!venue?.ready ? "Venue not ready" : loading
              ? "Placing…"
              : parseFloat(marginRequired) > 0 && parseFloat(marginRequired) > amountToHuman(availableToTrade)
              ? "Insufficient Balance"
              : `Place ${side === "buy" ? "Long" : "Short"} Limit Order`}
          </button>
        )}

        {/* Order summary */}
        <div className="flex flex-col gap-1.5 rounded-[9px] bg-[#212128] p-3">
          <div className={rowCls}>
            <span>Limit Price</span>
            <span className="font-mono text-[#f5f5f5]">
              {execPrice > 0 ? formatMarketUsd(market, execPrice) : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span>Est. Liquidation Price</span>
            <span className={`font-mono ${liqPriceDisplay !== "—" ? "text-amber-400" : "text-[#f5f5f5]"}`}>
              {liqPriceDisplay}
            </span>
          </div>
          <div className={rowCls}>
            <span>Order Value</span>
            <span className="font-mono text-[#f5f5f5]">${orderValue}</span>
          </div>
          <div className={rowCls}>
            <span>Margin Required</span>
            <span className="font-mono text-[#f5f5f5]">${marginRequired}</span>
          </div>
          <div className={rowCls}>
            <span className="flex items-center gap-[5px]">
              Fees
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
            </span>
            <span className="font-mono text-[#f5f5f5]">
              0.03% per side
            </span>
          </div>
        </div>
      </div>

    </div>
  );
}
