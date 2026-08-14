import type {RepositoryRefUpdate, StoredChatMessage} from "./conversation-types";
import type {RepositoryPush} from "./repository-types";

export type RepositoryPushPayload = RepositoryPush;

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function repositoryPushBatches(payload: RepositoryPushPayload) {
  const objectBatches = chunks([...new Map(payload.objects.map((object) => [object.id, object])).values()], 1000)
    .map((objects) => ({repositoryId: payload.repositoryId, objects, refs: [] as RepositoryRefUpdate[]}));
  const refBatches = chunks(payload.refs, 100)
    .map((refs) => ({repositoryId: payload.repositoryId, objects: [] as StoredChatMessage[], refs}));
  return [...objectBatches, ...refBatches];
}
