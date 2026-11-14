// Market-aware formatting for the single AVAX-PERP market (2dp price, 2dp size).

import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKETS } from "@/config";
import { formatMarketPrice, formatMarketSize, formatMarketUsd, priceFor, sizeFor, toPriceInput } from "./format";

const AVAX = MARKETS["AVAX-PERP"];

test("AVAX renders 2dp", () => {
  assert.equal(formatMarketPrice(AVAX, 27.5), "27.50");
  assert.equal(formatMarketUsd(AVAX, 27.5), "$27.50");
});

test("bigint prices are treated as 1e18", () => {
  assert.equal(formatMarketUsd(AVAX, 27500000000000000000n), "$27.50");
});

test("formatMarketUsd renders a dash for absent or non-positive values", () => {
  assert.equal(formatMarketUsd(AVAX, null), "—");
  assert.equal(formatMarketUsd(AVAX, undefined), "—");
  assert.equal(formatMarketUsd(AVAX, 0n), "—");
});

test("sizes use the market's sizeDecimals", () => {
  assert.equal(formatMarketSize(AVAX, 12.345), "12.35");
});

test("toPriceInput rounds a typed price to the market's precision", () => {
  assert.equal(toPriceInput(AVAX, 27.545), "27.55");
});

test("priceFor / sizeFor resolve by market id", () => {
  assert.equal(priceFor(AVAX.marketId, 27.5), "$27.50");
  assert.equal(sizeFor(AVAX.marketId, 12.345), "12.35");
});

test("an unknown market id falls back to 4dp rather than throwing", () => {
  assert.equal(priceFor(9999, 1.23456789), "$1.2346");
  assert.equal(sizeFor(9999, 1.23456789), "1.2346");
});

test("every market's finest tick is distinguishable at its own precision", () => {
  for (const m of Object.values(MARKETS)) {
    const tick = m.tickSizes[0];
    const a = formatMarketPrice(m, 1 + tick);
    const b = formatMarketPrice(m, 1 + 2 * tick);
    assert.notEqual(a, b, `${m.symbol}: priceDecimals ${m.priceDecimals} cannot separate consecutive ${tick} ticks`);
  }
});
