# Fuji qualification — M0 started

Status: **incomplete; execution disabled**. This is a network identity check, not a deployment manifest or a qualified trading integration.

## Reproduce

Python 3.12.3, standard library only; no dependency install, wallet or keys required:

```sh
python3 -m unittest discover -s scripts -t . -v
python3 scripts/qualify_fuji.py
python3 -m scripts.compare_fuji_rpcs
```

The probes permit only `eth_chainId` and `eth_getBlockByNumber` on fixed public Fuji RPC endpoints. It rejects mainnet, altered endpoints, enabled execution, malformed responses, missing blocks and latest blocks older than 120 seconds or future-dated. Transport failures exit nonzero; there is no fallback. The 120-second bound is a probe sanity check, **not** an oracle or transaction finality policy.

`config/fuji.json` has no contract addresses and cannot enable transactions. No environment RPC override is supported. This tooling does not establish application-wide security for components not yet implemented.

## Recorded observation

- Base repository revision before user-requested Git date rewriting: `f90d38aef7bb407ea2e8aa0030502a90b6b36e2e` (rewritten equivalent `02bcf9547b0fb4a2cdba635ac2ca0664888b900f`). Git dates were adjusted; evidence timestamps describe actual observations.
- Authoritative network reference: <https://build.avax.network/docs/primary-network> (retrieved 2026-11-13). Table identifies Fuji C-Chain as `43113` (`0xa869`), gas currency AVAX and RPC `https://api.avax-test.network/ext/bc/C/rpc`.
- Public read observed at `2026-11-13T14:08:15.902057+00:00`: chain `43113`, block `61007149`, hash `0x42635f17386576e76da33db02d051cd2bf27e0aeb1fbb0da29402dbf12e2b672`, timestamp `1794578893`.
- This was a live public RPC read, not a local or fork test. No transaction receipt exists: nothing was signed or submitted; no gas was spent.
- Six local unit tests passed on Python 3.12.3. Initial discovery failed because the scripts package marker was absent; adding it resolved discovery.

The initial observation above was single-provider only. Re-running produces a different latest block. No generated reports or response bodies are committed.

## Independent-provider comparison

PublicNode publishes its Fuji C-Chain endpoint at <https://avalanche-fuji-c-chain.publicnode.com> (retrieved 2026-11-13): `https://avalanche-fuji-c-chain-rpc.publicnode.com`.

The comparison checks both chain IDs and fresh heads, then reads the same height two blocks behind the lower head. Both providers must return that exact height, a fresh timestamp and matching block hash/timestamp. Outages, disagreement or invalid data fail closed; neither provider is silently substituted for the other. The two-block offset is not a finality rule.

Actual public read at `2026-11-13T14:13:20.124266+00:00` agreed on block `61007331`, hash `0x15b1fef33a9ef22a2a7bf576564f0d978d3cfdb37a22c0f514655f2122ff1bbb`, timestamp `1794579196`. Observed heads were `61007333` and `61007334`. No transactions or gas costs.

Eleven local unit tests passed. The initial PublicNode Python request returned HTTP 403; identifying the tool with `User-Agent: avensdex-qualification/1.0` resolved it. Provider throttling/history limits, WebSocket behavior and finality remain unqualified.

## Phase 1 read-only asset observation

Source basis: `130529e` plus the documented read commands; observed 2026-11-13. A new two-provider comparison at `2026-11-13T15:02:10.985530+00:00` passed at Fuji block `61009285`, hash `0xafbe8c382e38c700187ea69d46c569ef87268ef4ad66169c9e4f00209c46c442`, timestamp `1794582124`.

The official [Circle address registry](https://developers.circle.com/stablecoins/usdc-contract-addresses), retrieved during this check, lists Fuji candidate `0x5425890298aed601595a70AB815c96711a31Bc65`. At that exact block, both the Avalanche public RPC and PublicNode independently returned:

- `decimals()`: `6`.
- `symbol()`: `USDC`.
- `paused()`: `false`.
- Nonempty runtime code with Keccak-256 hash `0x7140a935aa3bb55d334d6d325fea277e47674770b10823feefa6f8b2c58af5fc`.

Reproduce each read for both fixed providers (historical-state availability may change):

```sh
RPC=https://api.avax-test.network/ext/bc/C/rpc
TOKEN=0x5425890298aed601595a70AB815c96711a31Bc65
BLOCK=61009285
cast call "$TOKEN" 'decimals()(uint8)' --rpc-url "$RPC" --block "$BLOCK"
cast call "$TOKEN" 'symbol()(string)' --rpc-url "$RPC" --block "$BLOCK"
cast call "$TOKEN" 'paused()(bool)' --rpc-url "$RPC" --block "$BLOCK"
cast code "$TOKEN" --rpc-url "$RPC" --block "$BLOCK" | cast keccak
# Repeat using https://avalanche-fuji-c-chain-rpc.publicnode.com.
```

This partially verifies candidate identity/metadata only. Proxy implementation/admin controls, freezing/blacklisting, supported transfer behavior, actual acquisition/deposit/withdrawal and fresh issuer risk remain unqualified. A proxy runtime hash does not freeze its implementation. No token is enabled by this report and testnet USDC is not a claim of redeemable dollar backing.

Both RPCs also accepted `eth_getBlockByNumber("finalized", false)` and returned the same block `61009427` (`0x3a2ee13`), hash `0xa7328eda32ddc429121f5208d2fbbc279ebd0cc89306d3d046a88a97eed53788`, timestamp `1794582302`. This observes tag support/agreement once; it does not establish a reviewed receipt canonicality/reorg/disagreement operating policy.

No base token, oracle feed or executable spot route was selected or tested here. Missing data is **not qualified**, not proof that no Fuji route exists. No signature, submission, token transfer or gas expenditure occurred.

## Remaining gates

1. Confirm initial market, collateral/base assets, capped bilateral settlement and public-validation scope with owner. AVAX exposure remains a candidate, not an approved market.
2. Extend observed two-provider agreement with finality, history availability, operational limits and a reviewed failover policy.
3. Complete asset/proxy/transfer qualification, wrapped-base identity, exact oracle feed/freshness and executable two-way spot liquidity at intended sizes. The USDC candidate metadata/code observation above is not complete asset qualification or approval.
4. Initial unit/risk/funding math, typed module/authority boundaries and execution-disabled manifest schema are implemented; see [foundation checks](FOUNDATION_CHECKS.md). Actual custody/authority implementations and an enabled deployment schema remain future gates. Python is qualification tooling only.
5. Obtain bounded authorization before public deployment or signing. The start request does not establish signer, budgets, expiry or allowed actions.

No complete M0 gate, economic eligibility, deployed custody/exchange implementation, public hedge execution or profitability is claimed. Mainnet remains out of scope.
