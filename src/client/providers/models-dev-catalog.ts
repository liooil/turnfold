import embeddedCatalogJson from "./models-dev-embedded.json";
import type {ProviderModel, ProviderProfile} from "../../shared/provider-types";

export const modelsDevApiUrl = "https://models.dev/api.json";

type JsonRecord = Record<string, unknown>;

export type ModelsDevModel = JsonRecord & {
  id: string;
  name: string;
  description: string;
  family?: string;
  attachment: boolean;
  reasoning: boolean;
  reasoning_options?: Array<Record<string, unknown>>;
  tool_call: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  release_date: string;
  last_updated: string;
  modalities: {input: string[]; output: string[]};
  open_weights: boolean;
  limit: {context: number; input?: number; output: number};
  cost?: Record<string, unknown>;
  status?: string;
};

export type ModelsDevProvider = JsonRecord & {
  id: string;
  env: string[];
  npm: string;
  api?: string;
  name: string;
  doc: string;
  models: Record<string, ModelsDevModel>;
};

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export type StoredModelsDevCatalog = {
  id: "current";
  fetchedAt: string;
  catalog: ModelsDevCatalog;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeModelsDevCatalog(value: unknown): ModelsDevCatalog {
  const input = record(value);
  if (!input) throw new Error("models.dev 返回的目录不是 JSON 对象");
  const catalog = Object.create(null) as ModelsDevCatalog;
  for (const [providerKey, providerValue] of Object.entries(input)) {
    const provider = record(providerValue);
    const models = record(provider?.models);
    if (!provider || !models) continue;
    const providerId = String(provider.id || providerKey).trim();
    const name = String(provider.name || providerId).trim();
    if (!providerId || !name) continue;
    const normalizedModels = Object.create(null) as Record<string, ModelsDevModel>;
    for (const [modelKey, modelValue] of Object.entries(models)) {
      const model = record(modelValue);
      const modalities = record(model?.modalities);
      const limit = record(model?.limit);
      const modelId = String(model?.id || modelKey).trim();
      const modelName = String(model?.name || modelId).trim();
      if (!model || !modalities || !limit || !modelId || !modelName) continue;
      if (!Number.isFinite(limit.context) || !Number.isFinite(limit.output)) continue;
      normalizedModels[modelId] = {
        ...model,
        id: modelId,
        name: modelName,
        description: String(model.description || ""),
        attachment: model.attachment === true,
        reasoning: model.reasoning === true,
        tool_call: model.tool_call === true,
        release_date: String(model.release_date || ""),
        last_updated: String(model.last_updated || ""),
        modalities: {input: stringArray(modalities.input), output: stringArray(modalities.output)},
        open_weights: model.open_weights === true,
        limit: {
          context: Number(limit.context),
          ...(Number.isFinite(limit.input) ? {input: Number(limit.input)} : {}),
          output: Number(limit.output)
        }
      } as ModelsDevModel;
    }
    if (!Object.keys(normalizedModels).length) continue;
    catalog[providerId] = {
      ...provider,
      id: providerId,
      env: stringArray(provider.env),
      npm: String(provider.npm || ""),
      ...(typeof provider.api === "string" ? {api: provider.api} : {}),
      name,
      doc: String(provider.doc || ""),
      models: normalizedModels
    } as ModelsDevProvider;
  }
  if (!Object.keys(catalog).length) throw new Error("models.dev 目录中没有可用模型");
  return catalog;
}

export const embeddedModelsDevCatalog = normalizeModelsDevCatalog(embeddedCatalogJson);

export function modelsDevModelCount(catalog: ModelsDevCatalog) {
  return Object.values(catalog).reduce((total, provider) => total + Object.keys(provider.models).length, 0);
}

export const embeddedModelsDevModelCount = modelsDevModelCount(embeddedModelsDevCatalog);

export function providerModelFromModelsDev(model: ModelsDevModel, source: ProviderModel["source"] = "catalog"): ProviderModel {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    ...(model.family ? {family: model.family} : {}),
    contextWindow: model.limit.context,
    maxTokens: model.limit.output,
    input: [...model.modalities.input],
    output: [...model.modalities.output],
    reasoning: model.reasoning,
    ...(Array.isArray(model.reasoning_options) ? {reasoningOptions: model.reasoning_options.map((item) => ({...item}))} : {}),
    toolCall: model.tool_call,
    ...(typeof model.structured_output === "boolean" ? {structuredOutput: model.structured_output} : {}),
    ...(typeof model.temperature === "boolean" ? {temperature: model.temperature} : {}),
    openWeights: model.open_weights,
    releaseDate: model.release_date,
    lastUpdated: model.last_updated,
    ...(model.status ? {status: model.status} : {}),
    ...(model.cost ? {pricing: {...model.cost}} : {}),
    source
  };
}

export function modelsDevProviderModels(catalog: ModelsDevCatalog, providerId: string, source: ProviderModel["source"] = "catalog") {
  return Object.values(catalog[providerId]?.models || {}).map((model) => providerModelFromModelsDev(model, source));
}

export function availableModelsDevModels(profile: ProviderProfile, catalog: ModelsDevCatalog) {
  const existingIds = new Set(profile.models.map((model) => model.id));
  return modelsDevProviderModels(catalog, profile.id).filter((model) => !existingIds.has(model.id));
}

export function modelsDevModel(catalog: ModelsDevCatalog, providerId: string, modelId: string) {
  const model = catalog[providerId]?.models[modelId];
  return model ? providerModelFromModelsDev(model) : undefined;
}
