import {describe, expect, test} from "bun:test";
import {
  availableModelsDevModels,
  embeddedModelsDevCatalog,
  embeddedModelsDevModelCount,
  modelsDevModel,
  normalizeModelsDevCatalog
} from "./models-dev-catalog.ts";

const selectedModels = [
  "openai/gpt-5.6",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "google/gemini-3.7-flash",
  "xai/grok-4.6",
  "deepseek/deepseek-v4-pro",
  "openrouter/moonshotai/kimi-k3",
  "openrouter/qwen/qwen3.8-2.4t-a95b",
  "minimax/MiniMax-M3",
  "zai/glm-5.2",
  "deepseek/deepseek-v4-flash",
  "openai/gpt-5.6-luna"
].sort();

describe("models.dev catalog", () => {
  test("embeds the selected top twelve models with rich metadata", () => {
    const actual = Object.values(embeddedModelsDevCatalog)
      .flatMap((provider) => Object.keys(provider.models).map((modelId) => `${provider.id}/${modelId}`))
      .sort();
    expect(embeddedModelsDevModelCount).toBe(12);
    expect(actual).toEqual(selectedModels);
    expect(modelsDevModel(embeddedModelsDevCatalog, "openai", "gpt-5.6")).toMatchObject({
      name: "GPT-5.6",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      reasoning: true,
      temperature: false,
      source: "catalog"
    });
  });

  test("offers only models not already attached to a Provider profile", () => {
    const profile = {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      auth: {type: "bearer"},
      headers: {},
      discoveryUrl: "",
      models: [{id: "gpt-5.6", name: "Local GPT", source: "manual"}],
      defaultModel: "gpt-5.6",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z"
    };
    expect(availableModelsDevModels(profile, embeddedModelsDevCatalog).map((model) => model.id)).toEqual(["gpt-5.6-luna"]);
  });

  test("rejects payloads without usable provider models", () => {
    expect(() => normalizeModelsDevCatalog(null)).toThrow("不是 JSON 对象");
    expect(() => normalizeModelsDevCatalog({broken: {models: {bad: {id: "bad"}}}})).toThrow("没有可用模型");
  });
});
