# FileSystemStorage 设计（本地文件夹即仓库）

> 状态：设计草案，随 `docs/storage-architecture.md` 评审。
> 三端同语义：浏览器（File System Access API）/ Bun（node:fs）/ Rust（native path 或 `service` 场景）共享同一目录布局与写入协议。

## 1. 定位与总则

- 一个目录 = 一个 Turnfold 仓库（类似 `.git` 目录之于 git 工作区，但这里目录本身就是仓库根，不要求父目录是项目目录）。
- **对象文件即内容寻址对象**：文件名 = 对象内容哈希的十六进制（`sha256:xxx`），与 IndexedDB/SQLite 中存的对象完全同一字节格式，天然去重、幂等、可跨端校验。
- **可移植性优先于紧凑性**：牺牲打包/压缩，换来"任何实现打开同一目录都能工作"与"人类/脚本可读、可审计"。极端（图片 base64）才考虑按文件存储（见 §4）。
- 低端环境约束：单目录文件数、文件名长度、跨平台字符（Windows 保留名、大小写不敏感 FS）在路径编码规则中统一处理。

## 2. 目录布局

```text
<repo-root>/
├── turnfold.json                 # 仓库 manifest（必须存在）
├── meta/
│   └── storage.json              # 本实现实例状态（可选）
├── objects/
│   ├── 2f/                       # 内容寻址对象，按哈希前 2 位分片（256 个子目录）
│   │   ├── 1b9c4b…（sha256 剩余 62 位）.json
│   │   └── …
│   └── ab/
├── refs/
│   ├── <conversation-id>.json    # 会话引用（head 指针 + 版本，CAS 更新）
│   └── …
├── working/
│   └── <device-id>/              # 设备级工作区（草稿/流式回答）
│       ├── <item-id>.json
│       └── …
├── credentials/                  # 可选：默认不写入公共目录（信任模型 §5）
│   └── <provider-id>__<name>.json
└── .tmp/                         # 原子写临时区（尽量与数据同卷）
```

**路径编码规则**（与 WebDAV/S3 的 keyspace 一致，仅编码不同）：

| 键 | 文件路径 |
| --- | --- |
| `objects/sha256:<64hex>` | `objects/<前2hex>/<后62hex>.json` |
| `refs/<id>` | `refs/<id>.json`（id 已清洗：`[a-z0-9._-]`，否则哈希命名 + manifest 映射） |
| `working/<deviceId>/<itemId>` | `working/<deviceId>/<itemId>.json` |
| `credentials/<providerId>/<name>` | `credentials/<providerId>__<name>.json`（`/`→`__`，Windows 保留名转义） |

**为什么 objects 两级分片**：单目录 >1 万文件时常见文件系统检索/备份性能显著下降（NTFS/ext4 均如此）；256 个子目录对偶发全量枚举友好（`list("objects/")` 扫 256 目录 × 各自文件）。

## 3. 文件规格与示例

### 3.1 `turnfold.json`（仓库 manifest，必写一次）

```jsonc
{
  "schemaVersion": 1,                       // 布局版本，硬性升级点
  "repositoryId": "sha256:9f1c…",           // 仓库身份（首次初始化生成，稳定）
  "name": "home",                           // 用户可读名称，可选
  "trust": "plaintext",                     // plaintext | vault | none（见 §5）
  "createdAt": "2026-08-22T10:00:00.000Z",
  "updatedAt": "2026-08-22T10:00:00.000Z"   // 随任何写入刷新（节流，见 §6）
}
```

量级：**约 250–350 B**。读：每次挂载/启动一次；写：初始化一次 + `updatedAt` 节流刷新（≥30s 间隔，见 §6）。

### 3.2 `objects/<shard>/<hash>.json`（不可变消息对象）

与现有 `StoredChatMessage` 完全同构（`message-object.ts` 的规范化 JSON 序列化），示例：

```jsonc
{
  "id": "sha256:2f1b9c…",
  "parentMessageId": "sha256:8d20…” || null,
  "role": "assistant",
  "parts": [
    {"type": "reasoning", "text": "用户问的是部署问题，我先检查 Dockerfile……", "signature": "eyJhb…" },
    {"type": "text", "text": "首先需要确认 compose.yml 的网络配置……"},
    {"type": "tool-call", "id": "toolu_01", "name": "Read", "arguments": {"file_path": "compose.yml"}}
  ],
  "origin": {"type": "model", "providerId": "anthropic", "model": "claude-sonnet-4-5", "attemptId": "…"},
  "completion": {"status": "complete", "reason": "stop"},
  "createdAt": "2026-08-22T10:02:11.000Z",
  "completedAt": "2026-08-22T10:02:31.000Z",
  "metadata": {"custom": {"response": {"providerId": "anthropic", "model": "…", "durationMs": 19837, "outputTokens": 812}}}
}
```

