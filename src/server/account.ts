import {createHash} from "node:crypto";
import {identityFromHeaders, type ChatIdentity} from "./identity";
import {errorStatus, json} from "./http";
import {portalUrl} from "./runtime";

export function identityKey(identity: ChatIdentity) {
  return createHash("sha256").update(`${identity.issuer}\0${identity.sub}`).digest("hex").slice(0, 32);
}

async function accountProfile(identity: ChatIdentity) {
  const fallback = {username: identity.username, name: identity.name || identity.username, email: identity.email};
  if (!portalUrl) return fallback;
  try {
    const response = await fetch(new URL("/api/account/identity", portalUrl), {
      headers: {
        "Accept": "application/json",
        "X-Portal-Authenticated": "1",
        "X-Authentik-Username": identity.username,
        "X-Authentik-Uid": identity.sub,
        "X-Authentik-Email": identity.email
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return fallback;
    const payload = await response.json() as {profile?: {username?: string; name?: string; email?: string}};
    return {
      username: payload.profile?.username?.trim() || fallback.username,
      name: payload.profile?.name?.trim() || fallback.name,
      email: payload.profile?.email?.trim() || fallback.email
    };
  } catch {
    return fallback;
  }
}

export async function accountConfig(request: Request) {
  try {
    const identity = identityFromHeaders(request.headers);
    return json({identityKey: identityKey(identity), profile: await accountProfile(identity), capabilities: {sync: true}});
  } catch (error) {
    return json({error: error instanceof Error ? error.message : "Account configuration unavailable"}, errorStatus(error, 503));
  }
}
