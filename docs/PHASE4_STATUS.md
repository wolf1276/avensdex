# Phase 4 backend and lifecycle status

## Gate and scope

**Supported local backend gate passed; the full terminal/browser Phase 4 is not complete.** Frontend integration remains explicitly deferred. Public deployment, source qualification, operator signing authorization and live trading remain unavailable. This document does not change those gates or authorize spending.

Implemented locally:

- Separate index and validated-mark adapter boundaries with an authenticated, epoch/revision-protected baseline/adaptive funding controller, source freshness, rate expiry, fractional index carry and no stale-gap backfill.
- Real EIP-712 admission into the durable matcher and loopback market-data service; supported contract execution remains vanilla limit orders only.
- Canonical settlement-journal outcomes into durable matcher/feed state; terminal outcomes release pending capacity, while unknown/pending/reorg downgrades restore or retain it. Reverts never automatically requeue or retry an order.
- Complete bounded policy-confirmed position enumeration from both modules/providers at one pinned block, with original block timestamps, ledger agreement and conservative refresh invalidation.
- A policy-confirmed funding reader that verifies settlement/oracle/source identities, captured code hashes, configured parameter bounds, actual index/mark timestamps and the cumulative funding index. Last provisional trade, independent index and validated mark remain separate.
- An offline publication proposal containing only `publish(expectedRevision,currentEpoch)` for the immutable publisher, with epoch expiry and `approvalRequired:true`, `executionEnabled:false`. It does not sign, broadcast, retry or provide deployment authorization.
- Trusted `refreshFunding` into a read-only `/funding` endpoint. Missing, stale, failed or unconfigured observations return `503`; expired funding is explicit, not replaced with simulated execution or a fabricated rate. Source freshness is rechecked at read/publication time, not just at the historical block time.
- Startup invalidates historical terminal settlement outcomes and positions before exposing the service. Canonical reconciliation is required again; a persisted fill is neither an everlasting finality guarantee nor a current-position ledger.

## Reproduction

```sh
npm run typecheck
npm run test:clob
npm run test:phase4:evm
npm test
npm run test:funding:rust
forge fmt --root contracts/evm --check
npm audit --omit=dev
```

The phase-4 EVM check starts a **fresh loopback-only Anvil instance with chain ID 43113**, zero preinstalled accounts, fixed local fixture time and generated disposable keys. Chain ID 43113 does not make it public Fuji. The script refuses a nonempty node before funding fixture accounts, accepts no RPC/wallet options and never loads operator secrets.

Its actual local lifecycle checks:

1. Deploy source fixtures plus real vault, adaptive oracle and settlement; bind the module with a 10-USDC liability cap.
2. Read a paired same-node funding snapshot, build a revision/epoch-bound proposal and submit its actual calldata with a generated fixture publisher.
3. Activate local fixture custody, mint/approve/deposit 2 fixture USDC for each trader.
4. Submit actual typed signatures through service admission, provisionally match, record an intent before dispatch and reconcile the actual transaction/receipt/event.
5. Verify pending then confirmed status, pending-capacity release and actual loopback WebSocket/reducer state.
6. Cancel an unmatched remainder with real offchain and onchain signed-owner cancellation while preserving the already filled size.
7. Read exact signed positions and distinct index/mark data from real deployed local contracts; `/ready` and public mutations remain `503`.
8. Apply nonzero funding to actual pair margins, conserve collateral, independently calculate the terminal index and prove quotes/renewal cannot backfill expiry gaps.
9. Close while funding is expired, renew in a new epoch, withdraw both owners' settled balances and reconcile remaining fees/token custody.
10. Reopen both journals and revalidate the historical fill without recreating the closed position.

Latest local checks for this unit passed: 14 funding, 65 protocol and 118 CLOB TypeScript tests; 30 Python tests; 133 Foundry tests including configured 1,000-case funding fuzzing; 4 locked Rust tests; 24 original local lifecycle receipts and 26 additional phase-4 receipts on **separate fresh local nodes**. Formatting and diff checks passed. Root `npm audit --omit=dev` reported zero vulnerabilities, a point-in-time dependency result, not a security audit. Per-run gas/cost totals are printed from actual local receipts and vary with generated signatures; they are not public Fuji cost or profitability evidence.

A clean tracked-source archive of revision `6bc90cc` additionally passed `npm ci --ignore-scripts`, the full `npm test` suite, locked Rust reference tests and Foundry formatting without reusing repository `node_modules` or generated artifacts. Hosted CI and browser tests were not run for this checkpoint; no historical-fork or public-Fuji result is implied.

OpenCode drafted isolated files in a separate worktree. Parent review removed unsafe/overbroad APIs, strengthened freshness/epoch validation, added paired-ledger and restart checks, and replaced tautological/mis-parenthesized EVM assertions with real state/receipt checks. No unreviewed worktree merge or funded-state reset was used.

## Explicit remaining gates

- Preserve/wire the existing terminal: wallet/network/account invalidation, approvals/deposits, supported order controls, actual funding/position/margin/cost/receipt displays and browser reconnect/cancellation/mobile/keyboard/error tests. These are deferred frontend work, not completed by backend tests.
- Independently qualify public index/mark sources, collateral, liquidity, finality and operating policy. Different source addresses or two clients pointing to one test node do not establish economic independence.
- Freeze reviewed controller parameters and integrate the additional mark/funding adapter identities into an explicitly reviewed deployment plan. The existing four-transaction planner still targets the manual-rate feed adapter.
- Supply an authorized public publisher/operator signer and durable bounded submission/recovery transport; no server signer or unattended publisher was added. The local fixture sender is not that transport.
- Complete applicable independent security/rights/release checks, separately authorize deployment/activation and prove a genuine public lifecycle with real counterparties and receipts.

Strategies, Guardian and genuine spot hedging remain Phase 5, not evidence implied by this local backend gate.
