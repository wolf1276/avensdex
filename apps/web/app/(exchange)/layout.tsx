import { Providers } from '@/components/common/Providers';
import { networkFromCookies } from '@/lib/network-server';

export default async function ExchangeLayout({ children }: { children: React.ReactNode }) {
  const network = await networkFromCookies();
  return <Providers network={network}><div role="status" className="bg-amber-950 px-4 py-2 text-center text-xs text-amber-100">Fuji testnet · Read-only release · Contracts paused · Deposits and trading unavailable</div>{children}</Providers>;
}
