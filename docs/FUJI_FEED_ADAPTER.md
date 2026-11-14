# Independent two-feed oracle implementation

`AvensFeedOracle` implements BASE/USD divided by COLLATERAL/USD in collateral-per-base `price18` units. It does not assume a USDC/USD peg, publish a synthetic public price or authorize deployment/activation. The initial base candidate is the independently published Fuji [AVAX/USD feed](FUJI_ORACLE_CANDIDATES.md); the collateral/USD feed also needs independent source/code/round qualification. Selecting concrete feeds and time bounds remains an explicit release-plan decision.

## API and trust boundary

Constructor: `(marketId, baseUsdFeed, collateralUsdFeed, fundingPublisher, baseMaxAge, quoteMaxAge)`. Only local fixture chain `31337` or Fuji `43113` is permitted; deployment chain, market (1–8), distinct feed addresses, decimals, proxy-shell code hashes, separate funding publisher and time bounds are immutable. Mainnet is rejected. Funding publisher must differ from the deployer and both feeds; it cannot set prices, withdraw tokens or spend vault collateral.

- Both feeds must have code and decimals 0–18. Runtime code replacement or a decimals change fails closed on every observation. Captured proxy-shell hashes are not independent source approval and do not freeze proxied aggregator/admin behavior; the approved manifest must compare actual source/code/roles before any public signature.
- Each `latestRoundData` must have a positive answer, nonzero round and timestamps, no future/start-after-update timestamp, no carried older `answeredInRound`, and age within its own explicit maximum. Base maximum is bounded to 3,600 seconds; collateral quote maximum to 86,400 seconds. These are upper implementation bounds, not approved economic policies.
- Prices normalize separately to 1e18 with bounded arithmetic. Ratio is `floor(baseUsd18 * 1e18 / collateralUsd18)`, positive and ≤1e27. `price(marketId).sourceTimestamp` is the **older original** update timestamp, never read time. `sources()` exposes both normalized inputs and original timestamps for audit.
- Proposed validation-only release settings are base age 600 seconds and quote age 86,400 seconds, corresponding to different published feed cadences. This is not a blanket relaxation of AVAX freshness: the adapter independently enforces the tighter base bound even when the composite timestamp is older. These settings require owner/risk review before public activation; directory heartbeat metadata alone is insufficient.

## Funding and owner exits

Only the immutable publisher can configure a signed price-index rate, bounded to 1% of the fresh composite price per hour, with a strictly future expiry at most one hour ahead. Old funding checkpoints only through its original expiry; renewal starts now without backfilling expired gaps. Index arithmetic is checked and sign changes preserve the checkpoint.

Construction sets a terminal zero checkpoint whose expiry is the constructor timestamp: it does **not** silently start a live funding period. The publisher must explicitly initialize/renew a rate before new entries can pass their funding-freshness gate.

When funding expires, `fundingIndex()` returns the real expired validity time and the frozen terminal index, while still requiring independently fresh price inputs. The settlement layer must reject **new** entries on expired funding but allow owners to settle/close existing liabilities using that terminal index at a valid independent price. It must never invent fresh rates, backfill the gap or use stale prices to enable exits. A separately reviewed activation/pause implementation and qualification tests must establish that integration; this oracle alone does not enable custody.

## Checks and evidence limits

OpenCode drafted the adapter and tests; Pi reviewed the source and used direct `EXTCODEHASH` checks rather than copying proxy bytecode on every read. All **22 local Foundry tests** pass, including three 1,000-case ratio/funding conservation properties. They cover chain/config/role checks, decimals/scaling/ratio/depeg, arithmetic bounds, each source's freshness and round/timestamp failures, immutable proxy-code/decimals pins, funding authority/caps/lifetime/sign changes/expired gaps and terminal-expiry behavior. Solidity formatting passes.

These are local fixtures, not a public deployment, live funding, external source qualification or public transfer evidence. Source/proxy/admin trust, current independent RPC agreement, safe stop/recovery, bounded signing authorization and the complete release manifest remain required. No user wallet key was given to the code-generating agent.
