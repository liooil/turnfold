// RepositoryOps：三端（浏览器 / Bun / Rust）同语义的仓库对象级操作契约。
// 设计见 docs/storage-architecture.md §3.4。实现可以基于任意 Storage 后端
// （IndexedDB / SQLite / 本地文件夹 / WebDAV / S3），但对外签名与语义一致。
import type {Conversation, ConversationSummary, StoredChatMessage, WorkingItem} from "./conversation-types";
import type {GenerationSettings} from "./generation-settings";
import type {LocalCredential} from "./provider-types";
import type {SessionTransferFormat} from "./session-transfer";

export type CreateConversationInput = {
  providerId: string;
  model: string;
  generationSettings: GenerationSettings;
  name: string;
  headMessageId?: string | null;
  messages?: StoredChatMessage[];
};

export type UpdateConversationInput = {
  providerId: string;
  model: string;
  generationSettings: GenerationSettings;
  name?: string;
};

export type CommitMessageInput = {
  conversationId: string;
  /** 乐观并发：期望的当前 head；不匹配则返回 conflict，不写入。 */
  expectedHeadId: string | null;
  expectedHeadVersion?: number;
  message: StoredChatMessage;
};

export type CommitMessageResult = {
  status: "ok" | "conflict";
  conversation: Conversation;
};

export type RepositoryImportInput = {
  files: Array<{name: string; text: string}>;
  titleTemplate?: string;
};

export type RepositoryImportResult = {
  createdConversationIds: string[];
  formats: SessionTransferFormat[];
  /** 无法解析而被跳过的 JSONL 行数（容错统计）。 */
  skippedLines: number;
};

export type RepositoryExportInput = {
  conversationId: string;
  format: Exclude<SessionTransferFormat, "turnfold">;
};

export interface RepositoryOps {
  // ---- 会话（ref 层） ----
  list(): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation | null>;
  create(input: CreateConversationInput): Promise<Conversation>;
  update(id: string, input: UpdateConversationInput): Promise<Conversation>;
  /** CAS 提交消息；expectedHeadId 不匹配返回 conflict。 */
  commit(input: CommitMessageInput): Promise<CommitMessageResult>;
  moveHead(conversationId: string, headMessageId: string | null): Promise<Conversation>;
  remove(id: string): Promise<void>;

  // ---- 草稿与工作项 ----
  listWorkingItems(conversationId?: string): Promise<WorkingItem[]>;
  saveWorkingItem(item: WorkingItem): Promise<void>;
  removeWorkingItem(id: string): Promise<void>;

  // ---- 导入 / 导出（基于 shared 传输格式） ----
  importRecords(input: RepositoryImportInput): Promise<RepositoryImportResult>;
  exportText(input: RepositoryExportInput): Promise<string>;

  // ---- 凭据（信任模型在实现层执行，见 shared/storage.ts secretStoragePolicy） ----
  listCredentials(): Promise<LocalCredential[]>;
  saveCredential(credential: LocalCredential): Promise<void>;
  removeCredential(id: string): Promise<void>;
}
