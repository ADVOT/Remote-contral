import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ConnectServer, interfaces } from '../server.js';

test('network discovery labels Radmin without treating arbitrary 26.x or virtual adapters as Radmin', () => {
  const ipv4 = address => ({ address, family: 'IPv4', internal: false });
  const discovered = interfaces({
    'Radmin VPN': [ipv4('26.0.0.10'), { address: 'fe80::1', family: 'IPv6', internal: false }],
    'Famatech VPN': [ipv4('26.0.0.11')],
    Tailscale: [ipv4('100.64.0.10')],
    WLAN: [ipv4('192.0.2.10')],
    'VMware Network Adapter': [ipv4('192.0.2.20')],
    Ethernet: [ipv4('26.0.0.30')],
    Offline: [ipv4('169.254.0.10')],
    Loopback: [{ ...ipv4('127.0.0.1'), internal: true }],
  });
  assert.deepEqual(discovered.map(({ name, kind }) => [name, kind]), [
    ['Radmin VPN', 'radmin'], ['Famatech VPN', 'radmin'], ['Tailscale', 'tailscale'],
    ['WLAN', 'lan'], ['VMware Network Adapter', 'virtual'], ['Ethernet', 'lan'],
  ]);
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
test('paired HTTP/stream/WebSocket access, origin fences, persistence, and revocation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-connect-test-'));
  const sockets = new Set();
  const backend = http.createServer((req, res) => {
    if (req.url === '/?token=fixture') {
      res.writeHead(303, { 'set-cookie': 'dsh-fixture=local-secret; HttpOnly', location: './' }); res.end(); return;
    }
    if (req.headers.cookie !== 'dsh-fixture=local-secret' || req.headers.origin !== `http://127.0.0.1:${backend.address().port}`) { res.writeHead(401); res.end(); return; }
    if (req.url === '/stream') { res.write('first\n'); setTimeout(() => res.end('second\n'), 20); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'secret=must-not-leak' });
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie, forwarded: req.headers['x-forwarded-for'] ?? null }));
  });
  backend.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  backend.on('upgrade', (req, socket) => {
    if (req.headers.cookie !== 'dsh-fixture=local-secret') return socket.destroy();
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', chunk => socket.write(chunk));
  });
  await listen(backend);
  const reservation = http.createServer(); await listen(reservation);
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const options = { stateFile: path.join(dir, 'state.json'), upstream: `http://127.0.0.1:${backend.address().port}/`, authenticatedUrl: base => base + '?token=fixture', port, allowedInterfaces: () => [{ address: '127.0.0.1', name: 'fixture', kind: 'lan' }] };
  const service = new ConnectServer(options);
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => { await service.dispose(); for (const s of sockets) s.destroy(); await new Promise(r => backend.close(r)); });
  // Keep test artifacts recoverable rather than deleting them; the fixture contains no real credentials.
  await service.start(['127.0.0.1']);
  const request = (url, data, cookie, extra = {}) => fetch(origin + url, { method: data ? 'POST' : 'GET', headers: { origin, connection: 'close', ...(cookie ? { cookie } : {}), ...extra }, ...(data ? { body: JSON.stringify(data) } : {}), redirect: 'manual' });
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api')).status, 401);
  const pair = async name => {
    service.createPairing();
    const response = await request('/__dsh_connect/pair', { name, code: service.pairing.code });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  service.createPairing(); const usedCode = service.pairing.code;
  assert.equal((await request('/__dsh_connect/pair', { name: 'phone', code: usedCode }, undefined, { origin: 'https://evil.invalid' })).status, 403);
  const response = await request('/__dsh_connect/pair', { name: 'phone', code: usedCode });
  assert.equal(response.status, 200);
  const deviceCookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/__dsh_connect/pair', { name: 'replay', code: usedCode })).status, 401);
  const proxied = await request('/api', undefined, deviceCookie, { 'x-forwarded-for': 'evil' });
  assert.equal(proxied.status, 200); assert.equal(proxied.headers.get('set-cookie'), null);
  assert.deepEqual(await proxied.json(), { path: '/api', cookie: 'dsh-fixture=local-secret', forwarded: null });
  assert.equal(await (await request('/stream', undefined, deviceCookie)).text(), 'first\nsecond\n');
  assert.equal((await request('/dsh-connect/state', undefined, deviceCookie)).status, 403);
  assert.equal((await request('/%64sh-connect/state', undefined, deviceCookie)).status, 403);
  assert.equal((await request('/?token=stolen', undefined, deviceCookie)).status, 400);
  assert.equal((await request('/api', undefined, deviceCookie, { origin: 'https://evil.invalid' })).status, 403);
  const ws = http.request(origin + '/api/remote.mux', { headers: { origin, cookie: deviceCookie, connection: 'Upgrade', upgrade: 'websocket' } });
  ws.end();
  const [, socket] = await once(ws, 'upgrade');
  socket.write('duplex-fixture');
  const [echo] = await once(socket, 'data'); assert.equal(echo.toString(), 'duplex-fixture');
  const closed = once(socket, 'close');
  service.revoke(service.state.devices[0].id);
  await closed;
  assert.equal((await request('/api', undefined, deviceCookie)).status, 401);
  const secondCookie = await pair('tablet');
  const persisted = fs.readFileSync(options.stateFile, 'utf8');
  assert.ok(!persisted.includes(secondCookie.split('=')[1]));
  const devices = service.snapshot().devices;
  assert.ok(!('hash' in devices[0]));
  await service.dispose();
  const restored = new ConnectServer(options);
  await restored.restore();
  assert.equal(restored.snapshot().running, true);
  assert.equal((await request('/api', undefined, secondCookie)).status, 200);
  restored.state.devices[0].expiresAt = Date.now() - 1;
  assert.equal((await request('/api', undefined, secondCookie)).status, 401);
  restored.createPairing(); restored.pairing.expiresAt = Date.now() - 1;
  assert.equal((await request('/__dsh_connect/pair', { name: 'late', code: restored.pairing.code })).status, 401);
  restored.attempts.clear();
  for (let i = 0; i < 8; i++) assert.equal((await request('/__dsh_connect/pair', { name: 'bad', code: '000000000' })).status, 401);
  assert.equal((await request('/__dsh_connect/pair', { name: 'bad', code: '000000000' })).status, 429);
  await restored.stop(); assert.equal(restored.snapshot().running, false); await restored.dispose();
});

test('invalid targets, wildcard interfaces, and corrupt state fail closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-connect-invalid-'));
  const file = path.join(dir, 'state.json');
  assert.throws(() => new ConnectServer({ stateFile: file, upstream: 'http://example.com', authenticatedUrl: x => x }), /本机/);
  const service = new ConnectServer({ stateFile: file, upstream: 'http://127.0.0.1:1', authenticatedUrl: x => x, allowedInterfaces: () => [] });
  await assert.rejects(service.start(['0.0.0.0']), /网络地址/);
  fs.writeFileSync(file, '{"version":3}');
  assert.throws(() => new ConnectServer({ stateFile: file, upstream: 'http://127.0.0.1:1', authenticatedUrl: x => x }), /状态文件/);
});
