import {describe, expect, test} from "bun:test";
import {createConversationSelectors, messagePartText} from "./conversation-selectors.ts";

const message = (id, parentMessageId, text) => ({
  id,
  parentMessageId,
  role: id.startsWith("a") ? "assistant" : "user",
  parts: [{type: "text", text}],
  origin: {type: "legacy"},
  completion: {status: "complete"},
  createdAt: id,
  completedAt: id
});

describe("conversation selectors", () => {
  test("selects preview paths without mutating the committed path", () => {
    const root = message("u1", null, "root");
    const current = message("a1", "u1", "current");
    const alternative = message("a2", "u1", "alternative");
    const state = {
      messageGraph: [root, current, alternative],
      conversation: {headMessageId: "a1", messages: [root, current]},
      previewHeadId: "a2"
    };
    const selectors = createConversationSelectors(state);

    expect(selectors.displayedMessages().map((item) => item.id)).toEqual(["u1", "a2"]);
    expect(state.conversation.messages.map((item) => item.id)).toEqual(["u1", "a1"]);
    expect(messagePartText(alternative, "text")).toBe("alternative");
  });
});
