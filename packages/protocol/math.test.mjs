import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as m from './math.ts';
const pair = () => ({ size6: 10_000n, entryPrice18: 100n * m.PRICE_SCALE, longMargin6: 10_000_000n,
  shortMargin6: 10_000_000n, lastFundingIndex18: 0n, fundingRemainder: 0n });
function settle(p, index) {
  const { payment6, remainder } = m.fundingSettlement(p, index);
  return { ...p, longMargin6: p.longMargin6 - payment6, shortMargin6: p.shortMargin6 + payment6,
    lastFundingIndex18: index, fundingRemainder: remainder };
}
test('original source accounting vectors retain funding, caps and payout rounding', () => {
  const vectors = JSON.parse(readFileSync(new URL('./accounting-vectors.json', import.meta.url)));
  for (const v of vectors) {
    const b = Object.fromEntries(Object.entries(v).map(([k, value]) => [k, BigInt(value)]));
    const p = { size6: b.size, entryPrice18: b.entry, longMargin6: b.longMargin, shortMargin6: b.shortMargin,
      lastFundingIndex18: b.checkpoint, fundingRemainder: b.remainder };
    assert.deepEqual(m.fundingSettlement(p, b.index), { payment6: b.payment, remainder: b.nextRemainder });
    const paid = m.payout(settle(p, b.index), b.price);
    assert.equal(paid.longPayout6, b.longPayout); assert.equal(paid.shortPayout6, b.shortPayout);
  }
});
test('raw base conversion floors hedge size and preserves owner dust at 6/8/18/24 decimals', () => {
  for (const decimals of [6, 8, 18, 24]) {
    const factor = 10n ** BigInt(decimals - 6), raw = m.toRawBase(1_000_000n, decimals);
    const dust = factor - 1n;
    assert.deepEqual(m.fromRawBase(raw + dust, decimals), { size6: 1_000_000n, dust });
  }
  assert.equal(m.toRawBase(1_000_000n, 18), 10n ** 18n);
  for (const decimals of [0, 5, 25, 18.1, NaN]) assert.throws(() => m.toRawBase(1n, decimals));
  assert.throws(() => m.fromRawBase(m.U128_MAX + 1n, 6));
});
test('wide unsigned products, signed truncation and opening fee ceiling', () => {
  assert.equal(m.mulDiv128(m.U128_MAX, m.U128_MAX, m.U128_MAX), m.U128_MAX);
  assert.throws(() => m.mulDiv128(m.U128_MAX, m.U128_MAX, 1n));
  assert.throws(() => m.mulDiv128(1n, 1n, 0n));
  assert.equal(m.signedAmount6(1n, -m.PRICE_SCALE + 1n), 0n);
  assert.equal(m.openingFee6(1n), 1n); assert.equal(m.openingFee6(10_000n), 3n);
  assert.equal(m.notional6(1_000_000n, 100n * m.PRICE_SCALE), 100_000_000n);
  for (const price of [0n, m.MAX_PRICE + 1n]) assert.throws(() => m.notional6(1n, price));
});
test('frequent funding settlement keeps fractional carry and cannot pay twice', () => {
  let p = pair(); const original = p;
  for (let n = 1n; n <= 100n; n++) {
    p = settle(p, n * 1_000_000_000_000n);
    const replay = settle(p, p.lastFundingIndex18);
    assert.deepEqual(replay, p);
  }
  assert.equal(original.longMargin6 - p.longMargin6, 1n);
  assert.equal(p.fundingRemainder, 0n);
  for (const index of [50_000_000_000_000n, 0n]) p = settle(p, index);
  assert.deepEqual(p, original);
});
test('partial close floors both margins and retains dust in the remaining pair', () => {
  const p = { ...pair(), size6: 3n, longMargin6: 10n, shortMargin6: 11n, fundingRemainder: -10n };
  const { part, remaining } = m.splitPair(p, 1n);
  assert.equal(part.longMargin6, 3n); assert.equal(part.shortMargin6, 3n);
  assert.equal(remaining.longMargin6, 7n); assert.equal(remaining.shortMargin6, 8n);
  assert.equal(remaining.fundingRemainder, -6n);
  const full = m.splitPair(p, 3n);
  assert.equal(full.remaining.size6, 0n); assert.equal(full.remaining.longMargin6, 0n);
  assert.equal(full.remaining.shortMargin6, 0n); assert.equal(full.remaining.fundingRemainder, 0n);
  assert.throws(() => m.splitPair(p, 0n)); assert.throws(() => m.splitPair(p, 4n));
});
test('liquidation uses capped equity and inclusive maintenance threshold', () => {
  const p = { ...pair(), size6: 1_000_000n, longMargin6: 10_000_000n, shortMargin6: 10_000_000n };
  assert.deepEqual(m.liquidatable(p, 100n * m.PRICE_SCALE, 500), { longUnsafe: false, shortUnsafe: false });
  assert.deepEqual(m.liquidatable(p, 90n * m.PRICE_SCALE, 500), { longUnsafe: true, shortUnsafe: false });
  assert.equal(m.liquidationPrice18(p, 500, true), 90n * m.PRICE_SCALE * 10_000n / 9500n);
  assert.equal(m.liquidationPrice18(p, 500, false), 110n * m.PRICE_SCALE * 10_000n / 10500n);
  assert.throws(() => m.liquidatable(p, 100n * m.PRICE_SCALE, 10_000));
});
test('seeded settlement and capped payouts conserve collateral across both signs', () => {
  let seed = 0x6176656en;
  const next = () => (seed = (seed * 6364136223846793005n + 1n) & ((1n << 64n) - 1n));
  for (let scenario = 0; scenario < 100; scenario++) {
    let p = { ...pair(), size6: next() % 1_000_000_000n + 1n,
      longMargin6: next() % 1_000_000_000n, shortMargin6: next() % 1_000_000_000n };
    const total = p.longMargin6 + p.shortMargin6;
    for (let step = 0; step < 100; step++) {
      const delta = (next() % 2_000_000_000_000n) - 1_000_000_000_000n;
      p = settle(p, p.lastFundingIndex18 + delta);
      assert.equal(p.longMargin6 + p.shortMargin6, total);
      const payout = m.payout(p, (next() % 200n + 1n) * m.PRICE_SCALE);
      assert.equal(payout.longPayout6 + payout.shortPayout6, total);
      assert(payout.longPayout6 >= 0n && payout.shortPayout6 >= 0n);
    }
  }
});
test('invalid numeric and signed boundaries fail closed', () => {
  for (const p of [{ ...pair(), size6: 0n }, { ...pair(), longMargin6: m.I128_MAX, shortMargin6: 1n },
    { ...pair(), fundingRemainder: m.PRICE_SCALE }, { ...pair(), size6: 1 }]) {
    assert.throws(() => m.payout(p, 100n * m.PRICE_SCALE));
  }
  assert.throws(() => m.fundingSettlement({ ...pair(), lastFundingIndex18: m.I128_MIN }, m.I128_MAX));
  assert.throws(() => m.signedAmount6(m.U128_MAX, m.I128_MAX));
});
