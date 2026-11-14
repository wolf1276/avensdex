import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, SCALE, nextRate, premium, ema } from './preview.ts';
import { initialState, publishEpoch, configureController, accrueIndex, fundingValidUntil, isExpired, INTERVAL, refreshObservations } from './controller.ts';

const PRICE = 100n * 10n ** 18n;
const observation = (now = 3600n, sign = 1n) => ({ indexPrice: PRICE, indexTimestamp: now,
  markPrice: PRICE + sign * PRICE * 1200n / SCALE, markTimestamp: now, now });
const initial = () => initialState('ADAPTIVE', defaults, 3599n, PRICE, 3599n);

for (const sign of [1n, -1n]) {
  test(`publication matches existing premium/EMA/rate math for sign ${sign}`, () => {
    const obs = observation(3600n, sign);
    const result = publishEpoch(initial(), obs);
    const sample = premium(obs.indexPrice, obs.markPrice, obs.indexTimestamp, obs.markTimestamp, obs.now);
    assert.equal(result.premiumSample, sample);
    assert.equal(result.smoothedPremium, ema(sample, undefined));
    assert.equal(result.ratePpm, nextRate('ADAPTIVE', sample, 0n));
    assert.equal(result.ratePpm > 0n, sign > 0n);
    const next = publishEpoch(result.state, observation(7200n, sign));
    assert.equal(next.smoothedPremium, ema(sample, sample));
    assert(next.ratePpm <= defaults.cap_ppm && next.ratePpm >= -defaults.cap_ppm);
    assert(next.ratePpm - result.ratePpm <= defaults.step_ppm);
    assert(next.ratePpm - result.ratePpm >= -defaults.step_ppm);
  });

  test(`split accrual preserves fractional index carry for sign ${sign}`, () => {
    const state = publishEpoch(initial(), observation(3600n, sign)).state;
    // Use a price with fractional per-second index accrual.
    state.indexPrice += 17n;
    const once = accrueIndex(state, 3660n);
    let split = state;
    for (let now = 3601n; now <= 3660n; now++) split = accrueIndex(split, now);
    assert.equal(split.fundingIndex, once.fundingIndex);
    assert.equal(split.fundingRemainder, once.fundingRemainder);
    const numerator = state.indexPrice * state.fundingRatePpm * 60n;
    assert.equal(once.fundingIndex, numerator / (SCALE * INTERVAL));
    assert.equal(once.fundingRemainder, numerator % (SCALE * INTERVAL));
  });
}

for (const sign of [1n, -1n]) {
  test(`observation refresh preserves epoch math and excludes stale gaps for sign ${sign}`, () => {
    const state = publishEpoch(initial(), observation(3600n, sign)).state;
    const terminal = accrueIndex(state, 3660n);
    const refreshed = refreshObservations(state, { ...observation(3800n, sign), indexPrice: PRICE + 17n }, 1);
    assert.equal(refreshed.fundingIndex, terminal.fundingIndex);
    assert.equal(refreshed.fundingRemainder, terminal.fundingRemainder);
    assert.equal(refreshed.rateAppliedAt, state.rateAppliedAt);
    assert.equal(refreshed.lastEpoch, state.lastEpoch);
    assert.equal(refreshed.fundingRatePpm, state.fundingRatePpm);
    assert.equal(refreshed.premiumEma, state.premiumEma);
    const accrued = accrueIndex(refreshed, 3810n);
    assert.equal(refreshed.fundingUpdatedAt, 3800n);
    assert.equal(fundingValidUntil(refreshed), 3860n);
    assert.equal(isExpired(refreshed, 3859n), false);
    assert.equal(isExpired(refreshed, 3860n), true);
    const numerator = state.fundingRatePpm * (PRICE * 60n + (PRICE + 17n) * 10n);
    assert.equal(accrued.fundingIndex, numerator / (SCALE * INTERVAL));
    assert.equal(accrued.fundingRemainder, numerator % (SCALE * INTERVAL));
    assert.throws(() => refreshObservations(refreshed, observation(3800n, sign), 1));
    assert.throws(() => refreshObservations(refreshed, observation(3810n, sign), 2));
    assert.throws(() => refreshObservations(refreshed, observation(7200n, sign), 1));
  });
}

