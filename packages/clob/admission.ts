import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem';
import { decimal, exact, trader, type Command, type Order } from './engine.ts';
import type { JournaledMatcher, Binding } from './journal.ts';

// Manual-book schema v1. These exact types must also be enforced by Phase 3 settlement.
export const ORDER_TYPES = { Order: [
  { name: 'trader', type: 'address' }, { name: 'marketId', type: 'uint32' },
  { name: 'side', type: 'uint8' }, { name: 'kind', type: 'uint8' },
  { name: 'size6', type: 'uint128' }, { name: 'limitPrice18', type: 'uint128' },
  { name: 'leverage', type: 'uint32' }, { name: 'maxFeeBps', type: 'uint16' },
  { name: 'nonce', type: 'uint64' }, { name: 'expiry', type: 'uint64' },
  { name: 'reduceOnly', type: 'bool' }, { name: 'postOnly', type: 'bool' }, { name: 'ioc', type: 'bool' },
] } as const;
export const CANCEL_TYPES = { Cancel: [
  { name: 'trader', type: 'address' }, { name: 'orderHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint64' }, { name: 'expiry', type: 'uint64' },
] } as const;
const AUTH_TYPES = { ...ORDER_TYPES, ...CANCEL_TYPES } as const;
export interface SignedOrder extends Omit<Order, 'id'> { leverage: number; maxFeeBps: number }
export interface Cancellation { trader: string; orderHash: Hex; nonce: string; expiry: number }
const orderKeys = ['trader', 'marketId', 'side', 'kind', 'size6', 'limitPrice18', 'leverage', 'maxFeeBps', 'nonce', 'expiry', 'reduceOnly', 'postOnly', 'ioc'];
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw Error('ADMISSION_INTEGER_BOUNDS');
}
function expiry(v: unknown, now: number) { integer(now, 0, 4_294_967_295); integer(v, now + 1, Math.min(now + 86400, 4_294_967_295)); }
export function admissionDomain(binding: Binding) {
  exact(binding, ['chainId', 'marketId', 'settlementContract']);
  if (binding.chainId !== 43113) throw Error('FUJI_ONLY');
  integer(binding.marketId, 1, 8);
  if (binding.settlementContract === null) throw Error('SETTLEMENT_DOMAIN_UNAVAILABLE');
  trader(binding.settlementContract);
  return { name: 'Avensdex', version: '1', chainId: 43113, verifyingContract: binding.settlementContract as Hex } as const;
}
export function orderTypedData(binding: Binding, input: unknown, now: number) {
  const domain = admissionDomain(binding); exact(input, orderKeys);
  trader(input.trader); decimal(input.nonce, (1n << 64n) - 1n);
  decimal(input.size6, 10n ** 15n); decimal(input.limitPrice18, 10n ** 27n); expiry(input.expiry, now);
  // Absolute bounds only: actual initial margin, allowed flags and fees remain contract-enforced.
  integer(input.leverage, 1, 10000); integer(input.maxFeeBps, 0, 10000);
  if (input.marketId !== binding.marketId || !['buy', 'sell'].includes(input.side as string)
    || !['limit', 'market'].includes(input.kind as string)
    || [input.reduceOnly, input.postOnly, input.ioc].some(v => typeof v !== 'boolean')
    || (input.postOnly && (input.kind === 'market' || input.ioc))
    || (input.kind === 'market' && !input.ioc)) throw Error('INVALID_SIGNED_ORDER');
  const o = input as unknown as SignedOrder;
  return { domain, types: AUTH_TYPES, primaryType: 'Order', message: {
    trader: o.trader as Hex, marketId: o.marketId, side: o.side === 'buy' ? 0 : 1, kind: o.kind === 'limit' ? 0 : 1,
    size6: BigInt(o.size6), limitPrice18: BigInt(o.limitPrice18), leverage: o.leverage, maxFeeBps: o.maxFeeBps,
    nonce: BigInt(o.nonce), expiry: BigInt(o.expiry), reduceOnly: o.reduceOnly, postOnly: o.postOnly, ioc: o.ioc,
  } } as const;
}
export function cancelTypedData(binding: Binding, input: unknown, now: number) {
  const domain = admissionDomain(binding); exact(input, ['trader', 'orderHash', 'nonce', 'expiry']);
  trader(input.trader); decimal(input.nonce, (1n << 64n) - 1n); expiry(input.expiry, now);
  if (typeof input.orderHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(input.orderHash) || /^0x0+$/.test(input.orderHash)) throw Error('INVALID_ORDER_HASH');
  const c = input as unknown as Cancellation;
  return { domain, types: AUTH_TYPES, primaryType: 'Cancel', message: {
    trader: c.trader as Hex, orderHash: c.orderHash, nonce: BigInt(c.nonce), expiry: BigInt(c.expiry),
  } } as const;
}
function signature(input: unknown): asserts input is Hex {
  if (typeof input !== 'string' || !/^0x[0-9a-f]{130}$/.test(input)) throw Error('INVALID_SIGNATURE_ENCODING');
  const r = BigInt(`0x${input.slice(2, 66)}`), s = BigInt(`0x${input.slice(66, 130)}`), v = input.slice(130);
  if (r === 0n || r >= N || s === 0n || s > N / 2n || !['1b', '1c'].includes(v)) throw Error('NON_CANONICAL_SIGNATURE');
}
export async function verifyAdmission(binding: Binding, input: unknown, now: number) {
  // Keep all validated values stable across asynchronous signature recovery.
  const envelope: unknown = structuredClone(input);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw Error('INVALID_ENVELOPE');
  const type = (envelope as { type?: unknown }).type;
  exact(envelope, type === 'order' ? ['type', 'order', 'signature'] : ['type', 'cancel', 'signature']);
  if (type !== 'order' && type !== 'cancel') throw Error('INVALID_ADMISSION_TYPE');
  signature(envelope.signature);
  const typed = type === 'order' ? orderTypedData(binding, envelope.order, now) : cancelTypedData(binding, envelope.cancel, now);
  const authorizationHash = hashTypedData(typed);
  const recovered = (await recoverTypedDataAddress({ ...typed, signature: envelope.signature })).toLowerCase();
  if (recovered !== typed.message.trader) throw Error('SIGNER_MISMATCH');
  let command: Command;
  if (type === 'order') {
    const { leverage: _leverage, maxFeeBps: _maxFeeBps, ...order } = envelope.order as SignedOrder;
    command = { type: 'submit', at: now, order: { id: authorizationHash, ...order } };
  } else {
    const cancel = envelope.cancel as Cancellation;
    command = { type: 'cancel', at: now, id: cancel.orderHash, trader: cancel.trader };
  }
  return { command, proof: { version: 1, domain: typed.domain, authorizationHash, envelope } };
}

// Trusted in-process ingress only. The executable cannot enable network trading before Phase 3.
export async function admitSigned(journal: JournaledMatcher, input: unknown, now: number) {
  const verified = await verifyAdmission(journal.binding, input, now);
  const command = verified.command;
  if (command.type === 'cancel') {
    const target = journal.snapshot().orders.find(o => o.id === command.id);
    const cancel = verified.proof.envelope.cancel as Cancellation;
    if (!target || target.nonce !== cancel.nonce || target.trader !== cancel.trader) throw Error('CANCEL_TARGET_MISMATCH');
  }
  const events = journal.apply(verified.command, verified.proof);
  return { seq: journal.snapshot().seq, events };
}
