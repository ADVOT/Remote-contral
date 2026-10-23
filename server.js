import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual, randomInt, scrypt } from 'node:crypto';
import { promisify } from 'node:util';


export const ADMIN = '/dsh-connect';
const COOKIE = 'dsh-connect-device';
const REMOTE = '/__dsh_connect';
const STATIC = new URL('./ui/', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const derive = promisify(scrypt);
const KDF = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const username = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validUsername = value => /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(value);
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function isLoopback(ip = '') {
  return ip === '::1' || /^127\./.test(ip) || /^::ffff:127\./i.test(ip);
}

export function interfaces(networks = os.networkInterfaces()) {
  return Object.entries(networks).flatMap(([name, rows]) => (rows ?? [])
    .filter(row => row.family === 'IPv4' && !row.internal && !row.address.startsWith('169.254.'))
    .map(row => ({ name, address: row.address, kind: /Radmin|Famatech/i.test(name) ? 'radmin' : /^100\./.test(row.address) && Number(row.address.split('.')[1]) >= 64 && Number(row.address.split('.')[1]) <= 127 ? 'tailscale' : /VMware|vEthernet|VirtualBox/i.test(name) ? 'virtual' : 'lan' })));
}

export function json(res, code, value, extra = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(value));
}

export async function body(req, cap = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效的 JSON'), { status: 400 }); }
}

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function requestPath(req) {
  if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20]/.test(req.url)) fail('请求路径无效');
  const url = new URL(req.url, 'http://internal');
  if (url.origin !== 'http://internal') fail('请求路径无效');
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { fail('请求路径编码无效'); }
  if (decoded.startsWith(ADMIN) || decoded === '/connect' || decoded.includes('\\')) fail('请在本机 DSH 中管理连接', 403);
  return url;
}
function sameSecret(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function cookie(req) { return String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1); }

function writeState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function serveAsset(res, file) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const data = fs.readFileSync(new URL(file, STATIC));
  res.writeHead(200, {
    'content-type': types[path.extname(file)], 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  });
  res.end(data);
}

/** A listener forwards only to the Host that created this plugin; no caller-controlled target. */
export class ConnectServer {
  constructor({ stateFile, upstream, authenticatedUrl, port = 3940, pairingSeconds = 600, deviceDays = 30, maxDevices = 16, tls, allowedInterfaces = interfaces }) {
    this.options = { port, pairingSeconds, deviceDays, maxDevices, tls };
    this.stateFile = stateFile;
    this.upstream = new URL(upstream);
    if (!isLoopback(this.upstream.hostname) || this.upstream.protocol !== 'http:') fail('DSH Connect 当前需要本机 HTTP Host', 500);
    for (const [key, value, min, max] of [['port', port, 1, 65535], ['pairingSeconds', pairingSeconds, 30, 3600], ['deviceDays', deviceDays, 1, 365], ['maxDevices', maxDevices, 1, 100]]) {
      if (!Number.isInteger(value) || value < min || value > max) fail(`配置 ${key} 超出允许范围`, 500);
    }
    this.authenticatedUrl = authenticatedUrl;
    this.allowedInterfaces = allowedInterfaces;
    this.listeners = [];
    this.connections = new Map();

    this.attempts = new Map();
    this.pairing = null;
    this.error = '';
    this.pending = false;
    this.pendingDone = Promise.resolve();
    this.disposed = false;
    this.passwordJobs = 0;
    this.state = { version: 2, enabled: false, addresses: [], devices: [], accounts: [] };
    if (fs.existsSync(stateFile)) {
      const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (![1, 2].includes(stored.version) || typeof stored.enabled !== 'boolean' || !Array.isArray(stored.addresses) || !Array.isArray(stored.devices)
        || stored.addresses.some(x => typeof x !== 'string')
        || stored.devices.some(x => typeof x.id !== 'string' || !/^[a-f0-9]{64}$/.test(x.hash) || typeof x.name !== 'string' || !Number.isSafeInteger(x.expiresAt))) fail('连接状态文件损坏；请恢复备份后重启插件', 500);
      const accounts = stored.version === 1 ? [] : stored.accounts;
      if (!Array.isArray(accounts) || accounts.length > 16 || accounts.some(a => typeof a.id !== 'string' || !validUsername(a.username) || !/^[a-f0-9]{32}$/.test(a.salt) || !/^[a-f0-9]{128}$/.test(a.passwordHash) || a.kdf !== 'scrypt-131072-8-1' || !Number.isSafeInteger(a.createdAt))
        || new Set(accounts.map(a => a.username)).size !== accounts.length || new Set(accounts.map(a => a.id)).size !== accounts.length
        || stored.devices.some(d => d.accountId !== undefined && !accounts.some(a => a.id === d.accountId))) fail('连接账号状态文件损坏；请恢复备份后重启插件', 500);
      this.state = { ...stored, version: 2, accounts };
    }
  }

