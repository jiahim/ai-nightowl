import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HttpApi, Store, startServer } from '../../src/index.js';

test('HTTP server 同源提供 Web、API、安全头和 body 限制', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nightowl-http-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = await startServer(new HttpApi({ store: new Store(dir) }), {
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await page.text(), /Local Control Plane/);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as any).version, '0.2.0');

  const tooLarge = await fetch(`${base}/blueprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: 'x'.repeat(1_048_576) }),
  });
  assert.equal(tooLarge.status, 413);
});

test('非 loopback 监听在无认证预览版被拒绝', async () => {
  const api = new HttpApi({ store: new Store(join(tmpdir(), 'nightowl-no-remote')) });
  await assert.rejects(
    () => startServer(api, { host: '0.0.0.0', port: 0 }),
    /只允许 loopback/,
  );
});
