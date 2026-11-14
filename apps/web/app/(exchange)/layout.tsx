import { Providers } from '@/components/common/Providers';
import { networkFromCookies } from '@/lib/network-server';

export default async function ExchangeLayout({ children }: { children: React.ReactNode }) {
  const network = await networkFromCookies();
  return <Providers network={network}><div role="status" className="bg-primary/10 px-4 py-2 text-center text-xs text-foreground">Preview · Read-only wallet access · Trading and signing remain paused.</div>{children}</Providers>;
}
