import type {AppState, ChatProvider} from "./app-state";
import type {LocalCredential} from "./providers/local-providers";

export function providerOf(state: AppState): ChatProvider | null {
  return state.config?.providers.find((item) => item.id === state.providerId) || null;
}

export function configuredResponseModel(state: AppState) {
  const item = providerOf(state);
  return item && state.model && item.models.some((model) => model.id === state.model)
    ? {provider: item, model: state.model}
    : null;
}

export function localCredential(state: AppState, providerId = state.providerId): LocalCredential | null {
  return state.localCredentials.find((item) => item.providerId === providerId && item.name === "default")
    || state.localCredentials.find((item) => item.providerId === providerId)
    || null;
}
