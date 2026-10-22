import os from 'node:os';
import path from 'node:path';
import { ConnectServer, ADMIN, body, isLoopback, json, serveAsset } from './server.js';

export const name = '@local/dsh-connect';
export const inject = ['webServer', 'connection'];

export async function apply(ctx, config = {}) {
  const upstream = ctx.webServer.getOrigin();
  const service = new ConnectServer({
    ...config,
    stateFile: config.stateFile ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'dsh-connect', 'state.json'),
    upstream,
    authenticatedUrl: base => ctx.connection.authenticatedUrl(base),
  });

  function guard(req, mutation = false) {
    const origin = new URL(upstream);
    if (!isLoopback(req.socket.remoteAddress) || req.headers.host !== origin.host || ctx.connection.requestRejection(req) !== undefined) throw Object.assign(new Error('仅限已登录的本机 DSH 管理连接'), { status: 403 });
    if (req.headers.origin && req.headers.origin !== origin.origin) throw Object.assign(new Error('请求来源无效'), { status: 403 });
    // The official dsh-app:// desktop bridge strips Origin after checking it.
    // Its authenticated loopback cookie plus this non-simple header fence mutations.
    if (mutation && req.headers['x-dsh-connect-admin'] !== '1') throw Object.assign(new Error('请从本机连接页面操作'), { status: 403 });
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: ADMIN, handler: async (req, res) => {
      try {
        guard(req, req.method !== 'GET');
        const pathname = new URL(req.url, upstream).pathname;
        const assets = new Map([[`${ADMIN}/console`, 'admin.html'], [`${ADMIN}/admin.js`, 'admin.js'], [`${ADMIN}/style.css`, 'style.css']]);
        if (req.method === 'GET' && assets.has(pathname)) return serveAsset(res, assets.get(pathname));
        if (req.method === 'GET' && pathname === `${ADMIN}/state`) return json(res, 200, service.snapshot());
        if (req.method !== 'POST' || pathname !== `${ADMIN}/action`) return json(res, 404, { error: '页面不存在' });
        const data = await body(req);
        if (!data || typeof data !== 'object') return json(res, 400, { error: '请求内容无效' });
        switch (data.action) {
          case 'start': await service.start(data.addresses); break;
          case 'stop': await service.stop(); break;
          case 'pair': service.createPairing(); break;
          case 'cancel-pair': service.pairing = null; break;
          case 'revoke': service.revoke(data.id); break;
          case 'revoke-account': service.revokeAccount(data.id); break;
          default: return json(res, 400, { error: '未知操作' });
        }
        json(res, 200, service.snapshot());
      } catch (error) {
        if (!res.headersSent) json(res, error.status ?? 500, { error: error.message });
        else res.destroy();
      }
    } });
    return async () => { dispose(); await service.dispose(); };
  }, 'dsh-connect: management routes and paired network listeners');

  ctx.on('webserver/index-inject', table => table.push({ kind: 'global', name: '__DSH_CONNECT_LOCAL_ORIGIN__', value: upstream }));
  service.armExpiry();
  await service.restore();
}
