# Funding controller reference

`packages/funding/controller.ts` is a pure local TypeScript reference, not an onchain controller, authorized publisher or live funding source. It reuses the source-derived premium, EMA and baseline/adaptive rate calculations in `preview.ts`; provenance remains in `packages/funding/NOTICE`.

Prices and cumulative funding indices use price18 units; rates and premium use signed ppm per 3,600-second interval. Timestamps and epoch numbers are bigint seconds. Parameters are validated by the existing reference validator and snapshotted on initialization/configuration. Each publication consumes `floor(now / 3600)` and requires a strictly newer epoch. Configuration checks the expected revision, resets the rate/EMA, and consumes the current epoch. These are deterministic state rules, not authentication: a real publisher must enforce authority separately.

A fresh independent index and validated mark are required for a usable premium. Stale or excessive premiums disable the rate and clear the EMA; malformed prices/future timestamps fail. The reference does not generate or independently validate mark provenance. No last-trade or matched-OI signal is substituted.

Accrual uses the previous observed index and rate, ending at the earliest of the requested time, index freshness expiry and one interval after publication. Missed stale intervals are not backfilled. Signed division remainders are carried between accrual calls so splitting a checkpoint does not silently discard fractional index changes. Rate expiry is distinct from the shorter oracle freshness window. All state transitions reject backwards time.

Tests compare both rate signs with existing pure math, split versus single accrual, deadband/slope/caps, stale inputs, epoch replay, expiry and configuration revision changes. Existing contract funding-settlement tests remain the conservation evidence; this reference does not hold collateral or implement payer clipping itself.

Still required: reviewed mark/index sourcing, finalized economic/governance specification, Solidity controller/epoch integration, authenticated publisher, differential multi-epoch contract/reference tests and deployment qualification. Do not wire this reference into live settlement as if those gates had passed.
