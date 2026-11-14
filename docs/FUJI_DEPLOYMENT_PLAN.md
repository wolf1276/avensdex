# Fuji deployment preparation — draft, not signing authorization

**Status: blocked; no transaction is authorized by this document.** The user requested deployment preparation using the dedicated funded Fuji deployer. The proposed budget below has not been explicitly confirmed. Wallet creation/funding, a public address or a passing local test does not approve activation or arbitrary spending.

## Proposed bounded scope for owner review

| Item | Proposed limit / unresolved decision |
| --- | --- |
| Network | Avalanche Fuji C-Chain only, chain ID **43113**. Mainnet and P/X chains excluded. |
| Deployer | `0xee5656873609373fF0224A1D3e5F03a8fB16B6F4`; dedicated public identity, not an ephemeral test fixture. No private material belongs in the repository or logs. |
| Gas | At most **0.05 test AVAX total** (50,000,000,000,000,000 wei), including failed/replaced transactions. This is a proposed ceiling, not an estimate or approval. Stop if worst-case gas liability cannot fit the remaining ceiling and balance. |
| Other native/token value | **Zero** native transfer value outside gas. No ERC-20 approvals/deposits, swaps, fills, funding actions, hedges or payouts in the initial deployment authorization. |
| Allowed actions | Only explicitly listed fresh paused-contract creations, immutable module binding and read-only source/runtime/role/domain verification after the release is qualified. Exact constructors, roles, nonce sequence, expected identities/code and transaction list must be frozen before signing. No arbitrary calls or upgrades. |
| Expiry | Proposed: **24 hours after explicit owner approval**, recorded as an exact UTC expiry before signing. No approval/expiry has been recorded yet. |
| Recovery / stop | Stop on wrong chain/provider disagreement, stale or missing evidence, code/role mismatch, unknown transaction outcome, nonce conflict, expiry or exhausted budget. Reconcile canonical receipts, transaction sender/nonce, actual code and balances before any retry. Never reset funded state or discard journals. |

Initial market, collateral, qualified independent oracle, owner/publisher/controller identities, cap and final deployment source revision are **not approved** yet. AVAX/USDC market 1 and the Circle-listed Fuji USDC candidate remain candidates, not enabled assets. No blank/default address may stand in for a role or verification result.

## Functional contract preparation, not public deployment

The original Phase 3 local build hard-rejected Fuji operations. The subsequent [capped activation implementation](FUJI_ACTIVATION.md) adds paused bootstrap, owner qualification attestation, immutable runtime/reference checks, entry pause without trapping owner exits, and independent two-feed prices with expired-terminal funding exits. A historical pinned-fork run checked 27 actual local receipts against copied USDC/feed state; this is not public execution or current asset/feed approval. The local publisher adapter remains local-only.

Exact-delta custody, canonical conservation, fixed-owner payouts, signatures/risk/replay checks and fresh exit prices remain enforced. Unsupported market/reduce-only/post-only/IOC/strategy execution stays disabled. No JSON flag or evidence hash itself establishes qualification. Exact reviewed release, current external code/governance checks, finite signing plan and explicit approval remain required before gas is spent.

## Required evidence before any signature

1. **Authorization:** explicit finite approval with exact UTC expiry, reviewed actions/constructor identities and operational stop/recovery ownership. Filling this draft is not approval.
2. **Collateral:** independent issuer/network identity, current proxy implementation/admin/owner/freeze controls, reviewed implementation code/provenance, transfer behavior and bounded local/fork conservation tests, then separately authorized genuine public acquisition/deposit/withdraw proof after the initial paused deployment. Historical fork qualification is not permission for public collateral actions. Metadata or an unchanged proxy-shell hash is insufficient.
3. **Oracle/funding:** exact independently sourced Fuji feed/controller identity, code/proxy trust, units, round/timestamp/freshness/expiry behavior and safe stale-gap semantics. [Read-only Fuji AVAX/USD candidate research](FUJI_ORACLE_CANDIDATES.md) identifies an official directory entry and paired historical reads; it is not integration or qualification. The local trusted-publisher adapter is not a qualified public feed or adaptive controller. Do not invent a feed address or publish synthetic prices to make deployment appear ready.
4. **Release/manifest:** reviewed source and bytecode, pinned tools, exact constructor arguments/roles/caps, expected deployed runtime including immutable configuration, deployment ID and EIP-712 domain. The current schema-1 manifest remains execution-disabled; no parser flag can authorize activation.
5. **RPC/transaction lifecycle:** independently operated providers agree at a pinned recent canonical block; signed submission intent is durable before dispatch, all known replacement candidates remain tracked, sender/nonce/to and actual receipts/code are reconciled. A previously funded balance or nonce observation is not a fresh submission preflight.
6. **Scope separation:** manual deployment verification is not public liquidity, adaptive-funding activation, browser readiness, Guardian/Autopilot, a hedge or profitability. Existing-terminal/status integration and strategy authority remain later work. Unresolved landing/artwork redistribution rights still block publishing those assets.

