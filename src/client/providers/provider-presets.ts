import type {ProviderCatalogSource, ProviderPreset, ProviderProfile, ProviderProtocol} from "../../shared/provider-types";
import {embeddedModelsDevCatalog, modelsDevProviderModels} from "./models-dev-catalog";

type PresetInput = {
  id: string;
  name: string;
  protocol?: ProviderProtocol;
  baseUrl: string;
  auth?: ProviderProfile["auth"];
  headers?: Record<string, string>;
  defaultModel: string;
  ompModels?: string[];
  sources?: ProviderCatalogSource[];
};

function preset(input: PresetInput): ProviderPreset {
  const modelIds = [...new Set([input.defaultModel, ...(input.ompModels || [])].filter(Boolean))];
  const catalogModels = modelsDevProviderModels(embeddedModelsDevCatalog, input.id, "preset");
  const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
  const models = modelIds.map((id) => catalogById.get(id) || {id, name: id, source: "preset" as const});
  for (const model of catalogModels) if (!modelIds.includes(model.id)) models.push(model);
  const catalogSources = input.sources || ["keyvault", "omp"];
  if (catalogModels.length && !catalogSources.includes("models.dev")) catalogSources.push("models.dev");
  return {
    id: input.id,
    name: input.name,
    protocol: input.protocol || "openai-chat",
    baseUrl: input.baseUrl,
    auth: input.auth || {type: "bearer"},
    headers: input.headers || {},
    discoveryUrl: "",
    models,
    defaultModel: input.defaultModel,
    catalogSources
  };
}

