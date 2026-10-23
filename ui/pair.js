const $ = id => document.getElementById(id);
const form = $('pair-form'), error = $('error'), submit = $('submit');
let mode = 'login', status = { paired: false }, busy = false, chosen = false;
const titles = { login: '登录并进入 DSH', register: '创建账号并进入 DSH', pair: '配对并进入 DSH' };
function render() {
  const account = mode !== 'pair', register = mode === 'register';
  $('account-fields').hidden = !account;
  for (const id of ['username', 'password']) { $(id).disabled = !account; $(id).required = account; }
  $('confirm-field').hidden = !register; $('confirm').disabled = !register; $('confirm').required = register;
  const needsCode = mode === 'pair' || (register && !status.paired);
  $('code-field').hidden = !needsCode; $('code').disabled = !needsCode; $('code').required = needsCode;
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('mode-help').textContent = register ? status.paired ? '这台设备已配对，可以直接设置账号，之后跨地址登录。' : '首次注册需要电脑上的配对码。之后更换地址只需账号密码。' : mode === 'pair' ? '只配对这台设备。想跨地址登录，可选择注册账号。' : '换了 Wi-Fi、Tailscale 或 Radmin VPN 地址？使用同一个账号登录。';
  submit.textContent = titles[mode];
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    button.disabled = busy || (button.dataset.mode === 'register' && Boolean(status.username));
  }
  $('session').hidden = !status.paired;
  $('logout').disabled = busy;
  $('session-text').textContent = status.username ? `当前账号：${status.username}` : '这台设备已配对。设置账号后，换网络地址也能登录。';
}
for (const button of document.querySelectorAll('[data-mode]')) button.onclick = () => {
  chosen = true; mode = button.dataset.mode; error.hidden = true; $('password').value = ''; $('confirm').value = ''; render();
};
async function post(route, data) {
  const response = await fetch('/__dsh_connect/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '连接失败，请重试');
  return value;
}
function enter() { window.top.location.replace('/'); }
form.addEventListener('submit', async event => {
  event.preventDefault(); error.hidden = true;
  if (mode === 'register' && $('password').value !== $('confirm').value) { error.textContent = '两次输入的密码不一致'; error.hidden = false; $('confirm').focus(); return; }
  busy = true; render(); submit.disabled = true; submit.textContent = '正在连接…';
  try {
    await post(mode, { name: $('name').value, code: $('code').value.replace(/[\s-]/g, ''), username: $('username').value, password: $('password').value });
    $('password').value = ''; $('confirm').value = ''; enter();
  } catch (e) {
    error.textContent = e.message; error.hidden = false;
  } finally { busy = false; submit.disabled = false; render(); }
});
$('logout').onclick = async () => {
  try { await post('logout', {}); window.top.location.replace('/__dsh_connect/login'); }
  catch (e) { error.textContent = e.message; error.hidden = false; }
};
fetch('/__dsh_connect/status', { cache: 'no-store' }).then(async response => {
  if (!response.ok) throw new Error('无法读取设备状态，请刷新重试');
  status = await response.json();
  if (status.name) $('name').value = status.name;
  if (status.username) $('username').value = status.username;
  if (!chosen && status.paired && !status.username) mode = 'register';
  render();
}).catch(e => {
  error.textContent = e.message; error.hidden = false;
});
render();
