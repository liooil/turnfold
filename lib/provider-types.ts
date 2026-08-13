export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export type ProviderModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  ownedBy?: string;
  pricing?: Record<string, unknown>;
};

export type ProviderDiscovery = {
  type: "openai-models-list" | "anthropic-models-list" | "google-models-list";
  url: string;
};

export type ProviderDefinition = {
  id: string;
  name: string;
  api: ProviderApi;
  connection: {
    type: "frontend" | "backend";
    baseUrl: string;
    proxy: null | {type: "relay" | "http" | "https" | "socks5"; url: string};
  };
  auth: {type: "bearer" | "header" | "none"; header?: string};
  headers: Record<string, string>;
  defaultModel: string;
  discovery: ProviderDiscovery;
  builtin: boolean;
  credentialState: "configured" | "missing" | "local";
  credentials: Array<{id: string; providerId: string; name: string; fingerprint: string}>;
};

export type ProviderSecret = {
  provider?: {apiKey?: string; headers?: Record<string, string>; baseUrl?: string};
  proxy?: {username?: string; password?: string; token?: string};
};

export type ResolvedBackendProvider = {
  provider: ProviderDefinition;
  credential: {id: string; name: string; secret: ProviderSecret};
};
