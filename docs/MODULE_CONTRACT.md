# Protocol interface contract — version 1

Status: frozen **initial interface specification**, compiled with Solidity 0.8.30. No vault/exchange/executor/oracle/reader implementations or deployed authorization are claimed. Changes to these boundaries require a reviewed spec/ABI change and updated tests, not silent reinterpretation. Current definitions are in `contracts/evm/src/interfaces/`.

## Identity, units and books

`Book(owner, strategyId)` identifies an immutable owner and either the manual book (`strategyId=0`) or that owner's existing isolated strategy. The vault verifies this relationship; a supplied Book is never authorization. Financial types follow [the units/risk specification](ASSET_AND_RISK_UNITS.md). Contract state is scoped to `block.chainid`, the vault deployment ID and fixed module addresses.

The vault alone owns free collateral, strategy free collateral, order escrow, pair margin amounts, insurance and raw strategy inventory. Exchange metadata stores order/pair identities, sizes, prices and funding checkpoints, not another spendable margin balance. A risk-library Pair is an ephemeral calculation snapshot. Reader/API/Guardian balances cannot credit custody.

```text
actual collateral custody = manual free + strategy free + escrow + pair margins + insurance + uncredited surplus
actual base custody       = attributed raw strategy inventory + uncredited base surplus
```

Pending external custody, if ever introduced, must leave local spendable buckets before the external action and have its own nonduplicated location/owner record. It is not needed for synchronous ERC-20 transfers and cannot be invented as a second refund path.

## Roles and fixed bootstrap

- Deploy only to explicit local C-Chain-compatible development (`31337`) or Fuji C-Chain (`43113`); mainnet is disabled.
- Constructor configuration fixes token identities, deployment ID, owner/bootstrap authority and independent oracle/publisher roles. No zero/default addresses or public initialization takeover.
- Owner-only `bindModules(exchange, executor)` executes once while deposits are disabled; check contract code, references and distinct identities, then freeze bindings. No module replacement, proxy upgrade or arbitrary-call route is included.
- `activateDeposits` is owner-only after bindings, token decimals/code, caps and chain identity pass verification. Trading/strategy activation has separate readiness and pause controls; deposit activation does not approve automation.
- Oracle publisher, owner and executor are distinct roles. Publisher has no ledger authority. Reader has no mutation authority. No `tx.origin` or unsigned HTTP identity is used.

## Typed call graph and required guards

| Path | Authoritative caller / checks | Accounting effect |
| --- | --- | --- |
| Wallet → Vault `deposit` | authenticated sender; active deposits; exact allowlisted ERC-20 delta; cap; reentrancy guard | actual custody and sender free collateral increase equally |
| Wallet → Vault withdrawal/allocation/policy/lifecycle | derive owner from `msg.sender`; verify strategy ownership; fixed recipient; free/unencumbered funds only | move existing liabilities or pay recorded owner; no delegate withdrawal |
| Wallet → Exchange manual/owner strategy methods | derive actor from sender; verify Book/order/pair ownership; preserve manual/strategy isolation | call only typed vault operations |
| Executor EOA → StrategyExecutor | `Authority.actor == msg.sender`; live onchain policy/revision, scoped permission, route, expiry, limits and risk checks | no independent custody ledger or payout ability |
| StrategyExecutor → Exchange strategy methods | only frozen executor may forward an actor; verify policy/Book again at canonical vault boundary | canonical per-book reservation/settlement |
| Exchange → Vault `reserveOrder` | only frozen exchange; real owner or currently authorized policy actor; monotonic canonical nonce; sufficient book free collateral | free → escrow, consumes the action nonce once |
| Exchange → Vault `releaseOrder/openPair` | only exchange; recorded reservation owners; unique order/pair identity; amounts bounded by remaining escrow | escrow → same book free / pair margins / opening fees |
| Exchange → Vault `transferFunding` | only exchange; known pair; payment bounded by payer margin | equal-opposite movement inside that pair; liability total unchanged |
| Exchange → Vault `settlePair` | only exchange; existing pair; released margins bounded; payout + insurance + liquidator reward equals released margins | credit recorded pair owners and approved fee/reward buckets; no arbitrary user credit |
| StrategyExecutor → Vault `executeSpot` | only frozen executor; verify actor/policy/nonce/expiry/permission; fixed registry route and token pair; nonreentrant exact approvals and deltas | debit only selected strategy; output recipient is vault; credit measured attributed inventory |
| Reader/API/Guardian → views | consistent canonical block, explicit chain/deployment, source age and resource limits | read-only; not authority to submit or withdraw |

