export type ApiCorsDecision = {
  allowed: boolean;
  responseOrigin: string;
};

export function parseBackendAllowedOrigins(value: string | undefined) {
  const origins = new Set<string>();
  for (const entry of String(value || "").split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(`Invalid BACKEND_ALLOWED_ORIGINS entry: ${candidate}`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`BACKEND_ALLOWED_ORIGINS entries must be HTTP(S) origins without a path: ${candidate}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function firstForwardedValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() || "";
}

function forwardedRequestOrigin(request: Request) {
  const protocol = firstForwardedValue(request.headers.get("x-forwarded-proto")).toLowerCase();
  if (protocol !== "http" && protocol !== "https") return "";
  try {
    const url = new URL(request.url);
    url.protocol = `${protocol}:`;
    return url.origin;
  } catch {
    return "";
  }
}

export function apiCorsDecision(request: Request, allowedOrigins: ReadonlySet<string>): ApiCorsDecision {
  const origin = request.headers.get("origin")?.trim() || "";
  if (!origin) return {allowed: true, responseOrigin: ""};
  const requestOrigins = new Set([new URL(request.url).origin, forwardedRequestOrigin(request)]);
  if (requestOrigins.has(origin) || allowedOrigins.has(origin)) return {allowed: true, responseOrigin: origin};
  return {allowed: false, responseOrigin: ""};
}

function appendVary(headers: Headers, values: string[]) {
  const current = (headers.get("vary") || "").split(",").map((value) => value.trim()).filter(Boolean);
  const names = new Map(current.map((value) => [value.toLowerCase(), value]));
  for (const value of values) names.set(value.toLowerCase(), value);
  headers.set("Vary", [...names.values()].join(", "));
}

function corsHeaders(request: Request, decision: ApiCorsDecision) {
  const headers = new Headers();
  if (decision.responseOrigin) {
    headers.set("Access-Control-Allow-Origin", decision.responseOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  appendVary(headers, ["Origin"]);
  if (request.headers.get("access-control-request-private-network") === "true") {
    headers.set("Access-Control-Allow-Private-Network", "true");
  }
  return headers;
}

export function apiCorsPreflightResponse(request: Request, decision: ApiCorsDecision) {
  const headers = corsHeaders(request, decision);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Length", "0");
  appendVary(headers, ["Access-Control-Request-Method", "Access-Control-Request-Headers"]);
  return new Response(null, {status: 204, headers});
}

export function applyApiCors(response: Response, request: Request, decision: ApiCorsDecision) {
  if (!decision.responseOrigin) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request, decision)) headers.set(name, value);
  appendVary(headers, ["Origin"]);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
