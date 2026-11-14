"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface FundingQuote {
  market_id: number; symbol: string;
  price: string | null; price_timestamp: number | null; as_of: number;
  funding_index: string | null; funding_valid_until: number | null; funding_expired: boolean | null;
  funding_rate_per_second_18: string | null;
}

const reasons: Record<string, string> = {
  RATE_EXPIRED: "Published quote expired; no funding accrues",
  RATE_UNAVAILABLE: "Published rate unavailable; no funding accrues",
  ORACLE_STALE: "Oracle stale or future-dated; not accruing",
};

/** Display-only hourly rate in bps; settlement always uses exact integer math. */
function hourlyBps(ratePerSecond18: string | null, price18: string | null): number | null {
  if (ratePerSecond18 === null || price18 === null) return null;
  const rate = BigInt(ratePerSecond18);
  const price = BigInt(price18);
  if (price <= 0n) return null;
  return Number(rate * 3600n * 10000n) / Number(price);
}
const fmtBps = (bps: number | null) =>
  bps === null ? "—" : `${bps >= 0 ? "+" : ""}${bps.toFixed(2)} bps/h`;

export function FundingStatus({ marketId }: { marketId: number }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setNow(Math.floor(Date.now() / 1000));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["funding-quote", marketId],
    queryFn: async ({ signal }): Promise<FundingQuote> => {
      const r = await apiFetch(`/api/markets/${marketId}`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      if (!r.ok) throw new Error("Funding RPC unavailable");
      return r.json();
    }, refetchInterval: 3000, retry: 0,
  });
  const data = query.isError ? undefined : query.data;
  const expired = data?.funding_expired === true || (data?.funding_valid_until != null && now > 0 && data.funding_valid_until <= now);
  const bps = expired ? 0 : hourlyBps(data?.funding_rate_per_second_18 ?? null, data?.price ?? null);
  const reason = query.isError ? "ORACLE_STALE" : !data ? undefined
    : data.funding_valid_until === null ? "RATE_UNAVAILABLE" : expired ? "RATE_EXPIRED" : null;
  const state = query.isError ? "RPC unavailable" : !data ? "Loading…"
    : reason ? (reasons[reason] ?? "Funding unavailable") : bps === 0 ? "Zero rate; no transfer" : "Accruing";
  const direction = reason || bps === null || bps === 0 ? "No current transfer"
    : bps > 0 ? "Longs pay shorts" : "Shorts pay longs";

  return <Dialog>
    <DialogTrigger aria-label="Funding details" className="flex h-full shrink-0 flex-col justify-center gap-0.5 px-2 text-left text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <span className="text-muted-foreground">Funding · Fuji</span>
      <span className="font-mono" role="status">{bps === null ? "—" : fmtBps(bps)}</span>
    </DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Funding details</DialogTitle>
        <DialogDescription>Hourly funding published by the designated publisher; expired quotes accrue nothing. Not APR or promised carry.</DialogDescription>
      </DialogHeader>
      <p role="status">{state}</p>
      {data ? <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt>Accruing rate</dt><dd className="font-mono">{fmtBps(bps)}</dd>
        <dt>Published rate</dt><dd className="font-mono break-all">{data.funding_rate_per_second_18 ?? "Unavailable"} price18/s</dd>
        <dt>Payment direction</dt><dd>{direction}</dd>
        <dt>Funding index</dt><dd className="font-mono break-all">{data.funding_index ?? "Unavailable"}</dd>
        <dt>Chain snapshot</dt><dd className="break-all">{new Date(data.as_of * 1000).toISOString()}</dd>
        <dt>Oracle source time</dt><dd className="break-all">{data.price_timestamp === null ? "Unavailable" : new Date(data.price_timestamp * 1000).toISOString()}</dd>
        <dt>Accrual expiry</dt><dd className="break-all">{data.funding_valid_until === null ? "Unavailable" : new Date(data.funding_valid_until * 1000).toISOString()}</dd>
      </dl> : <p>Funding data unavailable. Check Fuji RPC connectivity; no rate is assumed.</p>}
      <p className="text-sm text-muted-foreground">Payments settle hourly-epoch checkpoints and are capped by payer collateral; either counterparty can close the pair at the on-chain oracle price. A published quote can survive an outage without accruing once expired.</p>
    </DialogContent>
  </Dialog>;
}
