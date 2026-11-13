# Canonical collateral custody foundation

`contracts/evm/src/AvensVault.sol` implements the first **local-EVM-only custody slice** of Phase 3. It is not a settlement exchange, a deployed application or the complete Phase 3 gate. No public deposits, orders, positions or trading become available from this change.

## Implemented boundary

- Immutable collateral contract, six-decimal requirement, nonzero deployment identity and finite liability cap. Construction permits only local chain `31337` or Fuji `43113`; mainnet is rejected.
- Immutable bootstrap owner may activate deposits only on local chain `31337`. **Fuji activation always reverts**, including for the bootstrap owner. A later reviewed settlement/module gate is required before any public custody activation; deploying this version on Fuji cannot enable deposits.
- One ledger: per-owner free collateral, with `totalLiabilities6` equal to its aggregate. No parallel offchain spendable credit, delegate, arbitrary recipient, sweep, module balance-credit or rescue endpoint exists.
- Deposits require exact owner debit **and** vault credit. Withdrawals require exact vault debit **and** owner credit, with recipient fixed to `msg.sender`. Nonzero amounts, sufficient free funds and a reentrancy lock are mandatory. A failed transfer or delta check reverts the entire token/accounting transition.
- Standard ERC-20 boolean success and successful empty returns are supported. False, malformed and reverted transfers fail closed. Tokens with transfer fees, sender surcharges or balance changes that violate exact deltas are rejected.
- Direct donations remain uncredited surplus and do not consume the liability cap or create withdrawable claims. There is deliberately no surplus recovery authority. Custody below recorded liabilities causes accounting, deposit and withdrawal to fail closed rather than paying early callers from other owners' collateral.

```text
actual token custody = sum(owner free balances) + uncredited surplus
recorded liabilities = sum(owner free balances) <= immutable deposit cap
```

The cap bounds credited liabilities, not permissionless token donations. Reading token decimals does **not** qualify a public asset: proxy/admin behavior, freezing, transfer semantics, rebases and honest balance reporting still require independent qualification. A malicious allowlisted token can lie about balances; exact-delta accounting cannot solve that trust assumption.

## Compatibility and remaining work

This is not an implementation of `IAvensVault`'s superseded v1 onchain-order-book ABI. In particular, `freeBalance(address)` is the manual-book-only view and `accounting()` reports the sole collateral asset; there are no strategy books yet. The CLOB signed-fill ABI and module bootstrap must be specified and tested before adding settlement. There are no callers using this foundation as a live adapter.

Future escrow, pair margins, fees, insurance and strategy inventory must extend **this canonical ledger**, never add another spendable representation of the same funds. Atomic signed settlement, nonce invalidation, funding, close/liquidation and intent reconciliation remain open. No unchecked matcher credit or module payout authority may bypass owner/bucket conservation.

## Verification

Run:

```sh
forge test --root contracts/evm --match-path test/AvensVault.t.sol
npm test
```

The custody adversarial tests were drafted by OpenCode against a separately implemented vault and reviewed/integrated by the Pi agent. Integration strengthened reentrancy assertions and added two-owner conservation and sender-surcharge checks. All 24 custody tests pass, including two 1,000-run fuzz properties. Full `npm test` passes: typecheck, 61 TypeScript tests, 12 Python tests and 43 Foundry tests. `forge fmt --check` passes for the two new Solidity files. Optimized runtime is 3,477 bytes with the pinned Solidity 0.8.30/Paris configuration; a local gas report is not public transaction-cost evidence.

Tests use local malicious-token fixtures only; they are not token qualification, fork evidence or public Fuji receipts. No browser flow, public deployment/signing, external token behavior or completed settlement lifecycle was verified.
