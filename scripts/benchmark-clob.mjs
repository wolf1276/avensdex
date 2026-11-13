// Synthetic, local-only benchmark fixtures. No RPC, wallet signing, transfers or product liquidity.
import { performance } from 'node:perf_hooks';
import { cpus, totalmem, platform, release } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { Matcher } from '../packages/clob/engine.ts';
import { JournaledMatcher } from '../packages/clob/journal.ts';
import { startMarketData } from '../services/clob/market-data.ts';
const A = `0x${'1'.repeat(40)}`, B = `0x${'2'.repeat(40)}`;
const binding = { chainId: 43113, marketId: 1, settlementContract: null };
const order = (id, changes = {}) => ({ id, trader: A, nonce: '1', marketId: 1, side: 'sell', kind: 'limit', size6: '1000000',
  limitPrice18: '30000000000000000000', expiry: 2000, reduceOnly: false, postOnly: false, ioc: false, ...changes });
function stats(samples, wallMs) {
  const sorted = [...samples].sort((a, b) => a - b), q = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: samples.length, p50Ms: q(.5), p95Ms: q(.95), p99Ms: q(.99), maxMs: sorted.at(-1),
    wallMs, commandsPerSecond: samples.length * 1000 / wallMs };
}
function timed(apply, command, samples) { const start = performance.now(); apply(command); samples.push(performance.now() - start); }
function paired(factory, rounds, count) {
  const samples = [], start = performance.now();
  for (let r = 0; r < rounds; r++) {
    const engine = factory(r);
    for (let i = 1; i <= count; i++) {
      timed(c => engine.apply(c), { type: 'submit', at: 1000, order: order(`s${i}`, { nonce: String(i) }) }, samples);
      timed(c => engine.apply(c), { type: 'submit', at: 1000, order: order(`b${i}`, { nonce: String(i), trader: B, side: 'buy' }) }, samples);
    }
  }
  return stats(samples, performance.now() - start);
}
paired(r => new Matcher(`warmup_${r}`), 1, 64);
const core = paired(r => new Matcher(`paired_${r}`), 8, 128);
const sweepSamples = [], sweepWall = performance.now();
for (let r = 0; r < 10; r++) {
  const engine = new Matcher(`sweep_${r}`);
  for (let i = 1; i <= 256; i++) engine.apply({ type: 'submit', at: 1000, order: order(`s${i}`, { nonce: String(i),
    limitPrice18: (30n * 10n ** 18n + BigInt(i % 4) * 10n ** 15n).toString() }) });
  timed(c => engine.apply(c), { type: 'submit', at: 1000, order: order('sweep', { trader: B, side: 'buy', kind: 'market',
    size6: '256000000', limitPrice18: '31000000000000000000' }) }, sweepSamples);
}
const sweep = stats(sweepSamples, performance.now() - sweepWall);
sweep.sweepsPerSecondIncludingPopulation = sweep.commandsPerSecond; delete sweep.commandsPerSecond;
// Sweep throughput is fills/time in the swept command only; population time is reported separately.
sweep.fillsPerSweep = 256; sweep.fillsPerSecondInSweep = 2560 * 1000 / sweepSamples.reduce((a, b) => a + b, 0);
const directory = mkdtempSync(join(tmpdir(), 'avensdex-benchmark-'));
let journal, service, socket;
try {
  journal = JournaledMatcher.open(join(directory, 'durable'), binding, true);
  const durable = paired(() => journal, 1, 64); journal.close();
  journal = JournaledMatcher.open(join(directory, 'delivery'), binding, true);
  service = await startMarketData(journal, 0, () => 1000);
  socket = new WebSocket(`ws://127.0.0.1:${service.port}/stream`);
  let seq = -1; const waiters = new Map();
  socket.on('error', () => {});
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString()); seq = event.seq;
    for (const [target, done] of waiters) if (target <= seq) { waiters.delete(target); done(); }
  });
  const wait = target => seq >= target ? Promise.resolve() : new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { waiters.delete(target); reject(Error('delivery timeout')); }, 5000);
    waiters.set(target, () => { clearTimeout(timeout); resolve(); });
  });
  await wait(0);
  const delivered = [], wall = performance.now();
  for (let i = 1; i <= 50; i++) {
    for (const command of [{ type: 'submit', at: 1000, order: order(`a${i}`, { nonce: String(i) }) },
      { type: 'cancel', at: 1000, id: `a${i}`, trader: A }]) {
      const started = performance.now(), result = service.apply(command); await wait(result.seq); delivered.push(performance.now() - started);
    }
  }
  const delivery = stats(delivered, performance.now() - wall);
  const paths = ['packages/clob/engine.ts', 'packages/clob/journal.ts', 'services/clob/market-data.ts', 'scripts/benchmark-clob.mjs'];
  const sources = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex')]));
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0, sources,
    environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    corePaired: core, sweep256: sweep, durablePaired: durable, durableLoopbackWebSocket: delivery,
    limitations: ['Synthetic local fixtures only; no public Fuji execution or liquidity', 'No signatures, HTTP admission, RPC or chain-finality measurement',
      'Core paired workload has at most one resting maker; state-copy/history overhead included', 'Sweep distribution has only ten samples; no statistical confidence claim',
      'Durable fsync uses this machine temporary directory/filesystem; no power-loss/remote-disk guarantee', 'Loopback delivery includes journal fsync and waits for final BBO frame; one subscriber, not WAN/fanout load'] }, null, 2));
} finally {
  socket?.terminate(); if (service) await service.close(); if (journal?.writable) journal.close();
  // Only this newly allocated synthetic benchmark directory, never an operator journal.
  rmSync(directory, { recursive: true, force: true });
}
