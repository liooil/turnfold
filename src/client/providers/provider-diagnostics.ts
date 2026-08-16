export function isLocalhostHostname(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || normalized.endsWith(".localhost");
}

export function isInsecureHttpTarget(targetUrl: string, pageUrl?: string) {
  const resolvedPageUrl = pageUrl || (typeof window !== "undefined" ? window.location.href : "");
  try {
    const target = new URL(targetUrl);
    const page = new URL(resolvedPageUrl);
    return page.protocol === "https:" && target.protocol === "http:" && !isLocalhostHostname(target.hostname);
  } catch {
    return false;
  }
}

export async function describeProviderRequestError(url: string, originalError: unknown) {
  if (typeof window === "undefined" || !window.isSecureContext) return null;
  if (!isInsecureHttpTarget(url)) return null;
  if (originalError && typeof originalError === "object" && "name" in originalError && originalError.name === "AbortError") return null;
  try {
    const target = new URL(url);
    await fetch(`${target.origin}/`, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(5000)
    });
    return `浏览器已允许访问该 HTTP 地址（${url}），但仍无法完成请求。请检查目标服务的 CORS 配置；若为局域网地址，还需允许 Access-Control-Allow-Private-Network: true。`;
  } catch {
    return `当前页面为 HTTPS，而目标 Provider 是 HTTP 局域网地址（${url}）。这很可能是浏览器阻止 HTTPS 页面加载不安全内容（Mixed Content），也可能是目标服务不可达或本地网络访问受限。请给模型服务配置 HTTPS 反向代理，或在浏览器中允许该站点加载不安全内容（仅限本机调试）。`;
  }
}
