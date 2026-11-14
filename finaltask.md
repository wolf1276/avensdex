# Final predeployment task list

Status: **NOT READY FOR PUBLIC DEPLOYMENT**. This is an acceptance checklist, not evidence of completion. Fuji C-Chain only (`43113`); mainnet remains disabled. Frontend/backend integration is deferred, not silently completed. No public signing, spending, deployment or activation is authorized by this document.

## Definition of done

Two separate gates apply:

1. **Paused deployment ready:** reviewed artifacts and bounded operator tooling can create Vault, FeedOracle and Settlement and bind settlement, with deposits inactive and entries paused. No collateral transfer or trading.
2. **Protocol complete except frontend/backend integration:** funding, strategy authority, real execution adapters and recovery are implemented and tested independently of UI/service wiring. This is substantially more work than paused deployment.

A checkbox needs a reviewed commit plus reproducible test/evidence references. Public results additionally need chain/address/block/receipt identity. Local mocks and historical forks never satisfy public evidence requirements.

## 1. Existing local foundation

- [x] Canonical exact-delta vault, escrow, isolated pair margins, fees/insurance and fixed-owner withdrawals.
- [x] Bilateral signed vanilla-limit settlement, replay/cancel/fill checks, bounded funding application, closes and liquidation.
- [x] Two-feed oracle adapter locally tested; capped paused Fuji activation capability.
- [x] Deterministic matcher, signed admission, durable journal, loopback market-data transport and client resync reducer.
- [x] Offline bounded four-transaction deployment planner and durable reconciliation journal.
- [x] Two-provider read-only deployment reader and inspection CLI (`8b0912a`).
- [x] Offline deployment-plan CLI (`03e2658`).

References: `docs/PHASE3_STATUS.md`, `docs/PAUSED_DEPLOYMENT_RECOVERY.md`, `docs/CLOB_ADMISSION.md`. These are local capabilities, not deployed integrations.

## 2. Protocol work: complete before claiming only integration remains

- [x] Connect canonical settlement-journal reconciliation to durable matcher/feed outcomes and pending-match capacity; generated-signature, restart/reorg and loopback tests are local fixtures, not public execution.
- [x] Add complete bounded policy-confirmed position aggregation, paired-provider ledger checks, real block timestamps and fail-closed service/feed refresh; mocked RPC/loopback evidence only, no public deployment or unsupported-order activation.

- [ ] Specify independent index, validated mark and premium observations; reject matcher-only price control, stale data and manipulation.
- [x] Add a pure local funding-controller reference using existing baseline/adaptive math, epoch/revision checks, expiry, stale-gap handling and fractional index carry; see `docs/FUNDING_CONTROLLER.md`.
- [x] Implement a standalone onchain baseline/adaptive funding adapter with configured bounds, scoped configuration/publisher authority and epoch/revision checks; test against the real local vault/settlement lifecycle (`docs/FUNDING_CONTROLLER.md`).
- [ ] Qualify independent index/mark sources, review economic parameters and integrate the new funding adapter into deployment/publisher tooling; the existing four-transaction deployment plan still uses the manual-rate feed adapter.
- [x] Implement funding epochs, monotonic publication, replay protection, rate expiry, stale-gap behavior and fractional index settlement in the standalone funding adapter; local tests only.
- [ ] Differential-test funding against source references; test both signs, rounding carry, payer clipping, restart and conservation over multiple epochs.
- [ ] Extend the single canonical ledger with isolated strategy allocation, owned spot inventory, reserves, costs and insurance accounting; no second spendable balance.
- [ ] Implement finite owner policies binding chain/deployment, executor, revision, nonce, expiry, routes/assets, exposure and cost budgets.
- [ ] Test executor scope, revocation, allowance separation, replay, fixed recipients and owner-only recovery/withdrawal.
- [ ] Implement independently sourced spot/perp quotes and conservative single-allocation sizing/admission, including both-leg fees, gas, repair and adverse exits.
- [ ] Implement genuine allowlisted venue execution with bounded slippage, deadlines and actual inventory/fill reconciliation.
- [ ] Prove atomic rollback where actually supported; otherwise implement explicit partial-leg states and bounded owner-authorized repairs.
- [ ] Implement Guardian observation, durable single-writer decisions/intents and canonical position/policy reads at one block.
- [ ] Test unknown/replaced/reverted/cancelled outcomes, restart, residual delta, funding reversal/expiry, payer exhaustion, counterparty exits and exhausted budgets.
- [ ] Implement pause/revoke/cancel/close/recover/settled-withdraw lifecycle without funded-state reset.
- [ ] Keep unsupported contract order flags disabled unless each is separately implemented with risk and authorization tests.

