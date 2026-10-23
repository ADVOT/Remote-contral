const $ = id => document.getElementById(id);
let state, busy = false, selected = new Set(), initialized = false;
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function error(message) { $('error').textContent = message; $('error').hidden = !message; }
async function api(action, data = {}) {
  const response = await fetch(action ? '/dsh-connect/action' : '/dsh-connect/state', action ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-connect-admin': '1' }, body: JSON.stringify({ action, ...data }) } : { cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '读取连接状态失败');
  return value;
}
function time(value) { return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function render() {
  $('status').textContent = state.running ? '连接已开启' : '连接已关闭';
  $('hostname').textContent = state.hostname;
  $('transport').textContent = state.tls ? 'HTTPS 加密连接' : 'HTTP · 跨网络请使用 Tailscale 或 Radmin VPN 加密通道';
  if (!initialized) {
    selected = new Set(state.addresses.length ? state.addresses : state.interfaces.filter(x => ['tailscale', 'radmin'].includes(x.kind) || (x.kind === 'lan' && /Wi-Fi|WLAN|无线|Ethernet|以太网/i.test(x.name))).map(x => x.address));
    initialized = true;
  }
  const available = new Set(state.interfaces.map(row => row.address));
  // Never submit saved or previously checked addresses that are no longer visible.
  selected = new Set([...selected].filter(address => available.has(address)));
  const unavailable = state.addresses.filter(address => !available.has(address));
  $('network-notice').hidden = !unavailable.length;
  $('network-notice').textContent = unavailable.length ? `上次使用的地址 ${unavailable.join('、')} 当前不可用。请选择下方在线网卡；Tailscale 或 Radmin VPN 上线后会自动出现在列表中。` : '';
  const list = $('networks-list'); list.replaceChildren();
  for (const row of state.interfaces) {
    const label = node('label', undefined, 'network');
    const check = node('input'); check.type = 'checkbox'; check.value = row.address; check.checked = selected.has(row.address); check.disabled = busy || state.running;
    check.addEventListener('change', () => { check.checked ? selected.add(row.address) : selected.delete(row.address); $('start').disabled = busy || !selected.size; });
    const meta = node('span', undefined, 'meta'); meta.append(node('span', row.name), node('span', row.address, 'address'));
    label.append(check, meta, node('span', ({ tailscale: 'Tailscale', radmin: 'Radmin VPN', virtual: '虚拟网卡' })[row.kind] ?? '局域网', 'kind')); list.append(label);
  }
  if (!state.interfaces.length) list.append(node('p', '没有可用地址。请连接 Wi-Fi，或等待 Tailscale / Radmin VPN 上线后刷新。', 'empty'));
  $('start').hidden = state.running; $('start').disabled = busy || !selected.size;
  $('stop').hidden = !state.running; $('stop').disabled = busy;
  $('add').disabled = busy || !state.running;
  const addresses = $('addresses'); addresses.replaceChildren(); addresses.hidden = !state.urls.length;
  for (const url of state.urls) {
    const row = node('div', undefined, 'address-row'), link = node('a', url); link.href = url; link.target = '_blank'; link.rel = 'noreferrer';
    const copy = node('button', '复制地址'); copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制地址'; }, 1800); }
      catch { error('无法自动复制，请长按或选中连接地址复制。'); }
    };
    row.append(link, copy); addresses.append(row);
  }
  $('pairing').hidden = !state.pairing;
  if (state.pairing) { $('code').textContent = state.pairing.code.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3'); countdown(); }
  const devices = $('devices'); devices.replaceChildren();
  for (const d of state.devices) {
    const row = node('div', undefined, 'device'), meta = node('div');
    const account = state.accounts?.find(a => a.id === d.accountId);
    meta.append(node('strong', d.name), node('span', `${account ? account.username + ' · ' : ''}${d.online ? '已连接' : '已配对'} · 最近访问 ${time(d.lastSeen)} · 到期 ${time(d.expiresAt)}`, 'subtle'));
    const revoke = node('button', '撤销访问', 'danger'); revoke.disabled = busy; revoke.onclick = () => act('revoke', { id: d.id }); row.append(meta, revoke); devices.append(row);
  }
  if (!state.devices.length) devices.append(node('p', '尚未添加设备。开启连接后，添加你的手机或另一台电脑。', 'empty'));
  const accounts = $('accounts'); accounts.replaceChildren();
  for (const account of state.accounts ?? []) {
    const row = node('div', undefined, 'device'), meta = node('div');
    meta.append(node('strong', account.username), node('span', `${account.sessions} 个有效登录 · 创建于 ${time(account.createdAt)}`, 'subtle'));
    const revoke = node('button', '撤销账号', 'danger'); revoke.disabled = busy;
    revoke.onclick = () => { if (window.confirm(`撤销账号 ${account.username} 并断开其全部设备？之后需要配对码重新注册。`)) act('revoke-account', { id: account.id }); };
    row.append(meta, revoke); accounts.append(row);
  }
  if (!state.accounts?.length) accounts.append(node('p', '尚未设置账号。先在远端注册，即可跨地址登录。', 'empty'));
}
function countdown() {
  if (!state?.pairing) return;
  const seconds = Math.max(0, Math.ceil((state.pairing.expiresAt - Date.now()) / 1000));
  $('expires').textContent = seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后过期` : '配对码已过期';
}
async function act(action, data) {
  busy = true; error(''); if (state) render();
  try { state = await api(action, data); }
  catch (e) { error(e.message); }
  finally { busy = false; if (state) render(); }
}
$('start').onclick = () => act('start', { addresses: [...selected] });
$('stop').onclick = () => act('stop');
$('add').onclick = () => act('pair');
$('cancel').onclick = () => act('cancel-pair');
async function refresh() {
  if (busy || document.hidden) return;
  try { state = await api(); render(); if (state.error) error(state.error); }
  catch (e) { error(e.message); }
}
refresh(); setInterval(refresh, 5000); setInterval(countdown, 1000);
