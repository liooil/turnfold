import {describe, expect, test} from "bun:test";
import {compactModelName} from "./model-display.ts";

describe("compact model names", () => {
  test("hides an Ollama model tag in compact UI", () => {
    expect(compactModelName("gemma4:e4b-it-qat")).toBe("gemma4");
    expect(compactModelName("qwen3.5:9b-q4_K_M")).toBe("qwen3.5");
  });

  test("keeps ordinary model identifiers unchanged", () => {
    expect(compactModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(compactModelName("Qwen3.5-9B-Q4_K_M.gguf")).toBe("Qwen3.5-9B-Q4_K_M.gguf");
  });
});
