// Durable settlement intent/receipt lifecycle. No signing, broadcasting, collateral or balance authority.
// A transaction hash or submission acknowledgment is never treated as a filled order.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { decimal, exact } from './engine.ts';
import { digest, encode, MAX_JOURNAL_BYTES } from './journal.ts';

// Minimal local adapter schema. Parent integration must decode the deployed ABI into these exact fields.
export const MATCHED_FILL_SIGNATURE = 'MatchedFill(uint64,bytes32,bytes32,uint128,uint128)' as const;
export const MATCHED_FILL_EVENT = { type: 'event', name: 'MatchedFill', inputs: [
  { name: 'pairId', type: 'uint64', indexed: true },
  { name: 'longOrderHash', type: 'bytes32', indexed: true },
  { name: 'shortOrderHash', type: 'bytes32', indexed: true },
  { name: 'size6', type: 'uint128', indexed: false },
  { name: 'price18', type: 'uint128', indexed: false },
] } as const;

export type SettlementStatus = 'intent' | 'broadcast' | 'pending' | 'unknown' | 'reverted' | 'confirmed' | 'reorged';
export type SettlementChainId = 31337 | 43113;
export interface SettlementIdentity { chainId: SettlementChainId; deploymentId: string; settlementContract: string }
export interface SettlementIntentInput {
  pairId: string; longOrderHash: string; shortOrderHash: string; size6: string; price18: string; sender: string; nonce: string;
}
export interface SettlementIntent extends SettlementIntentInput {
  version: 1; chainId: SettlementChainId; deploymentId: string; settlementContract: string; intentId: string;
}
export interface BroadcastIdentity { txHash: string; sender: string; nonce: string }
export interface ReceiptIdentity { txHash: string; status: 'success' | 'reverted'; blockNumber: string; blockHash: string; sender: string; nonce: string }
export interface SettlementEvent {
  contract: string; pairId: string; longOrderHash: string; shortOrderHash: string; size6: string; price18: string;
  txHash: string; blockNumber: string; blockHash: string; logIndex: number;
}
export interface SettlementView {
  intent: SettlementIntent; broadcasts: readonly BroadcastIdentity[]; broadcast: BroadcastIdentity | null;
  status: SettlementStatus; receipt: ReceiptIdentity | null; event: SettlementEvent | null;
  reason: string | null; confirmations: number | null;
}
export interface ConfirmedFill extends SettlementEvent { intentId: string; sender: string; nonce: string }
// Injected by the caller. Values are revalidated and cloned; callbacks are not trusted to mark success.
export interface ReceiptReader {
  getReceipt(txHash: string): Promise<unknown>;
  getCanonicalHead(): Promise<unknown>;
  getCanonicalBlockHash(blockNumber: string): Promise<unknown>;
}
export interface SettlementJournalOptions { confirmations: number; reader: ReceiptReader; create?: boolean }

const ZERO32 = `0x${'0'.repeat(64)}`, ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_RECORD_BYTES = 32_768, MAX_LOGS = 256, MAX_CONFIRMATIONS = 1_000_000;
const hash32 = (value: unknown) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value) || value === ZERO32) throw Error('INVALID_SETTLEMENT_HASH');
  return value;
};
const address = (value: unknown) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value) || value === ZERO_ADDRESS) throw Error('INVALID_SETTLEMENT_ADDRESS');
  return value;
};
const quantity = (value: unknown, bits: 64 | 128, zero = false) => decimal(value, (1n << BigInt(bits)) - 1n, zero).toString();
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw Error('INVALID_SETTLEMENT_INTEGER');
  return value as number;
};
const reason = (value: unknown): string | null => {
  if (value !== null && (typeof value !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(value))) throw Error('INVALID_SETTLEMENT_REASON');
  return value as string | null;
};
function checkedIdentity(input: unknown): SettlementIdentity {
  exact(input, ['chainId', 'deploymentId', 'settlementContract']);
  if (input.chainId !== 31337 && input.chainId !== 43113) throw Error('INVALID_SETTLEMENT_CHAIN');
  return Object.freeze({ chainId: input.chainId, deploymentId: hash32(input.deploymentId), settlementContract: address(input.settlementContract) });
}
function checkedOptions(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_SETTLEMENT_OPTIONS');
  const keys = Object.keys(input);
  if (keys.some(key => !['confirmations', 'reader', 'create'].includes(key)) || !keys.includes('confirmations') || !keys.includes('reader')) {
    throw Error('INVALID_SETTLEMENT_OPTIONS');
  }
  const value = input as Record<string, unknown>;
  const confirmations = integer(value.confirmations, 1, MAX_CONFIRMATIONS);
  if (value.create !== undefined && typeof value.create !== 'boolean') throw Error('INVALID_SETTLEMENT_OPTIONS');
  const reader = value.reader as Partial<ReceiptReader> | null;
  if (!reader || typeof reader.getReceipt !== 'function' || typeof reader.getCanonicalHead !== 'function'
    || typeof reader.getCanonicalBlockHash !== 'function') throw Error('INVALID_SETTLEMENT_READER');
  return { confirmations, reader: reader as ReceiptReader, create: value.create === true };
}
function deepFreeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}
const copy = <T>(value: T): T => { const cloned = structuredClone(value); deepFreeze(cloned); return cloned; };
const same = (a: unknown, b: unknown) => encode(a) === encode(b);

