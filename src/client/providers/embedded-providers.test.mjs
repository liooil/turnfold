import {describe, expect, test} from "bun:test";
import {embeddedModelsDevCatalog, embeddedModelsDevModelCount} from "./models-dev-catalog.ts";
import {
  catalogProviderProfiles,
  embeddedProviderProfiles,
  getEmbeddedProviderProfile,
  withEmbeddedProviderModels
} from "./embedded-providers.ts";

describe("embedded Provider profiles", () => {
  test("derives its Provider and model catalog exclusively from the embedded models.dev subset", () => {
    expect(embeddedProviderProfiles.map((item) => item.id)).toEqual(Object.keys(embeddedModelsDevCatalog));
    expect(embeddedProviderProfiles.reduce((total, item) => total + item.models.length, 0)).toBe(embeddedModelsDevModelCount);
    for (const item of embeddedProviderProfiles) {
      expect(item.catalogSource).toBe("models.dev");
      expect(item.models.every((model) => model.source === "catalog")).toBe(true);
      expect(item.models.some((model) => model.id === item.defaultModel)).toBe(true);
    }
  });

  test("adds only the transport defaults required by Turnfold", () => {
    expect(getEmbeddedProviderProfile("openai")).toMatchObject({
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.6"
    });
    expect(getEmbeddedProviderProfile("anthropic")).toMatchObject({
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      auth: {type: "header", header: "x-api-key"}
    });
    expect(getEmbeddedProviderProfile("minimax")).toMatchObject({
      protocol: "anthropic",
      baseUrl: "https://api.minimax.io/anthropic/v1"
    });
    expect(getEmbeddedProviderProfile("ollama")).toBeUndefined();
  });

  test("turns downloadable models.dev providers with API URLs into simple connection choices", () => {
    const profiles = catalogProviderProfiles({
      compatible: {
        id: "compatible",
        env: ["COMPATIBLE_API_KEY"],
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.example.com/v1",
        name: "Example",
        doc: "https://example.com/docs",
        models: embeddedModelsDevCatalog.openai.models
      }
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      id: "compatible",
      name: "Example",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      auth: {type: "bearer"},
      defaultModel: "gpt-5.6"
    });
  });

  test("replaces old preset models while preserving local overrides", () => {
    const template = getEmbeddedProviderProfile("openai");
    const timestamp = "2026-08-14T00:00:00.000Z";
    const hydrated = withEmbeddedProviderModels({
      ...template,
      createdAt: timestamp,
      updatedAt: timestamp,
      models: [
        {id: "gpt-5.4", name: "Old preset", source: "preset"},
        {id: "gpt-5.6", name: "Local GPT", source: "manual"}
      ]
    });
    expect(hydrated.models.map((model) => [model.id, model.source])).toEqual([
      ["gpt-5.6", "manual"],
      ["gpt-5.6-luna", "catalog"]
    ]);
  });
});
