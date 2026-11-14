# Capped Fuji activation — implemented, not publicly activated

The manual contracts now support chain **43113**, retain local **31337** tests and reject mainnet execution. This is contract capability, not deployment, permission to sign, public readiness or an audit. The service/configuration remain execution-disabled.

## Bootstrap and authority

- A fresh vault starts with deposits inactive and entries paused. Its immutable Fuji liability cap cannot exceed **10,000,000 collateral base units (10 USDC)**.
- Only its bootstrap owner can bind the single settlement module, activate or pause/resume entries. Binding freezes the module address/runtime hash and verifies its vault/deployment references.
- `activateFuji(nonzeroEvidenceHash)` requires the bound settlement's technical readiness, unchanged collateral proxy-shell/runtime and six decimals. Settlement readiness checks fresh independently sourced price and a live funding checkpoint. The evidence hash records an owner attestation; it does **not** verify asset provenance, implementation/admin state or approval by itself.
- Pausing blocks deposits, new reservations and fills. Cancellation, expired-order release, existing funding settlement, owner closes/liquidation and free owner withdrawals remain callable. Changing chain/module runtime cannot grant custody authority.
- Live funding requires `validUntil > block.timestamp`: even the constructor block's default zero checkpoint cannot activate custody without publisher initialization. Funding expiry blocks fills and resume. Existing positions can settle the frozen terminal index and close **only with fresh price data**. Reserving a cancellable order does not itself create a position and does not require a live funding rate.

`AvensFeedOracle` separately enforces base and collateral feed freshness; the settlement's composite timestamp remains the older original source timestamp. Candidate constructor policy is **600 seconds AVAX/USD**, **86400 seconds USDC/USD**, composite maximum **86400 seconds**. These are explicit proposed release parameters, not an approved public policy or uninterrupted-availability promise. The local publisher adapter remains local-only, but now also returns initialized expired terminal indices for fresh-price local exits; neither adapter accrues an expired gap. See [feed semantics and trust limits](FUJI_FEED_ADAPTER.md).

## Reproducible historical fork check

```sh
node --experimental-strip-types scripts/qualify-fuji-fork.mjs
```

This optional network check has no wallet/password inputs or public write path. It first runs the existing current-account read-only preflight, then independently reads the **historical** fixture block **61048431**, hash `0xcaa872f12ead6bb50acd4669a2f4843befae6809f51ac228fbbe51c63f863c2f`, from both fixed providers. Account observations and historical fixture observations are kept separate. That fork point had genuine AVAX/USD source age 125 seconds; no price/source timestamp is replaced with read time. A current source or nonce mismatch is not permission to reset real funded state.

It starts a fresh loopback-only Anvil fork, verifies the historical hash/chain before impersonation, and uses only local issuer impersonation, test balances and throwaway trader keys. A completed run checked **27 actual local receipts**: three module creations, binding/activation, genuine copied USDC mint/approval/transfer behavior, issuer pause/blacklist reverting deposits, donation isolation, a wallet-signed bilateral fill, entry pause, partial/full owner closes after funding expiry, owner withdrawals and final custody/liability/fee conservation. Negative asset checks also require the exact decoded transfer error, not a transport failure. Receipt reads verify exact hash/from/to and canonical local block identity; they do not resubmit transactions on a receipt-watcher timeout.

This is historical fork evidence, **not public Fuji transactions**, current feed availability, public finality, liquidity, actual issuer authorization or public custody qualification. The report deliberately retains `qualificationComplete:false`, `publicDeploymentAuthorized:false` and zero public submissions. Generated reports/fixture addresses stay outside Git. Public sources/roles/code and the current sender nonce must be rechecked before any later authorized signature.

## Remaining gates and issuer risk

Circle's candidate proxy remains upgradeable, pausable and blacklistable. Proxy-shell pins do not freeze the underlying implementation, controller addresses or Chainlink aggregator governance. Source-explorer verification metadata was inspected for `FiatTokenV2_2` implementation `0x6f3c4787bab4eeebf62efb8c35dc9259fdc9d9f4`; that is not an independent bytecode rebuild or security audit. An issuer freeze can prevent token exits; exact-delta checks revert without fabricating payouts.

The next public scope must freeze reviewed source/artifacts, exact roles/constructors/nonces/runtime hashes, fees/budget, expiry and canonical recovery, and receive explicit approval. Initially deploy **paused**, with no activation, rate publication, collateral transfers, trades or hedges. Public asset acquisition/deposit/withdraw validation needs a separate bounded authorization after deployment. Adaptive funding, terminal, admission and Guardian/Autopilot integrations remain incomplete. See [deployment draft](FUJI_DEPLOYMENT_PLAN.md).
