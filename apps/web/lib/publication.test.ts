import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { writeWithWallet, getInjectedProvider, connectWallet } from './evm/wallet';

test('read-only publication refuses wallet writes before accessing any provider', async () => {
  await assert.rejects(writeWithWallet({ expectedOwner: '0x0000000000000000000000000000000000000001',
    address: '0x0000000000000000000000000000000000000002', abi: [], functionName: 'deposit', args: [1n] }), /read-only release/);
});

test('reported wallet warning blocks provider access and connection until reviewed', async () => {
  assert.equal(getInjectedProvider(), null);
  await assert.rejects(connectWallet(), /MetaMask security warning/);
});

test('browser deployment addresses use literal Next public env references', () => {
  const config = readFileSync(new URL('../config/networks.ts', import.meta.url), 'utf8');
  for (const name of ['VAULT', 'SETTLEMENT', 'ORACLE']) assert(config.includes(`process.env.NEXT_PUBLIC_FUJI_${name}`));
  assert(!config.includes('process.env[name]'));
});
