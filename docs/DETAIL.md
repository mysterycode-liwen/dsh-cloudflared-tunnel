# Cloudflared Tunnel 管理

从 DSH 左侧栏管理本机的 `cloudflared` CLI 与 Cloudflare Tunnel。

## 功能

- **环境**：检测安装状态与版本、下载安装官方 CLI、检查更新、查看登录状态（`cert.pem`）。
- **命名隧道**：列出、创建、重命名、删除、后台启动/停止，并支持配置 DNS 路由。
- **快速隧道**：一键启动 `trycloudflare.com` 临时公网地址，无需登录。
- **config.yml**：查看与编辑本地隧道配置文件。
- **命令速查**：常用命令模板与安全的 argv 执行器（非 shell、带超时与输出上限）。
- **Agent 工具**：相同能力以 Host 工具注册，供智能体调用。

## 安全约定

- 所有写入/删除/暴露公网的操作都需要**二次确认**；Agent 调用同样受此约束，不会被绕过。
- 凭据仅保存在系统凭据保险箱，不写入插件配置。
- 命令执行使用 argv 数组（`spawn`），不经过 shell；默认 30 秒超时、输出上限 1MB。
- 隧道进程由插件托管，可在 UI 中停止；关闭 DSH 时进程随插件清理。

## 平台与架构

安装按 `process.platform` + `process.arch` 选择官方产物，而不是只按操作系统：

| 平台 | 架构 | 下载产物 | 落地方式 |
| --- | --- | --- | --- |
| Windows | x64 / arm64 | `cloudflared-windows-amd64.exe` | 直接写入 `~/.cloudflared/cloudflared.exe` |
| Windows | ia32 | `cloudflared-windows-386.exe` | 同上 |
| Linux | x64 | `cloudflared-linux-amd64` | 直接写入 `~/.cloudflared/cloudflared` |
| Linux | arm64 / arm / ia32 | `cloudflared-linux-arm64` / `-arm` / `-386` | 同上 |
| macOS | x64 / arm64 | `cloudflared-darwin-amd64.tgz` / `-arm64.tgz` | 下载后解包 `.tgz`，取出 `cloudflared` |

- 未知平台/架构不会静默装错，面板会显示「当前平台无官方构建」并禁用安装按钮，给出官方手动安装链接。
- 只有非 Windows 平台会 `chmod 0o755`；Windows 不支持该权限位，跳过。
- Windows 覆盖已有 `cloudflared.exe` 时若被运行中的进程占用，会返回可读提示，而不是裸 errno。

## 限制

- Windows 上 `cloudflared` 没有自动更新机制，更新通过重新下载官方二进制完成。
- Windows 无原生 arm64 构建，arm64 机器使用 x64 产物（由系统模拟执行）。
- 快速隧道的临时域名由 Cloudflare 自动分配，无法自定义。
- DNS 路由需要有效的 Cloudflare 登录（API token 走 `cloudflared tunnel route dns`）。
