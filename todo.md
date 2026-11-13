# Avensdex — NEARFlow → Avalanche delivery

Authoritative source: the complete NEARFlow working tree, including dirty/untracked work, captured in [the source manifest](config/nearflow-source.json). Its `migration.md` defines the protocol port; its `todo.md` distinguishes existing features from unfinished genuine execution. Preserve those semantics. This is not a greenfield exchange or UI rebuild.

Local reference: `legacy/nearflow/` (ignored, not a published runtime). [Baseline and limitations](docs/NEARFLOW_BASELINE.md).

## Phase 1 — source baseline and EVM parity foundation (M0–M1)

- [x] Locate and read source architecture, current roadmap and complete Avalanche migration plan.
- [x] Snapshot working source including untracked landing/terminal/contract work; verify file hashes without changing the original.
- [x] Exclude credentials, environment files, dependency/build directories and private key files.
- [ ] Finish module-by-module review and establish fresh source regression results; old test counts are not new evidence.
- [ ] Preserve third-party notices; resolve landing code/artwork redistribution permission before publishing it.
- [ ] Pin EVM tools/compiler target; reuse the existing TypeScript/Rust funding references and golden vectors.
- [ ] Port funding controller math with signed-rounding, EMA, deadband, rate/step caps and signal validation parity.
- [ ] Port asset units and bilateral risk math; retain size6, price18, collateral6 and wrapped-base18/dust rules.
- [ ] Freeze typed vault/exchange/executor/oracle/reader interfaces, role bindings and manifest schema.
- [ ] Qualify exact Fuji collateral/base, independent oracle, spot route/version, finality and operational limits. AVAX/WAVAX is a candidate, not an enabled market.

**Gate:** reproducible local parity checks; exact integration blockers recorded. No address placeholders enable execution.

## Phase 2 — custody and matched exchange port (M2)

- [ ] Port canonical same-ledger free balances, strategy allocations, escrow, pair margins and insurance.
- [ ] Replace NEP-141 transfer-call/callback custody with exact-delta ERC-20 deposits and synchronous owner-only withdrawals.
- [ ] Reject fee-on-transfer/rebasing behavior; preserve donation/surplus separation and reentrancy protection.
- [ ] Port bounded price-time matching, self-trade prevention, partial fills, post-only/IOC/reduce-only, expiry and nonces.
- [ ] Port bilateral collateral-capped settlement, partial/full close, opening fees and liquidation distribution.
- [ ] Port funding accrual/index/remainders, payer caps, epoch/revision replay protection, oracle/rate expiry and no backfill.
- [ ] Verify unit/fuzz/conservation/invariant tests, code size and worst-case gas without unlimited-contract-size bypasses.

**Gate:** Solidity behavior matches source semantics; liabilities reconcile to actual custody.

## Phase 3 — existing terminal, wallet and API migration (M3)

- [ ] Reuse landing, chart/book/ticket, Markets, Portfolio, Leaderboard and settings; do not redesign or rebuild them.
- [ ] Replace NEAR wallet/callback handling with EVM connection, explicit Fuji switching and account/chain invalidation.
- [ ] Replace named accounts/NEAR RPC with address validation, versioned ABIs and block-pinned chain reads.
- [ ] Wire exact approvals, deposits, order/cancel/close and owner withdrawals; keep AVAX gas separate from collateral/inventory.
- [ ] Preserve read-only API endpoints; reject wrong chain, unknown deployment, stale data and request-provided targets.
- [ ] Show actual receipt/fill states, funding units/history, errors and Avalanche explorer links; no mock success fallback.
- [ ] Update branding/market symbols only where backed by configuration; preserve license notices and demo isolation.
- [ ] Pass local wallet-driven browser lifecycle, keyboard/mobile/accessibility and existing UI regressions.

**Gate:** actual local-EVM deposit → matched trade → funding/close → owner withdrawal in the preserved terminal.

## Phase 4 — strategies and durable EVM execution (M4)

- [ ] Port isolated strategy lifecycle, owner allocation/release, pause/close and fixed-recipient exits.
- [ ] Replace NEAR restricted keys with contract-enforced owner/executor/chain/deployment/route authority.
- [ ] Bind revisions, expiry, permissions, exposure, reserve/margin, costs/turnover, cooldown and canonical action nonces.
- [ ] Preserve single-capital budgeting and conservative collectible-funding admission; no positive-rate-only entries.
- [ ] Keep any owner-authorized execution-validation session separate from investment authority.
- [ ] Port durable intents/journals to a new chain/deployment-aware namespace; never rewrite or replay NEAR journals.
- [ ] Test revocation/replay, forbidden payouts, competing workers, crash/restart and unknown/replaced/reverted transaction reconciliation.

**Gate:** adversarial authorization and recovery tests pass; delegates cannot withdraw or expand authority.

## Phase 5 — spot, hedge composition and Guardian (M5–M6)

- [ ] Qualify one real Avalanche spot route using its actual protocol quoter; never relabel Ref math as LFJ Liquidity Book math.
- [ ] Bind router/version/path/assets, allowances, deadlines and output floors; reconcile actual base output and dust.
- [ ] Compose real spot/perp legs with tested all-or-nothing rollback, or explicit partial-leg state and bounded recovery.
- [ ] Preserve the four-action batch limit, item-level authorization and all-in cost accounting.
- [ ] Reconnect funding snapshots, opportunity/sizing, Guardian policies, shared budgets and one-decision-per-epoch controls.
- [ ] Monitor actual fills, counterparty exits, margin, residual delta/time, rate expiry and exhausted budgets; no blind re-entry.
- [ ] Finish the source's incomplete Vault/Hedge controls inside Trade using real actions and independent leg status.
- [ ] Pass real-runtime failure/conservation matrix, both funding signs, seeded scenarios and restart reconciliation.

**Gate:** genuine execution and owner recovery proven in the stated local/fork environment; no PAPER path masquerades as live execution.

## Phase 6 — capped Fuji validation, cutover and release (M7–M8)

- [ ] Obtain a bounded Fuji signing plan: accounts/actions, assets, funds/gas/exposure caps, expiry and stop/recovery conditions. Source NEAR spending authorization does not transfer to Fuji.
- [ ] Deploy fresh contracts paused/default-disabled; verify bytecode, ABI, module bindings, assets, roles and finite caps.
- [ ] Validate small deposits/owner withdrawals, matched trades, actual funding conservation, selected spot/hedge and owner exits.
- [ ] Prove pause/revoke/recovery and successful-execution restart using real receipts and token deltas.
- [ ] Complete clean-install/build/CI, dependency/secret/security checks and real browser-wallet verification.
- [ ] Reconcile existing NEAR liabilities and pending intents under original code; never reset/sweep funded state or mint destination credits from source snapshots.
- [ ] Retire active NEAR dependencies only after parity/cutover; preserve labeled legacy evidence and owner recovery.
- [ ] Publish accurate setup/operations, public evidence, costs, unresolved inventory/liabilities and safe-stop procedures.

**Gate:** reconciled public Fuji lifecycle with no unresolved custody/security blocker. A deployment hash, rejected opportunity or local/fork test does not pass the public gate.

## Execution rules

Use Ponytail; make small complete changes with directly related tests and inspected commits. Keep implementation parity, integration availability, economic eligibility and public activation separate. Mainnet/M9, GMX replacement, rolling carry and pooled shares are out of scope unless separately approved. Do not inherit source roadmap checkmarks as Avalanche completion.
