const conversationHashKey = "conversation";

export function conversationIdFromHash(hash: string) {
  const input = hash.startsWith("#") ? hash.slice(1) : hash;
  const id = new URLSearchParams(input).get(conversationHashKey)?.trim() || "";
  return id && id.length <= 120 ? id : "";
}

export function conversationHash(id: string) {
  const parameters = new URLSearchParams();
  parameters.set(conversationHashKey, id);
  return `#${parameters.toString()}`;
}
