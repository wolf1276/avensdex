# Appwrite Fuji backend

Deploy `services/appwrite/index.ts` as a **Node 22 Function**, not a Site or persistent HTTP server. Build from repository root with `npm ci --include=dev --ignore-scripts && npm run build`; entrypoint is `dist/services/appwrite/index.js`. Runtime imports are emitted JavaScript. A successful build does not establish live trading readiness.

## Storage and concurrency

A dedicated Appwrite database collection has one required string attribute `payload` (32768 characters), collection-level public **read only**, no client create/update/delete permissions and document security disabled. Only the Function's platform-issued ephemeral key gets `documents.read` / `documents.write`. No wallet, operator signing key, session credential or long-lived API key is deployed.

Explicit provisioning creates document `00000000` once, binding the stream, chain/market/settlement, deployment ID and exact configuration digest. Requests **never initialize missing storage**, clear existing history or migrate filesystem journals. Preserve any pre-existing funded journal separately; this adapter is not an implicit migration tool.

Each command prepares on an isolated matcher copy and atomically **creates** the next uniquely numbered document. No upsert/update/delete exists in the adapter. The record binds previous digest, command, authorization, resulting state digest and sequenced events. A competing worker cannot overwrite a winner. Lost acknowledgments are read back using the identical immutable payload; absent/different outcomes return unavailable without resubmission. Cold starts replay and validate the complete bounded prefix.

Shortcut: this capped testnet release retains at most **1024 command records**, each at most **32768 bytes**. Capacity exhaustion, oversized crossing sweeps, corruption or missing history stop admission; they do not truncate or compact funded state. Review/export/migrate explicitly before increasing these bounds.

## Configuration and routes

Set public metadata variables `APPWRITE_ENDPOINT`, `CLOB_DATABASE_ID`, `CLOB_COLLECTION_ID`, and `CLOB_DEPLOYMENT_JSON` (the exact JSON from `config/fuji-clob.json`). Appwrite supplies the project ID and ephemeral `x-appwrite-key` at execution. The endpoint is restricted to official HTTPS Appwrite Cloud API hosts. Configure the `avensdex.vercel.app` web platform for public Realtime subscription.

- `/health`: checks durable storage replay, not financial readiness.
- `/snapshot`, `/orderbook`, `/orders`: actual persisted provisional state; expiry removals persist before display.
- `/trades`: explicitly provisional matcher trades, never manufactured chain fills.
- `/realtime`: public endpoint/project/channel metadata. Each created command document contains ordered `events`; consumers must resnapshot on gaps, reconnects or malformed data, not trust arbitrary payloads as balances/fills.
- `/admission/ready`: checks actual pinned code/module identity, chain, cap, entry readiness and paired canonical source.
- `POST /orders`, `/cancel`: signed envelopes with the same canonical escrow/nonce gate as the HTTP backend. Cancellation acknowledgment is offchain only; on-chain cancellation is still required.
- `/ready`: **503**, because automatic settlement submission is not connected. No server signer, activation endpoint or collateral-credit API exists.

Browser requests are restricted to the exact Vercel origin. Bodies, RPC timeouts, response pages and retained history are bounded. Provider execution quotas/WAF controls are still needed for public abuse protection; cold workers do not share an in-memory rate limiter.

## Checks and limits

`npm run test:appwrite` covers cold starts, real EIP-712 verification, concurrent writers, lost acknowledgments, integrity/identity refusal, REST pagination and endpoint/write bounds using isolated fixtures. `npm run test:phase4:evm` separately tests real local EVM escrow and HTTP admission through close/withdraw; neither establishes public Fuji fills.

Appwrite deployment, frontend connection, on-chain activation and a funded public lifecycle are separate gates. Keep wallets disabled while the reported MetaMask warning remains unresolved. Never disable that warning or treat a new domain as a security fix.
