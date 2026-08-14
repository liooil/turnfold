import {describe, expect, test} from "bun:test";
import {autoDetectProvider} from "./provider-auto-detect.ts";

describe("simple Provider auto-detection", () => {
  test("derives a unique identity and title while probing an OpenAI-compatible /v1 endpoint", async () => {
    const calls = [];
    const profile = await autoDetectProvider("https://api.example.com", "secret", ["example"], async (input, init = {}) => {
      const url = String(input);
      calls.push({url, headers: new Headers(init.headers)});
      if (url === "https://api.example.com/v1/models") {
        return Response.json({data: [{id: "example-chat", owned_by: "example"}]});
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
  });

  test("uses Anthropic discovery and authentication when the URL identifies Anthropic", async () => {
    const profile = await autoDetectProvider("https://api.anthropic.com", "anthropic-key", [], async (input, init = {}) => {
      const url = String(input);
      if (url === "https://api.anthropic.com/v1/models?limit=200") {
        expect(new Headers(init.headers).get("x-api-key")).toBe("anthropic-key");
        return Response.json({data: [{id: "claude-test", display_name: "Claude Test"}]});
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
  });

  test("rejects invalid or incompatible endpoints", async () => {
    await expect(autoDetectProvider("not a url", "", [])).rejects.toThrow("有效的 Provider URL");
    await expect(autoDetectProvider("https://none.example", "", [], async () => new Response("missing", {status: 404})))
      .rejects.toThrow("未能从该 URL 探测");
  });
});
