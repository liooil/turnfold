import {describe, expect, test} from "bun:test";
import {publicFrontendProviders} from "./public-provider-catalog.ts";

describe("public frontend provider catalog", () => {
  test("normalizes a bundled frontend provider", () => {
    expect(publicFrontendProviders([{
      id: "ollama",
      name: "Ollama",
      api: "openai-completions",
      connection: {type: "frontend", baseUrl: "http://127.0.0.1:11434/v1/", proxy: null},
      auth: {type: "none"},
      defaultModel: "local-model"
    }])).toEqual([expect.objectContaining({
      id: "ollama",
      connection: {type: "frontend", baseUrl: "http://127.0.0.1:11434/v1", proxy: null},
      discovery: {type: "openai-models-list", url: "http://127.0.0.1:11434/v1/models"},
      credentialState: "local"
    })]);
  });

  test("excludes backend and malformed entries", () => {
    expect(publicFrontendProviders([
      {id: "remote", connection: {type: "backend", baseUrl: "https://example.com/v1"}},
      null,
      "invalid"
    ])).toEqual([]);
  });
});
