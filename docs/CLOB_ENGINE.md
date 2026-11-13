# Deterministic matching and durable commands

## Implemented

`packages/clob/engine.ts` provides one-market, bigint size6/price18 matching in TypeScript using the existing Node toolchain. It supports price priority and FIFO at equal prices, aggregated depth/BBO, partials, limit and signed-price-bound-compatible IOC market behavior, post-only/IOC constraints, monotonic trader nonces, cancellation, expiry and self-trade prevention. The highest-priority maker's price is used; self-cross cancels the incoming remainder rather than creating a trade.

Orders/trades/book levels/BBO/settlement status/position snapshots share a contiguous stream sequence. Snapshots include the stream identity, current sequence, active aggregated depth, order history, recent trades and explicit unavailable/blocked settlement. A successful offchain match is **not** a filled perpetual position or earned funding.

Reduce-only admission requires fresh trusted reconciler position input, the correct reducing side and sufficient capacity after open and provisional reductions. Missing/stale positions fail closed. Position updates must advance canonical block identity/source time; pending reductions are retained conservatively rather than released by a snapshot refresh. There is no live chain reconciler or public position-update endpoint yet. Test snapshots are fixtures, not testnet evidence.

`packages/clob/journal.ts` wraps the core with:

- One exclusive writer lock in an operator-controlled directory; no automatic crash-lock stealing.
- Explicit create-once behavior; missing/corrupt state never silently resets.
- Fuji chain/market/settlement-address binding and persisted stream/engine version.
- Append-only commands/proofs, SHA-256 chain, record indices and deterministic complete state/event fingerprints.
- Command validation on a copy; append and fsync **before** changing the live book or returning events/acknowledgment.
- Restart replay that refuses hash, sequence, identity or behavioral divergence and truncated tails.
- Unknown-write poison state; stop writes and retain the lock until operator reconciliation.

This follows the original Store's single-writer/fsync/recovery principles without importing a browser/NEAR runtime. No original source file is changed.

## Run tests

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:clob
```

Sixteen matcher/journal tests passed, including process crash/restart, corrupt/truncated journal, competing writer, domain mismatch, unknown-write injection, replay, price/FIFO/partials, expiry/cancellation and unavailable/exhausted reduction capacity. These are local development tests, not product simulation or public Fuji trades. Full `npm test` retains the prior math/network/contract suites.

## Operational limits and next boundaries

The core has no public admission server, wallet authority, collateral ledger, signer, blockchain transaction sender or settlement implementation. It expects a trusted adapter to authenticate commands; engine-level owner strings alone are not cryptographic authentication. The [signed EOA adapter](CLOB_ADMISSION.md) now implements the local authentication boundary and durable proof capture. Actual contract checks and read-only reconciliation are now implemented in the [separate Phase 3 local boundary](PHASE3_STATUS.md). Public deployment/readiness gating and wiring canonical status back into this public stream remain unavailable; this matcher does not gain signing or custody authority. The position command is trusted reconciler input only, not a mechanism for clients to set balances.

Book capacity is 256 resting orders; trader identities at most 1,000; pending matches at most 4,096; retained orders at most 8,704. A maximum 64 MiB command journal and 32 KiB record bound fail closed. Unsettled order identities are never pruned to make room. Pending settlement confirmation/reversion and capacity release remain unwired in this matcher until a qualified deployment and the Phase 4 transport/status integration exist. The separate Phase 3 reconciler validates canonical fills/positions, but cannot turn on the public feed or silently mutate this journal. The fresh local-EVM integration passes a real matcher-generated match of wallet-signed orders into the contract, while keeping this development book explicitly blocked/unavailable.

The initial implementation uses sorted bounded arrays and copy-before-commit state for correctness, not an unmeasured fastest-book claim. Benchmark core matching separately from journal fsync, signature validation, WebSocket delivery and blockchain finality. No performance target is claimed achieved by the unit-test duration.

Filesystem locks/hash chains assume a trusted local directory and single host; they are not a distributed lease or protection against a malicious filesystem owner. Backups/checkpoints/rotation and large-scale recovery are pending. Never delete a funded/obligation-bearing journal or retry an uncertain write merely to resume service.

The active product has no PAPER mode and cannot pretend an absent settlement deployment is live. User orders/trading remain unavailable until the genuine Fuji contract/admission boundary is ready. No deployed contract, transaction, confirmed position, liquidity or profit is claimed by this library.
