const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

process.env.TEST_ALWAYS_OPEN = '1';
process.env.SQ_TOKEN = 'test-token';
process.env.SQ_LOCATION_1 = 'loc-1';
process.env.SQ_LOCATION_2 = 'loc-2';
process.env.ROUTE_1 = 'print1';
process.env.ROUTE_2 = '/print2';
process.env.SQ_SIGNATURE = 'test-signature-key';
process.env.SQ_URL = 'https://howards-cloudprnt.onrender.com/sq-webhook';
process.env.SQ_ENVIRONMENT = 'sandbox';
process.env.CLIENT_ID = 'test';
process.env.CLIENT_SECRET = 'test';
process.env.REFRESH_TOKEN = 'test';

const { app, parseSquareOrder } = require('../server.cjs');

const server = app.listen(0);
const port = server.address().port;

function sign(body) {
  return crypto
    .createHmac('sha256', process.env.SQ_SIGNATURE)
    .update(Buffer.concat([Buffer.from(process.env.SQ_URL, 'utf8'), Buffer.from(body, 'utf8')]))
    .digest('base64');
}

function request(method, path, body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, port, path, headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function event(id, orderId = 'order-1') {
  return JSON.stringify({ type: 'order.updated', event_id: id, data: { object: { order_updated: { order_id: orderId, version: 1 } } } });
}

function order(locationId, id = 'order-1', version = 1) {
  return {
    order: {
      id,
      version,
      state: 'OPEN',
      location_id: locationId,
      ticket_name: 'A12',
      source: { name: 'Square Online' },
      fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'Pat Customer' }, pickup_at: '2026-07-19T12:00:00Z', note: 'Please label bags' } }],
      line_items: [
        { quantity: '2', name: 'Burger', modifiers: [{ name: 'No onion' }, { name: 'Add bacon' }] },
        { quantity: '1', name: 'Fries', modifiers: [] }
      ],
      note: 'Customer note'
    }
  };
}

async function postSquare(body, orderJson, signature = sign(body)) {
  process.env.SQ_TEST_ORDER_JSON = JSON.stringify(orderJson);
  return request('POST', '/sq-webhook', body, { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature });
}

async function poll(route) {
  const res = await request('POST', `/${route}`, '{}', { 'content-type': 'application/json' });
  return { status: res.status, json: JSON.parse(res.body.toString('utf8')) };
}

(async () => {
  try {
    let res = await request('GET', '/');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.toString(), 'OK');

    res = await request('GET', '/sq-webhook');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.toString(), 'Square webhook route is live');

    const invalidBody = event('bad-sig', 'bad-order');
    res = await postSquare(invalidBody, order('loc-1', 'bad-order'), 'bad-signature');
    assert.strictEqual(res.status, 403);

    const parsed = parseSquareOrder(order('loc-1').order);
    assert.strictEqual(parsed.totalItems, '3');
    assert.deepStrictEqual(parsed.items[0].modifiers, ['No onion', 'Add bacon']);

    const body1 = event('evt-1', 'order-1');
    res = await postSquare(body1, order('loc-1', 'order-1'));
    assert.strictEqual(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let p1 = await poll('print1');
    let p2 = await poll('print2');
    assert.strictEqual(p1.json.jobReady, true);
    assert.strictEqual(p2.json.jobReady, false);
    const route2Download = await request('GET', `/print2?token=${encodeURIComponent(p1.json.jobToken)}`);
    assert.strictEqual(route2Download.status, 204);
    res = await request('GET', `/print1?token=${encodeURIComponent(p1.json.jobToken)}`);
    assert.strictEqual(res.status, 200);

    const body2 = event('evt-2', 'order-2');
    res = await postSquare(body2, order('loc-2', 'order-2'));
    assert.strictEqual(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    p1 = await poll('print1');
    p2 = await poll('print2');
    assert.strictEqual(p1.json.jobReady, false);
    assert.strictEqual(p2.json.jobReady, true);
    await request('GET', `/print2?token=${encodeURIComponent(p2.json.jobToken)}`);

    const body3 = event('evt-3', 'order-3');
    res = await postSquare(body3, order('unknown', 'order-3'));
    assert.strictEqual(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    p1 = await poll('print1');
    p2 = await poll('print2');
    assert.strictEqual(p1.json.jobReady, false);
    assert.strictEqual(p2.json.jobReady, false);

    const dup = event('evt-dup', 'order-dup');
    res = await postSquare(dup, order('loc-1', 'order-dup'));
    assert.strictEqual(res.status, 200);
    res = await postSquare(dup, order('loc-1', 'order-dup'));
    assert.strictEqual(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    p1 = await poll('print1');
    assert.strictEqual(p1.json.jobReady, true);
    await request('GET', `/print1?token=${encodeURIComponent(p1.json.jobToken)}`);
    p1 = await poll('print1');
    assert.strictEqual(p1.json.jobReady, false);

    console.log('Square webhook local verification passed');
  } finally {
    server.close();
    process.exit(0);
  }
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
