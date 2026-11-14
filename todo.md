# AVENSDEX — CLOB delivery checklist

The low-latency CLOB request supersedes the prior onchain order-book delivery order, not the product: perpetuals, adaptive funding, owner-controlled delta-neutral Autopilot, Guardian and existing branding/terminal remain required. [Audited implementation plan](docs/CLOB_PLAN.md). [Source baseline](docs/NEARFLOW_BASELINE.md).

Active execution is **Fuji-only**: no PAPER mode, synthetic balances, fake fills or fallback simulation. Missing genuine execution is unavailable. Local unit/fuzz/benchmark fixtures remain development tests, not shipped trading or public evidence. Historical source evidence is preserved, not relabeled.

NEAR source is preserved. New work lives in `packages/clob`, `services/clob` and `contracts/evm`; no source-chain balances, keys or journals are reused as Avalanche authority. Use Ponytail, small feature-named commits and a push after each completed tested unit. Secrets, local instructions and unreviewed-rights source remain excluded.

## Phase 1 — foundation and source boundary (local foundation delivered; external gates open)

- [x] Hash-verified complete local source snapshot, including relevant dirty/untracked source; exclude credentials/build outputs.
- [x] Inspect current architecture, source Rust matching, wallet submission wrapper, funding, custody/risk/Guardian and terminal boundaries. [Audit](docs/CLOB_PLAN.md); complete security review is not claimed.
- [x] Fresh copied-source regression: 162 TS and 134 Rust exchange tests; installed frontend dependencies reused, not a clean frontend release check.
- [x] Pin initial tools and CI; run local/clean tracked-source equivalents. [Hosted CI at `6e03f26` passed](https://github.com/wolf1276/avensdex/actions/runs/43457508279); root clean archive checks also pass.
- [x] Test Solidity funding math against original TS/Rust rate vectors and stateful sign mirrors.
- [x] Test explicit size6/price18/collateral6/raw-base units, capped payouts, funding remainders, partial-close dust and liquidation-risk math.
- [x] Initial typed module/accounting/nonce contract and disabled manifest parser. Existing v1 onchain-book ABI is reference-only under the new CLOB plan.
- [ ] Finish remaining semantic/security review as affected components are implemented.
- [ ] Complete Fuji token/proxy/transfer, oracle/freshness, venue/liquidity and canonicality/operating qualification before dependent public integration.
- [ ] Resolve missing supplied landing code/artwork redistribution permission before publishing those files; preserve third-party notices.

Evidence: [foundation checks](docs/FOUNDATION_CHECKS.md), [Phase 1 scope](docs/PHASE1_STATUS.md), [read-only Fuji observations](docs/FUJI_QUALIFICATION.md). Do not call public qualification complete from local math tests or token metadata.

## Phase 2 — deterministic offchain matching and market data (P0; local gate complete)

- [x] One bounded TypeScript in-memory CLOB; limit and price-bounded IOC market orders; buy/sell, price-time/FIFO, multiple orders per level, partials and self-trade prevention. [Core/journal implementation and limits](docs/CLOB_ENGINE.md).
- [x] Core owner/canonical-nonce cancellation checks, duplicate rejection, expiry and reduce-only capacity checks. Reduce-only rejects absent/stale confirmed input. This is trusted internal command validation; cryptographic public admission remains separately pending.
- [x] Aggregated depth, BBO, recent provisional trades and sequenced order/book/blocked-settlement events.
- [x] Durable append-only hash-checked command journal, single-writer lock, fsync-before-ack and deterministic replay; refuse corruption, missing state, mismatched identity or unknown writes. Sixteen core/journal tests pass; no onchain transaction broadcast or settlement exists yet.
- [x] [EIP-712 order/cancel admission](docs/CLOB_ADMISSION.md) binds trader, Fuji/deployment, market, price/size, leverage, fee cap, flags, nonce and expiry; strict low-s EOA recovery, canonical hash IDs, durable proofs and cancel-target/replay checks. Signed in-process service ingress publishes only after fsync. Public network activation remains blocked by Phase 3; no address-only enable switch or private server signer.
- [x] Loopback WebSocket snapshot/delta subscriptions, payload/client/backpressure limits and durable expiry ticks. [Service/reducer scope](docs/CLOB_SERVICE.md). HTTP mutation/admission remains 503 until genuine deployment/signature gates exist, not an unsigned fallback.
- [x] Shared browser-safe client reducer detects sequence/stream gaps, freezes stale state and requests authoritative resynchronization. Actual existing-terminal wiring remains Phase 4.
- [x] Forty-five CLOB tests cover core/journal/real loopback/reducer plus forgery, domain/financial-field tampering, low-s signatures, cancellation scope, async mutation and concurrent/restarted nonce replay. Four new Solidity auth tests include cross-language golden vectors and a 1,000-case signature-recovery property; hash helpers are not settlement.
- [x] Benchmark pure matching, durable local acknowledgments and WebSocket delivery separately; publish [measured clean-revision quantiles/throughput/hardware/methodology](docs/CLOB_BENCHMARK.md), including the slower smoke-run caveat and the signed in-process recovery → fsync → WebSocket checkpoint. HTTP admission, browser/WAN/fanout and onchain finality remain unmeasured; no public performance claim.

**Local gate passed:** reproducible signed matcher/journal/transport behavior. All matches remain provisional; no collateral, confirmed positions or onchain transactions are fabricated. [Live-trading blocker review](docs/LIVE_TRADING_BLOCKERS.md): Phase 3, genuine deployment/readiness and downstream integration gates remain mandatory.

## Phase 3 — canonical collateral and signed atomic settlement (P0; supported local gate complete)

- [x] Implement [local-only exact-delta ERC-20 custody](docs/COLLATERAL_VAULT.md), cap, reentrancy/donation handling, canonical free balances and fixed-owner withdrawals. A [separate capped Fuji activation path](docs/FUJI_ACTIVATION.md) is implemented/historically fork-tested; public activation and signing remain unapproved.
- [x] Extend the same canonical ledger with manual-order escrow/reservations, pair margins and fees/insurance; freeze one code/reference-checked settlement binding before local activation. Public activation stays hard-disabled. Strategy buckets/authority remain Phase 5 work and cannot be enabled through the manual schema.
- [x] Implement EIP-712 validation, trader identity, chain/deployment domain, monotonic explicit nonce invalidation, exact-hash cancellation, expiry and cumulative partial-fill accounting.
- [x] Validate both counterparties' price limits, signed fee caps, leverage/margin/collateral, independent-reference price band and position/size/liquidation constraints before atomically applying a matched fill.
- [x] Resolve cancellation/matching races onchain, including owner cancellation before first reservation/fill; duplicates/replays and insufficient margin revert the entire fill. No unrestricted matcher balance/token-payout authority.
- [x] Preserve isolated bilateral capped settlement, fees, payer-bounded funding checkpoints, fractional rounding, partial/full close and permissionless unsafe-only liquidation; no basic spot order-book substitute.
- [x] Keep unsupported market/reduce-only/post-only/IOC/strategy settlement disabled until its risk semantics are tested. The supported path is manual vanilla limit orders only.
- [x] [Durable settlement reconciliation](docs/SETTLEMENT_RECONCILIATION.md): intent-before-dispatch identity, canonical decoded receipts/events, confirmation policy, original/replacement/revert/unknown/reorg handling and current positions from both modules at one pinned canonical block. Restart/lost-hash ambiguity pauses; no automatic signing, retry or simulated positions.
- [x] Foundry forgery/replay/race/insufficient-collateral/conservation/oracle/failure tests and bounded local gas/code-size checks. [Phase 3 evidence and limits](docs/PHASE3_STATUS.md): 84 Foundry, 94 TypeScript and 12 Python tests plus typecheck and a fresh Anvil/Paris lifecycle checking 24 actual local receipts.

**Supported local gate passed:** signed order → atomic funded fill → canonical position/funding → partial/full close → settled owner token withdrawal. This is local fixture evidence, not public Fuji execution. Adaptive funding/epochs, strategy allocation/inventory, UI/Guardian integration and public qualification/activation remain later gates. Successful submission alone is not confirmation or a filled order.

## Phase 4 — existing terminal, adaptive funding and lifecycle (P0d/P1)

**Supported local backend gate delivered:** [scope and fresh local EVM lifecycle](docs/PHASE4_STATUS.md). Full Phase 4 remains open: existing-terminal/browser work is deferred, and qualified public sources, deployment/publisher transport and activation are not claimed.

- [x] Wire canonical settlement-journal outcomes into durable matcher/feed state and pending capacity, including restart/unknown/reorg downgrades; no blind retries or simulated positions.
- [x] Read complete bounded policy-confirmed positions and funding from paired providers at pinned blocks, preserving actual source timestamps and failing closed on stale/inconsistent data.
- [x] Distinguish backend last provisional trade, independent index and validated-mark adapter observations; verify code/reference identities without claiming public economic independence.
- [x] Verify a fresh local backend EVM lifecycle through funding proposal calldata, signed admission/fill/cancellation, canonical outcomes, actual funding, expired-rate owner exits, withdrawals and restart; HTTP mutations/readiness stay unavailable.
- [ ] Preserve existing landing/Trade layout/branding; no standalone book demo or terminal rebuild.
- [ ] Wire EVM wallet/chain/account invalidation, approvals/deposits and typed contract reads/mutations.
- [ ] Connect live depth/BBO/spread/trades, supported order controls and explicit provisional/pending/confirmed/reverted states; wire canonical settlement outcomes and pending-match capacity release into the existing journal/feed without retrying unknown outcomes. Unsupported market/flags stay unavailable.
- [ ] Wire the distinct last-trade/index/mark data into the existing terminal and qualify genuine public sources; matcher cannot unilaterally control funding or liquidation.
- [x] Implement/test local baseline/adaptive math, smoothing/caps, oracle freshness, epochs/rate expiry, index settlement and payment conservation. Never use matched long-OI-minus-short-OI as the primary premium signal; public qualification and publisher integration remain open.
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
- [x] Publish [current Fuji deployment/verification prerequisites](docs/FUJI_CLOB_RUNBOOK.md), truthful unavailable-state setup and measured local benchmark. These are instructions, not deployment evidence or authorization.
- [x] Add a fixed-endpoint read-only deployment inspection CLI for two-provider head/block/transaction/receipt/code observations; local unit tests only, no signer, journal integration or public deployment evidence.
- [x] Add an offline deployment-plan CLI that reads external planner input and reviewed artifacts, reuses existing planner validation and prints the paused plan/hash; no signer, RPC, broadcast, activation or journal mutation.
- [ ] Complete actual deployment/signing tools, public safe-stop/recovery proof, demo and release README once the genuine lifecycle passes; publish only to the confirmed repository.

**Gate:** reconciled genuine Fuji lifecycle with no unresolved custody/security blocker. PAPER, local VM and fork results remain distinct. Centralized matching is disclosed. No profitability, liquidity, latency or decentralization claim without applicable evidence.
