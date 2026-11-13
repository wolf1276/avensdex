# Avalanche migration and implementation plan

Status: M0 started with implemented read-only network checks and [recorded public RPC observations](FUJI_QUALIFICATION.md). Trading integrations, contracts, deployment and transaction execution remain unimplemented/unqualified.

## 1. Scope and baseline

Avensdex will target Avalanche C-Chain Fuji (chain ID `43113`) first. Avalanche mainnet (chain ID `43114`) is explicitly disabled. AVAX is the native gas asset; wrapped AVAX, collateral and native gas must have separate balances and units.

The existing implementation has now been identified at `/home/ahir/Projects/near-hacks/NEARFlow`, including dirty/untracked source, the landing page and full terminal. [The source baseline](NEARFLOW_BASELINE.md) and [`todo.md`](../todo.md) supersede the former greenfield assumption and sequence in this scaffold. Follow the source's complete `migration.md` for behavioral parity and its current roadmap for pre-existing gaps. Reuse the existing UI, TypeScript funding/risk/economic code and protocol semantics; rewrite NEAR-specific custody, authority and transport for EVM. The local baseline is ignored until publication/rights review. Funded-state migration still requires separate authorized reconciliation and cutover; never reset or silently transfer balances.

Initial scope:

- One isolated, bilateral perpetual market.
- One explicitly qualified collateral asset and base asset.
- One executable spot integration, if Fuji liquidity and asset compatibility qualify.
- Canonical vault custody, bounded matching/settlement/funding, owner-controlled hedge policies, guardian and integrated trading client.
- Capped public validation only after local and integration gates pass.

Not in scope: mainnet, bridges, custom Avalanche L1s, pooled shares, multi-venue routing, unrestricted executors, proxies, gas sponsorship or unattended investment without separate approval.

## 2. Decisions required before implementation

Record accepted decisions as versioned design records. Unresolved execution-critical decisions block the dependent milestone.

| Decision | Required outcome |
| --- | --- |
| Market | Base/quote identity, tick/lot sizes, minimum order, notional/open-interest caps |
| Collateral | Verified chain address, decimals, transfer behavior, issuer/admin risks and availability |
| Settlement | Bilateral payout cap, close rules, liquidation, fees, rounding and bad-debt behavior |
| Oracle | Exact feed/source, units, heartbeat, staleness, deviation and outage rules |
| Spot venue | Exact deployed contracts, supported pair/route, liquidity, fees and approval semantics |
| Funding | Formula, units, update authority, epochs, payer limits, caps and expiry |
| Runtime | Pinned compiler, EVM target, Foundry, Node/package manager and client dependencies |
| Operations | Role holders, pause/recovery permissions, bounded spending and public validation budgets |
| Product | Transparent capped-payoff disclosures, execution-validation versus investment scope |

AVAX exposure is a candidate market, not a confirmed choice. Do not assume a token ticker identifies a usable asset, that a mainnet feed exists on Fuji, or that testnet liquidity is economically representative.

## 3. Avalanche qualification

### Network and infrastructure

- Verify chain identity from independent authoritative documentation and RPC responses.
- Select primary and independent fallback RPC services; document limits, log ranges, WebSocket behavior and transaction-history availability.
- Verify explorer links, receipt lookup, finality policy and behavior during RPC disagreement or downtime.
- Confirm supported EVM features and compiler target against Fuji; measure deployment size and worst-case transaction gas on the chosen runtime.
- Keep local node, pinned fork and public Fuji configuration distinct. Do not permit environment-variable fallback to mainnet.
- Use an allowlisted deployment manifest, never arbitrary browser-supplied contract addresses.

### Assets, pricing and routes

For every asset, record address, decimals, verified source, code identity, mint/admin controls and supported transfer behavior. Reject unsupported fee-on-transfer, rebasing or callback behavior rather than silently crediting nominal amounts.

