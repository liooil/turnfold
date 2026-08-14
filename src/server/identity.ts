export type ChatIdentity = {issuer: string; sub: string; username: string; name: string; email: string};
type HeaderReader = Pick<Headers, "get">;

const authIssuer = process.env.AUTH_ISSUER?.trim() || process.env.AUTHENTIK_ISSUER?.trim() || "turnfold:forward-auth";
const authMode = process.env.AUTH_MODE?.trim().toLowerCase() || "forward-auth";

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