References: `todo.md` Phases 4–5, `docs/ARCHITECTURE.md`, `docs/LIVE_TRADING_BLOCKERS.md`. Controller/strategy/Guardian core logic is NOT deferred as frontend/backend integration.

## 3. Deployment operator tooling

- [x] Add bounded offline extraction of ABI/creation code from the three fixed Foundry artifact paths into planner format, with malformed/unlinked-code rejection tests.
- [ ] Review extracted ABI/creation code against the frozen source/tool versions and constructor parameters; extraction alone is not qualification.
- [ ] Derive and verify constructor-dependent runtime hashes, including immutable values; do not equate creation-code hashes with deployed runtime.
- [x] Wire journal reconciliation to the two-provider reader through a bounded operator CLI; explicitly distinguish read-only RPC from local journal writes. Local unit tests use injected fake readers and fixture journals; RPC reads remain read-only while successful reconciliation may append local journal records.
- [ ] Add operator-controlled signing with approval/plan binding and expiry checks; no server-side trading signer or credentials in repository/config/logs.
- [ ] Persist recoverable signed material securely outside Git and record intent/identity before dispatch.
- [ ] Add serial broadcast gated on exact sender, nonce, calldata, value, gas/fees, current approval and remaining budget.
- [ ] Recheck chain, provider agreement, pending/latest nonce, balance/reserve and qualification immediately before each action.
- [ ] Test interrupted dispatch, missing hash, provider timeout/disagreement, reorg, reverted creation/binding, expired approval and nonce conflict.
- [ ] Reserve worst-case cost of unknown/pending transactions; no automatic retry, replacement, nonce release or budget reset.
- [ ] Document separately authorized replacement/cancellation and safe stop/recovery; never overwrite a funded journal.
- [ ] Run a fresh loopback end-to-end test through the actual operator tooling before public use.

References: `packages/protocol/deployment.ts`, `docs/PAUSED_DEPLOYMENT_RECOVERY.md`.

## 4. Qualification and external evidence (cannot be completed by writing code)

- [ ] Confirm initial market, base/collateral assets and settlement assumptions.
- [ ] Verify collateral address, decimals, implementation/proxy/admin identity, upgrades, blacklist/pause behavior and exact transfer semantics.
- [ ] Verify both oracle feed proxies/implementations/controllers, units, heartbeat/deviation assumptions, freshness and failure behavior.
- [ ] Qualify a genuine spot venue and exact route/assets; record intended-size quotes, depth, fees and entry/exit/repair constraints.
- [ ] Adopt a finality/confirmation/reorg policy and independent provider operating policy.
- [ ] Obtain sufficient test AVAX and legitimate test collateral without requesting or committing secrets.
- [ ] Review remaining semantic/security issues; obtain and address independent review before a public trading-readiness claim.
- [ ] Resolve applicable source redistribution rights and preserve provenance/notices. Landing/artwork rights remain unresolved; exclude those files until permission exists.
- [ ] Reconcile any original NEAR liabilities/pending state under original code if applicable; do not migrate authority or reset balances.
- [ ] Verify applicable publication/program requirements and disclosures.

References: `docs/FUJI_QUALIFICATION.md`, `docs/FUJI_ORACLE_CANDIDATES.md`, `docs/NEARFLOW_BASELINE.md`, `docs/FUJI_DEPLOYMENT_PLAN.md`.

## 5. Release verification

