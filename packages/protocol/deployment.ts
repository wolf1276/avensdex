// Bounded, paused Fuji deployment planning plus a durable recovery journal.
// No signer, broadcaster, wallet access, activation, collateral or balance authority is implemented here.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeDeployData, encodeFunctionData, getContractAddress, keccak256, parseTransaction,
  recoverTransactionAddress, stringToHex, type Abi, type Hex,
} from 'viem';

export const FUJI_CHAIN_ID = 43113 as const;
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
export const MAX_RECORD_BYTES = 32_768;
const MAX_GAS_LIMIT = 30_000_000;
const MAX_CONFIRMATIONS = 1_000_000;
const MAX_BUDGET_WEI = 50_000_000_000_000_000n;
const MAX_DEPOSIT_CAP6 = 10_000_000;
const MAX_FEE = (1n << 128n) - 1n;
const MAX_NONCE = (1n << 64n) - 1n;

export interface CodeIdentity { address: Hex; codeHash: Hex }
export interface ArtifactHashes { codeHash: Hex; abiHash: Hex; initDataHash: Hex }
export type ContractName = 'AvensVault' | 'AvensFeedOracle' | 'AvensSettlement';
export type DeployArtifacts = Record<ContractName, { abi: Abi; bytecode: Hex }>;
type CheckedArtifact = { abi: Abi; bytecode: Hex; codeHash: Hex; abiHash: Hex };
type CheckedArtifacts = Record<ContractName, CheckedArtifact>;
export interface DeploymentTx {
  sequence: number; kind: 'create' | 'bindSettlement'; contract: ContractName; chainId: 43113;
  from: Hex; to: Hex | null; nonce: string; value: '0'; dataHash: Hex; gas: number;
  maxFeePerGas: string; maxPriorityFeePerGas: string; expectedCreatedAddress: Hex | null;
}
export interface DeploymentPlan {
  schemaVersion: 1; chainId: 43113; mainnet: false; deploymentId: Hex; sourceRevision: string;
  deployer: Hex; fundingPublisher: Hex; market: 1; depositCap6: number; baseMaxAge: number;
  quoteMaxAge: number; maxOracleAge: number; startingNonce: string; expiresAt: number;
  budgetWei: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
  codeIdentities: { collateral: CodeIdentity; baseUsdFeed: CodeIdentity; quoteUsdFeed: CodeIdentity };
  artifacts: Record<ContractName, ArtifactHashes>;
  addresses: { vault: Hex; feedOracle: Hex; settlement: Hex };
  sourceFingerprint: Hex; transactions: readonly DeploymentTx[];
  approvalRequired: true; executionEnabled: false; depositsActive: false; planHash: Hex;
}
export type RuntimeHashes = Record<ContractName, Hex>;

const INPUT_KEYS = ['chainId', 'mainnet', 'deploymentId', 'sourceRevision', 'deployer', 'fundingPublisher',
  'collateral', 'baseUsdFeed', 'quoteUsdFeed', 'market', 'depositCap6', 'baseMaxAge', 'quoteMaxAge',
  'maxOracleAge', 'startingNonce', 'expiresAt', 'budgetWei', 'gasLimits', 'maxFeePerGas', 'maxPriorityFeePerGas'] as const;
const GAS_KEYS = ['vault', 'feedOracle', 'settlement', 'bindSettlement'] as const;
const ARTIFACT_NAMES = ['AvensVault', 'AvensFeedOracle', 'AvensSettlement'] as const;
const CONSTRUCTOR_TYPES: Record<ContractName, readonly string[]> = {
  AvensVault: ['address', 'bytes32', 'uint128'],
  AvensFeedOracle: ['uint32', 'address', 'address', 'address', 'uint64', 'uint64'],
  AvensSettlement: ['address', 'address', 'uint32', 'uint64'],
};

