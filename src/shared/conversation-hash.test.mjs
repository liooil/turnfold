import {describe, expect, test} from "bun:test";
import {conversationHash, conversationIdFromHash} from "./conversation-hash.ts";

describe("conversation hash routing", () => {
  test("round-trips a conversation id", () => {
    const id = "f60dbe18-92ca-4a7d-9d5d-242d0ed4d042";
    expect(conversationIdFromHash(conversationHash(id))).toBe(id);
  });

  test("preserves URL-sensitive ids", () => {
    expect(conversationIdFromHash(conversationHash("local/id + draft"))).toBe("local/id + draft");
  });

  test("ignores unrelated or oversized hashes", () => {
    expect(conversationIdFromHash("#services")).toBe("");
    expect(conversationIdFromHash(`#conversation=${"x".repeat(121)}`)).toBe("");
  });
});
