import {describe, expect, test} from "bun:test";
import {responseMetadata} from "./response-metadata.ts";

describe("response metadata", () => {
  test("calculates output token throughput", () => {
    const metadata = responseMetadata("openai-compatible", "gpt-test", performance.now() - 2000, 40);
    expect(metadata.providerId).toBe("openai-compatible");
    expect(metadata.model).toBe("gpt-test");
    expect(metadata.durationMs).toBeGreaterThanOrEqual(1900);
    expect(metadata.tokensPerSecond).toBeGreaterThanOrEqual(19);
    expect(metadata.tokensPerSecond).toBeLessThanOrEqual(21);
  });

  test("calculates stream throughput after the first token", () => {
    const startedAt = performance.now() - 2000;
    const metadata = responseMetadata("openai-compatible", "gpt-test", startedAt, 40, undefined, startedAt + 500);
    expect(metadata.timeToFirstTokenMs).toBeGreaterThanOrEqual(450);
    expect(metadata.timeToFirstTokenMs).toBeLessThanOrEqual(550);
    expect(metadata.tokensPerSecond).toBeGreaterThanOrEqual(24);
    expect(metadata.tokensPerSecond).toBeLessThanOrEqual(30);
  });

  test("keeps speed unavailable when provider omits token usage", () => {
    const metadata = responseMetadata("local", "model", performance.now() - 100, undefined);
    expect(metadata.outputTokens).toBeNull();
    expect(metadata.tokensPerSecond).toBeNull();
  });

  test("falls back to estimated tokens when provider output is absent", () => {
    const metadata = responseMetadata("local", "model", performance.now() - 2000, undefined, 80);
    expect(metadata.outputTokens).toBe(80);
    expect(metadata.tokensPerSecond).toBeGreaterThanOrEqual(39);
    expect(metadata.tokensPerSecond).toBeLessThanOrEqual(41);
  });
});
