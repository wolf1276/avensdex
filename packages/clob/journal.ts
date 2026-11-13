import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Matcher, exact, type Command } from './engine.ts';

export interface Binding { chainId: 43113; marketId: number; settlementContract: string | null }
export const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
export function encode(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => v instanceof Map ? { $map: [...v] }
    : typeof v === 'bigint' ? { $bigint: v.toString() } : v);
}
export const digest = (value: unknown) => createHash('sha256').update(encode(value)).digest('hex');
function checkedBinding(b: Binding): Binding {
  exact(b, ['chainId', 'marketId', 'settlementContract']);
  if (b.chainId !== 43113 || !Number.isInteger(b.marketId) || b.marketId < 1 || b.marketId > 8
    || (b.settlementContract !== null && (!/^0x[0-9a-f]{40}$/.test(b.settlementContract) || /^0x0+$/.test(b.settlementContract)))) throw Error('INVALID_JOURNAL_BINDING');
  return Object.freeze({ chainId: 43113, marketId: b.marketId, settlementContract: b.settlementContract });
}
function append(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) throw Error('JOURNAL_WRITE_FAILED'); offset += n;
  }
  fsyncSync(fd);
}
export class JournaledMatcher {
  private readonly fd: number;
  private readonly lock: string;
  readonly binding: Binding;
  private readonly matcher: Matcher;
  private previous: string;
  private index: number;
  private bytes: number;
  private constructor(fd: number, lock: string, binding: Binding, matcher: Matcher, previous: string, index: number, bytes: number) {
    this.fd = fd; this.lock = lock; this.binding = binding; this.matcher = matcher;
    this.previous = previous; this.index = index; this.bytes = bytes;
  }
  private failed = false;
  private closed = false;
  static open(directory: string, input: Binding, create = false): JournaledMatcher {
    const binding = checkedBinding(input);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, 'writer.lock');
    const lockFd = openSync(lock, 'wx', 0o600); // Never steal a crash-held lock.
    let fd: number | undefined;
    try {
      append(lockFd, Buffer.from(`${process.pid}\n`)); closeSync(lockFd);
      const path = join(directory, 'commands.jsonl');
      if (!existsSync(path)) {
        if (!create) throw Error('JOURNAL_MISSING_REFUSE_RESET');
        fd = openSync(path, 'ax', 0o600);
        const body = { version: 1, index: 0, previous: '0'.repeat(64), header: { engineVersion: 1, binding, streamId: randomUUID() } };
        append(fd, Buffer.from(encode({ ...body, digest: digest(body) }) + '\n'));
        const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      if (statSync(path).size > MAX_JOURNAL_BYTES) throw Error('JOURNAL_CAPACITY');
      const text = readFileSync(path, 'utf8');
      if (!text.endsWith('\n') || !text.trim()) throw Error('JOURNAL_INCOMPLETE_REFUSE_TRUNCATION');
      const lines = text.slice(0, -1).split('\n');
      let matcher: Matcher | undefined, previous = '0'.repeat(64), index = 0;
      for (let i = 0; i < lines.length; i++) {
        const record: unknown = JSON.parse(lines[i]!);
        exact(record, i === 0 ? ['version', 'index', 'previous', 'header', 'digest']
          : ['version', 'index', 'previous', 'command', 'proof', 'resultHash', 'digest']);
        const { digest: checksum, ...body } = record;
        if (record.version !== 1 || record.index !== i || record.previous !== previous || checksum !== digest(body)) throw Error('JOURNAL_HASH_OR_SEQUENCE');
        if (i === 0) {
          const header = record.header; exact(header, ['engineVersion', 'binding', 'streamId']);
          if (header.engineVersion !== 1 || encode(checkedBinding(header.binding as Binding)) !== encode(binding)
            || typeof header.streamId !== 'string') throw Error('JOURNAL_IDENTITY_MISMATCH');
          matcher = new Matcher(header.streamId, binding.marketId);
        } else {
          const plan = matcher!.prepare(record.command as Command);
          if (record.resultHash !== digest({ state: plan.state, events: plan.events })) throw Error('JOURNAL_REPLAY_DIVERGENCE');
          matcher!.commit(plan);
        }
        previous = checksum as string; index = i;
      }
      fd ??= openSync(path, 'a', 0o600);
      return new JournaledMatcher(fd, lock, binding, matcher!, previous, index, Buffer.byteLength(text));
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      // Startup errors never reset/truncate a journal. Only remove the lock acquired by this attempt.
      try { closeSync(lockFd); } catch { /* already closed */ }
      unlinkSync(lock); throw error;
    }
  }
  snapshot() { return this.matcher.snapshot(); }
  get writable() { return !this.failed && !this.closed; }
  apply(command: Command, proof: unknown = null) {
    if (!this.writable) throw Error('JOURNAL_UNAVAILABLE_RECONCILE_BEFORE_RETRY');
    const plan = this.matcher.prepare(command);
    const body = { version: 1, index: this.index + 1, previous: this.previous, command, proof,
      resultHash: digest({ state: plan.state, events: plan.events }) };
    const checksum = digest(body), bytes = Buffer.from(encode({ ...body, digest: checksum }) + '\n');
    if (bytes.length > 32_768 || this.bytes + bytes.length > MAX_JOURNAL_BYTES) throw Error('JOURNAL_CAPACITY');
    try { append(this.fd, bytes); }
    catch { this.failed = true; throw Error('UNKNOWN_JOURNAL_WRITE_STOP_AND_RECONCILE'); }
    // No book event/ack escapes until the whole command is durably recorded.
    const events = this.matcher.commit(plan);
    this.previous = checksum; this.index++; this.bytes += bytes.length;
    return events;
  }
  close() {
    if (this.closed) return;
    closeSync(this.fd); this.closed = true;
    if (!this.failed) unlinkSync(this.lock); // Unknown writes retain the lock for explicit operator reconciliation.
  }
}
