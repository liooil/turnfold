import {describe, expect, test} from "bun:test";
import {conversationTitlePrompt, normalizeGeneratedConversationTitle} from "./conversation-title.ts";

describe("AI conversation titles", () => {
  test("builds a bounded prompt from the first messages", () => {
    const prompt = conversationTitlePrompt([
      {role: "user", parts: [{type: "text", text: "如何优化流式 Markdown？"}]},
      {role: "assistant", parts: [{type: "text", text: "可以按稳定块增量渲染。"}]}
    ]);
    expect(prompt).toContain("用户：如何优化流式 Markdown？");
    expect(prompt).toContain("助手：可以按稳定块增量渲染。");
  });

  test("removes common model formatting and unsafe path separators", () => {
    expect(normalizeGeneratedConversationTitle("## 标题：\“流式 Markdown / 渲染优化\”\n说明")).toBe("流式 Markdown ／ 渲染优化");
  });

  test("allows an empty result to remain untitled", () => {
    expect(normalizeGeneratedConversationTitle("<think>no title</think>\n")).toBe("");
  });
});