test('reference accrual rejects either int128 overflow like the contract', () => {
  for (const sign of [1n, -1n]) {
    const state = publishEpoch(initial(), observation(3600n, sign)).state;
    state.fundingIndex = sign > 0n ? (1n << 127n) - 1n : -(1n << 127n);
    assert.throws(() => accrueIndex(state, 3601n), /overflow/);
  }
});

test('stale index, stale mark and excessive premium disable the rate', () => {
  for (const change of [{ indexTimestamp: 3500n }, { markTimestamp: 3200n }, { markPrice: PRICE * 2n }]) {
    const result = publishEpoch(initial(), { ...observation(), ...change });
    assert.equal(result.fallback, true);
    assert.equal(result.ratePpm, 0n);
    assert.equal(result.smoothedPremium, null);
  }
});

test('future/invalid observations and repeated epochs are rejected', () => {
  for (const change of [{ indexPrice: 0n }, { markPrice: 10n ** 28n }, { indexTimestamp: 3601n }, { markTimestamp: -1n }]) {
    assert.throws(() => publishEpoch(initial(), { ...observation(), ...change }));
  }
  const result = publishEpoch(initial(), observation());
  assert.throws(() => publishEpoch(result.state, observation()), /epoch/);
  assert.throws(() => publishEpoch(result.state, observation(3599n)), /epoch/);
});

test('all transitions reject time reversal, including before first publication', () => {
  assert.throws(() => publishEpoch(initial(), observation(3598n)), /monotonic/);
  assert.throws(() => accrueIndex(initial(), 3598n), /monotonic/);
  assert.throws(() => configureController(initial(), 'BASELINE', defaults, 1, 3598n), /monotonic/);
});

test('oracle freshness and rate expiry bound accrual without stale-gap backfill', () => {
  const state = publishEpoch(initial(), observation()).state;
  assert.equal(fundingValidUntil(state), 3660n);
  assert.equal(isExpired(state, 3659n), false);
  assert.equal(isExpired(state, 3660n), true);
  const bounded = accrueIndex(state, 3660n);
  const late = accrueIndex(state, 10000n);
  assert.equal(late.fundingIndex, bounded.fundingIndex);
  assert.equal(late.fundingRemainder, bounded.fundingRemainder);
  const renewed = publishEpoch(late, observation(10800n)).state;
  assert.equal(renewed.fundingIndex, bounded.fundingIndex);
});

test('configuration validates mode/revision, snapshots parameters and consumes epoch', () => {
  const params = { ...defaults };
  const state = initialState('ADAPTIVE', params, 3599n, PRICE, 3599n);
  params.cap_ppm = 1n;
  assert.equal(state.params.cap_ppm, defaults.cap_ppm);
  assert.throws(() => initialState('BAD' as 'ADAPTIVE', defaults, 0n, PRICE, 0n), /mode/);
  assert.throws(() => configureController(state, 'BASELINE', defaults, 2, 3600n), /revision/);
  assert.throws(() => configureController(state, 'BAD' as 'ADAPTIVE', defaults, 1, 3600n), /mode/);
  const config = configureController(state, 'BASELINE', defaults, 1, 3600n);
  assert.equal(config.revision, 2);
  assert.equal(config.fundingRatePpm, 0n);
  assert.throws(() => publishEpoch(config, observation()), /epoch/);
  const baseline = publishEpoch(config, observation(7200n));
  assert.equal(baseline.ratePpm, 1200n);
});

test('deadband is inactive and large valid premiums obey adaptive caps', () => {
  const neutral = publishEpoch(initial(), { ...observation(), markPrice: PRICE + PRICE * 100n / SCALE });
  assert.equal(neutral.ratePpm, 0n);
  const extreme = publishEpoch(initial(), { ...observation(), markPrice: PRICE * 110n / 100n });
  assert.equal(extreme.ratePpm, defaults.step_ppm);
});
