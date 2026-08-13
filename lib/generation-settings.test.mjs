import {describe, expect, test} from "bun:test";
import {normalizeGenerationSettings} from "./generation-settings.ts";

describe("generation settings", () => {
  test("normalizes user-controlled values", () => {
    expect(normalizeGenerationSettings({reasoning: "high", showReasoningSummary: true, temperature: 5, maxOutputTokens: 12.8})).toEqual({
      reasoning: "high",
      showReasoningSummary: true,
      temperature: 2,
      maxOutputTokens: 12
    });
  });
});