function makeIntent(identity: SettlementIdentity, input: unknown): SettlementIntent {
  exact(input, ['pairId', 'longOrderHash', 'shortOrderHash', 'size6', 'price18', 'sender', 'nonce']);
  const body = {
    version: 1 as const, chainId: identity.chainId, deploymentId: identity.deploymentId, settlementContract: identity.settlementContract,
    pairId: quantity(input.pairId, 64), longOrderHash: hash32(input.longOrderHash), shortOrderHash: hash32(input.shortOrderHash),
    size6: quantity(input.size6, 128), price18: quantity(input.price18, 128), sender: address(input.sender), nonce: quantity(input.nonce, 64, true),
  };
  return { ...body, intentId: digest(body) };
}
function checkIntent(input: unknown, identity: SettlementIdentity): SettlementIntent {
  exact(input, ['version', 'chainId', 'deploymentId', 'settlementContract', 'pairId', 'longOrderHash', 'shortOrderHash', 'size6', 'price18', 'sender', 'nonce', 'intentId']);
  if (input.version !== 1 || input.chainId !== identity.chainId || input.deploymentId !== identity.deploymentId
    || input.settlementContract !== identity.settlementContract) throw Error('SETTLEMENT_INTENT_IDENTITY_MISMATCH');
  const checked = makeIntent(identity, {
    pairId: input.pairId, longOrderHash: input.longOrderHash, shortOrderHash: input.shortOrderHash,
    size6: input.size6, price18: input.price18, sender: input.sender, nonce: input.nonce,
  });
  if (checked.intentId !== input.intentId) throw Error('SETTLEMENT_INTENT_DIGEST_MISMATCH');
  return checked;
}
function checkBroadcast(input: unknown): BroadcastIdentity {
  exact(input, ['txHash', 'sender', 'nonce']);
  return { txHash: hash32(input.txHash), sender: address(input.sender), nonce: quantity(input.nonce, 64, true) };
}
function checkReceiptIdentity(input: unknown): ReceiptIdentity {
  exact(input, ['txHash', 'status', 'blockNumber', 'blockHash', 'sender', 'nonce']);
  if (input.status !== 'success' && input.status !== 'reverted') throw Error('INVALID_SETTLEMENT_RECEIPT_STATUS');
  return { txHash: hash32(input.txHash), status: input.status, blockNumber: quantity(input.blockNumber, 64, true),
    blockHash: hash32(input.blockHash), sender: address(input.sender), nonce: quantity(input.nonce, 64, true) };
}
function checkEvent(input: unknown): SettlementEvent {
  exact(input, ['contract', 'pairId', 'longOrderHash', 'shortOrderHash', 'size6', 'price18', 'txHash', 'blockNumber', 'blockHash', 'logIndex']);
  return {
    contract: address(input.contract), pairId: quantity(input.pairId, 64), longOrderHash: hash32(input.longOrderHash),
    shortOrderHash: hash32(input.shortOrderHash), size6: quantity(input.size6, 128), price18: quantity(input.price18, 128),
    txHash: hash32(input.txHash), blockNumber: quantity(input.blockNumber, 64, true), blockHash: hash32(input.blockHash),
    logIndex: integer(input.logIndex, 0, 0xffffffff),
  };
}
function matchesEvent(identity: SettlementIdentity, intent: SettlementIntent, receipt: ReceiptIdentity, event: SettlementEvent) {
  return event.contract === identity.settlementContract && event.pairId === intent.pairId
    && event.longOrderHash === intent.longOrderHash && event.shortOrderHash === intent.shortOrderHash
    && event.size6 === intent.size6 && event.price18 === intent.price18
    && event.txHash === receipt.txHash && event.blockHash === receipt.blockHash
    && BigInt(event.blockNumber) === BigInt(receipt.blockNumber);
}