For every oracle, record feed address, quote/base units, valid round/timestamp rules, update cadence and failure handling. Reject invalid, nonpositive, future-dated or stale data. A chart API is informational only, never a settlement fallback.

For the selected spot route, verify router/pool addresses, token order, supported swap interface, reserve/depth evidence, fees, price impact, slippage, deadlines, approval behavior and entry/exit availability at intended sizes. Reconcile actual token deltas rather than trusting quoted output.

Qualification output: a reproducible report with timestamp/block, commands or scripts, source references, quotes, costs, limitations and a pass/fail decision. Addresses and successful RPC reads alone do not qualify a route. Mocks may establish local behavior only; an unavailable Fuji integration blocks genuine public hedge validation rather than permitting a simulated substitute.

## 4. Target architecture and accounting

Proposed layout, to create only as each implementation unit is ready:

```text
contracts/          Vault, Exchange, Funding, OracleAdapter, StrategyExecutor, Reader
contracts/test/     unit, fuzz, invariant and integration tests
packages/domain/    typed units, schemas, reference math and deployment identity
packages/client/    validated chain reads and transaction construction
services/guardian/  durable intents, admission, submission and reconciliation
apps/web/           landing, manual Trade and strategy controls
config/             non-secret network/deployment manifests
scripts/            qualification, deployment and evidence tooling
docs/               design records, runbooks and evidence indexes
```

Use explicit integer units for native gas, token quantities, price, notional, margin, funding rate/index and time. Document conversion denominators, signed arithmetic, bounds and rounding direction. Do not use floating point for financial state.

The Vault is the sole custody and liability ledger. Free balances, order escrow, pair margins, strategy allocations/inventory, accrued fees and insurance must be mutually exclusive allocations. Internal transfers conserve liabilities. Actual custody must cover liabilities per asset; direct donations create no depositor credit and require an explicit surplus policy.

Exchange and strategy modules receive typed, narrowly scoped capabilities. No arbitrary-call executor, unrestricted credit function or alternate spendable ledger. Withdrawals go only to authenticated owners. Delegates cannot withdraw, change recipients or enlarge policy permissions.

Emergency actions must be operation-specific: block risk-increasing activity while preserving safe recovery/withdrawal where valid. Never bypass oracle, solvency or ownership checks to force an exit. Define outage behavior explicitly.

## 5. Contract workstream

### A. Financial specification and reference model

Specify matching priority, reservation and release rules, partial fills, IOC, post-only, reduce-only, cancellation, expiry, nonce scope and maximum matching work. Specify pair lifecycle, realized/unrealized PnL, fees, close/liquidation priority and funding before margin changes.

Specify baseline/adaptive funding, premium validation, smoothing, deadband, slope/absolute caps, epoch identity, rate expiry, skipped intervals, fractional carry and payer-capacity limits. An expired rate cannot accrue indefinitely. Funding debits and credits must conserve collateral.

Build independent reference vectors for both funding signs, zero funding, caps, rounding, minimum sizes, extreme valid inputs, partial closes and insolvency boundaries.

### B. Vault and exchange

Implement exact token-delta deposits, caps, custody accounting, scoped module access, escrow and owner withdrawals. Add reentrancy protection and explicit external-token assumptions.

Implement bounded price-time matching and bilateral positions. A matched pair holds both sides' margins; profits cannot exceed the counterparty's available pair margin or create claims on unrelated accounts. Implement fees, partial/full closes, liquidation and funding settlement without double spending reserved balances.

### C. Strategy execution

Policies bind chain, deployment, owner, strategy, executor, revision, nonce, expiry, route, assets, amount/exposure limits and cost budgets. Approval and strategy authorization remain separate. Test revocation and policy changes against pending execution and stale signatures.

One strategy allocation funds spot inventory, perp margin, reserve, fees, gas assumptions and repair allowance. Short notional is not spendable capital. Admission considers collectible funding, payer capacity, entry/exit liquidity and adverse-exit losses; positive displayed funding alone is insufficient.

