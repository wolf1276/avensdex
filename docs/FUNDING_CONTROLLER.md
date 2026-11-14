# Funding controller reference

`packages/funding/controller.ts` is a pure local TypeScript reference, not an onchain controller, authorized publisher or live funding source. It reuses the source-derived premium, EMA and baseline/adaptive rate calculations in `preview.ts`; provenance remains in `packages/funding/NOTICE`.

Prices and cumulative funding indices use price18 units; rates and premium use signed ppm per 3,600-second interval. Timestamps and epoch numbers are bigint seconds. Parameters are validated by the existing reference validator and snapshotted on initialization/configuration. Each publication consumes `floor(now / 3600)` and requires a strictly newer epoch. Configuration checks the expected revision, resets the rate/EMA, and consumes the current epoch. These are deterministic state rules, not authentication: a real publisher must enforce authority separately.

A fresh independent index and validated mark are required for a usable premium. Stale or excessive premiums disable the rate and clear the EMA; malformed prices/future timestamps fail. The reference does not generate or independently validate mark provenance. No last-trade or matched-OI signal is substituted.

Accrual uses the previous observed index and rate, ending at the earliest of the requested time, index freshness expiry and one interval after publication. Missed stale intervals are not backfilled. Signed division remainders are carried between accrual calls so splitting a checkpoint does not silently discard fractional index changes. Rate expiry is distinct from the shorter oracle freshness window. All state transitions reject backwards time.

Tests compare both rate signs with existing pure math, split versus single accrual, deadband/slope/caps, stale inputs, epoch replay, expiry and configuration revision changes. Existing contract funding-settlement tests remain the conservation evidence; this reference does not hold collateral or implement payer clipping itself.

## Onchain implementation

`contracts/evm/src/AvensFundingOracle.sol` implements the controller as a separate `IOracleAdapter`. It reads a code-pinned index adapter and a different code-pinned validated-mark adapter; the immutable funding publisher cannot supply price values. Only the configuration owner may change validated parameters/mode with an expected revision. Publications bind the revision and current epoch and consume each epoch once. Configuration checkpoints the old rate, disables the new rate and consumes its epoch. No publisher/owner transfer or arbitrary external-call authority is provided.

Unlike the exploratory reference's explicit disabled fallback result, invalid/stale onchain observations **revert atomically**; they do not publish a substitute price/rate or clear an existing rate. Each usable rate expires at the earlier of its captured index freshness limit and one hour after publication. Reading a newer source price cannot extend an old rate. Permissionless checkpoints use chain time only and retain signed fractional carry. The price method independently enforces configured index freshness; expired funding returns its terminal index and actual past expiry only when the current price is fresh, allowing the settlement contract's existing owner-exit behavior.

Local Foundry tests cover owner/publisher scope, actual source reads, both signs, epoch/config replay, stale/future/outlier inputs, source-code/chain changes, atomic configuration failure and a 1,000-case split-checkpoint property. Separate local lifecycle tests connect this adapter to the real vault/settlement and check exact nonzero funding transfers of 1,833 collateral base units in both directions, conservation, expiry, close and owner withdrawal. Mocks establish contract behavior, not independent public price evidence.

This contract is not part of the existing four-transaction deployment planner. Its additional mark source and deployment/role/artifact schema must be qualified and explicitly integrated before deployment; no existing frozen binding, manifest or deployment plan was changed. Distinct adapter addresses/code hashes do not prove independent economics, and proxy implementation/governance changes are not prevented by pinning proxy runtime.

Still required: reviewed independent mark/index sourcing, finalized economic/governance parameters, larger differential multi-epoch contract/reference tests, restart/publisher transport, deployment-planner integration and public qualification. No live controller or deployment is claimed.
