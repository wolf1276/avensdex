# Local adaptive funding demonstration

```sh
npm ci --ignore-scripts
npm run demo:adaptive
# Shorter viewing window:
npm run demo:adaptive -- --hold=180
```

Requires the repository's Node/Foundry tools. The command spawns its **own fresh loopback Anvil** with generated fixture wallets and test tokens. It never reads an operator wallet, sends a public transaction, changes Vercel/Appwrite configuration or resets an existing node/journal.

The runner executes the actual vault, adaptive oracle, signed HTTP admission and settlement contracts. It verifies source premium → adaptive rate, owner deposits, canonical escrow, signed partial fill, funding paid between isolated margins, signed cancellation, observation expiry, authenticated refresh without backfilling the gap, and a second conserved funding payment. During the viewing window it prints:

- `LOCAL_ANVIL_FIXTURE_NOT_PUBLIC_FUJI`, generated contract addresses and read-only local snapshot/funding URLs;
- the actual adaptive rate (`220` ppm/hour in this controlled scenario, **2.20 bps/hour**, not APR);
- actual long/short margin balances after funding;
- the viewing duration and controlled VM time.

**VM time is intentionally frozen while viewing.** Prices are controlled local `ControllerSource` fixtures, not qualified independent public feeds. Chain ID 43113 on loopback is not the public Fuji chain. This is a contract/backend demonstration, not a complete browser-wallet demonstration or proof of live liquidity/profitability.

After the viewing window the runner continues: expired-rate owner close, zero open positions/reservations, owner withdrawals, custody/fee reconciliation and journal restart. The completed scenario checks **32 local transaction receipts**. Do not stop early and claim final withdrawal/restart checks passed; let the success message appear.

The public deployment remains separate. The current public settlement is bound immutably to the manual feed oracle; deploying an adaptive oracle does not retrofit that binding. Public adaptive use requires qualified index/mark adapters, bounded operator publication/refresh transport, a separately verified settlement/vault release and activation/lifecycle evidence. Never bypass a wallet security warning for this demonstration.
