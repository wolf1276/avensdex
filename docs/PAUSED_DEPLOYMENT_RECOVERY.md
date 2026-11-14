# Paused deployment planning and recovery

`packages/protocol/deployment.ts` implements an offline **draft planner/journal**, not a signer, broadcaster, approval service or public deployment CLI. OpenCode drafted it; parent review added the shared-proxy-code regression, preserved real null addresses on reverted creations, bounded receipt gas and rechecked canonicality after runtime reads. Tests use generated local fixture keys only.

## Fixed scope

`buildDeploymentPlan(input, reviewedArtifacts, now)` permits Fuji **43113**, market 1, mainnet false, a distinct deployer/funding publisher, collateral/base/quote identities, cap at most **10 USDC**, explicit feed ages and a future expiry at most 24 hours away. Four consecutive owner nonces encode exactly:

1. Create `AvensVault(collateral, deploymentId, depositCap6)`.
2. Create `AvensFeedOracle(1, baseUsdFeed, quoteUsdFeed, fundingPublisher, baseMaxAge, quoteMaxAge)`.
3. Create `AvensSettlement(vault, feedOracle, 1, maxOracleAge)`.
4. Call `vault.bindSettlement(settlement)`.

All native values are zero. Gas limits multiplied by maximum fees must fit the stated budget, at most **0.05 test AVAX**. Addresses, ABI/creation-code/init-data hashes, source revision/fingerprint, fees and nonce sequence are bound into a deterministic plan hash. Different feed addresses can legitimately share identical proxy-shell bytecode; code-hash uniqueness is not identity qualification.

`validateDeploymentPlan` rebuilds from trusted inputs/artifacts; a supplied hash alone proves neither authorization nor qualification. All returned plans/views retain `approvalRequired:true`, `executionEnabled:false`, `depositsActive:false`. No activation, rate publication, approvals, collateral transfer, trade, hedge, upgrade, cancellation or replacement transaction is encodable.

## Durable evidence

`DeploymentJournal.open(directory, { input, artifacts, expectedRuntimeHashes, reader, confirmations, create? }, now)` writes/fsyncs its plan header before recording any signed identity. It uses an exclusive writer lock, hash-chained bounded JSONL, file/directory fsync and refuses missing/corrupt journals, truncation, lock stealing or an implicit reset. Unknown writes poison the writer and retain its lock for explicit recovery.

`recordSigned(serializedTransaction)` recovers the actual EIP-1559 sender and verifies chain, nonce, target, zero value, calldata hash, gas and fees against the next planned transaction before persisting its hash. It does not produce a signature or broadcast. `reconcile(sequence)` requires the actual transaction plus canonical receipt/confirmations, sender/nonce/input identity and expected created runtime. Receipt gas cannot exceed signed gas. A reverted creation's real null contract address is preserved, not invented. Reorgs/missing evidence/unexpected runtime stop progression.

Restart downgrades persisted progress to unknown and requires serial fresh reconciliation. Reconciliation may continue after plan expiry. Nothing here permits automatic retries/replacements, releases an unknown nonce or destroys the old journal.

## Read-only reader CLI

`npm run deployment:read -- <command>` uses the fixed Fuji endpoints and the two-provider reader to print `head`, `block <number>`, `transaction <hash>`, `receipt <hash>` or `code <address> <block>` as JSON. Both providers must agree on the requested observation; malformed or one-sided results fail closed. Head reads enforce freshness, and code reads check the pinned block for reorgs. Receipt inspection alone does not establish canonicality or confirmation depth; those checks remain the journal's responsibility. The CLI has no signer, retry, broadcast or journal-write path, and it is not wired to `DeploymentJournal` reconciliation or an operator signing workflow.

## Operator obligations before any real key use

`nextSignableSequence` describes ordering only; it is **not** signing permission. The operator must separately establish explicit approval of the exact frozen plan, current expiry, trusted/reviewed artifacts/runtime hashes, fresh paired-provider evidence, current sender nonce/pending reconciliation, current asset/feed implementation/governance and sufficient remaining gas reserve/balance. Repeat applicable checks immediately before each signature/submission. Persist raw signed material/recovery data securely outside Git; this journal stores identity hashes, not recoverable raw bytes.

Expiry forbids new signatures/submissions, but cannot invalidate an already signed/broadcast EVM transaction: it may mine later and its worst-case gas remains reserved. Any cancellation/replacement requires a separately bounded authorization and reconciliation; do not silently extend expiry, spend a new budget or start a new nonce sequence.

No public gas or collateral was spent by these tests. See [the deployment draft](FUJI_DEPLOYMENT_PLAN.md) and [activation/fork evidence and limitations](FUJI_ACTIVATION.md).
