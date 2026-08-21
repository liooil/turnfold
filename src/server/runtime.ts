import path from "node:path";
import {parseBackendAllowedOrigins} from "./cors";

function normalizedBasePath(value: string | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export const port = Number.parseInt(process.env.PORT || "3000", 10);
export const portalUrl = process.env.PORTAL_URL?.trim() || "";
export const staticRoot = path.resolve(process.env.STATIC_ROOT || "dist");
export const basePath = normalizedBasePath(process.env.BASE_PATH);
export const backendAllowedOrigins = parseBackendAllowedOrigins(process.env.BACKEND_ALLOWED_ORIGINS);
