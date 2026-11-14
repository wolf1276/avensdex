"use client";

import { useState } from "react";
import { AccountBar } from "@/features/trade/components/AccountBar";
import { BottomPanel } from "@/features/trade/components/BottomPanel";
import { MarketHeader } from "@/features/trade/components/MarketHeader";
import { OrderEntry } from "@/features/trade/components/OrderEntry";
import { TradeChart } from "@/features/trade/components/TradeChart";
import type { MarketConfig } from "@/config";

type MobileTab = "chart" | "ticket" | "positions";

export function TradeTerminalGrid({ market }: { market: MarketConfig }) {
  const [mobileTab, setMobileTab] = useState<MobileTab>("chart");
  // `side` is lifted here so the mobile bottom bar can open the ticket pre-set
  // to long/short. OrderEntry falls back to its own state when not controlled.
  const [side, setSide] = useState<"buy" | "sell">("buy");

  const gridClasses = "lg:grid lg:[grid-template-rows:auto_minmax(280px,1fr)_auto] lg:[grid-template-columns:minmax(0,1fr)_360px] lg:[grid-template-areas:'info_ticket'_'chart_ticket'_'pos_ticket']";
  const activeTab = mobileTab;
  const vis = (tab: MobileTab) => activeTab === tab ? "flex" : "hidden";

  const tabs: { key: MobileTab; label: string }[] = [
    { key: "chart", label: "Chart" },
    { key: "ticket", label: "Trade" },
    { key: "positions", label: "Positions" },
  ];

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${gridClasses}`}>
      {/* ── Market header (info) — sticky at the top on mobile ── */}
      <div
        style={{ gridArea: "info" }}
        className="sticky top-0 z-20 lg:static lg:z-auto"
      >
        <MarketHeader market={market} />
        <p role="status" className="border-b border-border bg-background px-4 py-2 text-xs leading-relaxed text-muted-foreground">Fuji validation preview · No active Avensdex liquidity. Order book hidden; trading paused. External chart prices are reference data, not executable quotes.</p>
      </div>

      {/* ── Mobile tab switcher (hidden on desktop) ── */}
      <div className="sticky top-[40px] z-10 flex shrink-0 border-b border-[#2A2A31] bg-[#19191A] lg:hidden">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setMobileTab(t.key)}
            className={`flex-1 py-3 text-[12.5px] font-semibold transition-colors ${
              activeTab === t.key
                ? "text-[#f5f5f5] after:absolute after:bottom-[-1px] after:left-3 after:right-3 after:h-[2px] after:rounded-full after:bg-[#f5f5f5] relative"
                : "text-[#a3a3a3]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Chart ── */}
      <div
        style={{ gridArea: "chart" }}
        className={`${vis("chart")} h-[58dvh] min-h-0 flex-col lg:flex lg:h-full`}
      >
        <TradeChart market={market} />
      </div>

      {/* ── Order ticket ── */}
      <div
        style={{ gridArea: "ticket" }}
        className={`${vis("ticket")} relative flex-col border border-[#2A2A31] bg-[#19191A] pb-[max(16px,env(safe-area-inset-bottom))] lg:flex lg:overflow-y-auto lg:pb-0`}
      >
        <AccountBar />
        <OrderEntry market={market} side={side} setSide={setSide} />
      </div>

      {/* ── Positions / open orders / history ── */}
      <div style={{ gridArea: "pos" }} className={`${vis("positions")} flex-col lg:flex`}>
        <BottomPanel marketId={market.marketId} />
      </div>

      {/* ── Mobile sticky Long/Short bar — jumps to the ticket pre-set ── */}
      {activeTab !== "ticket" && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-2 gap-2 border-t border-[#2A2A31] bg-[#19191A]/95 p-3 backdrop-blur-sm lg:hidden"
          style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
        >
          <button
            onClick={() => { setSide("buy"); setMobileTab("ticket"); }}
            className="rounded-[9px] bg-[#1fae5b] py-3 text-[14px] font-semibold text-white"
          >
            Long / Buy
          </button>
          <button
            onClick={() => { setSide("sell"); setMobileTab("ticket"); }}
            className="rounded-[9px] bg-[#e8716f] py-3 text-[14px] font-semibold text-white"
          >
            Short / Sell
          </button>
        </div>
      )}
    </div>
  );
}
