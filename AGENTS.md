# Avensdex contributor instructions

Read `README.md`, `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` before implementation.

## Workflow

- Deliver the smallest complete, tested change for the current milestone.
- Commit each completed logical unit as work progresses. Do not batch the whole project into a large commit.
- Keep behavior changes with their directly related tests. Use descriptive commit messages.
- Inspect staged diffs, run `git diff --check` and relevant tests before committing.
- Preserve unrelated work. Never commit credentials, private journals or generated outputs.
- Retain applicable licenses and third-party attribution when introducing dependencies, code or assets.
- Report checks actually run and remaining limitations. Documentation does not establish implementation or deployment.

## Safety

- Initial network is Avalanche C-Chain Fuji; mainnet stays disabled.
- One canonical ledger owns collateral, escrow, margins, inventory and insurance liabilities.
- Preserve owner-only payouts, scoped executor authority, oracle freshness and replay protection.
- Reconcile unknown transactions before retrying. A successful submission is not proof of a filled order or hedge.
- Never reset funded state or bypass custody/security checks to meet a deadline.
- Keep local, fork and public testnet evidence distinct. Never invent addresses, receipts, balances, profitability or test results.

## Delivery

The repository is currently a planning scaffold. Implementation begins in a subsequent session. Public deployments and signing require an explicitly bounded execution plan and applicable authorization. Publication must use the confirmed remote: `https://github.com/wolf1276/avensdex`.
