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

## Offline plan CLI

`npm run deployment:plan -- <planner-input.json> <reviewed-artifacts.json>` reads exactly two local regular files, rebuilds the plan through `buildDeploymentPlan` and prints it as JSON, including `planHash`, `approvalRequired:true`, `executionEnabled:false` and `depositsActive:false`. Each file must be non-empty and at most **1,048,576 bytes**. Missing, non-regular, oversized or malformed JSON files and invalid planner fields fail closed with a bounded error code. Expiry is checked against the current UTC Unix time; the plan hash does not depend on the time of the run.

The input file is the existing schema-1 planner input accepted by `buildDeploymentPlan`, not a new format. It must contain exactly the planner's top-level keys; extra fields are rejected.

The artifacts file must be an object with exactly `AvensVault`, `AvensFeedOracle` and `AvensSettlement`, each containing `abi` (the reviewed ABI array) and `bytecode` (a `0x`-prefixed creation-code string). Raw Foundry artifact JSON does not fit this schema because Foundry stores bytecode at `bytecode.object`. The plan CLI does not read `contracts/evm/out`, compile contracts or qualify artifacts. To extract the planner format from an existing Foundry build, run `npm run --silent deployment:artifacts -- contracts/evm/out > /absolute/external/path/reviewed-artifacts.json`. The extraction CLI reads only the three fixed `Contract.sol/Contract.json` paths, enforces bounded regular-file reads and rejects malformed creation code or nonempty link references. It does not establish source provenance, constructor correctness, deployment runtime hashes or review approval. The operator must review the source/release, verify the resulting hashes and constructor/bind surface, and keep the approved files outside generated build output. The planner validates the required constructors and the vault binding function; preparing these files is not deployment authorization.

The CLI has no signer, wallet, RPC, broadcast, activation, approval or journal-write path. Printing a plan is not authorization to sign or deploy.

## Explicit operator preparation and execution

`npm run deployment:prepare -- <absolute-input.json> <new-absolute-external-directory>` builds the existing plan and rehearses its four exact calls on a newly spawned private loopback Fuji fork. Public upstream calls are read-only and fixed-provider; no operator key is loaded. It verifies predicted addresses, gas bounds, constructor-dependent runtime hashes, owner/publisher/binding, zero liabilities and paused custody. Generated packets stay outside Git. Fork receipts are not public deployment evidence.

`npm run deployment:execute -- <absolute-packet-directory> <encrypted-keystore-path> <password-file-path> <approval-json-path>` is a separate **operator-only signing/broadcast CLI**, not a server component. The approval object must contain exactly `approved:true`, `chainId:43113`, the exact `planHash`, a current `expiresAt` no later than the plan expiry, a decimal `budgetWei` covering maximum planned gas and at most 0.05 test AVAX, `pausedOnly:true` and an explicit `authorizationReference`. A local approval file records applicable owner authorization; creating one is not a substitute for obtaining that authorization.

The CLI validates signer identity, actual chain, latest/pending nonce, native gas reserve and source-code pins; preserves owner-only raw signed material with fsync before journal binding/dispatch; and submits each sequence once. It reconciles the fixed signed hash against the paired reader before signing the next sequence. Unknown/reverted/reorged outcomes stop with preserved journals and a global recovery marker—there is no automatic retry, replacement, reinitialization or activation. Final verification reads actual paused vault/binding/publisher state from both providers. Never upload keystores, password files, packets or recovery material to Vercel or Git.

The reusable approval/calldata helpers have local regression tests. Preparation additionally contains assert-based private-fork checks of the real compiled artifacts; operator execution still requires current qualification and bounded authorization.

## Durable evidence

`DeploymentJournal.open(directory, { input, artifacts, expectedRuntimeHashes, reader, confirmations, create? }, now)` writes/fsyncs its plan header before recording any signed identity. It uses an exclusive writer lock, hash-chained bounded JSONL, file/directory fsync and refuses missing/corrupt journals, truncation, lock stealing or an implicit reset. Unknown writes poison the writer and retain its lock for explicit recovery.

`recordSigned(serializedTransaction)` recovers the actual EIP-1559 sender and verifies chain, nonce, target, zero value, calldata hash, gas and fees against the next planned transaction before persisting its hash. It does not produce a signature or broadcast. `reconcile(sequence)` requires the actual transaction plus canonical receipt/confirmations, sender/nonce/input identity and expected created runtime. Receipt gas cannot exceed signed gas. A reverted creation's real null contract address is preserved, not invented. Reorgs/missing evidence/unexpected runtime stop progression.

Restart downgrades persisted progress to unknown and requires serial fresh reconciliation. Reconciliation may continue after plan expiry. Nothing here permits automatic retries/replacements, releases an unknown nonce or destroys the old journal.

## Read-only reader CLI

`npm run deployment:read -- <command>` uses the fixed Fuji endpoints and the two-provider reader to print `head`, `block <number>`, `transaction <hash>`, `receipt <hash>` or `code <address> <block>` as JSON. Both providers must agree on the requested observation; malformed or one-sided results fail closed. Head reads enforce freshness, and code reads check the pinned block for reorgs. Receipt inspection alone does not establish canonicality or confirmation depth; those checks remain the journal's responsibility. The CLI has no signer, retry, broadcast or journal-write path, and it is not wired to `DeploymentJournal` reconciliation or an operator signing workflow.

## Journal reconciliation CLI

`npm run deployment:reconcile -- <journal-directory> <planner-input.json> <reviewed-artifacts.json> <runtime-config.json>` opens an **existing** deployment journal with `create:false`, rebuilds its plan from the external planner input and reviewed artifacts, validates the supplied runtime hashes and confirmation policy, and uses the fixed two-provider Fuji reader to reconcile signed transactions in serial order. It writes status transitions to the local journal only; the two-provider RPC reads themselves are read-only. It has no signer, broadcast, activation or journal-create/reset operation. `<runtime-config.json>` must contain exactly `expectedRuntimeHashes` and `confirmations`. Missing journals, corrupt journals and identity mismatches are refused. Opening uses the journal's writer lock and may create the directory; restart invalidation and failed or successful observations can append local status records. It never creates a missing journal or resets evidence. Exit `0` means every signed transaction observed is confirmed (unsigned planned steps may remain); `2` means at least one signed transaction remains unresolved or reverted/reorged, and `1` means an operational error. A zero exit is not deployment completion or signing permission. Reconciliation stops before later transactions when a predecessor is not confirmed.

## Operator obligations before any real key use

`nextSignableSequence` describes ordering only; it is **not** signing permission. The operator must separately establish explicit approval of the exact frozen plan, current expiry, trusted/reviewed artifacts/runtime hashes, fresh paired-provider evidence, current sender nonce/pending reconciliation, current asset/feed implementation/governance and sufficient remaining gas reserve/balance. Repeat applicable checks immediately before each signature/submission. Persist raw signed material/recovery data securely outside Git; this journal stores identity hashes, not recoverable raw bytes.

Expiry forbids new signatures/submissions, but cannot invalidate an already signed/broadcast EVM transaction: it may mine later and its worst-case gas remains reserved. Any cancellation/replacement requires a separately bounded authorization and reconciliation; do not silently extend expiry, spend a new budget or start a new nonce sequence.

No public gas or collateral was spent by these tests. See [the deployment draft](FUJI_DEPLOYMENT_PLAN.md) and [activation/fork evidence and limitations](FUJI_ACTIVATION.md).