The contract/wallet public identity is not secret. Keystore/passwords, signed raw transactions and private recovery journals must remain protected outside Git; no deployment preflight needs to read them.

## Read-only preparation observation

At `2026-11-13T20:51:02.563Z`, the official Fuji RPC returned block **61023041**, hash **`0xacbe97a0d116e14cde5bda39a300bd9d86fc696e5d1749c9bcde5940b6288c14`**, for candidate `0x5425890298aed601595a70AB815c96711a31Bc65`. The same block hash was rechecked after the reads.

- Proxy-shell runtime: **1,852 bytes**, keccak256 **`0x7140a935aa3bb55d334d6d325fea277e47674770b10823feefa6f8b2c58af5fc`**.
- Getters: `USD Coin`, `USDC`, decimals **6**, `paused=false`.
- Owner/pauser: `0xd3e1C813C50dD377c903Ec0F9410FF2cf960A21D`; master minter: `0x5b2173b7D3D4592816D9AD520f309b3F443CCBE1`; blacklister: `0x9E73387476398A7e777Ac07C6baf9A1950405754`.
- EIP-1967 implementation/admin slots were both zero. The legacy `keccak256("org.zeppelinos.proxy.implementation")` slot held implementation **`0x6f3c4787bab4eeebf62efb8c35dc9259fdc9d9f4`**; the corresponding legacy admin slot held **`0x97b69a3cffab3d2fd5aed7fe48effab94832d2ee`**. A zero EIP-1967 slot therefore does not prove this token is immutable.

This is **single-provider candidate observation**, not complete asset qualification, source-code verification, role-owner approval, executable liquidity or transfer evidence. The configured independent provider also answered Fuji identity/head reads during preparation, but those different-height observations alone do not prove same-block canonical agreement or persistent availability. Its earlier HTTP 403 must not be silently treated as successful readiness or bypassed by automatic fallback.

## Read-only deployer preflight

```sh
python3 -m scripts.preflight_fuji --deployer 0xee5656873609373fF0224A1D3e5F03a8fB16B6F4
```

This tool reads only the fixed Fuji providers and public address. It has no signer/key/password input, deployment path or ready-true override. It reuses the existing chain/same-block comparison, checks both providers' balance/nonce at that exact block, rechecks block identity after account reads and rejects evidence that expires during those reads. It rejects malformed/unbounded values and EOA nonces beyond uint64. A funded observation still returns `deploymentReady:false`, `executionEnabled:false`, `transactionsSubmitted:0` and **exit 2**. A provider/config/input failure is redacted and returns **exit 1**; no fallback or automatic retry occurs. Pinned canonical nonce observations do not reconcile pending transactions or authorize a next nonce.

A real read-only run at **`2026-11-14T06:58:22.611954+00:00`** found agreement between the configured official and PublicNode providers at block **61048149**, hash **`0x0a69f93d051cfaee1c264555012058c269572cba76a5090817d908c829ee8ed5`**, source timestamp **1794639488**. Both returned deployer balance **499999999996640000 wei** and canonical nonce **0** at that pinned block. The run correctly returned exit 2 / deployment blocked, not deployment approval or finality proof.

OpenCode drafted the preflight and its initial 14 tests. Pi review reproduced four red cases and fixed final-read freshness, uint64 nonce bounds, zero block-hash rejection and CLI argument-error redaction; it also bounded quantities before integer conversion, blocked redirects before any follow-up request and removed an unused RPC method. All **18 preflight tests** pass; the existing 12 network-tool tests remain separate coverage. Unit tests use mocks, not public transaction evidence.

No wallet secret was read, no transaction was signed/submitted and no deployment gas was spent during these checks. See [the public deployment runbook](FUJI_CLOB_RUNBOOK.md) and [remaining live-trading blockers](LIVE_TRADING_BLOCKERS.md).
