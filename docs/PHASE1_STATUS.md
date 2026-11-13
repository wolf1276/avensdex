# Phase 1 — delivered checks and open gate

**Status: local foundation delivered; overall Phase 1 remains open.** This report does not waive source review, rights or public-integration qualification to satisfy a checklist.

## Completed logical units

- `9395311`: original TS/Rust funding references, shared fixtures and Solidity pure controller math.
- `97da2bc`: explicit asset units, raw inventory/dust conversion, capped bilateral payout/funding, signed rounding, partial-close allocation and liquidation-risk calculations with tests.
- `6188d38`: initial typed vault/exchange/executor/oracle/reader boundaries, authority/accounting/nonce contract and an adversarially tested execution-disabled manifest parser.
- `130529e`: pinned read-only CI workflow and Rust toolchain, with current root checks reproducible without the ignored source snapshot. Subsequent source review added explicit matching/expiry/cancel-all ABI boundaries and selector checks.

No vault/exchange/executor implementations, deployed authorization or full exchange gas/size evidence are implied by interfaces and math libraries.

## Checks actually run

- `npm ci --ignore-scripts`, strict TS check and root audit: pass; zero findings in the current two-package root dependency tree, not the legacy frontend tree.
- Four TS funding tests; twelve protocol tests (eight math and four manifest tests): pass.
- Eleven Python read-only network-tool tests: pass.
- Fifteen Foundry tests: pass, including three properties at 1,000 fuzz runs each. The TS seeded accounting test covers 10,000 settlement/payout transitions separately.
- Four locked Rust funding reference tests: pass on pinned Rust 1.96.0.
- `forge fmt --root contracts/evm --check`, staged diff checks and markdown relative-link checks: pass.
- Clean `git archive` of tracked revision `130529e`: fresh npm install, complete root test command, Rust reference and Solidity formatting passed outside the original working directory. The later ABI-selector addition was tested again in the current tree.
- Original snapshot regression: 162 TS and 134 Rust exchange tests pass. These use the copied source and existing installed frontend dependencies, not a fresh legacy dependency installation or EVM runtime. [Scope/details](FOUNDATION_CHECKS.md).
- Read-only public Fuji two-provider agreement, candidate USDC registry/code/decimals/symbol/pause observations and finalized-tag support: recorded separately in [qualification evidence](FUJI_QUALIFICATION.md). No signatures, transfers, contract deployments or gas expenditure.

The CI workflow's syntax/pinning/security configuration and command equivalents were checked locally. Hosted GitHub Actions was not run/observed. Full frontend build/typecheck/lint/browser/Sandbox and complete source security/semantic review were not freshly completed. No independent audit is claimed.

## Why the overall gate stays open

| Open item | What is still required | Dependent work |
| --- | --- | --- |
| Source review | Finish remaining module-by-module semantic/dependency review; preserve identified gaps in authority, genuine execution and UI | Complete Phase 1 acceptance and parity assurance |
| Landing rights | Source attribution explicitly says no landing code/artwork license was supplied; verify redistribution permission before publication | Publishing that existing UI, not local math tests |
| Public asset qualification | Verify wrapped base identity, proxy/admin/issuer risk, transfers and actual available collateral; USDC metadata observations alone are insufficient | Asset binding/deposits on Fuji |
| Oracle | Select exact independent source/feed and validate units, update cadence and source freshness; no silent TTL extension | Real settlement and strategy activation |
| Spot route | Select actual venue/version/assets/pool and quote both directions at intended sizes with fees/gas/repair allowance | Genuine public hedge qualification |
| Finality/operations | Review canonicality/reorg/disagreement handling, history and provider limits; one finalized-tag agreement is not an operating policy | Public transport/reconciliation |

Missing data is not evidence that an integration does not exist. Mocks remain local and cannot satisfy these public gates. Lack of current profitable carry is separate from implementation correctness; no economic admission is claimed.

## Next executable unit

Complete the remaining source review and required local contract decisions, then implement capped exact-delta collateral custody and fixed-owner withdrawals against `IAvensVault`, with malicious-token/reentrancy, donation, cap, authority and conservation tests. Keep public deposits/trading/automation disabled until their separate qualification and bounded authorization gates pass.

Mainnet and X-Chain remain out of scope. The initial destination is Fuji **C-Chain**, chain ID `43113`; local tests use `31337`. Existing NEAR funds/state/permissions/journals are not copied into spendable Avalanche balances.
