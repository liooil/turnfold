export type ProviderProtocol = "openai-chat" | "openai-responses" | "anthropic" | "google";

export type ProviderModel = {
  id: string;
  name: string;
  description?: string;
  family?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  output?: string[];
  reasoning?: boolean;
  reasoningOptions?: Array<Record<string, unknown>>;
  toolCall?: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  openWeights?: boolean;
  releaseDate?: string;
  lastUpdated?: string;
  status?: string;
  ownedBy?: string;
  pricing?: Record<string, unknown>;
  source: "manual" | "discovered" | "preset" | "catalog";
};

export type ProviderProfile = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  auth: {type: "bearer" | "header" | "none"; header?: string};
  headers: Record<string, string>;
  discoveryUrl: string;
  models: ProviderModel[];
  defaultModel: string;
  createdAt: string;
  updatedAt: string;
};

export type CatalogProviderProfile = Omit<ProviderProfile, "createdAt" | "updatedAt"> & {
  catalogSource: "models.dev";
};

export type ProviderSecret = {
  apiKey?: string;
  headers?: Record<string, string>;
};

/** 本地存储的凭据实体（仓库对象；写入哪个 Storage 由信任模型决定）。 */
export type LocalCredential = {
  id: string;
  providerId: string;
  name: string;
  secret: ProviderSecret;
  createdAt: string;
  updatedAt: string;
};

export type ProviderMessage = {
  role: "system" | "user" | "assistant";
  text: string;
};

export type ProviderStreamEvent =
  | {type: "text-delta"; text: string}
  | {type: "reasoning-delta"; text: string};
