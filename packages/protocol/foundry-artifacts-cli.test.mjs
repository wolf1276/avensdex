import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FOUNDRY_ARTIFACT_NAMES, parseFoundryArtifactsArgs, prepareFoundryArtifacts } from './foundry-artifacts-cli.ts';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'avensdex-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = { abi: [{ type: 'constructor', inputs: [] }], bytecode: { object: '0x60AB', linkReferences: {} } };
  const put = (name, value) => {
    const folder = join(dir, `${name}.sol`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${name}.json`), JSON.stringify(value));
  };
  for (const name of FOUNDRY_ARTIFACT_NAMES) put(name, raw);
  return { dir, raw, put };
}

test('artifact CLI accepts exactly one bounded directory argument', () => {
  assert.equal(parseFoundryArtifactsArgs(['out']), 'out');
  for (const args of [[], ['', 'out'], [''], ['x'.repeat(4097)]]) {
    assert.throws(() => parseFoundryArtifactsArgs(args), /INVALID_FOUNDRY_ARTIFACT_ARGS/);
  }
});

test('extracts only ABI and normalized creation code from fixed paths', t => {
  const { dir, raw } = fixture(t);
  const result = prepareFoundryArtifacts(dir);
  assert.deepEqual(Object.keys(result), [...FOUNDRY_ARTIFACT_NAMES]);
  for (const name of FOUNDRY_ARTIFACT_NAMES) assert.deepEqual(result[name], { abi: raw.abi, bytecode: '0x60ab' });
  const cli = fileURLToPath(new URL('./foundry-artifacts-cli.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', cli, dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), result);
});

test('rejects malformed ABI, missing code, unlinked and invalid bytecode', t => {
  const { dir, raw, put } = fixture(t);
  for (const value of [null, {}, { ...raw, abi: [] }, { ...raw, bytecode: {} },
    { ...raw, bytecode: { object: '0x' } }, { ...raw, bytecode: { object: '0x123' } },
    { ...raw, bytecode: { object: '0x__$unlinked$__' } },
    { ...raw, bytecode: { object: '0x6000', linkReferences: { 'Library.sol': {} } } }]) {
    put('AvensVault', value);
    assert.throws(() => prepareFoundryArtifacts(dir), /INVALID_FOUNDRY|UNRESOLVED_FOUNDRY/);
  }
  put('AvensVault', raw);
  rmSync(join(dir, 'AvensSettlement.sol', 'AvensSettlement.json'));
  assert.throws(() => prepareFoundryArtifacts(dir), /FOUNDRY_ARTIFACT_UNAVAILABLE/);
  writeFileSync(join(dir, 'AvensVault.sol', 'AvensVault.json'), '{');
  assert.throws(() => prepareFoundryArtifacts(dir), /INVALID_DEPLOYMENT_PLAN_JSON/);
});
