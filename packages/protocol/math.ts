// Stateless reference for size6, price18/index18 and collateral6; never credits custody.
export const PRICE_SCALE = 10n ** 18n;
export const MAX_PRICE = 10n ** 27n;
export const U128_MAX = (1n << 128n) - 1n;
export const I128_MAX = (1n << 127n) - 1n;
export const I128_MIN = -(1n << 127n);
export interface Pair {
  size6: bigint; entryPrice18: bigint; longMargin6: bigint; shortMargin6: bigint;
  lastFundingIndex18: bigint; fundingRemainder: bigint;
}
function integer(value: bigint, low: bigint, high: bigint) {
  if (typeof value !== 'bigint' || value < low || value > high) throw Error('integer outside bounds');
}
function price(value: bigint) { integer(value, 1n, MAX_PRICE); }
function signed(value: bigint) { integer(value, I128_MIN, I128_MAX); }
function validate(p: Pair) {
  integer(p.size6, 1n, U128_MAX); price(p.entryPrice18);
  integer(p.longMargin6, 0n, I128_MAX); integer(p.shortMargin6, 0n, I128_MAX);
  integer(p.longMargin6 + p.shortMargin6, 0n, I128_MAX);
  signed(p.lastFundingIndex18); integer(p.fundingRemainder, -PRICE_SCALE + 1n, PRICE_SCALE - 1n);
}
function clamp(value: bigint, low: bigint, high: bigint) { return value < low ? low : value > high ? high : value; }
function factor(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 6 || decimals > 24) throw Error('unsupported decimals');
  return 10n ** BigInt(decimals - 6);
}
export function toRawBase(size6: bigint, decimals: number) {
  integer(size6, 0n, U128_MAX); return size6 * factor(decimals);
}
export function fromRawBase(raw: bigint, decimals: number) {
  integer(raw, 0n, (1n << 256n) - 1n);
  const scale = factor(decimals), size6 = raw / scale;
  integer(size6, 0n, U128_MAX); return { size6, dust: raw % scale };
}
export function mulDiv128(a: bigint, b: bigint, divisor: bigint) {
  integer(a, 0n, U128_MAX); integer(b, 0n, U128_MAX); integer(divisor, 1n, U128_MAX);
  const result = a * b / divisor; integer(result, 0n, U128_MAX); return result;
}
export function notional6(size6: bigint, price18: bigint) { price(price18); return mulDiv128(size6, price18, PRICE_SCALE); }
export function signedAmount6(size6: bigint, delta18: bigint) {
  integer(size6, 0n, U128_MAX); signed(delta18);
  const result = size6 * delta18 / PRICE_SCALE;
  integer(result, -I128_MAX, I128_MAX); return result;
}
export function payout(p: Pair, price18: bigint) {
  validate(p); price(price18);
  const pnl6 = clamp(signedAmount6(p.size6, price18 - p.entryPrice18), -p.longMargin6, p.shortMargin6);
  return { longPayout6: p.longMargin6 + pnl6, shortPayout6: p.shortMargin6 - pnl6, pnl6 };
}
export function fundingSettlement(p: Pair, index18: bigint) {
  validate(p); signed(index18);
  const delta = index18 - p.lastFundingIndex18; signed(delta);
  signedAmount6(p.size6, delta);
  const numerator = p.size6 * delta + p.fundingRemainder;
  const owed = numerator / PRICE_SCALE; integer(owed, -I128_MAX, I128_MAX);
  const payment6 = clamp(owed, -p.shortMargin6, p.longMargin6);
  return { payment6, remainder: payment6 === owed ? numerator % PRICE_SCALE : 0n };
}
export function splitPair(p: Pair, amount6: bigint) {
  validate(p); integer(amount6, 1n, p.size6);
  const part = { ...p, size6: amount6, longMargin6: p.longMargin6 * amount6 / p.size6,
    shortMargin6: p.shortMargin6 * amount6 / p.size6, fundingRemainder: 0n };
  const remaining = { ...p, size6: p.size6 - amount6, longMargin6: p.longMargin6 - part.longMargin6,
    shortMargin6: p.shortMargin6 - part.shortMargin6,
    fundingRemainder: p.fundingRemainder * (p.size6 - amount6) / p.size6 };
  return { part, remaining };
}
export function liquidatable(p: Pair, price18: bigint, maintenanceBps: number) {
  maintenance(maintenanceBps);
  const equity = payout(p, price18), value = notional6(p.size6, price18) * BigInt(maintenanceBps) / 10_000n;
  const required = value > 0n ? value : 1n;
  return { longUnsafe: equity.longPayout6 <= required, shortUnsafe: equity.shortPayout6 <= required };
}
export function liquidationPrice18(p: Pair, maintenanceBps: number, isLong: boolean) {
  validate(p); maintenance(maintenanceBps);
  const entry = notional6(p.size6, p.entryPrice18);
  const numerator = isLong ? (entry > p.longMargin6 ? entry - p.longMargin6 : 0n) : entry + p.shortMargin6;
  const rate = BigInt(isLong ? 10_000 - maintenanceBps : 10_000 + maintenanceBps);
  const result = numerator * PRICE_SCALE * 10_000n / (p.size6 * rate);
  integer(result, 0n, U128_MAX); return result;
}
export function openingFee6(notional: bigint) {
  integer(notional, 0n, U128_MAX); return (notional * 3n + 9_999n) / 10_000n;
}
function maintenance(bps: number) {
  if (!Number.isInteger(bps) || bps <= 0 || bps >= 10_000) throw Error('invalid maintenance');
}
