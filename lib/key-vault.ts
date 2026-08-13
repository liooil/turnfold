import {readFileSync} from "node:fs";

export type ChatIdentity = {issuer: string; sub: string; username: string; name: string; email: string};
type HeaderReader = Pick<Headers, "get">;

const keyVaultUrl = process.env.KEY_VAULT_URL?.trim() || "";
const authIssuer = process.env.AUTH_ISSUER?.trim() || process.env.AUTHENTIK_ISSUER?.trim() || "turnfold:forward-auth";
const serviceTokenFile = process.env.KEY_VAULT_TOKEN_FILE?.trim() || "";
const authMode = process.env.AUTH_MODE?.trim().toLowerCase() || "forward-auth";
let serviceToken: string | null = null;

function loadServiceToken() {
  if (!serviceTokenFile) throw new Error("KEY_VAULT_TOKEN_FILE is not configured");
  if (!serviceToken) serviceToken = readFileSync(/* turbopackIgnore: true */ serviceTokenFile, "utf8").trim();
  return serviceToken;
}

export function keyVaultAvailable() {
  return Boolean(keyVaultUrl && serviceTokenFile);
}

export function identityFromHeaders(headers: HeaderReader): ChatIdentity {
  if (authMode === "single-user") {
    const username = process.env.SINGLE_USER_NAME?.trim() || "local";
    return {issuer: "turnfold:single-user", sub: "default", username, name: username, email: ""};
  }
  const username = headers.get("x-turnfold-username")?.trim()
    || headers.get("x-authentik-username")?.trim()
    || headers.get("x-forwarded-user")?.trim()
    || "";
  const sub = headers.get("x-turnfold-sub")?.trim()
    || headers.get("x-authentik-uid")?.trim()
    || headers.get("x-forwarded-sub")?.trim()
    || username;
  if (!username || !sub) {
    const error = new Error("Authenticated user context is required");
    Object.assign(error, {statusCode: 401});
    throw error;
  }
  return {
    issuer: headers.get("x-turnfold-issuer")?.trim() || authIssuer,
    sub,
    username,
    name: headers.get("x-authentik-name")?.trim() || username,
    email: headers.get("x-authentik-email")?.trim() || ""
  };
}

export function keyVaultFetch(
  pathname: string,
  identity: ChatIdentity,
  init: {method?: string; body?: string; headers?: HeadersInit} = {}
) {
  if (!keyVaultAvailable()) throw new Error("Key Vault is not configured");
  const method = init.method || "GET";
  return fetch(new URL(pathname, keyVaultUrl), {
    method,
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${loadServiceToken()}`,
      ...init.headers,
      "X-Key-Vault-Actor-Issuer": identity.issuer,
      "X-Key-Vault-Actor-Sub": identity.sub,
      "X-Key-Vault-Actor-Username": identity.username
    },
    body: init.body,
    cache: "no-store",
    signal: AbortSignal.timeout(300000)
  });
}
