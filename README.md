# Cloudflared Tunnel 管理（DSH 插件）

从 DeepSeek Harness（DSH）左侧栏管理本机的 `cloudflared` CLI 与 Cloudflare Tunnel。提供一个始终中文、跟随主题的工作台面板，并把同样的能力注册为 Agent 工具 `cloudflared`。

## 功能

- **环境**：检测安装状态与版本、下载安装官方 CLI（带进度）、检查更新 / 升级到最新版、打开登录页面（`tunnel login`，自动捕获并打开授权链接）。
- **命名隧道**：列出（结构化展示名称 / ID / 创建时间）、创建、重命名、删除、后台启动 / 停止、配置 DNS 路由。
- **Ingress 路由**：读取 / 编辑隧道的远端 Ingress 规则（Hostname → 本地服务），支持 `httpHostHeader` 重写以修复后端 `Invalid Host header`；保存后自动重启连接器使配置生效。
  - 凭据直接取自 `cloudflared login` 生成的 `cert.pem`（其中是 ARGO TUNNEL TOKEN，内含可用的 Cloudflare API token），无需另外配置 API Token。
- **快速隧道**：一键启动 `trycloudflare.com` 临时公网地址；可指定本地端口与重写 Host（自动规范化域名 / URL → 主机名）。
- **config.yml**：查看与编辑本地隧道配置文件。
- **命令速查**：常用命令模板与安全的 argv 执行器（非 shell、带超时与输出上限）。
- **Agent 工具**：所有能力以 Host 工具 `cloudflared` 注册，供智能体调用。

## 安装

在 DSH 中通过插件管理器安装本目录：

1. 打开 DSH → 插件 → 安装本地插件（Bundle）。
2. 选择本仓库目录（包含 `package.json` / `index.js` / `client.js`）。
3. 安装后左侧栏出现 **Cloudflared** 入口，点击打开面板。

或使用插件管理器命令：

```text
install_bundle target=<本目录绝对路径>
```

## 使用前提

1. 在「环境」页安装 cloudflared CLI（Windows 会下载到 `~/.cloudflared/cloudflared.exe`）。
2. 点击「打开登录页面」完成 Cloudflare 授权，生成 `cert.pem`。
3. 命名隧道相关操作（DNS 路由、Ingress、启动）需要已登录；快速隧道无需登录。

## 安全约定

- 只有**删除隧道**需要二次确认（带一次性 token、5 分钟有效、绑定操作与参数）。
- 所有命令都用 argv 数组 `spawn` 执行，不经过 shell；默认 30 秒超时、输出上限 1MB。
- API / Tunnel 凭据只在运行时从本地 `cert.pem` 读取，不写入插件配置、不随代码分发。
- 隧道进程由插件托管，可在 UI 中停止。

## 目录结构

```text
index.js            Host 端：HTTP JSON 路由 + cloudflared Agent 工具 + 命令调度
client.js           Web 端：侧栏图标 + 主面板 + 各功能 Tab（React，无 JSX）
cordis.patch.yml    静态 Bundle 注入声明
locale/zh.json      中文文案
locale/en.json      英文文案（面板固定中文，便于国际化扩展）
icon.svg            侧栏图标
docs/DETAIL.md      功能详情
```

## 已知限制

- cloudflared **不会热加载**远端 Ingress 配置：修改后需重启连接器；本插件在保存 Ingress 后会自动重启正在运行的隧道。
- 快速隧道的临时域名由 Cloudflare 自动分配，无法自定义。
- 面板在会话内无法做 GUI 可视验证，改动后请刷新 DSH 界面查看。

## 许可

MIT
