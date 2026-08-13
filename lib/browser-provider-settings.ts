import type {ProviderDefinition, ProviderSecret} from "./provider-types";

function inferredDiscoveryUrl(provider: ProviderDefinition, baseUrl: string) {
  if (provider.discovery.type === "anthropic-models-list") return `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models?limit=200`;
  if (provider.discovery.type === "google-models-list") return `${baseUrl}/models?pageSize=200`;
  return `${baseUrl}/models`;
}

export function applyBrowserProviderSettings(provider: ProviderDefinition, secret: ProviderSecret) {
  const configuredBaseUrl = secret.provider?.baseUrl?.trim();
  if (!configuredBaseUrl) return provider;
  const url = new URL(configuredBaseUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Provider Base URL 必须使用 http 或 https");
  const baseUrl = configuredBaseUrl.replace(/\/+$/, "");
  const originalBaseUrl = provider.connection.baseUrl.replace(/\/+$/, "");
  const discoveryUrl = provider.discovery.url.startsWith(originalBaseUrl)
    ? inferredDiscoveryUrl(provider, baseUrl)
    : provider.discovery.url;
  return {
    ...provider,
    connection: {...provider.connection, baseUrl},
    discovery: {...provider.discovery, url: discoveryUrl}
  };
}
