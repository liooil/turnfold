import type {StoredChatMessage} from "./conversation-types";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function canonicalMessage(message: Omit<StoredChatMessage, "id">) {
  return JSON.stringify(canonicalValue(message));
}

export async function messageObjectId(message: Omit<StoredChatMessage, "id">, namespace = "") {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}\0${canonicalMessage(message)}`));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createMessageObject(message: Omit<StoredChatMessage, "id">, namespace = ""): Promise<StoredChatMessage> {
  return {...message, id: await messageObjectId(message, namespace)};
}

export async function validMessageObjectId(message: StoredChatMessage, namespace = "") {
  if (!message.id.startsWith("sha256:")) return false;
  const {id: _id, ...content} = message;
  return message.id === await messageObjectId(content, namespace);
}
