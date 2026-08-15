import type {StoredChatMessage} from "../shared/conversation-types";
import {createMessageObject} from "../shared/message-object";
import {messageNow} from "./draft-model";

export async function immutableMessage(
  input: Pick<StoredChatMessage, "parentMessageId" | "role" | "parts" | "origin" | "completion"> & {metadata?: StoredChatMessage["metadata"]},
  identityKey: string
) {
  const timestamp = messageNow();
  return createMessageObject({...input, createdAt: timestamp, completedAt: timestamp}, identityKey);
}
