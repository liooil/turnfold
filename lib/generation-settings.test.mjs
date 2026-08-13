import {describe, expect, test} from "bun:test";
import {generationCallOptions, normalizeGenerationSettings} from "./generation-settings.ts";

function provider(api) {
  return {
    id: api,
    name: api,
    api,
    connection: {type: "backend", baseUrl: "https://example.com/v1", proxy: null},
    auth: {type: "bearer"},
    headers: {},
    defaultModel: "test-model",
    discovery: {type: "openai-models-list", url: "https://example.com/v1/models"},
    builtin: false,
    credentialState: "configured",
    credentials: []
  };
}

describe("generation settings", () => {
  test("normalizes user-controlled values", () => {
    expect(normalizeGenerationSettings({reasoning: "high", showReasoningSummary: true, temperature: 5, maxOutputTokens: 12.8})).toEqual({
      reasoning: "high",
      showReasoningSummary: true,
      temperature: 2,
      maxOutputTokens: 12
    });
  });

  test("maps OpenAI reasoning and summary", () => {
    expect(generationCallOptions(provider("openai-responses"), {
      reasoning: "high",
      showReasoningSummary: true,
      temperature: null,
      maxOutputTokens: 4096
    })).toEqual({
      reasoning: "high",
      maxOutputTokens: 4096,
      providerOptions: {openai: {reasoningSummary: "auto"}}
    });
  });

  test("maps Anthropic adaptive thinking", () => {
    expect(generationCallOptions(provider("anthropic-messages"), {
      reasoning: "medium",
      showReasoningSummary: true,
      temperature: 0.4,
      maxOutputTokens: null
    })).toEqual({
      reasoning: "medium",
      temperature: 0.4,
      providerOptions: {anthropic: {thinking: {type: "adaptive", display: "summarized"}}}
    });
  });

  test("keeps auto mode provider-default", () => {
    expect(generationCallOptions(provider("openai-completions"), {
      reasoning: "auto",
      showReasoningSummary: false,
      temperature: null,
      maxOutputTokens: null
    })).toEqual({});
  });
});
