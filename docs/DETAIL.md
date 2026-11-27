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

## 限制

- Windows 上 `cloudflared` 没有自动更新机制，更新通过重新下载官方二进制完成。
- 快速隧道的临时域名由 Cloudflare 自动分配，无法自定义。
- DNS 路由需要有效的 Cloudflare 登录（API token 走 `cloudflared tunnel route dns`）。
