import { keccak256, parseAbi, type Hex, type PublicClient } from 'viem';
import { verifyAdmission, type SignedOrder } from '../../packages/clob/admission.ts';
import { exact, trader } from '../../packages/clob/engine.ts';
import type { Binding } from '../../packages/clob/journal.ts';

export interface AdmissionDeployment {
  chainId: 43113; marketId: 1; deploymentId: Hex; vault: Hex; settlement: Hex; oracle: Hex;
  vaultCodeHash: Hex; settlementCodeHash: Hex; oracleCodeHash: Hex; confirmations: number;
}
const abi = parseAbi([
  'function deploymentId() view returns (bytes32)', 'function settlementModule() view returns (address)',
  'function vault() view returns (address)', 'function oracle() view returns (address)',
  'function marketId() view returns (uint32)', 'function depositsActive() view returns (bool)',
  'function entriesPaused() view returns (bool)', 'function activationReady() view returns (bool)',
  'function depositCap6() view returns (uint128)',
  'function accounting() view returns (uint256 custody, uint256 liabilities, uint256 surplus)',
  'function cancelled(bytes32) view returns (bool)', 'function filledSize6(bytes32) view returns (uint128)',
  'function minimumNonce(address) view returns (uint256)',
  'function nonceHash(address,uint64) view returns (bytes32)',
  'function reservation(bytes32) view returns ((address owner,uint128 amount6))',
]);
const zero = `0x${'0'.repeat(64)}`;
export function createAdmissionGate(primary: PublicClient, secondary: PublicClient, input: AdmissionDeployment, clock = () => Math.floor(Date.now() / 1000)) {
  const config = Object.freeze(structuredClone(input));
  exact(config, ['chainId', 'marketId', 'deploymentId', 'vault', 'settlement', 'oracle', 'vaultCodeHash', 'settlementCodeHash', 'oracleCodeHash', 'confirmations']);
  if (config.chainId !== 43113 || config.marketId !== 1 || !Number.isInteger(config.confirmations)
    || config.confirmations < 3 || config.confirmations > 100) throw Error('INVALID_ADMISSION_DEPLOYMENT');
  for (const address of [config.vault, config.settlement, config.oracle]) trader(address);
  for (const value of [config.deploymentId, config.vaultCodeHash, config.settlementCodeHash, config.oracleCodeHash]) {
    if (!/^0x[0-9a-f]{64}$/.test(value) || value === zero) throw Error('INVALID_ADMISSION_PIN');
  }
  const binding: Binding = { chainId: 43113, marketId: 1, settlementContract: config.settlement };
  return Object.freeze({ binding, async check(envelope?: unknown) {
    const proof = envelope === undefined ? null : await verifyAdmission(binding, envelope, clock());
    const order = proof?.proof.envelope.type === 'order' ? proof.proof.envelope.order as SignedOrder : null;
    if (order && (order.kind !== 'limit' || order.reduceOnly || order.postOnly || order.ioc || order.leverage > 10 || order.maxFeeBps < 3)) {
      throw Error('UNSUPPORTED_CONTRACT_ORDER');
    }
    const clients = [primary, secondary];
    if ((await Promise.all(clients.map(c => c.getChainId()))).some(chain => chain !== 43113)) throw Error('FUJI_ONLY');
    const heads = await Promise.all(clients.map(c => c.getBlockNumber({ cacheTime: 0 })));
    const head = heads[0]! < heads[1]! ? heads[0]! : heads[1]!;
    if (head < BigInt(config.confirmations - 1)) throw Error('INSUFFICIENT_CONFIRMATIONS');
    const blockNumber = head - BigInt(config.confirmations - 1);
    const headers = await Promise.all(clients.map(c => c.getBlock({ blockNumber })));
    const blockHash = headers[0]!.hash, sourceTime = Number(headers[0]!.timestamp);
    const fresh = () => Number.isSafeInteger(clock()) && clock() >= sourceTime && clock() - sourceTime <= 60;
    if (!blockHash || headers.some(h => h.hash !== blockHash || h.timestamp !== headers[0]!.timestamp || h.number !== blockNumber) || !fresh()) throw Error('CANONICAL_SOURCE_UNAVAILABLE');
    const read = async (address: Hex, functionName: string, args: readonly unknown[] = []) => {
      const values = await Promise.all(clients.map(c => c.readContract({ address, abi, functionName, args, blockNumber } as never)));
      const encode = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
      if (encode(values[0]) !== encode(values[1])) throw Error('ADMISSION_PROVIDER_DISAGREEMENT');
      return values[0] as unknown;
    };
    for (const [address, pin] of [[config.vault, config.vaultCodeHash], [config.settlement, config.settlementCodeHash], [config.oracle, config.oracleCodeHash]] as const) {
      const codes = await Promise.all(clients.map(c => c.getCode({ address, blockNumber })));
      if (codes.some(code => !code || code === '0x' || keccak256(code) !== pin)) throw Error('ADMISSION_RUNTIME_MISMATCH');
    }
    const expected = [[config.vault, 'deploymentId', config.deploymentId], [config.settlement, 'deploymentId', config.deploymentId],
      [config.vault, 'settlementModule', config.settlement], [config.settlement, 'vault', config.vault],
      [config.settlement, 'oracle', config.oracle], [config.settlement, 'marketId', 1]] as const;
    for (const [address, name, value] of expected) {
      const actual = await read(address, name);
      if (typeof actual === 'string' ? actual.toLowerCase() !== value : actual !== value) throw Error('ADMISSION_BINDING_MISMATCH');
    }
    const cap = await read(config.vault, 'depositCap6') as bigint;
    if (cap <= 0n || cap > 10_000_000n) throw Error('ADMISSION_CAP_MISMATCH');
    await read(config.vault, 'accounting'); // Contract checks canonical conservation and custody itself.
    if (!proof || order) {
      if (await read(config.vault, 'depositsActive') !== true || await read(config.vault, 'entriesPaused') !== false
        || await read(config.settlement, 'activationReady') !== true) throw Error('FUJI_ENTRIES_UNAVAILABLE');
    }
    if (order && proof) {
      const hash = proof.proof.authorizationHash;
      const [cancelled, filled, minimum, nonceHash, reservation] = await Promise.all([
        read(config.settlement, 'cancelled', [hash]), read(config.settlement, 'filledSize6', [hash]),
        read(config.settlement, 'minimumNonce', [order.trader]), read(config.settlement, 'nonceHash', [order.trader, BigInt(order.nonce)]),
        read(config.vault, 'reservation', [hash]),
      ]);
      if (cancelled !== false || filled !== 0n || BigInt(order.nonce) < (minimum as bigint)
        || nonceHash !== hash) throw Error('ORDER_CHAIN_STATE_UNAVAILABLE');
      const notional = BigInt(order.size6) * BigInt(order.limitPrice18) / 10n ** 18n;
      const leverage = BigInt(order.leverage);
      const required = (notional + leverage - 1n) / leverage + (notional * 3n + 9999n) / 10000n;
      const escrow = reservation as { owner: string; amount6: bigint };
      if (!escrow || escrow.owner.toLowerCase() !== order.trader || required <= 0n || escrow.amount6 < required) throw Error('CANONICAL_ORDER_ESCROW_REQUIRED');
    }
    const finalHeaders = await Promise.all(clients.map(c => c.getBlock({ blockNumber })));
    if (!fresh() || finalHeaders.some(h => h.hash !== blockHash || Number(h.timestamp) !== sourceTime || h.number !== blockNumber)) throw Error('ADMISSION_CANONICAL_SOURCE_CHANGED');
    return { blockNumber: blockNumber.toString(), blockHash, sourceTime, settlement: 'unavailable' as const };
  } });
}
export type AdmissionGate = ReturnType<typeof createAdmissionGate>;
