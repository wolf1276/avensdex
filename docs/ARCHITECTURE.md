# Avensdex architecture

**Status: Avalanche target design for the existing NEARFlow protocol port, not deployed infrastructure.**

Preserve the existing source architecture and terminal identified in [the baseline report](NEARFLOW_BASELINE.md). The source's complete `migration.md` defines the port; [`todo.md`](../todo.md) maps its M0–M8 sequence into six delivery phases. The component split below replaces NEAR chain boundaries, not the product's economic semantics.

## Product boundary

Avensdex targets Avalanche C-Chain, initially on Fuji (chain ID 43113). The initial scope is one perpetual market, explicitly verified collateral and a bounded spot/perp hedge strategy. Mainnet is disabled.

The exchange uses isolated, bilateral positions. Each matched pair holds both sides' margin; settlement cannot create claims against unrelated users. Profits are capped by the counterparty's available pair margin. This is not an uncapped cross-margin product.

## Proposed components

| Component | Responsibility |
| --- | --- |
| Vault | Canonical token custody, free balances, escrow, pair margins, strategy inventory, insurance and owner payouts |
| Exchange | Bounded matching, order lifecycle, positions, funding and liquidation |
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

Positive quoted funding does not establish an economic opportunity. Admission includes collectible funding, payer capacity, both-leg entry/exit, gas, reserves, repair allowance and adverse-exit risk.

An owner-authorized execution-validation session must remain distinct from investment admission. Validation evidence is not profitability evidence or permission for unattended entries.

## Proposed development stack

- Solidity and Foundry for contract implementation and invariant/fuzz tests
- TypeScript with explicit bigint units and chain/deployment-aware DTOs
- Next.js/React for the client
- Compatible EVM wallet/public-client tooling, selected and pinned during implementation
- One independently verified spot venue integration initially

Initial Node/TypeScript, Foundry/Solidity and Rust-reference tools are pinned; [local foundation results](PHASE1_STATUS.md) record their checks. Actual deployments, asset behavior, oracle feeds and executable routes remain unqualified until the corresponding gate passes. Candidate metadata reads and parser success cannot enable execution; no address placeholders silently enable it.
