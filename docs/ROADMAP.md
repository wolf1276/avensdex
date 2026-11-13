# Avensdex delivery roadmap

The identified NEARFlow source already contains the UI and exchange. [`todo.md`](../todo.md) is now the active six-phase port task list, derived from the source's full migration plan. This page retains the original target gates; it is not an instruction to rebuild existing features.

M0 qualification has started with tested read-only network probes; see [recorded evidence and blockers](FUJI_QUALIFICATION.md). Public milestone gates remain incomplete; the [supported Phase 3 local settlement gate](PHASE3_STATUS.md) is complete. No public deployment or successful trading execution is implied by this checklist.

The [Avalanche migration plan](AVAX_MIGRATION_PLAN.md) expands these milestones into qualification decisions, workstreams, acceptance gates and operating controls.

## 1. Specification and qualification

- [ ] Confirm initial market, collateral/base assets and settlement rules.
- [ ] Verify exact network, asset decimals, oracle behavior and executable spot venue.
- [ ] Quote intended entry/exit sizes, depth, fees, gas and repair allowances.
- [ ] Separate investment admission from any finite owner-authorized execution-validation session.
- [ ] Freeze module interfaces, accounting invariants, role model, tool versions and deployment manifest schema.
- [ ] Verify applicable program requirements, submission format and publication destination.

**Gate:** explicit design and reproducible qualification; addresses alone do not prove executable liquidity.

## 2. Contract foundations and exchange

- [x] Implement explicit asset units and bounded pure funding/risk math with source reference vectors and local property tests. [Phase 1 results](PHASE1_STATUS.md); stateful exchange implementation remains open.
- [x] Implement canonical custody, exact token deltas, caps, manual-order escrow and owner withdrawals; [local Phase 3 tests](PHASE3_STATUS.md). Public activation and strategy books remain disabled.
- [x] Implement bounded offchain price-time matching, partial fills, IOC/post-only/reduce-only, expiry and nonces; [Phase 2 signed local admission](CLOB_ADMISSION.md) is tested. Public activation remains gated on actual custody/settlement and deployment readiness.
- [x] Implement local signed bilateral settlement, fees, partial/full closes and liquidation for supported vanilla limit orders. Fuji remains disabled.
- [ ] Implement funding index settlement, payer limits, rounding, epoch protection and stale-gap behavior.
- [x] Verify local runtime size, Paris compatibility and tested fill/close gas bounds. Public Fuji execution costs/finality and independent assurance remain unqualified.

**Gate:** unit, differential, fuzz and conservation tests pass.

## 3. Strategy authority and genuine execution

- [ ] Implement isolated strategy allocation and finite, revocable onchain policies.
- [ ] Bind exact routes, assets, units, deadlines, exposure and cost budgets.
- [ ] Preserve conservative admission using a single capital allocation.
- [ ] Implement separately scoped execution validation only if needed.
- [ ] Execute real spot/perp legs with actual inventory/fill reconciliation.
- [ ] Prove atomic rollback or explicit partial-leg recovery, retained inventory ownership and owner exits.
- [ ] Persist chain/deployment-aware intents, nonces, costs and audit state.

**Gate:** adversarial authorization, execution, recovery and withdrawal tests pass.

## 4. Guardian and public transport

- [ ] Read funding, prices, policies and positions at one canonical block.
- [ ] Simulate and submit bounded actions with durable single-writer coordination.
- [ ] Handle unknown, replaced, reverted and cancelled transactions without duplicate exposure.
- [ ] Monitor delta, margin, funding expiry, counterparty exits and cost budgets.
- [ ] Verify genuine public funding conservation and successful-execution restart.
- [ ] Keep synthetic research fixtures out of live product execution paths.

**Gate:** real transport and restart reconciliation, not merely a submission hash.

## 5. Client and read boundary

- [ ] Preserve the existing landing and manual Trade terminal; verify valid navigation and Avalanche connectivity without rebuilding the UI.
- [ ] Wire wallet connection, chain switching, approvals, deposits and account-change invalidation.
- [ ] Show actual positions, funding units/history, gas, margin, costs and receipt links.
- [ ] Integrate strategy allocation, policy confirmation, pending legs, pause/revoke/recover/close/withdraw inside Trade.
- [ ] Validate read/proposal inputs, freshness, numeric bounds, request sizes and resource limits.
- [ ] Verify keyboard/focus/mobile and disconnected/loading/empty/failed states.

**Gate:** actual wallet-driven browser flow with canonical data; no simulated success substitute.

## 6. Assurance and public release

- [ ] Run seeded actual-runtime scenarios, both funding signs and failure/conservation matrices.
- [ ] Reconcile hand traces and metrics against actual token deltas, receipts, funding and gas.
- [ ] Review permissions, oracle/venue trust, replay, precision and transaction recovery.
- [ ] Add reproducible CI, clean install/build, contract/TS/browser checks and secret/dependency scanning.
- [ ] Deploy a fresh capped Fuji instance with verified code, assets, roles and run budgets.
- [ ] Verify deposit, matched trades, real swap/hedge, funding, recovery, revocation and settled owner withdrawals.
- [ ] Record whether public execution proves validation or economically admitted investment.
- [ ] Prepare setup/runbooks, safe stop/recovery, live URL, real transaction evidence and an accurate demo.
- [ ] Publish only after destination, disclosure and release checks pass.

**Gate:** evidence-backed public lifecycle, reconciled custody and no unresolved money/security blocker.

## Evidence discipline

Track implementation, integration availability, economic eligibility and activation separately. For each completed task record source revision, checks actually run, environment/network/deployment identity, receipt links where applicable, costs, pending liabilities and limitations.

Local and pinned-fork tests do not constitute public Fuji execution. A correct admission rejection does not prove a completed hedge. No promised profitability or fixed completion date.

## Deferred scope

Mainnet activation, rolling multi-interval carry, pooled shares, multiple venues/assets, custom L1 infrastructure, bridges, proxies and gas sponsorship require separate reviewed decisions.
