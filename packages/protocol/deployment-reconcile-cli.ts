// Operator CLI/helper for reconciling an EXISTING paused deployment journal.
// RPC reads use the fixed two-provider Fuji reader and are read-only. Reconciliation
// may append status transitions to the local journal; it is not a fully read-only
// operation and never creates, resets, signs, broadcasts or activates anything.
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { avalancheFuji } from 'viem/chains';
import { DeploymentJournal, type DeploymentReader, type DeploymentView } from './deployment.ts';
import { createDeploymentReader } from './deployment-reader.ts';
import { DEPLOYMENT_RPC_URLS } from './deployment-reader-cli.ts';
import { readJson } from './deployment-plan-cli.ts';

export const MAX_DEPLOYMENT_RECONCILE_PATH_LENGTH = 4096;

export interface DeploymentReconcileFiles {
  journalDir: string;
  inputPath: string;
  artifactsPath: string;
  runtimeConfigPath: string;
}

export interface DeploymentReconcileOptions {
  directory: string;
  input: unknown;
  artifacts: unknown;
  expectedRuntimeHashes: unknown;
  confirmations: unknown;
  reader: DeploymentReader;
  now?: number;
}

export function parseDeploymentReconcileArgs(args: readonly string[]): DeploymentReconcileFiles {
  if (args.length !== 4 || args.some(arg => !arg || arg.length > MAX_DEPLOYMENT_RECONCILE_PATH_LENGTH)) {
    throw Error('INVALID_DEPLOYMENT_RECONCILE_ARGS');
  }
  return {
    journalDir: args[0]!,
    inputPath: args[1]!,
    artifactsPath: args[2]!,
    runtimeConfigPath: args[3]!,
  };
}

export function readRuntimeConfig(path: string): { expectedRuntimeHashes: unknown; confirmations: unknown } {
  const value = readJson(path, 'DEPLOYMENT_RECONCILE_CONFIG_UNAVAILABLE');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_DEPLOYMENT_RECONCILE_CONFIG');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('expectedRuntimeHashes') || !keys.includes('confirmations')) {
    throw Error('INVALID_DEPLOYMENT_RECONCILE_CONFIG');
  }
  return { expectedRuntimeHashes: (value as Record<string, unknown>).expectedRuntimeHashes, confirmations: (value as Record<string, unknown>).confirmations };
}

export async function reconcileExistingDeploymentJournal(options: DeploymentReconcileOptions): Promise<DeploymentView> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) throw Error('INVALID_DEPLOYMENT_RECONCILE_TIME');
  const journal = DeploymentJournal.open(options.directory, {
    input: options.input,
    artifacts: options.artifacts,
    expectedRuntimeHashes: options.expectedRuntimeHashes,
    reader: options.reader,
    confirmations: options.confirmations,
    create: false,
  }, now);
  try {
    let view = journal.view();
    const count = journal.plan().transactions.length;
    for (let sequence = 0; sequence < count; sequence++) {
      if (!view.transactions[sequence]?.signed) break;
      if (sequence > 0 && view.transactions[sequence - 1]?.status !== 'confirmed') break;
      view = await journal.reconcile(sequence);
    }
    return view;
  } finally {
    journal.close();
  }
}

// A completed read is not necessarily a reconciled transaction.
export function deploymentReconcileExitCode(view: DeploymentView): 0 | 2 {
  return view.transactions.some(tx => tx.signed && tx.status !== 'confirmed') ? 2 : 0;
}

async function main() {
  const args = parseDeploymentReconcileArgs(process.argv.slice(2));
  const input = readJson(args.inputPath, 'DEPLOYMENT_RECONCILE_INPUT_UNAVAILABLE');
  const artifacts = readJson(args.artifactsPath, 'DEPLOYMENT_RECONCILE_ARTIFACTS_UNAVAILABLE');
  const config = readRuntimeConfig(args.runtimeConfigPath);
  const clients = DEPLOYMENT_RPC_URLS.map(url => createPublicClient({
    chain: avalancheFuji, transport: http(url, { retryCount: 0, timeout: 15_000 }),
  }));
  const reader = await createDeploymentReader(clients[0]!, clients[1]!);
  const view = await reconcileExistingDeploymentJournal({
    directory: args.journalDir,
    input,
    artifacts,
    expectedRuntimeHashes: config.expectedRuntimeHashes,
    confirmations: config.confirmations,
    reader,
    now: Math.floor(Date.now() / 1000),
  });
  console.log(JSON.stringify(view));
  process.exitCode = deploymentReconcileExitCode(view);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = error instanceof Error && /^[A-Z0-9_]{1,120}$/.test(error.message) ? error.message : 'DEPLOYMENT_RECONCILE_FAILED';
    console.error(`Deployment reconcile failed: ${code}. Two-provider RPC reads are read-only; only the local journal may receive status transitions.`);
    process.exitCode = 1;
  });
}