量级：

| 内容 | 典型 | 上限/极端 |
| --- | --- | --- |
| 纯文本消息（100–2000 token） | **2–8 KB** | 长回复 100 KB |
| 推理（thinking）文本 | 1–20 KB | 200 KB |
| 工具调用 arguments | 200 B–2 KB | 10 KB |
| 工具结果（日志/输出） | 1–50 KB | **5 MB**（如长测试输出） |
| 内嵌图片（base64） | 50 KB–1 MB | **5–15 MB**（多图/高分辨率） |
| 元数据（usage/时长） | 300–800 B | 2 KB |

读：渲染历史时按需；写：**每轮对话 2–4 次**（user + assistant，可能含 reasoning/工具调用拆分为独立对象）。**不可变、幂等**：同一内容重复写 = 跳过，不会产生新文件。

### 3.3 `refs/<conversation-id>.json`（会话引用，CAS）

即 `ConversationRefState` 序列化：

```jsonc
{
  "id": "sha256:3c0d…",
  "name": "修复登录问题",
  "headMessageId": "sha256:2f1b…",
  "providerId": "anthropic",
  "model": "claude-sonnet-4-5",
  "generationSettings": {"reasoning": "auto", "showReasoningSummary": false, "temperature": null, "maxOutputTokens": null},
  "headVersion": 42,
  "metadataVersion": 3,
  "createdAt": "2026-08-20T09:00:00.000Z",
  "updatedAt": "2026-08-22T10:02:31.000Z"
}
```

量级：**约 400–700 B**（随名称/模型 ID 长度浮动）。
**读频率最高**：每次打开会话、切换分支、历史列表刷新都会读（列表=枚举 refs 目录 + 单文件读）。**写频率低但必须原子**：提交消息/移动 head 每轮 1–2 次，**必须带 `expectedHeadVersion` CAS**（见 §6）。

### 3.4 `working/<device-id>/<item-id>.json`（草稿与未完成工作）

```jsonc
{
  "id": "wk-01",
  "conversationId": "sha256:3c0d…",
  "kind": "assistant-stream",
  "observedHeadId": "sha256:2f1b…",
  "parts": [{"type": "text", "text": "正在生成的回答前半段……"}],
  "status": "streaming",
  "attemptId": "…",
  "providerId": "anthropic",
  "model": "claude-sonnet-4-5",
  "createdAt": "2026-08-22T10:02:10.000Z",
  "updatedAt": "2026-08-22T10:02:18.000Z"
}
```

量级：**1–50 KB**（草稿几乎就是消息的 parts；流式中途可能含部分推理/文本）。
**读写频率最高**：流式期间 **每 1–2 s 写一次**（节流合并，见 §6）；恢复时按 device-id 目录枚举读取。崩溃恢复语义：`updatedAt` 超过阈值（如 30 min）视为孤儿，UI 提示清理。

### 3.5 `credentials/<provider-id>__<name>.json`

```jsonc
{
  "providerId": "anthropic",
  "name": "default",
  "secret": {"apiKey": "sk-ant-…"},       // trust=plaintext 时明文；public 仓库强制信封加密
  "createdAt": "2026-08-20T09:00:00.000Z",
  "updatedAt": "2026-08-20T09:00:00.000Z"
}
```

量级：**约 250–400 B**。**极低频**（配置期读写；请求期由上层进程内存缓存）。写入由信任模型（§5）把关：`public` 仓库默认拒绝。

### 3.6 `meta/storage.json`（可选，本实现实例状态）

```jsonc
{
  "storageId": "fs:home-2c91",          // 实例标识（配对/同步状态关联）
  "deviceId": "device-7f3a",             // 工作区前缀
  "lastGcAt": "2026-08-21T03:00:00.000Z"
}
```

量级：**约 120 B**。低频。

## 4. 量级汇总（一次典型对话 / 一个仓库）

