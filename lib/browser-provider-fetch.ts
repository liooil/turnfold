import type {ProviderDefinition, ProviderSecret} from "./provider-types";

export function createBrowserProviderFetch(provider: ProviderDefinition, secret: ProviderSecret) {
  const proxy = provider.connection.proxy;
  if (!proxy) return fetch;
  if (proxy.type !== "relay") throw new Error(`Unsupported frontend proxy: ${proxy.type}`);
  return async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const relayHeaders: Record<string, string> = {"Content-Type": "application/json"};
    if (secret.proxy?.token) relayHeaders.Authorization = `Bearer ${secret.proxy.token}`;
    return fetch(proxy.url, {
      method: "POST",
      headers: relayHeaders,
      body: JSON.stringify({
        url: String(input),
        method: init.method || "GET",
        headers: Object.fromEntries(headers.entries()),
        body: typeof init.body === "string" ? init.body : null
      }),
      signal: init.signal
    });
  };
}
