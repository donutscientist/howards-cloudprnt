const assert = require('assert');
const crypto = require('crypto');
const http = require('http');

process.env.EMAIL_POLL_MS = '1000';
process.env.SQ_TOKEN = 'test-token';
process.env.SQ_LOCATION_1 = 'loc-1';
process.env.SQ_LOCATION_2 = 'loc-2';
process.env.ROUTE_1 = 'print1';
process.env.ROUTE_2 = '/print2';
process.env.SQ_SIGNATURE = 'test-signature-key';
process.env.SQ_URL = 'https://howards-cloudprnt.onrender.com/sq-webhook';
process.env.SQ_ENVIRONMENT = 'sandbox';
process.env.CLEAR_KEY = 'clear-test-key';
process.env.BUSINESS_TZ = 'America/Chicago';
process.env.CLIENT_ID = 'test';
process.env.CLIENT_SECRET = 'test';
process.env.REFRESH_TOKEN = 'test';

const { app, parseSquareOrder, buildReceipt, enqueueReceipt, printerPollState, checkPollingStatus, parseGrubHub, EMAIL_POLL_MS, PRINTER_POLL_SECONDS } = require('../server.cjs');

const server = app.listen(0);
const port = server.address().port;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sign(body) {
  return crypto.createHmac('sha256', process.env.SQ_SIGNATURE)
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

function event(id, orderId = 'order-1', type = 'order.created') {
  const key = type === 'order.created' ? 'order_created' : 'order_updated';
  return JSON.stringify({ type, event_id: id, data: { object: { [key]: { order_id: orderId, version: 1 } } } });
}

function order(locationId, id = 'order-1', overrides = {}) {
  return { order: {
    id, version: 1, state: 'OPEN', location_id: locationId, ticket_name: 'A12',
    source: { name: 'Square Online' },
    fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'Pat Customer' }, pickup_at: '2026-07-19T12:00:00Z', note: 'Please label bags' } }],
    line_items: [{ quantity: '2', name: 'Burger', modifiers: [{ name: 'Glazed' }, { name: 'Vanilla Iced', quantity: '2' }, { name: 'Vanilla Iced' }] }],
    note: 'Customer note',
    ...overrides
  } };
}

async function postSquare(body, orderJson, signature = sign(body)) {
  process.env.SQ_TEST_ORDER_JSON = JSON.stringify(orderJson);
  return request('POST', '/sq-webhook', body, { 'content-type': 'application/json', 'x-square-hmacsha256-signature': signature });
}
async function poll(route) {
  const res = await request('POST', `/${route}`, '{}', { 'content-type': 'application/json' });
  return { status: res.status, json: JSON.parse(res.body.toString('utf8')) };
}
async function clear(reset = false) {
  return request('GET', `/clear?key=${process.env.CLEAR_KEY}${reset ? '&resetSquare=1' : ''}`);
}
async function drain(route) {
  const p = await poll(route);
  if (p.json.jobReady) await request('GET', `/${route}?token=${encodeURIComponent(p.json.jobToken)}`);
  return p;
}
async function assertNoJobs() {
  const p1 = await poll('print1');
  const p2 = await poll('print2');
  assert.strictEqual(p1.json.jobReady, false);
  assert.strictEqual(p2.json.jobReady, false);
  assert.strictEqual(p1.json.nextPollInterval, PRINTER_POLL_SECONDS);
  assert.strictEqual(p2.json.nextPollInterval, PRINTER_POLL_SECONDS);
}

