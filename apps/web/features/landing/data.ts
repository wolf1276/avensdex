import { DEFAULT_MARKET_SYMBOL } from '@/config';
import type { Feature, NavLink, Partner, Stat, UseCase } from './types';

export const navLinks: NavLink[] = [
  { href: '#home', label: 'Home' },
  { href: '#platform', label: 'The terminal' },
  { href: '#use-cases', label: 'Inside Avensdex' },
  { href: `/trade/${DEFAULT_MARKET_SYMBOL}`, label: 'Open terminal' },
];

// Technologies used by the project, not endorsements or partnerships.
export const partners: Partner[] = [
  { name: 'Avalanche', logo: '/logo.svg' },
  { name: 'TradingView' },
  { name: 'USDC' },
];

export const stats: Stat[] = [
  { value: '1', label: 'Isolated bilaterial market: AVAX-PERP' },
  { value: '2', label: 'Directions. Long or short.' },
  { value: '$0', label: 'Real funds at risk on Fuji' },
];

export const features: Feature[] = [
  { index: '01', title: 'Read the whole market', text: 'Chart tools, a depth book and recent trades. One workspace, without the tab switching.' },
  { index: '02', title: 'Shape your order', text: 'Vanilla limit orders, long and short, capped at 10x leverage. Preview margin and liquidation before you sign.' },
  { index: '03', title: 'Know what you’re trading', text: 'The Fuji deployment stays paused until the owner qualifies and activates it; readiness is verified on-chain before any order is admitted.' },
];

export const useCases: UseCase[] = [
  { title: 'A chart with room to think', description: 'Use TradingView indicators, drawing tools, timeframes and chart styles. The embedded chart needs internet and displays independent reference prices — never venue liquidity or an executable oracle.' },
  { title: 'Depth, without the guesswork', description: 'The book appears only when the venue serves depth at the pinned chain block. No depth is shown — and no reference price is treated as an order book — before the admission backend is live.' },
  { title: 'An order ticket that stays in view', description: 'Choose a direction, size and leverage up to 10x. Orders are signed vanilla limits — reduce-only, post-only, IOC, market and TP/SL are not admitted by the settlement contract. Review margin and liquidation estimates before signing.' },
  { title: 'Your activity, in one place', description: 'Open orders are tracked in this browser and reconciled against chain state. Positions, fills and funding history appear once the admission backend indexes them.' },
  { title: 'Made for the smaller screen, too', description: 'Move between chart, book, ticket and positions on mobile. Dedicated long and short controls bring the order ticket into reach.' },
  { title: 'An honest Fuji validation path', description: 'The exchange runs on Avalanche Fuji C-Chain (43113) against a capped, initially paused AVAX-PERP/USDC deployment. Deposits activate only after owner qualification. Leveraged trading carries risk; no investment return is promised.' },
];
