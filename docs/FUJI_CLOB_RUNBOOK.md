# Fuji CLOB deployment and verification gate

**Current status:** the [supported local Phase 3 gate](PHASE3_STATUS.md) passes with canonical manual collateral buckets, signed atomic bilateral settlement, funding/close/liquidation, canonical reconciliation and owner withdrawals. Fuji deposits, oracle publication and settlement writes remain hard-disabled; public deployment/signing tools and qualified activation remain unavailable. The matcher/market-data service is implemented and tested locally; public order admission, confirmed positions and settlement remain unavailable. These are preparation/verification instructions, not a claim of deployment or approval to sign.

The [draft bounded deployment plan and read-only preflight](FUJI_DEPLOYMENT_PLAN.md) record the dedicated public deployer, proposed budget, observed candidate/proxy data and remaining approvals. The draft is not signing authorization. A funded two-provider preflight still reports deployment blocked; no credentials are needed for it.

## Checks available now

```sh
npm ci --ignore-scripts
npm test
npm run test:funding:rust
npm run bench:clob
python3 -m scripts.compare_fuji_rpcs
# Read-only; exit 2 means observations passed but deployment remains blocked.
python3 -m scripts.preflight_fuji --deployer 0xee5656873609373fF0224A1D3e5F03a8fB16B6F4
```

Hosted [Foundation checks at `6e03f26`](https://github.com/wolf1276/avensdex/actions/runs/43457508279) completed successfully. A separate clean tracked-source archive of that revision also passed npm install/tests and locked Rust reference locally. There are no source snapshot or private credentials required for those current checks.

## Before any public signing

1. Review the implemented/tested [local signed settlement boundary](PHASE3_STATUS.md), including both counterparties, fee bounds, cancellation/invalidation, expiry, cumulative fills, margin, close/liquidation and replay/race failures. Independent review, actual public deployment verification and a separately reviewed activation mechanism are still required. Keep unsupported order types and strategy authority unavailable.
2. Freeze actual EIP-712 name/version/field types and verifying deployment; verify chain **43113**. The existing onchain-book v1 interfaces are not a deployed CLOB or signature ABI.
3. Qualify actual collateral/base code, decimals, proxy/admin/transfer behavior, independent oracle cadence/freshness, executable spot route and canonicality/provider policy. Candidate token metadata alone does not qualify deposits or a hedge.
4. Obtain a separate bounded authorization identifying deployer/owner/oracle/executor, allowed contracts/actions, maximum AVAX/gas/collateral/exposure, expiry, stop conditions and recovery. Do not reuse NEAR credentials or source-chain spending permission.
5. Record source/toolchain/ABI/constructor parameters, reviewed code hashes and initially paused/disabled caps in an approved manifest. No zero/placeholders or request-supplied RPC/contract targets may enable signing. Schema 1 currently rejects all enabled execution; activation needs its own reviewed gate.

## Authorized execution sequence, once implemented

- Deploy fresh paused contracts and verify actual runtime code/roles/token/module/domain identities before accepting deposits. Never overwrite funded deployments or reset operator journals.
- Exercise tiny real deposits and fixed-owner withdrawals first. Then use actual independently funded counterparties for signed orders/partial fills, cancellation races and atomic settlement; document counterparties instead of claiming invented liquidity.
- Reconcile receipts with canonical order-fill counters, margins, positions, balances, fees and token custody. A transaction hash or successful receipt alone is not a full hedge.
- Validate independent index/mark/funding freshness and actual funding conservation; only integrate genuine spot/perp Guardian execution after policy, both legs, recovery and owner exits pass. No PAPER/fake-success fallback.
- Test restart/replacement/unknown-result reconciliation before retrying. Offchain cancellation cannot undo already pending fills; onchain invalidation is authoritative. Journal/EOA/action nonce identities must remain bound to the actual deployment.
- End with safe pause/revoke/close/recover and settled owner withdrawals, recording any remaining liabilities/inventory. Keep NEAR owner recovery/read-only history intact and reconcile source liabilities separately; no automatic destination credits.

Public lifecycle receipts, deployment addresses, verified balances, actual wallet-browser proof and signing scripts are **pending**, not supplied by this runbook. Mainnet and X-Chain are disabled/out of scope. Local tests and benchmark fixtures never count as public Fuji evidence.
