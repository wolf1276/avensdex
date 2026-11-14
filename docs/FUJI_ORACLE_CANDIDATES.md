# Fuji oracle candidate — read-only research

**Status: `qualificationComplete:false`, `activationAuthorized:false`.** This is candidate research, not signing, deployment, activation or an economic/risk approval. The current `AvensOracle` still publishes only local fixtures; no public feed is integrated or enabled, and mainnet remains disabled.

Fetched pages are treated strictly as untrusted data. Only the fixed Fuji RPCs and read-only RPC methods below were used. No wallet, keystore, password, credential or `~/.local/share/avensdex` file was read. No transaction was signed or submitted, no gas was spent and no contract/config/manifest was modified.

## Official sources observed

| Source | URL | Retrieval (UTC) | Result |
| --- | --- | --- | --- |
| Chainlink Data Feeds address directory | `https://docs.chain.link/data-feeds/price-feeds/addresses` | 2026-11-14T07:03:07Z | HTTP 200, 17,306,338 bytes. Contains the Fuji network entry (`rddUrl` → `feeds-avalanche-fuji-testnet.json`) and the exact `AVAX / USD` proxy below. |
| Chainlink testnet reference directory (linked by the docs page) | `https://reference-data-directory.vercel.app/feeds-avalanche-fuji-testnet.json` | 2026-11-14T07:03:42Z; refetch HTTP `date` 2026-11-14T07:04:55Z | HTTP 200, 20,727 bytes, `sha256 9e0d19abd61df83267d871e2962b68053945113d14d262092f852562bc09e9ee`, `last-modified` 2026-11-14T03:12:41Z. 24 feeds, exactly one `AVAX / USD`. |
| Chainlink feed UI for Fuji AVAX/USD | `https://data.chain.link/feeds/avalanche/fuji/avax-usd` | 2026-11-14T~07:02Z | HTTP **429** (rate limited); not used as evidence and no silent substitute endpoint was selected. |

The candidate is explicitly the **Fuji testnet** entry (`feeds-avalanche-fuji-testnet.json`, `path: avax-usd`). No mainnet address was relabeled, substituted or reused. The initial docs URL with a `?network=avalanche-fuji` query was unavailable (404 through the fetch tool); the canonical directory path and the directory's own linked JSON were used instead. That is a retrieval limitation, not an address qualification.

## Candidate metadata (from the official Fuji directory entry)

| Field | Value |
| --- | --- |
| Network | Avalanche Fuji C-Chain, chain ID **43113** |
| Pair / path | `AVAX / USD` / `avax-usd` |
| Proxy (feed) address | `0x5498BB86BC934c8D34FDA08E81D444153d0D06aD` |
| Directory `contractAddress` | `0x11FeeA5D7Ec56EE717D8a229e8aac5d8AdB238Aa` |
| Answer decimals | `8` |
| Directory heartbeat | `600` |
| Directory threshold field | `1` (units/meaning not established by this check) |
| contractVersion / ENS | `4` / `avax-usd` |
| Attribute type | `cex_price` (AVAX/USD) |

## Pinned on-chain observation