// This is a credential-free, browser-safe seed catalog. KeyVault supplies the
// complete baseline; OMP supplies compatible current model aliases and local
// endpoint conventions. The embedded models.dev subset adds rich metadata for
// twelve curated models without making application startup depend on a network.
export const providerPresets: ProviderPreset[] = [
  preset({id: "openai", name: "OpenAI", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.4", ompModels: ["gpt-5.5"]}),
  preset({id: "anthropic", name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", auth: {type: "header", header: "x-api-key"}, defaultModel: "claude-sonnet-4-6", ompModels: ["claude-opus-4-8"]}),
  preset({id: "google", name: "Google Gemini", protocol: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", auth: {type: "header", header: "x-goog-api-key"}, defaultModel: "gemini-3.1-pro-preview"}),
  preset({id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", headers: {"X-Title": "Turnfold"}, defaultModel: "anthropic/claude-sonnet-4.6", ompModels: ["openai/gpt-5.5"]}),
  preset({id: "rust.cat", name: "rust.cat", protocol: "openai-responses", baseUrl: "https://rust.cat/codex/v1", defaultModel: "gpt-5.3-codex", ompModels: ["gpt-5.6-sol"]}),
  preset({id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-chat", ompModels: ["deepseek-v4-pro", "deepseek-v4-flash"]}),
  preset({id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "openai/gpt-oss-120b"}),
  preset({id: "mistral", name: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-large-latest", ompModels: ["devstral-medium-latest"]}),
  preset({id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4", ompModels: ["grok-4-fast-non-reasoning"]}),
  preset({id: "moonshot", name: "Moonshot AI", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "kimi-k3", ompModels: ["kimi-k2.7-code"]}),
  preset({id: "siliconflow", name: "SiliconFlow", baseUrl: "https://api.siliconflow.com/v1", defaultModel: "deepseek-ai/DeepSeek-V3.2", ompModels: ["zai-org/GLM-5.1"]}),
  preset({id: "siliconflow-cn", name: "SiliconFlow CN", baseUrl: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V3.2", ompModels: ["deepseek-ai/DeepSeek-V4-Pro"]}),
  preset({id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/v1", defaultModel: "MiniMax-M2.1", ompModels: ["MiniMax-M3"]}),
  preset({id: "zai", name: "Z.AI", baseUrl: "https://api.z.ai/api/paas/v4", defaultModel: "glm-5", ompModels: ["glm-5.2"]}),
  preset({id: "qianfan", name: "Baidu Qianfan", baseUrl: "https://qianfan.baidubce.com/v2", defaultModel: "ernie-4.5-8k-preview", ompModels: ["deepseek-v3.2"]}),
  preset({id: "dashscope", name: "Alibaba DashScope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3.5-plus", sources: ["keyvault"]}),
  preset({id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", ompModels: ["moonshotai/Kimi-K2.7-Code"]}),
  preset({id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", defaultModel: "accounts/fireworks/models/deepseek-v3p2", ompModels: ["kimi-k2.7-code"]}),
  preset({id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", defaultModel: "gpt-oss-120b", ompModels: ["zai-glm-4.7"]}),
  preset({id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", defaultModel: "nvidia/llama-3.1-nemotron-ultra-253b-v1", ompModels: ["nvidia/llama-3.1-nemotron-70b-instruct"]}),
  preset({id: "huggingface", name: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", defaultModel: "deepseek-ai/DeepSeek-V3.2", ompModels: ["deepseek-ai/DeepSeek-R1"]}),
  preset({id: "novita", name: "Novita AI", baseUrl: "https://api.novita.ai/openai/v1", defaultModel: "deepseek/deepseek-v3.2", ompModels: ["moonshotai/kimi-k2.7-code"]}),
  preset({id: "aimlapi", name: "AIML API", baseUrl: "https://api.aimlapi.com/v1", defaultModel: "gpt-5.4", ompModels: ["gpt-5.5-2026-04-23"]}),
  preset({id: "venice", name: "Venice AI", baseUrl: "https://api.venice.ai/api/v1", defaultModel: "llama-3.3-70b"}),
  preset({id: "nanogpt", name: "NanoGPT", baseUrl: "https://nano-gpt.com/api/v1", defaultModel: "gpt-5.4", ompModels: ["openai/gpt-5.5"]}),
  preset({id: "vercel-ai-gateway", name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", defaultModel: "openai/gpt-5.4", ompModels: ["anthropic/claude-opus-4.8"]}),
  preset({id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", baseUrl: "https://gateway.ai.cloudflare.com/v1", defaultModel: "openai/gpt-5.4", ompModels: ["anthropic/claude-opus-4-8"]}),
  preset({id: "litellm", name: "LiteLLM", baseUrl: "http://127.0.0.1:4000/v1", defaultModel: "gpt-5.4", ompModels: ["claude-opus-4-8"]}),
  preset({id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", auth: {type: "none"}, defaultModel: "qwen3.5:9b", ompModels: ["gpt-oss:20b"]}),
  preset({id: "lm-studio", name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", auth: {type: "none"}, defaultModel: "local-model", ompModels: ["llama-3-8b"]}),
  preset({id: "llama.cpp", name: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1", auth: {type: "none"}, defaultModel: "local-model", sources: ["keyvault"]}),
  preset({id: "vllm", name: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", auth: {type: "none"}, defaultModel: "local-model", ompModels: ["gpt-oss-20b"]})
];

const providerPresetMap = new Map(providerPresets.map((item) => [item.id, item]));

export function getProviderPreset(id: string) {
  return providerPresetMap.get(id);
}

export function isProviderPreset(id: string) {
  return providerPresetMap.has(id);
}

export function availableProviderPresetModels(profile: ProviderProfile) {
  const presetProfile = getProviderPreset(profile.id);
  if (!presetProfile) return [];
  const overriddenIds = new Set(profile.models.filter((model) => model.source !== "preset").map((model) => model.id));
  return presetProfile.models.filter((model) => !overriddenIds.has(model.id));
}

export function withProviderPresetModels<T extends ProviderProfile>(profile: T): T {
  const localModels = profile.models.filter((model) => model.source !== "preset");
  const presetModels = availableProviderPresetModels({...profile, models: localModels});
  if (!getProviderPreset(profile.id)) return profile;
  return {...profile, models: [...localModels, ...presetModels]} as T;
}
