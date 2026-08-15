import {describe, expect, test} from "bun:test";
import {autoDetectProvider} from "./provider-auto-detect.ts";

describe("simple Provider auto-detection", () => {
  test("derives a unique identity and title while probing an OpenAI-compatible /v1 endpoint", async () => {
    const calls = [];
    const profile = await autoDetectProvider("https://api.example.com", "secret", ["example"], async (input, init = {}) => {
      const url = String(input);
      calls.push({url, method: init.method || "GET", headers: new Headers(init.headers)});
      if (url === "https://api.example.com/v1/models") {
        return Response.json({data: [{id: "example-chat", owned_by: "example"}]});
      }
      if (url === "https://api.example.com/v1/chat/completions") {
        return new Response("model is required", {status: 400});
      }
      if (url === "https://api.example.com") {
        return new Response("<title>Example AI Console</title>", {headers: {"content-type": "text/html"}});
      }
      return new Response("missing", {status: 404});
    });
    expect(profile).toMatchObject({
      id: "example-2",
      name: "Example AI Console",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      defaultModel: "example-chat"
    });
    expect(profile.models).toHaveLength(1);
    expect(calls[0].headers.get("authorization")).toBe("Bearer secret");
    expect(calls[1]).toMatchObject({url: "https://api.example.com/v1/chat/completions", method: "POST"});
  });

  test("uses Anthropic discovery, shape checks and an endpoint smoke test", async () => {
    const calls = [];
    const profile = await autoDetectProvider("https://api.anthropic.com", "anthropic-key", [], async (input, init = {}) => {
      const url = String(input);
      calls.push({url, method: init.method || "GET", headers: new Headers(init.headers)});
      if (url === "https://api.anthropic.com/v1/models?limit=200") {
        return Response.json({data: [{id: "claude-test", display_name: "Claude Test"}], has_more: false});
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        return new Response("messages is required", {status: 400});
      }
      throw new Error("title blocked by CORS");
    });
    expect(profile).toMatchObject({
      id: "anthropic",
      name: "anthropic.com",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      auth: {type: "header", header: "x-api-key"}
    });
    expect(calls[0].headers.get("x-api-key")).toBe("anthropic-key");
    expect(calls[1]).toMatchObject({url: "https://api.anthropic.com/v1/messages", method: "POST"});
    expect(calls[1].headers.get("x-api-key")).toBe("anthropic-key");
    expect(calls[1].headers.get("anthropic-version")).toBe("2023-06-01");
  });

  test("prefers openai-chat when a gemini-named host actually serves an OpenAI-compatible API", async () => {
    const profile = await autoDetectProvider("https://gemini.example.com", "secret", [], async (input) => {
      const url = String(input);
      if (url === "https://gemini.example.com/v1/models?pageSize=50") {
        return Response.json({data: [{id: "chat-model"}]});
      }
      if (url === "https://gemini.example.com/v1/models") {
        return Response.json({data: [{id: "chat-model"}]});
      }
      if (url === "https://gemini.example.com/v1/chat/completions") {
        return new Response("model is required", {status: 400});
      }
      return new Response("missing", {status: 404});
    });
    expect(profile).toMatchObject({
      protocol: "openai-chat",
      baseUrl: "https://gemini.example.com/v1",
      defaultModel: "chat-model"
    });
  });

  test("falls back to anthropic when the model list carries Anthropic's has_more marker", async () => {
    const calls = [];
    const profile = await autoDetectProvider("https://models.example.com", "claude-key", [], async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://models.example.com/v1/models" || url === "https://models.example.com/v1/models?limit=200") {
        return Response.json({data: [{id: "claude-test", display_name: "Claude Test"}], has_more: false});
      }
      if (url === "https://models.example.com/v1/messages") {
        return new Response("messages is required", {status: 400});
      }
      return new Response("missing", {status: 404});
    });
    expect(profile).toMatchObject({protocol: "anthropic", baseUrl: "https://models.example.com/v1"});
    expect(calls).toContain("https://models.example.com/v1/messages");
  });

  test("rejects when the model list exists but the chat route does not", async () => {
    await expect(autoDetectProvider("https://api.example.com", "secret", [], async (input) => {
      const url = String(input);
      if (url === "https://api.example.com/v1/models") return Response.json({data: [{id: "ghost"}]});
      return new Response("missing", {status: 404});
    })).rejects.toThrow("对话端点不存在");
  });

  test("reports rejected credentials from the endpoint smoke test", async () => {
    await expect(autoDetectProvider("https://api.example.com", "secret", [], async (input) => {
      const url = String(input);
      if (url === "https://api.example.com/v1/models") return Response.json({data: [{id: "ghost"}]});
      if (url === "https://api.example.com/v1/chat/completions") return new Response("Unauthorized", {status: 401});
      return new Response("missing", {status: 404});
    })).rejects.toThrow("拒绝了 API Key");
  });

  test("rejects invalid or incompatible endpoints", async () => {
    await expect(autoDetectProvider("not a url", "", [])).rejects.toThrow("有效的 Provider URL");
    await expect(autoDetectProvider("https://none.example", "", [], async () => new Response("missing", {status: 404})))
      .rejects.toThrow("未能从该 URL 探测");
  });
});
