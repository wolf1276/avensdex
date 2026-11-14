import { encodeFunctionData, keccak256, type Hex, type PublicClient } from 'viem';
import { exact, decimal } from './engine.ts';
import { validate as validateParams, premium, type Params } from '../funding/preview.ts';

const MAX_BLOCK = (1n << 64n) - 1n;
const MAX_UINT32 = 4_294_967_295;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_PRICE18 = 10n ** 27n;
const MAX_PPM = 2000n;
const INT128_MIN = -(1n << 127n);
const INT128_MAX = (1n << 127n) - 1n;
const INT256_MIN = -(1n << 255n);
const INT256_MAX = (1n << 255n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

const settlementAbi = [
  { type: 'function', name: 'deploymentId', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'oracle', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'marketId', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint32' }] },
  { type: 'function', name: 'deploymentChainId', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint256' }] },
] as const;

const oracleAbi = [
  { type: 'function', name: 'marketId', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint32' }] },
  { type: 'function', name: 'deploymentChainId', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'fundingPublisher', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'indexSource', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'markSource', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'indexSourceCodeHash', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'markSourceCodeHash', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'params', stateMutability: 'view', inputs: [], outputs: [
    { type: 'int256' }, { type: 'int256' }, { type: 'int256' }, { type: 'int256' }, { type: 'int256' },
    { type: 'int256' }, { type: 'int256' }, { type: 'int256' }, { type: 'int256' }, { type: 'int256' },
  ] },
  { type: 'function', name: 'mode', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'revision', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'hasLastEpoch', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'lastEpoch', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'fundingRatePpm', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'int256' }] },
  { type: 'function', name: 'premiumEma', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'int256' }] },
  { type: 'function', name: 'rateValidUntil', stateMutability: 'view', inputs: [],
    outputs: [{ name: '', type: 'uint64' }] },
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [{ name: 'market', type: 'uint32' }],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'price18', type: 'uint128' }, { name: 'sourceTimestamp', type: 'uint64' }] }] },
  { type: 'function', name: 'fundingIndex', stateMutability: 'view', inputs: [{ name: 'market', type: 'uint32' }],
    outputs: [{ name: '', type: 'int128' }, { name: '', type: 'uint64' }] },
] as const;

const priceAbi = [
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [{ name: 'market', type: 'uint32' }],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'price18', type: 'uint128' }, { name: 'sourceTimestamp', type: 'uint64' }] }] },
] as const;

const publishAbi = [
  { type: 'function', name: 'publish', stateMutability: 'nonpayable', inputs: [
    { name: 'expectedRevision', type: 'uint256' }, { name: 'expectedEpoch', type: 'uint256' }] },
] as const;

interface BlockInfo { number: bigint; hash: Hex; timestamp: number }

