// Read-only Fuji RPC adapter for DeploymentJournal. No signer, wallet, retry or submission authority.
import {
  TransactionNotFoundError, TransactionReceiptNotFoundError,
  type Hex, type PublicClient,
} from 'viem';
import { FUJI_CHAIN_ID, type DeploymentReader } from './deployment.ts';

const MAX_BLOCK = (1n << 64n) - 1n;
const MAX_VALUE = (1n << 128n) - 1n;
const MAX_FEE = (1n << 128n) - 1n;
const MAX_GAS = 30_000_000n;
const MAX_HEAD_AGE = 120n;

export interface DeploymentReaderOptions { now?: () => number }

function hash32(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/i.test(value)) throw Error('INVALID_RPC_HASH');
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0+$/i.test(value)) throw Error('INVALID_RPC_ADDRESS');
  return value.toLowerCase() as Hex;
}
function optionalAddress(value: unknown): Hex | null {
  return value === null || value === undefined ? null : address(value);
}
function quantity(value: unknown, max: bigint, zero = false): bigint {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) n = BigInt(value);
  else throw Error('INVALID_RPC_QUANTITY');
  if (n < 0n || n > max || (!zero && n === 0n)) throw Error('RPC_QUANTITY_BOUNDS');
  return n;
}
function blockNumber(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) throw Error('INVALID_READER_BLOCK');
  const n = BigInt(value);
  if (n > MAX_BLOCK) throw Error('INVALID_READER_BLOCK');
  return n;
}
function block(value: unknown) {
  if (!value || typeof value !== 'object') throw Error('INVALID_RPC_BLOCK');
  const raw = value as Record<string, unknown>;
  return { number: quantity(raw.number, MAX_BLOCK, true), hash: hash32(raw.hash), timestamp: quantity(raw.timestamp, MAX_BLOCK, true) };
}
function code(value: unknown): Hex {
  if (value === undefined || value === null) return '0x';
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw Error('INVALID_RPC_CODE');
  return value.toLowerCase() as Hex;
}
function transaction(value: unknown, requested: Hex) {
  if (!value || typeof value !== 'object') throw Error('INVALID_RPC_TRANSACTION');
  const raw = value as Record<string, unknown>;
  if (raw.type !== 'eip1559') throw Error('RPC_TRANSACTION_TYPE');
  if (quantity(raw.chainId, MAX_BLOCK) !== BigInt(FUJI_CHAIN_ID)) throw Error('RPC_TRANSACTION_CHAIN');
  const hash = hash32(raw.hash);
  if (hash !== requested) throw Error('RPC_TRANSACTION_HASH');
  if (typeof raw.input !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.input)) throw Error('INVALID_RPC_INPUT');
  return {
    hash, chainId: FUJI_CHAIN_ID, from: address(raw.from), to: optionalAddress(raw.to),
    nonce: quantity(raw.nonce, MAX_BLOCK, true).toString(),
    value: quantity(raw.value, MAX_VALUE, true).toString(),
    input: raw.input.toLowerCase() as Hex,
    gas: Number(quantity(raw.gas, MAX_GAS)),
    maxFeePerGas: quantity(raw.maxFeePerGas, MAX_FEE).toString(),
    maxPriorityFeePerGas: quantity(raw.maxPriorityFeePerGas, MAX_FEE, true).toString(),
  };
}
function receipt(value: unknown, requested: Hex) {
  if (!value || typeof value !== 'object') throw Error('INVALID_RPC_RECEIPT');
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  if (status !== 'success' && status !== 'reverted') throw Error('INVALID_RPC_RECEIPT_STATUS');
  const transactionHash = hash32(raw.transactionHash);
  if (transactionHash !== requested) throw Error('RPC_RECEIPT_HASH');
  const to = optionalAddress(raw.to), contractAddress = optionalAddress(raw.contractAddress);
  if (to !== null && contractAddress !== null) throw Error('RPC_RECEIPT_CONTRACT');
  return {
    transactionHash, status,
    blockNumber: quantity(raw.blockNumber, MAX_BLOCK, true).toString(),
    blockHash: hash32(raw.blockHash),
    from: address(raw.from), to, contractAddress,
    gasUsed: quantity(raw.gasUsed, MAX_GAS, true).toString(),
  };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function settled<T>(result: PromiseSettledResult<T>, missing: (error: unknown) => boolean): T | null {
  if (result.status === 'fulfilled') return result.value;
  if (missing(result.reason)) return null;
  throw result.reason;
}

export async function createDeploymentReader(primary: PublicClient, secondary: PublicClient,
  options: DeploymentReaderOptions = {}): Promise<DeploymentReader> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  if (typeof now !== 'function') throw Error('INVALID_READER_CLOCK');
  const providers = [primary, secondary] as const;
  async function verifyChains() {
    const chains = await Promise.all(providers.map(provider => provider.getChainId()));
    if (chains[0] !== FUJI_CHAIN_ID || chains[1] !== FUJI_CHAIN_ID) throw Error('DEPLOYMENT_RPC_CHAIN_MISMATCH');
  }
  async function pinned(number: bigint) {
    const [leftRaw, rightRaw] = await Promise.all(providers.map(provider => provider.getBlock({ blockNumber: number })));
    const left = block(leftRaw), right = block(rightRaw);
    if (left.number !== number || right.number !== number || left.hash !== right.hash || left.timestamp !== right.timestamp) {
      throw Error('RPC_BLOCK_DISAGREEMENT');
    }
    return left;
  }
  await verifyChains();
  return Object.freeze({
    async getTransaction(txHash: string) {
      await verifyChains();
      const requested = hash32(txHash);
      const results = await Promise.allSettled(providers.map(provider => provider.getTransaction({ hash: requested })));
      const left = settled(results[0]!, error => error instanceof TransactionNotFoundError);
      const right = settled(results[1]!, error => error instanceof TransactionNotFoundError);
      if (left === null && right === null) return null;
      if (left === null || right === null) throw Error('RPC_TRANSACTION_DISAGREEMENT');
      const a = transaction(left, requested), b = transaction(right, requested);
      if (!same(a, b)) throw Error('RPC_TRANSACTION_DISAGREEMENT');
      return a;
    },
    async getReceipt(txHash: string) {
      await verifyChains();
      const requested = hash32(txHash);
      const results = await Promise.allSettled(providers.map(provider => provider.getTransactionReceipt({ hash: requested })));
      const left = settled(results[0]!, error => error instanceof TransactionReceiptNotFoundError);
      const right = settled(results[1]!, error => error instanceof TransactionReceiptNotFoundError);
      if (left === null && right === null) return null;
      if (left === null || right === null) throw Error('RPC_RECEIPT_DISAGREEMENT');
      const a = receipt(left, requested), b = receipt(right, requested);
      if (!same(a, b)) throw Error('RPC_RECEIPT_DISAGREEMENT');
      return a;
    },
    async getCanonicalHead() {
      await verifyChains();
      const [leftRaw, rightRaw] = await Promise.all(providers.map(provider => provider.getBlock({ blockTag: 'latest' })));
      const left = block(leftRaw), right = block(rightRaw);
      if (left.number === right.number && left.hash !== right.hash) throw Error('RPC_HEAD_DISAGREEMENT');
      const min = left.number <= right.number ? left : right;
      const observed = await pinned(min.number);
      if (observed.hash !== min.hash || observed.timestamp !== min.timestamp) throw Error('RPC_HEAD_DISAGREEMENT');
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0) throw Error('INVALID_READER_CLOCK');
      const currentBig = BigInt(current);
      if (observed.timestamp > currentBig) throw Error('RPC_HEAD_FUTURE');
      if (currentBig - observed.timestamp > MAX_HEAD_AGE) throw Error('RPC_HEAD_STALE');
      if ((await pinned(min.number)).hash !== observed.hash) throw Error('RPC_HEAD_CHANGED');
      return { number: min.number.toString(), hash: observed.hash };
    },
    async getCanonicalBlockHash(number: string) {
      const requested = blockNumber(number);
      await verifyChains();
      const [leftRaw, rightRaw] = await Promise.all(providers.map(provider => provider.getBlock({ blockNumber: requested })));
      const left = block(leftRaw), right = block(rightRaw);
      if (left.number !== requested || right.number !== requested || left.hash !== right.hash) throw Error('RPC_BLOCK_DISAGREEMENT');
      return left.hash;
    },
    async getCode(addressInput: string, number: string) {
      const target = address(addressInput), requested = blockNumber(number);
      await verifyChains();
      const before = await pinned(requested);
      const [leftRaw, rightRaw] = await Promise.all(providers.map(provider => provider.getCode({ address: target, blockNumber: requested })));
      const left = code(leftRaw), right = code(rightRaw);
      if (left !== right) throw Error('RPC_CODE_DISAGREEMENT');
      if ((await pinned(requested)).hash !== before.hash) throw Error('RPC_CODE_REORG');
      return left;
    },
  });
}
