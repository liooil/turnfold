import {describe, expect, test} from "bun:test";
import {describeProviderRequestError, isInsecureHttpTarget, isLocalhostHostname} from "./provider-diagnostics.ts";

describe("provider request diagnostics", () => {
  test("identifies localhost hostnames", () => {
    expect(isLocalhostHostname("localhost")).toBe(true);
    expect(isLocalhostHostname("127.0.0.1")).toBe(true);
    expect(isLocalhostHostname("::1")).toBe(true);
    expect(isLocalhostHostname("[::1]")).toBe(true);
    expect(isLocalhostHostname("192.168.1.10")).toBe(false);
  });

  test("detects insecure HTTP targets from an HTTPS page", () => {
    expect(isInsecureHttpTarget("http://192.168.1.10:11434/", "https://example.github.io/app/")).toBe(true);
    expect(isInsecureHttpTarget("https://192.168.1.10:8443/", "https://example.github.io/app/")).toBe(false);
    expect(isInsecureHttpTarget("http://localhost:11434/", "https://example.github.io/app/")).toBe(false);
    expect(isInsecureHttpTarget("http://192.168.1.10:11434/", "http://example.local/")).toBe(false);
  });

  test("does not diagnose outside a browser secure context", async () => {
    expect(await describeProviderRequestError("http://192.168.1.10:11434/", new TypeError("Failed to fetch"))).toBeNull();
  });
});
