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

  test("memoizes the message graph index across repeated calls", () => {
    const root = message("u1", null, "root");
    const current = message("a1", "u1", "current");
    const state = {
      messageGraph: [root],
      conversation: {headMessageId: "a1", messages: [root, current]},
      previewHeadId: ""
    };
    const selectors = createConversationSelectors(state);
    const first = selectors.knownMessageMap();
    expect(selectors.knownMessageMap()).toBe(first);

    state.conversation = {...state.conversation, messages: [...state.conversation.messages]};
    expect(selectors.knownMessageMap()).not.toBe(first);
    const second = selectors.knownMessageMap();
    expect(selectors.knownMessageMap()).toBe(second);
  });

  test("returns sorted edit alternatives and children from the memoized index", () => {
    const root = message("u1", null, "root");
    const edited = {...message("u1b", null, "edited"), origin: {type: "user", sourceMessageId: "u1"}};
    const unrelated = message("u2", null, "unrelated");
    const state = {
      messageGraph: [root, edited, unrelated],
      conversation: {headMessageId: "u1", messages: [root]},
      previewHeadId: ""
    };
    const selectors = createConversationSelectors(state);
    expect(selectors.rootEditAlternatives("u1b").map((item) => item.id)).toEqual(["u1", "u1b"]);
    expect(selectors.rootEditAlternatives("missing")).toEqual([]);
    expect(selectors.messageChildren("u1")).toEqual([]);
  });
});
