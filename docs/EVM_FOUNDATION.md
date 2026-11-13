# EVM foundation — funding math checkpoint

Status: Phase 1 in progress. This implements the source's M1 pure controller-math port, not a custody contract or a public deployment.

## Toolchain and checks

- Node `22.22.3`, npm `10.9.8`, TypeScript `5.9.3` (lockfile retained).
- Foundry `1.8.3` (`cae51ad458f6abb64852b7709eb784352429825d`).
- Solidity `0.8.30`, explicit `paris` EVM target, optimizer 200 runs, no transient-storage assumptions.
- Rust reference checked on rustc `1.96.0`; its dependency lockfile is preserved. Rust remains a differential reference, not a dependency of an Avalanche application.

```sh
npm ci --ignore-scripts
npm test
npm run test:funding:rust
forge fmt --root contracts/evm --check
```

`npm test` typechecks the current pure TS funding module and runs four TypeScript funding tests, eleven read-only network-tool unit tests and five Solidity funding tests. The Solidity property test runs 1,000 seeded fuzz cases. Four Rust reference tests passed separately. `npm install --ignore-scripts` reported zero vulnerabilities for the current two-package root dependency tree; this says nothing about the unimported legacy frontend dependencies.

No frontend, wallet signing, fork integration, source-wide regression or public contract execution was tested in this checkpoint. Compiler/target behavior is locally tested; public Fuji bytecode compatibility remains a deployment qualification task.

## Preserved behavior

`packages/funding/preview.ts`, its tests and JSON fixtures are unchanged from the source snapshot. The Rust reference shares those same fixtures. The Solidity library consumes the same twelve rate vectors and both stateful trace sets, including negative mirrors, configuration extremes and rounding floors. Parameters and default caps are preserved, not recalibrated to make an opportunity pass.

- Rates/premium use ppm (`1e6`) per 3,600-second interval; positive rates mean longs pay shorts once the exchange accrual/settlement layer is ported.
- BASELINE clamps the signal directly; ADAPTIVE retains soft deadband, nonlinear response, smoothing, step cap and absolute cap.
- Both retain bounded EMA and truncation toward zero.
- Signal pricing preserves the source `1e27` maximum price, timestamp/freshness rules and independent-index/recent-mark contract.
- All accepted parameter bounds are retained. Extreme signed values reject before dangerous negation/casting.

The library is internal/pure. It has **no** caller authority, storage, oracle publishing, epoch scheduling, index accrual, payer-margin settlement or collateral movement. Those must be enforced by subsequent exchange/oracle implementations; math tests do not establish those properties.

`forge build --sizes` was run, but internal-only libraries produce no meaningful deployable product-size measurement. Full exchange size/gas qualification is pending. Foundry static lint reported guarded-cast advisories and inlined-test-loop validation warnings; compiler/tests pass. Prices are checked `<=1e27` before signed casts; age bounds are validated positive before unsigned casts. No finding is dismissed as a security audit pass.
