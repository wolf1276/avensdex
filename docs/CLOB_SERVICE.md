# Sequenced CLOB market data

## Implemented and unavailable boundaries

`services/clob/market-data.ts` runs a real loopback HTTP/WebSocket server backed by the durable journal. `packages/clob/feed.ts` is a browser-safe reducer for the existing terminal. It is not a new terminal/demo page and is not yet wired into the archived NEAR frontend.

The current executable is read-only: **all network writes return 503**, including unsigned orders, cancellation, positions and admin mutations. `/ready` is 503. There is no server signer, public transaction sender, PAPER mode or simulated execution fallback. Signed local admission is now [implemented and tested](CLOB_ADMISSION.md); until genuine Fuji deployment validation and settlement exist, the executable still shows an empty/unavailable market honestly. `applySigned` is trusted in-process ingress only, not a public API or activation bypass. Internal producer calls in automated tests/benchmarks use fixtures, not public liquidity or testnet receipts.

The service remains centralized and single-host. It has no custody authority. Source NEAR programs and funded state are untouched.

## Start safely

Use Node 22.22.3 and `npm ci --ignore-scripts`. The journal must be an explicit absolute path **outside this repository**, in a trusted local operator-owned directory.

```sh
# Fresh, empty development/service journal ONLY. No signing or token movement.
CLOB_JOURNAL_DIR=/absolute/external/path/avensdex-clob npm run clob:serve -- --create

# Restart the same journal; never use a new directory to bypass pending/unknown state.
CLOB_JOURNAL_DIR=/absolute/external/path/avensdex-clob npm run clob:serve
```

The listener is fixed to `127.0.0.1`, default port 8787 (`CLOB_PORT` can select another local port). The journal is bound to Fuji C-Chain `43113`, one market ID and a currently unset settlement contract. This is configuration identity, not proof of a live deployment. Existing journals cannot be rebound to another chain/market/contract or silently reset.

- `GET /health`: liveness, sequence/stream identity and explicit admission/settlement/position unavailability.
- `GET /ready`: 503 until the genuine trading dependencies exist.
- `GET /snapshot`: current authoritative stream snapshot; no cache.
- `GET /funding`: `503` until a trusted `refreshFunding` producer supplies verified paired-provider data. Responses separate actual index/mark observations from the last provisional trade, preserve source timestamps, recheck configured freshness and explicitly report rate expiry. The default executable has no configured producer.
- `ws://127.0.0.1:8787/stream`: initial snapshot, then sequenced events.
- Client `{ "type": "resync" }`: refresh snapshot, at most once per second per connection. No arbitrary subscription/write commands.

No HTTP route accepts RPC addresses, order credits, positions, confirmed fills or withdrawal recipients. Network order admission will need its own cryptographic and verified-deployment gate; it is not enabled by providing a made-up contract address.

## Sequence protocol

Snapshot and event envelopes contain `streamId`, `marketId`, `seq`, `at`, `type`, `data`. The snapshot's sequence is the last committed event. Events cover order status, absolute price-level size/order-count updates, BBO, provisional trade, blocked settlement, canonical settlement outcomes, trusted-source position snapshots and explicit position invalidation. Matcher quantity changes do not imply chain-confirmed positions. Trusted `reconcileSettlement`, `refreshPositions` and `refreshFunding` producers are described in [settlement reconciliation](SETTLEMENT_RECONCILIATION.md) and [funding](FUNDING_CONTROLLER.md); none are network mutation endpoints. Startup invalidates persisted terminal fills and positions before listening, and failed refreshes never leave old evidence usable as fresh.

`MarketDataFeed` validates bounded wire values and rejects malformed/foreign state. Duplicate earlier events are ignored. A missing sequence, new-stream event, invalid payload or clock regression freezes freshness and requests one resync; further events wait for the authoritative snapshot. Reconnect marks state stale. A same-stream older snapshot cannot roll back state during resync. Position source block/time and freshness are explicit; absent confirmed input remains null. Confirmation states not implemented by the protocol are rejected, not fabricated.

The future terminal adapter must coalesce the reducer's `resync` result into one request, honor `stale`, close old sockets on reconnect/account/network changes and never authorize an order based on stale display state. No integrated browser-wallet flow is claimed here.

## Bounds and recovery

- Up to 16 WebSocket subscribers, 1 KiB inbound WS frames, no compression, at most 8 MiB queued outbound bytes per consumer. Slow/failed consumers close/resync rather than blocking durable producer acknowledgment.
- HTTP headers/timeouts/connection bounds are explicit; nonlocal browser origins are refused. Local-only scope is not a public deployment security review or production authentication/rate-limiting claim.
- Expiry timer journals removals before broadcasting. Shutdown closes connections then allows the caller to close the journal; the CLI does so on SIGINT/SIGTERM.
- Journal fsync-before-events, digest/replay checks and unknown-write/crash lock behavior are described in [the engine report](CLOB_ENGINE.md). Never auto-steal locks, truncate a damaged tail, delete pending records or report unknown writes as successful.

## Checks and measurement

```sh
npm run typecheck
npm run test:clob
npm run bench:clob
```

The expanded 118-test CLOB suite passes locally. Coverage includes actual loopback sockets, snapshot/delta equality, dropped-message resync, reconnect, expiry, unsigned mutation refusal, origin/client/frame limits, shutdown/restart without journal loss, canonical outcome/capacity downgrades, policy-confirmed paired-ledger reads and fail-closed funding data. Unit RPC responses and signatures are local fixtures, not public authorizations. The separate `npm run test:phase4:evm` check uses actual transactions only on a fresh generated-key loopback Anvil instance; [its evidence](PHASE4_STATUS.md) is not public Fuji execution.

The benchmark script reports core paired matching, 256-maker sweeps, fsync-backed local acknowledgments and loopback delivery separately, with quantiles/hardware/source hashes and explicit methodology limits. Its synthetic inputs are local measurement fixtures only. No matching, delivery, admission or chain-finality latency is inferred from unit-test duration. See [the measured local report](CLOB_BENCHMARK.md); signature/HTTP/WAN/finality/fanout performance remains unmeasured.
