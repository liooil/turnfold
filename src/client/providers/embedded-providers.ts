import type {CatalogProviderProfile, ProviderProfile, ProviderProtocol} from "../../shared/provider-types";
import {embeddedModelsDevCatalog, modelsDevProviderModels, type ModelsDevCatalog, type ModelsDevProvider} from "./models-dev-catalog";

type ConnectionDefaults = {
  protocol: ProviderProtocol;
  baseUrl?: string;
  auth?: ProviderProfile["auth"];
  headers?: Record<string, string>;
};

// models.dev describes models and usually exposes the provider API URL. Native
// SDK providers omit that URL, so Turnfold supplies only the transport details
// required by its browser runtime. Model IDs and metadata always come from the
// embedded models.dev subset.
const connectionDefaults: Record<string, ConnectionDefaults> = {
  openai: {protocol: "openai-responses", baseUrl: "https://api.openai.com/v1"},
  anthropic: {protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", auth: {type: "header", header: "x-api-key"}},
  google: {protocol: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", auth: {type: "header", header: "x-goog-api-key"}},
  xai: {protocol: "openai-chat", baseUrl: "https://api.x.ai/v1"},
  deepseek: {protocol: "openai-chat"},
  openrouter: {protocol: "openai-chat", headers: {"X-Title": "Turnfold"}},
  minimax: {protocol: "anthropic"},
  zai: {protocol: "openai-chat"}
};

function inferredConnection(provider: ModelsDevProvider): ConnectionDefaults {
  const known = connectionDefaults[provider.id];
  if (known) return known;
  const npm = provider.npm.toLowerCase();
  const api = provider.api?.toLowerCase() || "";
  if (npm.includes("anthropic") || api.includes("/anthropic/")) return {protocol: "anthropic"};
  if (npm.includes("@ai-sdk/google") || api.includes("generativelanguage.googleapis.com")) {
    return {protocol: "google", auth: {type: "header", header: "x-goog-api-key"}};
  }
  return {protocol: "openai-chat"};
}

function catalogProviderProfile(catalog: ModelsDevCatalog, provider: ModelsDevProvider): CatalogProviderProfile | null {
  const connection = inferredConnection(provider);
  const models = modelsDevProviderModels(catalog, provider.id);
  const baseUrl = provider.api || connection.baseUrl;
  if (!baseUrl || !models.length) return null;
  return {
    id: provider.id,
    name: provider.name,
    protocol: connection.protocol,
    baseUrl,
    auth: connection.auth || (provider.env.length ? {type: "bearer"} : {type: "none"}),
    headers: connection.headers || {},
    discoveryUrl: "",
    models,
    defaultModel: models[0]?.id || "",
    catalogSource: "models.dev"
  };
}

export function catalogProviderProfiles(catalog: ModelsDevCatalog) {
  return Object.values(catalog).flatMap((provider) => {
    const profile = catalogProviderProfile(catalog, provider);
    return profile ? [profile] : [];
  });
}

export const embeddedProviderProfiles = catalogProviderProfiles(embeddedModelsDevCatalog);

export function selectableCatalogProviderProfiles(catalog: ModelsDevCatalog) {
  const profiles = new Map(embeddedProviderProfiles.map((profile) => [profile.id, profile]));
  for (const profile of catalogProviderProfiles(catalog)) profiles.set(profile.id, profile);
  return [...profiles.values()];
}

const embeddedProviderMap = new Map(embeddedProviderProfiles.map((item) => [item.id, item]));

export function getEmbeddedProviderProfile(id: string) {
  return embeddedProviderMap.get(id);
}

export function isEmbeddedProvider(id: string) {
  return embeddedProviderMap.has(id);
}

export function withEmbeddedProviderModels<T extends ProviderProfile>(profile: T): T {
  const embedded = getEmbeddedProviderProfile(profile.id);
  if (!embedded) return profile;
  const localModels = profile.models.filter((model) => model.source !== "catalog" && model.source !== "preset");
  const overriddenIds = new Set(localModels.map((model) => model.id));
  const catalogModels = embedded.models.filter((model) => !overriddenIds.has(model.id));
  return {...profile, models: [...localModels, ...catalogModels]} as T;
}
