import type {StoredChatMessage} from "./conversation-types";

export function mergeMessageGraph(...groups: StoredChatMessage[][]) {
  return new Map(groups.flat().map((message) => [message.id, message]));
}

export function messagePathInGraph(messages: Map<string, StoredChatMessage>, headMessageId: string | null) {
  const reversed: StoredChatMessage[] = [];
  const seen = new Set<string>();
  let cursor = headMessageId;
  while (cursor) {
    if (seen.has(cursor)) return [];
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

/**
 * Precomputed lookups over the merged message graph. Building an index is
 * O(N); every lookup below is then O(1) or O(siblings). Rebuild the index only
 * when the message data actually changes.
 */
export type MessageGraphIndex = {
  map: Map<string, StoredChatMessage>;
  childrenByParent: Map<string | null, StoredChatMessage[]>;
  roots: StoredChatMessage[];
  rootEditAlternatives: Map<string, StoredChatMessage[]>;
};

export function compareMessageOrder(left: StoredChatMessage, right: StoredChatMessage) {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function indexMessageGraph(...groups: StoredChatMessage[][]): MessageGraphIndex {
  const map = new Map<string, StoredChatMessage>();
  for (const group of groups) {
    for (const message of group) map.set(message.id, message);
  }
  const childrenByParent = new Map<string | null, StoredChatMessage[]>();
  for (const message of map.values()) {
    let siblings = childrenByParent.get(message.parentMessageId);
    if (!siblings) {
      siblings = [];
      childrenByParent.set(message.parentMessageId, siblings);
    }
    siblings.push(message);
  }
  for (const siblings of childrenByParent.values()) siblings.sort(compareMessageOrder);
  const roots = childrenByParent.get(null) ?? [];
  return {map, childrenByParent, roots, rootEditAlternatives: indexRootEditAlternatives(roots)};
}

/**
 * Families of root messages connected through edit origins (origin.sourceMessageId),
 * mirroring rootEditAlternativesInGraph semantics via union-find over the roots.
 */
function indexRootEditAlternatives(roots: StoredChatMessage[]) {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let cursor = id;
    while (parent.get(cursor) !== cursor) cursor = parent.get(cursor)!;
    let node = id;
    while (parent.get(node) !== cursor) {
      const next = parent.get(node)!;
      parent.set(node, cursor);
      node = next;
    }
    return cursor;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };
  for (const root of roots) parent.set(root.id, root.id);
  for (const root of roots) {
    const sourceMessageId = "sourceMessageId" in root.origin ? root.origin.sourceMessageId : undefined;
    if (sourceMessageId) {
      if (!parent.has(sourceMessageId)) parent.set(sourceMessageId, sourceMessageId);
      union(root.id, sourceMessageId);
    }
  }
  const byComponent = new Map<string, StoredChatMessage[]>();
  for (const root of roots) {
    const component = find(root.id);
    let family = byComponent.get(component);
    if (!family) {
      family = [];
      byComponent.set(component, family);
    }
    family.push(root);
  }
  const alternatives = new Map<string, StoredChatMessage[]>();
  for (const family of byComponent.values()) {
    family.sort(compareMessageOrder);
    for (const root of family) alternatives.set(root.id, family);
  }
  return alternatives;
}

export function messageChildrenInIndex(index: MessageGraphIndex, parentMessageId: string | null) {
  return index.childrenByParent.get(parentMessageId) ?? [];
}

export function rootEditAlternativesInIndex(index: MessageGraphIndex, messageId: string) {
  return index.rootEditAlternatives.get(messageId) ?? [];
}

export function newestBranchTipInIndex(
  index: MessageGraphIndex,
  startId: string,
  currentPathIds: Set<string>,
  currentHeadMessageId: string | null
) {
  if (currentPathIds.has(startId)) return currentHeadMessageId || startId;
  let cursor = startId;
  const seen = new Set<string>();
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const children = index.childrenByParent.get(cursor) ?? [];
    if (!children.length) return cursor;
    cursor = children.at(-1)!.id;
  }
  return startId;
}
