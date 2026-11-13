# CLOB implementation plan and source audit

## Actual starting point

The NEAR source stays untouched at its original path; the local hash-verified reference stays in ignored `legacy/nearflow/`. No NEAR key, balance, contract or journal is converted into EVM authority.

| Concern | Inspected implementation | Disposition |
| --- | --- | --- |
| Matching | `legacy/nearflow/contracts/exchange/src/trading.rs`: bounded onchain Rust matching | Preserve as behavioral reference; cannot execute on Avalanche |
| Client matcher | `legacy/nearflow/client/lib/market/matcher.ts`: native NEAR wallet calls + polling, **not** an in-memory matcher | Replace transport, not reuse it as a matching engine |
| Solidity | `contracts/evm/src/libraries` and `interfaces` only | Math is tested; **no settlement/custody implementation exists at this audit** |
| Funding | active `packages/funding`, `FundingMath.sol`, `RiskMath.sol` | Reuse formulas, signs, freshness, caps, remainder and conservation rules |
| Custody/strategy | source `lib.rs`, `strategy.rs`, `execution.rs` | Canonical-ledger/owner-payout semantics retained; ERC-20/EIP-712 implementation still required |
| Guardian/economics | source `packages/{vault,risk,adapters}` and `services/guardian` | Reuse capital/cost/reconciliation semantics. Current Guardian rejects real/mixed adapters and Policy requires PAPER; no bypass |
| Persistence | source `packages/vault/store.ts` | Reuse single-writer, digest, fsync, fail-closed recovery principles; append-only command journal needed for the CLOB |
| UI | source `TradeTerminalGrid`, book, ticket, positions/history, landing | Preserve existing terminal/layout/branding. Active Avalanche frontend not imported yet; landing permission issue remains |
| NEAR dependencies | named-account regex, near-sdk/NEP-141 callbacks, native wallet-selector/AppKit namespace, finalized NEAR RPC, Ref/wNEAR execution | Isolate from new CLOB/EVM runtime; no string-renaming shortcut |

Audit basis: actual code paths above, prior source baseline and local 162 TS / 134 Rust exchange regressions. This is an engineering boundary review, not a complete independent security audit.

## Delivery order

1. **P0a — deterministic offchain CLOB:** one market, size6/price18 bigint arithmetic, price-time matching, bounded market/limit orders, partials, cancellation, expiry, self-trade prevention, reduce-only capacity when confirmed state is available; sequenced provisional events and depth. Write command journals durably before acknowledging; validate deterministic replay and refuse corrupt/unknown state.
2. **P0b — signed admission and market data:** EIP-712 domain-bound order/cancel validation, loopback HTTP/WebSocket service, snapshots/deltas/BBO/trades/order status/blocked settlement status. Bound payloads, connections and slow-client queues. Client reducer detects sequence/stream gaps and requires an authoritative snapshot. Unknown confirmed positions are unavailable, not invented zeros.
3. **P0c — atomic settlement:** implement canonical ERC-20 vault and signed-order Solidity settlement, trader/nonces/expiry/invalidation/partial fills/price/fees/collateral/margin/position checks, then race/forgery/conservation tests. No public consume/fill shortcut without custody checks. Initially unsupported order types stay disabled. The old v1 onchain-book interface is a reference, not the new CLOB settlement implementation.
4. **P0d/P1 — existing terminal and funding:** wire EVM wallet and real settlement lifecycle into the preserved book/ticket/tables. Keep last trade, independent index and validated mark distinct. Only eligible settled observations inform premium; matcher output is not unilateral oracle/liquidation authority. Apply tested baseline/adaptive math and conserving funding indices.
5. **P1/P2 — Guardian and Autopilot:** real spot/perp adapters, policy/nonce/cost binding, conservative sizing, pending/confirmed reconciliation and bounded repair/owner exits; integrate controls into Trade, not another demo. No live hedge claim before both genuine legs pass.
6. **Assurance/release:** benchmark matching, durable acknowledgment and delivery separately; run local contract/browser/failure suites. Only then prepare a capped Fuji deployment plan and obtain separate signing approval. Never claim local results as public receipts.

The active checklist is [`todo.md`](../todo.md). Each completed logical unit gets tests, an inspected commit and push. Mainnet remains disabled; no signing/deployment is authorized by this task.

## Trust boundary

The matcher is a centralized, noncustodial operator with censorship/ordering/liveness risk, not a fully decentralized exchange. FIFO is deterministic by the recorded acceptance sequence, not proof of globally fair network arrival. Offchain book updates are not blockchain transactions. Only atomic, validated onchain settlement changes collateral/positions. An order acknowledgment or match event is provisional and must never be displayed as a confirmed fill.

Market orders require a signed worst-price bound and IOC semantics; no unbounded market price. Signed cancellation of offchain remaining quantity cannot undo already matched/pending fills or replace onchain nonce invalidation. A confirmed-chain observer and settlement worker must reconcile races/unknown outcomes before retries. No exposed matcher/admin endpoint may credit balances, mark fills confirmed or withdraw user funds.

The active product is Fuji-only with no PAPER/demo-execution toggle, synthetic balances or simulated fills. Until a real deployment is verified, order admission/settlement remain unavailable and confirmed positions are explicitly unavailable. Matching/benchmark fixtures are local automated tests only, never public product liquidity or testnet evidence. Real signatures are cryptographic admission evidence, not execution evidence or proof of deployed contract code. Never invent hashes, counterparties, liquidity, custody or performance results.
