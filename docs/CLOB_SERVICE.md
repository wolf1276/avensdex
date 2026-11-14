# Sequenced CLOB market data

## Implemented and unavailable boundaries

`services/clob/market-data.ts` runs a real loopback HTTP/WebSocket server backed by the durable journal. `packages/clob/feed.ts` is a browser-safe reducer for the existing terminal. It is not a new terminal/demo page and is not yet wired into the archived NEAR frontend.

The executable defaults to read-only. An explicit `CLOB_CONFIG_FILE` enables **canonically gated signed ingress**, not activation: runtime hashes, deployment/module links, Fuji chain, cap, current entry readiness, nonce/cancellation state and full owner-funded on-chain order escrow must verify at one paired, policy-confirmed block. Unsigned/unescrowed/stale/foreign orders cannot enter the book. `/ready` remains 503 because public settlement submission is not wired. There is no server signer, public transaction sender, PAPER mode or simulated execution fallback. Internal producer calls in automated tests/benchmarks use fixtures, not public liquidity or testnet receipts.

The service remains centralized and single-host. It has no custody authority. Source NEAR programs and funded state are untouched.

## Start safely

Use Node 22.22.3 and `npm ci --ignore-scripts`. The journal must be an explicit absolute path **outside this repository**, in a trusted local operator-owned directory.

```sh
# Fresh, empty development/service journal ONLY. No signing or token movement.
CLOB_JOURNAL_DIR=/absolute/external/path/avensdex-clob npm run clob:serve -- --create

# Restart the same journal; never use a new directory to bypass pending/unknown state.
CLOB_JOURNAL_DIR=/absolute/external/path/avensdex-clob npm run clob:serve
```

The listener is fixed to `127.0.0.1`, default port 8787 (`CLOB_PORT` can select another local port). Without admission configuration, the journal has an unset settlement contract. With an absolute `CLOB_CONFIG_FILE`, it is bound to that exact Fuji settlement. The JSON must contain exactly `chainId:43113`, `marketId:1`, `deploymentId`, `vault`, `settlement`, `oracle`, `vaultCodeHash`, `settlementCodeHash`, `oracleCodeHash` and `confirmations` (3–100). Addresses/hashes are lowercase, nonzero reviewed pins. RPC URLs are fixed in the executable. This is configuration identity, not proof of a live deployment; every admission rechecks actual paired state. Existing journals cannot be rebound or silently reset.

`CLOB_ALLOWED_ORIGIN=https://avensdex.vercel.app` explicitly permits that exact browser origin for CORS and WebSocket access; wildcard, HTTP and lookalike origins are not accepted as configured origins. TLS must terminate at the host reverse proxy. No wallet secret belongs in either configuration file.

- `GET /health`: liveness, sequence/stream identity and explicit admission/settlement/position unavailability.
- `GET /ready`: 503 until the genuine trading dependencies exist.
- `GET /snapshot`: current authoritative stream snapshot; no cache.
- `GET /funding`: `503` until a trusted `refreshFunding` producer supplies verified paired-provider data. Responses separate actual index/mark observations from the last provisional trade, preserve source timestamps, recheck configured freshness and explicitly report rate expiry. The default executable has no configured producer.
- `ws://127.0.0.1:8787/stream`: initial snapshot, then sequenced events.
- Client `{ "type": "resync" }`: refresh snapshot, at most once per second per connection. No arbitrary subscription/write commands.

- `GET /admission/ready`: canonical admission probe; returns 200 only after actual gates pass, with **global `ready:false` and settlement unavailable**. This does not claim executable settlement.
- `POST /orders`: JSON `{type:'order',order,signature}` using the exact EIP-712 schema; only vanilla limit orders with leverage ≤10 and contract-supported fees/flags. Full initial-margin-plus-fee escrow for this exact signed hash must already exist on-chain. Returns 202 `accepted_provisional`, never a confirmed fill.
- `POST /cancel`: signed cancellation envelope; removes the local quote only. The response explicitly requires separate on-chain cancellation; local removal does not revoke an independently relayable signature.
- `GET /orderbook`, `/orders`, `/trades`: journal-backed snapshot, orders and explicitly provisional trades, respectively.

No HTTP route accepts RPC addresses, order credits, positions, confirmed fills, native payments, private keys or withdrawal recipients. Admission bodies are capped at 8192 bytes, one verification is in flight, and at most eight gated requests are admitted per ten seconds. Exact-origin checks, bounded connections and reverse-proxy controls supplement signature/escrow authorization; they are not a full public abuse/security audit. Failed or duplicate writes do not mutate state and require state reconciliation before a client retries.

## Sequence protocol

