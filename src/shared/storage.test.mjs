import {describe, expect, test} from "bun:test";
import {MemoryStorage} from "./memory-storage";
import {
  canStorePlaintextSecrets,
  credentialStorageKey,
  metaStorageKey,
  objectStorageKey,
  refStorageKey,
  secretStoragePolicy,
  workingItemStorageKey
} from "./storage";

const capability = (overrides = {}) => ({
  durable: true,
  atomicRefs: true,
  public: false,
  versioned: false,
  trust: "plaintext",
  ...overrides
});

const data = (bytes) => new Uint8Array(bytes).fill(0x41);

describe("storage key space", () => {
  test("builds namespaced keys", () => {
    expect(objectStorageKey("sha256:abcd")).toBe("objects/sha256:abcd");
    expect(refStorageKey("sha256:c1")).toBe("refs/sha256:c1");
    expect(workingItemStorageKey("device-1", "wk-1")).toBe("working/device-1/wk-1");
    expect(credentialStorageKey("anthropic")).toBe("credentials/anthropic/default");
    expect(credentialStorageKey("anthropic", "prod")).toBe("credentials/anthropic/prod");
    expect(metaStorageKey("storage.json")).toBe("meta/storage.json");
  });
});

describe("secret storage policy (trust model)", () => {
  test("vault storage accepts plaintext secrets", () => {
    expect(secretStoragePolicy(capability({trust: "vault"}))).toBe("plaintext");
    expect(canStorePlaintextSecrets(capability({trust: "vault"}))).toBe(true);
  });

  test("private plaintext storage accepts plaintext (dev default)", () => {
    expect(secretStoragePolicy(capability({trust: "plaintext", public: false}))).toBe("plaintext");
    expect(canStorePlaintextSecrets(capability({trust: "plaintext", public: false}))).toBe(true);
  });

  test("public storage requires envelope encryption", () => {
    expect(secretStoragePolicy(capability({trust: "plaintext", public: true}))).toBe("encrypted-required");
    expect(secretStoragePolicy(capability({trust: "vault", public: true}))).toBe("plaintext");
    expect(canStorePlaintextSecrets(capability({trust: "plaintext", public: true}))).toBe(false);
  });

  test("none trust rejects secrets", () => {
    expect(secretStoragePolicy(capability({trust: "none"}))).toBe("reject");
    expect(canStorePlaintextSecrets(capability({trust: "none"}))).toBe(false);
  });
});

describe("MemoryStorage", () => {
  test("round-trips single and batch operations", async () => {
    const storage = new MemoryStorage("mem:test", capability());
    await storage.write("objects/a", data(10));
    await storage.writeMany([{key: "objects/b", data: data(20)}, {key: "refs/c", data: data(30)}]);

    expect((await storage.read("objects/a"))?.byteLength).toBe(10);
    expect((await storage.read("refs/c"))?.byteLength).toBe(30);
    expect(await storage.read("missing")).toBeNull();

    const many = await storage.readMany(["objects/b", "objects/a", "missing"]);
    expect(many.map((value) => value?.byteLength ?? null)).toEqual([20, 10, null]);

    const entries = await storage.list("objects/");
    expect(entries.map((entry) => entry.key)).toEqual(["objects/a", "objects/b"]);
    expect(entries[0].size).toBe(10);
    expect(entries[0].updatedAt).toBeTruthy();

    await storage.removeMany(["objects/a", "refs/c"]);
    expect(await storage.read("objects/a")).toBeNull();
    expect((await storage.list()).map((entry) => entry.key)).toEqual(["objects/b"]);
  });

  test("write overwrites and remove deletes", async () => {
    const storage = new MemoryStorage("mem:test2", capability());
    await storage.write("key", data(1));
    await storage.write("key", data(2));
    expect((await storage.read("key"))?.byteLength).toBe(2);
    await storage.remove("key");
    expect((await storage.list()).length).toBe(0);
  });

  test("exposes stable id and capability", async () => {
    const storage = new MemoryStorage("mem:test3", capability({trust: "none", public: true}));
    expect(storage.id).toBe("mem:test3");
    expect(await storage.capability()).toMatchObject({trust: "none", public: true});
  });
});
