# CLOB benchmark — measured local results

**Not a Fuji execution, live-liquidity or end-to-end trading benchmark.** The sub-100 ms goal remains a target for the eventual authenticated product path; signatures, HTTP admission, contracts, WAN and finality were not measured here.

## Reproduce

```sh
npm ci --ignore-scripts
npm run bench:clob
```

Measured at `2026-11-13T15:53:09.301Z` on clean source revision **`9304fc7b4692f654ab1ad79a1ede5b830c56d54f`** (`dirty:false`). The script emits raw JSON, revision/dirty status, source hashes, sample counts, quantiles and limitations. Re-running varies with workload, machine load and filesystem/cache state.

Environment: Node **v22.22.3**, Linux **6.8.0-147-generic**, **12th Gen Intel Core i5-12450H**, **12 logical CPUs**, **16,548,417,536 bytes RAM**. One Node process, one market. Durable work uses a newly allocated local `/tmp` directory (filesystem reported `ext2/ext3` family); no remote disk or power-loss durability test. No accounts were funded or transactions signed/submitted. Synthetic benchmark orders are measurement fixtures only, never product liquidity.

## Observations

Nearest-rank sample quantiles, milliseconds; rounded for readability:

| Workload | Samples | p50 | p95 | p99 | Max | Observed throughput |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Core paired order commands, no journal/network | 2,048 | 0.277 | 0.517 | 0.781 | 1.226 | 3,580 commands/s |
| Single command sweeping 256 makers | 10 | 1.565 | 2.574 | 2.574 | 2.574 | 137,975 provisional fills/s **inside sweep commands only** |
| Core + journal/hash + synchronous fsync acknowledgment | 128 | 2.591 | 3.737 | 4.312 | 5.816 | 368 commands/s |
| Journal/fsync → final sequenced frame received over loopback WebSocket | 100 | 2.150 | 2.724 | 2.856 | 2.946 | 450 commands/s |

These rows use **different workloads and sample counts**; they are not a controlled claim that adding WebSockets makes journaled matching faster. A prior dirty-tree smoke run of the script observed durable p99 **29.410 ms**, max **43.691 ms**, demonstrating filesystem/load variability. It was not a clean-revision comparison; the clean run above is the reproducible recorded source point, not a latency guarantee.

## Methodology and limits

- Warm-up: 64 pairs, excluded.
- Core paired: eight independent books of 128 pairs. Each pair submits a resting ask, then a matching bid; at most one resting maker. Measurements include copy-before-commit, bounded retained history, sorting, aggregation and event construction. Throughput uses measured wall time, including fixture/loop overhead; not a large-deep-book saturation result.
- Sweep: populate 256 maker orders at four ask levels; one price-bounded IOC buy requests their combined size, repeated ten times. Quantiles time only the sweep command. Fill throughput divides 2,560 provisional fills by summed sweep-command time; **excludes book population**. Total population-plus-sweep wall time was **723.441 ms** (13.823 complete sweeps/s). Ten observations do not establish statistical confidence or production tail behavior.
- Durable: one new journal, 64 pairs/128 commands. Per-command timer includes engine preparation, full-state/event fingerprint, record append and synchronous fsync before acknowledgment. Total wall time **347.570 ms**. No remote replication, checkpointing or database load.
- Delivery: one new journal, one actual loopback subscriber, 50 submit/cancel pairs. Timer starts before trusted in-process producer submission and ends when the client receives the command's final BBO sequence. It includes fsync, serialization and loopback delivery. Total wall time **222.124 ms**. This is **not authenticated HTTP order acknowledgment** and does not measure browser rendering, fanout, congestion or WAN reconnect.
- No price oracle, collateral/margin validation, cryptographic admission or onchain matching/settlement/finality was timed. Provisional matches are not confirmations. No extrapolation to public testnet TPS or low-latency decentralized matching is warranted.

## Exact measured source hashes (SHA-256)

```text
packages/clob/engine.ts           890e4906d5e4aa27f98d82a31ef2417a57f52c70c6db057aba52e6764726717d
packages/clob/journal.ts          8dec572d8d2d963cda3f08cd76c38b54a09b0f2f459ca45f7ef3cbb90a6360f6
services/clob/market-data.ts      f01cb802c4a9bb6c31bbf63ce4dbcc93186bc28c50e1ee76cb803ca91f6b3c2b
scripts/benchmark-clob.mjs        acdc6797b9bf019ded8251f675b0692e743141acc4c5199e07d0aa355878dcfe
```

Raw generated output was reviewed but not committed indiscriminately. Public throughput/latency acceptance remains open until signed admission, real collateral settlement, confirmed positions and the existing terminal are integrated and measured separately.
