# Turnfold

[English](README.md) | 简体中文

[项目主页](https://liooil.github.io/turnfold/) · [使用文档](README.zh-CN.md)

可直接打开完整的本地优先 Web App：<https://liooil.github.io/turnfold/app/>。它不依赖 Turnfold 后端；配置一个浏览器可访问的 Provider 后即可开始聊天。

Provider 必须允许来自 Pages 域名的浏览器请求。本地模型服务还可能需要浏览器的本地网络访问权限，以及显式的 CORS/Origin 白名单。

Turnfold 是一个本地优先、用于管理分支式 AI 对话的仓库。

消息是不可变的内容寻址对象。一个会话只是指向当前消息的轻量引用，因此编辑消息和重新生成回答会创建不同的后续路径，而不是覆盖历史。浏览器首先使用本地仓库完成渲染；只有用户显式连接 Backend URL 后才会进行同步。

> Turnfold 是从实际运行的个人部署中拆分出来的早期开源版本。在 v1 之前，存储和同步格式仍可能发生变化。

## 主要特性

- 基于 IndexedDB 的本地优先仓库，支持离线渲染和待同步队列。
- 不可变消息、具名会话引用、分支导航和引用日志历史。
- 多个可持久化草稿，以及可恢复的助手流式回答。
- 从内嵌 Models.dev 子集生成不含凭据的 Provider 连接配置；所有 Provider 默认禁用。
- 内嵌 Models.dev 的 12 个精选模型；完整目录只会在用户明确点击后下载或更新，并保存在当前浏览器。
- 支持浏览器直连的自定义 Provider 与内嵌 Provider 本地配置；凭据不会进入内嵌目录。
- Provider 默认使用两步式简单配置：从模型目录选择并填写凭据，或只输入 URL 与 Key 自动探测；原有完整表单保留为进阶配置。
- 使用手写 SSE 客户端支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI 协议。
- 支持原生归档，以及 Codex CLI、Claude Code 和 OMP JSONL 格式的导入与导出。
- 支持从多个文件、ZIP 压缩包或只读本地目录批量导入。
- 面向稳定流式布局设计的增量 Markdown 和 MathJax 渲染。
- 可安装的 PWA，以及轻量的 Bun/SQLite 同步服务器。
- 显式、基于 URL 的 Backend 连接；提供页面本身不会授予 Backend 读取浏览器数据的权限。

Turnfold 当前规定每条消息只有一个父消息。因此它形成的是分支式消息历史，而不是通用的多父节点 DAG，也不是 Git 的实现。

## 快速开始

需要安装带有 Compose 插件的 Docker，并准备一个允许当前浏览器发起请求的 AI 端点。

```sh
docker compose up --build -d
```

打开 <http://localhost:3000>，检查并保存一个内嵌 Provider 以将其启用，或者添加自定义 Provider。模型 ID 可以手动填写，也可以刷新模型列表。

默认 Compose 配置使用 `AUTH_MODE=single-user`，只适合 localhost 或可信私有网络。不要把该模式直接暴露到公网。

## 开发

```sh
bun install
bun run dev
```

常用检查命令：

```sh
bun run typecheck
bun test
bun run build
docker compose config
```

源码依赖方向固定为 `client -> shared <- server`。模块职责与兼容边界见 [docs/architecture.md](docs/architecture.md)。

Rust 可执行文件、Backend 授权模型、Provider/Vault 边界与 WebDAV 适配器见 [docs/local-service.md](docs/local-service.md)。

`bun run dev` 会启动 Bun 的 fullstack 开发服务器（`Bun.serve` 且 `development: true`）。它通过 Bun 的 HTML bundle 直接提供 `src/index.html`，并直接读取源码依赖中的 public 和 MathJax 资源，因此前端改动会热更新，不需要运行 `build` 或 `build:pages`。

开发服务器默认监听 `3000` 端口，可通过 `PORT` 修改。

Rust runtime 可以同时提供生产前端和 SQLite 同步 Backend，但不会因此自动把前端连接到该 Backend：

```sh
bun run build
cargo run -p turnfold -- serve --listen 127.0.0.1:3000 --static-dir dist --database turnfold.db --vault-keyring default
```

能力发现端点为 `/api/local/v1/info`。只有用户显式连接原生 Backend 或 WebDAV Root 后，仓库才会同步；页面由该服务提供并不代表已连接。跨域原生同步与 Turnfold `/dav` 入口分别使用绑定 Origin 的 `repository.sync` 和 `repository.webdav` Grant。标准远程 WebDAV 可使用 Basic 或无认证模式，但服务端必须提供浏览器兼容的 CORS。设置 `--vault-keyring` 会启用独立配对的 Provider Agent 与加密 Vault，且不提供明文凭据解析。`--vault-key-file` 仍是显式 fallback，但 runtime 绝不会在两种密钥来源之间静默降级。Rust runtime 默认只监听 loopback，使用 `single-user` 和 `turnfold.db`。

将已有 key file 迁移进 OS keyring 时，应先停止服务，再运行以下非破坏命令。Turnfold 会先用数据库验证密钥，且不会删除源文件：

```sh
turnfold vault migrate-key --database turnfold.db \
  --from-key-file turnfold.vault.key --to-keyring default
```

Release archive 包含 `turnfold`（Windows 为 `turnfold.exe`）、构建后的 `dist/` 和 `service/` 安装器。Windows 运行 `service/install-task.ps1`，Linux 运行 `service/install-systemd-user.sh`，macOS 运行 `service/install-launchagent.sh`。这些安装器使用当前用户的 OS keyring 和服务管理器；卸载脚本默认只移除服务托管，保留数据库与 keyring。发布包中的 executable 会自动查找同级的 `dist/`。

原生 DAV 客户端还可以连接一个可选的、挂载在根路径的独立 listener：

```sh
cargo run -p turnfold -- serve --webdav-listen 127.0.0.1:3001 \
  --webdav-username turnfold --webdav-password-file webdav.password
```

该 listener 仅支持 `single-user` 模式并要求 Basic 认证；它拒绝带浏览器 `Origin` 的请求，明文 HTTP 只适合 loopback。全部监听、数据库、Vault 与认证参数见 `turnfold serve --help`；DAV namespace、ETag 规则和 working snapshot 策略见 [docs/local-service.md](docs/local-service.md#repository-service-and-webdav)。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口。 |
| `BASE_PATH` | `/` | 运行时 URL 前缀；必须与同名 Docker 构建参数一致。 |
| `HOME_URL` | 应用根路径 | 构建时设置的 Turnfold 标志跳转地址。 |
| `CHAT_DATABASE_PATH` | `/data/turnfold.db` | SQLite 同步数据库。 |
| `AUTH_MODE` | `forward-auth` | 可信本地环境使用 `single-user`；身份感知代理后方使用 `forward-auth`。 |
| `SINGLE_USER_NAME` | `local` | 单用户模式显示的用户名。 |
| `AUTH_ISSUER` | `turnfold:forward-auth` | 转发身份的稳定 issuer 标识。 |
| `PORTAL_URL` | 空 | 可选的兼容身份资料接口。 |
| `BACKEND_ALLOWED_ORIGINS` | 空 | 允许连接此 Bun Backend 的浏览器精确 Origin，多个值以逗号分隔。 |

`forward-auth` 接受 `X-Turnfold-Username` 和 `X-Turnfold-Sub`。为保持兼容，也支持 Authentik 的 `X-Authentik-Username` 和 `X-Authentik-Uid`。反向代理必须先移除客户端传入的不可信身份请求头，再写入自己的身份请求头。

上表描述现有 Bun/Docker 部署的默认值。Rust 支持 `CHAT_DATABASE_PATH`、`AUTH_MODE`、`SINGLE_USER_NAME` 和 `AUTH_ISSUER`；其本地默认值为 `turnfold.db` 与 `single-user`，监听地址通过 `--listen` 配置。

跨域 Backend 访问默认拒绝；页面 Origin 必须精确列入白名单，例如 `BACKEND_ALLOWED_ORIGINS=https://liooil.github.io`。允许的响应会返回该精确 Origin 和 credentialed CORS，不接受通配符。同源访问以及不携带 `Origin` 的非浏览器客户端不受影响。

Rust Backend 支持同源的显式连接；跨域浏览器需要在独立 Backend 页面完成确认。Grant 仅包含 `repository.sync`，同时绑定精确页面 Origin 和 Backend 身份，90 天后过期，并可在 Backend 设置中撤销。反向代理部署必须通过 `--public-origin` 声明精确外部 Origin，并提供可信 HTTPS。

内嵌 Provider 及其模型完全由内嵌 Models.dev 子集生成；Turnfold 只补充浏览器运行时所需的协议、认证方式和 API 端点。它们不包含凭据，并且默认全部禁用。简单配置可直接选择内嵌或已下载目录中的 Provider 并填写凭据；也可只输入 URL 与 Key，让 Turnfold 探测协议和模型，并根据网页标题或域名生成标识与名称。进阶配置保留标识、协议、认证、端点、默认模型和附加 Headers 等全部字段。Provider 配置、模型覆盖、自定义配置、发现的模型列表、请求头和凭据都只保存在当前浏览器中。模型请求及探测请求由浏览器直接发送到所配置的端点，Bun 服务器不参与。Provider 因此必须允许 Turnfold 来源通过 CORS；访问局域网端点时，浏览器还可能请求本地网络访问权限。

Turnfold 内嵌来自 [Models.dev](https://models.dev/) 的 12 个精选模型元数据。完整 Models.dev 目录不会自动获取；用户可在 Provider 设置中明确点击下载或更新，数据随后保存在独立的浏览器 IndexedDB 中。下载的目录条目只会作为匹配 Provider 的模型模板，并且不包含任何凭据。

## 部署到子路径

构建参数和运行时环境必须使用相同的基础路径：

```sh
docker build --build-arg BASE_PATH=/turnfold -t turnfold .
docker run --rm -p 3000:3000 -e BASE_PATH=/turnfold -v turnfold-data:/data turnfold
```

然后打开 <http://localhost:3000/turnfold/>。

## 数据与兼容性

- 浏览器数据、Provider 配置和凭据保存在 IndexedDB 中，无需服务器也可以继续使用。
- 用户显式连接 Backend 后，引用和不可变对象才会同步；启动时不会自动联系任何 Backend。
- 用户显式连接 WebDAV 后，引用和不可变对象才会通过所选 DAV Root 同步；当前设备的工作项只作为恢复快照备份，不会合并进另一设备的活动编辑器。
- 完整备份使用 `*.turnfold.json`，其中 `type` 为 `"turnfold-archive"`、`version` 为 `1`。
- 原生备份包括消息对象、会话引用和工作草稿。

升级早期版本前请保留备份。

## 常见问题

### 在 GitHub Pages 上打开 Turnfold，访问局域网 HTTP 模型时报 Mixed Content，怎么办？

GitHub Pages 是 HTTPS 页面，浏览器会阻止它加载 `http://192.168.x.x:11434` 这类不安全资源。Service Worker 不能绕过这个限制。

建议的解决办法：

- 给局域网模型服务配置 HTTPS 反向代理（例如 Caddy/Nginx + mkcert），并在 Turnfold 中使用 `https://` 地址。
- 仅限本机调试时，可以在浏览器中允许该站点加载不安全内容。
- 如果主要在局域网内使用，也可以直接运行 Turnfold 并通过 `http://<局域网IP>:3000` 访问，而不是使用 GitHub Pages。

即使解决了 Mixed Content，局域网模型或代理还需要允许来自 Pages 域名的 CORS，并可能需要 `Access-Control-Allow-Private-Network: true`。


## 安全

不要提交 API Key、数据库或导出的对话归档。Provider 密钥保存在当前浏览器的 IndexedDB 中，绝不会发送给 Turnfold 服务器。与所有浏览器端密钥一样，同源脚本可以访问它们，因此部署时应使用严格的 CSP，并且只加载可信资源。

请按照 [SECURITY.md](SECURITY.md) 中的说明私下报告安全漏洞。

## 许可证

Turnfold 使用 MIT License，详见 [LICENSE](LICENSE)。
