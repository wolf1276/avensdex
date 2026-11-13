import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournaledMatcher } from '../../packages/clob/journal.ts';
import { startMarketData } from './market-data.ts';

async function main() {
  const directory = process.env.CLOB_JOURNAL_DIR, args = process.argv.slice(2);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (!directory || !isAbsolute(directory)) throw Error('ABSOLUTE_EXTERNAL_JOURNAL_REQUIRED');
  const location = relative(root, directory);
  if (!(location.startsWith(`..${sep}`) || isAbsolute(location))) throw Error('JOURNAL_MUST_STAY_OUTSIDE_REPOSITORY');
  if (args.length > 1 || (args.length === 1 && args[0] !== '--create')) throw Error('INVALID_ARGUMENTS');
  // Read-only until genuine Fuji settlement/deployment verification and authenticated admission exist.
  const journal = JournaledMatcher.open(directory, { chainId: 43113, marketId: 1, settlementContract: null }, args[0] === '--create');
  let service;
  try { service = await startMarketData(journal, Number(process.env.CLOB_PORT ?? '8787')); }
  catch (error) { journal.close(); throw error; }
  console.log(JSON.stringify({ url: `http://127.0.0.1:${service.port}`, chainId: 43113, orderAdmission: 'unavailable', settlement: 'unavailable' }));
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    try { await service.close(); journal.close(); } catch { process.exitCode = 1; }
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
main().catch(() => {
  console.error('CLOB startup refused. Inspect the explicit configuration/journal/lock; never reset unknown state.'); process.exitCode = 1;
});
