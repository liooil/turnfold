export const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    "connect-src 'self' http: https: ws: wss:"
  ].join("; "),
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

export function json(payload: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(payload, {status, headers: {...securityHeaders, "Cache-Control": "no-store", ...headers}});
}

export function errorStatus(error: unknown, fallback: number) {
  return typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : fallback;
}