function encode(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? { $bigint: v.toString() } : v);
}
const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw Error('INVALID_DEPLOYMENT_SCHEMA');
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function hash32(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/i.test(value)) throw Error('INVALID_DEPLOYMENT_HASH');
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0+$/i.test(value)) throw Error('INVALID_DEPLOYMENT_ADDRESS');
  return value.toLowerCase() as Hex;
}
function hexData(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw Error('INVALID_DEPLOYMENT_BYTECODE');
  return value.toLowerCase() as Hex;
}
function strictDecimal(value: unknown, max: bigint, zero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw Error('INVALID_DEPLOYMENT_QUANTITY');
  const n = BigInt(value);
  if (n > max || n < (zero ? 0n : 1n)) throw Error('DEPLOYMENT_QUANTITY_BOUNDS');
  return n;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw Error('INVALID_DEPLOYMENT_INTEGER');
  return value as number;
}
function rpcQuantity(value: unknown, max: bigint, zero = false): bigint {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value)) n = BigInt(value);
  else throw Error('INVALID_DEPLOYMENT_RPC_QUANTITY');
  if (n < 0n || n > max || (!zero && n === 0n)) throw Error('DEPLOYMENT_RPC_QUANTITY_BOUNDS');
  return n;
}
function codeIdentity(value: unknown): CodeIdentity {
  exact(value, ['address', 'codeHash']);
  return { address: address(value.address), codeHash: hash32(value.codeHash) };
}
function runtimeHashes(value: unknown): RuntimeHashes {
  exact(value, ARTIFACT_NAMES);
  return { AvensVault: hash32(value.AvensVault), AvensFeedOracle: hash32(value.AvensFeedOracle), AvensSettlement: hash32(value.AvensSettlement) };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const copy = <T>(value: T): T => deepFreeze(structuredClone(value));
const same = (a: unknown, b: unknown) => encode(a) === encode(b);
function distinct(values: readonly string[], code: string) {
  if (new Set(values.map(value => value.toLowerCase())).size !== values.length) throw Error(code);
}
function artifact(name: ContractName, value: unknown): CheckedArtifact {
  exact(value, ['abi', 'bytecode']);
  if (!Array.isArray(value.abi) || value.abi.length === 0 || value.abi.length > 4096) throw Error('INVALID_DEPLOYMENT_ABI');
  const abi = value.abi as Abi;
  const bytecode = hexData(value.bytecode);
  const constructors = abi.filter(item => isRecord(item) && item.type === 'constructor');
  if (constructors.length !== 1) throw Error('DEPLOYMENT_CONSTRUCTOR_MISSING');
  const inputs = (constructors[0] as Record<string, unknown>).inputs;
  if (!Array.isArray(inputs) || inputs.some(item => !isRecord(item) || typeof item.type !== 'string')
    || inputs.map(item => (item as Record<string, unknown>).type).join(',') !== CONSTRUCTOR_TYPES[name].join(',')) {
    throw Error('DEPLOYMENT_CONSTRUCTOR_MISMATCH');
  }
  if (name === 'AvensVault') {
    const bindings = abi.filter(item => isRecord(item) && item.type === 'function' && item.name === 'bindSettlement');
    const bind = bindings[0] as Record<string, unknown> | undefined;
    if (bindings.length !== 1 || !bind || !Array.isArray(bind.inputs) || bind.inputs.length !== 1
      || !isRecord(bind.inputs[0]) || (bind.inputs[0] as Record<string, unknown>).type !== 'address') {
      throw Error('DEPLOYMENT_BINDING_MISMATCH');
    }
  }
  return { abi, bytecode, codeHash: keccak256(bytecode), abiHash: keccak256(stringToHex(JSON.stringify(abi))) };
}
function checkArtifacts(value: unknown): CheckedArtifacts {
  exact(value, ARTIFACT_NAMES);
  return {
    AvensVault: artifact('AvensVault', value.AvensVault),
    AvensFeedOracle: artifact('AvensFeedOracle', value.AvensFeedOracle),
    AvensSettlement: artifact('AvensSettlement', value.AvensSettlement),
  };
}
function makeTx(sequence: number, kind: DeploymentTx['kind'], contract: ContractName, from: Hex, to: Hex | null,
  nonce: bigint, data: Hex, gas: number, maxFeePerGas: string, maxPriorityFeePerGas: string,
  expectedCreatedAddress: Hex | null): DeploymentTx {
  return Object.freeze({
    sequence, kind, contract, chainId: FUJI_CHAIN_ID, from, to, nonce: nonce.toString(), value: '0',
    dataHash: keccak256(data), gas, maxFeePerGas, maxPriorityFeePerGas, expectedCreatedAddress,
  });
}

export function buildDeploymentPlan(input: unknown, artifactsInput: unknown, nowInput: unknown): DeploymentPlan {
  const now = integer(nowInput, 0, 4_294_967_295);
  exact(input, INPUT_KEYS);
  const artifacts = checkArtifacts(artifactsInput);
  if (input.chainId !== FUJI_CHAIN_ID) throw Error('INVALID_DEPLOYMENT_CHAIN');
  if (input.mainnet !== false) throw Error('DEPLOYMENT_MAINNET_DISABLED');
  const deploymentId = hash32(input.deploymentId);
  if (typeof input.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(input.sourceRevision) || /^0+$/.test(input.sourceRevision)) {
    throw Error('INVALID_DEPLOYMENT_SOURCE_REVISION');
  }
  const sourceRevision = input.sourceRevision;
  const deployer = address(input.deployer), fundingPublisher = address(input.fundingPublisher);
  const collateral = codeIdentity(input.collateral), baseUsdFeed = codeIdentity(input.baseUsdFeed), quoteUsdFeed = codeIdentity(input.quoteUsdFeed);
  if (input.market !== 1) throw Error('INVALID_DEPLOYMENT_MARKET');
  const depositCap6 = integer(input.depositCap6, 1, MAX_DEPOSIT_CAP6);
  const baseMaxAge = integer(input.baseMaxAge, 1, 3600), quoteMaxAge = integer(input.quoteMaxAge, 1, 86400);
  const maxOracleAge = integer(input.maxOracleAge, 1, 86400);
  if (maxOracleAge !== Math.max(baseMaxAge, quoteMaxAge)) throw Error('DEPLOYMENT_ORACLE_AGE_MISMATCH');
  const startingNonce = strictDecimal(input.startingNonce, MAX_NONCE, true);
  if (startingNonce + 3n > MAX_NONCE) throw Error('DEPLOYMENT_NONCE_OVERFLOW');
  const expiresAt = integer(input.expiresAt, 0, 4_294_967_295);
  if (expiresAt <= now || expiresAt > now + 86400) throw Error('INVALID_DEPLOYMENT_EXPIRY');
  const budgetWei = strictDecimal(input.budgetWei, MAX_BUDGET_WEI);
  const maxFeePerGas = strictDecimal(input.maxFeePerGas, MAX_FEE);
  const maxPriorityFeePerGas = strictDecimal(input.maxPriorityFeePerGas, MAX_FEE, true);
  if (maxPriorityFeePerGas > maxFeePerGas) throw Error('DEPLOYMENT_FEE_PRIORITY');
  exact(input.gasLimits, GAS_KEYS);
  const limits = input.gasLimits as Record<string, unknown>;
  const gas = {
    vault: integer(limits.vault, 21_000, MAX_GAS_LIMIT), feedOracle: integer(limits.feedOracle, 21_000, MAX_GAS_LIMIT),
    settlement: integer(limits.settlement, 21_000, MAX_GAS_LIMIT), bindSettlement: integer(limits.bindSettlement, 21_000, MAX_GAS_LIMIT),
  };
  const totalGas = BigInt(gas.vault + gas.feedOracle + gas.settlement + gas.bindSettlement);
  if (totalGas * maxFeePerGas > budgetWei) throw Error('DEPLOYMENT_GAS_BUDGET_EXCEEDED');

  distinct([deployer, fundingPublisher, collateral.address, baseUsdFeed.address, quoteUsdFeed.address], 'DEPLOYMENT_IDENTITY_DUPLICATE');

  const vaultAddress = address(getContractAddress({ from: deployer, nonce: startingNonce }));
  const feedOracleAddress = address(getContractAddress({ from: deployer, nonce: startingNonce + 1n }));
  const settlementAddress = address(getContractAddress({ from: deployer, nonce: startingNonce + 2n }));
  distinct([deployer, fundingPublisher, collateral.address, baseUsdFeed.address, quoteUsdFeed.address,
    vaultAddress, feedOracleAddress, settlementAddress], 'DEPLOYMENT_ADDRESS_COLLISION');

  const vaultInit = encodeDeployData({ abi: artifacts.AvensVault.abi, bytecode: artifacts.AvensVault.bytecode,
    args: [collateral.address, deploymentId, BigInt(depositCap6)] });
  const feedInit = encodeDeployData({ abi: artifacts.AvensFeedOracle.abi, bytecode: artifacts.AvensFeedOracle.bytecode,
    args: [1, baseUsdFeed.address, quoteUsdFeed.address, fundingPublisher, baseMaxAge, quoteMaxAge] });
  const settlementInit = encodeDeployData({ abi: artifacts.AvensSettlement.abi, bytecode: artifacts.AvensSettlement.bytecode,
    args: [vaultAddress, feedOracleAddress, 1, maxOracleAge] });
  const bindData = encodeFunctionData({ abi: artifacts.AvensVault.abi, functionName: 'bindSettlement', args: [settlementAddress] });

  const fee = maxFeePerGas.toString(), priority = maxPriorityFeePerGas.toString();
  const transactions = [
    makeTx(0, 'create', 'AvensVault', deployer, null, startingNonce, vaultInit, gas.vault, fee, priority, vaultAddress),
    makeTx(1, 'create', 'AvensFeedOracle', deployer, null, startingNonce + 1n, feedInit, gas.feedOracle, fee, priority, feedOracleAddress),
    makeTx(2, 'create', 'AvensSettlement', deployer, null, startingNonce + 2n, settlementInit, gas.settlement, fee, priority, settlementAddress),
    makeTx(3, 'bindSettlement', 'AvensVault', deployer, vaultAddress, startingNonce + 3n, bindData, gas.bindSettlement, fee, priority, null),
  ] as const;

  const artifactHashes: Record<ContractName, ArtifactHashes> = {
    AvensVault: { codeHash: artifacts.AvensVault.codeHash, abiHash: artifacts.AvensVault.abiHash, initDataHash: keccak256(vaultInit) },
    AvensFeedOracle: { codeHash: artifacts.AvensFeedOracle.codeHash, abiHash: artifacts.AvensFeedOracle.abiHash, initDataHash: keccak256(feedInit) },
    AvensSettlement: { codeHash: artifacts.AvensSettlement.codeHash, abiHash: artifacts.AvensSettlement.abiHash, initDataHash: keccak256(settlementInit) },
  };
  const sourceFingerprint = keccak256(stringToHex(JSON.stringify({
    sourceRevision,
    artifacts: {
      AvensVault: { codeHash: artifactHashes.AvensVault.codeHash, abiHash: artifactHashes.AvensVault.abiHash },
      AvensFeedOracle: { codeHash: artifactHashes.AvensFeedOracle.codeHash, abiHash: artifactHashes.AvensFeedOracle.abiHash },
      AvensSettlement: { codeHash: artifactHashes.AvensSettlement.codeHash, abiHash: artifactHashes.AvensSettlement.abiHash },
    },
  })));
  const body = {
    schemaVersion: 1 as const, chainId: FUJI_CHAIN_ID, mainnet: false as const, deploymentId, sourceRevision,
    deployer, fundingPublisher, market: 1 as const, depositCap6, baseMaxAge, quoteMaxAge, maxOracleAge,
    startingNonce: startingNonce.toString(), expiresAt, budgetWei: budgetWei.toString(), maxFeePerGas: fee,
    maxPriorityFeePerGas: priority,
    codeIdentities: Object.freeze({ collateral, baseUsdFeed, quoteUsdFeed }),
    artifacts: Object.freeze(artifactHashes),
    addresses: Object.freeze({ vault: vaultAddress, feedOracle: feedOracleAddress, settlement: settlementAddress }),
    sourceFingerprint, transactions,
    approvalRequired: true as const, executionEnabled: false as const, depositsActive: false as const,
  };
  const planHash = keccak256(stringToHex(JSON.stringify(body)));
  return deepFreeze({ ...body, planHash }) as DeploymentPlan;
}

// Rebuild from trusted input and reviewed artifacts. A supplied planHash alone is never authorization.
export function validateDeploymentPlan(plan: unknown, input: unknown, artifacts: unknown, now: unknown): DeploymentPlan {
  const trusted = buildDeploymentPlan(input, artifacts, now);
  if (!isRecord(plan) || plan.planHash !== trusted.planHash || !same(plan, trusted)) throw Error('DEPLOYMENT_PLAN_MISMATCH');
  return trusted;
}

export type TxStatus = 'planned' | 'signed' | 'pending' | 'unknown' | 'reverted' | 'confirmed' | 'reorged';
export interface SignedIdentity {
  txHash: Hex; chainId: 43113; from: Hex; nonce: string; to: Hex | null; value: '0'; dataHash: Hex;
  gas: number; maxFeePerGas: string; maxPriorityFeePerGas: string; expectedCreatedAddress: Hex | null;
}
export interface ReceiptIdentity {
  txHash: Hex; status: 'success' | 'reverted'; blockNumber: string; blockHash: Hex;
  from: Hex; to: Hex | null; contractAddress: Hex | null; gasUsed: string; confirmations: number;
}
export interface DeploymentTxView {
  sequence: number; tx: DeploymentTx; status: TxStatus; signed: SignedIdentity | null;
  receipt: ReceiptIdentity | null; runtimeCodeHash: Hex | null; reason: string | null;
}
export interface DeploymentView {
  plan: DeploymentPlan; expectedRuntimeHashes: RuntimeHashes; confirmations: number;
  transactions: readonly DeploymentTxView[]; nextSignableSequence: number | null;
  approvalRequired: true; executionEnabled: false; depositsActive: false;
}
export interface DeploymentReader {
  getTransaction(txHash: string): Promise<unknown>;
  getReceipt(txHash: string): Promise<unknown>;
  getCanonicalHead(): Promise<unknown>;
  getCanonicalBlockHash(blockNumber: string): Promise<unknown>;
  getCode(address: string, blockNumber: string): Promise<unknown>;
}
interface StoredTx {
  status: TxStatus; signed: SignedIdentity | null; receipt: ReceiptIdentity | null;
  runtimeCodeHash: Hex | null; reason: string | null;
}
type StatusRecord = {
  type: 'status'; sequence: number; status: Exclude<TxStatus, 'planned' | 'signed'>;
  reason: string | null; receipt: ReceiptIdentity | null; runtimeCodeHash: Hex | null;
};
type JournalEvent =
  | { type: 'header'; engineVersion: 1; plan: DeploymentPlan; expectedRuntimeHashes: RuntimeHashes; confirmations: number; createdAt: number }
  | { type: 'signed'; sequence: number; signed: SignedIdentity }
  | StatusRecord;

const REASON = /^[A-Z0-9_]{1,80}$/;
function checkReason(value: unknown): string | null {
  if (value !== null && (typeof value !== 'string' || !REASON.test(value))) throw Error('INVALID_DEPLOYMENT_REASON');
  return value as string | null;
}
function checkSigned(value: unknown, tx: DeploymentTx): SignedIdentity {
  exact(value, ['txHash', 'chainId', 'from', 'nonce', 'to', 'value', 'dataHash', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'expectedCreatedAddress']);
  if (value.chainId !== FUJI_CHAIN_ID) throw Error('SIGNED_CHAIN_MISMATCH');
  const signed: SignedIdentity = {
    txHash: hash32(value.txHash), chainId: FUJI_CHAIN_ID, from: address(value.from),
    nonce: strictDecimal(value.nonce, MAX_NONCE, true).toString(), to: value.to === null ? null : address(value.to),
    value: '0', dataHash: hash32(value.dataHash), gas: integer(value.gas, 21_000, MAX_GAS_LIMIT),
    maxFeePerGas: strictDecimal(value.maxFeePerGas, MAX_FEE).toString(),
    maxPriorityFeePerGas: strictDecimal(value.maxPriorityFeePerGas, MAX_FEE, true).toString(),
    expectedCreatedAddress: value.expectedCreatedAddress === null ? null : address(value.expectedCreatedAddress),
  };
  if (value.value !== '0' || signed.from !== tx.from || signed.nonce !== tx.nonce || signed.to !== tx.to
    || signed.dataHash !== tx.dataHash || signed.gas !== tx.gas || signed.maxFeePerGas !== tx.maxFeePerGas
    || signed.maxPriorityFeePerGas !== tx.maxPriorityFeePerGas || signed.expectedCreatedAddress !== tx.expectedCreatedAddress) {
    throw Error('SIGNED_TRANSACTION_MISMATCH');
  }
  return signed;
}
function checkReceipt(value: unknown, tx: DeploymentTx, signed: SignedIdentity): ReceiptIdentity {
  exact(value, ['txHash', 'status', 'blockNumber', 'blockHash', 'from', 'to', 'contractAddress', 'gasUsed', 'confirmations']);
  if (value.status !== 'success' && value.status !== 'reverted') throw Error('INVALID_DEPLOYMENT_RECEIPT_STATUS');
  const receipt: ReceiptIdentity = {
    txHash: hash32(value.txHash), status: value.status,
    blockNumber: strictDecimal(value.blockNumber, MAX_NONCE, true).toString(), blockHash: hash32(value.blockHash),
    from: address(value.from), to: value.to === null ? null : address(value.to),
    contractAddress: value.contractAddress === null ? null : address(value.contractAddress),
    gasUsed: strictDecimal(value.gasUsed, MAX_NONCE, true).toString(),
    confirmations: integer(value.confirmations, 0, MAX_CONFIRMATIONS),
  };
  if (receipt.txHash !== signed.txHash || receipt.from !== tx.from || receipt.to !== tx.to) throw Error('RECEIPT_TRANSACTION_IDENTITY_MISMATCH');
  if (tx.kind === 'create') {
    if (receipt.to !== null || (receipt.contractAddress !== tx.expectedCreatedAddress
      && (receipt.status !== 'reverted' || receipt.contractAddress !== null))) throw Error('RECEIPT_CREATED_ADDRESS_MISMATCH');
  } else if (receipt.contractAddress !== null) {
    throw Error('RECEIPT_UNEXPECTED_CONTRACT_ADDRESS');
  }
  if (BigInt(receipt.gasUsed) > BigInt(tx.gas)) throw Error('RECEIPT_GAS_EXCEEDS_LIMIT');
  return receipt;
}
function emptyState(plan: DeploymentPlan): StoredTx[] {
  return plan.transactions.map(() => ({ status: 'planned', signed: null, receipt: null, runtimeCodeHash: null, reason: null }));
}
function nextSignable(state: readonly StoredTx[]): number | null {
  for (let index = 0; index < state.length; index++) {
    if (state[index]!.status === 'planned') {
      return state.slice(0, index).every(entry => entry.status === 'confirmed') ? index : null;
    }
    if (state[index]!.status !== 'confirmed') return null;
  }
  return null;
}
function applyEvent(state: StoredTx[], event: unknown, plan: DeploymentPlan, runtime: RuntimeHashes, policy: number): void {
  if (!isRecord(event)) throw Error('INVALID_DEPLOYMENT_EVENT');
  if (event.type === 'header') throw Error('DEPLOYMENT_HEADER_NOT_FIRST');
  if (event.type === 'signed') {
    exact(event, ['type', 'sequence', 'signed']);
    const sequence = integer(event.sequence, 0, plan.transactions.length - 1);
    const expected = nextSignable(state);
    if (sequence !== expected) throw Error('DEPLOYMENT_SEQUENCE_NOT_READY');
    const tx = plan.transactions[sequence]!;
    const signed = checkSigned(event.signed, tx);
    if (state.some(entry => entry.signed?.txHash === signed.txHash)) throw Error('DEPLOYMENT_TX_ALREADY_RESERVED');
    state[sequence] = { status: 'signed', signed, receipt: null, runtimeCodeHash: null, reason: null };
    return;
  }
  if (event.type !== 'status') throw Error('INVALID_DEPLOYMENT_EVENT');
  exact(event, ['type', 'sequence', 'status', 'reason', 'receipt', 'runtimeCodeHash']);
  const sequence = integer(event.sequence, 0, plan.transactions.length - 1);
  const stored = state[sequence]!;
  if (!stored.signed) throw Error('DEPLOYMENT_TX_NOT_SIGNED');
  if (!['pending', 'unknown', 'reverted', 'confirmed', 'reorged'].includes(event.status as string)) throw Error('INVALID_DEPLOYMENT_STATUS');
  const status = event.status as StatusRecord['status'];
  const reason = checkReason(event.reason);
  const receipt = event.receipt === null ? null : checkReceipt(event.receipt, plan.transactions[sequence]!, stored.signed);
  const runtimeCodeHash = event.runtimeCodeHash === null ? null : hash32(event.runtimeCodeHash);
  if (status === 'confirmed') {
    const tx = plan.transactions[sequence]!;
    if (state.slice(0, sequence).some(entry => entry.status !== 'confirmed')) throw Error('DEPLOYMENT_PREVIOUS_NOT_CONFIRMED');
    if (!receipt || receipt.status !== 'success' || receipt.confirmations < policy || reason !== null) throw Error('DEPLOYMENT_CONFIRMATION_INVALID');
    if (tx.kind === 'create') {
      if (runtimeCodeHash !== runtime[tx.contract]) throw Error('DEPLOYMENT_RUNTIME_HASH_MISMATCH');
    } else if (runtimeCodeHash !== null) {
      throw Error('DEPLOYMENT_BIND_RUNTIME_UNEXPECTED');
    }
  } else if (status === 'reverted') {
    if (!receipt || receipt.status !== 'reverted' || receipt.confirmations < policy || reason === null || runtimeCodeHash !== null) {
      throw Error('DEPLOYMENT_REVERT_INVALID');
    }
  } else if (status === 'pending') {
    if (!receipt || receipt.confirmations >= policy || reason === null || runtimeCodeHash !== null) throw Error('DEPLOYMENT_PENDING_INVALID');
  } else if (status === 'reorged') {
    if (reason === null || runtimeCodeHash !== null) throw Error('DEPLOYMENT_REORG_INVALID');
  } else if (reason === null) {
    throw Error('DEPLOYMENT_UNKNOWN_INVALID');
  }
  if (stored.status === status && same(stored.receipt, receipt) && stored.reason === reason && stored.runtimeCodeHash === runtimeCodeHash) {
    throw Error('DEPLOYMENT_DUPLICATE_TRANSITION');
  }
  stored.status = status; stored.receipt = receipt; stored.reason = reason; stored.runtimeCodeHash = runtimeCodeHash;
}
function append(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw Error('DEPLOYMENT_JOURNAL_WRITE_FAILED');
    offset += written;
  }
  fsyncSync(fd);
}
type Fetched = { ok: true; value: unknown } | { ok: false };
async function fetched(call: () => Promise<unknown>): Promise<Fetched> {
  try {
    const value = await call();
    return { ok: true, value: value === null || value === undefined ? value : structuredClone(value) };
  } catch { return { ok: false }; }
}
function checkRpcTransaction(value: unknown, tx: DeploymentTx, signed: SignedIdentity) {
  exact(value, ['hash', 'chainId', 'from', 'to', 'nonce', 'value', 'input', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']);
  const hash = hash32(value.hash), from = address(value.from), to = value.to === null ? null : address(value.to);
  if (value.chainId !== FUJI_CHAIN_ID || hash !== signed.txHash || from !== tx.from || to !== tx.to) throw Error('RPC_TRANSACTION_IDENTITY_MISMATCH');
  if (rpcQuantity(value.nonce, MAX_NONCE, true).toString() !== tx.nonce) throw Error('RPC_TRANSACTION_NONCE_MISMATCH');
  if (rpcQuantity(value.value, (1n << 128n) - 1n, true) !== 0n) throw Error('RPC_TRANSACTION_VALUE_MISMATCH');
  if (typeof value.input !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(value.input) || keccak256(value.input as Hex) !== tx.dataHash) {
    throw Error('RPC_TRANSACTION_INPUT_MISMATCH');
  }
  if (rpcQuantity(value.gas, BigInt(MAX_GAS_LIMIT)).toString() !== String(tx.gas)) throw Error('RPC_TRANSACTION_GAS_MISMATCH');
  if (rpcQuantity(value.maxFeePerGas, MAX_FEE).toString() !== tx.maxFeePerGas) throw Error('RPC_TRANSACTION_MAX_FEE_MISMATCH');
  if (rpcQuantity(value.maxPriorityFeePerGas, MAX_FEE, true).toString() !== tx.maxPriorityFeePerGas) throw Error('RPC_TRANSACTION_PRIORITY_FEE_MISMATCH');
}
function checkRpcReceipt(value: unknown, tx: DeploymentTx, signed: SignedIdentity) {
  exact(value, ['transactionHash', 'status', 'blockNumber', 'blockHash', 'from', 'to', 'contractAddress', 'gasUsed']);
  if (value.status !== 'success' && value.status !== 'reverted') throw Error('INVALID_DEPLOYMENT_RECEIPT_STATUS');
  const transactionHash = hash32(value.transactionHash), from = address(value.from), to = value.to === null ? null : address(value.to);
  if (transactionHash !== signed.txHash || from !== tx.from || to !== tx.to) throw Error('RPC_RECEIPT_IDENTITY_MISMATCH');
  if (value.contractAddress !== null && typeof value.contractAddress !== 'string') throw Error('INVALID_DEPLOYMENT_ADDRESS');
  const contractAddress = value.contractAddress === null ? null : address(value.contractAddress);
  if (tx.kind === 'create'
    ? contractAddress !== tx.expectedCreatedAddress && (value.status !== 'reverted' || contractAddress !== null)
    : contractAddress !== null) throw Error('RPC_RECEIPT_CREATED_ADDRESS_MISMATCH');
  return {
    contractAddress, status: value.status as 'success' | 'reverted',
    blockNumber: rpcQuantity(value.blockNumber, MAX_NONCE, true).toString(),
    blockHash: hash32(value.blockHash),
    gasUsed: rpcQuantity(value.gasUsed, BigInt(tx.gas), true).toString(),
  };
}
function checkHead(value: unknown) {
  exact(value, ['number', 'hash']);
  return { number: rpcQuantity(value.number, MAX_NONCE, true), hash: hash32(value.hash) };
}
function checkJournalOptions(value: unknown) {
  if (!isRecord(value)) throw Error('INVALID_DEPLOYMENT_OPTIONS');
  const allowed = ['input', 'artifacts', 'expectedRuntimeHashes', 'reader', 'confirmations', 'create'];
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || ['input', 'artifacts', 'expectedRuntimeHashes', 'reader', 'confirmations'].some(key => !keys.includes(key))) {
    throw Error('INVALID_DEPLOYMENT_OPTIONS');
  }
  if (value.create !== undefined && typeof value.create !== 'boolean') throw Error('INVALID_DEPLOYMENT_OPTIONS');
  const confirmations = integer(value.confirmations, 1, MAX_CONFIRMATIONS);
  const reader = value.reader as Partial<DeploymentReader> | null;
  if (!reader || typeof reader.getTransaction !== 'function' || typeof reader.getReceipt !== 'function'
    || typeof reader.getCanonicalHead !== 'function' || typeof reader.getCanonicalBlockHash !== 'function'
    || typeof reader.getCode !== 'function') throw Error('INVALID_DEPLOYMENT_READER');
  return { input: value.input, artifacts: value.artifacts, expectedRuntimeHashes: runtimeHashes(value.expectedRuntimeHashes),
    reader: reader as DeploymentReader, confirmations, create: value.create === true };
}
function checkExistingHeader(event: unknown, trustedPlan: DeploymentPlan, expectedRuntime: RuntimeHashes, confirmations: number) {
  exact(event, ['type', 'engineVersion', 'plan', 'expectedRuntimeHashes', 'confirmations', 'createdAt']);
  if (event.type !== 'header' || event.engineVersion !== 1 || event.confirmations !== confirmations) throw Error('DEPLOYMENT_JOURNAL_IDENTITY_MISMATCH');
  const headerRuntime = runtimeHashes(event.expectedRuntimeHashes);
  if (!same(headerRuntime, expectedRuntime)) throw Error('DEPLOYMENT_JOURNAL_RUNTIME_MISMATCH');
  if (!isRecord(event.plan) || event.plan.planHash !== trustedPlan.planHash || !same(event.plan, trustedPlan)) {
    throw Error('DEPLOYMENT_JOURNAL_PLAN_MISMATCH');
  }
  return integer(event.createdAt, 0, 4_294_967_295);
}

export class DeploymentJournal {
  private readonly fd: number;
  private readonly lock: string;
  private readonly deploymentPlan: DeploymentPlan;
  private readonly runtime: RuntimeHashes;
  private readonly confirmations: number;
  private readonly reader: DeploymentReader;
  private state: StoredTx[];
  private previous: string;
  private index: number;
  private bytes: number;
  #queue: Promise<void> = Promise.resolve();
  #failed = false;
  #closed = false;
  private constructor(fd: number, lock: string, plan: DeploymentPlan, runtime: RuntimeHashes, confirmations: number,
    reader: DeploymentReader, state: StoredTx[], previous: string, index: number, bytes: number) {
    this.fd = fd; this.lock = lock; this.deploymentPlan = plan; this.runtime = runtime; this.confirmations = confirmations;
    this.reader = reader; this.state = state; this.previous = previous; this.index = index; this.bytes = bytes;
  }
  static open(directory: string, options: unknown, nowInput: unknown): DeploymentJournal {
    if (typeof directory !== 'string' || directory.length === 0 || directory.length > 4096) throw Error('INVALID_DEPLOYMENT_DIRECTORY');
    const now = integer(nowInput, 0, 4_294_967_295);
    const { input, artifacts, expectedRuntimeHashes, reader, confirmations, create } = checkJournalOptions(options);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, 'writer.lock');
    const lockFd = openSync(lock, 'wx', 0o600); // Never steal a crash-held lock.
    let fd: number | undefined, lockOpen = true, startupJournal: DeploymentJournal | undefined;
    try {
      append(lockFd, Buffer.from(`${process.pid}\n`)); closeSync(lockFd); lockOpen = false;
      const path = join(directory, 'deployment.jsonl');
      let newPrevious = '0'.repeat(64);
      if (!existsSync(path)) {
        if (!create) throw Error('DEPLOYMENT_JOURNAL_MISSING_REFUSE_RESET');
        const plan = buildDeploymentPlan(input, artifacts, now);
        fd = openSync(path, 'ax', 0o600);
        const event: JournalEvent = { type: 'header', engineVersion: 1, plan, expectedRuntimeHashes, confirmations, createdAt: now };
        const body = { version: 1, index: 0, previous: '0'.repeat(64), event };
        newPrevious = digest(body);
        append(fd, Buffer.from(encode({ ...body, digest: newPrevious }) + '\n'));
        const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      if (fd === undefined) {
        if (statSync(path).size > MAX_JOURNAL_BYTES) throw Error('DEPLOYMENT_JOURNAL_CAPACITY');
        const text = readFileSync(path, 'utf8');
        if (!text.endsWith('\n') || !text.trim()) throw Error('DEPLOYMENT_JOURNAL_INCOMPLETE_REFUSE_TRUNCATION');
        const lines = text.slice(0, -1).split('\n');
        let trustedPlan: DeploymentPlan | undefined, createdAt = 0, previous = '0'.repeat(64), index = 0;
        let replayState: StoredTx[] | undefined;
        for (let line = 0; line < lines.length; line++) {
          const record = JSON.parse(lines[line]!) as unknown;
          exact(record, ['version', 'index', 'previous', 'event', 'digest']);
          const { digest: checksum, ...body } = record;
          if (record.version !== 1 || record.index !== line || record.previous !== previous || checksum !== digest(body)) {
            throw Error('DEPLOYMENT_JOURNAL_HASH_OR_SEQUENCE');
          }
          if (line === 0) {
            if (!isRecord(record.event) || record.event.type !== 'header') throw Error('DEPLOYMENT_JOURNAL_HEADER_MISSING');
            createdAt = integer(record.event.createdAt, 0, 4_294_967_295);
            trustedPlan = buildDeploymentPlan(input, artifacts, createdAt);
            checkExistingHeader(record.event, trustedPlan, expectedRuntimeHashes, confirmations);
            replayState = emptyState(trustedPlan);
          } else {
            applyEvent(replayState!, record.event, trustedPlan!, expectedRuntimeHashes, confirmations);
          }
          previous = checksum as string; index = line;
        }
        if (!trustedPlan || !replayState) throw Error('DEPLOYMENT_JOURNAL_HEADER_MISSING');
        fd = openSync(path, 'a', 0o600);
        startupJournal = new DeploymentJournal(fd, lock, trustedPlan, expectedRuntimeHashes, confirmations, reader,
          replayState, previous, index, Buffer.byteLength(text));
        // A persisted receipt is historical evidence, not proof of current canonicality.
        for (let sequence = 0; sequence < replayState.length; sequence++) {
          const stored = replayState[sequence]!;
          if (stored.status !== 'planned' && stored.status !== 'unknown') {
            startupJournal.#transition(sequence, 'unknown', 'RESTART_RECONCILIATION_REQUIRED', stored.receipt, stored.runtimeCodeHash);
          }
        }
        return startupJournal;
      }
      const plan = buildDeploymentPlan(input, artifacts, now);
      const journal = new DeploymentJournal(fd, lock, plan, expectedRuntimeHashes, confirmations, reader,
        emptyState(plan), newPrevious, 0, statSync(path).size);
      return journal;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      if (lockOpen) { try { closeSync(lockFd); } catch { /* already closed */ } }
      if (!startupJournal || !startupJournal.#failed) {
        try { unlinkSync(lock); } catch { /* already gone */ }
      }
      throw error;
    }
  }
  get writable() { return !this.#failed && !this.#closed; }
  #assertWritable() {
    if (!this.writable) throw Error('DEPLOYMENT_JOURNAL_UNAVAILABLE_RECONCILE_BEFORE_RETRY');
  }
  #commit(event: JournalEvent) {
    this.#assertWritable();
    const body = { version: 1, index: this.index + 1, previous: this.previous, event };
    const checksum = digest(body), bytes = Buffer.from(encode({ ...body, digest: checksum }) + '\n');
    if (bytes.length > MAX_RECORD_BYTES || this.bytes + bytes.length > MAX_JOURNAL_BYTES) throw Error('DEPLOYMENT_JOURNAL_CAPACITY');
    try { append(this.fd, bytes); }
    catch { this.#failed = true; throw Error('UNKNOWN_DEPLOYMENT_JOURNAL_WRITE_STOP_AND_RECONCILE'); }
    try { applyEvent(this.state, event, this.deploymentPlan, this.runtime, this.confirmations); }
    catch { this.#failed = true; throw Error('DEPLOYMENT_JOURNAL_REPLAY_DIVERGENCE'); }
    this.previous = checksum; this.index++; this.bytes += bytes.length;
  }
  #view(): DeploymentView {
    const transactions = this.state.map((stored, sequence) => ({
      sequence, tx: this.deploymentPlan.transactions[sequence]!, status: stored.status, signed: stored.signed,
      receipt: stored.receipt, runtimeCodeHash: stored.runtimeCodeHash, reason: stored.reason,
    }));
    return copy({
      plan: this.deploymentPlan, expectedRuntimeHashes: this.runtime, confirmations: this.confirmations, transactions,
      nextSignableSequence: nextSignable(this.state), approvalRequired: true as const,
      executionEnabled: false as const, depositsActive: false as const,
    });
  }
  #transition(sequence: number, status: StatusRecord['status'], reason: string | null,
    receipt: ReceiptIdentity | null, runtimeCodeHash: Hex | null): DeploymentView {
    this.#assertWritable();
    const stored = this.state[sequence];
    if (!stored) throw Error('DEPLOYMENT_SEQUENCE_INVALID');
    if (stored.status === status && same(stored.receipt, receipt) && same(stored.runtimeCodeHash, runtimeCodeHash) && stored.reason === reason) {
      return this.#view();
    }
    const event: StatusRecord = { type: 'status', sequence, status, reason, receipt, runtimeCodeHash };
    const probe = structuredClone(this.state);
    applyEvent(probe, event, this.deploymentPlan, this.runtime, this.confirmations);
    this.#commit(event);
    return this.#view();
  }
  plan(): DeploymentPlan { return copy(this.deploymentPlan); }
  view(): DeploymentView { return this.#view(); }
  async recordSigned(serializedTransaction: unknown): Promise<DeploymentView> {
    const run = this.#queue.then(() => this.#recordSignedNow(serializedTransaction));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
  async #recordSignedNow(serializedTransaction: unknown): Promise<DeploymentView> {
    this.#assertWritable();
    if (typeof serializedTransaction !== 'string' || !/^0x[0-9a-fA-F]{2,}$/.test(serializedTransaction) || serializedTransaction.length > 2 + MAX_RECORD_BYTES * 2) {
      throw Error('INVALID_SERIALIZED_TRANSACTION');
    }
    const sequence = nextSignable(this.state);
    if (sequence === null) throw Error('DEPLOYMENT_SEQUENCE_NOT_READY');
    const tx = this.deploymentPlan.transactions[sequence]!;
    let parsed: ReturnType<typeof parseTransaction>;
    let recovered: Hex;
    if (!serializedTransaction.startsWith('0x02')) throw Error('INVALID_SERIALIZED_TRANSACTION');
    try {
      parsed = parseTransaction(serializedTransaction as `0x02${string}`);
      recovered = address(await recoverTransactionAddress({ serializedTransaction: serializedTransaction as `0x02${string}` }));
    } catch { throw Error('INVALID_SERIALIZED_TRANSACTION'); }
    if (parsed.type !== 'eip1559' || parsed.chainId !== FUJI_CHAIN_ID) throw Error('SIGNED_CHAIN_MISMATCH');
    if (parsed.nonce === undefined) throw Error('INVALID_SERIALIZED_TRANSACTION');
    if (parsed.accessList?.length) throw Error('SIGNED_ACCESS_LIST_MISMATCH');
    const to = parsed.to === undefined ? null : parsed.to;
    const value = parsed.value ?? 0n;
    const input = parsed.data ?? '0x';
    const nonce = BigInt(parsed.nonce), gas = parsed.gas ?? 0n;
    const maxFee = parsed.maxFeePerGas ?? 0n, priority = parsed.maxPriorityFeePerGas ?? 0n;
    if (recovered.toLowerCase() !== tx.from.toLowerCase()) throw Error('SIGNED_SENDER_MISMATCH');
    if (to !== tx.to) throw Error('SIGNED_RECIPIENT_MISMATCH');
    if (nonce.toString() !== tx.nonce) throw Error('SIGNED_NONCE_MISMATCH');
    if (value !== 0n) throw Error('SIGNED_VALUE_MISMATCH');
    if (keccak256(input as Hex) !== tx.dataHash) throw Error('SIGNED_INPUT_MISMATCH');
    if (gas.toString() !== String(tx.gas)) throw Error('SIGNED_GAS_MISMATCH');
    if (maxFee.toString() !== tx.maxFeePerGas) throw Error('SIGNED_MAX_FEE_MISMATCH');
    if (priority.toString() !== tx.maxPriorityFeePerGas) throw Error('SIGNED_PRIORITY_FEE_MISMATCH');
    const signed: SignedIdentity = {
      txHash: keccak256(serializedTransaction as Hex), chainId: FUJI_CHAIN_ID, from: recovered,
      nonce: nonce.toString(), to, value: '0', dataHash: tx.dataHash, gas: Number(gas), maxFeePerGas: maxFee.toString(),
      maxPriorityFeePerGas: priority.toString(), expectedCreatedAddress: tx.expectedCreatedAddress,
    };
    const event = { type: 'signed' as const, sequence, signed };
    const probe = structuredClone(this.state);
    applyEvent(probe, event, this.deploymentPlan, this.runtime, this.confirmations);
    this.#commit(event);
    return this.#view();
  }
  reconcile(sequence: unknown): Promise<DeploymentView> {
    const run = this.#queue.then(() => this.#reconcileNow(sequence));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
  async #reconcileNow(sequenceInput: unknown): Promise<DeploymentView> {
    this.#assertWritable();
    const sequence = integer(sequenceInput, 0, this.deploymentPlan.transactions.length - 1);
    const stored = this.state[sequence]!;
    if (!stored.signed) throw Error('DEPLOYMENT_TX_NOT_SIGNED');
    if (this.state.slice(0, sequence).some(entry => entry.status !== 'confirmed')) throw Error('DEPLOYMENT_PREVIOUS_NOT_CONFIRMED');
    const signed = stored.signed, tx = this.deploymentPlan.transactions[sequence]!, reader = this.reader;
    const unchanged = () => this.state[sequence]?.signed?.txHash === signed.txHash;
    const transactionRaw = await fetched(() => reader.getTransaction(signed.txHash));
    if (!unchanged()) throw Error('DEPLOYMENT_RECONCILE_RACE');
    if (!transactionRaw.ok) return this.#transition(sequence, 'unknown', 'TRANSACTION_UNAVAILABLE', null, null);
    if (transactionRaw.value === null || transactionRaw.value === undefined) return this.#transition(sequence, 'unknown', 'TRANSACTION_NOT_FOUND', null, null);
    try { checkRpcTransaction(transactionRaw.value, tx, signed); }
    catch { return this.#transition(sequence, 'unknown', 'INVALID_TRANSACTION', null, null); }
    const receiptRaw = await fetched(() => reader.getReceipt(signed.txHash));
    if (!unchanged()) throw Error('DEPLOYMENT_RECONCILE_RACE');
    if (!receiptRaw.ok) return this.#transition(sequence, 'unknown', 'RECEIPT_UNAVAILABLE', null, null);
    if (receiptRaw.value === null || receiptRaw.value === undefined) return this.#transition(sequence, 'unknown', 'RECEIPT_NOT_FOUND', null, null);
    let receipt: ReturnType<typeof checkRpcReceipt>;
    try { receipt = checkRpcReceipt(receiptRaw.value, tx, signed); }
    catch { return this.#transition(sequence, 'unknown', 'INVALID_RECEIPT', null, null); }
    const headRaw = await fetched(() => reader.getCanonicalHead());
    if (!unchanged()) throw Error('DEPLOYMENT_RECONCILE_RACE');
    if (!headRaw.ok) return this.#transition(sequence, 'unknown', 'HEAD_UNAVAILABLE', null, null);
    let head: ReturnType<typeof checkHead>;
    try { head = checkHead(headRaw.value); } catch { return this.#transition(sequence, 'unknown', 'INVALID_HEAD', null, null); }
    const confirmationCount = head.number - BigInt(receipt.blockNumber) + 1n;
    if (confirmationCount < 1n) return this.#transition(sequence, 'unknown', 'RECEIPT_AHEAD_OF_HEAD', null, null);
    if (confirmationCount > BigInt(MAX_CONFIRMATIONS)) return this.#transition(sequence, 'unknown', 'CONFIRMATION_OVERFLOW', null, null);
    const confirmations = Number(confirmationCount);
    const canonicalRaw = await fetched(() => reader.getCanonicalBlockHash(receipt.blockNumber));
    if (!unchanged()) throw Error('DEPLOYMENT_RECONCILE_RACE');
    if (!canonicalRaw.ok || canonicalRaw.value === null) return this.#transition(sequence, 'unknown', 'CANONICAL_BLOCK_UNAVAILABLE', null, null);
    let canonicalHash: Hex;
    try { canonicalHash = hash32(canonicalRaw.value); } catch { return this.#transition(sequence, 'unknown', 'CANONICAL_BLOCK_INVALID', null, null); }
    const receiptIdentity = (runtimeCodeHash: Hex | null): ReceiptIdentity => ({
      txHash: signed.txHash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      from: tx.from, to: tx.to, contractAddress: receipt.contractAddress,
      gasUsed: receipt.gasUsed, confirmations,
    });
    if (canonicalHash !== receipt.blockHash) {
      return this.#transition(sequence, 'reorged', 'CANONICAL_BLOCK_HASH_CHANGED', receiptIdentity(null), null);
    }
    const pinnedHead = await fetched(() => reader.getCanonicalBlockHash(head.number.toString()));
    if (!unchanged()) throw Error('DEPLOYMENT_RECONCILE_RACE');
    if (!pinnedHead.ok || pinnedHead.value !== head.hash) {
      return this.#transition(sequence, 'unknown', 'CANONICAL_HEAD_CHANGED', receiptIdentity(null), null);
    }
    if (confirmations < this.confirmations) {
      return this.#transition(sequence, 'pending', receipt.status === 'reverted' ? 'REVERTED_AWAITING_CONFIRMATIONS' : 'CONFIRMATIONS_PENDING',
        receiptIdentity(null), null);
    }
    if (receipt.status === 'reverted') {
      return this.#transition(sequence, 'reverted', 'RECEIPT_REVERTED', receiptIdentity(null), null);
    }
    let runtimeCodeHash: Hex | null = null;
    if (tx.kind === 'create') {
      const codeRaw = await fetched(() => reader.getCode(tx.expectedCreatedAddress!, receipt.blockNumber));
      if (!unchanged()) throw Error('DEPLOYMENT_RECONCILE_RACE');
      if (!codeRaw.ok) return this.#transition(sequence, 'unknown', 'RUNTIME_CODE_UNAVAILABLE', receiptIdentity(null), null);
      if (typeof codeRaw.value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(codeRaw.value) || codeRaw.value === '0x') {
        return this.#transition(sequence, 'unknown', 'RUNTIME_CODE_MISSING', receiptIdentity(null), null);
      }
      runtimeCodeHash = keccak256(codeRaw.value as Hex);
      if (runtimeCodeHash !== this.runtime[tx.contract]) {
        return this.#transition(sequence, 'unknown', 'RUNTIME_CODE_HASH_MISMATCH', receiptIdentity(null), null);
      }
    }
    // Code reads must belong to the same canonical observation, not a branch replaced during the read.
    const finalHead = await fetched(() => reader.getCanonicalBlockHash(head.number.toString()));
    if (!unchanged()) throw Error('DEPLOYMENT_RECONCILE_RACE');
    if (!finalHead.ok || finalHead.value !== head.hash) {
      return this.#transition(sequence, 'unknown', 'CANONICAL_HEAD_CHANGED', receiptIdentity(null), null);
    }
    return this.#transition(sequence, 'confirmed', null, receiptIdentity(runtimeCodeHash), runtimeCodeHash);
  }
  close() {
    if (this.#closed) return;
    closeSync(this.fd); this.#closed = true;
    if (!this.#failed) unlinkSync(this.lock); // Unknown writes retain the lock for explicit operator reconciliation.
  }
}
