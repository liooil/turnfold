# Turnfold 仓库统一架构（Storage 抽象与三端平级）

> 状态：设计草案 v0.1（评审中）。本文档锁定方向后，按「迁移路径」分阶段实现。
> 对应文档：`docs/architecture.md`（分层边界）、`docs/local-service.md`（Rust 本地服务）。

## 1. 目标与心智模型

Turnfold 有三个实现：**浏览器客户端（UI，含 GitHub Pages 分发形态——同一份前端代码、完全一致）、Bun 服务端（API + CLI）、Rust 本地服务（API + CLI + vault/Agent）**。它们都操作同一个对象模型，但目前只有浏览器能"直接处理消息/会话"，其余实现只能通过同步协议间接读写。GitHub Pages 上运行的就是浏览器客户端的同一构建产物，只是没有配套后端，因此不构成独立实现。

目标心智模型：**像 .git 一样，三个实现是平级、等价的**。对象模型与仓库操作契约是唯一的"事实标准"，每个实现只是它的一个宿主：

- 浏览器实现：UI 优先，存储 = IndexedDB（本地优先），可直连 Provider；
- Bun 实现：API + CLI 优先，存储 = SQLite / 本地文件夹；
- Rust 实现：API + CLI + vault + Agent 优先，存储 = SQLite / 本地文件夹 / WebDAV / S3；
- 任何实现都能独立完成"创建会话、提交消息、移动 head、导入导出、管理凭据"，不依赖其他实现在线；
- 部分能力受实现限制而不可用（见 §5 特性矩阵），这是被接受的差异，而不是缺陷。

沿用不变量："本地" = 当前浏览器 profile（浏览器端）或本机进程（服务端），不是提供页面的进程。

## 2. 现状盘点（as-is）