function hash32(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0+$/i.test(value)) throw Error('INVALID_FUNDING_HASH');
  return value.toLowerCase() as Hex;
}
function address(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0+$/i.test(value)) throw Error('INVALID_FUNDING_ADDRESS');
  return value.toLowerCase() as Hex;
}
function block(value: unknown): BlockInfo {
  if (!value || typeof value !== 'object') throw Error('INVALID_FUNDING_BLOCK');
  const raw = value as Record<string, unknown>;
  let n: bigint;
  if (typeof raw.number === 'bigint') n = raw.number;
  else if (typeof raw.number === 'number' && Number.isSafeInteger(raw.number)) n = BigInt(raw.number);
  else if (typeof raw.number === 'string' && /^(0|[1-9][0-9]*)$/.test(raw.number)) n = BigInt(raw.number);
  else throw Error('INVALID_FUNDING_BLOCK');
  if (n < 0n || n > MAX_BLOCK) throw Error('INVALID_FUNDING_BLOCK');
  const h = hash32(raw.hash);
  let t: number;
  if (typeof raw.timestamp === 'bigint') {
    if (raw.timestamp < 0n || raw.timestamp > BigInt(MAX_SAFE)) throw Error('INVALID_FUNDING_TIME');
    t = Number(raw.timestamp);
  } else if (typeof raw.timestamp === 'number') {
    if (!Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0 || raw.timestamp > MAX_SAFE) throw Error('INVALID_FUNDING_TIME');
    t = raw.timestamp;
  } else if (typeof raw.timestamp === 'string' && /^(0|[1-9][0-9]*)$/.test(raw.timestamp)) {
    const bi = BigInt(raw.timestamp);
    if (bi > BigInt(MAX_SAFE)) throw Error('INVALID_FUNDING_TIME');
    t = Number(bi);
  } else throw Error('INVALID_FUNDING_TIME');
  return { number: n, hash: h, timestamp: t };
}
function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw Error(label);
}
function asInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw Error(label);
}
function asNumber(value: unknown, label: string, max = MAX_SAFE): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(max)) throw Error(label);
    return Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw Error(label);
    return value;
  }
  throw Error(label);
}
function asBool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw Error(label);
  return value;
}
function asPrice(value: unknown, label: string): { price18: bigint; sourceTimestamp: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(label);
  const raw = value as Record<string, unknown>;
  const p = raw.price18 !== undefined ? raw.price18 : raw[0];
  const t = raw.sourceTimestamp !== undefined ? raw.sourceTimestamp : raw[1];
  const price18 = asBigInt(p, label);
  const sourceTimestamp = asNumber(t, label);
  if (price18 <= 0n || price18 > MAX_PRICE18) throw Error(label);
  return { price18, sourceTimestamp };
}
function asFundingIndex(value: unknown, label: string): { index18: bigint; validUntil: number } {
  if (Array.isArray(value)) {
    if (value.length !== 2) throw Error(label);
    const index18 = asInt(value[0], label);
    const validUntil = asNumber(value[1], label);
    if (index18 < INT128_MIN || index18 > INT128_MAX) throw Error(label);
    return { index18, validUntil };
  }
  if (!value || typeof value !== 'object') throw Error(label);
  const raw = value as Record<string, unknown>;
  const i = raw.index18 !== undefined ? raw.index18 : raw[0];
  const v = raw.validUntil !== undefined ? raw.validUntil : raw[1];
  const index18 = asInt(i, label);
  const validUntil = asNumber(v, label);
  if (index18 < INT128_MIN || index18 > INT128_MAX) throw Error(label);
  return { index18, validUntil };
}

function checkedParams(input: unknown): Params {
  if (!Array.isArray(input) || input.length !== 10) throw Error('INVALID_FUNDING_PARAMS');
  const values = input.map(value => decimal(value, UINT256_MAX, true));
  const params = { version: Number(values[0]), cap_ppm: values[1]!, step_ppm: values[2]!, deadband_ppm: values[3]!,
    smoothing_ppm: values[4]!, ema_alpha_ppm: values[5]!, nonlinear_scale_ppm: values[6]!,
    max_premium_ppm: values[7]!, oracle_max_age_sec: values[8]!, mark_max_age_sec: values[9]! };
  validateParams(params);
  return params;
}

function validateInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_FUNDING_INPUT');
  const keys = Object.keys(input).sort();
  const expected = ['chainId', 'confirmations', 'deploymentId', 'marketId', 'now', 'oracleCodeHash', 'oracleContract', 'settlementContract'].sort();
  if (keys.length !== expected.length || keys.join(',') !== expected.join(',')) throw Error('INVALID_FUNDING_INPUT');
  const v = input as Record<string, unknown>;
  if (typeof v.chainId !== 'number' || !Number.isSafeInteger(v.chainId) || (v.chainId !== 31337 && v.chainId !== 43113)) throw Error('INVALID_FUNDING_IDENTITY');
  hash32(v.deploymentId);
  address(v.settlementContract);
  address(v.oracleContract);
  hash32(v.oracleCodeHash);
  if (typeof v.marketId !== 'number' || !Number.isSafeInteger(v.marketId) || v.marketId < 1 || v.marketId > 8) throw Error('INVALID_FUNDING_MARKET');
  if (typeof v.confirmations !== 'number' || !Number.isSafeInteger(v.confirmations) || v.confirmations < 1 || v.confirmations > 1000) throw Error('INVALID_FUNDING_CONFIRMATIONS');
  if (typeof v.now !== 'number' || !Number.isSafeInteger(v.now) || v.now < 0 || v.now > MAX_UINT32) throw Error('INVALID_FUNDING_TIME');
  return {
    chainId: v.chainId,
    deploymentId: hash32(v.deploymentId),
    settlementContract: address(v.settlementContract),
    oracleContract: address(v.oracleContract),
    oracleCodeHash: hash32(v.oracleCodeHash),
    marketId: v.marketId,
    confirmations: v.confirmations,
    now: v.now,
  };
}

async function verifyChain(client: PublicClient, chainId: number) {
  if (await client.getChainId() !== chainId) throw Error('FUNDING_RPC_CHAIN_MISMATCH');
}

interface Collected {
  chainId: number;
  selectedBlock: BlockInfo;
  settlement: {
    codeHash: Hex;
    deploymentId: Hex;
    oracle: Hex;
    marketId: number;
    deploymentChainId: number;
  };
  oracle: {
    codeHash: Hex;
    marketId: number;
    deploymentChainId: number;
    fundingPublisher: Hex;
    indexSource: Hex;
    markSource: Hex;
    indexSourceCodeHash: Hex;
    markSourceCodeHash: Hex;
    mode: number;
    parameters: readonly string[];
    revision: string;
    hasLastEpoch: boolean;
    lastEpoch: string;
    fundingRatePpm: string;
    premiumEma: string;
    rateValidUntil: number;
    oraclePrice: { price18: string; sourceTimestamp: number };
    fundingIndex: { index18: string; validUntil: number };
    indexSourceCodeHashCurrent: Hex;
    markSourceCodeHashCurrent: Hex;
    indexSourcePrice: { price18: string; sourceTimestamp: number };
    markSourcePrice: { price18: string; sourceTimestamp: number };
  };
}

