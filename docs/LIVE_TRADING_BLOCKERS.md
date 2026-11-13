# Live-trading blockers — Phase 2 checkpoint

**Decision: NOT READY. Keep public trading/settlement and Autopilot disabled.** Phase 2 local signed matching/data delivery is implemented; none of its provisional events establish collateral, positions, liquidity or a public fill.

## Checked now

- `config/fuji.json`: Fuji `43113`, `executionEnabled:false`, `mainnetEnabled:false`, no deployed module/asset/oracle addresses. The current manifest parser rejects execution-enabled configurations.
- Solidity source: interfaces and pure math/authentication libraries only. No implemented canonical vault, stateful exchange/settlement, funding controller or strategy executor. The new hash/recovery library is not a settlement shortcut.
- Executable journal binding: settlement contract unset. HTTP writes and `/ready` return 503; signed in-process authorization cannot turn on those endpoints. Tests verify both null and nonzero fixture bindings remain network-write-disabled.
- Real public, **read-only** RPC observation at `2026-11-13T16:21:02.095354+00:00`: both fixed providers agreed on Fuji block **61012562**, hash **`0xbbd024b42de463b53fd6f48605a27c85b24b406685c79d0bcac531e38f590b19`**, timestamp **1794586852**; heads **61012564/61012565**. This is identity/same-height agreement, not a finality guarantee or application readiness. An earlier comparison attempt failed closed; separate provider reads and the recorded repeat passed. The initial failure's cause was not captured, so no root-cause claim or stable-availability guarantee is made.
- No public deployment, public wallet signing, token movement or gas expenditure. Local signatures and synthetic addresses are test fixtures only. Earlier USDC metadata observations were not rerun as a full asset qualification and do not enable collateral.

## Blocking manual perpetual trading

| Blocker | Required closure |
| --- | --- |
| **No canonical custody implementation** | Exact token deltas, capped deposits, single free/escrow/margin/insurance liability ledger, reentrancy/donation handling, authenticated fixed-owner withdrawals and conservation tests. |
| **No atomic settlement implementation** | Independently enforce both EIP-712 sides, fees/leverage/margin/price limits, partial-fill counters, nonce reuse/invalidation, expiry, close/liquidation and rollback. Prove unsafe/unsupported order types reject. |
| **No onchain cancellation/race handling** | Authoritative cancellation/invalidation versus already pending fills. Offchain signed cancellation alone cannot revoke an onchain authorization. |
| **No reconciler/confirmed risk state** | Durable settlement intent identity; canonical receipt/fill/balance/position reconciliation; replacement/revert/unknown/reorg policy; pending reservations and safe rejection/recovery without blind retry or invented positions. |
| **Assets, oracle and market unqualified** | Approve initial market; verify collateral/base/proxy/admin/transfer behavior and independent index/mark freshness. Candidate metadata is insufficient. Matcher must not control liquidation/funding. |
| **Stateful funding not integrated** | Baseline/adaptive epochs/index, freshness/expiry, caps, payer capacity and conservation. Pure rate math alone is not applied funding. |
| **Existing EVM terminal not wired** | Genuine wallet/chain invalidation, approvals/deposits, signed tickets, confirmed positions/margin/costs and actual receipt links; browser/error/reconnect tests. No replacement demo page. |
| **No approved public execution plan/deployment** | Separate owner authorization with exact identities/actions, finite funds/gas/exposure, expiry and stop/recovery; deploy paused/capped, verify code/roles/domain/assets, then actual bounded lifecycle evidence. |

Do not bypass these by setting `executionEnabled`, supplying an address, adding a server signer, crediting offchain balances or treating matcher trades as confirmed. Independent signature verification is necessary but not funded risk approval. Public API admission also needs actual deployment/readiness validation and bounded abuse controls before activation.

## Additional Autopilot/release blockers

- No genuine independent spot/perp adapters, two-way executable liquidity at intended sizes or cost-aware hedge eligibility. No real paired-leg reconciliation, residual-delta repair or verified inventory ownership.
- No deployed scoped/revocable mandates or tested owner pause/revoke/close/recover/settled-withdraw lifecycle. The ignored source Guardian's PAPER-only guard must not be removed to fabricate a real adapter.
- Source landing/artwork redistribution rights remain unresolved; this blocks publishing those files, not implementing the isolated core. Preserve notices and the original source/funded state.
- Full existing-terminal build/browser regression, independent money/security review, operating limits/finality policy and actual capped Fuji lifecycle evidence remain pending. Local/CI/benchmark results cannot replace them.

**Next implementation priority:** Phase 3 custody + signed atomic bilateral settlement and adversarial/conservation tests; then confirmed reconciliation and existing-terminal/funding integration. Live Autopilot follows genuine both-leg/authority/recovery verification. See [`todo.md`](../todo.md) for the full ordered checklist.
