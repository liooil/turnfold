import {apiResponse} from "./server/api";
import {json} from "./server/http";
import {basePath, port} from "./server/runtime";
import {staticResponse} from "./server/static-files";

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (basePath && url.pathname === basePath) return Response.redirect(new URL(`${basePath}/${url.search}${url.hash}`, request.url), 308);
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) return json({error: "Not found"}, 404);
    const pathname = url.pathname.slice(basePath.length) || "/";
    const api = await apiResponse(request, pathname);
    if (api) return api;
    if (request.method !== "GET" && request.method !== "HEAD") return json({error: "Method not allowed"}, 405);
    return staticResponse(pathname);
  }
});

console.log(`Turnfold Bun server listening on ${new URL(basePath ? `${basePath}/` : "/", server.url)}`);
