import path from "node:path";
import {json, securityHeaders} from "./http";
import {staticRoot} from "./runtime";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp"
};

export type StaticResponseOptions = {
  root?: string;
};

export async function staticResponse(pathname: string, options: StaticResponseOptions = {}) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return json({error: "Invalid path"}, 400);
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = path.resolve(options.root || staticRoot);
  let filePath = path.resolve(root, relative);
  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, "index.html")) return json({error: "Not found"}, 404);
  let file = Bun.file(filePath);
  if (!(await file.exists()) && !path.extname(relative)) {
    filePath = path.join(root, "index.html");
    file = Bun.file(filePath);
  }
  if (!(await file.exists())) return json({error: "Not found"}, 404);
  const extension = path.extname(filePath);
  const immutable = /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(path.basename(filePath))
    || relative.startsWith("assets/mathjax/4.1.3/");
  return new Response(file, {
    headers: {
      ...securityHeaders,
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" || path.basename(filePath) === "sw.js"
        ? "no-cache"
        : immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600"
    }
  });
}
