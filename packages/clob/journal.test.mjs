import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, existsSync, unlinkSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JournaledMatcher, digest } from './journal.ts';
const binding = { chainId: 43113, marketId: 1, settlementContract: null };
const A = `0x${'1'.repeat(40)}`, B = `0x${'2'.repeat(40)}`;
const order = (id, changes = {}) => ({ id, trader: A, nonce: '1', marketId: 1, side: 'sell', kind: 'limit',
  size6: '10', limitPrice18: '100', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false, ...changes });
function directory(t) { const d = mkdtempSync(join(tmpdir(), 'avensdex-journal-test-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }
test('durable accept, proof retention and restart reproduce exact book/event state', t => {
  const dir = directory(t), j = JournaledMatcher.open(dir, binding, true);
  j.apply({ type: 'submit', at: 1000, order: order('a') }, { testOnly: true });
  j.apply({ type: 'submit', at: 1001, order: order('b', { trader: B, side: 'buy', size6: '4' }) });
  const before = j.snapshot(); const lines = readFileSync(join(dir, 'commands.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); assert.deepEqual(JSON.parse(lines[1]).proof, { testOnly: true });
  j.close(); const restored = JournaledMatcher.open(dir, binding);
  assert.deepEqual(restored.snapshot(), before); restored.close();
});
test('missing journals never silently initialize, and existing state is not reset by create', t => {
  const dir = directory(t); assert.throws(() => JournaledMatcher.open(dir, binding), /MISSING/);
  const j = JournaledMatcher.open(dir, binding, true); j.apply({ type: 'tick', at: 1000 }); const seq = j.snapshot().seq; j.close();
  const restored = JournaledMatcher.open(dir, binding, true); assert.equal(restored.snapshot().seq, seq); restored.close();
});
test('single writer, closed instance and wrong chain/domain cannot accept commands', t => {
  const dir = directory(t), j = JournaledMatcher.open(dir, binding, true);
  assert.throws(() => JournaledMatcher.open(dir, binding), /EEXIST/);
  j.close(); assert.throws(() => j.apply({ type: 'tick', at: 1000 }), /UNAVAILABLE/);
  assert.throws(() => JournaledMatcher.open(dir, { ...binding, marketId: 2 }), /IDENTITY/);
  assert.throws(() => JournaledMatcher.open(dir, { ...binding, chainId: 43114 }), /BINDING/);
  assert.throws(() => JournaledMatcher.open(dir, { ...binding, settlementContract: `0x${'a'.repeat(40)}` }), /IDENTITY/);
});
test('invalid or oversize commands leave book and persisted bytes unchanged', t => {
  const dir = directory(t), j = JournaledMatcher.open(dir, binding, true);
  const before = j.snapshot(), bytes = readFileSync(join(dir, 'commands.jsonl'));
  assert.throws(() => j.apply({ type: 'submit', at: 1000, order: order('bad', { size6: '-1' }) }));
  assert.throws(() => j.apply({ type: 'tick', at: 1000 }, 'x'.repeat(40_000)), /CAPACITY/);
  assert.deepEqual(j.snapshot(), before); assert.deepEqual(readFileSync(join(dir, 'commands.jsonl')), bytes); j.close();
});
test('truncated tail and modified bytes fail closed without repair/reset', t => {
  for (const corruption of ['truncated', 'modified']) {
    const dir = directory(t), j = JournaledMatcher.open(dir, binding, true);
    j.apply({ type: 'submit', at: 1000, order: order('a') }); j.close();
    const path = join(dir, 'commands.jsonl');
    if (corruption === 'truncated') appendFileSync(path, '{"version":1');
    else writeFileSync(path, readFileSync(path, 'utf8').replace('"size6":"10"', '"size6":"11"'));
    const bytes = readFileSync(path); assert.throws(() => JournaledMatcher.open(dir, binding), /INCOMPLETE|HASH/);
    assert.deepEqual(readFileSync(path), bytes);
  }
});
test('even a rehashed record with a changed replay result is rejected', t => {
  const dir = directory(t), j = JournaledMatcher.open(dir, binding, true);
  j.apply({ type: 'tick', at: 1000 }); j.close();
  const path = join(dir, 'commands.jsonl'), lines = readFileSync(path, 'utf8').trim().split('\n');
  const { digest: ignored, ...body } = JSON.parse(lines[1]); body.resultHash = '0'.repeat(64);
  lines[1] = JSON.stringify({ ...body, digest: digest(body) }); writeFileSync(path, lines.join('\n') + '\n');
  assert.throws(() => JournaledMatcher.open(dir, binding), /DIVERGENCE/);
});
test('an uncertain write poisons the writer and retains the operator lock', t => {
  const dir = directory(t), j = JournaledMatcher.open(dir, binding, true), before = j.snapshot();
  closeSync(j.fd); // Test-only descriptor fault injection; no production reset/recovery shortcut.
  assert.throws(() => j.apply({ type: 'tick', at: 1000 }), /UNKNOWN_JOURNAL_WRITE/);
  assert.equal(j.writable, false); assert.deepEqual(j.snapshot(), before);
  assert.throws(() => j.apply({ type: 'tick', at: 1000 }), /UNAVAILABLE/);
  assert(existsSync(join(dir, 'writer.lock')));
});
test('process crash retains the lock; operator-only recovery replays durable accepted state', t => {
  const dir = directory(t), moduleUrl = new URL('./journal.ts', import.meta.url).href;
  const script = `import {JournaledMatcher} from ${JSON.stringify(moduleUrl)};
    const j=JournaledMatcher.open(${JSON.stringify(dir)},${JSON.stringify(binding)},true);
    j.apply({type:'tick',at:1000}); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert(existsSync(join(dir, 'writer.lock')));
  assert.throws(() => JournaledMatcher.open(dir, binding), /EEXIST/);
  // Test-only operator action after confirming the child exited. Runtime never steals locks.
  unlinkSync(join(dir, 'writer.lock'));
  const j = JournaledMatcher.open(dir, binding); assert.equal(j.snapshot().seq, 1); j.close();
});