Snapshot and event envelopes contain `streamId`, `marketId`, `seq`, `at`, `type`, `data`. The snapshot's sequence is the last committed event. Events cover order status, absolute price-level size/order-count updates, BBO, provisional trade, blocked settlement, canonical settlement outcomes, trusted-source position snapshots and explicit position invalidation. Matcher quantity changes do not imply chain-confirmed positions. Trusted `reconcileSettlement`, `refreshPositions` and `refreshFunding` producers are described in [settlement reconciliation](SETTLEMENT_RECONCILIATION.md) and [funding](FUNDING_CONTROLLER.md); none are network mutation endpoints. Startup invalidates persisted terminal fills and positions before listening, and failed refreshes never leave old evidence usable as fresh.

`MarketDataFeed` validates bounded wire values and rejects malformed/foreign state. Duplicate earlier events are ignored. A missing sequence, new-stream event, invalid payload or clock regression freezes freshness and requests one resync; further events wait for the authoritative snapshot. Reconnect marks state stale. A same-stream older snapshot cannot roll back state during resync. Position source block/time and freshness are explicit; absent confirmed input remains null. Confirmation states not implemented by the protocol are rejected, not fabricated.

The future terminal adapter must coalesce the reducer's `resync` result into one request, honor `stale`, close old sockets on reconnect/account/network changes and never authorize an order based on stale display state. No integrated browser-wallet flow is claimed here.

## Bounds and recovery

- Up to 16 WebSocket subscribers, 1 KiB inbound WS frames, no compression, at most 8 MiB queued outbound bytes per consumer. Slow/failed consumers close/resync rather than blocking durable producer acknowledgment.
- HTTP headers/timeouts/connection bounds are explicit; nonlocal browser origins are refused. Local-only scope is not a public deployment security review or production authentication/rate-limiting claim.
- Expiry timer journals removals before broadcasting. Shutdown closes connections then allows the caller to close the journal; the CLI does so on SIGINT/SIGTERM.
- Journal fsync-before-events, digest/replay checks and unknown-write/crash lock behavior are described in [the engine report](CLOB_ENGINE.md). Never auto-steal locks, truncate a damaged tail, delete pending records or report unknown writes as successful.

## Current public deployment versus local execution evidence

`config/fuji-clob.json` records the actual paused release deployed from contract source `8877179f02d6821576bc1af83adc5e7578787e9f`. Deployment/binding receipts are [vault](https://testnet.snowtrace.io/tx/0xc9c1f05fa669aeceed5a7c394523db3cc0a3a3574c9aacd57cdc5bd79722f1a5), [oracle](https://testnet.snowtrace.io/tx/0x1b27e73c8bc322887cfc2e6d38298db209e9bc1de242ac87f7ca6730fa901126), [settlement](https://testnet.snowtrace.io/tx/0xc53d8fe40d2a5a734699796a28316091c2b719ea72b20792bd97333473d79afa) and [binding](https://testnet.snowtrace.io/tx/0x5d957c3208205ffb8a1f28a5b17a15ff9478f11fc026f89c4bad2d9a1a3d06f0). These are deployment transactions, not orders or fills.

At 2026-11-14 18:34:42 UTC, the new gate was checked read-only against the two fixed public Fuji providers: all runtime/module pins passed and admission correctly refused the paused contracts (`FUJI_ENTRIES_UNAVAILABLE`). No transaction was submitted by that check; it does not establish fresh economic qualification or authorize activation.

The expanded local Phase 4 regression now reserves both signed orders on-chain, confirms escrow, rejects an unreserved HTTP order, admits both orders through actual HTTP, and reconciles the local fill/funding/close/withdraw/restart lifecycle: **28 loopback Anvil receipts**, not public Fuji trades.

## Checks and measurement

```sh
npm run typecheck
npm run test:clob
npm run bench:clob
```

The expanded 122-test CLOB suite passes locally, including actual HTTP signed ingress with unit-RPC escrow fixtures and rejection of missing escrow, cancellation/replay, bad runtime/identity, stale/reorged/disagreeing sources, oversized/malformed input and origin spoofing. Coverage includes actual loopback sockets, snapshot/delta equality, dropped-message resync, reconnect, expiry, unsigned mutation refusal, origin/client/frame limits, shutdown/restart without journal loss, canonical outcome/capacity downgrades, policy-confirmed paired-ledger reads and fail-closed funding data. Unit RPC responses and signatures are local fixtures, not public authorizations. The separate `npm run test:phase4:evm` check uses actual transactions only on a fresh generated-key loopback Anvil instance; [its evidence](PHASE4_STATUS.md) is not public Fuji execution.

The benchmark script reports core paired matching, 256-maker sweeps, fsync-backed local acknowledgments and loopback delivery separately, with quantiles/hardware/source hashes and explicit methodology limits. Its synthetic inputs are local measurement fixtures only. No matching, delivery, admission or chain-finality latency is inferred from unit-test duration. See [the measured local report](CLOB_BENCHMARK.md); signature/HTTP/WAN/finality/fanout performance remains unmeasured.
