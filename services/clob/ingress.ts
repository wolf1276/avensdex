import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdmissionGate } from './admission-gate.ts';

export const MAX_ADMISSION_BYTES = 8192;
function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted); };
    const fail = (message: string) => { cleanup(); req.pause(); reject(Error(message)); };
    const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_ADMISSION_BYTES) { fail('BODY_LIMIT'); return; } chunks.push(chunk); };
    const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('INVALID_JSON')); } };
    const aborted = () => { cleanup(); reject(Error('REQUEST_ABORTED')); };
    req.on('data', data); req.once('end', end); req.once('aborted', aborted); req.once('error', aborted);
  });
}

/** Public data enters only through bounded signed envelopes and the canonical escrow gate. */
export function createIngress(gate: AdmissionGate, submit: (envelope: unknown) => Promise<unknown>) {
  let busy = false, windowStart = Date.now(), count = 0;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const readiness = req.method === 'GET' && req.url === '/admission/ready';
    const expected = req.url === '/orders' ? 'order' : req.url === '/cancel' ? 'cancel' : null;
    if (!readiness && !(req.method === 'POST' && expected)) return false;
    const send = (status: number, value: unknown) => { res.writeHead(status).end(JSON.stringify(value)); };
    if (Date.now() - windowStart >= 10_000) { windowStart = Date.now(); count = 0; }
    if (busy || ++count > 8) { res.setHeader('Retry-After', '10'); send(429, { error: 'ADMISSION_RATE_LIMIT' }); return true; }
    busy = true;
    try {
      if (readiness) {
        const source = await gate.check();
        send(200, { orderAdmission: 'available', ready: false, ...source }); return true;
      }
      res.setHeader('Connection', 'close');
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        send(415, { error: 'JSON_CONTENT_TYPE_REQUIRED' }); return true;
      }
      const length = req.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > MAX_ADMISSION_BYTES)) {
        send(413, { error: 'BODY_LIMIT' }); return true;
      }
      let envelope: unknown;
      try { envelope = await body(req); }
      catch (error) {
        const large = error instanceof Error && error.message === 'BODY_LIMIT';
        res.once('finish', () => req.destroy()); send(large ? 413 : 400, { error: large ? 'BODY_LIMIT' : 'INVALID_REQUEST_BODY' }); return true;
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || (envelope as { type?: unknown }).type !== expected) {
        send(400, { error: 'INVALID_ADMISSION_ENVELOPE' }); return true;
      }
      const source = await gate.check(envelope);
      const result = await submit(envelope); // Signature, expiry, nonce and journal fsync checked again before acknowledgment.
      send(202, { status: expected === 'order' ? 'accepted_provisional' : 'removed_offchain', source,
        onchainCancellationRequired: expected === 'cancel', result, filled: false, settlement: 'unavailable' });
    } catch {
      send(503, { error: 'SIGNED_ADMISSION_REFUSED', retryRequiresStateReconciliation: true });
    } finally { busy = false; }
    return true;
  };
}