| 维度 | 典型值 | 备注 |
| --- | --- | --- |
| 单轮对话产生的文件数 | 3–8（user、assistant、工具调用与结果各 1–3） | 含 reasoning 分离时更多 |
| 单轮对话数据量 | 10–100 KB | 无图片；有图片 1–10 MB |
| 一个会话（20 轮） | 100–300 对象，0.5–2 MB | 纯文本 |
| 一个仓库（会话数 × 平均对象数） | 500 会话 ≈ **1.5–4 万对象**，10–200 MB | 文件数=对象数+refs(500)+working(少量) |
| 全量枚举（启动扫描） | 1.5–4 万文件 | 需要分片目录；后端实现应流式枚举避免 I/O 尖峰 |

**结论性取舍**：
- 对象文件**不压缩**（JSON 原文），换取可读与跨实现校验简单；磁盘溢出风险由仓库规模声明（建议 ≤10 GB）与 gc 控制；
- 单文件 >1 MB 的对象（图片/大工具结果）**仅存索引路径**的做法**不采用**（v1）：base64 直接入库，后续若实测过大再演进为 `objects/…/payload.bin` + 缩略索引（这是明确的 v2 演进点，不是默认设计）。

## 5. 信任模型映射

`turnfold.json.trust` 声明该仓库目录的信任等级；三端行为一致：

| trust | 含义 | credentials 写入 |
| --- | --- | --- |
| `plaintext` | 本机/受控目录，允许明文 | **允许**（透明） |
| `vault` | 目录本身由 OS 密钥保护（如加密卷/FileVault），凭据原样写 | 允许（依赖卷加密） |
| `none` | 只读挂载/公共目录 | **拒绝写 credentials**；显式覆盖需信封加密（密钥经 vault/WebCrypto，不进仓库） |

开发环境默认 `plaintext`（对应 `TURNFOLD_STORAGE_TRUST` / 设置页覆盖）。

## 6. 写入协议与读写频率总表

### 6.1 原子写（三端统一）

```text
write(key, data):
  1. 写入 .tmp/<uuid>（同卷）
  2. flush +（必要时）fsync
  3. rename → 目标路径          ← 原子替换（POSIX/浏览器 createWritable 同语义；
                                    浏览器 FS Access API 为 write+close 组合，视作近似原子）
```

- objects：纯追加语义（内容寻址），无需 CAS，**重复写跳过**；
- refs/working：读-改-写整文件，**先经同进程互斥锁**（防止多实例并发：Bun/Rust 可加文件锁 `.tmp/lock`，浏览器单页面内互斥即可，跨标签页为最佳努力）；
- refs 提交带 `expectedHeadVersion`：版本不匹配即冲突（与现有服务器语义一致）。

### 6.2 读写频率

| 数据 | 读 | 写 | 延迟要求 | 优化 |
| --- | --- | --- | --- | --- |
| `turnfold.json` | 挂载 1 次 | 初始化 + ≥30s 节流 | 低 | `updatedAt` 与写入解耦，异步刷新 |
| `refs/*` | **高频**：打开会话/列表/分支切换 | 每轮 1–2 次 | 读 ≤10ms | 列表=目录枚举+批量读；内存缓存（失效即读目录 mtime） |
| `objects/*` | 渲染历史按需（当前路径 20–60 个） | 每轮 2–4 次（幂等） | 中 | 只读当前分支路径，不全量载入 |
| `working/*` | 恢复时 1 次/设备 | **流式期每 1–2s**（节流合并 delta） | 写 ≤50ms | 与内存状态合并写；停止生成时强制 flush |
| `credentials/*` | 配置期 | 配置期 | 低 | 进程内缓存 |
| `meta/storage.json` | 挂载 | gc 后 | 低 | — |

### 6.3 崩溃与孤儿回收

- 写对象 → rename 前崩溃：`.tmp` 孤儿，启动时忽略/清理；
- refs 已更新但对象缺失（极端）：读取时按 `parentMessageId` 断链检测，标记"缺失对象"而不是报错（与现有浏览器行为一致）；
- **gc**（`repo fsck/gc`，低频手触或 ≥7 天自动）：按 reachable 集合（refs 全量遍历 parent 链）删除不可达对象；working 中超过 30 天未更新的项提示清理；
- 不引入 journal：对象不可变 + ref CAS + 原子 rename 已保证可恢复性；jounal 的复杂度收益为负。

## 7. 三端实现映射与差异

