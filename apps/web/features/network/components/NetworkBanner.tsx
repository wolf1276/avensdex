"use client";
import { useVenue } from "@/features/network/useVenue";
export function NetworkBanner() {
  const { data } = useVenue();
  return <div role="status" className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-border bg-secondary px-3 py-2 text-center text-xs text-muted-foreground">
    <span>{data?.ready ? 'Trading available' : 'Trading paused'}</span>
    {!data?.ready && <span>· {data?.reason || "Checking pricing availability…"}</span>}
  </div>;
}
