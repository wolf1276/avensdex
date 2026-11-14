import type { Metadata } from 'next';
import { GeistPixelLine } from 'geist/font/pixel';
import {
  Hero, Manifesto, Pillars, PlatformSection,
  SiteFooter, SiteHeader, SmoothScroll, StatsGrid, UseCases,
} from '@/features/landing';

export const metadata: Metadata = {
  title: 'Avensdex — Find your edge. Keep your flow.',
  description: 'A perpetuals workspace connected to Avalanche Fuji (43113): AVAX-PERP with capped validation, wallet-signed vanilla limit orders and on-chain custody.',
};

export default function Home() {
  return (
    <div className={GeistPixelLine.variable}>
      <SmoothScroll />
      <main className="agent-landing">
        <SiteHeader />
        <Hero />
        <PlatformSection />
        <StatsGrid />
        <Pillars />
        <Manifesto />
        <UseCases />
        <SiteFooter />
      </main>
    </div>
  );
}