type JournalEvent =
  | { type: 'header'; engineVersion: 2; identity: SettlementIdentity; confirmations: number }
  | { type: 'intent'; intent: SettlementIntent }
  | { type: 'broadcast'; intentId: string; broadcast: BroadcastIdentity; replacement: boolean }
  | { type: 'transition'; intentId: string; status: Exclude<SettlementStatus, 'intent' | 'broadcast'>;
      reason: string | null; receipt: ReceiptIdentity | null; event: SettlementEvent | null; confirmations: number | null };
interface Stored {
  intent: SettlementIntent; broadcasts: BroadcastIdentity[]; status: SettlementStatus;
  receipt: ReceiptIdentity | null; event: SettlementEvent | null; reason: string | null; confirmations: number | null;
}
type SettledStatus = Exclude<SettlementStatus, 'intent' | 'broadcast'>;
function transitionAllowed(from: SettlementStatus, to: SettlementStatus): boolean {
  if (to === 'broadcast' || to === 'intent') return false;
  if (from === 'intent') return to === 'unknown';
  if (from === 'broadcast' || from === 'pending' || from === 'unknown') return true;
  // Rechecking a canonical receipt may increase confirmations or downgrade after head rollback.
  if (from === 'reverted' || from === 'confirmed') return to === from || to === 'pending' || to === 'reorged' || to === 'unknown';
  return to === 'pending' || to === 'unknown' || to === 'reverted' || to === 'confirmed' || to === 'reorged';
}
function transitionEvent(input: unknown, identity: SettlementIdentity, policy: number, intent: SettlementIntent, from: SettlementStatus) {
  exact(input, ['type', 'intentId', 'status', 'reason', 'receipt', 'event', 'confirmations']);
  if (input.type !== 'transition' || input.intentId !== intent.intentId) throw Error('SETTLEMENT_TRANSITION_MISMATCH');
  const status = input.status;
  if (!['pending', 'unknown', 'reverted', 'confirmed', 'reorged'].includes(status as string)
    || !transitionAllowed(from, status as SettlementStatus)) throw Error('SETTLEMENT_TRANSITION_ORDER');
  const parsedReason = reason(input.reason);
  const receipt = input.receipt === null ? null : checkReceiptIdentity(input.receipt);
  if (receipt && (receipt.sender !== intent.sender || receipt.nonce !== intent.nonce)) throw Error('SETTLEMENT_RECEIPT_SENDER_NONCE_MISMATCH');
  const event = input.event === null ? null : checkEvent(input.event);
  const confirmations = input.confirmations === null ? null : integer(input.confirmations, 0, Number.MAX_SAFE_INTEGER);
  if (status === 'confirmed') {
    if (!receipt || receipt.status !== 'success' || !event || confirmations === null || confirmations < policy
      || !matchesEvent(identity, intent, receipt, event) || parsedReason !== null) throw Error('SETTLEMENT_CONFIRMATION_INVALID');
  } else if (status === 'reverted') {
    if (!receipt || receipt.status !== 'reverted' || event || confirmations === null || confirmations < policy
      || parsedReason === null) throw Error('SETTLEMENT_REVERT_INVALID');
  } else if (status === 'pending') {
    if (!receipt || event || confirmations === null || confirmations >= policy
      || parsedReason === null) throw Error('SETTLEMENT_PENDING_INVALID');
  } else if (status === 'reorged') {
    if (!receipt || event || parsedReason === null) throw Error('SETTLEMENT_REORG_INVALID');
  } else {
    if (parsedReason === null || (event && (!receipt || receipt.status !== 'success'
      || !matchesEvent(identity, intent, receipt, event)))) throw Error('SETTLEMENT_UNKNOWN_INVALID');
  }
  return { type: 'transition' as const, intentId: intent.intentId, status: status as SettledStatus,
    reason: parsedReason, receipt, event, confirmations };
}
function checkBroadcastEvent(stored: Stored, input: unknown) {
  exact(input, ['type', 'intentId', 'broadcast', 'replacement']);
  if (input.type !== 'broadcast' || input.intentId !== stored.intent.intentId || typeof input.replacement !== 'boolean') {
    throw Error('SETTLEMENT_BROADCAST_MISMATCH');
  }
  const broadcast = checkBroadcast(input.broadcast);
  if (broadcast.sender !== stored.intent.sender || broadcast.nonce !== stored.intent.nonce) {
    throw Error('SETTLEMENT_BROADCAST_IDENTITY_MISMATCH');
  }
  if (!input.replacement) {
    if (stored.broadcasts.length !== 0) throw Error('SETTLEMENT_DUPLICATE_BROADCAST');
  } else {
    if (stored.broadcasts.length === 0) throw Error('SETTLEMENT_NOTHING_TO_REPLACE');
    if (stored.broadcasts.at(-1)!.txHash === broadcast.txHash) throw Error('SETTLEMENT_DUPLICATE_BROADCAST');
    if (stored.status === 'confirmed' || stored.status === 'reverted') throw Error('SETTLEMENT_BROADCAST_FINAL');
  }
  if (stored.broadcasts.length >= 64) throw Error('SETTLEMENT_REPLACEMENT_CAPACITY');
  if (stored.broadcasts.some(value => value.txHash === broadcast.txHash)) throw Error('SETTLEMENT_BROADCAST_REUSED');
  return { type: 'broadcast' as const, intentId: stored.intent.intentId, broadcast, replacement: input.replacement };
}
function uniqueIntent(records: Map<string, Stored>, intent: SettlementIntent) {
  for (const stored of records.values()) {
    if (stored.intent.sender === intent.sender && stored.intent.nonce === intent.nonce) throw Error('SETTLEMENT_NONCE_ALREADY_RESERVED');
    if (stored.intent.pairId === intent.pairId && stored.status !== 'reverted') throw Error('SETTLEMENT_PAIR_ALREADY_RESERVED');
    if (stored.status !== 'confirmed' && stored.status !== 'reverted') {
      const hashes = [stored.intent.longOrderHash, stored.intent.shortOrderHash];
      if (hashes.includes(intent.longOrderHash) || hashes.includes(intent.shortOrderHash)) throw Error('SETTLEMENT_RECONCILE_ORDER_FIRST');
    }
  }
}
function uniqueBroadcast(records: Map<string, Stored>, intentId: string, txHash: string) {
  for (const [id, stored] of records) {
    if (id !== intentId && stored.broadcasts.some(value => value.txHash === txHash)) throw Error('SETTLEMENT_TX_ALREADY_RESERVED');
  }
}
function replayEvent(records: Map<string, Stored>, input: unknown, identity: SettlementIdentity, policy: number) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_SETTLEMENT_EVENT');
  const type = (input as Record<string, unknown>).type;
  if (type === 'header') throw Error('SETTLEMENT_HEADER_NOT_FIRST');
  if (type === 'intent') {
    exact(input, ['type', 'intent']);
    const intent = checkIntent(input.intent, identity);
    if (records.has(intent.intentId)) throw Error('SETTLEMENT_DUPLICATE_INTENT');
    uniqueIntent(records, intent);
    records.set(intent.intentId, { intent, broadcasts: [], status: 'intent', receipt: null, event: null, reason: null, confirmations: null });
    return;
  }
  if (type === 'broadcast' || type === 'transition') {
    const rawIntentId = (input as Record<string, unknown>).intentId;
    if (typeof rawIntentId !== 'string') throw Error('SETTLEMENT_INTENT_MISSING');
    const stored = records.get(rawIntentId);
    if (!stored) throw Error('SETTLEMENT_INTENT_MISSING');
    if (type === 'broadcast') {
      const event = checkBroadcastEvent(stored, input);
      uniqueBroadcast(records, event.intentId, event.broadcast.txHash);
      stored.broadcasts.push(event.broadcast);
      stored.status = 'broadcast'; stored.receipt = null; stored.event = null; stored.reason = null; stored.confirmations = null;
    } else {
      const event = transitionEvent(input, identity, policy, stored.intent, stored.status);
      if (stored.status === event.status && stored.receipt && event.receipt
        && same(stored.receipt, event.receipt) && same(stored.event, event.event)
        && stored.reason === event.reason && stored.confirmations === event.confirmations) {
        throw Error('SETTLEMENT_DUPLICATE_TRANSITION');
      }
      stored.status = event.status; stored.receipt = event.receipt; stored.event = event.event;
      stored.reason = event.reason; stored.confirmations = event.confirmations;
    }
    return;
  }
  throw Error('INVALID_SETTLEMENT_EVENT');
}
function append(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) throw Error('SETTLEMENT_JOURNAL_WRITE_FAILED');
    offset += n;
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
interface ParsedReceipt extends ReceiptIdentity { logs: SettlementEvent[] }
function checkReceipt(input: unknown, txHash: string, intent: SettlementIntent): ParsedReceipt {
  exact(input, ['txHash', 'status', 'blockNumber', 'blockHash', 'sender', 'nonce', 'logs']);
  const sender = address(input.sender), nonce = quantity(input.nonce, 64, true);
  if (sender !== intent.sender || nonce !== intent.nonce) throw Error('SETTLEMENT_RECEIPT_SENDER_NONCE_MISMATCH');
  if (input.txHash !== txHash) throw Error('SETTLEMENT_RECEIPT_TX_MISMATCH');
  if (input.status !== 'success' && input.status !== 'reverted') throw Error('INVALID_SETTLEMENT_RECEIPT_STATUS');
  const blockNumber = quantity(input.blockNumber, 64, true);
  const blockHash = hash32(input.blockHash);
  if (!Array.isArray(input.logs) || input.logs.length > MAX_LOGS) throw Error('SETTLEMENT_RECEIPT_LOGS');
  const logs = input.logs.map(raw => {
    const event = checkEvent(raw);
    if (event.txHash !== txHash || event.blockHash !== blockHash || BigInt(event.blockNumber) !== BigInt(blockNumber)) {
      throw Error('SETTLEMENT_LOG_RECEIPT_MISMATCH');
    }
    return event;
  });
  return { txHash, status: input.status, blockNumber, blockHash, sender, nonce, logs };
}
function checkHead(input: unknown) {
  exact(input, ['number', 'hash']);
  return { number: quantity(input.number, 64, true), hash: hash32(input.hash) };
}
function matchingLogs(identity: SettlementIdentity, intent: SettlementIntent, receipt: ParsedReceipt) {
  return receipt.logs.filter(log => log.contract === identity.settlementContract && log.pairId === intent.pairId
    && log.longOrderHash === intent.longOrderHash && log.shortOrderHash === intent.shortOrderHash);
}

