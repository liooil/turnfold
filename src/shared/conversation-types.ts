import type {GenerationSettings} from "./generation-settings";

export type ResponseMetadata = {
  providerId: string;
  model: string;
  durationMs: number;
  timeToFirstTokenMs?: number | null;
  outputTokens: number | null;
  tokensPerSecond: number | null;
};

export type MessageOrigin =
  | {type: "user"; clientId?: string; sourceMessageId?: string}
  | {type: "manual"; clientId?: string; sourceMessageId?: string}
  | {type: "model"; providerId: string; model: string; attemptId: string}
  | {type: "system"; source: string}
  | {type: "imported"};

export type MessageCompletion = {
  status: "complete" | "partial";
  reason?: "stop" | "user-cancelled" | "connection-lost" | "provider-error" | "timeout";
};

// 从外部会话 JSONL（Codex / Claude Code / OMP）导入时提取的用量信息。
// 字段全部可选：来源格式没有的维度就不出现。
export type ImportedMessageUsage = {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalTokens?: number;
  stopReason?: string;
};

export type ImportedMessageMetadata = {
  sourceFormat: "codex" | "claude" | "omp";
  usage?: ImportedMessageUsage;
};

export type StoredChatMessage = {
  id: string;
  parentMessageId: string | null;
  role: "system" | "user" | "assistant";
  parts: Array<Record<string, unknown> & {type: string}>;
  origin: MessageOrigin;
  completion: MessageCompletion;
  createdAt: string;
  completedAt: string;
  metadata?: {custom?: {response?: ResponseMetadata; imported?: ImportedMessageMetadata}};
};

export type ConversationSummary = {
  id: string;
  name: string;
  headMessageId: string | null;
  providerId: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  upstreamHeadMessageId?: string | null;
  headVersion?: number;
  metadataVersion?: number;
};

export type Conversation = ConversationSummary & {
  generationSettings: GenerationSettings;
  messages: StoredChatMessage[];
};

export type WorkingItemKind = "user-draft" | "assistant-stream";
export type WorkingItemStatus = "editing" | "streaming" | "interrupted" | "failed";

export type WorkingItem = {
  id: string;
  conversationId: string;
  kind: WorkingItemKind;
  observedHeadId: string | null;
  editSourceMessageId?: string;
  messageRole?: "user" | "assistant";
  requestAssistantReply?: boolean;
  incompleteTargetAction?: "interrupt" | "append";
  parts: StoredChatMessage["parts"];
  status: WorkingItemStatus;
  attemptId?: string;
  providerId?: string;
  model?: string;
  failureReason?: MessageCompletion["reason"];
  metadata?: StoredChatMessage["metadata"];
  createdAt: string;
  updatedAt: string;
};

export type ConversationRefState = {
  id: string;
  name: string;
  headMessageId: string | null;
  providerId: string;
  model: string;
  generationSettings: GenerationSettings;
  headVersion: number;
  metadataVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type RepositoryFetch = {
  refs: ConversationRefState[];
  objects: StoredChatMessage[];
  fetchedAt: string;
};

export type RepositoryRefUpdate = {
  conversationId: string;
  expectedHeadMessageId: string | null;
  expectedHeadVersion: number;
  expectedMetadataVersion: number;
  headMessageId: string | null;
  name: string;
  providerId: string;
  model: string;
  generationSettings: GenerationSettings;
  createdAt: string;
  updatedAt: string;
};