async function collect(client: PublicClient, chainId: number, marketId: number, selected: BlockInfo, input: ReturnType<typeof validateInput>): Promise<Collected> {
  await verifyChain(client, chainId);
  const bn = selected.number;
  const settlementAddress = input.settlementContract;
  const oracleAddress = input.oracleContract;

  const settlementCode = await client.getCode({ address: settlementAddress, blockNumber: bn });
  if (!settlementCode || settlementCode === '0x') throw Error('FUNDING_SETTLEMENT_CODE_MISSING');
  const settlementCodeHash = keccak256(settlementCode);
  const settlementDeploymentId = hash32(await client.readContract({ address: settlementAddress, abi: settlementAbi, functionName: 'deploymentId', blockNumber: bn }));
  const settlementOracle = address(await client.readContract({ address: settlementAddress, abi: settlementAbi, functionName: 'oracle', blockNumber: bn }));
  const settlementMarketId = asNumber(await client.readContract({ address: settlementAddress, abi: settlementAbi, functionName: 'marketId', blockNumber: bn }), 'INVALID_FUNDING_MARKET');
  const settlementChainId = asNumber(await client.readContract({ address: settlementAddress, abi: settlementAbi, functionName: 'deploymentChainId', blockNumber: bn }), 'INVALID_FUNDING_CHAIN');

  const oracleCode = await client.getCode({ address: oracleAddress, blockNumber: bn });
  if (!oracleCode || oracleCode === '0x') throw Error('FUNDING_ORACLE_CODE_MISSING');
  const oracleCodeHashCurrent = keccak256(oracleCode);
  const oracleMarketId = asNumber(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'marketId', blockNumber: bn }), 'INVALID_FUNDING_MARKET');
  const oracleChainId = asNumber(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'deploymentChainId', blockNumber: bn }), 'INVALID_FUNDING_CHAIN');
  const fundingPublisher = address(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'fundingPublisher', blockNumber: bn }));
  const indexSource = address(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'indexSource', blockNumber: bn }));
  const markSource = address(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'markSource', blockNumber: bn }));
  const indexSourceCodeHash = hash32(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'indexSourceCodeHash', blockNumber: bn }));
  const markSourceCodeHash = hash32(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'markSourceCodeHash', blockNumber: bn }));
  const mode = asNumber(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'mode', blockNumber: bn }), 'INVALID_FUNDING_MODE', 1);
  const parametersRaw = await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'params', blockNumber: bn });
  if (!Array.isArray(parametersRaw) || parametersRaw.length !== 10 || parametersRaw.some(value => typeof value !== 'bigint')) throw Error('INVALID_FUNDING_PARAMS');
  const parameters = parametersRaw.map(value => value.toString());
  checkedParams(parameters);
  const revisionRaw = await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'revision', blockNumber: bn });
  const revision = asBigInt(revisionRaw, 'INVALID_FUNDING_REVISION').toString();
  if (asBigInt(revisionRaw, 'INVALID_FUNDING_REVISION') < 1n || asBigInt(revisionRaw, 'INVALID_FUNDING_REVISION') > UINT256_MAX) throw Error('INVALID_FUNDING_REVISION');
  const hasLastEpoch = asBool(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'hasLastEpoch', blockNumber: bn }), 'INVALID_FUNDING_EPOCH');
  const lastEpochRaw = await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'lastEpoch', blockNumber: bn });
  const lastEpoch = asBigInt(lastEpochRaw, 'INVALID_FUNDING_EPOCH').toString();
  const fundingRatePpmRaw = await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'fundingRatePpm', blockNumber: bn });
  const fundingRatePpmBig = asInt(fundingRatePpmRaw, 'INVALID_FUNDING_PPM');
  if (fundingRatePpmBig < -MAX_PPM || fundingRatePpmBig > MAX_PPM) throw Error('INVALID_FUNDING_PPM');
  const fundingRatePpm = fundingRatePpmBig.toString();
  const premiumEmaRaw = await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'premiumEma', blockNumber: bn });
  const premiumEmaBig = asInt(premiumEmaRaw, 'INVALID_FUNDING_PREMIUM');
  if (premiumEmaBig < INT256_MIN || premiumEmaBig > INT256_MAX) throw Error('INVALID_FUNDING_PREMIUM');
  const premiumEma = premiumEmaBig.toString();
  const rateValidUntil = asNumber(await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'rateValidUntil', blockNumber: bn }), 'INVALID_FUNDING_TIME');

  const oraclePriceRaw = await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'price', args: [marketId], blockNumber: bn });
  const oraclePrice = asPrice(oraclePriceRaw, 'INVALID_FUNDING_PRICE');
  const fundingIndexRaw = await client.readContract({ address: oracleAddress, abi: oracleAbi, functionName: 'fundingIndex', args: [marketId], blockNumber: bn });
  const fundingIndex = asFundingIndex(fundingIndexRaw, 'INVALID_FUNDING_INDEX');

  const indexSourceCode = await client.getCode({ address: indexSource, blockNumber: bn });
  const markSourceCode = await client.getCode({ address: markSource, blockNumber: bn });
  if (!indexSourceCode || indexSourceCode === '0x') throw Error('FUNDING_INDEX_SOURCE_CODE_MISSING');
  if (!markSourceCode || markSourceCode === '0x') throw Error('FUNDING_MARK_SOURCE_CODE_MISSING');
  const indexSourceCodeHashCurrent = keccak256(indexSourceCode);
  const markSourceCodeHashCurrent = keccak256(markSourceCode);

  const indexPriceRaw = await client.readContract({ address: indexSource, abi: priceAbi, functionName: 'price', args: [marketId], blockNumber: bn });
  const indexPrice = asPrice(indexPriceRaw, 'INVALID_FUNDING_PRICE');
  const markPriceRaw = await client.readContract({ address: markSource, abi: priceAbi, functionName: 'price', args: [marketId], blockNumber: bn });
  const markPrice = asPrice(markPriceRaw, 'INVALID_FUNDING_PRICE');

  return {
    chainId,
    selectedBlock: selected,
    settlement: {
      codeHash: settlementCodeHash,
      deploymentId: settlementDeploymentId,
      oracle: settlementOracle,
      marketId: settlementMarketId,
      deploymentChainId: settlementChainId,
    },
    oracle: {
      codeHash: oracleCodeHashCurrent,
      marketId: oracleMarketId,
      deploymentChainId: oracleChainId,
      fundingPublisher,
      indexSource,
      markSource,
      indexSourceCodeHash,
      markSourceCodeHash,
      mode,
      parameters,
      revision,
      hasLastEpoch,
      lastEpoch,
      fundingRatePpm,
      premiumEma,
      rateValidUntil,
      oraclePrice: { price18: oraclePrice.price18.toString(), sourceTimestamp: oraclePrice.sourceTimestamp },
      fundingIndex: { index18: fundingIndex.index18.toString(), validUntil: fundingIndex.validUntil },
      indexSourceCodeHashCurrent,
      markSourceCodeHashCurrent,
      indexSourcePrice: { price18: indexPrice.price18.toString(), sourceTimestamp: indexPrice.sourceTimestamp },
      markSourcePrice: { price18: markPrice.price18.toString(), sourceTimestamp: markPrice.sourceTimestamp },
    },
  };
}

