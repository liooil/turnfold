import {describe, expect, test} from "bun:test";
import {canonicalMessage, messageObjectId, validRepositoryNamespace} from "./message-object.ts";

describe("canonical message", () => {
  test("ignores object key insertion order", () => {
    const first = canonicalMessage({
      role: "user",
      parts: [{type: "text", text: "hello"}],
      parentMessageId: null
    });
    const second = canonicalMessage({
      parentMessageId: null,
      parts: [{type: "text", text: "hello"}],
      role: "user"
    });
    expect(first).toBe(second);
  });

  test("sorts keys by code unit order, not locale collation", () => {
    const value = {z: 1, ä: 2, a: 3};
    expect(canonicalMessage(value)).toBe(canonicalMessage({a: 3, z: 1, ä: 2}));
    expect(canonicalMessage(value)).toBe('{"a":3,"z":1,"ä":2}');
  });

  test("produces stable message object ids", async () => {
    const message = {
      parentMessageId: null,
      role: "user",
      parts: [{type: "text", text: "hello"}],
      origin: {type: "user"},
      completion: {status: "complete"},
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z"
    };
    const id = await messageObjectId(message, "local:test");
    expect(id).toBe(await messageObjectId({...message, parts: [{text: "hello", type: "text"}]}, "local:test"));
  });

  test("accepts current and known legacy repository namespaces", () => {
    expect(validRepositoryNamespace("local:12345678-1234-4234-8234-123456789abc")).toBe(true);
    expect(validRepositoryNamespace("8daac02ed9a886768394ae58c97a63b9")).toBe(true);
    expect(validRepositoryNamespace("legacy:unbounded")).toBe(false);
  });
});
