export function validProviderUrl(value: string, label: string, required = true) {
  if (!value && !required) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return value.replace(/\/+$/, "");
  } catch {
    throw new Error(`${label} 必须是有效的 http 或 https URL`);
  }
}

export function validProviderId(value: string) {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)) throw new Error("Provider 标识只能包含小写字母、数字、点、下划线和连字符");
  return id;
}

export function providerHeadersFromJson(value: string) {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("附加 Headers 必须是有效的 JSON 对象");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("附加 Headers 必须是 JSON 对象");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") throw new Error(`Header ${name} 的值必须是字符串`);
    if (!name.trim()) throw new Error("Header 名称不能为空");
    headers[name] = headerValue;
  }
  return headers;
}
