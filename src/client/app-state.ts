import type {Conversation, ConversationSummary, StoredChatMessage, WorkingItem} from "../shared/conversation-types";
import {defaultGenerationSettings} from "../shared/generation-settings";
import type {ChatProfile} from "../shared/profile-types";
import type {ProviderProfile} from "../shared/provider-types";
import type {LocalCredential} from "./providers/local-providers";
import {embeddedModelsDevCatalog, embeddedModelsDevModelCount} from "./providers/models-dev-catalog";

export type ChatProvider = ProviderProfile & {modelDiscoveryError?: string};
export type ChatConfig = {providers: ChatProvider[]; profile: ChatProfile};
export type ServerChatConfig = {identityKey: string; profile: ChatProfile; capabilities?: {sync?: boolean}};
export type CachedChatBootstrap = {profile?: ChatProfile; config?: ChatConfig; frontendProviders?: unknown[]};
export type HashNavigationMode = "push" | "replace" | "none";

export function createInitialAppState() {
  return {
    config: null as ChatConfig | null,
    localCredentials: [] as LocalCredential[],
    conversations: [] as ConversationSummary[],
    conversation: null as Conversation | null,
    providerId: "",
    model: "",
    generationSettings: {...defaultGenerationSettings},
    recentModelKeys: [] as string[],
    historyOpen: window.matchMedia("(min-width: 681px)").matches,
    offline: false,
    loading: true,
    error: "",
    modelQuery: "",
    streaming: false,
    streamController: null as AbortController | null,
    workingItems: [] as WorkingItem[],
    activeDraftId: "",
    historyTree: window.localStorage.getItem("turnfold-history-tree") === "1",
    advancedActions: window.localStorage.getItem("turnfold-advanced-actions") === "1",
    identityKey: "",
    authenticated: false,
    syncing: false,
    syncRequested: false,
    initialFetchComplete: false,
    lastFetchAt: "",
    syncError: "",
    renderFrame: 0,
    settingsTimer: 0,
    syncTimer: 0,
    workingSaveTimers: new Map<string, number>(),
    messageGraph: [] as StoredChatMessage[],
    previewHeadId: "",
    queuedDraftId: "",
    importPanelOpen: false,
    importing: false,
    importStatus: "",
    importTitleTemplate: window.localStorage.getItem("turnfold-import-title-template") || "{title}",
    composerFullscreen: false,
    settingsOpen: false,
    providerEditorOpen: false,
    providerEditorId: "",
    providerEditorMode: "simple" as "simple" | "advanced",
    providerSetupKind: "catalog" as "catalog" | "detect",
    providerSetupUrl: "",
    providerSetupKey: "",
    providerSetupBusy: false,
    providerSetupError: "",
    providerSetupDetected: null as Omit<ProviderProfile, "createdAt" | "updatedAt"> | null,
    providerSetupController: null as AbortController | null,
    providerModelEditorOpen: false,
    providerModelProviderId: "",
    providerModelPresetId: "",
    providerModelQuery: "",
    modelsDevCatalog: embeddedModelsDevCatalog,
    modelsDevModelCount: embeddedModelsDevModelCount,
    modelsDevFetchedAt: "",
    modelsDevUpdating: false,
    modelsDevError: ""
  };
}

export type AppState = ReturnType<typeof createInitialAppState>;
