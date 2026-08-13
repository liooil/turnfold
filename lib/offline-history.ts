import type {Conversation, ConversationRefState, ConversationSummary, RepositoryFetch, RepositoryRefUpdate, StoredChatMessage, WorkingItem} from "./conversation-types";

// Keep the original database identifiers so existing installations upgrade without losing local history.
const databaseName = "xiteng-chat-offline";
const databaseVersion = 3;
const activeProfileKey = "xiteng-chat-offline-profile";

type CachedProfile<T = unknown> = {
  id: string;
  config: T;
  summaries: ConversationSummary[];
  updatedAt: string;
  lastFetchAt?: string;
};

type CachedConversationRef = Omit<Conversation, "messages"> & {
  cacheKey: string;
  profileId: string;
  messages?: StoredChatMessage[];
};

type CachedMessage = StoredChatMessage & {cacheKey: string; profileId: string};
type CachedWorkingItem = WorkingItem & {cacheKey: string; profileId: string};

type CachedReflog = {
  cacheKey: string;
  profileId: string;
  conversationId: string;
  oldHeadMessageId: string | null;
  newHeadMessageId: string | null;
  reason: "commit" | "create" | "fetch" | "reset" | "rename" | "delete";
  createdAt: string;
};

export type RepositoryOutboxRecord = {
  cacheKey: string;
  profileId: string;
  conversationId: string;
  objectIds: string[];
  expectedHeadMessageId: string | null;
  expectedHeadVersion: number;
  expectedMetadataVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type PendingConversationChange = {
  cacheKey: string;
  profileId: string;
  conversationId: string;
  requestPath?: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
  createdAt: string;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("profiles")) database.createObjectStore("profiles", {keyPath: "id"});
      if (!database.objectStoreNames.contains("conversations")) {
        const conversations = database.createObjectStore("conversations", {keyPath: "cacheKey"});
        conversations.createIndex("profileId", "profileId");
      }
      if (!database.objectStoreNames.contains("pending")) {
        const pending = database.createObjectStore("pending", {keyPath: "cacheKey"});
        pending.createIndex("profileId", "profileId");
      }
      if (!database.objectStoreNames.contains("messages")) {
        const messages = database.createObjectStore("messages", {keyPath: "cacheKey"});
        messages.createIndex("profileId", "profileId");
      }
      if (!database.objectStoreNames.contains("working")) {
        const working = database.createObjectStore("working", {keyPath: "cacheKey"});
        working.createIndex("profileId", "profileId");
        working.createIndex("profileConversation", ["profileId", "conversationId"]);
      }
      if (!database.objectStoreNames.contains("reflog")) {
        const reflog = database.createObjectStore("reflog", {keyPath: "cacheKey"});
        reflog.createIndex("profileConversation", ["profileId", "conversationId"]);
      }
      if (!database.objectStoreNames.contains("repositoryOutbox")) {
        const outbox = database.createObjectStore("repositoryOutbox", {keyPath: "cacheKey"});
        outbox.createIndex("profileId", "profileId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open offline history"));
  });
}

async function transaction<T>(storeName: string, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const current = database.transaction(storeName, mode);
    const request = run(current.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`Offline ${storeName} operation failed`));
    current.oncomplete = () => database.close();
    current.onerror = () => reject(current.error || new Error(`Offline ${storeName} transaction failed`));
  });
}

function activeProfileId() {
  return window.localStorage.getItem(activeProfileKey) || "";
}

function profileCacheKey(profileId: string, id: string) {
  return `${profileId}:${id}`;
}

function normalizedCachedMessage(message: Partial<StoredChatMessage>, parentMessageId: string | null, timestamp: string): StoredChatMessage {
  const role = message.role || "user";
  return {
    id: message.id || crypto.randomUUID(),
    parentMessageId: message.parentMessageId === undefined ? parentMessageId : message.parentMessageId,
    role,
    parts: Array.isArray(message.parts) ? message.parts : [],
    origin: message.origin || (role === "user" ? {type: "user"} : role === "system" ? {type: "system", source: "legacy-cache"} : {type: "legacy"}),
    completion: message.completion || {status: "complete"},
    createdAt: message.createdAt || timestamp,
    completedAt: message.completedAt || timestamp,
    ...(message.metadata ? {metadata: message.metadata} : {})
  };
}

