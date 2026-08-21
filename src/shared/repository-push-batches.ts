import type {RepositoryRefUpdate, StoredChatMessage} from "./conversation-types";
import type {RepositoryPush} from "./repository-types";

export type RepositoryPushPayload = RepositoryPush;

export const maximumRepositoryPushBodyBytes = 48 * 1024 * 1024;

const encoder = new TextEncoder();

function encodedBytes(value: unknown) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Repository sync payload cannot be encoded");
  return encoder.encode(encoded).byteLength;
}

function chunks<T>(
  items: T[],
  maximumItems: number,
  maximumBodyBytes: number,
  emptyPayload: RepositoryPush,
  itemKind: string
) {
  const result: T[][] = [];
  const emptyBytes = encodedBytes(emptyPayload);
  let current: T[] = [];
  let currentBytes = emptyBytes;
  for (const item of items) {
    const itemBytes = encodedBytes(item);
    const separatorBytes = current.length ? 1 : 0;
    if (current.length >= maximumItems || currentBytes + separatorBytes + itemBytes > maximumBodyBytes) {
      if (current.length) result.push(current);
      current = [];
      currentBytes = emptyBytes;
    }
    if (currentBytes + itemBytes > maximumBodyBytes) {
      throw new Error(`Repository ${itemKind} exceeds the synchronization request size limit`);
    }
    current.push(item);
    currentBytes += (current.length > 1 ? 1 : 0) + itemBytes;
  }
  if (current.length) result.push(current);
  return result;
}

function objectChunks(payload: RepositoryPushPayload, maximumBodyBytes: number) {
  const emptyPayload = {
    repositoryId: payload.repositoryId,
    objects: [] as StoredChatMessage[],
    refs: [] as RepositoryRefUpdate[]
  };
  const emptyBytes = encodedBytes(emptyPayload);
  const provenancePropertyBytes = encodedBytes({
    repositoryId: payload.repositoryId,
    objects: [],
    objectRepositoryIds: {},
    refs: []
  }) - emptyBytes;
  const result: Array<{objects: StoredChatMessage[]; objectRepositoryIds: Record<string, string>}> = [];
  let objects: StoredChatMessage[] = [];
  let objectRepositoryIds: Record<string, string> = {};
  let bodyBytes = emptyBytes;
  let provenanceEntries = 0;

  for (const object of [...new Map(payload.objects.map((item) => [item.id, item])).values()]) {
    const objectBytes = encodedBytes(object);
    const sourceRepositoryId = payload.objectRepositoryIds?.[object.id];
    const hasProvenance = Boolean(sourceRepositoryId) && sourceRepositoryId !== payload.repositoryId;
    const provenanceBytes = hasProvenance
      ? (provenanceEntries ? 1 : provenancePropertyBytes)
        + encodedBytes({[object.id]: sourceRepositoryId}) - 2
      : 0;
    const candidateBytes = bodyBytes + (objects.length ? 1 : 0) + objectBytes + provenanceBytes;
    if (objects.length >= 1000 || candidateBytes > maximumBodyBytes) {
      if (objects.length) result.push({objects, objectRepositoryIds});
      objects = [];
      objectRepositoryIds = {};
      bodyBytes = emptyBytes;
      provenanceEntries = 0;
    }

    const firstProvenanceBytes = hasProvenance
      ? provenancePropertyBytes + encodedBytes({[object.id]: sourceRepositoryId}) - 2
      : 0;
    if (bodyBytes + objectBytes + firstProvenanceBytes > maximumBodyBytes) {
      throw new Error("Repository object exceeds the synchronization request size limit");
    }
    bodyBytes += (objects.length ? 1 : 0) + objectBytes;
    objects.push(object);
    if (hasProvenance && sourceRepositoryId) {
      bodyBytes += (provenanceEntries ? 1 : provenancePropertyBytes)
        + encodedBytes({[object.id]: sourceRepositoryId}) - 2;
      objectRepositoryIds[object.id] = sourceRepositoryId;
      provenanceEntries += 1;
    }
  }
  if (objects.length) result.push({objects, objectRepositoryIds});
  return result;
}

export function repositoryPushBatches(payload: RepositoryPushPayload, maximumBodyBytes = maximumRepositoryPushBodyBytes) {
  const emptyPayload = {repositoryId: payload.repositoryId, objects: [] as StoredChatMessage[], refs: [] as RepositoryRefUpdate[]};
  const objectBatches = objectChunks(payload, maximumBodyBytes)
    .map(({objects, objectRepositoryIds}) => {
      return {
        repositoryId: payload.repositoryId,
        objects,
        ...(Object.keys(objectRepositoryIds).length ? {objectRepositoryIds} : {}),
        refs: [] as RepositoryRefUpdate[]
      };
    });
  const refBatches = chunks(payload.refs, 100, maximumBodyBytes, emptyPayload, "ref")
    .map((refs) => ({repositoryId: payload.repositoryId, objects: [] as StoredChatMessage[], refs}));
  return [...objectBatches, ...refBatches];
}
