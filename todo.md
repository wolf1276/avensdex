# AVENSDEX — CLOB delivery checklist

The low-latency CLOB request supersedes the prior onchain order-book delivery order, not the product: perpetuals, adaptive funding, owner-controlled delta-neutral Autopilot, Guardian and existing branding/terminal remain required. [Audited implementation plan](docs/CLOB_PLAN.md). [Source baseline](docs/NEARFLOW_BASELINE.md).

Active execution is **Fuji-only**: no PAPER mode, synthetic balances, fake fills or fallback simulation. Missing genuine execution is unavailable. Local unit/fuzz/benchmark fixtures remain development tests, not shipped trading or public evidence. Historical source evidence is preserved, not relabeled.

NEAR source is preserved. New work lives in `packages/clob`, `services/clob` and `contracts/evm`; no source-chain balances, keys or journals are reused as Avalanche authority. Use Ponytail, small feature-named commits and a push after each completed tested unit. Secrets, local instructions and unreviewed-rights source remain excluded.

## Phase 1 — foundation and source boundary (local foundation delivered; external gates open)

- [x] Hash-verified complete local source snapshot, including relevant dirty/untracked source; exclude credentials/build outputs.
- [x] Inspect current architecture, source Rust matching, wallet submission wrapper, funding, custody/risk/Guardian and terminal boundaries. [Audit](docs/CLOB_PLAN.md); complete security review is not claimed.
- [x] Fresh copied-source regression: 162 TS and 134 Rust exchange tests; installed frontend dependencies reused, not a clean frontend release check.
- [x] Pin initial tools and CI; run local/clean tracked-source equivalents. Hosted CI observation remains separate.
- [x] Test Solidity funding math against original TS/Rust rate vectors and stateful sign mirrors.
- [x] Test explicit size6/price18/collateral6/raw-base units, capped payouts, funding remainders, partial-close dust and liquidation-risk math.
- [x] Initial typed module/accounting/nonce contract and disabled manifest parser. Existing v1 onchain-book ABI is reference-only under the new CLOB plan.
- [ ] Finish remaining semantic/security review as affected components are implemented.
- [ ] Complete Fuji token/proxy/transfer, oracle/freshness, venue/liquidity and canonicality/operating qualification before dependent public integration.
- [ ] Resolve missing supplied landing code/artwork redistribution permission before publishing those files; preserve third-party notices.

Evidence: [foundation checks](docs/FOUNDATION_CHECKS.md), [Phase 1 scope](docs/PHASE1_STATUS.md), [read-only Fuji observations](docs/FUJI_QUALIFICATION.md). Do not call public qualification complete from local math tests or token metadata.

## Phase 2 — deterministic offchain matching and market data (P0)

- [ ] One bounded TypeScript in-memory CLOB; limit and price-bounded IOC market orders; buy/sell, price-time/FIFO, multiple orders per level, partials and self-trade prevention.
- [ ] Owner cancellation, monotonic order nonces/duplicate rejection, explicit expiry and reduce-only capacity checks. Keep reduce-only admission disabled without confirmed position state.
- [ ] Aggregated depth, BBO, recent provisional trades and sequenced order/book/blocked-settlement events.
- [ ] Durable append-only hash-checked command journal, single-writer lock, fsync-before-ack and deterministic replay; refuse corruption, missing state, mismatched identity or unknown writes.
- [ ] EIP-712 order/cancel admission bound to trader, chain and verifying contract; no request-supplied execution targets or private server signer.
- [ ] Loopback WebSocket snapshot/delta subscriptions and bounded HTTP admission; payload/client/backpressure limits and expiry ticks.
- [ ] Shared client state reducer detects sequence/stream gaps and resynchronizes from authoritative snapshots.
- [ ] Tests: FIFO, partial/cancel/expiry/duplicates, determinism, reduce-only limits, journal corruption/restart/competing writers, forgery/domain mismatch, reconnect/gaps and slow clients.
- [ ] Benchmark pure matching, durable local acknowledgments and WebSocket delivery separately; report p50/p95/p99, throughput, hardware, workload and limitations. Sub-100 ms is a target, not a claim.

**Gate:** reproducible local matcher/transport behavior. All matches remain provisional; no collateral, confirmed positions or onchain transactions are fabricated.

## Phase 3 — canonical collateral and signed atomic settlement (P0)

