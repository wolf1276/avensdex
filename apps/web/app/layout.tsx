import type { Metadata, Viewport } from "next";
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import '@fontsource/geist-mono/400.css';
import "./globals.css";

export const metadata: Metadata = {
  // `|| fallback` (not ??): an EMPTY NEXT_PUBLIC_APP_URL is defined but makes
  // new URL("") throw ERR_INVALID_URL and kill the whole build.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"),
  title: "Avensdex | Fuji Perpetuals",
  description: "AVAX-PERP on Avalanche Fuji (43113) — capped, initially paused deployment validated on testnet with test funds only",
  applicationName: "Avensdex",
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png" },
      { url: "/favicon.ico", sizes: "48x48" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
  },
  openGraph: {
    title: "Avensdex | Fuji Perpetuals",
    description: "AVAX-PERP on Avalanche Fuji (43113), validated on testnet",
    siteName: "Avensdex",
    images: [{ url: "/icon-512.png", width: 512, height: 512 }],
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#19191A",
  width: "device-width",
  initialScale: 1,
  // Allow pinch-zoom for accessibility; iOS input auto-zoom is prevented via a
  // 16px min font-size on inputs in globals.css instead of locking the scale.
  maximumScale: 5,
  // Extend the canvas under the iOS notch / home indicator; pair with safe-area
  // padding utilities (.pt-safe / .pb-safe) so content stays clear of insets.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark h-full" style={{ '--font-poppins': 'Poppins', '--font-geist-mono': 'Geist Mono' } as React.CSSProperties}>
      <body className="min-h-dvh bg-[#19191A] text-[#f5f5f5] antialiased">
        {children}
      </body>
    </html>
  );
}
