import {describe, expect, test} from "bun:test";
import {mergeMessageGraph, messageChildrenInGraph, messagePathInGraph, newestBranchTipInGraph, rootEditAlternativesInGraph} from "./message-graph.ts";

const node = (id, parentMessageId, createdAt) => ({
  id, parentMessageId, role: id.startsWith("a") ? "assistant" : "user", parts: [],
  origin: {type: "legacy"}, completion: {status: "complete"}, createdAt, completedAt: createdAt
});

describe("message graph", () => {
  const root = node("u1", null, "2026-01-01T00:00:00Z");
  const answerA = node("a1", "u1", "2026-01-01T00:00:01Z");
  const answerB = node("a2", "u1", "2026-01-01T00:00:02Z");
  const followupB = node("u2", "a2", "2026-01-01T00:00:03Z");
  const graph = mergeMessageGraph([root, answerA], [answerB, followupB]);

  test("sorts sibling branches deterministically", () => {
    expect(messageChildrenInGraph(graph, "u1").map((message) => message.id)).toEqual(["a1", "a2"]);
  });

  test("builds the selected path without changing a ref", () => {
    expect(messagePathInGraph(graph, "u2").map((message) => message.id)).toEqual(["u1", "a2", "u2"]);
  });

  test("keeps conversation paths longer than 500 objects", () => {
    const messages = new Map();
    let parentMessageId = null;
    for (let index = 0; index < 501; index += 1) {
      const message = node(`m${index}`, parentMessageId, new Date(index * 1000).toISOString());
      messages.set(message.id, message);
      parentMessageId = message.id;
    }
    expect(messagePathInGraph(messages, parentMessageId)).toHaveLength(501);
  });

  test("uses the current ref for its branch and newest descendants for alternatives", () => {
    expect(newestBranchTipInGraph(graph, "a1", new Set(["u1", "a1"]), "a1")).toBe("a1");
    expect(newestBranchTipInGraph(graph, "a2", new Set(["u1", "a1"]), "a1")).toBe("u2");
  });

  test("does not mix unrelated root messages into first-message edit branches", () => {
    const editedRoot = {...node("u3", null, "2026-01-01T00:00:04Z"), origin: {type: "user", sourceMessageId: "u1"}};
    const unrelated = node("u4", null, "2026-01-01T00:00:05Z");
    const roots = mergeMessageGraph([...graph.values()], [editedRoot, unrelated]);
    expect(rootEditAlternativesInGraph(roots, "u3").map((message) => message.id)).toEqual(["u1", "u3"]);
  });
});
