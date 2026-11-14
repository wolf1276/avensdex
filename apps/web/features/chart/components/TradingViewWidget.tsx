"use client";

import { memo, useLayoutEffect, useId, useRef, useState } from "react";

// Renders TradingView's Advanced Chart (the real widget engine, loaded from
// tv.js). Data, indicators, drawing tools and chart types are all handled by
// TradingView itself, so this works regardless of the viewer's region.

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => { remove?: () => void };
    };
  }
}

const SCRIPT_ID = "tradingview-embed-script";
const SCRIPT_SRC = "https://s3.tradingview.com/tv.js";

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.TradingView?.widget === 'function') return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    const fail = (message: string) => {
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      script.remove();
      scriptPromise = null;
      reject(new Error(message));
    };
    const timeout = setTimeout(() => fail('Chart download timed out. Check your connection and retry.'), 15_000);
    script.onload = () => {
      if (typeof window.TradingView?.widget !== 'function') return fail('Chart script did not initialize. Please retry.');
      clearTimeout(timeout);
      script.onload = script.onerror = null;
      resolve();
    };
    script.onerror = () => fail('Chart download failed. Check your connection and retry.');
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Avensdex dark palette, matched to the order ticket surface.
const BG = "#100e17";
const GRID = "#25252B";
const SCALE_LINE = "#30283e";
const SCALE_TEXT = "#a3a3a3";
const UP = "#1fae5b";
const DOWN = "#e34c4c";

export const TradingViewWidget = memo(function TradingViewWidget({
  symbol,
  interval = "60",
  chartStyle = "1",
}: {
  // REQUIRED. This defaulted to "COINBASE:NEARUSD", so any caller that failed
  // to thread a symbol through charted AVAX under another market's header.
  symbol: string;
  interval?: string;
  chartStyle?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountId = `tv_${useId().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // TradingView needs its DOM attached while disposing; passive cleanup runs after React removes it.
  useLayoutEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    setLoading(true);
    setError(null);
    host.innerHTML = "";
    const inner = document.createElement("div");
    inner.id = mountId;
    inner.style.width = "100%";
    // Keep the time axis and TradingView attribution inside the chart viewport.
    inner.style.height = "100%";
    host.appendChild(inner);

    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let widget: { remove?: () => void } | undefined;
    const frames = new Set<HTMLIFrameElement>();
    const loaded = () => {
      if (!cancelled) { clearTimeout(frameTimer); setError(null); setLoading(false); }
    };
    const failed = () => {
      if (!cancelled) { clearTimeout(frameTimer); setError('Your browser could not load the reference chart. Retry or open it directly.'); setLoading(false); }
    };
    const watchFrames = () => {
      host.querySelectorAll('iframe').forEach(frame => {
        if (frames.has(frame)) return;
        frames.add(frame); frame.title ||= `Reference chart: ${symbol}`;
        frame.addEventListener('load', loaded); frame.addEventListener('error', failed);
      });
    };
    const observer = new MutationObserver(watchFrames);
    observer.observe(host, { childList: true, subtree: true });

    loadScript()
      .then(() => {
        if (cancelled || !window.TradingView) return;
        widget = new window.TradingView.widget({
          autosize: true,
          symbol,
          interval,
          timezone: "Etc/UTC",
          theme: "dark",
          style: chartStyle,
          locale: "en",
          backgroundColor: BG,
          gridColor: GRID,
          toolbar_bg: BG,
          custom_css_url: `${window.location.origin}/tradingview-overrides.css`,
          enable_publishing: false,
          allow_symbol_change: false,
          hide_top_toolbar: true,
          hide_side_toolbar: false,
          hide_legend: false,
          save_image: false,
          withdateranges: false,
          details: false,
          calendar: false,
          container_id: mountId,
          loading_screen: { backgroundColor: BG, foregroundColor: SCALE_TEXT },
          disabled_features: [
            "timeframes_toolbar",
            "header_symbol_search",
            "header_compare",
            "use_localstorage_for_settings",
          ],
          overrides: {
            "paneProperties.background": BG,
            "paneProperties.backgroundType": "solid",
            "paneProperties.vertGridProperties.color": GRID,
            "paneProperties.horzGridProperties.color": GRID,
            "scalesProperties.backgroundColor": BG,
            "scalesProperties.lineColor": SCALE_LINE,
            "scalesProperties.textColor": SCALE_TEXT,
            "mainSeriesProperties.candleStyle.upColor": UP,
            "mainSeriesProperties.candleStyle.downColor": DOWN,
            "mainSeriesProperties.candleStyle.borderUpColor": UP,
            "mainSeriesProperties.candleStyle.borderDownColor": DOWN,
            "mainSeriesProperties.candleStyle.wickUpColor": UP,
            "mainSeriesProperties.candleStyle.wickDownColor": DOWN,
          },
        });
        watchFrames();
        // iframe load is the cross-origin transport boundary; TradingView renders its own data loader inside.
        frameTimer = setTimeout(() => {
          if (!cancelled) { setError('Chart frame did not load. Retry or open the reference chart.'); setLoading(false); }
        }, 15_000);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Chart failed to load");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(frameTimer); observer.disconnect();
      frames.forEach(frame => { frame.removeEventListener('load', loaded); frame.removeEventListener('error', failed); });
      try { widget?.remove?.(); }
      catch { /* A vendor may already have removed its own iframe; never crash the surrounding route. */ }
      finally { host.replaceChildren(); }
    };
  }, [symbol, interval, chartStyle, mountId, retryNonce]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={hostRef} className="h-full w-full" />
      {(loading || error) && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#100e17]">
          {error ? (
            <div className="flex flex-col items-center gap-3">
              <span className="text-xs font-mono text-[#a3a3a3]">Chart unavailable</span>
              <span className="max-w-[260px] text-center text-[11px] text-[#737373]">{error}</span>
              <button
                onClick={() => setRetryNonce((v) => v + 1)}
                className="rounded-[6px] bg-[#100e17] border border-[#443456] px-3 py-1.5 text-[11px] font-medium text-[#f5f5f5] hover:border-[#4a4a4a] transition-colors"
              >
                Retry
              </button>
              <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`} target="_blank" rel="noopener noreferrer"
                className="text-xs text-[#a3a3a3] underline">Open reference chart</a>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 pointer-events-none">
              <div className="w-5 h-5 border-2 border-[#100e17] border-t-[#a3a3a3] rounded-full animate-spin" />
              <span className="text-[#737373] text-xs font-mono">Loading chart…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