Prove atomicity using actual contract composition, including partial order-fill semantics. If both legs cannot revert together, implement explicit partial-leg states, exposure/time caps, bounded repair and owner recovery. Never label submission or a successful transaction as a complete hedge without confirming both legs.

## 6. Guardian and persistence workstream

Use chain/deployment/account-scoped identities everywhere. Read related admission inputs at one canonical block and validate freshness before submission. Persist intent identity, policy revision, expected effects and transaction nonce before broadcasting.

Model transaction state separately from order/hedge state:

- Intent: prepared, submitted, unknown, confirmed, reverted, replaced or cancelled.
- Execution: unfilled, partial, hedged, repair-required, closing or settled.

Enforce a durable single writer per signing account or equivalent coordination. On timeout, crash or restart, reconcile canonical receipts, nonce replacements, fills, balances, positions and owned inventory before retrying. An unknown transaction is not an automatic retry. Handle duplicate events, RPC disagreement, reorgs and checkpoint replay idempotently.

Monitor margin, delta, payer capacity, funding expiry, counterparty exits, budget exhaustion and stale data. Bound every automated repair. Persist audit events without secrets and make safe stop/restart behavior reproducible.

## 7. Client workstream

Build landing and manual Trade first; integrate strategies inside Trade rather than shipping disconnected mock flows.

- Wallet connect, explicit Fuji switching, wrong-chain refusal and account-change invalidation.
- Verified deployment identity and token units on all reads and writes.
- Approvals, deposits, orders, cancels, positions, funding, liquidation risk and owner withdrawals.
- Allocation and policy review showing recipient restrictions, expiry, exposure and budgets.
- Distinct submitted/confirmed/filled/partial/hedged/recovery states and real explorer receipt links.
- Pause, revoke, recover, close and withdraw controls with truthful availability.
- Clear capped bilateral payoff and testnet-risk disclosures; no guaranteed-yield language.
- Keyboard, focus, mobile and disconnected/loading/empty/error coverage.

Validate schemas, numeric bounds, freshness, request sizes and read-service resource limits. Public read services must not expose signing keys or unrestricted transaction execution. Synthetic fixtures must never masquerade as live execution.

## 8. Test and assurance matrix

| Layer | Required checks |
| --- | --- |
| Math | Independent reference/differential vectors; signed bounds, rounding and both funding signs |
| Custody | Deposit/withdraw deltas, donations, conservation, escrow release, inventory and insurance liabilities |
| Exchange | Priority, partial fills, all order flags, expiry, cancellation races, bounded gas, close and liquidation |
| Authority | Cross-chain/deployment replay, stale nonce/revision, expiry, revocation, recipient changes, malicious callbacks |
| Pricing | Stale/invalid/future data, decimals, outage, deviation and stale funding gaps |
| Strategy | Capital sufficiency, slippage, partial fills, failed second leg, atomic rollback or bounded repair |
| Guardian | Crash before/after broadcast, unknown/replaced transactions, duplicate logs, reorg and restart reconciliation |
| Browser | Real wallet-driven lifecycle, chain/account changes, rejection, pending/error states and accessibility |
| Release | Clean install/build, pinned dependencies, secret scanning, license review and manifest/code verification |

Run unit, differential, fuzz and stateful invariant tests locally. Use a pinned fork only for reproducible integration evidence. Public Fuji validation is separate and must include real receipts and custody reconciliation. No test result or external availability is claimed until actually recorded.

## 9. Delivery sequence and acceptance gates

Each row is a milestone, delivered in small tested commits. Do not batch the whole build into one commit.