`settlePair`'s liquidator parameter is only a bounded liquidation reward destination authenticated by the exchange's liquidation path, not an owner withdrawal recipient. The vault must reject nonzero reward for the zero address, excess release/reward and unknown pair IDs. Trade/funding/oracle rules are enforced by the exchange; the vault independently enforces ownership/bucket bounds and conservation. The exchange is therefore a critical trusted module, not an untrusted plugin.

Orders retain source bounds: size6 at most `1e15`, positive integer leverage capped by initial margin, expiry within 86,400 seconds, minimum one collateral currency unit notional, incompatible post-only/IOC rejection and bounded source order/position capacity. Leverage is dimensionless, not bps. Permissionless `matchOrders` must enforce actual best price-time priority and all execution checks; caller-supplied IDs cannot select a worse counterparty. `expireOrder` only releases an actually expired order; owner-only `cancelAll` stays bounded by that book's maximum 16 orders (marketId zero means all its markets). These ABI paths preserve source keeper/recovery functionality; they do not grant keeper payout authority.

No generic `credit`, `execute(bytes)`, arbitrary calldata, delegatecall, sweep-user-assets or delegate payout endpoint is specified. Synchronous transfer/swap failure reverts its entire accounting transition; do not copy NEAR asynchronous refund callbacks.

## Nonces and policies

- EOA transaction nonce is transport ordering only.
- Owner policy revision increases on approval/revocation and invalidates stale actions. Approval commits the actual onchain chain/deployment/owner/strategy/route identity; it cannot be replayed as a different vault's authority.
- The vault owns one monotonic application nonce per Book. It is independent of policy revision and EOA nonce; never reset it when a policy changes. `nextNonce` returns the minimum next acceptable nonce. A successful action consumes it exactly once, even across modules or batch items.
- Reservation-backed placement consumes the nonce in `reserveOrder`. Spot consumes it inside `executeSpot`. Strategy cancellation/close/reduce-only actions without reservation consume it through exchange-only `consumeStrategyAction`. Executor prechecks do **not** also consume it. Reversion rolls the whole nonce/accounting transition back.
- Forwarded identity is accepted only from frozen modules, with policy/ownership revalidation. Direct owner lifecycle/payout calls never accept a forwarded owner.
- Each batch has 1–4 actions, checks every Book/policy/nonce separately and reverts atomically on failure. A successful resting order is not a filled hedge.
- Policy permissions are explicit bit flags: OPEN=1, REDUCE=2, CANCEL=4, SPOT_BUY=8, SPOT_SELL=16. Unknown bits reject. Withdraw, approve/revoke and owner changes are never permissions.
- Policy turnover/cost/action caps are cumulative per revision, not reset by a worker restart. Horizon remains bounded by the source one-hour funding lifetime. A validation-purpose policy cannot be used for unattended investment. A max-action budget is not proof that residual market loss is bounded.
- Native executor gas budgets stay separately enforced operationally; `maxCosts6` is a collateral-denominated strategy budget, not spendable AVAX or a guarantee of EOA gas expenditure. No native-value executor endpoint is specified.

## Oracle/readiness

`IOracleAdapter.price` returns independent-source price18 and original source timestamp or reverts on invalid/nonpositive/future/stale data. Trusted-publisher parity can be implemented locally; a real feed/provider and cadence must qualify before public activation. Never stamp old data with read time or use informational chart data as settlement fallback.

`Readiness.ready` is false for incomplete code/module/asset/role checks, pause, expired source/rate or missing required integration. Rate update/configuration settles the old index, preserves epoch/revision constraints and cannot backfill stale gaps. These are implementation requirements, not behavior established by interface selector tests.

## Deployment manifest boundary

`packages/protocol/manifest.ts` defines schema 1 and validates untrusted configuration: exact fields, local/Fuji chain allowlist, disabled execution/mainnet, pinned tools, nonzero normalized addresses/hashes, distinct modules/assets/roles, collateral6/base18, finite caps and explicit nullable evidence digests. Missing public integration evidence remains null. No usable deployment manifest with invented addresses is committed.

Schema validation proves only structure. Addresses, code hashes, report digests and receipts must be independently reconciled with canonical RPC state; parser success cannot enable signing, prove token behavior, establish liquidity or qualify an oracle. Initial schema deliberately has no enabled-execution mode. A later activation schema requires its own reviewed evidence/authorization gate.

## Required implementation tests

Interfaces compile and selected stable selectors are checked, including recipient-free payout ABIs. Parser adversarial tests reject unsafe configuration. Neither proves actual contract authorization. Phase 2/4 must add malicious module/token/reentrancy tests, bootstrap takeover/rebind rejection, cross-book conservation, fixed-owner payout, nonce/revision replay, revocation and policy/batch isolation against deployed local implementations before activating them.