- [ ] Implement exact-delta ERC-20 custody, caps, reentrancy/donation handling, one canonical liability ledger and fixed-owner withdrawals.
- [ ] Implement EIP-712 validation, trader identity, chain/deployment domain, nonce invalidation/cancellation, expiry and cumulative partial-fill accounting.
- [ ] Validate both counterparties' price limits, fees, margin/collateral and position/size/liquidation constraints before atomically applying a matched fill.
- [ ] Handle cancellation/matching races onchain; duplicates/replays and insufficient margin revert the entire fill. No unrestricted matcher balance/payout authority.
- [ ] Preserve isolated bilateral capped settlement, fees, partial/full close and liquidation; no basic spot order-book substitute.
- [ ] Keep unsupported market/reduce-only/strategy order settlement disabled until each corresponding risk constraint is tested.
- [ ] Durable settlement intent/receipt reconciliation, confirmation policy, replacement/revert/unknown handling and genuine position updates. Never auto-resubmit an unknown outcome.
- [ ] Foundry forgery/replay/race/insufficient-collateral/conservation/oracle/failure tests and bounded gas/code-size checks.

**Gate:** actual local-EVM signed order → atomic funded fill → position/close → owner withdrawal. Successful submission is not confirmation or a filled order.

## Phase 4 — existing terminal, adaptive funding and lifecycle (P0d/P1)

- [ ] Preserve existing landing/Trade layout/branding; no standalone book demo or terminal rebuild.
- [ ] Wire EVM wallet/chain/account invalidation, approvals/deposits and typed contract reads/mutations.
- [ ] Connect live depth/BBO/spread/trades, limit/market controls and order status with explicit provisional/pending/confirmed/reverted states.
- [ ] Distinguish last traded price, independent index and validated mark; matcher cannot unilaterally control funding or liquidation.
- [ ] Apply baseline/adaptive math, smoothing/caps, oracle freshness, epochs/rate expiry, index settlement and payment conservation. Never use matched long-OI-minus-short-OI as the primary premium signal.
- [ ] Show actual funding, positions, margin, costs and real explorer links; unavailable sources fail closed, not simulated success.
- [ ] Test real local wallet/browser flow, sequence reconnect/resync, cancellation races, stale data, keyboard/mobile/error states.

## Phase 5 — Guardian and delta-neutral Autopilot (P1/P2)

- [ ] Reuse conservative opportunity/capital/sizing, risk/watchdog and durable decision/replay semantics behind EVM-aware adapters; do not bypass PAPER-only source guards.
- [ ] Genuine independent spot/perp quotes, liquidity/collateral checks, cost-aware bounded sizing and scoped/revocable onchain owner mandates.
- [ ] Real pending/confirmed fill reconciliation, partial-leg detection, residual delta/margin monitoring and policy-authorized repairs only.
- [ ] Unknown outcomes pause/reconcile; no blind retry or invented atomicity. Test counterparty exits, funding reversal, venue/leg failures and exhausted budgets.
- [ ] Owner pause/revoke/cancel/close/recover/settled-withdraw controls, fixed recipients and actual inventory ownership.
- [ ] Add Autopilot/Guardian status and decision receipts inside existing Trade. No autonomous live hedge claim until both genuine legs are verified.

## Phase 6 — capped Fuji verification and release

- [ ] Finish asset/oracle/spot/finality/rights gates; distinguish implementation, integration availability, economic eligibility and activation.
- [ ] Separate bounded approval before any public deployment/signing/spending: identities/actions, finite funds/gas/exposure, expiry and stop/recovery plan. Mainnet stays disabled.
- [ ] Fresh paused Fuji C-Chain deployment (`43113`), code/role/module/token/ABI verification and safe deposit/withdrawal first.
- [ ] Real wallet signed orders, settlement, funding, close/liquidation where safely applicable, hedge/recovery/revoke/withdraw and restart proof with actual receipts/token deltas.
- [ ] Clean installation, CI/security/dependency/secret review, existing-terminal browser regression and reproducible benchmark/evidence report.
- [ ] Reconcile original NEAR liabilities/pending state under original code; never reset or silently transfer funded state. Preserve immutable labeled history.
- [ ] Publish accurate setup, bounded deployment/verification instructions, safe stop/recovery, demo and implemented-vs-pending README to the confirmed repository only.

**Gate:** reconciled genuine Fuji lifecycle with no unresolved custody/security blocker. PAPER, local VM and fork results remain distinct. Centralized matching is disclosed. No profitability, liquidity, latency or decentralization claim without applicable evidence.
