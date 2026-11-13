# Avensdex architecture

**Status: Avalanche target design for the existing NEARFlow protocol port, not deployed infrastructure.**

Preserve the existing product and terminal identified in [the baseline report](NEARFLOW_BASELINE.md). The [CLOB audit and implementation plan](CLOB_PLAN.md) and [`todo.md`](../todo.md) supersede the prior onchain-matching delivery order. NEAR remains untouched; new matcher/market-data/EVM code is isolated. This architecture changes execution boundaries, not perpetual/funding/vault/Guardian scope.

## Product boundary

Avensdex targets Avalanche C-Chain, initially on Fuji (chain ID 43113). The initial scope is one perpetual market, explicitly verified collateral and a bounded spot/perp hedge strategy. Mainnet is disabled.

The exchange uses isolated, bilateral positions. Each matched pair holds both sides' margin; settlement cannot create claims against unrelated users. Profits are capped by the counterparty's available pair margin. This is not an uncapped cross-margin product.

## Low-latency execution boundary

One-market price-time matching and book updates occur offchain in a deterministic TypeScript process. Accepted commands are journaled/fsynced before acknowledgment; all trades are provisional until canonical onchain settlement. Sequenced snapshots/deltas expose gaps, blocked/pending settlement and confirmed positions distinctly. This is a centralized matcher with ordering/censorship/liveness risk, not a fully decentralized order book.

EIP-712 order authorization binds trader, chain ID, verifying settlement contract, market, price/size, nonce, expiry, fees and supported flags. The onchain settlement module validates both signed sides, cancellation/invalidation, cumulative fills, collateral/margin, fees and position constraints atomically. It never trusts a matcher credit, offchain available balance or claimed fill. Matching/cancel races are resolved by contract validity, not HTTP acknowledgment. No transaction is sent for every depth update.

The active product has no PAPER mode, synthetic balances or simulated execution: genuine execution targets Fuji only. Until a real verified deployment and required integrations exist, admission/settlement/positions report unavailable. Local unit/fuzz/benchmark fixtures are tests, not public trades or product liquidity.

## Proposed components

| Component | Responsibility |
| --- | --- |
| Vault | Canonical token custody, free balances, escrow, pair margins, strategy inventory, insurance and owner payouts |
| Matcher / market-data service | Deterministic offchain price-time book, durable commands, signed admission and sequenced WebSocket snapshots/deltas; no custody or withdrawal authority |
| Exchange / settlement | Validate signed matched fills atomically onchain; cancellation/invalidation, cumulative fills, positions, funding and liquidation; no onchain book-update transport |
| Strategy executor | Owner-approved policies, bounded spot/perp actions, deadlines, costs, revocation and replay protection |
| Oracle adapter | Independently sourced prices, verified units and source freshness |
| Reader | Read-only aggregate views and readiness snapshots |
| Guardian | Offchain observation, conservative admission, durable intent submission and reconciliation |
| Client | Landing, manual Trade terminal and integrated strategy controls |

No component may create a second spendable representation of the same collateral. Module calls must be typed and narrowly authorized; no generic arbitrary-call executor or unrestricted balance-credit method.

## Financial invariants

- Account, strategy, escrow, pair-margin and insurance liabilities reconcile to actual token custody.
- Direct token donations do not mint depositor credit.
- Owner payouts have fixed, authenticated recipients; delegates cannot withdraw or expand their authority.
- Native AVAX gas, wrapped asset inventory and collateral balances remain distinct.
- One allocation funds spot inventory, perp margin, reserves and costs. Short notional is not free cash.
- Funding transfers conserve collateral, honor payer limits and retain fractional rounding rules.
- Stale or invalid settlement data fails closed. Informational chart data is not a fallback oracle.

## Authority and execution

Policies bind chain, deployment, owner, strategy, executor, revision, nonce, expiry, route, exposure and cost limits. Token allowance is separate from strategy authorization.

Persist intent identity before submission. Track transaction status separately from order fills. Reconcile canonical receipts, balances and positions before recording execution success or retrying an unknown outcome.

A spot/perp entry is atomic only if the actual contract composition reverts the whole operation on either leg's failure. Otherwise partial legs need explicit pending state, bounded repair and owner recovery.

## Funding and strategy admission

The controller design includes baseline/adaptive modes, premium validation, smoothing, deadband, slope/absolute caps and rate expiry. Parameters and arithmetic require explicit specification and differential tests before deployment.

Last trade, independent index and validated mark are distinct. Use reliable independent reference data and validated settled observations; matcher-generated prices cannot unilaterally control funding or liquidation. Long and short OI are matched, so their difference is not the primary funding signal.

Positive quoted funding does not establish an economic opportunity. Admission includes collectible funding, payer capacity, both-leg entry/exit, gas, reserves, repair allowance and adverse-exit risk.

An owner-authorized execution-validation session must remain distinct from investment admission. Validation evidence is not profitability evidence or permission for unattended entries.

## Proposed development stack

- Solidity and Foundry for contract implementation and invariant/fuzz tests
- TypeScript with explicit bigint units and chain/deployment-aware DTOs
- Next.js/React for the client
- Compatible EVM wallet/public-client tooling, selected and pinned during implementation
- One independently verified spot venue integration initially

Initial Node/TypeScript, Foundry/Solidity and Rust-reference tools are pinned; [local foundation results](PHASE1_STATUS.md) record their checks. Actual deployments, asset behavior, oracle feeds and executable routes remain unqualified until the corresponding gate passes. Candidate metadata reads and parser success cannot enable execution; no address placeholders silently enable it.
