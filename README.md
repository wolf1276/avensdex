# Avensdex

**Adaptive perpetual trading on Avalanche.**

Avensdex is the Avalanche port of the existing NEARFlow perpetual trading platform: matched exchange, adaptive funding, owner-controlled hedge strategies and the existing landing/trading UI.

## Product

- Perpetual trading terminal with transparent positions, margin and funding
- Isolated collateral accounting and bounded settlement
- Revocable strategy permissions and cost-aware spot/perp execution
- Observable execution, recovery and owner withdrawals

## Network

Initial development targets Avalanche C-Chain Fuji. Mainnet execution is outside the initial scope.

## Status

The complete NEARFlow working-source baseline has been copied locally and hash-verified. Its existing architecture, UI and migration plan are the implementation basis; follow [`todo.md`](todo.md) for the six phases and current tasks. See [baseline provenance and publication limits](docs/NEARFLOW_BASELINE.md).

A [deterministic offchain CLOB and crash-safe command journal](docs/CLOB_ENGINE.md), read-only Fuji network checks, Solidity funding/units/risk math, typed module interfaces, an execution-disabled manifest parser and pinned CI are implemented. Local reference/property/parser checks pass; see [Phase 1 results and open gates](docs/PHASE1_STATUS.md). The full EVM port is not complete: signed public admission, WebSocket/terminal wiring, collateral/settlement contracts and live Guardian/Autopilot execution are pending. All matches are provisional/blocked, never confirmed positions. No deployed Avalanche application or public contract execution is claimed. No live trading, yield or production-readiness claims are made.

## Run local foundation checks

Requires the pinned Node/npm, Foundry/Solidity and Rust toolchains listed in [foundation verification](docs/FOUNDATION_CHECKS.md).

```sh
npm ci --ignore-scripts
npm test
npm run test:funding:rust
```

## Run qualification checks

Requires Python 3.12; no dependencies or wallet needed.

```sh
python3 -m unittest discover -s scripts -t . -v
python3 scripts/qualify_fuji.py
python3 -m scripts.compare_fuji_rpcs
```

The network probes are read-only. Mainnet and transaction execution remain disabled. The active product is Fuji-only with no PAPER/simulated-execution fallback; local unit/fuzz/benchmark fixtures are development tests only.

See [Fuji qualification evidence and blockers](docs/FUJI_QUALIFICATION.md), the [Avalanche migration plan](docs/AVAX_MIGRATION_PLAN.md), [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).
