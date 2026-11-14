# Foundation verification

This page retains the original foundation checkpoint below. See [Phase 3 status](PHASE3_STATUS.md) for current implemented custody/settlement scope, test counts and limitations.

## Reproduce from tracked source

Use Node 22.22.3/npm 10.9.8, Python 3.12.3, Foundry 1.8.3 (`forge` and `anvil`) and Rust 1.96.0. Node/Rust/Foundry/compiler versions are recorded in their configuration files. Dependency lockfiles are retained.

```sh
npm ci --ignore-scripts
npm audit --audit-level=high
forge fmt --root contracts/evm --check
npm test
npm run test:funding:rust
```

The GitHub workflow `.github/workflows/checks.yml` pins action revisions and tool versions. It has contents-read-only permission, does not persist checkout credentials and has no public signing/deployment jobs or configured wallet secrets. It runs local unit/reference tests and a fresh loopback Anvil lifecycle using ephemeral generated development keys, not public liquidity probes or public transactions. The source snapshot, its dependencies and the existing frontend are not required by these tracked-code checks.

Local commands above passed. YAML syntax/structure, pinned action references and read-only/no-secret workflow configuration were checked locally. A clean tracked-source `git archive` of revision `130529e` was separately installed/tested outside the original directory: npm install/test, locked Rust reference and Solidity formatting passed without the ignored source snapshot. The later matching/expiry ABI addition was tested in the current tree. At that historical checkpoint a hosted GitHub Actions run had **not** been observed; current hosted results must be checked separately in GitHub Actions. A workflow file or local Phase 3 run does not by itself establish a hosted Phase 3 CI pass.

## Original foundation-checkpoint coverage

- Four TypeScript funding tests, twelve protocol tests (eight units/risk and four manifest-parser tests), eleven Python network-tool tests.
- Fifteen Foundry tests, including three properties at 1,000 fuzz runs each: funding bounds/symmetry, bilateral conservation, raw inventory/dust.
- Four locked Rust funding reference tests.
- TypeScript strict check covers current pure funding and protocol modules. It does not typecheck the ignored legacy frontend.
- Original source accounting/funding vectors are retained unchanged. Stateful tests include both funding signs, fractional carry/replay/reversal, capped payout, full/partial close and malformed/out-of-range configuration.
- `npm audit` found zero vulnerabilities in the current root two-package dependency tree. This does not clear the legacy frontend dependency findings.

See [math/units](ASSET_AND_RISK_UNITS.md), [module/manifest contract](MODULE_CONTRACT.md) and [the original funding checkpoint](EVM_FOUNDATION.md). Those original foundation-only results did not establish custody or deployed permission checks. The later [Phase 3 local gate](PHASE3_STATUS.md) does test custody/settlement, but no public trade, whole-source security audit or browser flow is established.

## Fresh legacy regression, separate environment

On the hash-verified ignored source snapshot, the existing source `npm test` passed **162 TypeScript tests** and `cargo test --locked --manifest-path contracts/exchange/Cargo.toml` passed **134 Rust exchange tests**. Source funding reference also passes four tests in the tracked reference crate.

The source TS run used a local ignored dependency symlink to the original project's already-installed `client/node_modules`; this is **not** a clean-install/release result. Tests ran against copied source, not the original working tree. No original source code or funded state was changed. Sandbox, browser, full frontend build/typecheck/lint and source-wide semantic/security review have not been freshly completed. Historical success counts are not substituted for those missing checks.
