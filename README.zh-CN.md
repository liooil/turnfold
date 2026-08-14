# Turnfold

[English](README.md) | 简体中文

[项目主页](https://liooil.github.io/turnfold/) · [使用文档](README.zh-CN.md)

可直接打开完整的本地优先 Web App：<https://liooil.github.io/turnfold/app/>。它不依赖 Turnfold 后端；配置一个浏览器可访问的 Provider 后即可开始聊天。

Provider 必须允许来自 Pages 域名的浏览器请求。本地模型服务还可能需要浏览器的本地网络访问权限，以及显式的 CORS/Origin 白名单。

Turnfold 是一个本地优先、用于管理分支式 AI 对话的仓库。

消息是不可变的内容寻址对象。一个会话只是指向当前消息的轻量引用，因此编辑消息和重新生成回答会创建不同的后续路径，而不是覆盖历史。浏览器首先使用本地仓库完成渲染；当服务器身份可用时，再在后台进行同步。

> Turnfold 是从实际运行的个人部署中拆分出来的早期开源版本。在 v1 之前，存储和同步格式仍可能发生变化。

## 主要特性

- 基于 IndexedDB 的本地优先仓库，支持离线渲染和待同步队列。
- 不可变消息、具名会话引用、分支导航和引用日志历史。
- 多个可持久化草稿，以及可恢复的助手流式回答。
- 内置不含凭据的 Provider 预置目录，来源于 KeyVault 并参考 OMP；所有预置都需要用户保存本地覆盖后才会启用。
- 内嵌 Models.dev 的 12 个精选模型；完整目录只会在用户明确点击后下载或更新，并保存在当前浏览器。
- 支持浏览器直连的自定义 Provider 与本地覆盖；凭据不会进入预置目录。
- 使用手写 SSE 客户端支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI 协议。
- 支持原生归档，以及 Codex CLI、Claude Code 和 OMP JSONL 格式的导入与导出。
- 支持从多个文件、ZIP 压缩包或只读本地目录批量导入。
- 面向稳定流式布局设计的增量 Markdown 和 MathJax 渲染。
- 可安装的 PWA，以及轻量的 Bun/SQLite 同步服务器。

Turnfold 当前规定每条消息只有一个父消息。因此它形成的是分支式消息历史，而不是通用的多父节点 DAG，也不是 Git 的实现。

## 快速开始

需要安装带有 Compose 插件的 Docker，并准备一个允许当前浏览器发起请求的 AI 端点。

```sh
docker compose up --build -d
```

打开 <http://localhost:3000>，检查并保存一个预置 Provider 的本地覆盖以将其启用，或者添加自定义 Provider。模型 ID 可以手动填写，也可以刷新模型列表。

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

开发服务器默认监听 `3000` 端口，可通过 `PORT` 修改。

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

`forward-auth` 接受 `X-Turnfold-Username` 和 `X-Turnfold-Sub`。为保持兼容，也支持 Authentik 的 `X-Authentik-Username` 和 `X-Authentik-Uid`。反向代理必须先移除客户端传入的不可信身份请求头，再写入自己的身份请求头。

内置预置目录只包含端点模板和模型 ID，不包含凭据，并且默认全部禁用。启用预置会创建同 ID 的本地覆盖。添加模型时，Turnfold 会列出尚未被同 ID 本地模型或发现模型覆盖的预置模型。Provider 覆盖、模型覆盖、自定义配置、发现的模型列表、请求头和凭据都只保存在当前浏览器中。模型请求由浏览器直接发送到所配置的端点，Bun 服务器不参与。Provider 因此必须允许 Turnfold 来源通过 CORS；访问局域网端点时，浏览器还可能请求本地网络访问权限。

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
- 已登录用户或单用户模式下的引用和不可变对象会同步到 SQLite。
- 完整备份使用 `*.turnfold.json`，其中 `type` 为 `"turnfold-archive"`、`version` 为 `1`。
- 旧的 `*.xiteng-chat.json` 归档仍然可以导入。
- 原生备份包括消息对象、会话引用和工作草稿。

升级早期版本前请保留备份。

## 安全

不要提交 API Key、数据库或导出的对话归档。Provider 密钥保存在当前浏览器的 IndexedDB 中，绝不会发送给 Turnfold 服务器。与所有浏览器端密钥一样，同源脚本可以访问它们，因此部署时应使用严格的 CSP，并且只加载可信资源。

请按照 [SECURITY.md](SECURITY.md) 中的说明私下报告安全漏洞。

## 许可证

Turnfold 使用 MIT License，详见 [LICENSE](LICENSE)。