| 维度 | 浏览器 | Bun 服务端 | Rust 本地服务 |
| --- | --- | --- | --- |
| 对象模型 | shared 内容寻址对象（不可变、sha256） | 同左 | 同左 |
| 消息/会话存储 | IndexedDB（offline-history + repository/*） | SQLite（conversations/messages 表） | SQLite（repository.rs） |
| 凭据存储 | IndexedDB `turnfold-local-vault`（明文） | 无（不存凭据） | Vault（OS keyring） |
| 偏好/UI 状态 | localStorage（仅偏好与授权 token，**非数据仓库**） | — | — |
| 对象级操作 | 有（ConversationRepository/WorkingItemRepository，仅浏览器实现） | 无（只有 sync 端点） | 无（只有同步 API） |
| 同步 | SyncEngine + RepositoryPeer（push/pull 批次 + ref CAS） | `/api/sync/fetch\|push` | 同 API |
| WebDAV | webdav-repository-peer（versioned envelope + 设备快照） | — | webdav.rs（本地前门） |
| 导入/导出 | 有（session-transfer） | 无 | 无 |

**缺口**：
1. 无统一 Storage 抽象——WebDAV、SQLite、IndexedDB、文件夹是互不相识的通道；
2. 对象级仓库操作只存在于浏览器，服务端只能靠同步协议间接操作；
3. 凭据三种形态（IDB 明文 / 无 / keyring），信任策略写死在各实现里；
4. WebDAV 语义过重（versioned envelope、设备快照备份），与"一个存储"的心智不符。

## 3. 目标架构（to-be）

### 3.1 分层

```text
┌──────────────────── shared 契约层 ────────────────────────────┐
│ ① 对象模型（不变）    不可变内容寻址对象 / 会话引用 / parts      │
│ ② 仓库操作集（新）    RepositoryOps：会话 CRUD、提交(CAS)、      │
│                      移动 head、导入导出、草稿、凭据            │
│ ③ Storage 抽象（新）  Blob/KV + 能力声明 + 信任模型             │
│ ④ 存储间复制（演化）  对象复制 + ref CAS（由 SyncEngine 收敛）   │
└────────────────────────────────────────────────────────────────┘
  实现 A 浏览器            实现 B Bun              实现 C Rust
  Storage: IDB / FS         SQLite / 本地文件夹/S3  SQLite / 本地文件夹 / WebDAV / S3
  Ops 实现                 Ops 实现                Ops 实现
  + UI、直连 Provider      + API、CLI              + API、CLI、vault、Agent
```

依赖方向不变：`client -> shared <- server`，三端均可仅依赖 shared 契约开发，实现细节互不引用。

### 3.2 Storage 抽象（shared，新文件 `src/shared/storage.ts`）

```ts
export type StorageTrust = "none" | "plaintext" | "vault";
// none:        完全不可信，不接收任何数据
// plaintext:   实现内部加密/隔离，但允许明文（开发默认）
// vault:       持久化前必须经系统级密钥保护（OS keyring / 信封加密）

export type StorageCapability = {
  durable: boolean;        // 重启后数据保留
  atomicRefs: boolean;     // ref（conversation 引用）更新是否原子（CAS 可用）
  public: boolean;         // 数据可能被其他进程/设备读取（文件夹共享、WebDAV、S3）
  versioned: boolean;      // 保留历史版本（备用；新实现默认 false）
  trust: StorageTrust;
};

export type StorageEntry = {
  key: string;
  size: number;
  updatedAt: string;
};

export interface Storage {
  /** 稳定实例标识（用于配对、peer 状态关联） */
  readonly id: string;
  capability(): Promise<StorageCapability>;
  list(prefix?: string): Promise<StorageEntry[]>;
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, data: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  /** 批量读/写：默认实现按单条循环；浏览器 FS 等慢 IO 实现必须重载以获得吞吐 */
  readMany?(keys: string[]): Promise<Array<Uint8Array | null>>;
  writeMany?(entries: Array<{key: string; data: Uint8Array}>): Promise<void>;
  removeMany?(keys: string[]): Promise<void>;
}
```

**键空间约定**（由 RepositoryOps 使用，Storage 不感知语义）：

```text
meta/<storage-id>.json         仓库标识、信任声明、schema 版本
objects/<object-id>            不可变消息对象（内容寻址）
refs/<conversation-id>         会话引用（headMessageId + 版本，CAS 更新）
working/<device-id>/<item-id>  草稿、流式回答、工作快照
credentials/<provider-id>/<name>  凭据对象（是否落盘由信任模型决定）
```

### 3.3 Storage 实现清单

| 实现 | 环境 | durable | atomicRefs | public | trust | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| `IndexedDBStorage` | 浏览器 | ✅ | ✅ | ─ | plaintext（可配置） | 默认权威仓库，由现有 offline-history 重构包装 |
| `FileSystemStorage` | 浏览器（FS Access API）/ Bun（node:fs）/ Rust（native path） | ✅ | 写入为"临时文件+rename"则✅ | 是（共享目录） | plaintext | **本地文件夹即仓库**：目录含 `turnfold.json`（manifest/信任声明）+ 对象文件（类 .git 布局）；三端同语义；详细设计见 [filesystem-storage.md](filesystem-storage.md)（示例文件/量级/读写频率） |
| `WebDAVStorage` | 浏览器/Rust | ✅ | 依服务器（PUT 幂等+条件头） | 是 | plaintext | **简化为纯 KV 文件树**（见 §7 迁移），无 envelope/快照 |
| `S3Storage` | Bun/Rust（浏览器直连待定，见 §8） | ✅ | 依服务器（ETag 条件写/版本控制） | 是（默认私有桶配置） | plaintext | 远端对象存储；端点/存储桶/密钥可配置，凭据默认加密后写入 |
| `SQLiteStorage` | Bun/Rust | ✅ | ✅ | ─ | plaintext（开发） | 现有表结构抽象为 KV 层，或按对象键建 blob 表 |
| `VaultStorage` | Rust | ✅ | ✅ | ─ | vault | OS keyring；凭据专用，也可存储其他敏感对象 |
| `MemoryStorage` | 测试 | ─ | ─ | ─ | none | 测试与临时会话 |

> **localStorage 不再作为 Storage 实现**：浏览器本地持久化由 IndexedDB 覆盖（必要时可再加 FileSystemStorage），localStorage 仅继续承担 UI 偏好与授权 token（不经 Storage 抽象，直接读写），不承载任何仓库数据。

**能力降级规则**：任何操作在特定 Storage 上不可用时，上层明确报错或降级（如 `atomicRefs=false` 时禁用手动分支切换的并发保护，改为乐观检测）。

### 3.4 仓库操作集 RepositoryOps（shared 契约）

把浏览器现有的 `ConversationRepository` 等接口下沉为平台无关契约（三个实现共用同一签名与语义）：

```ts
export interface RepositoryOps {
  // 会话
  listConversations(): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<Conversation | null>;
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  updateConversation(id: string, input: UpdateConversationInput): Promise<Conversation>;
  /** CAS：expectedHeadId/expectedHeadVersion 不匹配 → conflict，不写入 */
  commitMessage(input: CommitMessageInput): Promise<CommitResult>;
  moveHead(conversationId: string, headMessageId: string | null): Promise<Conversation>;
  removeConversation(id: string): Promise<void>;
  // 草稿与工作项
  listWorkingItems(conversationId?: string): Promise<WorkingItem[]>;
  saveWorkingItem(item: WorkingItem): Promise<void>;
  removeWorkingItem(id: string): Promise<void>;
  // 导入导出（基于传输格式）
  importRecord(text: string, filename?: string, titleTemplate?: string): Promise<ImportResult>;
  exportConversation(id: string, format: SessionTransferFormat): Promise<string>;
  // 凭据（信任模型检查在此执行）
  listCredentials(): Promise<LocalCredential[]>;
  saveCredential(credential: LocalCredential): Promise<void>;
  removeCredential(id: string): Promise<void>;
}
```

实现策略：
- **浏览器**：现有 IndexedDB 实现改为基于 `IndexedDBStorage` 的 Ops 实现（行为与现在一致）；
- **Bun/Rust**：同一 Ops 契约实现于 `SQLiteStorage` 之上（消息对象内容寻址校验 `validMessageObjectId` 保持）；
- 纯图/哈希逻辑继续留在 shared（message-graph / message-object / conversation-hash），三个实现零差异。

### 3.5 凭据与信任模型（可配置）

- 凭据是普通对象（`credentials/<providerId>/<name>`），**写入哪个 Storage 由信任模型决定**：
  - `vault` 存储：明文写入，最高信任；
  - `plaintext` 存储：允许明文（**开发环境默认**，如本机 SQLite / IndexedDB）；
  - `public` 存储（文件夹共享 / WebDAV / S3）：凭据**默认拒绝写入**；显式开启时要求信封加密（后端 `vault` 或浏览器 WebCrypto，密钥不进仓库）。
- 信任级别可配置，而不是写死：环境变量 `TURNFOLD_STORAGE_TRUST`（服务端）与设置页"凭据保管"（浏览器）二选一/并存，默认 `plaintext`。
- 凭据不随仓库复制默认同步到其他 Storage；跨设备同步凭据必须显式允许（默认禁止，见 §8 未决问题）。

### 3.6 操作面对称（API + CLI）

**API**（Bun 与 Rust 的 `serve` 提供同一契约；现有 `/api/sync/*` 保留为同步底层）：

```text
POST /api/repo/conversations         列表 / 详情 / 创建 / 更新
POST /api/repo/conversations/:id/commit   提交消息（CAS）
POST /api/repo/conversations/:id/head     移动 head
POST /api/repo/import /api/repo/export    导入导出
POST /api/repo/credentials               凭据 CRUD（信任模型执行处）
```

**CLI**（三端对称，Bun 也要）：

```text
turnfold session list / show / import file.jsonl / export
turnfold repo status / fsck / gc
turnfold credential set / list / remove
bun run cli session list / import ...      # Bun 等价实现，同一 Ops
```

## 4. 存储间复制（同步语义演化）

现有 `RepositoryPeer`（push/pull 批次 + ref CAS）保留为"Storage 间复制"协议，但不再需要特定实现的 peer：

```text
sync(source: RepositoryOps, target: Storage) {
  inventory = target.list(objects/*)            // 取代 push 的对象快照
  写入缺失对象（内容寻址，天然幂等）
  refs: 逐会话 CAS 提交（expectedHeadVersion），冲突返回
}
```

- `SyncEngine` 仅依赖 Ops + Storage 契约，三端可共享同一实现思路；
- WebDAV / S3 不再有特殊同步协议：它们就是普通 `public` Storage；
- 冲突语义不变（版本 CAS），跨多设备仍以"准 + 报告冲突"为准。

## 5. 特性矩阵（部分功能某些实现不可用）

| 能力 | 浏览器 | Bun | Rust | 说明 |
| --- | --- | --- | --- | --- |
| 会话/消息图编辑 | ✅ UI | ✅ API/CLI | ✅ API/CLI | |
| 直连 Provider 请求 | ✅ | 无 | ✅（Agent 代执行） | Bun 无 Outbound 请求 |
| Agent/Vault | 无 | 无 | ✅ | 平台能力 |
| 导入/导出 | ✅ | ✅ CLI | ✅ CLI | |
| 凭据保管 | IDB 明文（可配 WebCrypto） | SQLite 明文（可配） | Vault | 信任模型统一 |
| 后台同步 | ✅ | ✅（作为远端） | ✅ | 任意两实现之间 |
| PWA/离线 | ✅ | — | — | |
| WebDAV 仓库 | ✅ Storage | ✅（读写远端） | ✅ Storage | 纯 KV |
| S3 仓库 | 待定（见 §8） | ✅ Storage | ✅ Storage | 对象存储 |

## 6. 迁移路径（分阶段）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P1 契约落地** ✅ 已完成 | `shared/storage.ts`（接口+能力+信任）、`shared/repository-ops.ts` 契约、`shared/memory-storage.ts`、LocalCredential 提升到 shared、架构测试强化（shared 不得依赖 node:/bun:） | typecheck + 139 测试全绿 |
| **P2 浏览器存储适配器** | IndexedDB 包装为 Storage；FS Access API 目录即仓库；凭据对象化（`credentials/*`，信任检查）；localStorage 确认仅剩偏好/token | 浏览器行为不变，新增 FS 目录仓库手工可用 |
| **P3 Bun** | SQLite 抽象为 Storage；实现 RepositoryOps；`/api/repo/*` 端点；`bun run cli` | API/CLI 可完成"建会话→提交→导出"全流程 |
| **P4 Rust** | 同契约 Ops（SQLite Storage）；vault 作为 Storage；`turnfold session/repo/credential` 子命令；serve API 对称 | CLI 全流程可用；vault 凭据走信任模型 |
| **P5 WebDAV 纯 KV 化** | 新键/路径布局（见 §7）；旧 envelope 数据一次性迁移或只读降级；移除 peer 特殊协议 | 现有 WebDAV 用户可迁移数据 |
| **P6 收尾** | SyncEngine 收敛到 Ops+Storage；删除旧 peer/webdav 特化代码；文档与特性矩阵更新 | 旧代码无残留 |

## 7. WebDAV 纯 KV 化（迁移要点）

- **键→路径**：`objects/sha256:xxx` → `objects/xx/xxx`（前缀分片）；`refs/<id>` → `refs/<id>.json`；转义与长度限制（常见 WebDAV 服务器 255 字符/文件名）→ 超限键做哈希命名 + manifest 映射；
- **原子写**：`PUT <key>.tmp` + `MOVE`（不支持 MOVE 时降级为覆盖写 + 信任降级）；
- **舍弃**：versioned envelope、设备快照备份结构——`working/*` 改为普通文件；
- **旧数据**：`v1` envelope 树提供一次性导出为 KV 布局的工具（`turnfold webdav migrate`），或标记只读降级；迁移期双方可并存（新存储用 `meta/` 中 schema 版本区分）；
- 兼容边界声明：WebDAV 树布局成为新的兼容边界，文档化。

## 8. 未决问题

1. **凭据跨设备同步**：默认禁止；是否允许"显式授权的凭据信封"（如仅加密备份）？
2. **FS 目录布局**：已定稿（见 [filesystem-storage.md](filesystem-storage.md) §2—`turnfold.json` manifest + `objects/xx/` 分片 + `refs/` + `working/<device>/` + `credentials/`），等待评审确认；
3. **Bun CLI 形态**：`bun run cli <op>` 单脚本分发（开发/CI），是否也要发布产物？
4. **Storage 实例 id 与配对**：浏览器 FS/WebDAV 的 storage-id 如何建立信任（首次写入 manifest 确认？沿用 pairing 令牌？）
5. **SQLite 表抽象**：以 blob 键值表承载全部对象，还是保留现有关系表 + SQLiteStorage 双向适配（推荐后者，迁移小）？
6. **Browser localFileSystemStorage 权限**：目录 handle 持久化（IndexedDB 存 handle）与"只读/读写"两种授权模式如何暴露？
7. **浏览器是否直连 S3**：需要 SigV4 签名与存储桶 CORS 配置；v1 先由 Bun/Rust 实现，浏览器经服务端访问（或后期加直连）？
8. **localStorage 收尾**：仅保留 UI 偏好与授权 token（不经 Storage 抽象）；现有持久化数据（如凭据）确认都在 IndexedDB 中，无迁移负担。

## 9. 兼容边界与不变量（更新后）

- 对象格式（不可变、sha256、parts/origin/completion/metadata）——不变；
- `turnfold-archive v1` 与 Codex/Claude/OMP 传输格式——不变；
- HTTP 同步协议（`/api/sync/*`）——保留，作为复制底层；
- **新增**：Storage 接口、键空间约定、RepositoryOps 契约、`turnfold.json` manifest、WebDAV KV 布局——均为兼容边界，变更需显式迁移；
- 不变量：任何写入 Storage 的消息对象必须通过 `validMessageObjectId`（命名空间级）；"本地优先 + 显式连接"保持；断开任何远端不删本地数据。
