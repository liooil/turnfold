import type {GenerationSettings} from "../../shared/generation-settings";
import type {ProviderMessage, ProviderModel, ProviderProfile, ProviderProtocol, ProviderSecret, ProviderStreamEvent} from "../../shared/provider-types";
import {describeProviderRequestError} from "./provider-diagnostics";

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

async function providerFetchWithDiagnostics(url: string, init: RequestInit, providerFetch: ProviderFetch) {
  try {
    return await providerFetch(url, init);
  } catch (error) {
    const message = await describeProviderRequestError(url, error);
    if (message) throw new Error(message, {cause: error});
    throw error;
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function outputTokens(value: unknown) {
  const usage = record(value);
  if (!usage) return undefined;
  for (const key of ["output_tokens", "completion_tokens", "candidatesTokenCount", "thoughtsTokenCount"]) {
    const candidate = usage[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.max(0, Math.round(candidate));
  }
  return undefined;
}

export function providerHeaders(profile: Omit<ProviderProfile, "createdAt" | "updatedAt">, secret: ProviderSecret, initial: HeadersInit = {}) {
  const headers = new Headers(initial);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  for (const [name, value] of Object.entries(profile.headers)) headers.set(name, value);
  for (const [name, value] of Object.entries(secret.headers || {})) headers.set(name, value);
  if (profile.auth.type === "bearer" && secret.apiKey) headers.set("Authorization", `Bearer ${secret.apiKey}`);
  if (profile.auth.type === "header" && profile.auth.header && secret.apiKey) headers.set(profile.auth.header, secret.apiKey);
  if (profile.protocol === "anthropic") {
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    if (!headers.has("anthropic-dangerous-direct-browser")) headers.set("anthropic-dangerous-direct-browser", "true");
  }
  return headers;
}

function commonMessages(messages: ProviderMessage[]) {
  return messages.map((message) => ({role: message.role, content: message.text}));
}

export function createProviderRequest(
  profile: ProviderProfile,
  secret: ProviderSecret,
  model: string,
  messages: ProviderMessage[],
  settings: GenerationSettings,
  signal?: AbortSignal
) {
  const headers = providerHeaders(profile, secret, {"Content-Type": "application/json", "Accept": "text/event-stream"});
  if (profile.protocol === "openai-chat") {
    return {
      url: endpoint(profile.baseUrl, "chat/completions"),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: commonMessages(messages),
          stream: true,
          stream_options: {include_usage: true},
          ...(settings.temperature !== null ? {temperature: settings.temperature} : {}),
          ...(settings.maxOutputTokens !== null ? {max_tokens: settings.maxOutputTokens} : {}),
          ...(!["auto", "none"].includes(settings.reasoning) ? {reasoning_effort: settings.reasoning} : {})
        }),
        signal
      } satisfies RequestInit
    };
  }
  if (profile.protocol === "openai-responses") {
    return {
      url: endpoint(profile.baseUrl, "responses"),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: messages.map((message) => ({role: message.role === "system" ? "developer" : message.role, content: message.text})),
          stream: true,
          ...(settings.temperature !== null ? {temperature: settings.temperature} : {}),
          ...(settings.maxOutputTokens !== null ? {max_output_tokens: settings.maxOutputTokens} : {}),
          ...(settings.reasoning !== "none" || settings.showReasoningSummary ? {reasoning: {
            ...(settings.reasoning !== "auto" && settings.reasoning !== "none" ? {effort: settings.reasoning} : {}),
            ...(settings.showReasoningSummary ? {summary: "auto"} : {})
          }} : {})
        }),
        signal
      } satisfies RequestInit
    };
  }
  if (profile.protocol === "anthropic") {
    const system = messages.filter((message) => message.role === "system").map((message) => message.text).join("\n\n");
    return {
      url: endpoint(profile.baseUrl, "messages"),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: messages.filter((message) => message.role !== "system").map((message) => ({role: message.role, content: message.text})),
          ...(system ? {system} : {}),
          max_tokens: settings.maxOutputTokens || 4096,
          stream: true,
          ...(settings.temperature !== null ? {temperature: settings.temperature} : {}),
          ...(settings.showReasoningSummary || !["auto", "none"].includes(settings.reasoning) ? {thinking: {type: "adaptive"}} : {})
        }),
        signal
      } satisfies RequestInit
    };
  }
  const systemInstruction = messages.filter((message) => message.role === "system").map((message) => message.text).join("\n\n");
  return {
    url: `${endpoint(profile.baseUrl, `models/${encodeURIComponent(model)}:streamGenerateContent`)}?alt=sse`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        contents: messages.filter((message) => message.role !== "system").map((message) => ({role: message.role === "assistant" ? "model" : "user", parts: [{text: message.text}]})),
        ...(systemInstruction ? {systemInstruction: {parts: [{text: systemInstruction}]}} : {}),
        generationConfig: {
          ...(settings.temperature !== null ? {temperature: settings.temperature} : {}),
          ...(settings.maxOutputTokens !== null ? {maxOutputTokens: settings.maxOutputTokens} : {}),
          ...(settings.showReasoningSummary ? {thinkingConfig: {includeThoughts: true}} : {})
        }
      }),
      signal
    } satisfies RequestInit
  };
}

