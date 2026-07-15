const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || '3199';
const BASE = `http://127.0.0.1:${PORT}`;

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const res = await request('GET', '/');
      if (res.status === 200) return;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('server did not become ready');
}

(async () => {
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DISABLE_EMAIL_POLLING: '1',
      PORT,
      CLEAR_JOBS_KEY: 'howards-clear-123',
      OPEN_TIME_MINUTES: '0',
      CLOSE_TIME_MINUTES: '1439'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => process.stdout.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));

  try {
    await waitForServer(child);

    let res = await request('GET', '/');
    assert.strictEqual(res.status, 200, 'GET / status');
    assert.strictEqual(res.body.toString(), 'OK', 'GET / body');

    res = await request('GET', '/health');
    assert.strictEqual(res.status, 200, 'GET /health status');
    const health = JSON.parse(res.body.toString());
    assert.strictEqual(health.ok, true, 'health ok');
    assert.strictEqual(typeof health.pendingJobs, 'number', 'health pendingJobs');
    assert.strictEqual(typeof health.activeJobs, 'number', 'health activeJobs');

    res = await request('POST', '/starcloudprnt');
    assert.strictEqual(res.status, 200, 'POST /starcloudprnt empty status');
    let poll = JSON.parse(res.body.toString());
    assert.strictEqual(poll.jobReady, false, 'empty poll jobReady');
    assert.strictEqual(poll.nextPollInterval, 5, 'business-hours poll interval');

    res = await request('POST', '/test/enqueue');
    assert.strictEqual(res.status, 200, 'test enqueue status');
    const { token } = JSON.parse(res.body.toString());
    assert.ok(token, 'test enqueue token');

    res = await request('POST', '/starcloudprnt');
    assert.strictEqual(res.status, 200, 'POST /starcloudprnt queued status');
    poll = JSON.parse(res.body.toString());
    assert.strictEqual(poll.jobReady, true, 'queued poll jobReady');
    assert.strictEqual(poll.jobToken, token, 'queued poll token');
    assert.ok(poll.mediaTypes.includes('application/vnd.star.starprnt'), 'queued poll media type');

    res = await request('GET', `/starcloudprnt?jobToken=${encodeURIComponent(token)}`);
    assert.strictEqual(res.status, 200, 'GET print job status');
    assert.match(res.headers['content-type'], /application\/vnd\.star\.starprnt/, 'GET print job content type');
    assert.ok(res.body.length > 0, 'GET print job body');

    res = await request('DELETE', `/starcloudprnt?jobToken=${encodeURIComponent(token)}`);
    assert.strictEqual(res.status, 200, 'DELETE print job status');

    res = await request('GET', '/clear-jobs?key=wrong');
    assert.strictEqual(res.status, 401, 'clear-jobs wrong key');

    res = await request('GET', '/clear-jobs?key=howards-clear-123');
    assert.strictEqual(res.status, 200, 'clear-jobs correct key');

    console.log('diagnostic tests passed');
  } finally {
    child.kill('SIGTERM');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
