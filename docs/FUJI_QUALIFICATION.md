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

## Remaining gates

1. Confirm initial market, collateral/base assets, capped bilateral settlement and public-validation scope with owner. AVAX exposure remains a candidate, not an approved market.
2. Extend observed two-provider agreement with finality, history availability, operational limits and a reviewed failover policy.
3. Qualify asset code/decimals/transfer behavior, exact oracle feed/freshness and executable two-way spot liquidity at intended sizes. No addresses have been selected or verified.
4. Freeze accounting/funding rules, interfaces, deployment schema and production toolchain before dependent implementation. Python is qualification tooling only.
5. Obtain bounded authorization before public deployment or signing. The start request does not establish signer, budgets, expiry or allowed actions.

No complete M0 gate, economic eligibility, contract implementation, public hedge execution or profitability is claimed. Mainnet remains out of scope.
