# Independent price and funding boundary

`contracts/evm/src/AvensOracle.sol` is a **local qualification adapter**, not a qualified Fuji feed or adaptive funding controller. Construction allows local chain 31337 or Fuji 43113, but publishing on Fuji is disabled. Mainnet is rejected. No public activation or external price source is established by this module.

## Roles and units

The immutable price publisher and funding publisher must be nonzero, distinct from each other and distinct from the deployer. Neither has vault token-payout authority. Market identity (1–8), deployment chain and maximum source age (1–3,600 seconds) are immutable. A later public adapter requires independently verified source identities, freshness, trust and feed behavior; matcher-generated observations cannot substitute for an independent source.

`publishPrice(price18, sourceTimestamp)` preserves the supplied source timestamp. It rejects nonpositive or above-1e27 prices, zero/future/stale timestamps and timestamp rollback. `price(marketId)` rechecks chain, market and source age on every read; it never restamps old data or uses a chart fallback. A trusted publisher can lie, so these guards do not eliminate publisher trust.

`setFundingRate(ratePrice18PerSecond, validUntil)` commits a signed price-index delta per second. Its absolute magnitude cannot exceed 1% of the current independent price per hour, with integer rounding down. The independent price must be fresh, and expiry must be strictly future and at most one hour away. This is a finite local test bound, not an economic admission rule or a profitability claim.

Before updating a rate, the adapter checkpoints the previous rate only through its expiry. It does not accrue during expired gaps. Renewal starts at the renewal time, preserves the old cumulative index and cannot retroactively charge the gap. Sign reversal, same-block rate replacement and zero rates conserve the accumulated index. `fundingIndex(marketId)` returns the cumulative signed index18 and explicit rate expiry, rejecting uninitialized funding or stale prices. Expired initialized funding returns its frozen terminal index and original past expiry: settlement still rejects it for fills, but may use it for existing-position exits. Settlement must apply that index to each pair's canonical vault margins before closing or liquidation.

The adapter does not implement adaptive premium calculation, smoothing, epochs, independent mark validation or economic opportunity admission. Those remain Phase 4/5 work; matched long-open-interest minus short-open-interest is not a funding premium signal.

## Checks

```sh
forge test --root contracts/evm --match-path test/AvensOracle.t.sol
```

Seven local Foundry tests pass, including a 1,000-case funding checkpoint/sign-conservation property. They cover independent roles, configuration/mainnet/Fuji guards, source freshness/future/rollback, wrong market, rate bounds/initialization/expiry, sign reversal and expired-gap renewal without backfill. They do not qualify a public token/feed/venue or establish public transaction evidence.