| 关注点 | 浏览器（FS Access API） | Bun（node:fs） | Rust（native path） |
| --- | --- | --- | --- |
| 目录获取 | `showDirectoryPicker`（只读/读写授权，handle 持久化到 IndexedDB 复用） | 配置路径 | 配置路径/参数 |
| 原子写 | `createWritable()`（write+close，近似原子） | `writeFile(tmp)` + `rename` | `std::fs::write` + `rename` |
| 锁 | 页面内互斥（跨标签页最佳努力） | 文件锁 `.tmp/lock` | `fs2` 文件锁 |
| 枚举 | 递归 `for await` 目录迭代（无 path 字符串） | `readdir` 流式 | `walkdir`/`read_dir` 流式 |
| 性能 | 中（每次操作有 IPC 开销） | 高 | 高 |
| 能力声明 | durable ✅ / atomicRefs ✅ / public ✅（受授权目录开放范围） | 同 | 同 |

浏览器特性差异：`turnfold.json.trust=public` 时 UI 强制"凭据不写入本目录"的提示；目录 handle 撤销时降级为只读仓库提示重新授权。

## 8. 路径迁移与兼容

- 目录布局 = 新的兼容边界（与 `docs/storage-architecture.md` §9 一致），schemaVersion 升级需显式迁移；
- `refs`/`objects` 与 IndexedDB/SQLite 之间无自动迁移：FS 仓库是**并存**的存储选择（与现有仓库互为 peer/sync 对象，通过 Storage 复制协议合并，而非转换）；
- 首次挂载时必须写 `turnfold.json`（初始化），拒绝空目录挂载为仓库以免误用普通文件夹。

## 9. 性能实测（基准，2026-08-22）

测试环境：Linux x86_64；Bun 1.4（node:fs，tmpfs，page cache 命中）；Headless Chromium 151（IndexedDB vs OPFS——OPFS 与 File System Access API 走同一实现路径，真实 FS API 另含一次权限校验，只会更慢）。可复现：`benchmarks/` 下脚本。

| 操作 | Bun `node:fs` | 浏览器 IndexedDB | 浏览器 FS API (OPFS) | FS/IDB 比值 |
| --- | --- | --- | --- | --- |
| 写 5KB 对象 | **0.024 ms** | 0.43 ms | 4.36 ms | ~10× |
| 写 5KB（批量 100） | ~0.02 ms/op | **0.07 ms/op**（单事务） | 4.38 ms/op | **~60×** |
| 读 5KB 单对象 | **0.008 ms** | 0.18 ms | 1.06 ms | ~6× |
| 批量读 100 对象 | ~0.008 ms/op | **0.03 ms/op**（并发 get） | 1.08 ms/op | **~21×** |
| 写 1MB | **0.26 ms** | 1.37 ms | 12.0 ms | ~9× |
| 读 1MB | **0.47 ms** | 1.83 ms | 3.70 ms | ~2× |
| 枚举 200 文件 | **0.05 ms** | — | — | — |

**结论与设计约束**：

1. **浏览器端 IDB 全面胜出**（单对象 5–10×，批量 20–60×）：IDB 是浏览器进程内结构化存储，FS API 每 op 都有跨进程 IPC + 文件打开/关闭 + 权限检查成本。**浏览器的主仓库必须是 IndexedDB**；
2. **浏览器 FS Storage 定位=低频场景**：备份/迁移/导入导出/只读挂载/多端交换。渲染历史（20–60 对象）FS 读 ~30–60 ms（IDB ~2–5 ms），勉强可感知但可接受——前提是**批量 + 内存缓存**，绝不可逐条 await；
3. **Bun/Rust node:fs 无此问题**（0.008–0.5 ms/op）："本地文件夹即仓库"在高性能端成立，Bun/Rust 可直接用 FS Storage 作主仓库；
4. **Storage 接口必须提供批量操作**（`readMany`/`writeMany`），浏览器的 FS 实现按最大并行度执行；单条接口作为 fallback；
5. working 流式写：浏览器 FS 每 1–2s 一次 ≈ 4–12 ms，无压力；IDB 更优。文件级节流策略（§6.2）保持不变。

## 10. 与其他 Storage 的键映射一致性

键空间（`objects/ refs/ working/ credentials/ meta/`）与 WebDAV 纯 KV 化（§7）及 S3 完全一致——三者的差别只是"键→路径/对象名"的编码规则。因此 FileSystemStorage 的读写协议（原子写、CAS、幂等对象）可直接复用到 WebDAV（`PUT tmp` + `MOVE`）与 S3（`PutObject` + ETag 条件写），只需实现各自的编码层。