(async () => {
  try {
    assert.strictEqual((await request('GET', '/')).body.toString(), 'OK');
    assert.strictEqual(EMAIL_POLL_MS, 1000);
    assert.strictEqual(PRINTER_POLL_SECONDS, 5);
    const serverSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.cjs'), 'utf8');
    assert.doesNotMatch(serverSource, /function\s+isBusinessHours|isBusinessHours\s*\(|openTime|closeTime|TEST_ALWAYS_OPEN|43200|stopEmailPolling|businessHours/);
    assert.match(serverSource, /startEmailPolling\(\);/);
    assert.strictEqual((await request('GET', '/sq-webhook')).body.toString(), 'Square webhook route is live');
    assert.strictEqual((await postSquare(event('bad', 'bad'), order('loc-1', 'bad'), 'bad')).status, 403);

    let healthBeforeEmail = JSON.parse((await request('GET', '/health')).body.toString());
    await sleep(1100);
    let healthAfterEmail = JSON.parse((await request('GET', '/health')).body.toString());
    assert.ok(healthAfterEmail.lastEmailPollAt > healthBeforeEmail.lastEmailPollAt);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(healthAfterEmail, 'businessHours'), false);

    let parsed = parseSquareOrder(order('loc-1').order);
    assert.deepStrictEqual(parsed.items[0].modifiers, ['1x Glazed', '3x Vanilla Iced']);
    assert.strictEqual(parsed.orderType, 'Online Order Pickup');
    assert.ok(buildReceipt('c', 't', 'p', '1', [{ item: '1x Item', modifiers: ['1x Modifier Name'] }]).includes(Buffer.from([0x1B, 0x45, 0x01])));

    parsed = parseSquareOrder(order('loc-1', 's1', { source: { name: 'Uber Eats' }, fulfillments: [{ type: 'DELIVERY', delivery_details: {} }] }).order);
    assert.strictEqual(parsed.orderType, 'UberEats Delivery');
    parsed = parseSquareOrder(order('loc-1', 's2', { source: { name: 'DoorDash' } }).order);
    assert.strictEqual(parsed.orderType, 'DoorDash Pickup');
    parsed = parseSquareOrder(order('loc-1', 's3', { source: { name: 'Grubhub' }, fulfillments: [{ type: 'DELIVERY', delivery_details: {} }] }).order);
    assert.strictEqual(parsed.orderType, 'GrubHub Delivery');
    const ghParsed = parseGrubHub('<html><body><div>Deliver to:</div><div>Pat Customer</div><table><tr><td>2</td><td>x</td><td>Burger</td></tr><tr><td colspan=3><ul><li>Cheese</li><li>Cheese</li></ul></td></tr></table></body></html>');
    assert.strictEqual(ghParsed.customer, 'Pat Customer');
    assert.strictEqual(ghParsed.orderType, 'GrubHub Delivery');
    assert.deepStrictEqual(ghParsed.items, [{ item: '2x Burger', modifiers: ['2x Cheese'] }]);

    let body = event('evt-same-a', 'order-same');
    const routeLogs = [];
    const routeOriginalLog = console.log;
    console.log = (...args) => { routeLogs.push(args.join(' ')); routeOriginalLog(...args); };
    await Promise.all([postSquare(body, order('loc-1', 'order-same')), postSquare(body, order('loc-1', 'order-same'))]);
    await sleep(50);
    let p = await poll('print1');
    assert.strictEqual(p.json.jobReady, true);
    assert.strictEqual(p.json.nextPollInterval, PRINTER_POLL_SECONDS);
    const sameToken = p.json.jobToken;
    assert.match(routeLogs.join('\n'), new RegExp(`SQUARE ORDER QUEUED: order-same -> #1`));
    assert.match(routeLogs.join('\n'), new RegExp(`JOB READY: #1 -> ${sameToken}`));
    assert.strictEqual((await poll('print1')).json.jobToken, sameToken);
    assert.strictEqual(routeLogs.filter((line) => line.includes(`JOB READY: #1 -> ${sameToken}`)).length, 2);
    assert.strictEqual((await poll('print2')).json.jobReady, false);
    await request('GET', `/print1?token=${sameToken}`);
    assert.match(routeLogs.join('\n'), new RegExp(`JOB DOWNLOADED: #1 -> ${sameToken}`));
    console.log = routeOriginalLog;
    await assertNoJobs();

    await postSquare(event('evt-created', 'order-flow', 'order.created'), order('loc-1', 'order-flow'));
    await sleep(50);
    const drainedPrint1 = await drain('print1');
    assert.strictEqual(drainedPrint1.json.jobReady, true);
    assert.strictEqual(drainedPrint1.json.nextPollInterval, PRINTER_POLL_SECONDS);
    await postSquare(event('evt-updated-ignored', 'order-updated-only', 'order.updated'), order('loc-1', 'order-updated-only'));
    await sleep(50);
    await assertNoJobs();
    await postSquare(event('evt-retry', 'order-flow', 'order.created'), order('loc-1', 'order-flow'));
    await sleep(50);
    await assertNoJobs();

    await Promise.all([
      postSquare(event('evt-diff-1', 'order-diff'), order('loc-2', 'order-diff')),
      postSquare(event('evt-diff-2', 'order-diff'), order('loc-2', 'order-diff'))
    ]);
    await sleep(50);
    assert.strictEqual((await poll('print1')).json.jobReady, false);
    const drainedPrint2 = await drain('print2');
    assert.strictEqual(drainedPrint2.json.jobReady, true);
    assert.strictEqual(drainedPrint2.json.nextPollInterval, PRINTER_POLL_SECONDS);

    await postSquare(event('evt-clear', 'order-clear'), order('loc-1', 'order-clear'));
    await sleep(50);
    assert.strictEqual((await request('GET', '/clear')).status, 401);
    let health = JSON.parse((await request('GET', '/health')).body.toString());
    assert.ok(health.queues.print1.pending >= 1);
    let cleared = await clear(false);
    assert.strictEqual(cleared.status, 200);
    assert.match(cleared.body.toString(), /Square deduplication retained/);
    await assertNoJobs();
    await postSquare(event('evt-clear-retry', 'order-clear'), order('loc-1', 'order-clear'));
    await sleep(50);
    await assertNoJobs();
    cleared = await clear(true);
    assert.strictEqual(cleared.body.toString(), 'Queues and Square deduplication cleared.');
    await postSquare(event('evt-after-reset', 'order-clear'), order('loc-1', 'order-clear'));
    await sleep(50);
    assert.strictEqual((await drain('print1')).json.jobReady, true);

    const loc2Logs = [];
    const loc2OriginalLog = console.log;
    console.log = (...args) => { loc2Logs.push(args.join(' ')); loc2OriginalLog(...args); };
    assert.strictEqual((await postSquare(event('evt-loc2', 'order-loc2'), order('loc-2', 'order-loc2'))).status, 200);
    await sleep(50);
    assert.strictEqual((await poll('print1')).json.jobReady, false);
    const loc2Poll = await poll('print2');
    assert.strictEqual(loc2Poll.json.jobReady, true);
    assert.match(loc2Logs.join('\n'), /SQUARE ORDER QUEUED: order-loc2 -> #2/);
    assert.match(loc2Logs.join('\n'), new RegExp(`JOB READY: #2 -> ${loc2Poll.json.jobToken}`));
    await request('GET', `/print2?token=${encodeURIComponent(loc2Poll.json.jobToken)}`);
    assert.match(loc2Logs.join('\n'), new RegExp(`JOB DOWNLOADED: #2 -> ${loc2Poll.json.jobToken}`));
    console.log = loc2OriginalLog;

    // Square DRAFT orders are printable, visible on /v immediately, and removed after download.
    assert.strictEqual((await postSquare(event('evt-draft', 'order-draft'), order('loc-1', 'order-draft', { state: 'DRAFT' }))).status, 200);
    await sleep(50);
    const draftView = await request('GET', `/v?key=${process.env.CLEAR_KEY}`);
    assert.strictEqual(draftView.status, 200);
    assert.match(draftView.body.toString(), /<th>Shop<\/th><th>Date<\/th><th>Time<\/th><th>Source<\/th><th>Type<\/th><th>Action<\/th>/);
    assert.doesNotMatch(draftView.body.toString(), /<th>Sequence<\/th>/);
    assert.match(draftView.body.toString(), />#1</);
    assert.strictEqual((await drain('print1')).json.jobReady, true);
    const draftGoneView = await request('GET', `/v?key=${process.env.CLEAR_KEY}`);
    assert.strictEqual(draftGoneView.status, 200);
    assert.doesNotMatch(draftGoneView.body.toString(), />Square Online</);
    assert.match(draftGoneView.body.toString(), /No waiting orders/);


    // Failed retrieval is not permanently marked queued.
    delete process.env.SQ_TEST_ORDER_JSON;
    process.env.SQ_TEST_ORDER_JSON = '{bad json';
    await request('POST', '/sq-webhook', event('evt-fail', 'order-fail'), { 'content-type': 'application/json', 'x-square-hmacsha256-signature': sign(event('evt-fail', 'order-fail')) });
    await sleep(50);
    await assertNoJobs();
    await postSquare(event('evt-fail-retry', 'order-fail'), order('loc-1', 'order-fail'));
    await sleep(50);
    assert.strictEqual((await drain('print1')).json.jobReady, true);

    const defaultToken = enqueueReceipt(buildReceipt('c', 'DoorDash Pickup', '', '1', [{ item: '1x Default', modifiers: [] }]), '', { source: 'DoorDash', orderType: 'Pickup' });
    const defaultPoll = await request('POST', '/starcloudprint', '{}', { 'content-type': 'application/json' });
    const defaultJson = JSON.parse(defaultPoll.body.toString('utf8'));
    assert.strictEqual(defaultJson.jobReady, true);
    assert.strictEqual(defaultJson.jobToken, defaultToken);
    assert.strictEqual(defaultJson.nextPollInterval, PRINTER_POLL_SECONDS);
    await request('GET', `/starcloudprint?token=${encodeURIComponent(defaultToken)}`);

    // Inspection stays on /v, fetches the latest Square order, redacts sensitive data, and leaves the job untouched.
    const inspectionOrder = order('loc-1', 'square-order-secret-1234', {
      version: 7,
      created_at: '2026-07-21T14:00:00Z',
      updated_at: '2026-07-21T14:05:00Z',
      reference_id: 'customer-order-42',
      application_details: { application_id: 'application-secret-9876', application_name: 'DoorDash Integration', access_token: 'never-display-token' },
      fulfillments: [{ type: 'PICKUP', state: 'PROPOSED', pickup_details: { recipient: { display_name: 'Pat Customer', phone_number: '+1 312 555 6789', email_address: 'private@example.com', address: { address_line_1: '123 Secret St' } }, pickup_at: '2026-07-21T15:00:00Z', note: 'Pickup counter' } }],
      line_items: [{ uid: 'line-uid-secret-1234', catalog_object_id: 'catalog-secret-1234', quantity: '2', name: 'Burger', variation_name: 'Large', note: 'No onions', modifiers: [{ uid: 'modifier-uid-secret-5678', catalog_object_id: 'modifier-catalog-secret-5678', name: 'Cheese', quantity: '3' }] }],
      tenders: [{ card_details: { card: { cardholder_name: 'Private' } } }]
    });
    process.env.SQ_TEST_ORDER_JSON = JSON.stringify(inspectionOrder);
    enqueueReceipt(buildReceipt('Pat Customer', 'DoorDash Pickup', 'Order #42', '2', []), 'print1', { routeLabel: '#1', source: 'DoorDash', orderType: 'Pickup', squareOrderId: inspectionOrder.order.id });
    const inspectionList = (await request('GET', `/v?key=${process.env.CLEAR_KEY}`)).body.toString();
    const inspectMatch = inspectionList.match(/href="\/v\?key=clear-test-key&amp;inspect=([a-f0-9]+)">Inspect<\/a>/);
    assert.ok(inspectMatch);
    assert.doesNotMatch(inspectionList, /square-order-secret-1234/);
    const beforeInspect = await poll('print1');
    const inspected = await request('GET', `/v?key=${process.env.CLEAR_KEY}&inspect=${inspectMatch[1]}`);
    const inspectedHtml = inspected.body.toString();
    assert.strictEqual(inspected.status, 200);
    assert.match(inspectedHtml, /Order Inspection/);
    assert.match(inspectedHtml, /Square order version<\/dt><dd>7/);
    assert.match(inspectedHtml, /Modifier name<\/dt><dd>Cheese/);
    assert.match(inspectedHtml, /Quantity<\/dt><dd>3/);
    assert.match(inspectedHtml, /Parsed receipt preview/);
    assert.match(inspectedHtml, /••••6789/);
    assert.doesNotMatch(inspectedHtml, /square-order-secret-1234|line-uid-secret-1234|modifier-uid-secret-5678|never-display-token|private@example\.com|123 Secret St|cardholder_name/);
    const afterInspect = await poll('print1');
    assert.strictEqual(afterInspect.json.jobToken, beforeInspect.json.jobToken);
    await request('GET', `/print1?token=${encodeURIComponent(afterInspect.json.jobToken)}`);

    // Queue view is protected and chronological, uses only #1/#2, and remove only removes selected item.
    assert.strictEqual((await request('GET', '/v?key=bad')).status, 401);
    enqueueReceipt(buildReceipt('c', 'DoorDash Pickup', '', '1', [{ item: '1x A', modifiers: [] }]), 'print1', { routeLabel: '#1', source: 'DoorDash', orderType: 'Pickup', createdAt: '2026-07-21T10:00:00Z' });
    enqueueReceipt(buildReceipt('c', 'GrubHub Delivery', '', '1', [{ item: '1x B', modifiers: [] }]), 'print2', { routeLabel: '#2', source: 'GrubHub', orderType: 'Delivery', createdAt: '2026-07-21T10:01:00Z' });
    const view = await request('GET', `/v?key=${process.env.CLEAR_KEY}`);
    assert.strictEqual(view.status, 200);
    const html = view.body.toString();
    assert.match(html, /<th>Shop<\/th><th>Date<\/th><th>Time<\/th><th>Source<\/th><th>Type<\/th><th>Action<\/th>/);
    assert.doesNotMatch(html, /<th>Sequence<\/th>/);
    assert.match(html, /Remove this order from the queue\?/);
    assert.match(html, />Inspect<\/a>/);
    assert.ok(html.indexOf('DoorDash') < html.indexOf('GrubHub'));
    assert.match(html, />#1</);
    assert.match(html, />#2</);
    assert.doesNotMatch(html, /location/i);
    const firstId = html.match(/name="id" value="([a-f0-9]+)"/)[1];
    const removed = await request('POST', '/queue/remove', `key=${encodeURIComponent(process.env.CLEAR_KEY)}&id=${firstId}`, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.strictEqual(removed.status, 302);
    assert.strictEqual((await poll('print1')).json.jobReady, false);
    assert.strictEqual((await drain('print2')).json.jobReady, true);

    // Polling route remains quiet for repeated polls while retaining CloudPRNT commands.
    printerPollState.delete('#1');
    const captured = [];
    const originalLog = console.log;
    console.log = (...args) => { captured.push(args.join(' ')); originalLog(...args); };
    await poll('print1');
    await poll('print1');
    console.log = originalLog;
    assert.strictEqual(captured.filter((line) => line.includes('Printer polling connected: #1')).length, 1);
    assert.match(captured.find((line) => line.includes('Printer polling connected: #1')), /Printer polling connected: #1 - \d{2}\/\d{2}\/\d{4},? \d{1,2}:\d{2}:\d{2} (AM|PM)/);
    assert.strictEqual(captured.filter((line) => line.includes('PRINTER POLLED')).length, 0);
    const receipt = buildReceipt('c', 'UberEats Delivery', '', '1', [{ item: '1x A', modifiers: [] }]);
    assert.ok(receipt.includes(Buffer.from([0x1B, 0x64, 0x03])));
    assert.ok(receipt.includes(Buffer.from([0x1D, 0x56, 0x00])));

    captured.length = 0;
    console.log = (...args) => { captured.push(args.join(' ')); originalLog(...args); };
    const state = printerPollState.get('#1');
    state.lastPollAt = Date.now() - (6 * 60 * 1000);
    checkPollingStatus();
    checkPollingStatus();
    await poll('print1');
    await poll('print1');
    console.log = originalLog;
    assert.strictEqual(captured.filter((line) => line.includes('Printer stops polling 5 minutes ago: #1')).length, 1);
    assert.match(captured.find((line) => line.includes('Printer stops polling 5 minutes ago: #1')), /Printer stops polling 5 minutes ago: #1 - \d{2}\/\d{2}\/\d{4},? \d{1,2}:\d{2}:\d{2} (AM|PM)/);
    assert.strictEqual(captured.filter((line) => line.includes('Printer polling connected: #1')).length, 1);

    console.log('Square webhook local verification passed');
    process.exitCode = 0;
  } finally {
    server.close();
  }
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
