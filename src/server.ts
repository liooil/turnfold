import {apiResponse} from "./server/api";
import {apiCorsDecision, apiCorsPreflightResponse, applyApiCors} from "./server/cors";
import {developmentStaticResponse} from "./server/development-static";
import {json} from "./server/http";
import {backendAllowedOrigins, basePath, port} from "./server/runtime";
import {staticResponse} from "./server/static-files";

const isDevelopment = process.env.NODE_ENV !== "production";
const serveStatic = isDevelopment ? developmentStaticResponse : staticResponse;

async function handleRequest(request: Request) {
  const url = new URL(request.url);
  if (basePath && url.pathname === basePath) return Response.redirect(new URL(`${basePath}/${url.search}${url.hash}`, request.url), 308);
  if (basePath && !url.pathname.startsWith(`${basePath}/`)) return json({error: "Not found"}, 404);
  const pathname = url.pathname.slice(basePath.length) || "/";
  const isApi = pathname.startsWith("/api/");
  const cors = apiCorsDecision(request, backendAllowedOrigins);
  if (isApi && !cors.allowed) return json({error: "Request origin is not allowed"}, 403);
  if (isApi && request.method === "OPTIONS") return apiCorsPreflightResponse(request, cors);
  const api = await apiResponse(request, pathname);
  if (api) return applyApiCors(api, request, cors);
  if (request.method !== "GET" && request.method !== "HEAD") return json({error: "Method not allowed"}, 405);
  return serveStatic(pathname);
}

if (isDevelopment) {
  const {default: appHtml} = await import("./index.html") as {default: Bun.HTMLBundle};
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    development: true,
    routes: {
      [`${basePath}/`]: appHtml
    },
    fetch: handleRequest
  });
  console.log(`Turnfold Bun dev server listening on ${new URL(basePath ? `${basePath}/` : "/", server.url)}`);
} else {
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    fetch: handleRequest
  });
  console.log(`Turnfold Bun server listening on ${new URL(basePath ? `${basePath}/` : "/", server.url)}`);
}