- [ ] Freeze reviewed source revision, dependencies, compiler/EVM settings and artifact hashes.
- [ ] Run clean tracked-source installation, typecheck and complete TS/Python/Foundry/local-Anvil suite.
- [ ] Run locked Rust references, formatting, seeded fuzz/invariant/differential tests and historical-fork checks where relevant.
- [ ] Inspect permissions, oracle/venue trust, rounding, conservation, replay and recovery boundaries.
- [ ] Recheck deployed bytecode size and gas bounds for the final build.
- [ ] Run dependency/secret checks and inspect staged/release contents; retain licenses and notices.
- [ ] Verify hosted CI for the frozen revision; record actual evidence and unresolved findings.

## 6. Explicit paused-deployment authorization

- [ ] Confirm deployer/bootstrap owner, distinct funding publisher, collateral and both feed addresses; verify key control without exposing keys.
- [ ] Freeze deployment ID, market, cap, feed ages, constructors, predicted addresses, starting nonce and all four transaction identities.
- [ ] Freeze approval ID/approver, exact plan hash/source revision, UTC expiry (at most 24 hours), per-transaction gas/fee limits and total budget (at most 0.05 test AVAX under current planner).
- [ ] Confirm zero native transfer value, cap at most 10 USDC and no approval/deposit/activation/trade/hedge in deployment scope.
- [ ] Assign recovery owner and accept explicit stop conditions; obtain user approval of the complete bounded packet.

## 7. Authorized public paused deployment and verification

Only after Sections 3–6 pass and applicable Section 4 gates are evidenced:

- [ ] Fresh two-provider preflight: Fuji chain, nonce/pending state, gas balance, asset/feed identities and current evidence.
- [ ] Deploy Vault, FeedOracle and Settlement serially; reconcile every transaction before the next.
- [ ] Bind settlement once; verify canonical receipts, runtime/ABI/source, constructor storage, ownership, publisher, references, domain and cap.
- [ ] Verify deposits inactive, entries paused and no unexpected liabilities; publish genuine addresses/receipt links and costs.
- [ ] Verify source on explorer where supported and record limitations honestly.
- [ ] Demonstrate restart reconciliation and safe stop without blind retry or journal reset.

## 8. Separate activation and lifecycle authorization

Paused deployment is not trading readiness:

- [ ] Obtain separately bounded authorization for activation, funding publication, collateral acquisition/approval/deposit/withdrawal and any trades/hedges.
- [ ] Verify fresh independent prices and valid funding checkpoint before activation.
- [ ] Prove tiny real owner deposit/withdrawal, signed bilateral fill, funding, close and reconciled final withdrawal with actual token deltas/receipts.
- [ ] Prove real hedge/partial-leg recovery/revocation and restart where strategy functionality is claimed.
- [ ] Preserve all pending liabilities; publish accurate runbooks, costs, limitations and evidence, without profitability claims.

## 9. Explicitly deferred frontend/backend integration

- [ ] Existing terminal wallet/network/account invalidation, approvals/deposits and supported order controls.
- [ ] Service wiring for admission, provisional/pending/confirmed/reverted state, canonical settlement capacity release and live data.
- [ ] Funding/position/cost/receipt displays and strategy controls inside Trade.
- [ ] Browser reconnect/resync, accessibility/mobile and disconnected/loading/error scenarios.
- [ ] Public hosting/authentication/rate limits/abuse controls and operational monitoring integration.

These integrations remain necessary for a usable public product, even after contract/operator readiness.

## Preservation constraints

- Preserve existing terminal branding/layout.
- Preserve PAPER-only source guards; do not bypass them to fabricate adapters.
- Add real local wallet/browser-flow tests during integration; existing protocol fixtures are not browser evidence.
- Perform incremental semantic review for each changed unit.

## Current evidence for this task

OpenCode drafted the bounded deployment-plan CLI descriptor-safety fix and separately reviewed it. Parent review added a subprocess timeout to the FIFO regression and an exact-size boundary test. `npm test` passed locally, including typecheck, TypeScript/Python suites, 118 Foundry tests and the 24-receipt fresh Anvil lifecycle. This is not a clean-install, hosted-CI, browser, historical-fork or public-deployment verification. The checklist remains an acceptance list, not evidence of deployment. No operator keys were accessed, no public transactions were sent, and no blockers above have been silently waived.
