import {describe, expect, test} from "bun:test";
import {
  BackendPairingRequiredError,
  backendApiUrl,
  backendApprovalUrl,
  backendGrantStorageKey,
  backendGrantToken,
  backendUrlStorageKey,
  defaultBackendUrl,
  fetchBackendConfig,
  normalizeBackendUrl,
  pollBackendPairing,
  removeBackendGrant,
  saveBackendGrant,
  startBackendPairing,
  suggestedBackendUrl
} from "./backend-connection.ts";

describe("Backend URLs", () => {
  test("normalizes origins and path prefixes", () => {
    expect(normalizeBackendUrl("https://example.test/")).toBe("https://example.test");
    expect(normalizeBackendUrl("https://example.test/turnfold///")).toBe("https://example.test/turnfold");
    expect(backendApiUrl("https://example.test/turnfold/", "/api/config")).toBe("https://example.test/turnfold/api/config");
  });

  test("uses the serving application as a suggestion without connecting", () => {
    expect(defaultBackendUrl("https://liooil.github.io/turnfold/app/#conversation", "/turnfold/app"))
      .toBe("https://liooil.github.io/turnfold/app");
    expect(suggestedBackendUrl({getItem: () => "http://127.0.0.1:43110/"}, "https://example.test/app/", "/app"))
      .toBe("http://127.0.0.1:43110");
    expect(suggestedBackendUrl({getItem: (key) => key === backendUrlStorageKey ? "invalid relative URL" : null}, "https://example.test/app/", "/app"))
      .toBe("https://example.test/app");
  });

  test("rejects unsafe or ambiguous Backend URLs", () => {
    expect(() => normalizeBackendUrl("ftp://example.test")).toThrow("http");
    expect(() => normalizeBackendUrl("https://user:secret@example.test")).toThrow("用户名");
    expect(() => normalizeBackendUrl("https://example.test/?token=secret")).toThrow("查询参数");
    expect(() => normalizeBackendUrl("https://example.test/#fragment")).toThrow("片段");
  });
});

describe("Backend configuration", () => {
  test("loads a synchronization capability only after an explicit request", async () => {
    let requested = "";
    let requestInit;
    const config = await fetchBackendConfig("https://sync.example.test/turnfold", async (input, init) => {
      requested = String(input);
      requestInit = init;
      return Response.json({
        identityKey: "remote-identity",
        profile: {username: "alice", name: "Alice", email: "alice@example.test"},
        capabilities: {sync: true}
      });
    });
    expect(requested).toBe("https://sync.example.test/turnfold/api/config");
    expect(requestInit.credentials).toBe("include");
    expect(config).toEqual({
      identityKey: "remote-identity",
      profile: {username: "alice", name: "Alice", email: "alice@example.test"},
      capabilities: {sync: true}
    });
  });

  test("rejects a server that does not advertise repository sync", async () => {
    await expect(fetchBackendConfig("https://static.example.test", async () => Response.json({
      identityKey: "remote-identity",
      profile: {username: "alice"},
      capabilities: {sync: false}
    }))).rejects.toThrow("不支持 Turnfold 仓库同步");
  });

  test("sends a saved grant only to the selected Backend", async () => {
    let requestInit;
    await fetchBackendConfig("https://sync.example.test", async (_input, init) => {
      requestInit = init;
      return Response.json({
        identityKey: "remote-identity",
        profile: {username: "alice"},
        capabilities: {sync: true, pairing: true}
      });
    }, undefined, "secret-token");
    expect(requestInit.headers.Authorization).toBe("Bearer secret-token");
  });

  test("reports a scoped pairing challenge", async () => {
    await expect(fetchBackendConfig("https://sync.example.test", async () => Response.json({
      error: "pair first",
      code: "pairing_required"
    }, {status: 401}))).rejects.toBeInstanceOf(BackendPairingRequiredError);
  });
});

