import type {StoredChatMessage} from "./conversation-types";

export function mergeMessageGraph(...groups: StoredChatMessage[][]) {
  return new Map(groups.flat().map((message) => [message.id, message]));
}

export function messagePathInGraph(messages: Map<string, StoredChatMessage>, headMessageId: string | null) {
  const reversed: StoredChatMessage[] = [];
  const seen = new Set<string>();
  let cursor = headMessageId;
  while (cursor) {
    if (seen.has(cursor) || reversed.length >= 500) return [];
    seen.add(cursor);
    const message = messages.get(cursor);
    if (!message) return [];
    reversed.push(message);
    cursor = message.parentMessageId;
  }
  return reversed.reverse();
}

export function messageChildrenInGraph(messages: Map<string, StoredChatMessage>, parentMessageId: string | null) {
  return [...messages.values()]
    .filter((message) => message.parentMessageId === parentMessageId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function rootEditAlternativesInGraph(messages: Map<string, StoredChatMessage>, messageId: string) {
  const roots = [...messages.values()].filter((message) => message.parentMessageId === null);
  const related = new Set([messageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of roots) {
      const sourceMessageId = "sourceMessageId" in message.origin ? message.origin.sourceMessageId : undefined;
      if (!related.has(message.id) && (!sourceMessageId || !related.has(sourceMessageId))) continue;
      if (!related.has(message.id)) { related.add(message.id); changed = true; }
      if (sourceMessageId && !related.has(sourceMessageId)) { related.add(sourceMessageId); changed = true; }
    }
  }
  return roots
    .filter((message) => related.has(message.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function newestBranchTipInGraph(
  messages: Map<string, StoredChatMessage>,
  startId: string,
  currentPathIds: Set<string>,
  currentHeadMessageId: string | null
) {
  if (currentPathIds.has(startId)) return currentHeadMessageId || startId;
  let cursor = startId;
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const children = messageChildrenInGraph(messages, cursor);
    if (!children.length) return cursor;
    cursor = children.at(-1)!.id;
  }
  return startId;
}
