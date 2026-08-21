import {validMessageObjectId} from "../../shared/message-object";
import type {ConversationRefState, StoredChatMessage} from "../../shared/conversation-types";
import type {
  RepositoryInventory,
  RepositoryPull,
  RepositoryPush,
  RepositoryPushRefResult,
  RepositoryPushResult,
  WorkingSnapshot
} from "../../shared/repository-types";
import {normalizeBackendUrl} from "../backend-connection";
import type {RepositoryPeer} from "./repository-peer";

const descriptorName = ".turnfold-repository.json";
const objectEnvelopeType = "turnfold-message-object";
const refEnvelopeType = "turnfold-conversation-ref";
const workingEnvelopeType = "turnfold-working-snapshot";

type WebDavFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type WebDavHrefParser = (source: string) => string[];

const browserWebDavFetch: WebDavFetch = (input, init) => globalThis.fetch(input, init);

export type WebDavAuthentication =
  | {type: "none"}
  | {type: "bearer"; token: string}
  | {type: "basic"; username: string; password: string};

type JsonResource<T> = {value: T; etag: string};

type RepositoryDescriptor = {
  type: "turnfold-webdav-repository";
  version: 1;
  id: string;
};

type MessageEnvelope = {
  type: typeof objectEnvelopeType;
  version: 1;
  repositoryId: string;
  object: StoredChatMessage;
};

type RefEnvelope = {
  type: typeof refEnvelopeType;
  version: 1;
  ref: ConversationRefState;
};

type WorkingEnvelope = {
  type: typeof workingEnvelopeType;
  version: 1;
  snapshot: WorkingSnapshot;
};

export class WebDavHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WebDavHttpError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function browserWebDavHrefs(source: string) {
  if (source.length > 16 * 1024 * 1024) throw new Error("WebDAV multistatus response is too large");
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("WebDAV server returned invalid XML");
  return [...document.getElementsByTagNameNS("DAV:", "href")].map((node) => node.textContent || "").filter(Boolean);
}

