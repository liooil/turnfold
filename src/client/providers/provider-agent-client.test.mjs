import {describe, expect, test} from "bun:test";
import {
  executeProviderAgent,
  fetchProviderAgentInfo,
  fetchProviderAgentResources,
  providerAgentGrantStorageKey,
  providerAgentGrantToken,
  removeProviderAgentGrant,
  saveProviderAgentGrant,
  saveProviderAgentProfile
} from "./provider-agent-client.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    values
  };
}

describe("Provider Agent connection", () => {
  test("stores its scoped grant separately by normalized Agent URL", () => {
    const storage = memoryStorage();
    saveProviderAgentGrant(storage, "http://127.0.0.1:3000/", "agent-token", {
      id: "grant-agent",
      origin: "https://app.example.test",
      clientName: "Turnfold Provider Agent",
      scopes: ["provider.execute", "vault.manage"],
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z"
    });
    expect(providerAgentGrantToken(storage, "http://127.0.0.1:3000")).toBe("agent-token");
    expect(JSON.parse(storage.values.get(providerAgentGrantStorageKey))["http://127.0.0.1:3000"].token).toBe("agent-token");
    removeProviderAgentGrant(storage, "http://127.0.0.1:3000");
    expect(providerAgentGrantToken(storage, "http://127.0.0.1:3000")).toBe("");
  });

  test("requires honest Vault and proxy capabilities", async () => {
    await expect(fetchProviderAgentInfo("http://127.0.0.1:3000", async () => Response.json({
      capabilities: {vault: false, providerProxy: false}
    }))).rejects.toThrow("未启用");
    await expect(fetchProviderAgentInfo("http://127.0.0.1:3000", async () => Response.json({
      capabilities: {vault: true, providerProxy: true}
    }))).resolves.toBeTruthy();
  });

  test("loads metadata without a plaintext secret field", async () => {
    const resources = await fetchProviderAgentResources("http://127.0.0.1:3000", "grant", async (input, init) => {
      expect(init.headers.Authorization).toBe("Bearer grant");
      if (String(input).endsWith("/provider/profiles")) return Response.json({profiles: [{
        id: "openai",
        name: "OpenAI",
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        auth: {type: "bearer"},
        headers: {},
        discoveryUrl: "",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }]});
      return Response.json({credentials: [{
        id: "credential-1",
        providerId: "openai",
        name: "default",
        fingerprint: "0123456789abcdef",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lastUsedAt: null
      }]});
    });
    expect(resources.credentials[0]).toEqual({
      id: "credential-1",
      providerId: "openai",
      name: "default",
      fingerprint: "0123456789abcdef",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lastUsedAt: null
    });
    expect(resources.credentials[0].secret).toBeUndefined();
  });
});

describe("Provider Agent requests", () => {
  test("registers a fixed profile without models or credentials", async () => {
    let sent;
    await saveProviderAgentProfile("http://127.0.0.1:3000", "grant", {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      auth: {type: "bearer"},
      headers: {},
      discoveryUrl: "",
      models: [{id: "gpt", name: "gpt", source: "manual"}],
      defaultModel: "gpt",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z"
    }, async (_input, init) => {
      sent = JSON.parse(init.body);
      return Response.json({profile: {
        id: "openai",
        ...sent,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z"
      }});
    });
    expect(sent.models).toBeUndefined();
    expect(sent.defaultModel).toBeUndefined();
    expect(sent.secret).toBeUndefined();
  });

  test("sends only IDs, operation and provider payload to the Agent", async () => {
    let requestedUrl = "";
    let requestedInit;
    const response = await executeProviderAgent("http://127.0.0.1:3000", "grant", {
      providerId: "openai",
      credentialId: "credential-1",
      operation: "stream",
      model: "gpt",
      body: {model: "gpt", stream: true}
    }, async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response("data: [DONE]\n\n", {headers: {"Content-Type": "text/event-stream"}});
    });
    expect(requestedUrl).toBe("http://127.0.0.1:3000/api/local/v1/provider/execute");
    expect(requestedInit.headers.Authorization).toBe("Bearer grant");
    expect(JSON.parse(requestedInit.body)).toEqual({
      providerId: "openai",
      credentialId: "credential-1",
      operation: "stream",
      model: "gpt",
      body: {model: "gpt", stream: true}
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });
});
