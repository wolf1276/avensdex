# Live-trading blockers — Phase 3 local checkpoint

**Decision: NOT READY for public execution. Keep public trading/settlement and Autopilot disabled.** Phase 2 and the [supported manual Phase 3 local-EVM gate](PHASE3_STATUS.md) pass. Actual local contract fills/owner exits do not establish public collateral qualification, deployment, liquidity or a Fuji fill.

## Recorded checkpoint evidence

Historical Phase 2 signed implementation basis: `e09050a`, plus the response-time RPC freshness fix described below. The subsequent [Phase 3 local evidence](PHASE3_STATUS.md) supersedes the earlier partial-custody implementation status, not the public qualification/activation blockers.

- `config/fuji.json`: Fuji `43113`, `executionEnabled:false`, `mainnetEnabled:false`, no deployed module/asset/oracle addresses. The current manifest parser rejects execution-enabled configurations.
- Solidity now includes the [canonical manual ledger](COLLATERAL_VAULT.md), signed bilateral settlement, bounded independent funding-index application and close/liquidation. Fresh local Anvil execution and adversarial/property checks pass; [Phase 3](PHASE3_STATUS.md) records limits. The [capped Fuji activation mechanism](FUJI_ACTIVATION.md) is implemented and historically fork-tested but not publicly deployed/activated. Strategy books/executor, adaptive funding/epochs and a qualified public oracle remain unimplemented or unintegrated; local hashes/receipts are not activation shortcuts.
- Executable journal binding: settlement contract unset. HTTP writes and `/ready` return 503; signed in-process authorization cannot turn on those endpoints. Tests verify both null and nonzero fixture bindings remain network-write-disabled.
- Real public, **read-only** RPC observation at `2026-11-13T19:15:33.492053+00:00`: both fixed providers agreed on Fuji block **61019217**, hash **`0x2c856e6ac3410e78d0e0fa4182fd2e198e2ec9f979796d9fce77909fe0c99e5e`**, timestamp **1794597326**; heads **61019219/61019221**. This is identity/same-height agreement, not finality or application readiness. During the review, probes failed closed with a freshness error. A reproduced timing bug sampled the wall clock before RPCs completed, falsely rejecting heads produced in flight; the corrected probe samples after each response. A regression failed before the fix and all 12 Python tests pass afterward. This does not prove every earlier failure had that cause or establish stable provider availability.
- No public deployment, public wallet signing, token movement or gas expenditure. Local signatures and synthetic addresses are test fixtures only. Earlier USDC metadata observations were not rerun as a full asset qualification and do not enable collateral.

## Blocking manual perpetual trading

| Blocker | Required closure |
| --- | --- |
| **Public custody activation unqualified and disabled** | Manual free/escrow/margin/fee/insurance accounting and immutable module binding pass locally. Independently qualify the actual asset/deployment/roles and implement a reviewed public activation gate. Strategy buckets remain disabled until Phase 5 authority/risk checks; never add parallel credit. |
| **Settlement not publicly deployed/verified** | Local atomic EIP-712 fills, risk/collateral/fee/nonce/cancellation/close/liquidation tests pass for manual vanilla limit orders. Independent assurance and a bounded verified Fuji deployment/lifecycle are still required. Unsupported flags/types stay disabled. |
| **Public cancellation/admission wiring absent** | Local exact-hash cancellation, explicit nonce invalidation and race handling are tested. Wire actual owner wallet transactions/canonical receipts before public admission; an offchain signed acknowledgment alone cannot revoke an onchain authorization. |
| **Reconciliation not activated in a live deployment** | Durable intent/receipt/replacement/unknown/reorg handling and pinned canonical position reads pass locally, including actual Anvil ABI/receipt/restart checks. Qualify public providers/finality, deployment identity and operational reconciliation before enabling any submission worker or confirmed public views. |
| **Assets, oracle and market unqualified** | Approve initial market; verify collateral/base/proxy/admin/transfer behavior and independent index/mark freshness. Candidate metadata is insufficient. Matcher must not control liquidation/funding. |
| **Adaptive funding/public oracle not integrated** | Local bounded-rate index settlement, freshness/expiry, payer caps/remainders and conservation are implemented. Baseline/adaptive premium/mark/epoch integration and qualified independent public source roles/cadence remain Phase 4/release gates. |
| **Existing EVM terminal not wired** | Genuine wallet/chain invalidation, approvals/deposits, signed tickets, confirmed positions/margin/costs and actual receipt links; browser/error/reconnect tests. No replacement demo page. |
| **No approved public execution plan/deployment** | Separate owner authorization with exact identities/actions, finite funds/gas/exposure, expiry and stop/recovery; deploy paused/capped, verify code/roles/domain/assets, then actual bounded lifecycle evidence. |

Do not bypass these by setting `executionEnabled`, supplying an address, adding a server signer, crediting offchain balances or treating matcher trades as confirmed. Independent signature verification is necessary but not funded risk approval. Public API admission also needs actual deployment/readiness validation and bounded abuse controls before activation.

## Additional Autopilot/release blockers

- No genuine independent spot/perp adapters, two-way executable liquidity at intended sizes or cost-aware hedge eligibility. No real paired-leg reconciliation, residual-delta repair or verified inventory ownership.
- No deployed scoped/revocable mandates or tested owner pause/revoke/close/recover/settled-withdraw lifecycle. The ignored source Guardian's PAPER-only guard must not be removed to fabricate a real adapter.
- Source landing/artwork redistribution rights remain unresolved; this blocks publishing those files, not implementing the isolated core. Preserve notices and the original source/funded state.
- Full existing-terminal build/browser regression, independent money/security review, operating limits/finality policy and actual capped Fuji lifecycle evidence remain pending. Local/CI/benchmark results cannot replace them.

**Next implementation priority:** Phase 4 existing-terminal wallet/canonical-data integration and adaptive funding/mark/epoch lifecycle, without enabling public writes before qualification/deployment approval. Phase 5 Autopilot follows genuine both-leg/authority/recovery verification. See [`todo.md`](../todo.md) for the full ordered checklist.
