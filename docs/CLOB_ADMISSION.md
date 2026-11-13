# Phase 2 signed admission — implemented, not activated for live trading

The local Phase 2 gate is complete: deterministic matching/journal/transport plus EIP-712 authorization, durable signed proofs, replay/cancellation checks and adversarial tests. **Public trading remains unavailable.** Completing Phase 2 does not complete collateral settlement or qualify a deployment.

## Authority boundary

`packages/clob/admission.ts` verifies EOA signatures, creates canonical order IDs and passes authorized commands/proofs to the existing journal. `service.applySigned(envelope)` is a **trusted in-process integration API**, not a network endpoint or signer. It fsyncs before publishing sequenced provisional events. The CLI still binds an unset settlement contract and refuses it. All HTTP mutations and `/ready` remain 503, even when a test journal is bound to a nonzero address. An address or valid signature is not deployment verification or collateral eligibility.

No server key, transaction sender, execution toggle, custody credit or PAPER fallback was added. Test-only signing uses publicly derived fixture keys with historical expiry=2000 (already expired on the actual chain); no funding or live wallet authorization is performed. The original NEAR source/state is untouched.

## Exact schema v1

Domain: `name="Avensdex"`, `version="1"`, `chainId=43113`, `verifyingContract=<fixed operator-configured settlement deployment>`. It must match the journal binding. Null/zero contracts and other chains fail. No envelope can override RPC, domain, contract, chain, ID or strategy scope.

```text
Order(address trader,uint32 marketId,uint8 side,uint8 kind,uint128 size6,uint128 limitPrice18,uint32 leverage,uint16 maxFeeBps,uint64 nonce,uint64 expiry,bool reduceOnly,bool postOnly,bool ioc)
Cancel(address trader,bytes32 orderHash,uint64 nonce,uint64 expiry)
```

- JSON order envelope: `{type:"order", order:{...}, signature:"0x..."}`. Side is `buy`/`sell` (typed 0/1); kind `limit`/`market` (typed 0/1). `orderTypedData` is the canonical wallet descriptor.
- Size/price/nonce JSON values are canonical decimal strings; flags are booleans. Addresses are canonical lowercase. The order ID is the full domain-bound EIP-712 digest, never a client-supplied identifier.
- Leverage and fee cap are signed and retained in the durable original proof. They do **not** become offchain spendable credit. Absolute parsing bounds are leverage 1–10,000 and fee cap 0–10,000 bps; the [local Phase 3 contract](PHASE3_STATUS.md) independently enforces leverage ≤10, a 3-bps opening fee/cap floor and funded risk checks. Public admission must also enforce the deployed contract's supported capabilities before activation. Those parser bounds do not approve 10,000x trading or unsupported order flags.
- Existing size6 ≤ `1e15`, price18 ≤ `1e27`, nonce 1…`2^64−1`, one-day maximum remaining validity and uint32 wall-clock bounds apply. Market orders require a positive signed worst-price limit and IOC=true. Incompatible post-only flags reject. Absent/stale confirmed positions reject reduce-only.
- New offchain submissions use strictly increasing owner nonces; existing lower-nonce resting orders remain active. The Phase 3 contract binds each nonce to one hash, supports authorized out-of-order fills and advances the broad floor only on explicit owner invalidation, not on a later fill or exact-hash cancellation.
- Cancellation envelope: `{type:"cancel", cancel:{trader,orderHash,nonce,expiry}, signature:"0x..."}`. It binds the original order nonce, exact digest and owner. Replay cannot cancel a different/recreated order. **Offchain cancellation does not revoke a signature onchain or undo pending fills**; the local contract's cancellation/invalidation is tested, but actual public wallet/receipt wiring and deployment activation remain live-trading blockers.
- Only canonical 65-byte, nonzero-scalar, low-s signatures with v=27/28 are supported. EIP-1271 smart-wallet signatures and compact/DER encodings are unsupported, not silently accepted.

`contracts/evm/src/libraries/ClobAuth.sol` contains the identical static hashing/recovery schema. Golden TS/Solidity hashes and signature recovery agree. This library has no fill-consumption, deposit, withdrawal or credit function. The [implemented local settlement contract](PHASE3_STATUS.md) derives its domain from its own chain/address, independently enforces order/risk/cancellation/fill constraints and never accepts a request-supplied domain as authority. Fuji writes remain disabled.

## Durability and tests

Signature recovery happens on a private cloned envelope, preventing caller mutation during async verification. After recovery, cancellation target checks and engine commit are synchronous. Concurrent same-nonce commands cannot both commit. Proofs include the domain, authorization digest and original envelope; matcher IDs reference the complete signed terms. Replay restores the existing hash-checked journal; old admissions cannot be resubmitted after restart. Journal hash checks are integrity/replay checks, not a claim that a malicious filesystem operator is trusted for custody or that every historical unsigned fixture proof is cryptographically revalidated on startup. Settlement must independently reverify signatures.

Checks run: strict TS, **45 CLOB tests**, **19 Foundry tests** including the new 1,000-case recovery fuzz property, and full root tests. Twelve new authorization tests cover financial-field tampering, wrong owner/chain/deployment/name/version/market, strict signature encoding/malleability, expiry/flags/schema bounds, nonce restart/replay, cancellation scope, concurrency and async mutation. Two real service tests cover signed admission → fsync → WebSocket state plus refusal to activate HTTP trading or an unset domain.

Clean detached-worktree checks and [hosted CI for `e09050a`](https://github.com/wolf1276/avensdex/actions/runs/43489960005) passed. The [signed local benchmark checkpoint](CLOB_BENCHMARK.md#phase-2-signed-ingress-checkpoint) measures recovery + fsync + final-frame loopback delivery separately (100 samples, p99 6.061 ms); it excludes public HTTP admission, wallet signing, funded settlement, WAN and finality.

See [live-trading blockers](LIVE_TRADING_BLOCKERS.md), [market-data runtime](CLOB_SERVICE.md) and [Fuji authorization prerequisites](FUJI_CLOB_RUNBOOK.md).
