import {describe, expect, test} from "bun:test";
import {
  apiCorsDecision,
  apiCorsPreflightResponse,
  applyApiCors,
  parseBackendAllowedOrigins
} from "./cors.ts";

describe("Backend CORS origins", () => {
  test("normalizes only exact HTTP(S) origins", () => {
    expect([...parseBackendAllowedOrigins("https://app.example.test/, http://127.0.0.1:3000")])
      .toEqual(["https://app.example.test", "http://127.0.0.1:3000"]);
    expect(() => parseBackendAllowedOrigins("*")).toThrow("BACKEND_ALLOWED_ORIGINS");
    expect(() => parseBackendAllowedOrigins("https://app.example.test/turnfold")).toThrow("without a path");
    expect(() => parseBackendAllowedOrigins("https://user:secret@app.example.test")).toThrow("without a path");
  });

  test("allows same-origin, configured origins, and requests without Origin", () => {
    const allowed = parseBackendAllowedOrigins("https://pages.example.test");
    expect(apiCorsDecision(new Request("http://127.0.0.1:3000/api/config"), allowed))
      .toEqual({allowed: true, responseOrigin: ""});
    expect(apiCorsDecision(new Request("http://127.0.0.1:3000/api/config", {
      headers: {Origin: "http://127.0.0.1:3000"}
    }), allowed)).toEqual({allowed: true, responseOrigin: "http://127.0.0.1:3000"});
    expect(apiCorsDecision(new Request("http://127.0.0.1:3000/api/config", {
      headers: {Origin: "https://pages.example.test"}
    }), allowed)).toEqual({allowed: true, responseOrigin: "https://pages.example.test"});
  });

  test("uses forwarded origin for a same-origin deployment behind TLS", () => {
    const decision = apiCorsDecision(new Request("http://turnfold.example.test/api/config", {
      headers: {
        Origin: "https://turnfold.example.test",
        "X-Forwarded-Proto": "https"
      }
    }), new Set());
    expect(decision).toEqual({allowed: true, responseOrigin: "https://turnfold.example.test"});
  });

  test("rejects an unlisted or opaque browser origin", () => {
    const allowed = parseBackendAllowedOrigins("https://pages.example.test");
    for (const origin of ["https://hostile.example.test", "null"]) {
      expect(apiCorsDecision(new Request("http://127.0.0.1:3000/api/config", {
        headers: {Origin: origin}
      }), allowed)).toEqual({allowed: false, responseOrigin: ""});
    }
  });
});

describe("Backend CORS responses", () => {
  const origin = "https://pages.example.test";

  test("answers preflight with the exact origin and constrained request surface", () => {
    const request = new Request("http://127.0.0.1:3000/api/sync/push", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true"
      }
    });
    const decision = apiCorsDecision(request, new Set([origin]));
    const response = apiCorsPreflightResponse(request, decision);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Accept, Content-Type");
    expect(response.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  test("adds credentialed CORS to the actual API response", async () => {
    const request = new Request("http://127.0.0.1:3000/api/config", {headers: {Origin: origin}});
    const response = applyApiCors(Response.json({ok: true}), request, apiCorsDecision(request, new Set([origin])));
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(await response.json()).toEqual({ok: true});
  });
});
