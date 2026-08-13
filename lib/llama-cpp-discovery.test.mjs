import {describe, expect, test} from "bun:test";
import {applyBrowserProviderSettings} from "./browser-provider-settings.ts";
import {discoverProviderModels} from "./provider-connectivity.ts";

function llamaProvider() {
  return {
    id: "llama.cpp",
    name: "llama.cpp",
    api: "openai-completions",
    connection: {type: "frontend", baseUrl: "http://127.0.0.1:8080/v1", proxy: null},
    auth: {type: "none"},
    headers: {},
    defaultModel: "local-model",
    discovery: {type: "openai-models-list", url: "http://127.0.0.1:8080/v1/models"},
    builtin: true,
    credentialState: "local",
    credentials: []
  };
}

describe("llama.cpp discovery", () => {
  test("applies a browser-local endpoint override", () => {
    const provider = applyBrowserProviderSettings(llamaProvider(), {provider: {baseUrl: "http://192.168.4.20:8081/v1/"}});
    expect(provider.connection.baseUrl).toBe("http://192.168.4.20:8081/v1");
    expect(provider.discovery.url).toBe("http://192.168.4.20:8081/v1/models");
  });

  test("falls back to /props when /v1/models is unavailable", async () => {
    const requests = [];
    const result = await discoverProviderModels(llamaProvider(), {}, async (input) => {
      requests.push(String(input));
      if (String(input).endsWith("/v1/models")) {
        return new Response(JSON.stringify({error: "Not Found"}), {status: 404, headers: {"Content-Type": "application/json"}});
      }
      return new Response(JSON.stringify({
        model_path: "/models/Qwen3.5-9B-Q4_K_M.gguf",
        default_generation_settings: {n_ctx: 32768}
      }), {status: 200, headers: {"Content-Type": "application/json"}});
    });
    expect(requests).toEqual(["http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8080/props"]);
    expect(result.endpoint).toBe("http://127.0.0.1:8080/props");
    expect(result.models).toEqual([{id: "Qwen3.5-9B-Q4_K_M.gguf", name: "Qwen3.5-9B-Q4_K_M.gguf", ownedBy: "llamacpp", contextWindow: 32768}]);
  });
});
