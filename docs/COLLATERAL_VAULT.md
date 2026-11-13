# Canonical collateral custody foundation

`contracts/evm/src/AvensVault.sol` implements **local-EVM-enabled canonical custody** for Phase 3. It is not independently a settlement exchange, a deployed application or proof of the complete Phase 3 gate. No public deposits, orders, positions or trading become available from this change.

## Implemented boundary

- Immutable collateral contract, six-decimal requirement, nonzero deployment identity and finite liability cap. Construction permits only local chain `31337` or Fuji `43113`; mainnet is rejected.
- Immutable bootstrap owner may activate deposits only on local chain `31337`. **Fuji activation always reverts**, including for the bootstrap owner. A later reviewed settlement/module gate is required before any public custody activation; deploying this version on Fuji cannot enable deposits.
- One ledger: per-owner free collateral, order reservations, bilateral pair margins, opening fees and insurance. Their aggregate equals `totalLiabilities6`; `accounting()` independently verifies the bucket totals before every financial operation. No parallel offchain spendable credit, generic balance-credit, arbitrary token payout, sweep or rescue endpoint exists.
- One immutable settlement binding, installed by the bootstrap owner before local deposit activation. Binding verifies contract code and exact vault/deployment references; rebind and late binding revert. The settlement module is trusted to validate signatures, oracle/risk rules and signed fill identity, not to invent collateral.
- Only that frozen module may reserve/release recorded order escrow, open unique pairs, move bounded funding between those pair margins and settle existing margins. Pair IDs cannot be reused even after full release. Insufficient collateral on either side reverts the whole transition.
- Settlement payouts derive from recorded pair owners; released margins must equal owner payouts plus insurance plus a bounded liquidation reward credit. Reward credits are liabilities owed to the specified liquidator, withdrawable only by that address. No module method transfers tokens to an arbitrary recipient.
- Deposits require exact owner debit **and** vault credit. Withdrawals require exact vault debit **and** owner credit, with recipient fixed to `msg.sender`. Nonzero amounts, sufficient free funds and a reentrancy lock are mandatory. A failed transfer or delta check reverts the entire token/accounting transition.
- Standard ERC-20 boolean success and successful empty returns are supported. False, malformed and reverted transfers fail closed. Tokens with transfer fees, sender surcharges or balance changes that violate exact deltas are rejected.
- Direct donations remain uncredited surplus and do not consume the liability cap or create withdrawable claims. There is deliberately no surplus recovery authority. Custody below recorded liabilities causes accounting, deposit and withdrawal to fail closed rather than paying early callers from other owners' collateral.

```text
actual token custody = recorded liabilities + uncredited surplus
recorded liabilities = total free + escrow + pair margins + fees + insurance
recorded liabilities <= immutable deposit cap
```

The cap bounds credited liabilities, not permissionless token donations. Reading token decimals does **not** qualify a public asset: proxy/admin behavior, freezing, transfer semantics, rebases and honest balance reporting still require independent qualification. A malicious allowlisted token can lie about balances; exact-delta accounting cannot solve that trust assumption.

## Compatibility and remaining work

This is not an implementation of `IAvensVault`'s superseded v1 onchain-order-book ABI. In particular, `freeBalance(address)` is the manual-book-only view and `accounting()` reports the sole collateral asset; there are no strategy books yet. The CLOB signed-fill module must enforce the signature/risk boundary separately from these custody bounds. A valid binding alone does not qualify a deployment or enable public custody. There are no callers using this foundation as a live adapter.

Escrow, pair margins, opening fees and insurance extend **this canonical ledger**, never another spendable representation of the same funds. Strategy allocation/inventory and automation remain disabled until their later-phase authority/risk implementation. Reserving collateral does not itself cancel or fill an order; the signed-settlement module owns order validity, cumulative fills and cancellation checks. No unchecked matcher credit or module token-payout authority may bypass owner/bucket conservation.

## Verification

Run:

```sh
forge test --root contracts/evm --match-path test/AvensVault.t.sol
npm test
```

The original 24 custody adversarial tests were drafted by OpenCode against a separately implemented vault and reviewed/integrated by the Pi agent. Integration strengthened reentrancy assertions and added two-owner conservation and sender-surcharge checks. Six additional ledger tests cover frozen binding, authorization, reservation ownership/consumption/release, bilateral rollback, bounded funding and partial/full conserving settlement, including one 1,000-run fuzz property. All 30 vault tests pass. Solidity formatting is checked with the pinned Solidity 0.8.30/Paris configuration. Local gas/code-size observations are not public transaction-cost evidence.

Tests use local malicious-token fixtures only; they are not token qualification, fork evidence or public Fuji receipts. No browser flow, public deployment/signing, external token behavior or completed settlement lifecycle was verified.
