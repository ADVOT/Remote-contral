import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectServer } from '../server.js';

test('account authorization, two address login, salted storage, migration and revocation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-connect-accounts-'));
  const backend = http.createServer((req, res) => {
    if (req.url === '/?token=fixture') res.writeHead(303, { 'set-cookie': 'fixture=internal', location: '/' });
    else res.writeHead(req.headers.cookie === 'fixture=internal' ? 200 : 401);
    res.end('fixture');
  });
  await new Promise(r => backend.listen(0, '127.0.0.1', r));
  const reservation = http.createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const options = {
    stateFile: path.join(dir, 'state.json'), upstream: `http://127.0.0.1:${backend.address().port}/`,
    authenticatedUrl: base => base + '?token=fixture', port,
    allowedInterfaces: () => ['127.0.0.1', '127.0.0.2'].map(address => ({ address, name: 'fixture' })),
  };
  let service = new ConnectServer(options);
  t.after(async () => { await service.dispose(); backend.closeAllConnections(); await new Promise(r => backend.close(r)); });
  await service.start(['127.0.0.1', '127.0.0.2']);
  const request = (host, route, data, cookie, extra = {}) => fetch(`http://${host}:${port}${route}`, {
    method: data ? 'POST' : 'GET',
    headers: { origin: `http://${host}:${port}`, connection: 'close', ...(cookie ? { cookie } : {}), ...extra },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const api = (host, route, data, cookie, extra) => request(host, '/__dsh_connect/' + route, data, cookie, extra);
  const a = '127.0.0.1', b = '127.0.0.2';
  const credentials = { username: 'Test.Mobile', password: 'fixture-only-password-2026', name: 'test phone' };
  assert.equal((await api(a, 'register', credentials)).status, 401);
  service.attempts.clear(); service.createPairing();
  const code = service.pairing.code;
  assert.equal((await api(a, 'register', { ...credentials, code, password: 'short' })).status, 400);
  assert.equal((await api(a, 'register', { ...credentials, code }, null, { origin: 'http://evil.invalid' })).status, 403);
  const registered = await api(a, 'register', { ...credentials, code });
  assert.equal(registered.status, 200);
  const firstCookie = registered.headers.get('set-cookie').split(';')[0];
  assert.equal(service.pairing, null);
  assert.equal((await api(a, 'register', { ...credentials, code, username: 'intruder' })).status, 401);
  assert.equal((await request(a, '/api', undefined, firstCookie)).status, 200);
  // The second origin has no first-origin cookie; the same account establishes its own session.
  assert.equal((await request(b, '/api')).status, 401);
  assert.equal((await api(b, 'login', { ...credentials, password: 'fixture-incorrect-password' })).status, 401);
  const unknown = await api(b, 'login', { ...credentials, username: 'missing-user' });
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error, '账号或密码不正确');
  service.attempts.clear();
  const loggedIn = await api(b, 'login', credentials);
  assert.equal(loggedIn.status, 200);
  const secondCookie = loggedIn.headers.get('set-cookie').split(';')[0];
  assert.notEqual(firstCookie, secondCookie);
  assert.equal((await request(b, '/api', undefined, secondCookie)).status, 200);
  assert.equal((await api(b, 'status', undefined, secondCookie).then(r => r.json())).username, 'test.mobile');
  assert.equal(service.snapshot().accounts[0].sessions, 2);
  assert.ok(!('passwordHash' in service.snapshot().accounts[0]));
  const persisted = fs.readFileSync(options.stateFile, 'utf8');
  assert.ok(!persisted.includes(credentials.password));
  assert.ok(!persisted.includes(firstCookie.split('=')[1]));
  assert.match(service.state.accounts[0].passwordHash, /^[a-f0-9]{128}$/);
  // Logout revokes only this origin's session, not the account or the other origin.
  assert.equal((await api(a, 'logout', {}, firstCookie)).status, 200);
  assert.equal((await request(a, '/api', undefined, firstCookie)).status, 401);
  assert.equal((await request(b, '/api', undefined, secondCookie)).status, 200);
  const accountId = service.state.accounts[0].id;
  await service.dispose(); service = new ConnectServer(options); await service.restore();
  assert.equal((await request(b, '/api', undefined, secondCookie)).status, 200);
  service.revokeAccount(accountId);
  assert.equal((await request(b, '/api', undefined, secondCookie)).status, 401);
  assert.equal((await api(b, 'login', credentials)).status, 401);
  // Existing v1 devices remain authorized and can attach an account without a new code.
  service.attempts.clear(); service.createPairing();
  const legacy = await api(a, 'pair', { name: 'legacy phone', code: service.pairing.code });
  const legacyCookie = legacy.headers.get('set-cookie').split(';')[0];
  service.state.version = 1; delete service.state.accounts; service.save();
  await service.dispose(); service = new ConnectServer(options); await service.restore();
  assert.equal((await request(a, '/api', undefined, legacyCookie)).status, 200);
  assert.equal((await api(a, 'register', credentials, legacyCookie)).status, 200);
  assert.equal(service.state.version, 2);
  assert.equal(service.state.devices.length, 1);
  // Two concurrent registrations cannot reuse one authorization code.
  service.attempts.clear(); service.createPairing();
  const shared = service.pairing.code;
  const responses = await Promise.all(['race.one', 'race.two'].map(username => api(a, 'register', { ...credentials, username, code: shared })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  const [one, two] = service.state.accounts;
  assert.notEqual(one.salt, two.salt); assert.notEqual(one.passwordHash, two.passwordHash);
  service.attempts.clear();
  for (let i = 0; i < 8; i++) assert.equal((await api(a, 'login', { ...credentials, password: 'fixture-incorrect-password' })).status, 401);
  assert.equal((await api(b, 'login', credentials)).status, 429);
  assert.equal((await request(b, '/dsh-connect/state')).status, 403);
});