describe("Backend browser grants", () => {
  function memoryStorage() {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      values
    };
  }

  test("stores grants by normalized Backend URL", () => {
    const storage = memoryStorage();
    const grant = {
      id: "grant-1",
      origin: "https://app.example.test",
      clientName: "Turnfold",
      scopes: ["repository.sync"],
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z"
    };
    saveBackendGrant(storage, "https://sync.example.test/", "token-1", grant);
    expect(backendGrantToken(storage, "https://sync.example.test")).toBe("token-1");
    expect(JSON.parse(storage.values.get(backendGrantStorageKey))["https://sync.example.test"].token).toBe("token-1");
    removeBackendGrant(storage, "https://sync.example.test");
    expect(backendGrantToken(storage, "https://sync.example.test")).toBe("");
  });

  test("keeps WebDAV and native repository grants in separate storage slots", () => {
    const storage = memoryStorage();
    const base = {
      id: "grant",
      origin: "https://app.example.test",
      clientName: "Turnfold",
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z"
    };
    saveBackendGrant(storage, "https://service.example.test", "native-token", {...base, scopes: ["repository.sync"]});
    saveBackendGrant(storage, "https://service.example.test", "dav-token", {...base, scopes: ["repository.webdav"]}, "turnfold-webdav-grants-v1");
    expect(backendGrantToken(storage, "https://service.example.test")).toBe("native-token");
    expect(backendGrantToken(storage, "https://service.example.test", "turnfold-webdav-grants-v1")).toBe("dav-token");
  });

  test("starts and polls the fixed repository scope", async () => {
    const requests = [];
    const pairing = await startBackendPairing("https://sync.example.test", "Turnfold browser", async (input, init) => {
      requests.push([String(input), init]);
      return Response.json({
        pairingId: "pair-1",
        pollToken: "poll-secret",
        expiresAt: "2099-01-01T00:00:00Z",
        pollIntervalMs: 1000
      }, {status: 201});
    });
    expect(JSON.parse(requests[0][1].body).requestedScopes).toEqual(["repository.sync"]);
    expect(backendApprovalUrl("https://sync.example.test", pairing.pairingId))
      .toBe("https://sync.example.test/local/pair/pair-1");

    const result = await pollBackendPairing("https://sync.example.test", pairing, async (input, init) => {
      requests.push([String(input), init]);
      return Response.json({
        status: "approved",
        token: "grant-token",
        grant: {
          id: "grant-1",
          origin: "https://app.example.test",
          clientName: "Turnfold browser",
          scopes: ["repository.sync"],
          createdAt: "2026-01-01T00:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z"
        }
      });
    });
    expect(result.status).toBe("approved");
    expect(result.token).toBe("grant-token");
    expect(JSON.parse(requests[1][1].body)).toEqual({pollToken: "poll-secret"});
  });

  test("supports a separately approved Provider/Vault scope set", async () => {
    const scopes = ["provider.execute", "vault.manage"];
    let requestedScopes;
    const pairing = await startBackendPairing("https://agent.example.test", "Turnfold Agent", async (_input, init) => {
      requestedScopes = JSON.parse(init.body).requestedScopes;
      return Response.json({
        pairingId: "pair-agent",
        pollToken: "poll-agent",
        expiresAt: "2099-01-01T00:00:00Z",
        pollIntervalMs: 1000
      }, {status: 201});
    }, undefined, scopes);
    expect(requestedScopes).toEqual(scopes);
    const result = await pollBackendPairing("https://agent.example.test", pairing, async () => Response.json({
      status: "approved",
      token: "agent-grant",
      grant: {
        id: "grant-agent",
        origin: "https://app.example.test",
        clientName: "Turnfold Agent",
        scopes,
        createdAt: "2026-01-01T00:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z"
      }
    }), undefined, scopes);
    expect(result.status).toBe("approved");
    expect(result.grant.scopes).not.toContain("repository.sync");
  });
});
