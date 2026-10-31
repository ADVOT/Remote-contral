# Remote-control

用于 **DeepSeek Harness（DSH）** 的远程连接插件。通过手机或另一台电脑的浏览器，访问本机 DSH 的会话、任务与审批；任务仍在运行 DSH 的电脑上执行。

## 功能

- 局域网访问，或通过 Tailscale / Radmin VPN 跨网络连接。
- 一次性配对码、设备管理与访问撤销。
- 本地账号密码登录，切换 Wi-Fi / Tailscale / Radmin VPN 地址后可使用同一账号。
- 密码采用独立随机盐与 scrypt 派生，设备凭据仅保存哈希，并限制登录尝试频率。

## 安装

目前面向 **Windows / DSH 0.2.1-rc.2**，插件版本为 **0.2.2**。DSH 插件接口仍可能随版本变化。

1. 下载或克隆本仓库。
2. 先启动过一次 DSH，再双击 `Install.cmd`。
3. 安装后正常重启 DSH，在侧边栏打开「连接」。

安装器会备份已有配置与连接状态，再把插件安装到当前用户的 `Documents/deepseek-harness/plugins/dsh-connect`。不修改 DSH 安装目录，不自动结束任务或更改防火墙。首次安装时远程访问默认关闭。

## 使用

1. 在电脑 DSH 的「连接」中选择联网网卡，点击「开启连接」。
2. 远端浏览器打开页面显示的完整地址。
3. 电脑点击「添加设备」，远端使用一次性配对码连接，或用配对码注册账号。
4. 已配对设备可在远端侧边栏「连接账号」设置账号；之后换地址只需账号密码登录。

账号为 3–32 位英文字母、数字或 `. _ -`，不区分大小写；密码为 12–128 个字符。配对码默认十分钟有效、只能使用一次；登录默认三十天有效。忘记密码时，可在电脑上撤销账号后重新配对注册。

跨网络使用时，两端登录同一个 [Tailscale 私有网络](https://tailscale.com/docs/how-to/connect-to-devices)，电脑选择 Tailscale 的 `100.x` 地址，远端打开显示的 IP 和端口。当前仅支持 IP 入口，不支持 MagicDNS、Tailscale Serve 子路径或任意代理域名。电脑与 DSH 必须保持运行。

连接超时时，检查两端在线状态、Tailscale 访问规则与 Windows 防火墙。局域网 / Tailscale 需要放行默认 TCP 3940 时，可在管理员 PowerShell 运行 `Enable-LanAccess.ps1`；默认模式仅允许本地子网和 Tailscale 地址段，不关闭防火墙。

### 两台电脑通过 Radmin VPN 连接

1. 两台 Windows 电脑安装并启动 [Radmin VPN](https://www.radmin-vpn.com/help/)。一台选择「创建网络」，设置私人网络名称和密码；另一台选择「加入网络」，输入相同的名称和密码。确认双方在该网络中在线。
2. 在被控电脑安装本插件并运行 DSH，在「连接」中勾选标为 **Radmin VPN** 的 `26.x.x.x` 地址，点击「开启连接」。
3. 控制电脑用浏览器打开页面显示的 `http://26.x.x.x:3940/`，使用 DSH 连接账号登录，或用被控电脑生成的一次性配对码注册。只控制对方时，控制电脑无需安装 DSH。
4. 如果需要双向控制，两台都安装本插件、各自开启连接并分别配对；每台电脑有独立的 DSH 连接账号。Radmin 网络密码与 DSH 连接密码分别设置。

若浏览器超时，在**被控电脑**的插件文件夹打开管理员 PowerShell，执行：

```powershell
.\Enable-LanAccess.ps1 -Radmin
```

该模式创建或更新独立的 Radmin 规则，仅放行当前在线 Radmin 网卡本机地址的 TCP 3940，来源限于 `26.0.0.0/8`，不放开其他网卡。`-Port` 可指定自定义端口，但需与插件配置一致；网卡地址变化后重新运行此命令。也可加 `-RadminPeerAddress` 指定控制电脑的实际 Radmin IPv4 地址，让这条专用规则只允许该电脑；其他已有规则仍可能独立放行。加 `-WhatIf` 可先预览而不修改防火墙。

若系统阻止脚本运行，可使用 `powershell -ExecutionPolicy Bypass -File .\Enable-LanAccess.ps1 -Radmin`，只对本次进程生效。插件不会代替你加入 Radmin 网络，也不会自行更改防火墙。

## 隐私与权限

- 账号属于这台 DSH 电脑，不是 DeepSeek 账号；插件不连接独立云中继。
- **所有配对设备和账号均具有本机用户的 DSH 操作能力**，请只授权可信设备。
- 普通局域网 HTTP 没有 TLS 加密；跨网络请使用 Tailscale 或 [Radmin VPN 加密通道](https://www.radmin-vpn.com/security/)，也可在插件配置中提供 `tls.certFile` / `tls.keyFile` 启用 HTTPS。
- 状态保存在 `DSH_HOME/dsh-connect/state.json`；默认 `DSH_HOME` 为当前用户的 `~/.dsh`。不要公开此文件、备份、Cookie、配对码、证书私钥或带令牌的链接。
- 本仓库不包含实际账号、设备状态、日志、截图或本机配置。测试里的账号、密码和地址都是合成夹具。
- 撤销设备会断开该登录；撤销账号会断开其全部登录。已开始的任务不会因此自动取消。

先在连接页关闭远程访问，再运行 `Disable.ps1` 并重启 DSH，可停用插件；脚本保留文件和设备记录。

## 开发

使用支持 `node --test` 的现代 Node.js，无第三方运行依赖：

```sh
npm run check
npm test
```

自动测试覆盖配对、账号登录、不同地址登录、撤销、HTTP / WebSocket 转发、Radmin 网卡识别及网卡失效后的选择恢复。已在真实 DSH 运行时检查注册与页面访问；这不代表所有设备、网络及模型任务都已验收，也不代表已从第二台电脑完成 Radmin 跨网络验收。移动端进入后的主界面沿用 DSH 本身。

实现使用 [DSH 官方插件接口](https://github.com/deepseek-ai/deepseek-harness)，架构参考 [Kimi Code 的公开远程控制实现](https://github.com/MoonshotAI/kimi-code/tree/main/packages/remote-control)，未复制其云服务或账号体系。

MIT License，见 [LICENSE](LICENSE)。
