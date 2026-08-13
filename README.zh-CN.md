# Turnfold

[English](README.md) | 简体中文

[项目主页](https://liooil.github.io/turnfold/) · [使用文档](README.zh-CN.md)

Turnfold 是一个本地优先、用于管理分支式 AI 对话的仓库。

消息是不可变的内容寻址对象。一个会话只是指向当前消息的轻量引用，因此编辑消息和重新生成回答会创建不同的后续路径，而不是覆盖历史。浏览器首先使用本地仓库完成渲染；当服务器身份可用时，再在后台进行同步。

> Turnfold 是从实际运行的个人部署中拆分出来的早期开源版本。在 v1 之前，存储和同步格式仍可能发生变化。

## 主要特性

- 基于 IndexedDB 的本地优先仓库，支持离线渲染和待同步队列。
- 不可变消息、具名会话引用、分支导航和引用日志历史。
- 多个可持久化草稿，以及可恢复的助手流式回答。
- 同时支持浏览器直连和服务端模型 Provider。
- 支持 OpenAI、Anthropic、Google、OpenAI-compatible、Ollama、llama.cpp、LM Studio 和 vLLM。
- 支持原生归档，以及 Codex CLI、Claude Code 和 OMP JSONL 格式的导入与导出。
- 支持从多个文件、ZIP 压缩包或只读本地目录批量导入。
- 面向稳定流式布局设计的增量 Markdown 和 MathJax 渲染。
- 可安装的 PWA，以及轻量的 Bun/SQLite 同步服务器。

Turnfold 当前规定每条消息只有一个父消息。因此它形成的是分支式消息历史，而不是通用的多父节点 DAG，也不是 Git 的实现。

## 快速开始

需要安装带有 Compose 插件的 Docker，并在打开浏览器的设备上运行 Ollama、LM Studio 等模型服务。

```sh
docker compose up --build -d
```

打开 <http://localhost:3000>。在模型设置中选择本地 Provider；如有需要，可调整浏览器能够访问的 Base URL。

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

开发服务器默认监听 `3000` 端口，可通过 `PORT` 修改。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口。 |
| `BASE_PATH` | `/` | 运行时 URL 前缀；必须与同名 Docker 构建参数一致。 |
| `HOME_URL` | 应用根路径 | 构建时设置的 Turnfold 标志跳转地址。 |
| `CHAT_DATABASE_PATH` | `/data/turnfold.db` | SQLite 同步数据库。 |
| `PUBLIC_PROVIDER_CATALOG_FILE` | `providers.json` | 暴露给浏览器的 Provider 目录。 |
| `AUTH_MODE` | `forward-auth` | 可信本地环境使用 `single-user`；身份感知代理后方使用 `forward-auth`。 |
| `SINGLE_USER_NAME` | `local` | 单用户模式显示的用户名。 |
| `AUTH_ISSUER` | `turnfold:forward-auth` | 转发身份的稳定 issuer 标识。 |
| `ACCOUNT_URL` | 空 | 可选的账户及 Provider 管理页面链接。 |
| `PORTAL_URL` | 空 | 可选的兼容身份资料接口。 |
| `KEY_VAULT_URL` | 空 | 可选的 Turnfold 兼容后端凭据服务。 |
| `KEY_VAULT_TOKEN_FILE` | 空 | 凭据服务使用的服务令牌文件。 |

`forward-auth` 接受 `X-Turnfold-Username` 和 `X-Turnfold-Sub`。为保持兼容，也支持 Authentik 的 `X-Authentik-Username` 和 `X-Authentik-Uid`。反向代理必须先移除客户端传入的不可信身份请求头，再写入自己的身份请求头。

编辑 [providers.json](providers.json) 可以修改浏览器直连 Provider。Provider 凭据和端点覆盖配置只保存在当前浏览器中。

## 部署到子路径

构建参数和运行时环境必须使用相同的基础路径：

```sh
docker build --build-arg BASE_PATH=/turnfold -t turnfold .
docker run --rm -p 3000:3000 -e BASE_PATH=/turnfold -v turnfold-data:/data turnfold
```

然后打开 <http://localhost:3000/turnfold/>。

## 数据与兼容性

- 浏览器数据保存在 IndexedDB 中，无需服务器也可以继续使用。
- 已登录用户或单用户模式下的引用和不可变对象会同步到 SQLite。
- 完整备份使用 `*.turnfold.json`，其中 `type` 为 `"turnfold-archive"`、`version` 为 `1`。
- 旧的 `*.xiteng-chat.json` 归档仍然可以导入。
- 原生备份包括消息对象、会话引用和工作草稿。

升级早期版本前请保留备份。

## 安全

不要提交 API Key、数据库、代理令牌或导出的对话归档。浏览器直连 Provider 的密钥保存在本地 IndexedDB 凭据库中。服务端密钥需要由外部凭据服务管理，不会保存在 Turnfold 的对话数据库中。

请按照 [SECURITY.md](SECURITY.md) 中的说明私下报告安全漏洞。

## 许可证

Turnfold 使用 MIT License，详见 [LICENSE](LICENSE)。
