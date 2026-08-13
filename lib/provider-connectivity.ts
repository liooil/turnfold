import {applyProviderAuthentication} from "./provider-model";
import type {ProviderDefinition, ProviderModel, ProviderSecret} from "./provider-types";

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;


function accountEndpoints(provider: ProviderDefinition) {
  const baseUrl = provider.connection.baseUrl.replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.hostname === "openrouter.ai") return ["https://openrouter.ai/api/v1/auth/key"];
  if (url.hostname === "api.deepseek.com") return [`${url.origin}/user/balance`];
  if (url.hostname === "api.moonshot.cn") return [`${baseUrl}/users/me/balance`];
  if (url.hostname === "api.openai.com") return [`${baseUrl}/dashboard/billing/credit_grants`];
  if (["openai-completions", "openai-responses"].includes(provider.api)) return [`${baseUrl}/dashboard/billing/credit_grants`];
  return [];
}

async function responseText(response: Response, maximum = 4 * 1024 * 1024) {
  const text = await response.text();
  if (text.length > maximum) throw new Error("Provider response is too large");
  return text;
}

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function publicMetadata(value: unknown, depth = 0): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => publicMetadata(item, depth + 1)).filter((item) => item !== undefined);
  const record = jsonRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).slice(0, 50).map(([key, item]) => [key, publicMetadata(item, depth + 1)]).filter((entry) => entry[1] !== undefined));
}

function selectedMetadata(record: JsonRecord, pattern: RegExp) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => pattern.test(key)).map(([key, value]) => [key, publicMetadata(value)]).filter((entry) => entry[1] !== undefined));
}

export function normalizeDiscoveredModels(payload: unknown): ProviderModel[] {
  const root = jsonRecord(payload);
  if (!root) return [];
  const source = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  return source.slice(0, 300).map((value) => {
    const model = jsonRecord(value);
    if (!model) return null;
    const rawId = model.id || model.name || model.model;
    if (typeof rawId !== "string" || !rawId.trim()) return null;
    const id = rawId.replace(/^models\//, "");
    const pricing = selectedMetadata(model, /price|pricing|cost|rate|token/i);
    return {
      id,
      name: typeof model.displayName === "string" ? model.displayName : typeof model.name === "string" ? model.name.replace(/^models\//, "") : id,
      ...(typeof model.owned_by === "string" ? {ownedBy: model.owned_by} : {}),
      ...(Number.isFinite(model.context_length) ? {contextWindow: Number(model.context_length)} : {}),
      ...(Object.keys(pricing).length ? {pricing} : {})
    };
  }).filter((model): model is ProviderModel => model !== null);
}

function normalizeLlamaCppProps(payload: unknown, fallbackModel: string): ProviderModel[] {
  const root = jsonRecord(payload);
  if (!root) return [];
  const modelPath = typeof root.model_path === "string" ? root.model_path : "";
  const modelAlias = typeof root.model_alias === "string" ? root.model_alias : "";
  const id = modelAlias.trim() || modelPath.split(/[\\/]/).filter(Boolean).at(-1) || fallbackModel;
  const generationSettings = jsonRecord(root.default_generation_settings);
  const contextWindow = Number(generationSettings?.n_ctx);
  return [{
    id,
    name: id,
    ownedBy: "llamacpp",
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? {contextWindow} : {})
  }];
}

function responseRateLimits(response: Response) {
  return Object.fromEntries([...response.headers.entries()].filter(([name]) => /rate.?limit|retry-after|quota/i.test(name)));
}

async function fetchJson(providerFetch: ProviderFetch, endpoint: string, headers: Headers, timeoutMs = 15000) {
  const response = await providerFetch(endpoint, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await responseText(response);
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = {preview: text.slice(0, 1000)};
  }
  return {response, payload};
}

async function modelProbe(provider: ProviderDefinition, secret: ProviderSecret, providerFetch: ProviderFetch) {
  const endpoint = provider.discovery.url;
  const headers = applyProviderAuthentication(provider, secret, {
    "Accept": "application/json",
    ...(provider.discovery.type === "anthropic-models-list" ? {"anthropic-version": "2023-06-01"} : {})
  });
  const startedAt = performance.now();
  const initial = await fetchJson(providerFetch, endpoint, headers);
  let {response, payload} = initial;
  let resolvedEndpoint = endpoint;
  let models = response.ok ? normalizeDiscoveredModels(payload) : [];
  if (provider.id === "llama.cpp" && models.length === 0) {
    const propsEndpoint = `${provider.connection.baseUrl.replace(/\/v1\/?$/, "")}/props`;
    try {
      const props = await fetchJson(providerFetch, propsEndpoint, headers, 5000);
      const propsModels = props.response.ok ? normalizeLlamaCppProps(props.payload, provider.defaultModel) : [];
      if (propsModels.length > 0) {
        response = props.response;
        payload = props.payload;
        resolvedEndpoint = propsEndpoint;
        models = propsModels;
      }
    } catch {
      // Preserve the primary /v1/models error when the compatibility probe also fails.
    }
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (!response.ok) {
    const root = jsonRecord(payload);
    const detail = root?.preview || root?.error || root?.message;
    const error = new Error(typeof detail === "string" ? detail : `Provider HTTP ${response.status}`);
    Object.assign(error, {statusCode: response.status});
    throw error;
  }
  return {endpoint: resolvedEndpoint, headers, response, payload, latencyMs, models};
}

export async function discoverProviderModels(
  provider: ProviderDefinition,
  secret: ProviderSecret,
  providerFetch: ProviderFetch = fetch
) {
  const probe = await modelProbe(provider, secret, providerFetch);
  return {
    endpoint: probe.endpoint,
    status: probe.response.status,
    latencyMs: probe.latencyMs,
    models: probe.models
  };
}

export async function testProviderConnectivity(
  provider: ProviderDefinition,
  secret: ProviderSecret,
  providerFetch: ProviderFetch = fetch
) {
  const probe = await modelProbe(provider, secret, providerFetch);
  const {endpoint, headers, response, payload, latencyMs, models} = probe;
  const root = jsonRecord(payload) || {};
  const account = selectedMetadata(root, /balance|credit|quota|usage|limit|billing|currency/i);
  const rateLimits = responseRateLimits(response);
  const accountUrls = accountEndpoints(provider);
  let accountProbe: unknown = null;
  for (const accountUrl of accountUrls) {
    try {
      const probe = await fetchJson(providerFetch, accountUrl, headers, 5000);
      if (!probe.response.ok) continue;
      accountProbe = {
        endpoint: accountUrl,
        status: probe.response.status,
        data: publicMetadata(jsonRecord(probe.payload)?.data || probe.payload)
      };
      break;
    } catch {
      // Account metadata is best-effort and must not fail a successful model probe.
    }
  }

  return {
    ok: true,
    status: response.status,
    latencyMs,
    endpoint,
    modelCount: models.length,
    models,
    account: Object.keys(account).length ? account : null,
    accountProbe,
    rateLimits: Object.keys(rateLimits).length ? rateLimits : null
  };
}
