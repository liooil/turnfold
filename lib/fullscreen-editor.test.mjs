import {describe, expect, test} from "bun:test";
import {
  fullscreenEditorCharacterThreshold,
  fullscreenEditorLineThreshold,
  shouldOpenFullscreenEditor
} from "./fullscreen-editor.ts";

describe("fullscreen editor", () => {
  test("keeps short messages in the compact composer", () => {
    expect(shouldOpenFullscreenEditor("a".repeat(fullscreenEditorCharacterThreshold - 1))).toBe(false);
    expect(shouldOpenFullscreenEditor(Array(fullscreenEditorLineThreshold - 1).fill("line").join("\n"))).toBe(false);
  });

  test("opens for a long single-line message", () => {
    expect(shouldOpenFullscreenEditor("a".repeat(fullscreenEditorCharacterThreshold))).toBe(true);
  });

  test("opens for a message with many lines", () => {
    expect(shouldOpenFullscreenEditor(Array(fullscreenEditorLineThreshold).fill("line").join("\n"))).toBe(true);
  });
});