function normalizedConversationSummary(summary: Partial<ConversationSummary> & {title?: unknown}): ConversationSummary | null {
  if (typeof summary.id !== "string" || !summary.id) return null;
  const timestamp = new Date().toISOString();
  return {
    id: summary.id,
    name: typeof summary.name === "string" ? summary.name : typeof summary.title === "string" ? summary.title : "",
    headMessageId: typeof summary.headMessageId === "string" ? summary.headMessageId : null,
    providerId: typeof summary.providerId === "string" ? summary.providerId : "",
    model: typeof summary.model === "string" ? summary.model : "",
    messageCount: typeof summary.messageCount === "number" && Number.isFinite(summary.messageCount) ? summary.messageCount : 0,
    createdAt: typeof summary.createdAt === "string" ? summary.createdAt : timestamp,
    updatedAt: typeof summary.updatedAt === "string" ? summary.updatedAt : typeof summary.createdAt === "string" ? summary.createdAt : timestamp,
    ...(summary.upstreamHeadMessageId === null || typeof summary.upstreamHeadMessageId === "string" ? {upstreamHeadMessageId: summary.upstreamHeadMessageId} : {}),
    ...(typeof summary.headVersion === "number" ? {headVersion: summary.headVersion} : {}),
    ...(typeof summary.metadataVersion === "number" ? {metadataVersion: summary.metadataVersion} : {})
  };
}

export function activateOfflineProfile(profileId: string) {
  window.localStorage.setItem(activeProfileKey, profileId);
}

export function activeOfflineProfileId() {
  return activeProfileId();
}

export async function mergeOfflineProfiles(sourceProfileId: string, targetProfileId: string) {
  if (!sourceProfileId || sourceProfileId === targetProfileId) return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const storeNames = ["profiles", "conversations", "pending", "messages", "working", "reflog", "repositoryOutbox"];
    const current = database.transaction(storeNames, "readwrite");
    const profiles = current.objectStore("profiles");
    const sourceProfileRequest = profiles.get(sourceProfileId);
    const targetProfileRequest = profiles.get(targetProfileId);
    let sourceProfile: CachedProfile | undefined;
    let targetProfile: CachedProfile | undefined;
    const profileReady = () => {
      if (sourceProfileRequest.readyState !== "done" || targetProfileRequest.readyState !== "done") return;
      sourceProfile = sourceProfileRequest.result as CachedProfile | undefined;
      targetProfile = targetProfileRequest.result as CachedProfile | undefined;
      if (!sourceProfile) return;
      const summaries = new Map<string, ConversationSummary>();
      for (const summary of [...(sourceProfile.summaries || []), ...(targetProfile?.summaries || [])]) {
        const existing = summaries.get(summary.id);
        if (!existing || summary.updatedAt > existing.updatedAt) summaries.set(summary.id, summary);
      }
      profiles.put({
        ...(sourceProfile || {}),
        ...(targetProfile || {}),
        id: targetProfileId,
        summaries: [...summaries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        updatedAt: new Date().toISOString(),
        lastFetchAt: targetProfile?.lastFetchAt || sourceProfile.lastFetchAt
      } satisfies CachedProfile);
    };
    sourceProfileRequest.onsuccess = profileReady;
    targetProfileRequest.onsuccess = profileReady;

    for (const storeName of storeNames.slice(1)) {
      const store = current.objectStore(storeName);
      const indexName = storeName === "reflog" ? "profileConversation" : "profileId";
      const range = storeName === "reflog"
        ? IDBKeyRange.bound([sourceProfileId, ""], [sourceProfileId, "\uffff"])
        : IDBKeyRange.only(sourceProfileId);
      const request = store.index(indexName).getAll(range);
      request.onsuccess = () => {
        for (const raw of request.result as Array<Record<string, unknown>>) {
          const oldKey = String(raw.cacheKey || "");
          const suffix = oldKey.startsWith(`${sourceProfileId}:`) ? oldKey.slice(sourceProfileId.length) : `:${crypto.randomUUID()}`;
          const migrated = {...raw, profileId: targetProfileId, cacheKey: `${targetProfileId}${suffix}`};
          const existingRequest = store.get(migrated.cacheKey as IDBValidKey);
          existingRequest.onsuccess = () => {
            const existing = existingRequest.result as Record<string, unknown> | undefined;
            if (!existing || String(raw.updatedAt || raw.createdAt || "") > String(existing.updatedAt || existing.createdAt || "")) store.put(migrated);
          };
        }
      };
    }
    current.oncomplete = () => { database.close(); resolve(); };
    current.onerror = () => { database.close(); reject(current.error || new Error("Unable to merge local repositories")); };
    current.onabort = () => { database.close(); reject(current.error || new Error("Local repository merge was aborted")); };
  });
}

