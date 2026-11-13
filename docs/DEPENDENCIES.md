# Added CLOB dependencies

The TypeScript matcher, command journal and sequence reducer use platform APIs. No Rust/C++ engine, database or server signing service is introduced. The EVM SDK below is used only for local typed-data hashing/recovery and public fixture-key signing in tests/benchmarks; no live wallet or RPC client is enabled.

- `viem` **2.57.19**, MIT, https://github.com/wevm/viem — EIP-712 descriptors/hashing and EOA signature recovery. Exact artifacts, including its noble/scure/ox/abitype dependencies and nested transport dependencies, are lockfile-pinned; their original package licenses/notices remain applicable. No source is vendored or relicensed. The active server still uses the separately pinned `ws` below.
- `ws` **8.23.0**, MIT, https://github.com/websockets/ws — WebSocket server and local socket tests/benchmark. Exact version and artifact integrity are pinned in `package-lock.json`; package-provided license/copyright notices remain with the installed dependency. No source is vendored or relicensed.
- `@types/ws` **8.18.2**, MIT; `@types/node` **22.20.5**, MIT — development-only typing packages. Their package notices, including dependency `undici-types` notices, remain applicable.
- Existing TypeScript **5.9.3** remains pinned. Node's built-in type stripping executes erasable TS; strict typecheck separately rejects unsupported transformed syntax.

`npm audit --audit-level=high` passed for the current root tree when these packages were added. Audit results are point-in-time dependency checks, not an independent security audit or clearance of the ignored legacy frontend. The source UI's attribution and missing supplied landing license remain tracked separately in the baseline/qualification documents.
