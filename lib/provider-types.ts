export type ProviderProtocol = "openai-chat" | "openai-responses" | "anthropic" | "google";

export type ProviderModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  ownedBy?: string;
  pricing?: Record<string, unknown>;
  source: "manual" | "discovered" | "preset";
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

export type ProviderCatalogSource = "keyvault" | "omp";

export type ProviderPreset = Omit<ProviderProfile, "createdAt" | "updatedAt"> & {
  catalogSources: ProviderCatalogSource[];
};

export type ProviderSecret = {
  apiKey?: string;
  headers?: Record<string, string>;
};

export type ProviderMessage = {
  role: "system" | "user" | "assistant";
  text: string;
};

export type ProviderStreamEvent =
  | {type: "text-delta"; text: string}
  | {type: "reasoning-delta"; text: string};