type SseMessage = {event: string; data: string};

async function readSse(response: Response, onMessage: (message: SseMessage) => void) {
  if (!response.ok) {
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as {error?: {message?: string} | string; message?: string};
      const nested = typeof payload.error === "object" ? payload.error?.message : payload.error;
      throw new Error(nested || payload.message || `Provider HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(text.slice(0, 1000) || `Provider HTTP ${response.status}`);
      throw error;
    }
  }
  if (!response.body) throw new Error("Streaming response body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (block: string) => {
    let event = "message";
    const data: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) onMessage({event, data: data.join("\n")});
  };
  while (true) {
    const {done, value} = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {stream: !done}).replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
}

export async function parseProviderStream(
  protocol: ProviderProtocol,
  response: Response,
  onEvent: (event: ProviderStreamEvent) => void
) {
  let reportedOutputTokens: number | undefined;
  await readSse(response, ({event, data}) => {
    if (!data || data === "[DONE]") return;
    const payload = JSON.parse(data) as JsonRecord;
    const failure = record(payload.error);
    if (failure?.message) throw new Error(String(failure.message));
    if (protocol === "openai-chat") {
      const choice = Array.isArray(payload.choices) ? record(payload.choices[0]) : null;
      const delta = record(choice?.delta);
      const reasoning = delta?.reasoning_content || delta?.reasoning;
      if (typeof reasoning === "string" && reasoning) onEvent({type: "reasoning-delta", text: reasoning});
      if (typeof delta?.content === "string" && delta.content) onEvent({type: "text-delta", text: delta.content});
      reportedOutputTokens = outputTokens(payload.usage) ?? reportedOutputTokens;
      return;
    }
    if (protocol === "openai-responses") {
      const type = String(payload.type || event);
      if (type === "response.output_text.delta" && typeof payload.delta === "string") onEvent({type: "text-delta", text: payload.delta});
      if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof payload.delta === "string") onEvent({type: "reasoning-delta", text: payload.delta});
      const completed = record(payload.response);
      reportedOutputTokens = outputTokens(completed?.usage) ?? outputTokens(payload.usage) ?? reportedOutputTokens;
      if (type === "response.failed" || type === "error") throw new Error(String(record(completed?.error)?.message || failure?.message || payload.message || "Provider response failed"));
      return;
    }
    if (protocol === "anthropic") {
      const type = String(payload.type || event);
      const delta = record(payload.delta);
      if (type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") onEvent({type: "text-delta", text: delta.text});
      if (type === "content_block_delta" && delta?.type === "thinking_delta" && typeof delta.thinking === "string") onEvent({type: "reasoning-delta", text: delta.thinking});
      reportedOutputTokens = outputTokens(payload.usage) ?? outputTokens(record(payload.message)?.usage) ?? reportedOutputTokens;
      if (type === "error") throw new Error(String(record(payload.error)?.message || "Anthropic request failed"));
      return;
    }
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    for (const candidateValue of candidates) {
      const candidate = record(candidateValue);
      const content = record(candidate?.content);
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      for (const partValue of parts) {
        const part = record(partValue);
        if (typeof part?.text !== "string" || !part.text) continue;
        onEvent({type: part.thought === true ? "reasoning-delta" : "text-delta", text: part.text});
      }
    }
    reportedOutputTokens = outputTokens(payload.usageMetadata) ?? reportedOutputTokens;
  });
  return {outputTokens: reportedOutputTokens};
}

export async function streamProvider(
  profile: ProviderProfile,
  secret: ProviderSecret,
  model: string,
  messages: ProviderMessage[],
  settings: GenerationSettings,
  onEvent: (event: ProviderStreamEvent) => void,
  signal: AbortSignal,
  providerFetch: ProviderFetch = fetch
) {
  const request = createProviderRequest(profile, secret, model, messages, settings, signal);
  const response = await providerFetchWithDiagnostics(request.url, request.init, providerFetch);
  return parseProviderStream(profile.protocol, response, onEvent);
}

export function normalizeDiscoveredModels(payload: unknown): ProviderModel[] {
  const root = record(payload);
  if (!root) return [];
  const source = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  return source.slice(0, 300).flatMap((value) => {
    const model = record(value);
    if (!model) return [];
    const rawId = model.id || model.name || model.model;
    if (typeof rawId !== "string" || !rawId.trim()) return [];
    const id = rawId.replace(/^models\//, "");
    return [{
      id,
      name: typeof model.displayName === "string" ? model.displayName : typeof model.display_name === "string" ? model.display_name : typeof model.name === "string" ? model.name.replace(/^models\//, "") : id,
      ...(typeof model.owned_by === "string" ? {ownedBy: model.owned_by} : {}),
      ...(Number.isFinite(model.context_length) ? {contextWindow: Number(model.context_length)} : {}),
      source: "discovered" as const
    }];
  });
}

export function inferredDiscoveryUrl(profile: ProviderProfile) {
  if (profile.discoveryUrl.trim()) return profile.discoveryUrl.trim();
  if (profile.protocol === "anthropic") return endpoint(profile.baseUrl, "models?limit=200");
  if (profile.protocol === "google") return endpoint(profile.baseUrl, "models?pageSize=50");
  return endpoint(profile.baseUrl, "models");
}

export async function discoverProviderModels(profile: ProviderProfile, secret: ProviderSecret, providerFetch: ProviderFetch = fetch, options: {strictShape?: boolean} = {}) {
  const discoveryUrl = inferredDiscoveryUrl(profile);
  const response = await providerFetchWithDiagnostics(discoveryUrl, {
    headers: providerHeaders(profile, secret, {"Accept": "application/json"}),
    signal: AbortSignal.timeout(15000)
  }, providerFetch);
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
  const payload = await response.json();
  if (options.strictShape) {
    const mismatch = protocolShapeMismatch(profile.protocol, payload);
    if (mismatch) throw new Error(`模型列表与 ${profile.protocol} 协议不匹配：${mismatch}`);
  }
  const models = normalizeDiscoveredModels(payload);
  if (!models.length) throw new Error("Provider 没有返回可用模型");
  return models;
}

export function protocolShapeMismatch(protocol: ProviderProtocol, payload: unknown): string | null {
  const root = record(payload);
  if (!root) return "响应不是 JSON 对象";
  if (protocol === "google") {
    return Array.isArray(root.models) && root.models.length ? null : "缺少 Google 格式的 models 列表";
  }
  if (!Array.isArray(root.data) || !root.data.length) return "缺少 data 模型列表";
  if (protocol === "anthropic") return typeof root.has_more === "boolean" ? null : "缺少 Anthropic 的 has_more 字段";
  return typeof root.has_more === "boolean" ? "响应形如 Anthropic（含 has_more 字段），不是 OpenAI 格式" : null;
}

export type EndpointSmokeResult = "ok" | "auth-denied" | "missing-route";

const AUTH_FAILURE_PATTERN = /api[ _-]?key|unauthori[sz]ed|authentication|invalid (credential|token|api)|permission denied/i;

function smokeRequest(profile: Omit<ProviderProfile, "createdAt" | "updatedAt">, secret: ProviderSecret, models: ProviderModel[]) {
  const init = {method: "POST", headers: providerHeaders(profile, secret, {"Content-Type": "application/json"}), body: "{}"} satisfies RequestInit;
  if (profile.protocol === "anthropic") return {url: endpoint(profile.baseUrl, "messages"), init};
  if (profile.protocol === "google") {
    if (!models[0]) throw new Error("没有可用于冒烟测试的模型");
    return {url: `${endpoint(profile.baseUrl, `models/${encodeURIComponent(models[0].id)}:streamGenerateContent`)}?alt=sse`, init};
  }
  return {url: endpoint(profile.baseUrl, profile.protocol === "openai-responses" ? "responses" : "chat/completions"), init};
}

export async function smokeTestProviderEndpoint(
  profile: Omit<ProviderProfile, "createdAt" | "updatedAt">,
  secret: ProviderSecret,
  models: ProviderModel[],
  providerFetch: ProviderFetch = fetch
): Promise<EndpointSmokeResult> {
  const request = smokeRequest(profile, secret, models);
  const response = await providerFetchWithDiagnostics(request.url, {...request.init, signal: AbortSignal.timeout(15000)}, providerFetch);
  if (response.status === 401 || response.status === 403) return "auth-denied";
  if (response.status === 404 || response.status === 405) return "missing-route";
  if (response.status >= 400) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      // 响应体不可读时按普通 4xx 处理
    }
    if (AUTH_FAILURE_PATTERN.test(body)) return "auth-denied";
  }
  return "ok";
}