export async function cacheChatConfig<T>(profileId: string, config: T) {
  activateOfflineProfile(profileId);
  const current = await transaction<CachedProfile<T> | undefined>("profiles", "readonly", (store) => store.get(profileId));
  const profile: CachedProfile<T> = {
    id: profileId,
    config,
    summaries: current?.summaries || [],
    updatedAt: new Date().toISOString(),
    lastFetchAt: current?.lastFetchAt
  };
  await transaction<IDBValidKey>("profiles", "readwrite", (store) => store.put(profile));
}

export async function loadCachedChatConfig<T>(requestedProfileId?: string) {
  const profileId = requestedProfileId || activeProfileId();
  if (!profileId) return null;
  const profile = await transaction<CachedProfile<T> | undefined>("profiles", "readonly", (store) => store.get(profileId));
  return profile ? {profileId, config: profile.config, updatedAt: profile.updatedAt, lastFetchAt: profile.lastFetchAt || ""} : null;
}

export async function cachedLastFetchAt() {
  const profileId = activeProfileId();
  if (!profileId) return "";
  const profile = await transaction<CachedProfile | undefined>("profiles", "readonly", (store) => store.get(profileId));
  return profile?.lastFetchAt || "";
}

export async function recordRepositoryFetch(timestamp: string) {
  const profileId = activeProfileId();
  if (!profileId) return;
  const profile = await transaction<CachedProfile | undefined>("profiles", "readonly", (store) => store.get(profileId));
  if (!profile) return;
  await transaction<IDBValidKey>("profiles", "readwrite", (store) => store.put({...profile, lastFetchAt: timestamp}));
}

export async function cacheConversationSummaries(summaries: ConversationSummary[]) {
  const profileId = activeProfileId();
  if (!profileId) return;
  const current = await transaction<CachedProfile | undefined>("profiles", "readonly", (store) => store.get(profileId));
  if (!current) return;
  const normalized = summaries.map((summary) => normalizedConversationSummary(summary)).filter((summary): summary is ConversationSummary => Boolean(summary));
  await transaction<IDBValidKey>("profiles", "readwrite", (store) => store.put({...current, summaries: normalized, updatedAt: new Date().toISOString()}));
}

export async function loadCachedConversationSummaries() {
  const profileId = activeProfileId();
  if (!profileId) return [];
  const profile = await transaction<CachedProfile | undefined>("profiles", "readonly", (store) => store.get(profileId));
  return (profile?.summaries || []).map((summary) => normalizedConversationSummary(summary)).filter((summary): summary is ConversationSummary => Boolean(summary));
}

