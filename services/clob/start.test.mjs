import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JournaledMatcher } from '../../packages/clob/journal.ts';
const script = fileURLToPath(new URL('./start.ts', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
test('CLI requires external explicit storage and never initializes missing state implicitly', t => {
  const directory = mkdtempSync(join(tmpdir(), 'avensdex-start-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const forbidden = join(root, `.blocked-clob-${randomUUID()}`);
  for (const path of ['', 'relative', forbidden, join(directory, 'missing')]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', script],
      { env: { ...process.env, CLOB_JOURNAL_DIR: path }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, result.stderr); assert(!existsSync(join(path, 'commands.jsonl')));
  }
  assert(!existsSync(forbidden));
});
test('explicit fresh CLI starts a real read-only listener and shuts down without losing the journal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'avensdex-start-test-'));
  const child = spawn(process.execPath, ['--experimental-strip-types', script, '--create'],
    { env: { ...process.env, CLOB_JOURNAL_DIR: directory, CLOB_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; rmSync(directory, { recursive: true, force: true });
  });
  const info = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(Error('CLI startup timeout')), 5000);
    child.stdout.on('data', data => { text += data.toString(); if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])); } });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`CLI exited before readiness: ${code}`)); });
  });
  const health = await (await fetch(`${info.url}/health`)).json();
  assert.equal(health.chainId, 43113); assert.equal(health.orderAdmission, 'unavailable'); assert.equal(health.ready, false);
  child.kill('SIGTERM'); assert.deepEqual(await exited, { code: 0, signal: null });
  assert(!existsSync(join(directory, 'writer.lock')));
  const restored = JournaledMatcher.open(directory, { chainId: 43113, marketId: 1, settlementContract: null });
  assert.equal(restored.snapshot().streamId, health.streamId); restored.close();
});