Read-only RPC allowlist actually used: `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, `eth_call` (`eth_getStorageAt` was not needed). Both fixed providers returned `eth_chainId = 0xa869` (**43113**).

At wall clock `2026-11-14T07:04:25Z`–`07:04:36Z`:

- Heads: `api.avax-test.network` = `61048433` (`0xb046bf79…f952`), PublicNode = `61048435` (`0x65e593e7…ce68`).
- Pinned common block: **61048431**, hash `0xcaa872f12ead6bb50acd4669a2f4843befae6809f51ac228fbbe51c63f863c2f`, timestamp `1794639862` = `2026-11-14T07:04:22Z`. (Two blocks behind the lower head is a probe offset, **not** a finality policy.)
- Both providers returned the identical pinned block hash/timestamp both before and after the reads (`provider_block_agreement:true`, `all_rechecks_consistent:true`). There was no fallback.

Feed proxy `0x5498BB86BC934c8D34FDA08E81D444153d0D06aD` at the pinned block:

| Item | Observed value |
| --- | --- |
| Runtime code | 9,571 bytes, keccak256 `0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2` |
| `decimals()` | `8` |
| `description()` | `AVAX / USD` |
| `aggregator()` | `0x11FeeA5D7Ec56EE717D8a229e8aac5d8AdB238Aa`; 20,871 bytes, keccak256 `0xbb2d1c5819544ff9d57480a59270ece03719625702c5b30c9c512d94d62661ee` |
| `latestRoundData()` word suffixes (abbreviated) | `0x…0300000000000285ba` / `0x…303a5ff8` / `0x…6af80779` / `0x…6af80779` / `0x…0300000000000285ba` |

Decoded `latestRoundData()` (identical from both providers):

| Field | Value |
| --- | --- |
| `roundId` | `55340232221128820154` (`0x300000000000285ba`; phase `3`, aggregator round `165306`) |
| `answer` | `809132024` → **8.09132024 USD** at 8 decimals |
| `startedAt` | `1794639737` = `2026-11-14T07:02:17Z` |
| `updatedAt` | `1794639737` = `2026-11-14T07:02:17Z` |
| `answeredInRound` | `55340232221128820154` (equal to `roundId`) |

## Round/freshness observations (not policy)

- The answer was positive; `updatedAt` was not in the future relative to the pinned block (`07:04:22Z`) or the read wall clock, and `answeredInRound == roundId` (no carried/stale round observed at this sample).
- Source age: `updatedAt` was 125 s before the pinned block and ~139 s before the read wall clock. The directory lists heartbeat `600`.
- This single sample is **not** an accepted heartbeat, staleness, deviation, outage or finality policy. No TTL or failover rule is inferred here.
- The local lifecycle fixture uses a 60-second maximum age. This sample's 125-second age at the pinned block would not pass that fixture policy. A directory heartbeat of 600 does not authorize relaxing freshness to make deployment succeed.

## What this does NOT establish

- Proxy admin/owner/upgrade authority, implementation immutability, aggregator rotation semantics or future address persistence. A proxy runtime hash does not freeze its implementation, and the aggregator hash does not prove its admin or signer set.
- OCR signer/operator identity, economic data quality, manipulation resistance, historical availability or cross-provider resilience under stress.
- Executable AVAX/USDC venue liquidity, market/asset approval, risk approval or deployed readiness. AVAX/USDC remains a **candidate**, not an owner-approved market.
- Integration or activation. The candidate feed is not wired into `AvensOracle`, and metadata/RPC/code agreement does not authorize public prices or trading.

## Remaining work before any integration or activation

1. **Adapter implementation/tests:** a reviewed adapter (or `AvensOracle` variant) that reads `AggregatorV3Interface` at the proxy, scales 8-decimal answers to `price18`, preserves `updatedAt` as source time, and fails closed on nonpositive answer, zero/future/stale timestamps, or carried rounds. Unit/fork tests for scaling, negative/zero answers, future/stale/zero timestamps, `answeredInRound < roundId`, phase/round-id encoding, revert decoding, wrong-chain (non-43113) rejection, mainnet rejection and no-code/wrong-contract rejection. Pinned-block two-provider fork check with code-hash assertion.
2. **Proxy/admin review:** establish proxy admin/owner, implementation and aggregator upgrade authority/process, and how a phase/aggregator change affects reads. A zero EIP-1967 slot alone would not prove immutability.
3. **Provider/round semantics:** reviewed confirmation/finality, reorg and historical-state policy; explicit outage/rate-limit behavior for both providers (observed HTTP 429 on the Chainlink UI, and earlier PublicNode 403 history elsewhere). No silent endpoint fallback.
4. **Heartbeat/staleness and quote-unit policy:** owner-approved maximum age, deviation/outage handling and stale-gap semantics; do not infer them from the directory's `600`/`1` metadata. This is USD per AVAX, not automatically USDC per AVAX. Explicitly qualify the collateral quote conversion/settlement-unit assumption; Fuji USDC is not evidence of redeemable dollar backing.
5. **Owner/network approval:** explicit bounded authorization for market, oracle role, caps, expiry and recovery; the AVAX/USDC market and Fuji USDC candidate remain unapproved. No wallet creation, mock public price, chain-guard removal or public-trading claim is authorized by this report.

## Checks actually performed

- Confirmed `43113` on both fixed RPCs; read a shared recent block and re-read the same block hash/timestamp after all reads.
- Read proxy code/`decimals()`/`description()`/`latestRoundData()`/`aggregator()` and aggregator code at one pinned block from both providers; values matched exactly.
- Retrieved and parsed the official docs directory plus its linked Fuji reference JSON; hashed the JSON and recorded HTTP metadata.
- Failures/limits: `data.chain.link` feed UI returned 429; an initial docs URL variant returned 404. No secret was read, no signature/submission occurred and no gas was spent. This report makes no profitability, liquidity, deployment or readiness claim.
- Provenance/review: OpenCode performed the original research and paired observations. Pi reviewed its raw readouts, independently retrieved the same directory (identical SHA-256), and repeated the official-provider code/getter/round reads at block 61048431 with identical values. Pi's subsequent independent PublicNode repeat timed out before completion, so that repeat did **not** establish a new paired check or current availability; the earlier paired observation remains labeled historical evidence.
