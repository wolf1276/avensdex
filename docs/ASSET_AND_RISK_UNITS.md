# Asset units and bilateral risk contract

## Units and bounds

- Collateral/accounting: atomic units of an explicitly verified six-decimal asset. No token is enabled by these libraries.
- Orders: micro-base (`size6`, `1e6` = one base unit).
- Price/funding index: `price18`/`index18`, `1e18` collateral currency per base. Positive prices are capped at `1e27` as in the source.
- Raw inventory: verified token units. Conversion supports decimals 6–24; six-decimal order size rounds **down** from actual raw output. Unhedged raw dust remains owned inventory, never another spendable collateral credit.
- Initial wrapped AVAX candidate: 18 decimals, factor `1e12` from size6. Native AVAX gas is not WAVAX inventory or collateral.
- Money/size inputs use u128; signed indexes/checkpoints use i128. Pair aggregate margin must fit positive i128 and remainder magnitude must be `<1e18`. This explicitly rejects unrealistic signed-cast overflow states; it does not increase the much smaller source deposit/exposure caps.

`mulDiv` uses u128 operands and a u256 intermediate; it rejects a zero divisor or a result outside u128. Signed operations retain source truncation toward zero and reject out-of-range intermediates before clipping. No float is used in financial state.

## Preserved rules

- `notional6 = floor(size6 × price18 / 1e18)`.
- PnL truncates signed `size6 × (exit18 − entry18) / 1e18`, capped between negative own margin and positive counterparty margin.
- Funding uses `(size6 × indexDelta18 + remainder) / 1e18`, signed truncation. Positive payment debits long margin and credits short margin. Clip to payer margin; discard only the unpaid capped remainder, never mint arrears.
- Same-index funding settlement has no second payment. Fractional carry is preserved through sign reversal.
- Settle funding **before** partial close. Close-side margins round down proportionally; the remaining pair retains integer margin dust and proportionally truncated signed funding remainder. Full close leaves no margin/remainder.
- Opening fee: ceil(notional6 × 3 / 10,000).
- Actual liquidation uses fresh capped equity and inclusive maintenance threshold, with minimum one collateral atomic unit. The computed liquidation price is informational, not an execution oracle or guaranteed exit.

These are pure snapshots and calculations, not custody/settlement state. Authoritative margins will exist only in the vault. A zero-sized remaining split is a closed result, not a valid input pair.

## Checks

Both Solidity and the independent bigint reference consume the unchanged original accounting vectors. TS tests include 10,000 seeded funding/payout transitions, raw precision 6/8/18/24, fee ceilings, partial/full close, replay/reversal, malformed values and extreme bounds. Foundry includes 1,000-run conservation and raw-dust fuzz tests, source vectors, wide products and rejection paths. Run `npm test` for current local checks.

No contract custody, matching, liquidation transfer, deployment, oracle or actual token precision is established by math tests. Source tests and Avalanche results are reported separately.
