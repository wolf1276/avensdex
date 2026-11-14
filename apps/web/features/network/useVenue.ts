"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { CONTRACTS, ASSETS } from "@/config";
interface Readiness { ready: boolean; connected: boolean; reason: string; readyUntil?: number; asOf?: number }

// The server adapter answers 503 with code NOT_CONFIGURED / NOT_READY until the
// paused Fuji deployment is activated; this hook never second-guesses or bypasses that.
export function useVenue() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const update = () => setNow(Math.floor(Date.now() / 1000));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  const query = useQuery({
    queryKey: ["venue-ready", CONTRACTS.settlement, CONTRACTS.oracle, ASSETS.usdc],
    queryFn: async ({ signal }): Promise<Readiness> => {
      if (!CONTRACTS.vault || !CONTRACTS.settlement || !CONTRACTS.oracle || !ASSETS.usdc) {
        return { ready: false, connected: false, reason: "Fuji deployment is not configured on this host" };
      }
      const response = await apiFetch("/api/ready", { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      const data = await response.json();
      const connected = typeof data.ready === 'boolean' && Number.isSafeInteger(data.asOf);
      return { ready: response.ok && data.ready === true, connected, readyUntil: data.readyUntil, asOf: data.asOf,
        reason: !connected ? 'Fuji RPC unavailable — check the deployment configuration'
          : data.ready ? '' : data.code === 'NOT_CONFIGURED' ? 'Fuji deployment is not configured on this host'
            : data.entriesPaused ? 'Venue paused' : data.depositsActive === false ? 'Deposits are not activated'
              : data.activationReady === false ? 'Settlement is not activation-ready'
                : 'Waiting for fresh on-chain oracle prices' };
    }, refetchInterval: 5000, staleTime: 2000, retry: 0,
  });
  let data = query.data;
  if (query.isError) data = { ready: false, connected: false, reason: "Fuji RPC unavailable" };
  else if (data?.ready && (!now || !Number.isSafeInteger(data.readyUntil) || !Number.isSafeInteger(data.asOf)
    || now < data.asOf! || now > data.readyUntil!)) data = { ...data, ready: false, reason: "Oracle readiness expired; waiting for fresh confirmation" };
  return { ...query, data };
}
