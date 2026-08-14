import {describe, expect, test} from "bun:test";
import {migrateLegacyPreferences} from "./preferences.ts";

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

describe("legacy browser preferences", () => {
  test("copies fixed and per-provider values without overwriting Turnfold preferences", () => {
    const storage = new MemoryStorage();
    storage.setItem("xiteng-chat-provider", "legacy-provider");
    storage.setItem("turnfold-provider", "current-provider");
    storage.setItem("xiteng-chat-model:openai", "gpt-legacy");

    migrateLegacyPreferences(storage);

    expect(storage.getItem("turnfold-provider")).toBe("current-provider");
    expect(storage.getItem("turnfold-model:openai")).toBe("gpt-legacy");
  });
});
