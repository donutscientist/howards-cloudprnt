const assert = require('assert');
const http = require('http');

process.env.ROUTE_1 = '/print1/';
process.env.ROUTE_2 = 'print2';
process.env.CLEAR_KEY = 'email-route-test-key';
process.env.CLIENT_ID = 'test';
process.env.CLIENT_SECRET = 'test';
process.env.REFRESH_TOKEN = 'test';

const { app, processEmailOrder, getRouteQueue, normalizePrintRoute } = require('../server.cjs');
const server = app.listen(0);
const port = server.address().port;

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  try {
    const parsedDoorDashOrder = {
      customer: 'Test Customer', orderType: 'DoorDash Delivery', phone: 'Order #DD123',
      totalItems: '1', items: [{ item: '1x Test Item', modifiers: ['Test modifier'] }],
      estimate: '', note: 'Test note'
    };
    const { printJobId, waitingOrderId, jobBuf } = processEmailOrder(parsedDoorDashOrder, 'DD', 'gmail-message-1');
    const route = normalizePrintRoute(process.env.ROUTE_1);
    const queue = getRouteQueue(route);

    assert.strictEqual(queue, getRouteQueue(normalizePrintRoute(process.env.ROUTE_1)));
    assert.notStrictEqual(waitingOrderId, printJobId, 'the UI removal ID is metadata, not the CloudPRNT token');
    assert.deepStrictEqual(queue.pending, [printJobId]);
    assert.strictEqual(queue.activeJobs.get(printJobId).buf, jobBuf);
    assert.strictEqual(queue.activeJobs.get(printJobId).metadata.removalId, waitingOrderId);

    const waitingBefore = await request('GET', `/v?key=${process.env.CLEAR_KEY}`);
    assert.strictEqual(waitingBefore.status, 200);
    assert.match(waitingBefore.body.toString(), /DoorDash/);

    const poll = await request('POST', '/print1');
    const pollBody = JSON.parse(poll.body.toString());
    assert.strictEqual(pollBody.jobReady, true);
    assert.strictEqual(pollBody.jobToken, printJobId);

    const download = await request('GET', `/print1?token=${encodeURIComponent(printJobId)}`);
    assert.strictEqual(download.status, 200);
    assert.strictEqual(download.headers['content-type'], 'application/vnd.star.starprnt');
    assert.deepStrictEqual(download.body, jobBuf);
    assert.strictEqual(queue.pending.includes(printJobId), false);
    assert.strictEqual(queue.activeJobs.has(printJobId), false);

    const waitingAfter = await request('GET', `/v?key=${process.env.CLEAR_KEY}`);
    assert.doesNotMatch(waitingAfter.body.toString(), /DoorDash/,
      'Waiting Orders is derived from pending jobs; metadata alone cannot create a row');
    console.log('Email DoorDash print route verification passed');
  } finally {
    server.close();
  }
  process.exit(0);
})().catch((error) => {
  console.error(error);
  server.close();
  process.exit(1);
});
