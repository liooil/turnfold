import {describe, expect, test} from "bun:test";
import {createProviderRequest, inferredDiscoveryUrl, normalizeDiscoveredModels, parseProviderStream, providerHeaders} from "./provider-runtime.ts";

const settings = {reasoning: "high", showReasoningSummary: true, temperature: 0.3, maxOutputTokens: 123};

function profile(protocol, overrides = {}) {
  return {
    id: protocol,
    name: protocol,
    protocol,
    baseUrl: "https://models.example/v1",
    auth: {type: "bearer"},
    headers: {"X-Profile": "local"},
    discoveryUrl: "",
    models: [{id: "test-model", name: "test-model", source: "manual"}],
    defaultModel: "test-model",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function sseResponse(blocks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    }
  }), {headers: {"Content-Type": "text/event-stream"}});
}

describe("local Provider runtime", () => {
  test("builds protocol-specific browser requests", async () => {
    const messages = [{role: "system", text: "Be brief"}, {role: "user", text: "Hello"}];
    const chat = createProviderRequest(profile("openai-chat"), {apiKey: "secret"}, "test-model", messages, settings);
    expect(chat.url).toBe("https://models.example/v1/chat/completions");
    expect(new Headers(chat.init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(chat.init.body).stream).toBe(true);

    const responses = createProviderRequest(profile("openai-responses"), {}, "test-model", messages, settings);
    expect(responses.url).toBe("https://models.example/v1/responses");
    expect(JSON.parse(responses.init.body).input[0].role).toBe("developer");

    const anthropic = createProviderRequest(profile("anthropic", {auth: {type: "header", header: "x-api-key"}}), {apiKey: "anthropic-key"}, "test-model", messages, settings);
    expect(anthropic.url).toBe("https://models.example/v1/messages");
    expect(new Headers(anthropic.init.headers).get("x-api-key")).toBe("anthropic-key");
    expect(new Headers(anthropic.init.headers).get("anthropic-dangerous-direct-browser")).toBe("true");

    const google = createProviderRequest(profile("google"), {}, "gemini-test", messages, settings);
    expect(google.url).toBe("https://models.example/v1/models/gemini-test:streamGenerateContent?alt=sse");
    expect(JSON.parse(google.init.body).contents[0].role).toBe("user");
  });

  test("parses handwritten SSE for all supported protocols", async () => {
    const cases = [
      ["openai-chat", ['data: {"choices":[{"delta":{"reasoning_content":"r","content":"a"}}]}\n\n', 'data: {"usage":{"completion_tokens":7}}\n\ndata: [DONE]\n\n']],
      ["openai-responses", ['event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"r"}\n\n', 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"a"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"output_tokens":8}}}\n\n']],
      ["anthropic", ['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"r"}}\n\n', 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"},"usage":{"output_tokens":9}}\n\n']],
      ["google", ['data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"r"},{"text":"a"}]}}],"usageMetadata":{"candidatesTokenCount":10}}\n\n']]
    ];
    for (const [protocol, blocks] of cases) {
      const events = [];
      const result = await parseProviderStream(protocol, sseResponse(blocks), (event) => events.push(event));
      expect(events).toEqual([{type: "reasoning-delta", text: "r"}, {type: "text-delta", text: "a"}]);
      expect(result.outputTokens).toBeGreaterThanOrEqual(7);
    }
  });

  test("discovers models independently from the preset catalog", () => {
    expect(inferredDiscoveryUrl(profile("openai-chat"))).toBe("https://models.example/v1/models");
    expect(normalizeDiscoveredModels({data: [{id: "model-a", owned_by: "local"}]})).toEqual([
      {id: "model-a", name: "model-a", ownedBy: "local", source: "discovered"}
    ]);
    const headers = providerHeaders(profile("google", {auth: {type: "header", header: "x-goog-api-key"}}), {apiKey: "key"});
    expect(headers.get("x-goog-api-key")).toBe("key");
  });
});
