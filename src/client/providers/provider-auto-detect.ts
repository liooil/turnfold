import type {ProviderProfile, ProviderProtocol, ProviderSecret} from "../../shared/provider-types";
import {discoverProviderModels} from "./provider-runtime";

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ProviderDraft = Omit<ProviderProfile, "createdAt" | "updatedAt">;

function parsedProviderUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入有效的 Provider URL");
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Provider URL 必须使用 http 或 https");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/(?:chat\/completions|responses|models)\/?$/i, "")
    .replace(/\/+$/, "") || "/";
  return url;
}

function baseUrlCandidates(url: URL) {
  const base = url.toString().replace(/\/+$/, "");
  const versionPath = url.hostname.includes("generativelanguage.googleapis.com") ? "v1beta" : "v1";
  const candidates = url.pathname === "/"
    ? [`${url.origin}/${versionPath}`, url.origin]
    : [base];
  return [...new Set(candidates)];
}

function protocolCandidates(url: URL): ProviderProtocol[] {
  const hint = `${url.hostname}${url.pathname}`.toLowerCase();
  const first: ProviderProtocol = hint.includes("anthropic")
    ? "anthropic"
    : hint.includes("generativelanguage.googleapis.com") || hint.includes("gemini")
      ? "google"
      : hint.includes("openai.com")
        ? "openai-responses"
        : "openai-chat";
  if (first === "openai-responses") return [first];
  if (first === "anthropic" || first === "google") return [first, "openai-chat"];
  return ["openai-chat", "anthropic", "google"];
}

function authForProtocol(protocol: ProviderProtocol): ProviderProfile["auth"] {
  if (protocol === "anthropic") return {type: "header", header: "x-api-key"};
  if (protocol === "google") return {type: "header", header: "x-goog-api-key"};
  return {type: "bearer"};
}

function decodeTitle(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function websiteTitle(url: URL, providerFetch: ProviderFetch, signal?: AbortSignal) {
  try {
    const response = await providerFetch(url.origin, {
      cache: "no-store",
      credentials: "omit",
      headers: {Accept: "text/html"},
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)])
    });
    const contentType = response.headers.get("content-type") || "";
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (!response.ok || contentLength > 1_000_000 || contentType && !contentType.includes("text/html")) return "";
    const match = (await response.text()).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? decodeTitle(match[1]) : "";
  } catch {
    return "";
  }
}

function domainIdentity(url: URL) {
  if (url.hostname === "localhost" || /^[\d.]+$/.test(url.hostname)) {
    const label = url.port ? `${url.hostname}-${url.port}` : url.hostname;
    return {id: label.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase(), name: url.host};
  }
  const segments = url.hostname.toLowerCase().split(".").filter(Boolean);
  while (["www", "api"].includes(segments[0])) segments.shift();
  const idSegments = segments.length > 1 ? segments.slice(0, -1) : segments;
  return {
    id: idSegments.join("-").replace(/[^a-z0-9-]+/g, "-") || "provider",
    name: segments.join(".") || url.hostname
  };
}

function uniqueProviderId(baseId: string, usedIds: Iterable<string>) {
  const used = new Set(usedIds);
  if (!used.has(baseId)) return baseId;
  let suffix = 2;
  while (used.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

export async function autoDetectProvider(
  urlValue: string,
  apiKey: string,
  usedIds: Iterable<string>,
  providerFetch: ProviderFetch = fetch,
  signal?: AbortSignal
): Promise<ProviderDraft> {
  const url = parsedProviderUrl(urlValue);
  const secret: ProviderSecret = apiKey ? {apiKey} : {};
  const probeFetch: ProviderFetch = (input, init = {}) => providerFetch(input, {
    ...init,
    signal: AbortSignal.any([...(signal ? [signal] : []), ...(init.signal ? [init.signal] : []), AbortSignal.timeout(5000)])
  });
  let lastError: unknown;
  for (const baseUrl of baseUrlCandidates(url)) {
    for (const protocol of protocolCandidates(url)) {
      const candidate: ProviderDraft = {
        id: "detecting",
        name: "Detecting",
        protocol,
        baseUrl,
        auth: apiKey ? authForProtocol(protocol) : {type: "none"},
        headers: {},
        discoveryUrl: "",
        models: [],
        defaultModel: ""
      };
      try {
        const models = await discoverProviderModels({...candidate, createdAt: "", updatedAt: ""}, secret, probeFetch);
        const domain = domainIdentity(url);
        const title = await websiteTitle(url, providerFetch, signal);
        return {
          ...candidate,
          id: uniqueProviderId(domain.id, usedIds),
          name: title || domain.name,
          models,
          defaultModel: models[0]?.id || ""
        };
      } catch (error) {
        lastError = error;
      }
    }
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : "";
  throw new Error(`未能从该 URL 探测到兼容的模型目录${detail}`);
}
