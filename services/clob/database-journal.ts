// Append-only database journal for stateless workers. No balances, signers or chain submission.
import { Matcher, exact, type Command, type Event } from '../../packages/clob/engine.ts';
import { digest, encode, type Binding } from '../../packages/clob/journal.ts';

export const DATABASE_RECORD_LIMIT = 1024;
export const DATABASE_RECORD_BYTES = 32768;
export interface JournalDocument { id: string; payload: string }
export interface AppendStore {
  list(): Promise<JournalDocument[]>;
  get(id: string): Promise<JournalDocument | null>;
  // Must be an atomic create with a unique ID, NEVER upsert/update or automatic retry.
  create(document: JournalDocument): Promise<void>;
}
export function journalDocumentId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > DATABASE_RECORD_LIMIT) throw Error('DATABASE_JOURNAL_CAPACITY');
  return index.toString().padStart(8, '0');
}
interface Header {
  version: 1; index: 0; previous: string;
  header: { engineVersion: 1; binding: Binding; deploymentId: string; configDigest: string; streamId: string };
  digest: string;
}
export interface DatabaseIdentity { binding: Binding; deploymentId: string; configDigest: string }
function identity(value: DatabaseIdentity) {
  exact(value, ['binding', 'deploymentId', 'configDigest']); exact(value.binding, ['chainId', 'marketId', 'settlementContract']);
  const b = value.binding;
  if (b.chainId !== 43113 || b.marketId !== 1 || typeof b.settlementContract !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(b.settlementContract) || /^0x0+$/.test(b.settlementContract)
    || !/^0x[0-9a-f]{64}$/.test(value.deploymentId) || /^0x0+$/.test(value.deploymentId)
    || !/^[0-9a-f]{64}$/.test(value.configDigest)) throw Error('INVALID_DATABASE_IDENTITY');
  return structuredClone(value);
}
function document(index: number, value: unknown): JournalDocument {
  const payload = encode(value);
  if (Buffer.byteLength(payload) > DATABASE_RECORD_BYTES) throw Error('DATABASE_RECORD_CAPACITY');
  return { id: journalDocumentId(index), payload };
}
function parse(row: JournalDocument): Record<string, unknown> {
  if (!row || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > DATABASE_RECORD_BYTES) throw Error('INVALID_DATABASE_RECORD');
  const value: unknown = JSON.parse(row.payload);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_DATABASE_RECORD');
  return value as Record<string, unknown>;
}
/** Explicit provisioning only. Requests never initialize missing storage or replace existing state. */
export async function initializeDatabaseJournal(store: AppendStore, input: DatabaseIdentity, streamId: string) {
  const checked = identity(input); new Matcher(streamId, 1);
  if ((await store.list()).length !== 0) throw Error('DATABASE_JOURNAL_ALREADY_EXISTS');
  const body = { version: 1, index: 0, previous: '0'.repeat(64), header: { engineVersion: 1, ...checked, streamId } };
  await store.create(document(0, { ...body, digest: digest(body) }));
}
export class DatabaseJournal {
  readonly binding: Binding;
  private readonly store: AppendStore;
  private readonly matcher: Matcher;
  private index: number;
  private previous: string;
  private constructor(store: AppendStore, matcher: Matcher, index: number, previous: string, binding: Binding) {
    this.store = store; this.matcher = matcher; this.index = index; this.previous = previous; this.binding = Object.freeze(binding);
  }
  static async load(store: AppendStore, input: DatabaseIdentity) {
    const checked = identity(input), rows = await store.list();
    if (!rows.length) throw Error('DATABASE_JOURNAL_MISSING_REFUSE_RESET');
    if (rows.length > DATABASE_RECORD_LIMIT + 1) throw Error('DATABASE_JOURNAL_CAPACITY');
    let matcher: Matcher | undefined, previous = '0'.repeat(64);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (row.id !== journalDocumentId(index)) throw Error('DATABASE_JOURNAL_SEQUENCE');
      const record = parse(row);
      exact(record, index === 0 ? ['version', 'index', 'previous', 'header', 'digest']
        : ['version', 'index', 'previous', 'command', 'proof', 'resultHash', 'events', 'digest']);
      const { digest: checksum, ...body } = record;
      if (record.version !== 1 || record.index !== index || record.previous !== previous || checksum !== digest(body)) throw Error('DATABASE_JOURNAL_INTEGRITY');
      if (index === 0) {
        const header = (record as unknown as Header).header;
        exact(header, ['engineVersion', 'binding', 'deploymentId', 'configDigest', 'streamId']);
        if (header.engineVersion !== 1 || encode(identity({ binding: header.binding, deploymentId: header.deploymentId, configDigest: header.configDigest })) !== encode(checked)) throw Error('DATABASE_JOURNAL_IDENTITY');
        matcher = new Matcher(header.streamId, checked.binding.marketId);
      } else {
        const command = record.command as Command;
        // Public adapter permits only signed admission/cancellation and expiry ticks.
        if (!command || !['submit', 'cancel', 'tick'].includes(command.type)) throw Error('DATABASE_COMMAND_REFUSED');
        const plan = matcher!.prepare(command);
        if (record.resultHash !== digest({ state: plan.state, events: plan.events }) || encode(record.events) !== encode(plan.events)) throw Error('DATABASE_JOURNAL_REPLAY');
        matcher!.commit(plan);
      }
      previous = checksum as string;
    }
    return new DatabaseJournal(store, matcher!, rows.length - 1, previous, checked.binding);
  }
  snapshot() { return this.matcher.snapshot(); }
  async apply(command: Command, proof: unknown = null): Promise<Event[]> {
    if (!['submit', 'cancel', 'tick'].includes(command.type)) throw Error('DATABASE_COMMAND_REFUSED');
    const plan = this.matcher.prepare(structuredClone(command)), index = this.index + 1;
    const body = { version: 1, index, previous: this.previous, command: structuredClone(command), proof: structuredClone(proof),
      resultHash: digest({ state: plan.state, events: plan.events }), events: plan.events };
    const checksum = digest(body), row = document(index, { ...body, digest: checksum });
    try { await this.store.create(row); }
    catch {
      // Lost acknowledgments and competing writers are read back, never blindly resubmitted.
      const observed = await this.store.get(row.id);
      if (!observed || observed.payload !== row.payload) throw Error('DATABASE_APPEND_UNKNOWN_OR_CONFLICT');
    }
    // Only the identical persisted command can commit locally; another winner never overwrites it.
    const observed = await this.store.get(row.id);
    if (!observed || observed.payload !== row.payload) throw Error('DATABASE_APPEND_NOT_CONFIRMED');
    const events = this.matcher.commit(plan); this.index = index; this.previous = checksum;
    return events;
  }
}