  save() { writeState(this.stateFile, this.state); }
  snapshot() {
    const now = Date.now();
    return {
      hostname: os.hostname(), running: this.listeners.length > 0, enabled: this.state.enabled, error: this.error,
      port: this.options.port, interfaces: this.allowedInterfaces(), addresses: this.state.addresses,
      urls: this.listeners.map(({ address }) => `${this.options.tls ? 'https' : 'http'}://${address}:${this.options.port}/`),
      devices: this.state.devices.filter(d => d.expiresAt > now).map(({ hash, ...d }) => ({ ...d, online: (this.connections.get(d.id)?.size ?? 0) > 0 })),
      accounts: this.state.accounts.map(({ id, username, createdAt }) => ({ id, username, createdAt, sessions: this.state.devices.filter(d => d.accountId === id && d.expiresAt > now).length })),
      pairing: this.pairing && this.pairing.expiresAt > now ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : null,
      tls: Boolean(this.options.tls),
    };
  }

  async restore() {
    if (this.state.enabled) {
      try { await this.start(this.state.addresses); }
      catch (error) { this.error = error.message; }
    }
  }

  async start(addresses) {
    if (this.disposed) fail('插件已停止', 503);
    if (this.pending) fail('连接服务正在切换，请稍后重试', 409);
    this.pending = true;
    this.pendingDone = new Promise(resolve => { this.finishPending = resolve; });
    const opened = [];
    try {
      const available = new Set(this.allowedInterfaces().map(row => row.address));
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 8 || addresses.some(a => typeof a !== 'string' || net.isIP(a) !== 4 || !available.has(a))) fail('请选择当前可用的网络地址');
      const unique = [...new Set(addresses)];
      // Prepare authentication before opening any network listener.
      await this.bootstrap();
      await this.closeListeners();
      for (const address of unique) {
        const tls = this.options.tls;
        const server = tls ? https.createServer({ cert: fs.readFileSync(tls.certFile), key: fs.readFileSync(tls.keyFile) }) : http.createServer();
        const sockets = new Set();
        server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
        server.on('request', (req, res) => this.handle(req, res, address).catch(error => {
          if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : '连接服务暂时不可用，请在本机查看状态' });
          else res.destroy();
        }));
        server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, address));
        server.requestTimeout = 120000;
        server.headersTimeout = 15000;
        server.maxHeadersCount = 100;
        server.on('error', error => { this.error = `监听 ${address} 失败：${error.code ?? error.message}`; });
        await new Promise((resolve, reject) => {
          const bad = error => reject(new Error(`监听 ${address}:${this.options.port} 失败：${error.code ?? error.message}`));
          server.once('error', bad);
          server.listen(this.options.port, address, () => { server.off('error', bad); resolve(); });
        });
        opened.push({ server, address, sockets });
      }
      this.listeners = opened;
      this.state.addresses = unique;
      this.state.enabled = true;
      this.error = '';
      this.save();
    } catch (error) {
      await Promise.all(opened.map(row => this.closeRow(row)));
      this.listeners = [];
      this.error = error.message;
      throw error;
    } finally { this.pending = false; this.finishPending(); }
  }

  async closeRow({ server, sockets }) {
    const closed = new Promise(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await closed;
  }
  async closeListeners() {
    const rows = this.listeners;
    this.listeners = [];
    await Promise.all(rows.map(row => this.closeRow(row)));
  }
  async stop() {
    if (this.pending) fail('连接服务正在切换，请稍后重试', 409);
    this.pending = true;
    this.pendingDone = new Promise(resolve => { this.finishPending = resolve; });
    try {
      await this.closeListeners(); this.pairing = null;
      this.state.enabled = false; this.save();
    } finally { this.pending = false; this.finishPending(); }
  }
  async dispose() { this.disposed = true; clearInterval(this.expiryTimer); await this.pendingDone; await this.closeListeners(); }

  createPairing() {
    if (!this.listeners.length) fail('先开启连接服务，再添加设备');
    this.pairing = { code: String(randomInt(100000000, 1000000000)), expiresAt: Date.now() + this.options.pairingSeconds * 1000 };
    return this.snapshot();
  }

  revoke(id) {
    if (typeof id !== 'string') fail('设备编号无效');
    const previous = this.state.devices;
    this.state.devices = previous.filter(d => d.id !== id);
    try { this.save(); } catch (error) { this.state.devices = previous; throw error; }
    for (const socket of this.connections.get(id) ?? []) socket.destroy();
    this.connections.delete(id);
    return this.snapshot();
  }

  revokeAccount(id) {
    if (typeof id !== 'string') fail('账号编号无效');
    const previous = this.state;
    const removed = previous.devices.filter(d => d.accountId === id);
    this.state = { ...previous, accounts: previous.accounts.filter(a => a.id !== id), devices: previous.devices.filter(d => d.accountId !== id) };
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    for (const device of removed) {
      for (const socket of this.connections.get(device.id) ?? []) socket.destroy();
      this.connections.delete(device.id);
    }
  }

  authority(req, address, requireOrigin = false) {
    const expected = `${this.options.tls ? 'https' : 'http'}://${address}:${this.options.port}`;
    if (req.headers.host !== `${address}:${this.options.port}`) return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== expected) return false;
    if (requireOrigin && origin !== expected) return false;
    return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']);
  }

  identify(req) {
    const raw = cookie(req);
    if (!raw || raw.length > 128) return null;
    const digest = sha(raw), now = Date.now();
    return this.state.devices.find(d => d.expiresAt > now && sameSecret(d.hash, digest)) ?? null;
  }

  allowAttempt(ip, account) {
    const now = Date.now();
    for (const [key, row] of this.attempts) if (row.until <= now) this.attempts.delete(key);
    for (const [key, limit] of [['global', 40], ['ip:' + ip, 8], ...(account ? [['account:' + sha(account), 8]] : [])]) {
      const row = this.attempts.get(key) ?? { count: 0, until: now + 60000 };
      if (row.count >= limit) fail('尝试次数过多，请一分钟后重试', 429);
      row.count++; this.attempts.set(key, row);
    }
  }

  validCode(value) {
    return typeof value === 'string' && this.pairing && this.pairing.expiresAt > Date.now() && sameSecret(value.replace(/[\s-]/g, ''), this.pairing.code);
  }

  async passwordHash(password, salt) {
    if (this.passwordJobs >= 2) fail('登录请求较多，请稍后重试', 429);
    this.passwordJobs++;
    try { return (await derive(password, Buffer.from(salt, 'hex'), 64, KDF)).toString('hex'); }
    finally { this.passwordJobs--; }
  }

  issueSession(res, data, accountId, existing, extra = {}) {
    if (this.disposed || !this.listeners.length) fail('连接服务已关闭，请重新连接', 503);
    const now = Date.now(), active = this.state.devices.filter(d => d.expiresAt > now);
    if (!existing && active.length >= this.options.maxDevices) fail('设备数量已达上限，请先在本机撤销旧设备', 409);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (name.length < 1 || name.length > 60 || /[\x00-\x1f]/.test(name)) fail('请输入 1–60 字的设备名称');
    const raw = token();
    const device = { id: existing?.id ?? randomBytes(16).toString('hex'), hash: sha(raw), name, createdAt: existing?.createdAt ?? now, lastSeen: now, expiresAt: now + this.options.deviceDays * 86400000, ...(accountId ? { accountId } : {}) };
    const previous = this.state;
    this.state = { ...this.state, ...extra, devices: [...active.filter(d => d.id !== existing?.id), device] };
    try { this.save(); } catch (error) { this.state = previous; throw error; }
    json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.options.deviceDays * 86400}${this.options.tls ? '; Secure' : ''}` });
  }

  async accountAuth(req, res, address, register) {
    if (!this.authority(req, address, true)) fail('请求来源无效', 403);
    const data = await body(req);
    const user = username(data?.username);
    this.allowAttempt(req.socket.remoteAddress, user || '(invalid)');
    if (!data || !validUsername(user)) fail('账号需为 3–32 位字母、数字、点、下划线或短横线');
    const password = data.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail('密码需为 12–128 个字符');
    if (register) {
      const device = this.identify(req), pairing = this.pairing;
      if (!device && !this.validCode(data.code)) fail('请使用本机生成的配对码，或在已配对设备上设置账号', 401);
      if (device?.accountId) fail('这台设备已关联账号，请直接使用账号登录', 409);
      if (this.state.accounts.length >= 16) fail('账号数量已达上限，请在本机管理账号', 409);
      if (this.state.accounts.some(a => a.username === user)) fail('该账号名不可用', 409);
      const salt = randomBytes(16).toString('hex');
      const hash = await this.passwordHash(password, salt);
      // Recheck authorization and uniqueness after the asynchronous KDF.
      const current = this.identify(req);
      if (device ? !current || current.id !== device.id || current.accountId : this.pairing !== pairing || !this.validCode(data.code)) fail('注册授权已失效，请重新配对', 401);
      if (this.state.accounts.length >= 16 || this.state.accounts.some(a => a.username === user)) fail('该账号名不可用或账号数量已达上限', 409);
      const account = { id: randomBytes(16).toString('hex'), username: user, salt, passwordHash: hash, kdf: 'scrypt-131072-8-1', createdAt: Date.now() };
      this.issueSession(res, data, account.id, current, { accounts: [...this.state.accounts, account] });
      if (!device) this.pairing = null;
    } else {
      const account = this.state.accounts.find(a => a.username === user);
      const hash = await this.passwordHash(password, account?.salt ?? '00000000000000000000000000000000');
      if (!account || !sameSecret(hash, account.passwordHash) || !this.state.accounts.some(a => a === account)) fail('账号或密码不正确', 401);
      const device = this.identify(req);
      this.issueSession(res, data, account.id, device?.accountId === account.id ? device : null);
    }
  }

  async pair(req, res, address) {
    if (!this.authority(req, address, true)) fail('请求来源无效', 403);
    this.allowAttempt(req.socket.remoteAddress);
    const data = await body(req);
    if (!data || !this.validCode(data.code)) fail('配对码不正确或已过期', 401);
    this.issueSession(res, data);
    this.pairing = null;
  }

  async handle(req, res, address) {
    if (!this.authority(req, address, !['GET', 'HEAD'].includes(req.method))) fail('请求来源无效', 403);
    const url = requestPath(req);
    if (url.searchParams.has('token')) fail('远程入口不接受 DSH 启动令牌', 400);
    if (url.pathname === `${REMOTE}/login` && req.method === 'POST') return this.accountAuth(req, res, address, false);
    if (url.pathname === `${REMOTE}/register` && req.method === 'POST') return this.accountAuth(req, res, address, true);
    if (url.pathname === `${REMOTE}/login` && req.method === 'GET') return serveAsset(res, 'pair.html');
    if (url.pathname === `${REMOTE}/status` && req.method === 'GET') {
      const device = this.identify(req), account = this.state.accounts.find(a => a.id === device?.accountId);
      return json(res, 200, { paired: Boolean(device), username: account?.username ?? null, name: device?.name ?? null });
    }
    if (url.pathname === `${REMOTE}/pair` && req.method === 'POST') return this.pair(req, res, address);
    if (url.pathname === `${REMOTE}/logout` && req.method === 'POST') {
      const device = this.identify(req);
      if (device) this.revoke(device.id);
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    if (req.method === 'GET' && [`${REMOTE}/pair.js`, `${REMOTE}/style.css`].includes(url.pathname)) return serveAsset(res, url.pathname.endsWith('.js') ? 'pair.js' : 'style.css');
    const device = this.identify(req);
    if (!device) {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === `${REMOTE}/login`)) return serveAsset(res, 'pair.html');
      return json(res, 401, { error: '设备未配对或访问已撤销，请返回首页重新配对' });
    }
    if (url.pathname.startsWith(REMOTE)) return json(res, 404, { error: '页面不存在' });
    device.lastSeen = Date.now();
    return this.proxy(req, res, device);
  }

  async bootstrap() {
    // The official launch-token exchange stays server-side. Never send this URL or cookie to a remote device.
    const launch = this.authenticatedUrl(this.upstream.href);
    const response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const cookies = response.headers.getSetCookie();
    await response.body?.cancel();
    if (response.status !== 303 || !cookies.length) fail('DSH 本机认证握手失败；请确认版本兼容', 502);
    this.upstreamCookie = cookies.map(c => c.split(';', 1)[0]).join('; ');
  }

  requestHeaders(req, upgrade = false) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP.has(key) && !['host', 'cookie', 'authorization', 'origin', 'referer', 'forwarded', 'accept-encoding'].includes(key) && !key.startsWith('x-forwarded-') && !key.startsWith('x-dsh-connect')) headers[key] = value;
    }
    headers.host = this.upstream.host;
    headers.origin = this.upstream.origin;
    headers.cookie = this.upstreamCookie;
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }

  track(id, socket) {
    const set = this.connections.get(id) ?? new Set();
    if (set.has(socket)) return;
    set.add(socket); this.connections.set(id, set);
    socket.once('close', () => { set.delete(socket); if (!set.size) this.connections.delete(id); });
  }

  proxy(req, res, device) {
    this.track(device.id, req.socket);
    return new Promise(resolve => {
      const upstream = http.request(new URL(req.url, this.upstream), { method: req.method, headers: this.requestHeaders(req) }, response => {
        const headers = {};
        for (const [key, value] of Object.entries(response.headers)) if (!HOP.has(key) && !['set-cookie', 'location'].includes(key)) headers[key] = value;
        if (response.headers.location) {
          const location = new URL(response.headers.location, this.upstream);
          if (location.origin !== this.upstream.origin || location.searchParams.has('token')) { response.destroy(); json(res, 502, { error: '后端返回了不支持的跳转' }); resolve(); return; }
          headers.location = location.pathname + location.search + location.hash;
        }
        headers['cache-control'] = 'no-store';
        headers['referrer-policy'] = 'no-referrer';
        res.writeHead(response.statusCode, headers);
        response.pipe(res);
        response.once('error', () => res.destroy());
        response.once('end', resolve);
      });
      upstream.on('error', () => {
        if (!res.headersSent) json(res, 502, { error: 'DSH 本机服务未响应，请在电脑上检查 DSH' });
        else res.destroy();
        resolve();
      });
      res.once('close', () => { upstream.destroy(); resolve(); });
      req.once('error', () => upstream.destroy());
      req.pipe(upstream);
    });
  }

  upgrade(req, socket, head, address) {
    const reject = code => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`); };
    let url;
    try { url = requestPath(req); } catch { return reject(403); }
    if (!this.authority(req, address, true) || url.pathname !== '/api/remote.mux' || url.search) return reject(403);
    const device = this.identify(req);
    if (!device) return reject(401);
    const upstream = http.request(new URL(req.url, this.upstream), { method: 'GET', headers: this.requestHeaders(req, true) });
    this.track(device.id, socket);
    const handshake = setTimeout(() => { upstream.destroy(); socket.destroy(); }, 10000);
    handshake.unref();
    upstream.once('upgrade', (response, remote, upstreamHead) => {
      clearTimeout(handshake);
      if (response.statusCode !== 101 || socket.destroyed || !this.state.devices.some(d => d.id === device.id && d.expiresAt > Date.now())) { remote.destroy(); socket.destroy(); return; }
      this.track(device.id, remote);
      const headers = Object.entries(response.headers).filter(([key]) => key !== 'set-cookie').flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).map(value => `${key}: ${value}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) remote.write(head);
      socket.pipe(remote); remote.pipe(socket);
      remote.once('error', () => socket.destroy());
      socket.once('error', () => remote.destroy());
      remote.once('close', () => socket.destroy());
      socket.once('close', () => remote.destroy());
    });
    upstream.once('response', response => { clearTimeout(handshake); response.resume(); reject(response.statusCode ?? 502); });
    upstream.once('error', () => { clearTimeout(handshake); socket.destroy(); });
    socket.once('close', () => { clearTimeout(handshake); upstream.destroy(); });
    socket.once('error', () => upstream.destroy());
    upstream.end();
  }

  armExpiry() {
    this.expiryTimer = setInterval(() => {
      for (const d of this.state.devices) if (d.expiresAt <= Date.now()) for (const socket of this.connections.get(d.id) ?? []) socket.destroy();
    }, 1000);
    this.expiryTimer.unref();
  }
}