export async function cacheConversation(conversation: Conversation) {
  const profileId = activeProfileId();
  if (!profileId) return;
  let parentMessageId: string | null = null;
  for (const candidate of conversation.messages) {
    const message = normalizedCachedMessage(candidate, parentMessageId, conversation.updatedAt);
    const record: CachedMessage = {...message, cacheKey: profileCacheKey(profileId, message.id), profileId};
    await transaction<IDBValidKey>("messages", "readwrite", (store) => store.put(record));
    parentMessageId = message.id;
  }
  const {messages: _messages, ...summary} = conversation;
  const ref: CachedConversationRef = {
    ...summary,
    upstreamHeadMessageId: conversation.upstreamHeadMessageId === undefined ? conversation.headMessageId : conversation.upstreamHeadMessageId,
    headVersion: conversation.headVersion || 0,
    metadataVersion: conversation.metadataVersion || 0,
    cacheKey: profileCacheKey(profileId, conversation.id),
    profileId
  };
  await transaction<IDBValidKey>("conversations", "readwrite", (store) => store.put(ref));
  await cacheConversationSummaries([
    summary,
    ...(await loadCachedConversationSummaries()).filter((item) => item.id !== conversation.id)
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
}

async function loadCachedMessage(profileId: string, id: string) {
  const record = await transaction<CachedMessage | undefined>("messages", "readonly", (store) => store.get(profileCacheKey(profileId, id)));
  if (!record) return null;
  const {cacheKey: _cacheKey, profileId: _profileId, ...message} = record;
  return message;
}

export async function loadCachedConversation(id: string) {
  const profileId = activeProfileId();
  if (!profileId) return null;
  const record = await transaction<CachedConversationRef | undefined>("conversations", "readonly", (store) => store.get(profileCacheKey(profileId, id)));
  if (!record) return null;
  const {cacheKey: _cacheKey, profileId: _profileId, messages: legacyMessages, ...conversation} = record;
  const normalizedSummary = normalizedConversationSummary(conversation as Partial<ConversationSummary> & {title?: unknown});
  if (!normalizedSummary) return null;
  if (legacyMessages) {
    const normalized: Conversation = {
      ...conversation,
      ...normalizedSummary,
      headMessageId: normalizedSummary.headMessageId || legacyMessages.at(-1)?.id || null,
      messages: legacyMessages.map((message, index) => normalizedCachedMessage(message, index ? legacyMessages[index - 1].id : null, conversation.updatedAt))
    };
    await cacheConversation(normalized);
    return normalized;
  }
  const reversed: StoredChatMessage[] = [];
  const seen = new Set<string>();
  let messageId = conversation.headMessageId;
  while (messageId) {
    if (seen.has(messageId) || reversed.length >= 500) return null;
    seen.add(messageId);
    const message = await loadCachedMessage(profileId, messageId);
    if (!message) return null;
    reversed.push(message);
    messageId = message.parentMessageId;
  }
  return {...conversation, ...normalizedSummary, messages: reversed.reverse()};
}

export async function removeCachedConversation(id: string) {
  const profileId = activeProfileId();
  if (!profileId) return;
  await transaction<undefined>("conversations", "readwrite", (store) => store.delete(profileCacheKey(profileId, id)));
  await transaction<undefined>("repositoryOutbox", "readwrite", (store) => store.delete(repositoryOutboxKey(profileId, id)));
  await cacheConversationSummaries((await loadCachedConversationSummaries()).filter((conversation) => conversation.id !== id));
}

export async function deleteLocalConversation(id: string) {
  const profileId = activeProfileId();
  if (!profileId) return;
  const conversation = await loadCachedConversation(id);
  await transaction<undefined>("conversations", "readwrite", (store) => store.delete(profileCacheKey(profileId, id)));
  await cacheConversationSummaries((await loadCachedConversationSummaries()).filter((item) => item.id !== id));
  if (conversation?.upstreamHeadMessageId !== undefined && ((conversation.headVersion || 0) > 0 || (conversation.metadataVersion || 0) > 0)) {
    await queueConversationChange({conversationId: id, method: "DELETE"});
  }
  await transaction<undefined>("repositoryOutbox", "readwrite", (store) => store.delete(repositoryOutboxKey(profileId, id)));
}

export async function saveWorkingItem(item: WorkingItem) {
  const profileId = activeProfileId();
  if (!profileId) return item;
  const record: CachedWorkingItem = {...item, cacheKey: profileCacheKey(profileId, item.id), profileId};
  await transaction<IDBValidKey>("working", "readwrite", (store) => store.put(record));
  return item;
}

export async function listWorkingItems(conversationId?: string) {
  const profileId = activeProfileId();
  if (!profileId) return [];
  const database = await openDatabase();
  return new Promise<WorkingItem[]>((resolve, reject) => {
    const current = database.transaction("working", "readonly");
    const store = current.objectStore("working");
    const request = conversationId
      ? store.index("profileConversation").getAll([profileId, conversationId])
      : store.index("profileId").getAll(profileId);
    request.onsuccess = () => resolve((request.result as CachedWorkingItem[])
      .map(({cacheKey: _cacheKey, profileId: _profileId, ...item}) => item)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    request.onerror = () => reject(request.error || new Error("Unable to read working items"));
    current.oncomplete = () => database.close();
  });
}

export async function removeWorkingItem(id: string) {
  const profileId = activeProfileId();
  if (!profileId) return;
  await transaction<undefined>("working", "readwrite", (store) => store.delete(profileCacheKey(profileId, id)));
}

export async function listCachedObjectIds() {
  const profileId = activeProfileId();
  if (!profileId) return [];
  const database = await openDatabase();
  return new Promise<string[]>((resolve, reject) => {
    const current = database.transaction("messages", "readonly");
    const request = current.objectStore("messages").index("profileId").getAllKeys(IDBKeyRange.only(profileId));
    request.onsuccess = () => resolve(request.result.map((key) => String(key).slice(profileId.length + 1)));
    request.onerror = () => reject(request.error || new Error("Unable to list local objects"));
    current.oncomplete = () => database.close();
  });
}

export async function listCachedMessages() {
  const profileId = activeProfileId();
  if (!profileId) return [];
  const database = await openDatabase();
  return new Promise<StoredChatMessage[]>((resolve, reject) => {
    const current = database.transaction("messages", "readonly");
    const request = current.objectStore("messages").index("profileId").getAll(profileId);
    request.onsuccess = () => resolve((request.result as CachedMessage[]).map(({cacheKey: _cacheKey, profileId: _profileId, ...message}) => message));
    request.onerror = () => reject(request.error || new Error("Unable to list local message objects"));
    current.oncomplete = () => database.close();
  });
}

function repositoryOutboxKey(profileId: string, conversationId: string) {
  return `${profileId}:${conversationId}:repository`;
}

export async function commitLocalMessage(conversationId: string, message: StoredChatMessage) {
  const profileId = activeProfileId();
  if (!profileId) throw new Error("Local repository profile is unavailable");
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const current = database.transaction(["conversations", "messages", "reflog", "repositoryOutbox"], "readwrite");
    const refs = current.objectStore("conversations");
    const objects = current.objectStore("messages");
    const reflog = current.objectStore("reflog");
    const outbox = current.objectStore("repositoryOutbox");
    const refKey = profileCacheKey(profileId, conversationId);
    const outboxKey = repositoryOutboxKey(profileId, conversationId);
    const refRequest = refs.get(refKey);
    refRequest.onsuccess = () => {
      const ref = refRequest.result as CachedConversationRef | undefined;
      if (!ref) {
        current.abort();
        reject(new Error("Local conversation ref is unavailable"));
        return;
      }
      if (ref.headMessageId !== message.parentMessageId) {
        current.abort();
        reject(new Error("Local conversation head changed"));
        return;
      }
      const existingOutboxRequest = outbox.get(outboxKey);
      existingOutboxRequest.onsuccess = () => {
        const timestamp = new Date().toISOString();
        const existing = existingOutboxRequest.result as RepositoryOutboxRecord | undefined;
        const object: CachedMessage = {...message, cacheKey: profileCacheKey(profileId, message.id), profileId};
        objects.put(object);
        refs.put({...ref, headMessageId: message.id, messageCount: ref.messageCount + 1, updatedAt: timestamp});
        const log: CachedReflog = {
          cacheKey: `${profileId}:${conversationId}:${timestamp}:${crypto.randomUUID()}`,
          profileId,
          conversationId,
          oldHeadMessageId: ref.headMessageId,
          newHeadMessageId: message.id,
          reason: "commit",
          createdAt: timestamp
        };
        reflog.put(log);
        outbox.put({
          cacheKey: outboxKey,
          profileId,
          conversationId,
          objectIds: [...new Set([...(existing?.objectIds || []), message.id])],
          expectedHeadMessageId: existing?.expectedHeadMessageId ?? ref.upstreamHeadMessageId ?? null,
          expectedHeadVersion: existing?.expectedHeadVersion ?? ref.headVersion ?? 0,
          expectedMetadataVersion: existing?.expectedMetadataVersion ?? ref.metadataVersion ?? 0,
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp
        } satisfies RepositoryOutboxRecord);
      };
    };
    current.oncomplete = () => { database.close(); resolve(); };
    current.onerror = () => { database.close(); reject(current.error || new Error("Local commit failed")); };
    current.onabort = () => database.close();
  });
  const conversation = await loadCachedConversation(conversationId);
  if (!conversation) throw new Error("Local commit could not be loaded");
  await cacheConversationSummariesFromConversation(conversation);
  return conversation;
}

export async function moveLocalConversationHead(conversationId: string, headMessageId: string | null) {
  const profileId = activeProfileId();
  if (!profileId) throw new Error("Local repository profile is unavailable");
  const conversation = await loadCachedConversation(conversationId);
  if (!conversation) throw new Error("Local conversation ref is unavailable");
  const targetPath = await messagePathFromCache(profileId, headMessageId);
  if (headMessageId !== null && targetPath.at(-1)?.id !== headMessageId) throw new Error("Target message is unavailable in the local graph");
  if (conversation.headMessageId === headMessageId) return conversation;

  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const current = database.transaction(["conversations", "reflog", "repositoryOutbox"], "readwrite");
    const refs = current.objectStore("conversations");
    const reflog = current.objectStore("reflog");
    const outbox = current.objectStore("repositoryOutbox");
    const refKey = profileCacheKey(profileId, conversationId);
    const outboxKey = repositoryOutboxKey(profileId, conversationId);
    const refRequest = refs.get(refKey);
    refRequest.onsuccess = () => {
      const ref = refRequest.result as CachedConversationRef | undefined;
      if (!ref || ref.headMessageId !== conversation.headMessageId) {
        current.abort();
        reject(new Error("Local conversation head changed"));
        return;
      }
      const outboxRequest = outbox.get(outboxKey);
      outboxRequest.onsuccess = () => {
        const timestamp = new Date().toISOString();
        const existing = outboxRequest.result as RepositoryOutboxRecord | undefined;
        refs.put({...ref, headMessageId, messageCount: targetPath.length, updatedAt: timestamp});
        reflog.put({
          cacheKey: `${profileId}:${conversationId}:${timestamp}:${crypto.randomUUID()}`,
          profileId,
          conversationId,
          oldHeadMessageId: ref.headMessageId,
          newHeadMessageId: headMessageId,
          reason: "reset",
          createdAt: timestamp
        } satisfies CachedReflog);
        outbox.put({
          cacheKey: outboxKey,
          profileId,
          conversationId,
          objectIds: existing?.objectIds || [],
          expectedHeadMessageId: existing?.expectedHeadMessageId ?? ref.upstreamHeadMessageId ?? null,
          expectedHeadVersion: existing?.expectedHeadVersion ?? ref.headVersion ?? 0,
          expectedMetadataVersion: existing?.expectedMetadataVersion ?? ref.metadataVersion ?? 0,
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp
        } satisfies RepositoryOutboxRecord);
      };
    };
    current.oncomplete = () => { database.close(); resolve(); };
    current.onerror = () => { database.close(); reject(current.error || new Error("Unable to move local conversation head")); };
    current.onabort = () => database.close();
  });
  const updated = await loadCachedConversation(conversationId);
  if (!updated) throw new Error("Moved conversation could not be loaded");
  await cacheConversationSummariesFromConversation(updated);
  return updated;
}

