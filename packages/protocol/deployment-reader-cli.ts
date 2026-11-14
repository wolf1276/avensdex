// Fixed-endpoint read-only deployment inspection. No signer, retry, broadcast or write method.
import { pathToFileURL } from 'node:url';
import { avalancheFuji } from 'viem/chains';
import { createPublicClient, http } from 'viem';
import { createDeploymentReader } from './deployment-reader.ts';
import type { DeploymentReader } from './deployment.ts';

export const DEPLOYMENT_RPC_URLS = [
  'https://api.avax-test.network/ext/bc/C/rpc',
  'https://avalanche-fuji-c-chain-rpc.publicnode.com',
] as const;

export type DeploymentReaderCommand =
  | { method: 'getCanonicalHead' }
  | { method: 'getCanonicalBlockHash'; block: string }
  | { method: 'getTransaction'; hash: string }
  | { method: 'getReceipt'; hash: string }
  | { method: 'getCode'; address: string; block: string };

export function parseDeploymentReaderArgs(args: readonly string[]): DeploymentReaderCommand {
  const [command, ...operands] = args;
  if (command === 'head' && operands.length === 0) return { method: 'getCanonicalHead' };
  if (command === 'block' && operands.length === 1) return { method: 'getCanonicalBlockHash', block: operands[0]! };
  if (command === 'transaction' && operands.length === 1) return { method: 'getTransaction', hash: operands[0]! };
  if (command === 'receipt' && operands.length === 1) return { method: 'getReceipt', hash: operands[0]! };
  if (command === 'code' && operands.length === 2) return { method: 'getCode', address: operands[0]!, block: operands[1]! };
  throw Error('INVALID_DEPLOYMENT_READER_ARGS');
}

export function runDeploymentReaderCommand(reader: DeploymentReader, command: DeploymentReaderCommand): Promise<unknown> {
  switch (command.method) {
    case 'getCanonicalHead': return reader.getCanonicalHead();
    case 'getCanonicalBlockHash': return reader.getCanonicalBlockHash(command.block);
    case 'getTransaction': return reader.getTransaction(command.hash);
    case 'getReceipt': return reader.getReceipt(command.hash);
    case 'getCode': return reader.getCode(command.address, command.block);
  }
}

async function main() {
  const command = parseDeploymentReaderArgs(process.argv.slice(2));
  const clients = DEPLOYMENT_RPC_URLS.map(url => createPublicClient({
    chain: avalancheFuji, transport: http(url, { retryCount: 0, timeout: 15_000 }),
  }));
  const reader = await createDeploymentReader(clients[0]!, clients[1]!);
  console.log(JSON.stringify(await runDeploymentReaderCommand(reader, command)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Deployment read failed. Check the fixed Fuji endpoints and read-only arguments; no transaction was sent.');
    process.exitCode = 1;
  });
}
