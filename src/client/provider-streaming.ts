import type {GenerationSettings} from "../shared/generation-settings";
import type {ResponseMetadata, StoredChatMessage} from "../shared/conversation-types";
import {responseMetadata} from "../shared/response-metadata";
import type {AppState, ChatProvider} from "./app-state";
import {localCredential, providerOf} from "./app-selectors";
import {messagePartText} from "./conversation-selectors";
import {messageNow} from "./draft-model";
import {saveLocalProviderProfile} from "./providers/local-providers";
import {discoverProviderModels, streamProvider} from "./providers/provider-runtime";

export type StreamEvent = {type: string; text?: string; error?: string; metadata?: ResponseMetadata};
export type StreamRequestContext = {provider: ChatProvider; model: string; conversationId: string; generationSettings: GenerationSettings};

function estimateFrontendOutputTokens(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const withoutSpaces = trimmed.replace(/\s+/g, "");
  const chineseChars = (withoutSpaces.match(/\p{Script=Han}/gu) || []).length;
  const nonChineseChars = withoutSpaces.length - chineseChars;
  return Math.max(0, Math.round(chineseChars + nonChineseChars / 4));
}

export function createProviderStreaming(state: AppState) {
  async function discoverLocalProvider(item: ChatProvider) {
    const secret = localCredential(state, item.id)?.secret || {};
    const discovered = await discoverProviderModels(item, secret);
    const localModels = item.models.filter((model) => model.source !== "discovered" && !discovered.some((candidate) => candidate.id === model.id));
    const models = [...localModels, ...discovered];
    const updated: ChatProvider = {
      ...item,
      models,
      defaultModel: models.some((model) => model.id === item.defaultModel) ? item.defaultModel : models[0].id,
      modelDiscoveryError: undefined,
      updatedAt: messageNow()
    };
    await saveLocalProviderProfile(updated);
    return updated;
  }

  async function streamLocalProvider(messages: StoredChatMessage[], onEvent: (event: StreamEvent) => void, signal: AbortSignal, context?: StreamRequestContext) {
    const item = context?.provider || providerOf(state)!;
    if (!item) throw new Error("当前会话尚未配置 Provider");
    const credential = localCredential(state, item.id);
    const secret = credential?.secret || {};
    if (item.auth.type !== "none" && !secret.apiKey && !Object.keys(secret.headers || {}).length) throw new Error(`请先配置 ${item.name} 的凭据`);
    const startedAt = performance.now();
    let firstTokenAt: number | null = null;
    let responseText = "";
    const result = await streamProvider(
      item,
      secret,
      context?.model || state.model,
      messages.filter((message) => ["system", "user", "assistant"].includes(message.role)).map((message) => ({role: message.role as "system" | "user" | "assistant", text: messagePartText(message, "text")})).filter((message) => message.role !== "system" || message.text),
      context?.generationSettings || state.generationSettings,
      (event) => {
        if ((event.type === "text-delta" || event.type === "reasoning-delta") && event.text && firstTokenAt === null) firstTokenAt = performance.now();
        if (event.type === "text-delta") responseText += event.text;
        onEvent(event);
      },
      signal
    );
    onEvent({type: "finish", metadata: responseMetadata(item.id, context?.model || state.model, startedAt, result.outputTokens, result.outputTokens === undefined ? estimateFrontendOutputTokens(responseText) : undefined, firstTokenAt)});
  }

  return {discoverLocalProvider, streamLocalProvider};
}