function utf8Base64Url(value: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function basicAuthorization(username: string, password: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(`${username}:${password}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function authenticationHeader(authentication: WebDavAuthentication) {
  if (authentication.type === "bearer") return authentication.token.trim() ? `Bearer ${authentication.token.trim()}` : "";
  if (authentication.type === "basic") return basicAuthorization(authentication.username, authentication.password);
  return "";
}

export function normalizeWebDavUrl(value: string, baseUrl?: string) {
  return `${normalizeBackendUrl(value, baseUrl)}/`;
}

function conversationRef(value: unknown): ConversationRefState {
  if (!record(value)) throw new Error("WebDAV ref is invalid");
  const id = typeof value.id === "string" ? value.id : "";
  const headMessageId = value.headMessageId === null || typeof value.headMessageId === "string" ? value.headMessageId : undefined;
  if (!id || id.length > 160 || headMessageId === undefined || (typeof headMessageId === "string" && headMessageId.length > 160)
    || typeof value.name !== "string" || value.name.length > 300
    || typeof value.providerId !== "string" || value.providerId.length > 80
    || typeof value.model !== "string" || value.model.length > 300 || !record(value.generationSettings)
    || !Number.isSafeInteger(value.headVersion) || Number(value.headVersion) < 0
    || !Number.isSafeInteger(value.metadataVersion) || Number(value.metadataVersion) < 0
    || typeof value.createdAt !== "string" || value.createdAt.length > 80
    || typeof value.updatedAt !== "string" || value.updatedAt.length > 80) {
    throw new Error("WebDAV ref is invalid");
  }
  return value as ConversationRefState;
}

function messageEnvelope(value: unknown): MessageEnvelope {
  if (!record(value) || value.type !== objectEnvelopeType || value.version !== 1
    || typeof value.repositoryId !== "string" || !/^local:[a-zA-Z0-9-]{8,160}$/.test(value.repositoryId)
    || !record(value.object) || new TextEncoder().encode(JSON.stringify(value.object)).byteLength > 2 * 1024 * 1024) {
    throw new Error("WebDAV message envelope is invalid");
  }
  const object = value.object;
  if (typeof object.id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(object.id)
    || !(object.parentMessageId === null || typeof object.parentMessageId === "string")
    || !["system", "user", "assistant"].includes(String(object.role))
    || !Array.isArray(object.parts) || !record(object.origin) || !record(object.completion)
    || typeof object.createdAt !== "string" || object.createdAt.length > 80
    || typeof object.completedAt !== "string" || object.completedAt.length > 80) {
    throw new Error("WebDAV message envelope is invalid");
  }
  return value as MessageEnvelope;
}

function refEnvelope(value: unknown): RefEnvelope {
  if (!record(value) || value.type !== refEnvelopeType || value.version !== 1) throw new Error("WebDAV ref envelope is invalid");
  return {type: refEnvelopeType, version: 1, ref: conversationRef(value.ref)};
}

function descriptor(value: unknown): RepositoryDescriptor {
  if (!record(value) || value.type !== "turnfold-webdav-repository" || value.version !== 1
    || typeof value.id !== "string" || !/^[a-zA-Z0-9._:-]{1,180}$/.test(value.id)) {
    throw new Error("WebDAV root is not a Turnfold repository");
  }
  return value as RepositoryDescriptor;
}

function metadataChanged(current: ConversationRefState, update: RepositoryPush["refs"][number]) {
  return current.name !== update.name
    || current.providerId !== update.providerId
    || current.model !== update.model
    || JSON.stringify(current.generationSettings) !== JSON.stringify(update.generationSettings);
}

function orderedObjects(objects: StoredChatMessage[], haveObjectIds: Set<string>) {
  const pending = new Map(objects.map((object) => [object.id, object]));
  const ordered: StoredChatMessage[] = [];
  while (pending.size) {
    let progressed = false;
    for (const [id, object] of pending) {
      if (object.parentMessageId && pending.has(object.parentMessageId)) continue;
      if (object.parentMessageId && !haveObjectIds.has(object.parentMessageId) && !ordered.some((candidate) => candidate.id === object.parentMessageId)) {
        throw new Error(`WebDAV object ${id} references a missing parent`);
      }
      ordered.push(object);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) throw new Error("WebDAV object graph is cyclic");
  }
  return ordered;
}

export class WebDavRepositoryPeer implements RepositoryPeer {
  private readonly rootUrl: string;
  private readonly authorization: string;
  private descriptor?: RepositoryDescriptor;

  constructor(
    rootUrl: string,
    authentication: WebDavAuthentication = {type: "none"},
    private readonly signal?: AbortSignal,
    private readonly webDavFetch: WebDavFetch = browserWebDavFetch,
    private readonly parseHrefs: WebDavHrefParser = browserWebDavHrefs
  ) {
    this.rootUrl = normalizeWebDavUrl(rootUrl);
    this.authorization = authenticationHeader(authentication);
  }

  async identity() {
    const current = await this.ensureRepository();
    return {id: `webdav:${current.id}`, kind: "server" as const, label: this.rootUrl};
  }

  async pull(inventory: RepositoryInventory): Promise<RepositoryPull> {
    await this.ensureRepository();
    const have = new Set(inventory.haveObjectIds);
    const objectHrefs = await this.collectionMembers("objects/");
    const objects: StoredChatMessage[] = [];
    const objectRepositoryIds: Record<string, string> = {};
    for (const href of objectHrefs) {
      const filename = this.directFilename(href, "objects/");
      const match = filename.match(/^([a-f0-9]{64})\.json$/);
      if (!match) continue;
      const id = `sha256:${match[1]}`;
      if (have.has(id)) continue;
      const {value} = await this.readJson<unknown>(href);
      const envelope = messageEnvelope(value);
      if (envelope.object.id !== id || !await validMessageObjectId(envelope.object, envelope.repositoryId)) {
        throw new Error(`WebDAV object ${id} failed content verification`);
      }
      objects.push(envelope.object);
      objectRepositoryIds[id] = envelope.repositoryId;
    }

    const refs: ConversationRefState[] = [];
    for (const href of await this.collectionMembers("refs/")) {
      const filename = this.directFilename(href, "refs/");
      if (!filename.endsWith(".json")) continue;
      const ref = refEnvelope((await this.readJson<unknown>(href)).value).ref;
      if (filename !== `${utf8Base64Url(ref.id)}.json`) throw new Error(`WebDAV ref ${ref.id} does not match its path`);
      refs.push(ref);
    }
    return {
      refs,
      objects: orderedObjects(objects, have),
      objectRepositoryIds,
      fetchedAt: new Date().toISOString()
    };
  }

  async push(batch: RepositoryPush): Promise<RepositoryPushResult> {
    await this.ensureRepository();
    for (const object of batch.objects) {
      const repositoryId = batch.objectRepositoryIds?.[object.id] || batch.repositoryId;
      if (!await validMessageObjectId(object, repositoryId)) throw new Error(`Object ${object.id} failed content verification`);
      const digest = object.id.replace(/^sha256:/, "");
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Object ${object.id} has an invalid identifier`);
      const pathname = `objects/${digest}.json`;
      const envelope: MessageEnvelope = {type: objectEnvelopeType, version: 1, repositoryId, object};
      const response = await this.request(pathname, {
        method: "PUT",
        headers: {"Content-Type": "application/json", "If-None-Match": "*"},
        body: JSON.stringify(envelope)
      });
      if (response.status === 412) {
        const existing = messageEnvelope((await this.readJson<unknown>(pathname)).value);
        if (existing.repositoryId !== repositoryId || existing.object.id !== object.id
          || !await validMessageObjectId(existing.object, existing.repositoryId)) {
          throw new Error(`WebDAV immutable object ${object.id} conflicts with existing content`);
        }
      } else if (!response.ok) {
        throw await this.responseError(response, `Unable to write WebDAV object ${object.id}`);
      }
    }

    const refs: RepositoryPushRefResult[] = [];
    for (const update of batch.refs) refs.push(await this.pushRef(update));
    return {refs, pushedAt: new Date().toISOString()};
  }

  async backupWorking(snapshot: WorkingSnapshot) {
    await this.ensureRepository();
    if (!snapshot.deviceId) throw new Error("Working snapshot deviceId is required");
    const pathname = `working/${utf8Base64Url(snapshot.deviceId)}.json`;
    const current = await this.readJson<unknown>(pathname, true);
    if (current && !current.etag) throw new Error("WebDAV server did not provide an ETag for the working snapshot");
    const envelope: WorkingEnvelope = {type: workingEnvelopeType, version: 1, snapshot};
    const response = await this.request(pathname, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(current ? {"If-Match": current.etag} : {"If-None-Match": "*"})
      },
      body: JSON.stringify(envelope)
    });
    if (response.status === 412) throw new Error("WebDAV working snapshot changed concurrently");
    if (!response.ok) throw await this.responseError(response, "Unable to back up working items");
  }

  private async pushRef(update: RepositoryPush["refs"][number]): Promise<RepositoryPushRefResult> {
    const pathname = `refs/${utf8Base64Url(update.conversationId)}.json`;
    const currentResource = await this.readJson<unknown>(pathname, true);
    if (currentResource && !currentResource.etag) throw new Error(`WebDAV server did not provide an ETag for ref ${update.conversationId}`);
    const current = currentResource ? refEnvelope(currentResource.value).ref : null;
    if (!current) {
      if (update.expectedHeadMessageId !== null || update.expectedHeadVersion !== 0 || update.expectedMetadataVersion !== 0) {
        return {conversationId: update.conversationId, status: "conflict", ref: null};
      }
    } else if (current.id !== update.conversationId
      || current.headMessageId !== update.expectedHeadMessageId
      || current.headVersion !== update.expectedHeadVersion
      || current.metadataVersion !== update.expectedMetadataVersion) {
      return {conversationId: update.conversationId, status: "conflict", ref: current};
    }

    const next: ConversationRefState = {
      id: update.conversationId,
      name: update.name,
      headMessageId: update.headMessageId,
      providerId: update.providerId,
      model: update.model,
      generationSettings: update.generationSettings,
      headVersion: current ? current.headVersion + Number(current.headMessageId !== update.headMessageId) : 1,
      metadataVersion: current ? current.metadataVersion + Number(metadataChanged(current, update)) : 1,
      createdAt: current?.createdAt || update.createdAt,
      updatedAt: new Date().toISOString()
    };
    const response = await this.request(pathname, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(currentResource ? {"If-Match": currentResource.etag} : {"If-None-Match": "*"})
      },
      body: JSON.stringify({type: refEnvelopeType, version: 1, ref: next} satisfies RefEnvelope)
    });
    if (response.status === 412) {
      const raced = await this.readJson<unknown>(pathname, true);
      return {conversationId: update.conversationId, status: "conflict", ref: raced ? refEnvelope(raced.value).ref : null};
    }
    if (!response.ok) throw await this.responseError(response, `Unable to write WebDAV ref ${update.conversationId}`);
    return {conversationId: update.conversationId, status: "ok", ref: next};
  }

  private async ensureRepository() {
    if (this.descriptor) return this.descriptor;
    let current = await this.readJson<unknown>(descriptorName, true);
    if (!current) {
      await this.ensureCollection("");
      await this.ensureCollection("objects/");
      await this.ensureCollection("refs/");
      await this.ensureCollection("working/");
      const created: RepositoryDescriptor = {type: "turnfold-webdav-repository", version: 1, id: crypto.randomUUID()};
      const response = await this.request(descriptorName, {
        method: "PUT",
        headers: {"Content-Type": "application/json", "If-None-Match": "*"},
        body: JSON.stringify(created)
      });
      if (!response.ok && response.status !== 412) throw await this.responseError(response, "Unable to initialize WebDAV repository");
      current = response.status === 412 ? await this.readJson<unknown>(descriptorName) : {value: created, etag: response.headers.get("etag") || ""};
    }
    this.descriptor = descriptor(current.value);
    await this.ensureCollection("objects/");
    await this.ensureCollection("refs/");
    await this.ensureCollection("working/");
    return this.descriptor;
  }

  private async ensureCollection(pathname: string) {
    const response = await this.request(pathname, {method: "MKCOL"});
    if (![201, 204, 405].includes(response.status)) throw await this.responseError(response, `Unable to prepare WebDAV collection ${pathname || this.rootUrl}`);
  }

  private async collectionMembers(pathname: string) {
    const response = await this.request(pathname, {method: "PROPFIND", headers: {Depth: "1"}});
    if (response.status !== 207) throw await this.responseError(response, `Unable to list WebDAV collection ${pathname}`);
    return this.parseHrefs(await response.text());
  }

  private directFilename(href: string, collection: string) {
    const collectionUrl = new URL(collection, this.rootUrl);
    const resourceUrl = new URL(href, collectionUrl);
    if (resourceUrl.origin !== collectionUrl.origin || !resourceUrl.pathname.startsWith(collectionUrl.pathname)) return "";
    try {
      const relative = decodeURIComponent(resourceUrl.pathname.slice(collectionUrl.pathname.length));
      return relative && !relative.includes("/") ? relative : "";
    } catch {
      return "";
    }
  }

  private async readJson<T>(pathname: string): Promise<JsonResource<T>>;
  private async readJson<T>(pathname: string, missingAllowed: true): Promise<JsonResource<T> | null>;
  private async readJson<T>(pathname: string, missingAllowed = false): Promise<JsonResource<T> | null> {
    const response = await this.request(pathname, {method: "GET", headers: {Accept: "application/json"}});
    if (missingAllowed && response.status === 404) return null;
    if (!response.ok) throw await this.responseError(response, `Unable to read WebDAV resource ${pathname}`);
    let value: T;
    try {
      value = await response.json() as T;
    } catch {
      throw new Error(`WebDAV resource ${pathname} did not return JSON`);
    }
    return {value, etag: response.headers.get("etag") || ""};
  }

  private request(pathname: string, init: RequestInit) {
    return this.webDavFetch(new URL(pathname, this.rootUrl), {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      headers: {
        ...(this.authorization ? {Authorization: this.authorization} : {}),
        ...init.headers
      },
      signal: this.signal
    });
  }

  private async responseError(response: Response, fallback: string) {
    let detail = "";
    try {
      const payload = await response.clone().json() as unknown;
      if (record(payload) && typeof payload.error === "string") detail = payload.error;
    } catch {}
    return new WebDavHttpError(detail || `${fallback} (HTTP ${response.status})`, response.status);
  }
}
