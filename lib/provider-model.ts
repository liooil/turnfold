import type {ProviderDefinition, ProviderSecret} from "./provider-types";

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function applyProviderAuthentication(
  provider: ProviderDefinition,
  secret: ProviderSecret,
  inputHeaders?: HeadersInit
) {
  const headers = new Headers(inputHeaders);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  for (const [name, value] of Object.entries(provider.headers || {})) headers.set(name, value);
  for (const [name, value] of Object.entries(secret.provider?.headers || {})) headers.set(name, value);
  const apiKey = secret.provider?.apiKey || "";
  if (provider.auth.type === "bearer" && apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  if (provider.auth.type === "header" && provider.auth.header && apiKey) headers.set(provider.auth.header, apiKey);
  return headers;
}

export async function createProviderModel(
  provider: ProviderDefinition,
  secret: ProviderSecret,
  modelId: string,
  providerFetch: ProviderFetch
) {
  const authenticatedFetch: ProviderFetch = (input, init = {}) => providerFetch(input, {
    ...init,
    headers: applyProviderAuthentication(provider, secret, init.headers)
  });
  // Provider API comes from the runtime Registry; dynamic imports keep unused SDKs out of the initial client chunk.
  if (provider.api === "openai-completions") {
    const {createOpenAICompatible} = await import("@ai-sdk/openai-compatible");
    return createOpenAICompatible({
      name: provider.id,
      baseURL: provider.connection.baseUrl,
      fetch: authenticatedFetch as typeof fetch
    }).chatModel(modelId);
  }
  if (provider.api === "openai-responses") {
    const {createOpenAI} = await import("@ai-sdk/openai");
    return createOpenAI({
      name: provider.id,
      baseURL: provider.connection.baseUrl,
      apiKey: secret.provider?.apiKey || "browser-managed",
      fetch: authenticatedFetch as typeof fetch
    }).responses(modelId);
  }
  if (provider.api === "anthropic-messages") {
    const {createAnthropic} = await import("@ai-sdk/anthropic");
    return createAnthropic({
      name: provider.id,
      baseURL: provider.connection.baseUrl,
      apiKey: secret.provider?.apiKey || "browser-managed",
      fetch: authenticatedFetch as typeof fetch
    }).messages(modelId);
  }
  const {createGoogleGenerativeAI} = await import("@ai-sdk/google");
  return createGoogleGenerativeAI({
    name: provider.id,
    baseURL: provider.connection.baseUrl,
    apiKey: secret.provider?.apiKey || "browser-managed",
    fetch: authenticatedFetch as typeof fetch
  }).chat(modelId);
}
