import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOrderBook } from './matcher';

test('depth requests bypass cache, preserve the selected network and forward cancellation', async t => {
  const controller = new AbortController();
  const book = { bids: [], asks: [], timestamp: 1234 };
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, '/api/markets/1/orderbook');
    assert.equal(url.searchParams.get('network'), 'fuji');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal);
    controller.abort();
    assert.equal(init.signal.aborted, true);
    return Response.json(book);
  });
  assert.deepEqual(await fetchOrderBook(1, controller.signal), book);
});

test('depth failures and malformed JSON become unavailable instead of unhandled rejections', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));
  assert.equal(await fetchOrderBook(1), null);
  fetch.mock.mockImplementation(async () => new Response('not-json'));
  assert.equal(await fetchOrderBook(1), null);
  fetch.mock.mockImplementation(async () => { throw new DOMException('Cancelled', 'AbortError'); });
  assert.equal(await fetchOrderBook(1), null);
});