export async function readFundingSnapshot(primary: PublicClient, secondary: PublicClient, input: unknown) {
  const validated = validateInput(input);

  // Read both heads, choose slower provider.
  const [pChain, sChain] = await Promise.all([primary.getChainId(), secondary.getChainId()]);
  if (pChain !== validated.chainId || sChain !== validated.chainId) throw Error('FUNDING_RPC_CHAIN_MISMATCH');
  const [pHeadRaw, sHeadRaw] = await Promise.all([primary.getBlock({ blockTag: 'latest' }), secondary.getBlock({ blockTag: 'latest' })]);
  const pHead = block(pHeadRaw);
  const sHead = block(sHeadRaw);
  if (pHead.number === sHead.number && pHead.hash !== sHead.hash) throw Error('FUNDING_HEAD_DISAGREEMENT');
  const minHead = pHead.number <= sHead.number ? pHead : sHead;
  const selectedNumber = minHead.number - BigInt(validated.confirmations) + 1n;
  if (selectedNumber < 0n) throw Error('FUNDING_CONFIRMATION_DEPTH_ROLLBACK');

  const [pSelRaw, sSelRaw] = await Promise.all([
    primary.getBlock({ blockNumber: selectedNumber }),
    secondary.getBlock({ blockNumber: selectedNumber }),
  ]);
  const pSel = block(pSelRaw);
  const sSel = block(sSelRaw);
  if (pSel.number !== selectedNumber || sSel.number !== selectedNumber
    || pSel.hash !== sSel.hash || pSel.timestamp !== sSel.timestamp) throw Error('FUNDING_BLOCK_DISAGREEMENT');
  const selectedBlock = pSel;
  if (selectedBlock.timestamp > validated.now || validated.now - selectedBlock.timestamp > 60) {
    if (selectedBlock.timestamp > validated.now) throw Error('FUNDING_SOURCE_FUTURE');
    throw Error('FUNDING_SOURCE_STALE');
  }

  const [left, right] = await Promise.all([
    collect(primary, validated.chainId, validated.marketId, selectedBlock, validated),
    collect(secondary, validated.chainId, validated.marketId, selectedBlock, validated),
  ]);
  const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
  if (JSON.stringify(left, replacer) !== JSON.stringify(right, replacer)) throw Error('FUNDING_PROVIDER_DISAGREEMENT');

  const c = left;
  // Validate settlement identity.
  if (c.settlement.codeHash === ('0x' + '0'.repeat(64))) throw Error('FUNDING_SETTLEMENT_CODE_MISSING');
  if (c.settlement.deploymentId !== validated.deploymentId) throw Error('FUNDING_DEPLOYMENT_MISMATCH');
  if (c.settlement.oracle !== validated.oracleContract) throw Error('FUNDING_SETTLEMENT_ORACLE_MISMATCH');
  if (c.settlement.marketId !== validated.marketId) throw Error('FUNDING_SETTLEMENT_MARKET_MISMATCH');
  if (c.settlement.deploymentChainId !== validated.chainId) throw Error('FUNDING_SETTLEMENT_CHAIN_MISMATCH');
  // Oracle identity.
  if (c.oracle.codeHash !== validated.oracleCodeHash) throw Error('FUNDING_ORACLE_CODE_MISMATCH');
  if (c.oracle.marketId !== validated.marketId) throw Error('FUNDING_ORACLE_MARKET_MISMATCH');
  if (c.oracle.deploymentChainId !== validated.chainId) throw Error('FUNDING_ORACLE_CHAIN_MISMATCH');
  if (c.oracle.indexSource === c.oracle.markSource) throw Error('FUNDING_SOURCE_IDENTITY');
  if (c.oracle.indexSourceCodeHash !== c.oracle.indexSourceCodeHashCurrent) throw Error('FUNDING_INDEX_SOURCE_CODE_CHANGED');
  if (c.oracle.markSourceCodeHash !== c.oracle.markSourceCodeHashCurrent) throw Error('FUNDING_MARK_SOURCE_CODE_CHANGED');
  // Mode.
  if (c.oracle.mode !== 0 && c.oracle.mode !== 1) throw Error('INVALID_FUNDING_MODE');
  // Price validations.
  const parameters = checkedParams(c.oracle.parameters);
  const blockTime = validated.now;
  const oraclePrice = c.oracle.oraclePrice;
  if (oraclePrice.sourceTimestamp === 0 || oraclePrice.sourceTimestamp > selectedBlock.timestamp
    || blockTime - oraclePrice.sourceTimestamp > Number(parameters.oracle_max_age_sec)) throw Error('FUNDING_ORACLE_PRICE_STALE');
  const indexPrice = c.oracle.indexSourcePrice;
  if (indexPrice.sourceTimestamp === 0 || indexPrice.sourceTimestamp > selectedBlock.timestamp
    || blockTime - indexPrice.sourceTimestamp > Number(parameters.oracle_max_age_sec)) throw Error('FUNDING_INDEX_PRICE_STALE');
  const markPrice = c.oracle.markSourcePrice;
  if (markPrice.sourceTimestamp === 0 || markPrice.sourceTimestamp > selectedBlock.timestamp
    || blockTime - markPrice.sourceTimestamp > Number(parameters.mark_max_age_sec)) throw Error('FUNDING_MARK_PRICE_STALE');
  if (oraclePrice.price18 !== indexPrice.price18 || oraclePrice.sourceTimestamp !== indexPrice.sourceTimestamp) throw Error('FUNDING_ORACLE_PRICE_MISMATCH');
  if (c.oracle.fundingIndex.validUntil !== c.oracle.rateValidUntil) throw Error('FUNDING_EXPIRY_MISMATCH');
  const rate = BigInt(c.oracle.fundingRatePpm), smoothed = BigInt(c.oracle.premiumEma);
  if (rate < -parameters.cap_ppm || rate > parameters.cap_ppm || smoothed < -parameters.max_premium_ppm
    || smoothed > parameters.max_premium_ppm || BigInt(c.oracle.lastEpoch) < 0n
    || BigInt(c.oracle.lastEpoch) > BigInt(Math.floor(selectedBlock.timestamp / 3600))) throw Error('FUNDING_STATE_BOUNDS');

  // Finish recheck paired selected block + heads depth + chains.
  const [rpChain, rsChain] = await Promise.all([primary.getChainId(), secondary.getChainId()]);
  if (rpChain !== validated.chainId || rsChain !== validated.chainId) throw Error('FUNDING_RPC_CHAIN_MISMATCH');
  const [rpHeadRaw, rsHeadRaw] = await Promise.all([primary.getBlock({ blockTag: 'latest' }), secondary.getBlock({ blockTag: 'latest' })]);
  const rpHead = block(rpHeadRaw);
  const rsHead = block(rsHeadRaw);
  if (rpHead.number === rsHead.number && rpHead.hash !== rsHead.hash) throw Error('FUNDING_HEAD_DISAGREEMENT');
  const rMin = rpHead.number <= rsHead.number ? rpHead.number : rsHead.number;
  const [rpSelRaw, rsSelRaw] = await Promise.all([primary.getBlock({ blockNumber: selectedNumber }), secondary.getBlock({ blockNumber: selectedNumber })]);
  const rpSel = block(rpSelRaw);
  const rsSel = block(rsSelRaw);
  if (rpSel.number !== selectedNumber || rsSel.number !== selectedNumber
    || rpSel.hash !== selectedBlock.hash || rsSel.hash !== selectedBlock.hash
    || rpSel.timestamp !== selectedBlock.timestamp || rsSel.timestamp !== selectedBlock.timestamp) throw Error('FUNDING_BLOCK_DISAGREEMENT');
  const depth = rMin - selectedNumber + 1n;
  if (depth < BigInt(validated.confirmations)) throw Error('FUNDING_CONFIRMATION_DEPTH_ROLLBACK');

  const fundingAvailable = validated.now < c.oracle.rateValidUntil;

  return Object.freeze({
    chainId: validated.chainId,
    marketId: validated.marketId,
    deploymentId: validated.deploymentId,
    settlementContract: validated.settlementContract,
    oracleContract: validated.oracleContract,
    blockNumber: selectedBlock.number.toString(),
    blockHash: selectedBlock.hash,
    sourceTime: selectedBlock.timestamp,
    oracleCodeHash: c.oracle.codeHash,
    fundingPublisher: c.oracle.fundingPublisher,
    indexSource: c.oracle.indexSource,
    markSource: c.oracle.markSource,
    indexSourceCodeHash: c.oracle.indexSourceCodeHash,
    markSourceCodeHash: c.oracle.markSourceCodeHash,
    mode: c.oracle.mode,
    parameters: Object.freeze([...c.oracle.parameters]),
    revision: c.oracle.revision,
    hasLastEpoch: c.oracle.hasLastEpoch,
    lastEpoch: c.oracle.lastEpoch,
    fundingRatePpm: c.oracle.fundingRatePpm,
    premiumEma: c.oracle.premiumEma,
    rateValidUntil: c.oracle.rateValidUntil,
    indexPrice18: c.oracle.indexSourcePrice.price18,
    indexSourceTime: c.oracle.indexSourcePrice.sourceTimestamp,
    markPrice18: c.oracle.markSourcePrice.price18,
    markSourceTime: c.oracle.markSourcePrice.sourceTimestamp,
    fundingIndex18: c.oracle.fundingIndex.index18,
    fundingValidUntil: c.oracle.fundingIndex.validUntil,
    fundingAvailable,
  });
}

