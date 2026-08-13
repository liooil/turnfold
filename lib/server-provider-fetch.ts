import nodeFetch from "node-fetch";
import {ProxyAgent} from "proxy-agent";
import type {ProviderDefinition, ProviderSecret} from "./provider-types";

export function createServerProviderFetch(provider: ProviderDefinition, secret: ProviderSecret) {
  const proxy = provider.connection.proxy;
  if (!proxy) return fetch;
  const proxyUrl = new URL(proxy.url);
  if (secret.proxy?.username) proxyUrl.username = secret.proxy.username;
  if (secret.proxy?.password) proxyUrl.password = secret.proxy.password;
  const agent = new ProxyAgent({getProxyForUrl: () => proxyUrl.toString()});
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await nodeFetch(String(input), {...init, agent} as never);
    return response as unknown as Response;
  };
}
