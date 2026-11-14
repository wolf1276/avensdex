// Deterministic funding controller reference. Pure state transitions only: no custody,
// signing, broadcast, activation or deployment authority. Reuses packages/funding/preview.ts math.
import {
  defaults,
  validate as validateParams,
  premium,
  ema,
  nextRate,
  type Params,
  SCALE,
} from './preview.ts';

export const INTERVAL = 3600n;
export const MAX_PRICE = 10n ** 27n;

export type Mode = 'BASELINE' | 'ADAPTIVE';

export interface Observation {
  indexPrice: bigint;
  indexTimestamp: bigint;
  markPrice: bigint;
  markTimestamp: bigint;
  now: bigint;
}

export interface ControllerState {
  mode: Mode;
  params: Params;
  revision: number;
  lastEpoch: bigint | null;
  rateAppliedAt: bigint;
  premiumEma: bigint | null;
  fallback: boolean;
  fundingRatePpm: bigint;
  fundingIndex: bigint;
  fundingRemainder: bigint;
  fundingUpdatedAt: bigint;
  indexPrice: bigint;
  indexTimestamp: bigint;
}

export interface PublishResult {
  state: ControllerState;
  epoch: bigint;
  ratePpm: bigint;
  premiumSample: bigint | null;
  smoothedPremium: bigint | null;
  fallback: boolean;
}

export class FundingControllerError extends Error {}

function epochOf(timestamp: bigint): bigint {
  if (timestamp < 0n) throw new FundingControllerError('negative timestamp');
  return timestamp / INTERVAL;
}

function positivePrice(value: bigint): boolean {
  return value > 0n && value <= MAX_PRICE;
}

function accrue(state: ControllerState, now: bigint): ControllerState {
  if (now < state.fundingUpdatedAt || state.indexTimestamp > now || state.rateAppliedAt > now) {
    throw new FundingControllerError('non-monotonic timestamp');
  }
  const oracleEnd = state.indexTimestamp + state.params.oracle_max_age_sec;
  const rateEnd = state.rateAppliedAt + INTERVAL;
  let end = now;
  if (end > oracleEnd) end = oracleEnd;
  if (end > rateEnd) end = rateEnd;
  if (end <= state.fundingUpdatedAt) return { ...state, fundingUpdatedAt: now };
  const elapsed = end - state.fundingUpdatedAt;
  const numerator = state.indexPrice * state.fundingRatePpm * elapsed + state.fundingRemainder;
  const denominator = SCALE * INTERVAL;
  const delta = numerator / denominator;
  return {
    ...state,
    fundingIndex: state.fundingIndex + delta,
    fundingRemainder: numerator % denominator,
    fundingUpdatedAt: now,
  };
}

export function initialState(
  mode: Mode,
  params: Params = defaults,
  now: bigint,
  indexPrice: bigint,
  indexTimestamp: bigint,
): ControllerState {
  validateParams(params);
  if (mode !== 'BASELINE' && mode !== 'ADAPTIVE') throw new FundingControllerError('unknown mode');
  if (!positivePrice(indexPrice) || indexTimestamp < 0n || indexTimestamp > now) {
    throw new FundingControllerError('invalid initial observation');
  }
  return {
    mode,
    params: Object.freeze({ ...params }),
    revision: 1,
    lastEpoch: null,
    rateAppliedAt: now,
    premiumEma: null,
    fallback: true,
    fundingRatePpm: 0n,
    fundingIndex: 0n,
    fundingRemainder: 0n,
    fundingUpdatedAt: now,
    indexPrice,
    indexTimestamp,
  };
}

export function fundingValidUntil(state: ControllerState): bigint {
  return state.rateAppliedAt + INTERVAL;
}

export function isExpired(state: ControllerState, now: bigint): boolean {
  return now >= fundingValidUntil(state);
}

export function publishEpoch(state: ControllerState, observation: Observation): PublishResult {
  validateParams(state.params);
  if (!positivePrice(observation.indexPrice) || !positivePrice(observation.markPrice)) {
    throw new FundingControllerError('invalid price');
  }
  if (
    observation.indexTimestamp < 0n ||
    observation.markTimestamp < 0n ||
    observation.indexTimestamp > observation.now ||
    observation.markTimestamp > observation.now
  ) {
    throw new FundingControllerError('invalid or future timestamp');
  }
  const now = observation.now;
  const epoch = epochOf(now);
  if (state.lastEpoch !== null && epoch <= state.lastEpoch) {
    throw new FundingControllerError('funding epoch already applied or replayed');
  }

  let next = accrue(state, now);
  next = { ...next, indexPrice: observation.indexPrice, indexTimestamp: observation.indexTimestamp };

  let premiumSample: bigint | null = null;
  let smoothedPremium: bigint | null = next.premiumEma;
  let fallback = next.fallback;
  let rate = 0n;
  try {
    const sample = premium(
      observation.indexPrice,
      observation.markPrice,
      observation.indexTimestamp,
      observation.markTimestamp,
      now,
      next.params,
    );
    premiumSample = sample;
    const smoothed = ema(sample, smoothedPremium ?? undefined, next.params);
    smoothedPremium = smoothed;
    fallback = false;
    rate = nextRate(next.mode, smoothed, next.fundingRatePpm, next.params);
  } catch {
    premiumSample = null;
    smoothedPremium = null;
    fallback = true;
    rate = 0n;
  }

  next = {
    ...next,
    fundingRatePpm: rate,
    premiumEma: smoothedPremium,
    fallback,
    rateAppliedAt: now,
    lastEpoch: epoch,
    fundingUpdatedAt: now,
  };

  return { state: next, epoch, ratePpm: rate, premiumSample, smoothedPremium, fallback };
}

export function configureController(
  state: ControllerState,
  mode: Mode,
  params: Params,
  expectedRevision: number,
  now: bigint,
  indexPrice?: bigint,
  indexTimestamp?: bigint,
): ControllerState {
  validateParams(params);
  if (mode !== 'BASELINE' && mode !== 'ADAPTIVE') throw new FundingControllerError('unknown mode');
  if (expectedRevision !== state.revision) {
    throw new FundingControllerError('configuration revision mismatch');
  }
  if (now < 0n) throw new FundingControllerError('negative timestamp');
  let next = accrue(state, now);
  const ip = indexPrice ?? next.indexPrice;
  const it = indexTimestamp ?? next.indexTimestamp;
  if (!positivePrice(ip) || it < 0n || it > now) {
    throw new FundingControllerError('invalid observation');
  }
  const revision = expectedRevision + 1;
  if (!Number.isSafeInteger(revision)) throw new FundingControllerError('revision overflow');
  return {
    ...next,
    mode,
    params: Object.freeze({ ...params }),
    revision,
    lastEpoch: epochOf(now),
    rateAppliedAt: now,
    premiumEma: null,
    fallback: true,
    fundingRatePpm: 0n,
    fundingUpdatedAt: now,
    indexPrice: ip,
    indexTimestamp: it,
  };
}

export function accrueIndex(state: ControllerState, now: bigint): ControllerState {
  return accrue(state, now);
}
