import type {ProviderApi, ProviderDefinition} from "./provider-types";

const supportedApis = new Set<ProviderApi>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai"
]);

export function publicFrontendProviders(value: unknown): ProviderDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const definition = raw as Record<string, unknown>;
    const connection = definition.connection && typeof definition.connection === "object" && !Array.isArray(definition.connection)
      ? definition.connection as Record<string, unknown>
      : null;
    if (connection?.type !== "frontend" || typeof connection.baseUrl !== "string") return [];
    const api = supportedApis.has(definition.api as ProviderApi) ? definition.api as ProviderApi : "openai-completions";
    const baseUrl = connection.baseUrl.replace(/\/+$/, "");
    const discoveryType: ProviderDefinition["discovery"]["type"] = api === "anthropic-messages"
      ? "anthropic-models-list"
      : api === "google-generative-ai" ? "google-models-list" : "openai-models-list";
    const discoveryUrl = discoveryType === "anthropic-models-list"
      ? `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models?limit=200`
      : discoveryType === "google-models-list" ? `${baseUrl}/models?pageSize=200` : `${baseUrl}/models`;
    const auth = definition.auth && typeof definition.auth === "object" && !Array.isArray(definition.auth)
      ? definition.auth as ProviderDefinition["auth"]
      : {type: "none" as const};
    const headers = definition.headers && typeof definition.headers === "object" && !Array.isArray(definition.headers)
      ? definition.headers as Record<string, string>
      : {};
    return [{
      id: String(definition.id || ""),
      name: String(definition.name || definition.id || ""),
      api,
      connection: {
        type: "frontend" as const,
        baseUrl,
        proxy: connection.proxy && typeof connection.proxy === "object"
          ? connection.proxy as ProviderDefinition["connection"]["proxy"]
          : null
      },
      auth,
      headers,
      defaultModel: String(definition.defaultModel || "local-model"),
      discovery: {type: discoveryType, url: discoveryUrl},
      builtin: true,
      credentialState: "local" as const,
      credentials: []
    }];
  }).filter((provider) => provider.id && provider.name);
}