async function cacheConversationSummariesFromConversation(conversation: Conversation) {
  const summary: ConversationSummary = {
    id: conversation.id,
    name: conversation.name,
    headMessageId: conversation.headMessageId,
    providerId: conversation.providerId,
    model: conversation.model,
    messageCount: conversation.messageCount,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    upstreamHeadMessageId: conversation.upstreamHeadMessageId,
    headVersion: conversation.headVersion,
    metadataVersion: conversation.metadataVersion
  };
  await cacheConversationSummaries([summary, ...(await loadCachedConversationSummaries()).filter((item) => item.id !== conversation.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
}

export async function createLocalConversation(conversation: Conversation) {
  const profileId = activeProfileId();
  if (!profileId) throw new Error("Local repository profile is unavailable");
  const timestamp = new Date().toISOString();
  const local: Conversation = {...conversation, upstreamHeadMessageId: null, headVersion: 0, metadataVersion: 0};
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const current = database.transaction(["conversations", "messages", "reflog", "repositoryOutbox"], "readwrite");
    const refs = current.objectStore("conversations");
    const objects = current.objectStore("messages");
    const reflog = current.objectStore("reflog");
    const outbox = current.objectStore("repositoryOutbox");
    for (const message of local.messages) objects.put({...message, cacheKey: profileCacheKey(profileId, message.id), profileId} satisfies CachedMessage);
    const {messages: _messages, ...summary} = local;
    refs.put({...summary, cacheKey: profileCacheKey(profileId, local.id), profileId} satisfies CachedConversationRef);
    reflog.put({
      cacheKey: `${profileId}:${local.id}:${timestamp}:${crypto.randomUUID()}`,
      profileId,
      conversationId: local.id,
      oldHeadMessageId: null,
      newHeadMessageId: local.headMessageId,
      reason: "create",
      createdAt: timestamp
    } satisfies CachedReflog);
    outbox.put({
      cacheKey: repositoryOutboxKey(profileId, local.id),
      profileId,
      conversationId: local.id,
      objectIds: local.messages.filter((message) => message.id.startsWith("sha256:")).map((message) => message.id),
      expectedHeadMessageId: null,
      expectedHeadVersion: 0,
      expectedMetadataVersion: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    } satisfies RepositoryOutboxRecord);
    current.oncomplete = () => { database.close(); resolve(); };
    current.onerror = () => { database.close(); reject(current.error || new Error("Unable to create local ref")); };
  });
  await cacheConversationSummariesFromConversation(local);
  return local;
}

export async function queueLocalRefUpdate(conversation: Conversation) {
  const profileId = activeProfileId();
  if (!profileId) throw new Error("Local repository profile is unavailable");
  await cacheConversation(conversation);
  const key = repositoryOutboxKey(profileId, conversation.id);
  const existing = await transaction<RepositoryOutboxRecord | undefined>("repositoryOutbox", "readonly", (store) => store.get(key));
  const timestamp = new Date().toISOString();
  const record: RepositoryOutboxRecord = {
    cacheKey: key,
    profileId,
    conversationId: conversation.id,
    objectIds: existing?.objectIds || [],
    expectedHeadMessageId: existing?.expectedHeadMessageId ?? conversation.upstreamHeadMessageId ?? null,
    expectedHeadVersion: existing?.expectedHeadVersion ?? conversation.headVersion ?? 0,
    expectedMetadataVersion: existing?.expectedMetadataVersion ?? conversation.metadataVersion ?? 0,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp
  };
  await transaction<IDBValidKey>("repositoryOutbox", "readwrite", (store) => store.put(record));
  return conversation;
}

export async function repositoryPushPayload() {
  const profileId = activeProfileId();
  if (!profileId) return {repositoryId: "", objects: [] as StoredChatMessage[], refs: [] as RepositoryRefUpdate[]};
  const database = await openDatabase();
  const outbox = await new Promise<RepositoryOutboxRecord[]>((resolve, reject) => {
    const current = database.transaction("repositoryOutbox", "readonly");
    const request = current.objectStore("repositoryOutbox").index("profileId").getAll(profileId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    current.oncomplete = () => database.close();
  });
  const objects: StoredChatMessage[] = [];
  const refs: RepositoryRefUpdate[] = [];
  for (const pending of outbox) {
    const conversation = await loadCachedConversation(pending.conversationId);
    if (!conversation) continue;
    for (const id of pending.objectIds) {
      const object = await loadCachedMessage(profileId, id);
      if (object) objects.push(object);
    }
    refs.push({
      conversationId: conversation.id,
      expectedHeadMessageId: pending.expectedHeadMessageId,
      expectedHeadVersion: pending.expectedHeadVersion,
      expectedMetadataVersion: pending.expectedMetadataVersion,
      headMessageId: conversation.headMessageId,
      name: conversation.name,
      providerId: conversation.providerId,
      model: conversation.model,
      generationSettings: conversation.generationSettings,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
  }
  return {repositoryId: profileId, objects, refs};
}

export async function applyRepositoryFetch(repository: RepositoryFetch) {
  const profileId = activeProfileId();
  if (!profileId) return;
  for (const object of repository.objects) {
    await transaction<IDBValidKey>("messages", "readwrite", (store) => store.put({...object, cacheKey: profileCacheKey(profileId, object.id), profileId}));
  }
  for (const remote of repository.refs) {
    const local = await loadCachedConversation(remote.id);
    const pending = await transaction<RepositoryOutboxRecord | undefined>("repositoryOutbox", "readonly", (store) => store.get(repositoryOutboxKey(profileId, remote.id)));
    const canFastForward = !local || (!pending && local.headMessageId === (local.upstreamHeadMessageId ?? local.headMessageId));
    const headMessageId = canFastForward ? remote.headMessageId : local!.headMessageId;
    const messages = await messagePathFromCache(profileId, headMessageId);
    const conversation: Conversation = {
      id: remote.id,
      name: pending && local ? local.name : remote.name,
      headMessageId,
      upstreamHeadMessageId: remote.headMessageId,
      providerId: pending && local ? local.providerId : remote.providerId,
      model: pending && local ? local.model : remote.model,
      generationSettings: pending && local ? local.generationSettings : remote.generationSettings,
      headVersion: remote.headVersion,
      metadataVersion: remote.metadataVersion,
      messageCount: messages.length,
      createdAt: remote.createdAt,
      updatedAt: pending && local ? local.updatedAt : remote.updatedAt,
      messages
    };
    await cacheConversation(conversation);
  }
  const remoteIds = new Set(repository.refs.map((ref) => ref.id));
  for (const local of await loadCachedConversationSummaries()) {
    if (remoteIds.has(local.id)) continue;
    const pending = await transaction<RepositoryOutboxRecord | undefined>("repositoryOutbox", "readonly", (store) => store.get(repositoryOutboxKey(profileId, local.id)));
    if (!pending && ((local.headVersion || 0) > 0 || (local.metadataVersion || 0) > 0)) await removeCachedConversation(local.id);
  }
  await recordRepositoryFetch(repository.fetchedAt);
}

async function messagePathFromCache(profileId: string, headMessageId: string | null) {
  const reversed: StoredChatMessage[] = [];
  const seen = new Set<string>();
  let id = headMessageId;
  while (id) {
    if (seen.has(id) || reversed.length >= 500) throw new Error("Local object history is cyclic or too long");
    seen.add(id);
    const object = await loadCachedMessage(profileId, id);
    if (!object) throw new Error(`Local object ${id} is unavailable`);
    reversed.push(object);
    id = object.parentMessageId;
  }
  return reversed.reverse();
}

export async function applyRepositoryPushResults(results: Array<{conversationId: string; status: "ok" | "conflict"; ref: ConversationRefState | null}>) {
  const profileId = activeProfileId();
  if (!profileId) return;
  for (const result of results) {
    const local = await loadCachedConversation(result.conversationId);
    if (!local || !result.ref) continue;
    if (result.status === "ok") {
      await cacheConversation({...local, upstreamHeadMessageId: result.ref.headMessageId, headVersion: result.ref.headVersion, metadataVersion: result.ref.metadataVersion});
      const key = repositoryOutboxKey(profileId, result.conversationId);
      if (local.headMessageId === result.ref.headMessageId) {
        await transaction<undefined>("repositoryOutbox", "readwrite", (store) => store.delete(key));
      } else {
        const pending = await transaction<RepositoryOutboxRecord | undefined>("repositoryOutbox", "readonly", (store) => store.get(key));
        if (pending) await transaction<IDBValidKey>("repositoryOutbox", "readwrite", (store) => store.put({
          ...pending,
          expectedHeadMessageId: result.ref!.headMessageId,
          expectedHeadVersion: result.ref!.headVersion,
          expectedMetadataVersion: result.ref!.metadataVersion
        }));
      }
    } else {
      await cacheConversation({...local, upstreamHeadMessageId: result.ref.headMessageId, headVersion: result.ref.headVersion, metadataVersion: result.ref.metadataVersion});
    }
  }
}

export async function queueConversationChange(change: Omit<PendingConversationChange, "cacheKey" | "profileId" | "createdAt">) {
  const profileId = activeProfileId();
  if (!profileId) return;
  const record: PendingConversationChange = {
    ...change,
    cacheKey: `${profileId}:${change.conversationId}:${change.method}:${change.requestPath || "conversation"}`,
    profileId,
    createdAt: new Date().toISOString()
  };
  await transaction<IDBValidKey>("pending", "readwrite", (store) => store.put(record));
}

export async function listPendingConversationChanges() {
  const profileId = activeProfileId();
  if (!profileId) return [];
  const database = await openDatabase();
  return new Promise<PendingConversationChange[]>((resolve, reject) => {
    const current = database.transaction("pending", "readonly");
    const request = current.objectStore("pending").index("profileId").getAll(profileId);
    request.onsuccess = () => resolve(request.result.sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
    request.onerror = () => reject(request.error || new Error("Unable to read pending history changes"));
    current.oncomplete = () => database.close();
  });
}

export async function removePendingConversationChange(cacheKey: string) {
  await transaction<undefined>("pending", "readwrite", (store) => store.delete(cacheKey));
}
