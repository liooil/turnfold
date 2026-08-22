// Storage 抽象：三端（浏览器 / Bun / Rust）同语义的仓库底层。
// 设计见 docs/storage-architecture.md §3.2（键空间约定与信任模型）。

/** 存储对凭据类数据的信任级别（可配置，开发环境默认 plaintext）。 */
export type StorageTrust = "none" | "plaintext" | "vault";

/**
 * 存储能力声明。上层据此决定写策略（批次、CAS、是否落盘凭据）。
 * 任何操作在特定 Storage 上不可用时，上层明确报错或降级。
 */
export type StorageCapability = {
  /** 数据是否持久（重启后保留）。 */
  durable: boolean;
  /** ref（会话引用）更新是否原子（可用 expectedHeadVersion CAS）。 */
  atomicRefs: boolean;
  /** 数据可能被其他进程/设备读取（文件夹共享 / WebDAV / S3）。 */
  public: boolean;
  /** 是否保留历史版本（备用；新实现默认 false）。 */
  versioned: boolean;
  trust: StorageTrust;
};

export type StorageEntry = {
  key: string;
  size: number;
  updatedAt: string;
};

export interface Storage {
  /** 稳定实例标识（用于配对、同步状态关联）。 */
  readonly id: string;
  capability(): Promise<StorageCapability>;
  list(prefix?: string): Promise<StorageEntry[]>;
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, data: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
  /** 批量读/写：默认实现按单条循环；浏览器 FS 等慢 IO 实现必须重载以获得吞吐。 */
  readMany?(keys: string[]): Promise<Array<Uint8Array | null>>;
  writeMany?(entries: Array<{key: string; data: Uint8Array}>): Promise<void>;
  removeMany?(keys: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// 键空间约定（与 WebDAV / S3 / 本地文件夹布局一致，仅编码不同）
// ---------------------------------------------------------------------------

export const STORAGE_KEY_PREFIXES = {
  meta: "meta/",
  objects: "objects/",
  refs: "refs/",
  working: "working/",
  credentials: "credentials/"
} as const;

export function objectStorageKey(objectId: string) {
  return `${STORAGE_KEY_PREFIXES.objects}${objectId}`;
}

export function refStorageKey(conversationId: string) {
  return `${STORAGE_KEY_PREFIXES.refs}${conversationId}`;
}

export function workingItemStorageKey(deviceId: string, itemId: string) {
  return `${STORAGE_KEY_PREFIXES.working}${deviceId}/${itemId}`;
}

export function credentialStorageKey(providerId: string, name = "default") {
  return `${STORAGE_KEY_PREFIXES.credentials}${providerId}/${name}`;
}

export function metaStorageKey(name: string) {
  return `${STORAGE_KEY_PREFIXES.meta}${name}`;
}

// ---------------------------------------------------------------------------
// 信任模型：凭据应否/可否写入某存储
// ---------------------------------------------------------------------------

/**
 * 凭据写入策略：
 * - `plaintext`：允许明文写入（vault / 非 public 的 plaintext 存储，或开发环境）；
 * - `encrypted-required`：public 存储——必须经信封加密后才能写入；
 * - `reject`：信任级别为 none（或加密不可用时的 public），拒绝写入。
 */
export type SecretStoragePolicy = "plaintext" | "encrypted-required" | "reject";

export function secretStoragePolicy(capability: StorageCapability): SecretStoragePolicy {
  if (capability.trust === "vault") return "plaintext";
  if (capability.trust === "none") return "reject";
  if (capability.public) return "encrypted-required";
  return "plaintext";
}

/** 仅返回允许明文写入的存储能力（用于 UI 勾选"凭据保管"时的提示）。 */
export function canStorePlaintextSecrets(capability: StorageCapability) {
  return secretStoragePolicy(capability) === "plaintext";
}
