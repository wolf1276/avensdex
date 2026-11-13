# Avensdex

**Adaptive perpetual trading on Avalanche.**

Avensdex is a planned perpetual trading platform combining a matched exchange, adaptive funding and owner-controlled hedge strategies.

## Product

- Perpetual trading terminal with transparent positions, margin and funding
- Isolated collateral accounting and bounded settlement
- Revocable strategy permissions and cost-aware spot/perp execution
- Observable execution, recovery and owner withdrawals

## Network

Initial development targets Avalanche C-Chain Fuji. Mainnet execution is outside the initial scope.

## Status

M0 qualification has started: read-only Fuji network and independent-provider block checks are implemented and tested. No application, contracts or public deployment are included yet. No live trading, yield or production-readiness claims are made.

## Run qualification checks

Requires Python 3.12; no dependencies or wallet needed.

```sh
python3 -m unittest discover -s scripts -t . -v
python3 scripts/qualify_fuji.py
python3 -m scripts.compare_fuji_rpcs
```

The network probes are read-only. Mainnet and transaction execution remain disabled.

See [Fuji qualification evidence and blockers](docs/FUJI_QUALIFICATION.md), the [Avalanche migration plan](docs/AVAX_MIGRATION_PLAN.md), [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).