| Milestone | Deliverable | Exit gate |
| --- | --- | --- |
| M0 — qualification | Decision records, network/assets/oracle/venue report, risk register | Exact identities verified; executable scope approved; blockers explicit |
| M1 — specification/tooling | Unit conventions, module interfaces, reference model, pinned tooling and CI | Deterministic vectors and clean checks; no enabled unverified addresses |
| M2 — custody/exchange | Vault, matching, settlement, funding and liquidation | Conservation, differential, fuzz/invariant and worst-case gas checks pass |
| M3 — strategies | Scoped policies, genuine leg execution and recovery | Adversarial authorization and partial-leg/owner-exit checks pass |
| M4 — guardian | Durable intents, simulation, submission and reconciliation | Restart/unknown-transaction tests show no duplicate exposure |
| M5 — client | Canonical wallet-driven Trade and strategy lifecycle | Browser flow and state/error/accessibility checks pass |
| M6 — capped Fuji validation | Fresh verified deployment and bounded public lifecycle evidence | Deposits, fills, real swap/hedge, funding, revoke/recovery and settled payouts reconciled |
| M7 — release | Runbooks, evidence index, accurate demo and publication review | No unresolved money/security blocker; explicit publication approval |

M0 is the immediate next work. M6 is not authorized by this document. A failed liquidity or oracle qualification pauses the dependent scope; it does not justify silently substituting a different chain, mock integration or mainnet.

## 10. Deployment and operating controls

A versioned manifest must include schema version, chain ID, deployment ID, source revision, toolchain, constructor/config parameters, addresses, deployed code hashes, deployment blocks/transactions, assets/decimals, oracle and venue identities, roles, caps and activation state. No private keys or credentials belong in it.

Before public signing, obtain a bounded authorization covering network, signer/owner, allowed contracts/actions, maximum funds/gas/exposure, expiry, stop conditions and recovery procedure. Verify role assignment and bytecode before deposits. Keep keys outside source control and logs.

Public validation order:

1. Verify fresh deployment, manifest, paused/default-disabled settings and caps.
2. Test small deposits and owner withdrawals before enabling trading.
3. Validate matching/settlement with disclosed counterparties and limited collateral.
4. Exercise scoped real spot/perp execution and reconcile both legs.
5. Validate funding, revocation, interruption/restart, recovery and close.
6. Withdraw settled owner balances and reconcile all remaining liabilities/inventory.
7. Stop safely and record limitations, costs and residual obligations.

An authorized execution-validation session is not evidence of investment eligibility or profitability. Do not create artificial yield claims from self-funded counterparties.

On incident: disable risk-increasing actions, preserve evidence and funded state, reconcile chain truth, communicate blocked actions and follow reviewed owner recovery. Without an explicitly designed upgrade path, fixes require a fresh deployment and separately authorized owner exit/re-entry, not hidden state replacement.

## 11. Evidence, publication and completion

For each gate, record source revision, actual commands/checks, environment, chain/deployment identity, block references, receipts where applicable, token deltas, gas/costs, unresolved liabilities and limitations. Keep implementation status, integration availability, economic eligibility and activation status separate.

Never commit secrets, private journals or generated execution output indiscriminately. Review redacted evidence before publication. Retain dependency licenses and attribution.

Publication destination is `https://github.com/wolf1276/avensdex`; verify the configured remote and explicit release approval before pushing. This plan grants no deployment, signing or publication authority.

Completion means an evidence-backed capped Fuji lifecycle with reconciled custody and owner exits—not a UI demo, deployment address or transaction hash. Mainnet requires a separate reviewed plan and authorization.

## 12. Immediate checklist

- [x] Reopen the development session in `/home/ahir/Projects/avensdex` after the directory rename.
- [x] Inspect repository status and existing tracked files; preserve unrelated work.
- [ ] Review this plan and resolve market/collateral and public-validation scope.
- [ ] Perform M0 qualification; record verified sources and explicit failures.
- [ ] Freeze accounting, funding, interfaces and deployment schema before implementation.
- [ ] Inspect staged changes, run `git diff --check` and relevant checks, then commit each logical unit.

Current limitation: network identity and two-provider block agreement checks have passed, but M0 is incomplete. Market/assets, oracle, executable liquidity, finality and provider operating limits remain unresolved. Local tests and public read evidence are recorded separately in the qualification report. No deployment or signing has occurred.
