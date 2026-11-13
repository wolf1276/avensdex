# Fuji qualification — M0 started

Status: **incomplete; execution disabled**. This is a network identity check, not a deployment manifest or a qualified trading integration.

## Reproduce

Python 3.12.3, standard library only; no dependency install, wallet or keys required:

```sh
python3 -m unittest discover -s scripts -t . -v
python3 scripts/qualify_fuji.py
```

The probe permits only `eth_chainId` and `eth_getBlockByNumber` on the fixed public Fuji RPC. It rejects mainnet, altered endpoints, enabled execution, malformed responses, missing blocks and latest blocks older than 120 seconds or future-dated. Transport failures exit nonzero; there is no fallback. The 120-second bound is a probe sanity check, **not** an oracle or transaction finality policy.

`config/fuji.json` has no contract addresses and cannot enable transactions. No environment RPC override is supported. This tooling does not establish application-wide security for components not yet implemented.

## Recorded observation

- Base repository revision: `f90d38aef7bb407ea2e8aa0030502a90b6b36e2e`; probe/config/tests introduced with this report's commit.
- Authoritative network reference: <https://build.avax.network/docs/primary-network> (retrieved 2026-11-13). Table identifies Fuji C-Chain as `43113` (`0xa869`), gas currency AVAX and RPC `https://api.avax-test.network/ext/bc/C/rpc`.
- Public read observed at `2026-11-13T14:08:15.902057+00:00`: chain `43113`, block `61007149`, hash `0x42635f17386576e76da33db02d051cd2bf27e0aeb1fbb0da29402dbf12e2b672`, timestamp `1794578893`.
- This was a live public RPC read, not a local or fork test. No transaction receipt exists: nothing was signed or submitted; no gas was spent.
- Six local unit tests passed on Python 3.12.3. Initial discovery failed because the scripts package marker was absent; adding it resolved discovery.

This is one provider's observation, not independently reconciled or finalized evidence. Re-running produces a different latest block. No generated reports or response bodies are committed.

## Remaining gates

1. Confirm initial market, collateral/base assets, capped bilateral settlement and public-validation scope with owner. AVAX exposure remains a candidate, not an approved market.
2. Independently verify a fallback RPC, same-block agreement, finality, history availability and operational limits.
3. Qualify asset code/decimals/transfer behavior, exact oracle feed/freshness and executable two-way spot liquidity at intended sizes. No addresses have been selected or verified.
4. Freeze accounting/funding rules, interfaces, deployment schema and production toolchain before dependent implementation. Python is qualification tooling only.
5. Obtain bounded authorization before public deployment or signing. The start request does not establish signer, budgets, expiry or allowed actions.

No complete M0 gate, economic eligibility, contract implementation, public hedge execution or profitability is claimed. Mainnet remains out of scope.
