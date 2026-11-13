# NEARFlow source baseline

The actual source is `/home/ahir/Projects/near-hacks/NEARFlow`, not the former planning scaffold. Source HEAD is `bc3ac2f4fa9e181073cf9b6efa55dc6ba7ffa23c` plus substantial dirty/untracked work. The full working-source snapshot is local at `legacy/nearflow/`; [its manifest](../config/nearflow-source.json) identifies each copied file by SHA-256 and size.

359 files (13,834,863 bytes) were copied and individually byte-verified against source. Source working-tree Git status was checked before/after and remained unchanged. Credentials/environment files, dependency/build directories, key files and symlinks were excluded. This is source copying, not transfer of balances, keys, deployments or authority.

## Already present — reuse, do not rebuild

- Landing and isolated demo terminal: `client/features/{landing,demo-terminal}`, `client/app/{page.tsx,demo}`.
- Backend-connected manual terminal, Markets/Portfolio/Leaderboard: `client/app/(exchange)`, `client/features/trade`, `client/stores`.
- Canonical NEAR custody, matching, settlement, funding and strategies: `contracts/exchange/src`.
- Funding Rust/TypeScript references and golden vectors: `packages/funding`.
- Conservative capital/sizing/opportunity, policy/watchdog, persistence/replay: `packages/{vault,risk,adapters}` and `services/guardian`.
- Read API, native NEAR wallet/RPC/receipt bindings: `client/lib/near` and `client/app/api`.
- Rust/TS/Sandbox/browser tests, operating documentation and source-specific public evidence.

The entire source `migration.md` was read, together with `ARCHITECTURE.md`, current `todo.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PHASE0_DECISIONS.md` and initial chain-boundary/math modules. The migration document supersedes older NEAR-only chain assumptions; the current source todo supersedes older PAPER-first delivery instructions. A complete module-by-module semantic/security review is **not yet finished**. Hashing/copying a file does not establish that review.

## Corrected delivery basis

Follow [the migration todo](../todo.md), mapping source M0–M8 into six delivery phases. Preserve the matched bilateral capped product, six-decimal collateral/base order size, 18-decimal prices, signed rounding, payer-limited funding, fixed-owner payouts and existing UI. Rewrite NEAR-specific contracts/authority/transport for EVM; do not replace the exchange with GMX or treat a ticker rename as a migration.

The source's integrated Vault/Hedge UI, public automation and economically eligible public hedge have unfinished gates. Existing public NEAR custody-smoke evidence is not Avalanche evidence. Historical NEAR run authorization does not authorize Fuji signing.

## Publication and limitations

The full baseline stays ignored/local while rights, evidence and sensitive-data review proceeds. No source dependencies or public signing scripts were executed during the snapshot. No source test count is claimed as a fresh result.

`client/licenses/terminal` and `client/licenses/walletconnect` contain notices that must accompany reused code/assets. `docs/UI_SOURCES.md` records a missing supplied landing-source/artwork license; attribution alone does not grant redistribution rights. Resolve that before pushing the landing implementation/artwork. Instruction guides are local reference only, not publication payload.

The prior root Node/TypeScript/Foundry scaffolding is unfinished, uncommitted work, not a completed phase. Public activation, code parity, integrations, clean release and old-chain retirement remain separately gated.
