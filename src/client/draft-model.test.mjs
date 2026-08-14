import {describe, expect, test} from "bun:test";
import {createDraftModel, requestAssistantReplyForSubmission, workingItemText} from "./draft-model.ts";

describe("draft model", () => {
  test("creates branch-aware drafts and selects the active draft", () => {
    const state = {workingItems: [], activeDraftId: ""};
    const drafts = createDraftModel(state, {uuid: () => "draft-1", displayedHeadId: () => "message-1"});
    const draft = drafts.newDraftItem("conversation-1", {text: "continue", requestAssistantReply: false});
    state.workingItems.push(draft);
    state.activeDraftId = draft.id;

    expect(draft.observedHeadId).toBe("message-1");
    expect(draft.requestAssistantReply).toBe(false);
    expect(workingItemText(draft)).toBe("continue");
    expect(drafts.activeDraft()).toBe(draft);
    expect(drafts.canStashActiveDraft()).toBe(true);
  });

  test("never requests an answer without a configured response model", () => {
    const draft = {messageRole: "user", requestAssistantReply: true};
    expect(requestAssistantReplyForSubmission(draft, true, false)).toBe(false);
    expect(requestAssistantReplyForSubmission(draft, false, false)).toBe(false);
  });

  test("respects the answer toggle when a response model is available", () => {
    expect(requestAssistantReplyForSubmission({messageRole: "user", requestAssistantReply: false}, true, true)).toBe(false);
    expect(requestAssistantReplyForSubmission({messageRole: "user", requestAssistantReply: true}, true, true)).toBe(true);
    expect(requestAssistantReplyForSubmission({messageRole: "assistant"}, false, true)).toBe(false);
  });
});
