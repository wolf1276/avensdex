# Live-trading blockers — Phase 2 checkpoint and partial custody update

**Decision: NOT READY. Keep public trading/settlement and Autopilot disabled.** Phase 2 local signed matching/data delivery is implemented; none of its provisional events establish collateral, positions, liquidity or a public fill.

## Checked at the Phase 2 checkpoint

Signed implementation basis: `e09050a`, plus the response-time RPC freshness fix described below. Subsequent custody slice `799d668` is linked below; the complete Phase 3 gate remains open.

- `config/fuji.json`: Fuji `43113`, `executionEnabled:false`, `mainnetEnabled:false`, no deployed module/asset/oracle addresses. The current manifest parser rejects execution-enabled configurations.
- Solidity source now includes the [local-only custody slice](COLLATERAL_VAULT.md): exact-delta free balances and owner withdrawals, with Fuji activation hard-disabled. Its 24 custody tests pass, including an independent rerun. Full escrow/margin/insurance/strategy buckets, stateful exchange/settlement, funding controller and strategy executor remain unimplemented. Hash/recovery helpers are not settlement shortcuts.
- Executable journal binding: settlement contract unset. HTTP writes and `/ready` return 503; signed in-process authorization cannot turn on those endpoints. Tests verify both null and nonzero fixture bindings remain network-write-disabled.
- Real public, **read-only** RPC observation at `2026-11-13T19:15:33.492053+00:00`: both fixed providers agreed on Fuji block **61019217**, hash **`0x2c856e6ac3410e78d0e0fa4182fd2e198e2ec9f979796d9fce77909fe0c99e5e`**, timestamp **1794597326**; heads **61019219/61019221**. This is identity/same-height agreement, not finality or application readiness. During the review, probes failed closed with a freshness error. A reproduced timing bug sampled the wall clock before RPCs completed, falsely rejecting heads produced in flight; the corrected probe samples after each response. A regression failed before the fix and all 12 Python tests pass afterward. This does not prove every earlier failure had that cause or establish stable provider availability.
- No public deployment, public wallet signing, token movement or gas expenditure. Local signatures and synthetic addresses are test fixtures only. Earlier USDC metadata observations were not rerun as a full asset qualification and do not enable collateral.

## Blocking manual perpetual trading

| Blocker | Required closure |
| --- | --- |
| **Canonical custody only partially implemented** | Local free-balance custody/caps/exact deltas/owner exits are tested. Extend the same ledger with escrow/reservations, margin, fees/insurance and strategy buckets, prove conservation and implement reviewed module/deployment activation before public deposits. |
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

**Next implementation priority:** extend the partial canonical custody ledger + signed atomic bilateral settlement and adversarial/conservation tests; then confirmed reconciliation and existing-terminal/funding integration. Live Autopilot follows genuine both-leg/authority/recovery verification. See [`todo.md`](../todo.md) for the full ordered checklist.