export class SettlementJournal {
  private readonly fd: number;
  private readonly lock: string;
  private readonly identity: SettlementIdentity;
  private readonly confirmations: number;
  private readonly reader: ReceiptReader;
  #records: Map<string, Stored>;
  private previous: string;
  private index: number;
  private bytes: number;
  #queue: Promise<void> = Promise.resolve();
  #failed = false;
  #closed = false;
  private constructor(fd: number, lock: string, identity: SettlementIdentity, confirmations: number, reader: ReceiptReader,
    records: Map<string, Stored>, previous: string, index: number, bytes: number) {
    this.fd = fd; this.lock = lock; this.identity = identity; this.confirmations = confirmations; this.reader = reader;
    this.#records = records; this.previous = previous; this.index = index; this.bytes = bytes;
  }
  static open(directory: string, input: unknown, options: unknown): SettlementJournal {
    const identity = checkedIdentity(input);
    const { confirmations, reader, create } = checkedOptions(options);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, 'writer.lock');
    const lockFd = openSync(lock, 'wx', 0o600); // Never steal a crash-held lock.
    let fd: number | undefined, lockOpen = true;
    let startupJournal: SettlementJournal | undefined;
    try {
      append(lockFd, Buffer.from(`${process.pid}\n`)); closeSync(lockFd); lockOpen = false;
      const path = join(directory, 'settlements.jsonl');
      if (!existsSync(path)) {
        if (!create) throw Error('SETTLEMENT_JOURNAL_MISSING_REFUSE_RESET');
        fd = openSync(path, 'ax', 0o600);
        const header = { type: 'header' as const, engineVersion: 2 as const, identity, confirmations };
        const body = { version: 1, index: 0, previous: '0'.repeat(64), event: header };
        append(fd, Buffer.from(encode({ ...body, digest: digest(body) }) + '\n'));
        const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      if (statSync(path).size > MAX_JOURNAL_BYTES) throw Error('SETTLEMENT_JOURNAL_CAPACITY');
      const text = readFileSync(path, 'utf8');
      if (!text.endsWith('\n') || !text.trim()) throw Error('SETTLEMENT_JOURNAL_INCOMPLETE_REFUSE_TRUNCATION');
      const lines = text.slice(0, -1).split('\n');
      const records = new Map<string, Stored>();
      let previous = '0'.repeat(64), index = 0;
      for (let i = 0; i < lines.length; i++) {
        const record = JSON.parse(lines[i]!) as unknown;
        exact(record, ['version', 'index', 'previous', 'event', 'digest']);
        const { digest: checksum, ...body } = record;
        if (record.version !== 1 || record.index !== i || record.previous !== previous || checksum !== digest(body)) {
          throw Error('SETTLEMENT_JOURNAL_HASH_OR_SEQUENCE');
        }
        if (i === 0) {
          exact(record.event, ['type', 'engineVersion', 'identity', 'confirmations']);
          if (record.event.type !== 'header' || record.event.engineVersion !== 2) throw Error('SETTLEMENT_JOURNAL_IDENTITY_MISMATCH');
          const headerIdentity = checkedIdentity(record.event.identity);
          if (encode(headerIdentity) !== encode(identity) || record.event.confirmations !== confirmations) {
            throw Error('SETTLEMENT_JOURNAL_IDENTITY_MISMATCH');
          }
        } else {
          replayEvent(records, record.event, identity, confirmations);
        }
        previous = checksum as string; index = i;
      }
      fd ??= openSync(path, 'a', 0o600);
      const journal = new SettlementJournal(fd, lock, identity, confirmations, reader, records, previous, index, Buffer.byteLength(text));
      startupJournal = journal;
      // A persisted confirmation is historical evidence, not proof of canonicality after restart.
      for (const [id, stored] of records) {
        if (stored.status !== 'unknown') {
          journal.#transition(id, 'unknown', 'RESTART_RECONCILIATION_REQUIRED', stored.receipt, null, null);
        }
      }
      return journal;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
      if (lockOpen) { try { closeSync(lockFd); } catch { /* already closed */ } }
      // Startup failures never reset/truncate a journal. Only remove the lock acquired by this attempt.
      if (!startupJournal || !startupJournal.#failed) {
        try { unlinkSync(lock); } catch { /* already gone */ }
      }
      throw error;
    }
  }
  get writable() { return !this.#failed && !this.#closed; }
  #assertWritable() {
    if (!this.writable) throw Error('SETTLEMENT_JOURNAL_UNAVAILABLE_RECONCILE_BEFORE_RETRY');
  }
  #commit(event: JournalEvent) {
    this.#assertWritable();
    const body = { version: 1, index: this.index + 1, previous: this.previous, event };
    const checksum = digest(body), bytes = Buffer.from(encode({ ...body, digest: checksum }) + '\n');
    if (bytes.length > MAX_RECORD_BYTES || this.bytes + bytes.length > MAX_JOURNAL_BYTES) {
      throw Error('SETTLEMENT_JOURNAL_CAPACITY');
    }
    try { append(this.fd, bytes); }
    catch { this.#failed = true; throw Error('UNKNOWN_SETTLEMENT_JOURNAL_WRITE_STOP_AND_RECONCILE'); }
    // No lifecycle state escapes until the whole transition is durable.
    replayEvent(this.#records, event, this.identity, this.confirmations);
    this.previous = checksum; this.index++; this.bytes += bytes.length;
  }
  #view(stored: Stored): SettlementView {
    return copy({
      intent: stored.intent, broadcasts: stored.broadcasts, broadcast: stored.broadcasts.at(-1) ?? null,
      status: stored.status, receipt: stored.receipt, event: stored.event,
      reason: stored.reason, confirmations: stored.confirmations,
    });
  }
  #transition(intentId: string, status: SettledStatus, transitionReason: string | null,
    receipt: ReceiptIdentity | null, event: SettlementEvent | null, confirmations: number | null): SettlementView {
    this.#assertWritable();
    const stored = this.#records.get(intentId);
    if (!stored) throw Error('SETTLEMENT_INTENT_MISSING');
    if (stored.status === status && same(stored.receipt, receipt) && same(stored.event, event)
      && stored.reason === transitionReason && stored.confirmations === confirmations) return this.#view(stored);
    const record = transitionEvent({ type: 'transition', intentId, status, reason: transitionReason, receipt, event, confirmations },
      this.identity, this.confirmations, stored.intent, stored.status);
    this.#commit(record);
    return this.#view(this.#records.get(intentId)!);
  }
  recordIntent(input: unknown): SettlementIntent {
    this.#assertWritable();
    const intent = makeIntent(this.identity, input);
    const existing = this.#records.get(intent.intentId);
    if (existing) return copy(existing.intent);
    uniqueIntent(this.#records, intent);
    this.#commit({ type: 'intent', intent });
    return copy(this.#records.get(intent.intentId)!.intent);
  }
  recordBroadcast(intentId: unknown, input: unknown): SettlementView {
    this.#assertWritable();
    if (typeof intentId !== 'string') throw Error('INVALID_SETTLEMENT_INTENT_ID');
    const stored = this.#records.get(intentId);
    if (!stored) throw Error('SETTLEMENT_INTENT_MISSING');
    const broadcast = checkBroadcast(input);
    if (broadcast.sender !== stored.intent.sender || broadcast.nonce !== stored.intent.nonce) {
      throw Error('SETTLEMENT_BROADCAST_IDENTITY_MISMATCH');
    }
    const last = stored.broadcasts.at(-1);
    if (last && last.txHash === broadcast.txHash) return this.#view(stored);
    const event = checkBroadcastEvent(stored, { type: 'broadcast', intentId, broadcast, replacement: stored.broadcasts.length > 0 });
    uniqueBroadcast(this.#records, intentId, broadcast.txHash);
    this.#commit(event);
    return this.#view(this.#records.get(intentId)!);
  }
  intent(intentId: unknown): SettlementView | null {
    if (typeof intentId !== 'string') throw Error('INVALID_SETTLEMENT_INTENT_ID');
    const stored = this.#records.get(intentId);
    return stored ? this.#view(stored) : null;
  }
  intents(): readonly SettlementView[] {
    return copy([...this.#records.values()].map(stored => this.#view(stored)));
  }
  confirmedFills(): readonly ConfirmedFill[] {
    const fills: ConfirmedFill[] = [];
    for (const stored of this.#records.values()) {
      if (stored.status === 'confirmed' && stored.event) {
        fills.push({ ...stored.event, intentId: stored.intent.intentId, sender: stored.intent.sender, nonce: stored.intent.nonce });
      }
    }
    return copy(fills);
  }
  reconcile(intentId: unknown): Promise<SettlementView> {
    const run = this.#queue.then(() => this.#reconcileNow(intentId));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }
  async #reconcileNow(rawIntentId: unknown): Promise<SettlementView> {
    this.#assertWritable();
    if (typeof rawIntentId !== 'string') throw Error('INVALID_SETTLEMENT_INTENT_ID');
    const intentId = rawIntentId;
    const initial = this.#records.get(intentId);
    if (!initial) throw Error('SETTLEMENT_INTENT_MISSING');
    const active = initial.broadcasts.at(-1);
    if (!active) throw Error('SETTLEMENT_INTENT_NOT_BROADCAST');
    const activeTxHash = active.txHash;
    const candidates = [...initial.broadcasts].reverse();
    const expected = { intent: initial.intent, txHash: activeTxHash, status: initial.status,
      receipt: initial.receipt ? { ...initial.receipt } : null, confirmations: initial.confirmations };
    const reader = this.reader;
    const unchanged = () => {
      const current = this.#records.get(intentId);
      return current !== undefined && current.broadcasts.at(-1)?.txHash === activeTxHash;
    };
    if (expected.receipt && expected.status !== 'reorged') {
      const canonical = await fetched(() => reader.getCanonicalBlockHash(expected.receipt!.blockNumber));
      if (!unchanged()) throw Error('SETTLEMENT_RECONCILE_RACE');
      if (!canonical.ok || canonical.value === null) return this.#transition(intentId, 'unknown', 'CANONICAL_BLOCK_UNAVAILABLE', null, null, null);
      let canonicalHash: string;
      try { canonicalHash = hash32(canonical.value); }
      catch { return this.#transition(intentId, 'unknown', 'CANONICAL_BLOCK_INVALID', null, null, null); }
      if (canonicalHash !== expected.receipt.blockHash) {
        return this.#transition(intentId, 'reorged', 'CANONICAL_BLOCK_HASH_CHANGED', expected.receipt, null, expected.confirmations);
      }
    }
    let receiptRaw: Fetched = { ok: true, value: null };
    let unavailable = false;
    // A replacement hash is not proof that the original was dropped or could not have mined.
    for (const candidate of candidates) {
      const fetchedReceipt = await fetched(() => reader.getReceipt(candidate.txHash));
      if (!unchanged()) throw Error('SETTLEMENT_RECONCILE_RACE');
      if (!fetchedReceipt.ok) { unavailable = true; continue; }
      if (fetchedReceipt.value !== null && fetchedReceipt.value !== undefined) {
        receiptRaw = fetchedReceipt; expected.txHash = candidate.txHash; break;
      }
    }
    if (!receiptRaw.ok || receiptRaw.value === null || receiptRaw.value === undefined) {
      return this.#transition(intentId, 'unknown', unavailable ? 'RECEIPT_UNAVAILABLE' : 'RECEIPT_NOT_FOUND', null, null, null);
    }
    let receipt: ParsedReceipt;
    try { receipt = checkReceipt(receiptRaw.value, expected.txHash, expected.intent); }
    catch { return this.#transition(intentId, 'unknown', 'INVALID_RECEIPT', null, null, null); }
    const receiptIdentity: ReceiptIdentity = {
      txHash: receipt.txHash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      sender: receipt.sender, nonce: receipt.nonce,
    };
    const headRaw = await fetched(() => reader.getCanonicalHead());
    if (!unchanged()) throw Error('SETTLEMENT_RECONCILE_RACE');
    if (!headRaw.ok) return this.#transition(intentId, 'unknown', 'HEAD_UNAVAILABLE', receiptIdentity, null, null);
    let head: { number: string; hash: string };
    try { head = checkHead(headRaw.value); }
    catch { return this.#transition(intentId, 'unknown', 'INVALID_HEAD', receiptIdentity, null, null); }
    const confirmationCount = BigInt(head.number) - BigInt(receipt.blockNumber) + 1n;
    if (confirmationCount < 1n) return this.#transition(intentId, 'unknown', 'RECEIPT_AHEAD_OF_HEAD', receiptIdentity, null, null);
    if (confirmationCount > BigInt(Number.MAX_SAFE_INTEGER)) return this.#transition(intentId, 'unknown', 'CONFIRMATION_OVERFLOW', receiptIdentity, null, null);
    const confirmations = Number(confirmationCount);
    const canonicalRaw = await fetched(() => reader.getCanonicalBlockHash(receipt.blockNumber));
    if (!unchanged()) throw Error('SETTLEMENT_RECONCILE_RACE');
    if (!canonicalRaw.ok || canonicalRaw.value === null) {
      return this.#transition(intentId, 'unknown', 'CANONICAL_BLOCK_UNAVAILABLE', receiptIdentity, null, confirmations);
    }
    let canonicalHash: string;
    try { canonicalHash = hash32(canonicalRaw.value); }
    catch { return this.#transition(intentId, 'unknown', 'CANONICAL_BLOCK_INVALID', receiptIdentity, null, confirmations); }
    if (canonicalHash !== receipt.blockHash) {
      return this.#transition(intentId, 'reorged', 'CANONICAL_BLOCK_HASH_CHANGED', receiptIdentity, null, confirmations);
    }
    const pinnedHead = await fetched(() => reader.getCanonicalBlockHash(head.number));
    if (!unchanged()) throw Error('SETTLEMENT_RECONCILE_RACE');
    if (!pinnedHead.ok || pinnedHead.value !== head.hash) {
      return this.#transition(intentId, 'unknown', 'CANONICAL_HEAD_CHANGED', receiptIdentity, null, confirmations);
    }
    if (confirmations < this.confirmations) {
      return this.#transition(intentId, 'pending',
        receipt.status === 'reverted' ? 'REVERTED_AWAITING_CONFIRMATIONS' : 'CONFIRMATIONS_PENDING',
        receiptIdentity, null, confirmations);
    }
    if (receipt.status === 'reverted') return this.#transition(intentId, 'reverted', 'RECEIPT_REVERTED', receiptIdentity, null, confirmations);
    const matches = matchingLogs(this.identity, expected.intent, receipt);
    if (matches.length !== 1) {
      return this.#transition(intentId, 'unknown', matches.length === 0 ? 'SETTLEMENT_LOG_MISSING' : 'SETTLEMENT_LOG_DUPLICATE',
        receiptIdentity, null, confirmations);
    }
    const event = matches[0]!;
    if (event.size6 !== expected.intent.size6 || event.price18 !== expected.intent.price18) {
      return this.#transition(intentId, 'unknown', 'SETTLEMENT_LOG_FIELD_MISMATCH', receiptIdentity, null, confirmations);
    }
    if (!matchesEvent(this.identity, expected.intent, receiptIdentity, event)) {
      return this.#transition(intentId, 'unknown', 'SETTLEMENT_LOG_MISMATCH', receiptIdentity, null, confirmations);
    }
    // Only a canonically validated event payload exposes a genuine fill; no balances are created here.
    return this.#transition(intentId, 'confirmed', null, receiptIdentity, event, confirmations);
  }
  close() {
    if (this.#closed) return;
    closeSync(this.fd); this.#closed = true;
    if (!this.#failed) unlinkSync(this.lock); // Unknown writes retain the lock for explicit operator reconciliation.
  }
}