export function buildFundingPublication(snapshot: unknown, now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_UINT32) throw Error('INVALID_FUNDING_TIME');
  exact(snapshot, ['chainId', 'marketId', 'deploymentId', 'settlementContract', 'oracleContract', 'blockNumber', 'blockHash',
    'sourceTime', 'oracleCodeHash', 'fundingPublisher', 'indexSource', 'markSource', 'indexSourceCodeHash', 'markSourceCodeHash',
    'mode', 'parameters', 'revision', 'hasLastEpoch', 'lastEpoch', 'fundingRatePpm', 'premiumEma', 'rateValidUntil',
    'indexPrice18', 'indexSourceTime', 'markPrice18', 'markSourceTime', 'fundingIndex18', 'fundingValidUntil', 'fundingAvailable']);
  if (snapshot.chainId !== 31337 && snapshot.chainId !== 43113) throw Error('INVALID_FUNDING_IDENTITY');
  hash32(snapshot.deploymentId); hash32(snapshot.blockHash); hash32(snapshot.oracleCodeHash);
  hash32(snapshot.indexSourceCodeHash); hash32(snapshot.markSourceCodeHash);
  address(snapshot.settlementContract);
  if (address(snapshot.indexSource) === address(snapshot.markSource)) throw Error('FUNDING_SOURCE_IDENTITY');
  decimal(snapshot.blockNumber, MAX_BLOCK, true);
  asNumber(snapshot.marketId, 'INVALID_FUNDING_MARKET', 8);
  if (snapshot.marketId === 0 || (snapshot.mode !== 0 && snapshot.mode !== 1)) throw Error('INVALID_FUNDING_MODE');
  const sourceTime = asNumber(snapshot.sourceTime, 'INVALID_FUNDING_TIME', MAX_UINT32);
  if (sourceTime > now || now - sourceTime > 60) throw Error('FUNDING_SOURCE_STALE');
  const params = checkedParams(snapshot.parameters);
  const indexAt = asNumber(snapshot.indexSourceTime, 'INVALID_FUNDING_TIME', sourceTime);
  const markAt = asNumber(snapshot.markSourceTime, 'INVALID_FUNDING_TIME', sourceTime);
  if (indexAt === 0 || markAt === 0) throw Error('INVALID_FUNDING_TIME');
  premium(decimal(snapshot.indexPrice18, MAX_PRICE18), decimal(snapshot.markPrice18, MAX_PRICE18),
    BigInt(indexAt), BigInt(markAt), BigInt(now), params);
  const revision = decimal(snapshot.revision, UINT256_MAX);
  const lastEpoch = decimal(snapshot.lastEpoch, BigInt(Math.floor(sourceTime / 3600)), true);
  const hasLastEpoch = asBool(snapshot.hasLastEpoch, 'INVALID_FUNDING_EPOCH');
  const currentEpoch = BigInt(Math.floor(now / 3600));
  if (hasLastEpoch && currentEpoch <= lastEpoch) throw Error('FUNDING_EPOCH_REPLAY');
  const rate = asInt(snapshot.fundingRatePpm, 'INVALID_FUNDING_PPM');
  if (rate < -params.cap_ppm || rate > params.cap_ppm) throw Error('INVALID_FUNDING_PPM');
  const smoothed = asInt(snapshot.premiumEma, 'INVALID_FUNDING_PREMIUM');
  if (smoothed < -params.max_premium_ppm || smoothed > params.max_premium_ppm) throw Error('INVALID_FUNDING_PREMIUM');
  const index = asInt(snapshot.fundingIndex18, 'INVALID_FUNDING_INDEX');
  if (index < INT128_MIN || index > INT128_MAX) throw Error('INVALID_FUNDING_INDEX');
  const until = asNumber(snapshot.rateValidUntil, 'INVALID_FUNDING_TIME');
  if (until !== snapshot.fundingValidUntil || typeof snapshot.fundingAvailable !== 'boolean') throw Error('FUNDING_EXPIRY_MISMATCH');
  return Object.freeze({
    from: address(snapshot.fundingPublisher), to: address(snapshot.oracleContract), value: '0', chainId: snapshot.chainId,
    data: encodeFunctionData({ abi: publishAbi, functionName: 'publish', args: [revision, currentEpoch] }),
    expectedRevision: revision.toString(), expectedEpoch: currentEpoch.toString(),
    expiresAt: Number((currentEpoch + 1n) * 3600n), approvalRequired: true, executionEnabled: false,
  });
}
