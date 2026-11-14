"use client";
import { useEffect } from "react";
import { useMarketStore } from "@/stores/market";
import { getOraclePrice } from "@/lib/evm/oracle";
import { fetchOrderBook, fetchRecentTrades } from "@/lib/market/matcher";
import { ACTIVE_MARKETS, PRICE_PRECISION, type MarketConfig } from "@/config";
import { apiFetch } from "@/lib/api";

export function MarketDataProvider({ market, children }: { market: MarketConfig; children: React.ReactNode }) {
  useEffect(() => {
    let stopped = false, busy = false, bookBusy = false;
    const bookController = new AbortController();
    // Depth must not wait for oracle, trade-history or statistics RPCs.
    async function pollBook() {
      if (bookBusy || stopped || document.visibilityState === 'hidden') return;
      bookBusy = true;
      try {
        const book = await fetchOrderBook(market.marketId, bookController.signal);
        if (!stopped) useMarketStore.getState().setOrderBook(market.marketId, book);
      } finally { bookBusy = false; }
    }
    async function poll() {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const [, trades, statsResponse] = await Promise.all([
          Promise.all(Object.values(ACTIVE_MARKETS).map(async m => {
            const oracle = await getOraclePrice(m.marketId).catch(() => null);
            if (!stopped) useMarketStore.getState().setMarkPrice(m.marketId, oracle?.price ?? 0n, oracle?.timestamp);
          })),
          fetchRecentTrades(market.marketId), apiFetch(`/api/markets/${market.marketId}`),
        ]);
        if (stopped) return;
        const store = useMarketStore.getState(); store.setTrades(market.marketId, trades);
        if (statsResponse.ok) {
          const s = await statsResponse.json();
          if (!stopped && s.last_price !== null && s.volume !== null && s.long_open_interest !== null && s.short_open_interest !== null) {
            store.setMarketStats(market.marketId, { lastPrice: BigInt(s.last_price), volume: BigInt(s.volume), longOI: BigInt(s.long_open_interest), shortOI: BigInt(s.short_open_interest) });
          }
        }
      } catch { /* Leave missing venue data unavailable, never substitute spot execution prices. */ }
      finally { busy = false; }
    }
    // Spot ticker is presentation-only (24h statistics), never the settlement mark.
    async function ticker() {
      try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${market.priceSourceSymbol}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
        if (!r.ok) return;
        const t = await r.json(); if (stopped) return;
        const high = Number(t.highPrice), low = Number(t.lowPrice), change = Number(t.priceChangePercent), last = Number(t.lastPrice);
        if (![high, low, change].every(Number.isFinite)) return;
        const store = useMarketStore.getState(); store.setPriceChangePct(market.marketId, change);
        store.setTicker24h(market.marketId, {
          highPrice: BigInt(Math.round(high * Number(PRICE_PRECISION))), lowPrice: BigInt(Math.round(low * Number(PRICE_PRECISION))), changePct: change,
          referencePrice: Number.isFinite(last * Number(PRICE_PRECISION)) && last > 0 ? BigInt(Math.round(last * Number(PRICE_PRECISION))) : undefined,
          observedAt: Date.now(),
        });
      } catch { /* External reference statistics are optional. */ }
    }
    const refreshBook = () => { void pollBook(); };
    void pollBook(); void poll(); void ticker();
    const bookTimer = setInterval(pollBook, 1000), timer = setInterval(poll, 3000), tickerTimer = setInterval(ticker, 30000);
    document.addEventListener('visibilitychange', refreshBook);
    return () => {
      stopped = true; bookController.abort();
      clearInterval(bookTimer); clearInterval(timer); clearInterval(tickerTimer);
      document.removeEventListener('visibilitychange', refreshBook);
    };
  }, [market.marketId, market.oracleSymbol, market.priceSourceSymbol]);
  return <>{children}</>;
}
