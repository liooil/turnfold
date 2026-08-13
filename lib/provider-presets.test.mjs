import {describe, expect, test} from "bun:test";
import {availableProviderPresetModels, getProviderPreset, providerPresets, withProviderPresetModels} from "./provider-presets.ts";

const keyVaultProviderIds = [
  "openai", "anthropic", "google", "openrouter", "rust.cat", "deepseek", "groq", "mistral", "xai", "moonshot",
  "siliconflow", "siliconflow-cn", "minimax", "zai", "qianfan", "dashscope", "together", "fireworks", "cerebras",
  "nvidia", "huggingface", "novita", "aimlapi", "venice", "nanogpt", "vercel-ai-gateway", "cloudflare-ai-gateway",
  "litellm", "ollama", "lm-studio", "llama.cpp", "vllm"
];

describe("Provider preset catalog", () => {
  test("contains every KeyVault Provider exactly once", () => {
    expect(providerPresets.map((item) => item.id).sort()).toEqual([...keyVaultProviderIds].sort());
    expect(new Set(providerPresets.map((item) => item.id)).size).toBe(providerPresets.length);
    expect(providerPresets.every((item) => item.catalogSources.includes("keyvault"))).toBe(true);
  });

  test("contains only browser runtime protocols and no credentials", () => {
    for (const item of providerPresets) {
      expect(["openai-chat", "openai-responses", "anthropic", "google"]).toContain(item.protocol);
      expect(["http:", "https:"]).toContain(new URL(item.baseUrl).protocol);
      expect(item.models.some((model) => model.id === item.defaultModel && model.source === "preset")).toBe(true);
      expect(JSON.stringify(item).toLowerCase()).not.toContain("apikey");
      expect(Object.keys(item.headers).map((name) => name.toLowerCase())).not.toContain("host");
    }
  });

  test("uses browser-reachable local endpoint templates", () => {
    expect(getProviderPreset("ollama")?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(getProviderPreset("litellm")?.baseUrl).toBe("http://127.0.0.1:4000/v1");
    expect(getProviderPreset("novita")?.baseUrl).toBe("https://api.novita.ai/openai/v1");
    expect(getProviderPreset("missing")).toBeUndefined();
  });

  test("lists only preset models without a local same-ID override", () => {
    const base = {
      ...getProviderPreset("openai"),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      catalogSources: undefined,
      models: []
    };
    const hydrated = withProviderPresetModels(base);
    expect(hydrated.models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"]);
    expect(availableProviderPresetModels(hydrated).map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"]);

    const overridden = withProviderPresetModels({
      ...hydrated,
      models: [{id: "gpt-5.4", name: "My GPT", source: "manual"}, ...hydrated.models]
    });
    expect(overridden.models.filter((model) => model.id === "gpt-5.4")).toEqual([
      {id: "gpt-5.4", name: "My GPT", source: "manual"}
    ]);
    expect(availableProviderPresetModels(overridden).map((model) => model.id)).toEqual(["gpt-5.5"]);
  });
});
