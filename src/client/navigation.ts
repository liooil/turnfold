import {conversationHash} from "../shared/conversation-hash";
import type {HashNavigationMode} from "./app-state";

export function updateConversationHash(id: string, mode: Exclude<HashNavigationMode, "none">) {
  const hash = conversationHash(id);
  if (window.location.hash === hash) return;
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", url);
}
