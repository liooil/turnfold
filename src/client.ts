import DOMPurify from "dompurify";
import {unzip} from "fflate";
import {marked} from "marked";
import {applyBrowserProviderSettings} from "../lib/browser-provider-settings";
import {createBrowserProviderFetch} from "../lib/browser-provider-fetch";
import {
  commitConversationMessage,
  createConversationHistory,
  deleteConversationHistory,
  getConversationHistory,
  listConversationHistory,
  moveConversationHead,
  synchronizeConversationRepository,
  updateConversationHistory
} from "../lib/conversation-client";
import {conversationHash, conversationIdFromHash} from "../lib/conversation-hash";
import {conversationTitlePrompt, normalizeGeneratedConversationTitle, untitledConversationLabel} from "../lib/conversation-title";
import type {Conversation, ConversationSummary, MessageCompletion, ResponseMetadata, StoredChatMessage, WorkingItem} from "../lib/conversation-types";
import {defaultGenerationSettings, type GenerationSettings, type ReasoningLevel} from "../lib/generation-settings";
import {
  activateOfflineProfile,
  cachedLastFetchAt,
  cacheChatConfig,
  listCachedMessages,
  listWorkingItems,
  loadCachedChatConfig,
  mergeOfflineProfiles,
  removeWorkingItem,
  saveWorkingItem
} from "../lib/offline-history";
import {
  deleteLocalCredential,
  getLocalCredential,
  listLocalCredentials,
  saveLocalCredential,
  type LocalCredential
} from "../lib/local-credentials";
import type {ChatProfile} from "../lib/profile-types";
import type {ProviderDefinition, ProviderModel, ProviderSecret} from "../lib/provider-types";
import {responseMetadata} from "../lib/response-metadata";
import {createMessageObject} from "../lib/message-object";
import {
  conversationTransferDocument,
  parseSessionTransfer,
  serializeSessionTransfer,
  serializeTurnfoldArchive,
  type SessionTransferFormat,
  type TransferDocument,
  type TransferNode
} from "../lib/session-transfer";
import {protectMath, restoreMath} from "../lib/math-markdown";
import {IncrementalMarkdownCache} from "../lib/incremental-markdown-cache";
import {mergeMessageGraph, messageChildrenInGraph, messagePathInGraph, newestBranchTipInGraph, rootEditAlternativesInGraph} from "../lib/message-graph";
import {compactModelName} from "../lib/model-display";
import {applyImportTitleTemplate, importFileStem, importSourceFolder} from "../lib/import-title-template";
import {shouldOpenFullscreenEditor} from "../lib/fullscreen-editor";
import {publicFrontendProviders} from "../lib/public-provider-catalog";
import bundledProviderCatalog from "../providers.json";

type ChatProvider = ProviderDefinition & {models: ProviderModel[]; modelDiscoveryError?: string};
type ChatConfig = {providers: ChatProvider[]; profile: ChatProfile};
type ServerChatConfig = ChatConfig & {identityKey: string; accountUrl?: string};
type CachedChatBootstrap = {config: ChatConfig; frontendProviders: ChatProvider[]};
type StreamEvent = {type: string; text?: string; error?: string; metadata?: ResponseMetadata};
type StreamRequestContext = {provider: ChatProvider; model: string; conversationId: string; generationSettings: GenerationSettings};
type HashNavigationMode = "push" | "replace" | "none";
type MathJaxRuntime = {
  startup?: {promise?: Promise<void>};
  typesetPromise?: (elements?: Element[]) => Promise<void>;
  typesetClear?: (elements?: Element[]) => void;
};
const basePath = __TURNFOLD_BASE_PATH__;
const homeUrl = __TURNFOLD_HOME_URL__;
const appUrl = (pathname: string) => `${basePath}${pathname}`;
const mathJaxAssetPath = `${basePath}/assets/mathjax/4.1.3`;
const builtInFrontendProviders = publicFrontendProviders(bundledProviderCatalog);

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Application root is missing");
const root: HTMLDivElement = rootElement;

function migrateLegacyPreferences() {
  const fixedKeys = ["client-id", "history-tree", "advanced-actions", "import-title-template", "recent-models", "provider"];
  for (const suffix of fixedKeys) {
    const legacy = `xiteng-chat-${suffix}`;
    const current = `turnfold-${suffix}`;
    if (window.localStorage.getItem(current) === null && window.localStorage.getItem(legacy) !== null) {
      window.localStorage.setItem(current, window.localStorage.getItem(legacy)!);
    }
  }
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const legacy = window.localStorage.key(index);
    if (!legacy?.startsWith("xiteng-chat-model:")) continue;
    const current = legacy.replace(/^xiteng-chat-model:/, "turnfold-model:");
    if (window.localStorage.getItem(current) === null) window.localStorage.setItem(current, window.localStorage.getItem(legacy)!);
  }
}

migrateLegacyPreferences();

const state = {
  config: null as ChatConfig | null,
  accountUrl: "",
  frontendProviders: [] as ChatProvider[],
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
  settingsOpen: false
};
const titleGenerationConversationIds = new Set<string>();

const icons = Object.fromEntries(Object.entries({
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h10M4 19h16"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1-2-4-2 1a8 8 0 0 0-2-1l-.3-2h-5l-.3 2a8 8 0 0 0-2 1l-2-1-2 4 2 1a7 7 0 0 0 0 2l-2 1 2 4 2-1a8 8 0 0 0 2 1l.3 2h5l.3-2a8 8 0 0 0 2-1l2 1 2-4-2-1a7 7 0 0 0 .1-1Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7M12 5v14"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  retry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M18 9a7 7 0 0 0-12-2l-2 3m2 5a7 7 0 0 0 12 2l2-3"/></svg>',
  reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-5 4 5 4"/><path d="M5 12h8a6 6 0 0 1 6 6v1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z"/><path d="m14 7 3 3"/></svg>',
  tree: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v16M5 8h6M5 16h6"/><rect x="11" y="5" width="8" height="6" rx="1"/><rect x="11" y="13" width="8" height="6" rx="1"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  scroll: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  offline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M8 8a9 9 0 0 1 12 2M5 12a9 9 0 0 1 2-2m3 6a3 3 0 0 1 4-1m-2 5h.01"/></svg>',
  transfer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M5 17v3h14v-3"/></svg>',
  upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L8 8m4-4 4 4"/><path d="M5 17v3h14v-3"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5"/></svg>'
}).map(([name, markup]) => [name, markup.replace("<svg ", '<svg class="ui-icon" ')])) as Record<string, string>;
function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]!);
}

function messagePartText(message: StoredChatMessage, type: "text" | "reasoning") {
  return message.parts.filter((part) => part.type === type && typeof part.text === "string").map((part) => String(part.text)).join("");
}

function knownMessageMap() {
  return mergeMessageGraph(state.messageGraph, state.conversation?.messages || []);
}

function conversationGraphObjects(conversation: Conversation) {
  if (!conversation.headMessageId) return [];
  const messages = [...knownMessageMap().values()];
  const adjacent = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (!adjacent.has(left)) adjacent.set(left, new Set());
    if (!adjacent.has(right)) adjacent.set(right, new Set());
    adjacent.get(left)!.add(right);
    adjacent.get(right)!.add(left);
  };
  for (const message of messages) {
    if (message.parentMessageId) connect(message.id, message.parentMessageId);
    if ("sourceMessageId" in message.origin && message.origin.sourceMessageId) connect(message.id, message.origin.sourceMessageId);
  }
  const selected = new Set<string>();
  const pending = [conversation.headMessageId];
  while (pending.length) {
    const id = pending.pop()!;
    if (selected.has(id)) continue;
    selected.add(id);
    for (const neighbor of adjacent.get(id) || []) pending.push(neighbor);
  }
  return messages.filter((message) => selected.has(message.id));
}

function downloadText(filename: string, text: string, type = "application/x-ndjson") {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFilename(name: string, suffix: string) {
  const safe = (String(name || "").trim() || "turnfold").replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "turnfold";
  return `${safe}.${suffix}`;
}

async function exportSessions(format: SessionTransferFormat) {
  if (format === "turnfold") {
    const conversations = await Promise.all(state.conversations.map((summary) => getConversationHistory(summary.id)));
    const [objects, workingItems] = await Promise.all([listCachedMessages(), listWorkingItems()]);
    downloadText(exportFilename("turnfold-backup", "turnfold.json"), serializeTurnfoldArchive(conversations, objects, workingItems), "application/json");
    return;
  }
  if (!state.conversation) throw new Error("当前没有可导出的会话");
  const document = conversationTransferDocument(state.conversation, conversationGraphObjects(state.conversation));
  downloadText(exportFilename(state.conversation.name, `${format}.jsonl`), serializeSessionTransfer(document, format));
}

async function materializeTransferNodes(document: TransferDocument) {
  const mappedIds = new Map<string, string>();
  const stored = new Map<string, StoredChatMessage>();
  const pending = new Map(document.nodes.map((node) => [node.sourceId, node]));
  while (pending.size) {
    let progressed = false;
    for (const [sourceId, node] of [...pending]) {
      if (node.parentSourceId && pending.has(node.parentSourceId) && !mappedIds.has(node.parentSourceId)) continue;
      const parentMessageId = node.parentSourceId ? mappedIds.get(node.parentSourceId) || null : null;
      const message = await createMessageObject({
        parentMessageId,
        role: node.role,
        parts: node.parts,
        origin: node.origin || (node.role === "user" ? {type: "user", sourceMessageId: sourceId} : {type: "legacy"}),
        completion: node.completion || {status: "complete"},
        createdAt: node.createdAt,
        completedAt: node.completedAt,
        ...(node.metadata ? {metadata: node.metadata} : {})
      }, state.identityKey);
      mappedIds.set(sourceId, message.id);
      stored.set(message.id, message);
      pending.delete(sourceId);
      progressed = true;
    }
    if (!progressed) throw new Error("导入文件的消息父节点形成循环");
  }
  return {mappedIds, messages: [...stored.values()]};
}

function transferSessionSourceIds(document: TransferDocument, headSourceId: string | null) {
  if (!headSourceId) return new Set<string>();
  const adjacent = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (!adjacent.has(left)) adjacent.set(left, new Set());
    if (!adjacent.has(right)) adjacent.set(right, new Set());
    adjacent.get(left)!.add(right);
    adjacent.get(right)!.add(left);
  };
  for (const node of document.nodes) if (node.parentSourceId) connect(node.sourceId, node.parentSourceId);
  const selected = new Set<string>();
  const pending = [headSourceId];
  while (pending.length) {
    const id = pending.pop()!;
    if (selected.has(id)) continue;
    selected.add(id);
    for (const neighbor of adjacent.get(id) || []) pending.push(neighbor);
  }
  return selected;
}

function uniqueImportedName(source: string, reserved: Set<string>) {
  const base = String(source || "").trim() || "导入的会话";
  if (!reserved.has(base)) {
    reserved.add(base);
    return base;
  }
  let index = 2;
  while (reserved.has(`${base} (导入 ${index})`)) index += 1;
  const name = `${base} (导入 ${index})`;
  reserved.add(name);
  return name;
}

async function importTransferDocument(document: TransferDocument, reservedNames: Set<string>, source: string, firstIndex: number) {
  if (!document.sessions.length) throw new Error("导入文件中没有会话");
  const {mappedIds, messages} = await materializeTransferNodes(document);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const conversationIds = new Map<string, string>();
  const imported: Conversation[] = [];
  for (const [sessionIndex, session] of document.sessions.entries()) {
    const headMessageId = session.headSourceId ? mappedIds.get(session.headSourceId) || null : null;
    const sessionMessages = [...transferSessionSourceIds(document, session.headSourceId)]
      .map((sourceId) => mappedIds.get(sourceId))
      .filter((id): id is string => Boolean(id))
      .map((id) => messagesById.get(id))
      .filter((message): message is StoredChatMessage => Boolean(message));
    const sourceTitle = session.name.trim() || "导入的会话";
    const importedTitle = applyImportTitleTemplate(state.importTitleTemplate, {
      title: sourceTitle,
      format: document.format,
      file: importFileStem(source.replaceAll("\\", "/").split("/").at(-1)?.trim() || source),
      folder: importSourceFolder(source),
      date: session.createdAt.slice(0, 10),
      model: session.model,
      provider: session.providerId,
      index: firstIndex + sessionIndex
    });
    const created = await createConversationHistory(
      session.providerId,
      session.model,
      session.generationSettings,
      uniqueImportedName(importedTitle, reservedNames),
      headMessageId,
      sessionMessages
    );
    conversationIds.set(session.sourceId, created.id);
    imported.push(await getConversationHistory(created.id));
  }
  for (const item of document.workingItems || []) {
    const conversationId = conversationIds.get(item.conversationId);
    if (!conversationId) continue;
    await saveWorkingItem({
      ...item,
      id: uuid(),
      conversationId,
      observedHeadId: item.observedHeadId ? mappedIds.get(item.observedHeadId) || null : null,
      ...(item.editSourceMessageId ? {editSourceMessageId: mappedIds.get(item.editSourceMessageId)} : {})
    });
  }
  return imported;
}

function sessionFileCandidate(name: string) {
  const lower = name.toLowerCase();
  return lower.endsWith(".json") || lower.endsWith(".jsonl");
}

function archiveFileCandidate(name: string) {
  return name.toLowerCase().endsWith(".zip");
}

type ImportSourceFile = {file: File; source: string};

async function filesFromZip(archive: File) {
  const archiveBytes = new Uint8Array(await archive.arrayBuffer());
  let acceptedBytes = 0;
  let acceptedFiles = 0;
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(archiveBytes, {
      filter(entry) {
        if (!sessionFileCandidate(entry.name) || entry.originalSize > 64 * 1024 * 1024) return false;
        if (acceptedFiles >= 2_000 || acceptedBytes + entry.originalSize > 512 * 1024 * 1024) return false;
        acceptedFiles += 1;
        acceptedBytes += entry.originalSize;
        return true;
      }
    }, (error, result) => error ? reject(error) : resolve(result));
  });
  return Object.entries(entries).map(([name, bytes]) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return {
      file: new File([copy.buffer], name, {type: name.toLowerCase().endsWith(".jsonl") ? "application/x-ndjson" : "application/json"}),
      source: `${archive.name} / ${name}`
    };
  });
}

async function expandImportFiles(files: Iterable<File>) {
  const expanded: ImportSourceFile[] = [];
  for (const file of files) {
    if (sessionFileCandidate(file.name)) expanded.push({file, source: file.webkitRelativePath || file.name});
    else if (archiveFileCandidate(file.name)) expanded.push(...await filesFromZip(file));
  }
  return expanded;
}

async function filesFromDirectory(handle: FileSystemDirectoryHandle) {
  const files: ImportSourceFile[] = [];
  let visited = 0;
  const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    const entries = (directory as FileSystemDirectoryHandle & {values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>}).values();
    for await (const entry of entries) {
      visited += 1;
      if (visited > 25_000) throw new Error("文件夹内容过多；请直接选择 sessions 或 projects 目录，而不是整个主目录");
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === "directory") {
        if (["node_modules", ".git", "cache", "logs"].includes(entry.name.toLowerCase())) continue;
        await walk(entry, path);
      } else if (sessionFileCandidate(entry.name)) {
        if (files.length >= 2_000) throw new Error("检测到超过 2000 个会话文件；请分批选择更小的目录");
        files.push({file: await entry.getFile(), source: path});
      }
    }
  };
  await walk(handle, handle.name);
  return files;
}

async function importSessionFiles(files: Iterable<ImportSourceFile>, sourceLabel: string) {
  const candidates = [...files];
  if (!candidates.length) throw new Error("没有找到可导入的 .json 或 .jsonl 会话文件");
  applyImportTitleTemplate(state.importTitleTemplate, {title: "标题", format: "codex", file: "rollout", folder: "sessions", date: "2026-08-13", model: "model", provider: "provider", index: 1});
  state.importing = true;
  state.importStatus = `正在扫描 ${sourceLabel} 中的 ${candidates.length} 个候选文件…`;
  renderApp();
  let imported = 0;
  const formats = new Set<SessionTransferFormat>();
  const failures: string[] = [];
  const reservedNames = new Set(state.conversations.map((item) => item.name));
  let firstConversationId = "";
  for (const [index, candidate] of candidates.entries()) {
    state.importStatus = `正在导入 ${index + 1} / ${candidates.length}：${candidate.source}`;
    updateImportStatus();
    try {
      const document = parseSessionTransfer(await candidate.file.text(), candidate.file.name);
      formats.add(document.format);
      const conversations = await importTransferDocument(document, reservedNames, candidate.source, imported + 1);
      imported += conversations.length;
      firstConversationId ||= conversations[0]?.id || "";
    } catch (error) {
      failures.push(`${candidate.source}：${error instanceof Error ? error.message : "无法解析"}`);
    }
  }
  try {
    state.conversations = await listConversationHistory();
    state.messageGraph = await listCachedMessages();
    if (firstConversationId) await selectConversation(firstConversationId);
    if (imported) scheduleRepositorySync();
    const formatLabel = formats.size ? ` · ${[...formats].join(" / ")}` : "";
    state.importStatus = `已导入 ${imported} 个会话${formatLabel}${failures.length ? `；跳过 ${failures.length} 个无法识别的文件` : ""}`;
    if (failures.length) state.importStatus += `\n${failures.slice(0, 3).join("\n")}${failures.length > 3 ? `\n另有 ${failures.length - 3} 个…` : ""}`;
  } catch (error) {
    state.importStatus = `导入在保存阶段中断：${error instanceof Error ? error.message : "未知错误"}`;
    throw error;
  } finally {
    state.importing = false;
    renderApp();
  }
}

function updateImportStatus() {
  const status = root.querySelector<HTMLElement>(".session-import-status");
  if (status) status.textContent = state.importStatus;
}

async function chooseImportDirectory() {
  const picker = (window as Window & {showDirectoryPicker?: (options?: {mode?: "read"}) => Promise<FileSystemDirectoryHandle>}).showDirectoryPicker;
  if (!picker) {
    root.querySelector<HTMLInputElement>('[data-action="session-directory"]')?.click();
    return;
  }
  try {
    const handle = await picker({mode: "read"});
    state.importing = true;
    state.importStatus = `正在只读扫描文件夹 ${handle.name}…`;
    renderApp();
    const files = await filesFromDirectory(handle);
    await importSessionFiles(files, `文件夹 ${handle.name}`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    state.importing = false;
    state.importStatus = `文件夹扫描失败：${error instanceof Error ? error.message : "未知错误"}`;
    renderApp();
    throw error;
  }
}

function messagePathTo(headMessageId: string | null) {
  return messagePathInGraph(knownMessageMap(), headMessageId);
}

function displayedMessages() {
  if (!state.previewHeadId) return state.conversation?.messages || [];
  return messagePathTo(state.previewHeadId);
}

function messageChildren(parentMessageId: string | null) {
  return messageChildrenInGraph(knownMessageMap(), parentMessageId);
}

function newestBranchTip(startId: string) {
  const currentIds = new Set((state.conversation?.messages || []).map((message) => message.id));
  return newestBranchTipInGraph(knownMessageMap(), startId, currentIds, state.conversation?.headMessageId || null);
}

function markdown(value: string) {
  const {source, fragments} = protectMath(value);
  const html = marked.parse(source, {async: false, gfm: true, breaks: false}) as string;
  return {
    html: DOMPurify.sanitize(restoreMath(html, fragments)),
    hasMath: fragments.length > 0
  };
}

function markdownRenderKey(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}-${(hash >>> 0).toString(36)}`;
}

type RenderedMarkdownBlock = {
  id: string;
  index: number;
  type: string;
  source: string;
  html: string;
  renderKey: string;
  hasMath: boolean;
  stable: boolean;
};

const streamingMarkdownCaches = new IncrementalMarkdownCache<Omit<RenderedMarkdownBlock, "source" | "type" | "index" | "stable">>();
const finishingMarkdownMessages = new Set<string>();
const markdownRenderMetrics = {
  lexMs: 0,
  parseMs: 0,
  blocksParsed: 0,
  blocksReused: 0,
  domBlocksUpdated: 0,
  mathTypesets: 0
};
(window as typeof window & {__turnfoldRenderMetrics?: typeof markdownRenderMetrics}).__turnfoldRenderMetrics = markdownRenderMetrics;

function renderMarkdownBlock(source: string, messageId: string, index: number, type: string, stable: boolean): RenderedMarkdownBlock {
  const startedAt = performance.now();
  const rendered = markdown(source);
  markdownRenderMetrics.parseMs += performance.now() - startedAt;
  markdownRenderMetrics.blocksParsed += 1;
  return {
    id: `${messageId}:markdown:${index}`,
    index,
    type,
    source,
    html: rendered.html,
    renderKey: markdownRenderKey(source),
    hasMath: rendered.hasMath,
    stable
  };
}

function markdownBlocks(value: string, messageId: string, complete: boolean) {
  if (complete && !streamingMarkdownCaches.has(messageId)) {
    return [renderMarkdownBlock(value, messageId, 0, "document", true)];
  }

  const result = streamingMarkdownCaches.render(
    messageId,
    value,
    (source, type, index, stable) => renderMarkdownBlock(source, messageId, index, type, stable),
    (durationMs) => { markdownRenderMetrics.lexMs += durationMs; },
    complete
  );
  markdownRenderMetrics.blocksReused += result.reused;
  return result.blocks;
}

function markdownBlockMarkup(block: RenderedMarkdownBlock) {
  return `<div class="markdown-block" data-block-id="${escapeHtml(block.id)}" data-block-index="${block.index}" data-block-type="${escapeHtml(block.type)}" data-render-key="${block.renderKey}" data-block-stable="${block.stable ? "1" : "0"}" data-has-math="${block.hasMath ? "1" : "0"}">${block.html}</div>`;
}

function isStreamingAssistant(message: StoredChatMessage, index: number) {
  return state.streaming
    && state.conversation?.messages.at(-1)?.id === message.id;
}

function renderMarkdownContainer(value: string, messageId: string, complete: boolean) {
  const blocks = markdownBlocks(value, messageId, complete);
  return `<div class="aui-md" data-render-key="${markdownRenderKey(value)}">${blocks.map(markdownBlockMarkup).join("")}</div>`;
}

function mathJaxRuntime() {
  return (window as typeof window & {MathJax?: MathJaxRuntime}).MathJax;
}

let mathJaxLoad: Promise<MathJaxRuntime> | null = null;
let mathTypesetChain = Promise.resolve();
let mathTypesetFrame = 0;
const pendingMathElements = new Map<HTMLElement, string>();

function ensureMathJax() {
  const active = mathJaxRuntime();
  if (active?.typesetPromise) return Promise.resolve(active);
  if (mathJaxLoad) return mathJaxLoad;

  (window as typeof window & {MathJax?: unknown}).MathJax = {
    loader: {paths: {fonts: `${mathJaxAssetPath}/fonts`}},
    output: {font: "mathjax-newcm"},
    tex: {
      inlineMath: {"[+]": [["$", "$"]]},
      processEscapes: true
    },
    options: {
      enableSpeech: false,
      enableBraille: false,
      enableExplorer: false,
      menuOptions: {settings: {speech: false, braille: false}}
    },
    svg: {fontCache: "local"},
    startup: {typeset: false}
  };

  mathJaxLoad = new Promise<MathJaxRuntime>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${mathJaxAssetPath}/tex-svg-nofont.js`;
    script.async = true;
    script.dataset.mathjax = "true";
    script.addEventListener("error", () => reject(new Error("MathJax 加载失败")), {once: true});
    script.addEventListener("load", async () => {
      try {
        const runtime = mathJaxRuntime();
        await runtime?.startup?.promise;
        if (!runtime?.typesetPromise) throw new Error("MathJax 初始化失败");
        resolve(runtime);
      } catch (error) {
        reject(error);
      }
    }, {once: true});
    document.head.appendChild(script);
  }).catch((error) => {
    mathJaxLoad = null;
    throw error;
  });
  return mathJaxLoad;
}

function clearMathTypesetting(element: Element) {
  mathJaxRuntime()?.typesetClear?.([element]);
}

function scheduleMathTypesetting(element: Element) {
  const candidates = element.matches('.math-fragment:not([data-math-rendered="1"])')
    ? [element as HTMLElement]
    : Array.from(element.querySelectorAll<HTMLElement>('.math-fragment:not([data-math-rendered="1"])'));
  for (const candidate of candidates) {
    pendingMathElements.set(candidate, candidate.dataset.mathKey || "");
    candidate.dataset.mathPending = "1";
  }
  if (!candidates.length || mathTypesetFrame) return;
  mathTypesetFrame = window.requestAnimationFrame(() => {
    mathTypesetFrame = 0;
    const batch = [...pendingMathElements.entries()];
    pendingMathElements.clear();
    mathTypesetChain = mathTypesetChain.then(async () => {
      const current = batch.filter(([candidate, mathKey]) => candidate.isConnected && candidate.dataset.mathKey === mathKey);
      if (!current.length) return;
      const runtime = await ensureMathJax();
      const stillCurrent = current.filter(([candidate, mathKey]) => candidate.isConnected && candidate.dataset.mathKey === mathKey);
      if (!stillCurrent.length) return;
      const viewport = root.querySelector<HTMLElement>("#thread-viewport");
      const wasAtBottom = isViewportAtBottom(viewport);
      const previousScrollTop = viewport?.scrollTop || 0;
      await runtime.typesetPromise!(stillCurrent.map(([candidate]) => candidate));
      markdownRenderMetrics.mathTypesets += stillCurrent.length;
      for (const [candidate, mathKey] of stillCurrent) {
        if (candidate.isConnected && candidate.dataset.mathKey === mathKey) {
          candidate.dataset.mathRendered = "1";
          candidate.dataset.mathTypesetCount = String(Number(candidate.dataset.mathTypesetCount || "0") + 1);
          const block = candidate.closest<HTMLElement>(".markdown-block");
          if (block) block.dataset.mathTypesetCount = String(Number(block.dataset.mathTypesetCount || "0") + 1);
          delete candidate.dataset.mathPending;
        }
      }
      if (wasAtBottom) scrollBottom();
      else if (viewport) viewport.scrollTop = previousScrollTop;
      for (const [candidate, mathKey] of stillCurrent) {
        if (candidate.isConnected && candidate.dataset.mathKey !== mathKey) scheduleMathTypesetting(candidate);
      }
    }).catch((error) => {
      for (const [candidate] of batch) delete candidate.dataset.mathPending;
      console.error("MathJax typesetting failed", error);
    });
  });
}

function estimateFrontendOutputTokens(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const withoutSpaces = trimmed.replace(/\s+/g, "");
  const chineseChars = (withoutSpaces.match(/\p{Script=Han}/gu) || []).length;
  const nonChineseChars = withoutSpaces.length - chineseChars;
  return Math.max(0, Math.round(chineseChars + nonChineseChars / 4));
}

function provider() {
  return state.config?.providers.find((item) => item.id === state.providerId) || null;
}

function localCredential(providerId = state.providerId) {
  return state.localCredentials.find((item) => item.providerId === providerId && item.name === "default")
    || state.localCredentials.find((item) => item.providerId === providerId)
    || null;
}

function updateConversationHash(id: string, mode: Exclude<HashNavigationMode, "none">) {
  const hash = conversationHash(id);
  if (window.location.hash === hash) return;
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  window.history[mode === "replace" ? "replaceState" : "pushState"]({}, "", url);
}

function settingsForProvider(item: ChatProvider) {
  const saved = window.localStorage.getItem(`turnfold-model:${item.id}`) || "";
  const model = item.models.some((candidate) => candidate.id === saved)
    ? saved
    : item.models.some((candidate) => candidate.id === item.defaultModel) ? item.defaultModel : item.models[0]?.id || "";
  return {model};
}

function rememberModel(providerId: string, model: string) {
  if (!providerId || !model) return;
  const key = `${providerId}/${model}`;
  state.recentModelKeys = [key, ...state.recentModelKeys.filter((item) => item !== key)].slice(0, 20);
  window.localStorage.setItem("turnfold-recent-models", JSON.stringify(state.recentModelKeys));
}

function avatarPlaceholder(profile: ChatProfile) {
  const source = String(profile.name || profile.username || "U").trim() || "U";
  const parts = source.split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)![0]}` : [...source].slice(0, 2).join("")).toUpperCase();
  let hash = 0;
  for (const character of String(profile.username || profile.name || initials)) hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  const hue = Math.abs(hash) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="32" fill="hsl(${hue} 58% 48%)"/><text x="128" y="145" text-anchor="middle" font-family="system-ui,sans-serif" font-size="82" font-weight="800" fill="white">${escapeHtml(initials)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function updateAvatar() {
  const image = root.querySelector<HTMLImageElement>(".header-avatar");
  const profile = state.config?.profile;
  const email = String(profile?.email || "").trim().toLowerCase();
  if (!image || !email) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  for (const source of [`https://www.gravatar.com/avatar/${hash}?d=404&s=256`, `https://seccdn.libravatar.org/avatar/${hash}?d=404&s=256`]) {
    const loaded = await new Promise<boolean>((resolve) => {
      const candidate = new Image();
      const timer = window.setTimeout(() => resolve(false), 5000);
      candidate.onload = () => { window.clearTimeout(timer); resolve(true); };
      candidate.onerror = () => { window.clearTimeout(timer); resolve(false); };
      candidate.referrerPolicy = "no-referrer";
      candidate.src = source;
    });
    if (loaded && image.isConnected) {
      image.src = source;
      break;
    }
  }
}

type ModelChoice = {provider: ChatProvider; model: ProviderModel; key: string};

function availableModelChoices(): ModelChoice[] {
  return state.config?.providers.flatMap((item) => item.models.map((model) => ({provider: item, model, key: `${item.id}/${model.id}`}))) || [];
}

function renderEffortControl(name: string) {
  const options: Array<[ReasoningLevel, string]> = [["auto", "自动"], ["none", "关闭"], ["low", "低"], ["medium", "中"], ["high", "高"]];
  return `<div class="effort-control"><div class="effort-heading"><strong>Effort</strong><small>控制模型的思考强度</small></div><div class="effort-options" role="radiogroup" aria-label="Effort">${options.map(([value, label]) => `<label><input type="radio" name="${name}" value="${value}" data-setting="reasoning"${state.generationSettings.reasoning === value ? " checked" : ""}><span>${label}</span></label>`).join("")}</div></div>`;
}

function renderModelOption(choice: ModelChoice) {
  const active = choice.provider.id === state.providerId && choice.model.id === state.model;
  const displayName = compactModelName(choice.model.name || choice.model.id);
  const detail = displayName === choice.model.id
    ? choice.provider.name
    : `${choice.model.id} · ${choice.provider.name}`;
  return `<button class="model-option${active ? " active" : ""}" type="button" data-action="choose-model" data-provider="${escapeHtml(choice.provider.id)}" data-model="${escapeHtml(choice.model.id)}"><span><strong>${escapeHtml(displayName)}</strong><small title="${escapeHtml(choice.model.id)}">${escapeHtml(detail)}</small></span><small>${choice.provider.connection.type === "frontend" ? "Frontend" : "Backend"}</small></button>`;
}

function quickModelChoices(choices: ModelChoice[]) {
  const activeKey = `${state.providerId}/${state.model}`;
  const preferredKeys = [activeKey, ...state.recentModelKeys, ...(state.config?.providers.map((item) => `${item.id}/${item.defaultModel}`) || [])];
  const selected: ModelChoice[] = [];
  for (const key of preferredKeys) {
    const choice = choices.find((item) => item.key === key);
    if (choice && !selected.includes(choice)) selected.push(choice);
  }
  for (const choice of choices) if (selected.length < 6 && !selected.includes(choice)) selected.push(choice);
  return selected.slice(0, 6);
}

function renderModelPicker() {
  const active = provider();
  if (!active || !state.config) return "";
  const activeModelName = compactModelName(active.models.find((model) => model.id === state.model)?.name || state.model);
  const choices = quickModelChoices(availableModelChoices());
  return `<details class="model-picker"><summary aria-label="模型和 Effort"><span class="picker-label">${escapeHtml(activeModelName)}</span><span class="picker-icons"><i class="picker-chevron">${icons.down}</i></span></summary><div class="model-menu"><section class="quick-models"><div class="quick-config-heading"><strong>模型</strong><small>当前与最近使用</small></div><div class="quick-model-list">${choices.map(renderModelOption).join("")}</div></section>${renderEffortControl("quick-effort")}<button class="open-settings-button" type="button" data-action="open-settings">${icons.settings}<span><strong>打开全部设置</strong><small>模型、生成参数与 Provider</small></span></button></div></details>`;
}

function renderProviderSettings() {
  if (!state.frontendProviders.length) return "";
  return `<section class="model-provider-settings"><div class="settings-section-heading"><strong>Provider 连接</strong><small>找不到模型时，在这里配置浏览器直连 Provider；服务需允许当前页面的 CORS 与本地网络访问</small></div>${state.frontendProviders.map((item) => {
    const configured = state.localCredentials.some((credential) => credential.providerId === item.id);
    return `<section class="local-key-entry"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.auth.type === "none" ? item.connection.baseUrl : item.id)}</small>${item.modelDiscoveryError ? `<small class="local-key-error">${escapeHtml(item.modelDiscoveryError)}</small>` : ""}</span><div><button type="button" data-action="configure-local" data-provider="${escapeHtml(item.id)}">${item.auth.type === "none" ? "端点" : configured ? "更新" : "配置"}</button>${configured ? `<button class="dangerous" type="button" data-action="delete-local" data-provider="${escapeHtml(item.id)}">重置</button>` : ""}${item.auth.type === "none" ? `<button type="button" data-action="probe-local" data-provider="${escapeHtml(item.id)}">探测</button>` : ""}</div></section>`;
  }).join("")}</section>`;
}

function renderGenerationSettings() {
  const settings = state.generationSettings;
  return `${renderEffortControl("settings-effort")}<div class="settings-field-grid"><label class="settings-check"><input type="checkbox" data-setting="showReasoningSummary"${settings.showReasoningSummary ? " checked" : ""}><span><strong>显示思考摘要</strong><small>Provider 支持时返回可见的思考摘要</small></span></label><label>Temperature<input type="number" min="0" max="2" step="0.1" placeholder="自动" data-setting="temperature" value="${settings.temperature ?? ""}"></label><label>最大输出 Tokens<input type="number" min="1" max="1000000" step="1" placeholder="自动" data-setting="maxOutputTokens" value="${settings.maxOutputTokens ?? ""}"></label></div><button class="settings-reset-button" type="button" data-action="reset-settings">恢复默认生成参数</button>`;
}

function renderSettingsPage() {
  if (!state.settingsOpen || !state.config) return "";
  const query = state.modelQuery.trim().toLowerCase();
  const choices = availableModelChoices();
  const matches = choices.filter((choice) => !query || choice.key.toLowerCase().includes(query) || choice.model.name.toLowerCase().includes(query) || choice.provider.name.toLowerCase().includes(query));
  const groups = state.config.providers.map((item) => {
    const items = matches.filter((choice) => choice.provider.id === item.id);
    return items.length ? `<section class="settings-model-group"><h3>${escapeHtml(item.name)}</h3><div>${items.map(renderModelOption).join("")}</div></section>` : "";
  }).join("");
  const providerSettings = renderProviderSettings();
  const accountHref = state.authenticated ? state.accountUrl : "";
  const accountLabel = "管理 Backend Provider 与凭据";
  const accountLink = accountHref ? `<a class="settings-account-link" href="${escapeHtml(accountHref)}">${icons.settings}<span>${accountLabel}</span></a>` : "";
  return `<section class="settings-page" role="dialog" aria-modal="true" aria-label="设置"><header class="settings-page-header"><button type="button" data-action="close-settings" aria-label="关闭设置">${icons.close}</button><span><strong>设置</strong><small>更改会自动保存</small></span></header><div class="settings-layout"><nav class="settings-nav" aria-label="设置分类"><button type="button" data-action="scroll-settings-section" data-id="settings-models">模型</button><button type="button" data-action="scroll-settings-section" data-id="settings-generation">生成</button><button type="button" data-action="scroll-settings-section" data-id="settings-providers">Provider</button><button type="button" data-action="scroll-settings-section" data-id="settings-interface">界面</button></nav><main class="settings-content"><section class="settings-card" id="settings-models"><header><h2>模型</h2><p>选择当前会话使用的模型。</p></header><label class="settings-model-search">${icons.search}<input value="${escapeHtml(state.modelQuery)}" data-action="model-search" placeholder="搜索 Provider 或模型"></label><div class="settings-model-groups">${groups || '<p class="settings-empty">没有匹配的模型</p>'}</div></section><section class="settings-card" id="settings-generation"><header><h2>生成</h2><p>这些参数随当前会话保存。</p></header>${renderGenerationSettings()}</section><section class="settings-card" id="settings-providers"><header><h2>Provider</h2><p>管理浏览器直连端点；Backend 凭据由账户安全保存。</p></header>${providerSettings || '<p class="settings-empty">当前没有可配置的浏览器 Provider。</p>'}${accountLink}</section><section class="settings-card" id="settings-interface"><header><h2>界面</h2><p>这些选项仅保存在当前浏览器。</p></header><div class="settings-interface-options"><label class="settings-check"><input type="checkbox" data-action="advanced-actions"${state.advancedActions ? " checked" : ""}><span><strong>显示高级对话操作</strong><small>显示“需要回答”和编辑助手回答</small></span></label><label class="settings-check"><input type="checkbox" data-action="history-tree-setting"${state.historyTree ? " checked" : ""}><span><strong>树状显示聊天历史</strong><small>按会话名称中的路径组织侧栏</small></span></label></div></section></main></div></section>`;
}

function scrollSettingsSection(id: string) {
  const section = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  section?.scrollIntoView({behavior: "smooth", block: "start"});
}

function historyItem(item: ConversationSummary, label = item.name, depth = 0) {
  const displayLabel = String(label || "").trim() || untitledConversationLabel;
  return `<article class="history-item${item.id === state.conversation?.id ? " active" : ""}" style="--history-depth:${depth}"><button class="history-select" type="button" data-action="select-conversation" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(displayLabel)}</strong><small>${escapeHtml(item.providerId)} · ${escapeHtml(item.model)}</small></button><button class="history-rename" type="button" data-action="rename-conversation" data-id="${escapeHtml(item.id)}" aria-label="重命名 ${escapeHtml(displayLabel)}">${icons.edit}</button><button class="history-delete" type="button" data-action="delete-conversation" data-id="${escapeHtml(item.id)}" aria-label="删除 ${escapeHtml(displayLabel)}">${icons.trash}</button></article>`;
}

type HistoryTreeNode = {segment: string; path: string; conversations: ConversationSummary[]; children: Map<string, HistoryTreeNode>};

function renderHistoryItems() {
  if (!state.historyTree) return state.conversations.map((item) => historyItem(item)).join("");
  const rootNode: HistoryTreeNode = {segment: "", path: "", conversations: [], children: new Map()};
  for (const conversation of state.conversations) {
    const segments = String(conversation.name || "").split("/").filter(Boolean);
    let node = rootNode;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let child = node.children.get(segment);
      if (!child) {
        child = {segment, path, conversations: [], children: new Map()};
        node.children.set(segment, child);
      }
      node = child;
    });
    node.conversations.push(conversation);
  }
  const renderNode = (node: HistoryTreeNode, depth: number): string => {
    const children = [...node.children.values()].sort((left, right) => left.segment.localeCompare(right.segment));
    const hasChildren = children.length > 0;
    const rows = node.conversations.map((item) => historyItem(item, node.segment || item.name, depth)).join("");
    const folder = hasChildren && node.segment
      ? `<div class="history-folder" style="--history-depth:${depth}">${escapeHtml(node.segment)}</div>`
      : "";
    return `${folder}${rows}${children.map((child) => renderNode(child, node.segment ? depth + 1 : depth)).join("")}`;
  };
  return renderNode(rootNode, 0);
}

function importTitleTemplatePreview() {
  try {
    return {
      text: `预览：${applyImportTitleTemplate(state.importTitleTemplate, {title: "修复登录问题", format: "codex", file: "rollout-123", folder: "sessions", date: "2026-08-13", model: "gpt-5.6-sol", provider: "openai", index: 1})}`,
      error: false
    };
  } catch (error) {
    return {text: error instanceof Error ? error.message : "标题模板无效", error: true};
  }
}

function renderImportPanel() {
  if (!state.importPanelOpen) return "";
  const disabled = state.importing ? " disabled" : "";
  const preview = importTitleTemplatePreview();
  return `<div class="session-import-overlay" role="presentation" data-action="close-import-panel"><section class="session-import-panel" role="dialog" aria-modal="true" aria-labelledby="session-import-title" data-import-panel><header><div><h2 id="session-import-title">导入聊天记录</h2><p>文件只在当前浏览器中读取；不会上传原始文件或申请写权限。</p></div><button type="button" data-action="close-import-panel" aria-label="关闭"${disabled}>${icons.close}</button></header><div class="session-location-help"><h3>这些文件通常在哪里？</h3><dl><div><dt>Codex CLI</dt><dd><code>~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl</code></dd></div><div><dt>Claude Code</dt><dd><code>~/.claude/projects/&lt;项目&gt;/*.jsonl</code></dd></div><div><dt>OMP</dt><dd><code>~/.omp/agent/sessions/&lt;项目&gt;/*.jsonl</code></dd></div><div><dt>Turnfold</dt><dd>浏览器“下载”目录中的 <code>*.turnfold.json</code></dd></div></dl><p>Windows 中的 <code>~</code> 对应 <code>%USERPROFILE%</code>。如果文件选择器默认隐藏点号目录，可直接输入路径，或先将目录打包为 ZIP。</p></div><label class="session-title-template"><span><strong>会话标题模板</strong><small>使用 <code>/</code> 可生成分组名称</small></span><input type="text" data-action="import-title-template" value="${escapeHtml(state.importTitleTemplate)}" aria-describedby="import-title-template-help" aria-invalid="${preview.error}"${disabled}></label><p class="session-title-template-help" id="import-title-template-help">可用变量：<code>{title}</code> <code>{format}</code> <code>{file}</code> <code>{folder}</code> <code>{date}</code> <code>{model}</code> <code>{provider}</code> <code>{index}</code></p><output class="session-title-template-preview${preview.error ? " error" : ""}">${escapeHtml(preview.text)}</output><div class="session-import-actions"><button type="button" data-action="choose-session-files"${disabled}>${icons.upload}<span><strong>选择多个文件</strong><small>JSON / JSONL；可一次多选</small></span></button><button type="button" data-action="choose-session-archive"${disabled}><span class="format-mark">ZIP</span><span><strong>选择 ZIP 压缩包</strong><small>递归查找其中的 JSON / JSONL</small></span></button><button type="button" data-action="choose-session-directory"${disabled}><span class="format-mark">DIR</span><span><strong>授权读取文件夹</strong><small>只读并递归扫描，浏览器会先询问</small></span></button></div>${state.importStatus ? `<pre class="session-import-status" aria-live="polite">${escapeHtml(state.importStatus)}</pre>` : ""}<input type="file" data-action="session-file" accept=".json,.jsonl,application/json,application/x-ndjson" multiple hidden><input type="file" data-action="session-archive" accept=".zip,application/zip" multiple hidden><input type="file" data-action="session-directory" accept=".json,.jsonl,application/json,application/x-ndjson" webkitdirectory directory multiple hidden></section></div>`;
}

function renderHistory() {
  const transferMenu = `<details class="history-transfer"><summary aria-label="导入或导出会话">${icons.transfer}</summary><div class="history-transfer-menu"><button type="button" data-action="import-session">${icons.upload}<span><strong>导入</strong><small>文件、ZIP 或本地文件夹</small></span></button><hr><button type="button" data-action="export-session" data-format="turnfold">${icons.transfer}<span><strong>Turnfold 完整备份</strong><small>整个本地仓库、分支和草稿</small></span></button><button type="button" data-action="export-session" data-format="codex"><span class="format-mark">CX</span><span><strong>Codex CLI JSONL</strong><small>导出当前分支</small></span></button><button type="button" data-action="export-session" data-format="claude"><span class="format-mark">CL</span><span><strong>Claude Code JSONL</strong><small>导出当前消息树</small></span></button><button type="button" data-action="export-session" data-format="omp"><span class="format-mark">OP</span><span><strong>OMP JSONL</strong><small>导出当前消息树</small></span></button></div></details>`;
  return `<button class="history-backdrop${state.historyOpen ? " open" : ""}" type="button" aria-label="关闭历史记录" data-action="close-history"></button><aside class="history-sidebar${state.historyOpen ? " open" : ""}" aria-label="聊天历史"><div class="history-heading"><strong>聊天历史</strong><div>${transferMenu}<button type="button" data-action="toggle-history-tree" aria-label="${state.historyTree ? "平铺显示" : "树状显示"}">${state.historyTree ? icons.list : icons.tree}</button><button type="button" data-action="new-conversation" aria-label="新对话">${icons.plus}</button><button class="history-close" type="button" data-action="close-history" aria-label="关闭历史记录">${icons.close}</button></div></div><div class="history-list">${renderHistoryItems()}</div></aside>`;
}

function activeReplyTargetId() {
  const draft = activeDraft();
  if (!draft || draft.editSourceMessageId) return undefined;
  const latestId = displayedMessages().at(-1)?.id || null;
  return draft.observedHeadId === latestId ? undefined : draft.observedHeadId;
}

function replyAction(message: StoredChatMessage, index: number) {
  return `<button class="icon-button" type="button" data-action="reply-message" data-index="${index}" aria-label="回复到这条消息" title="回复到这条消息">${icons.reply}</button>`;
}

function renderMessage(message: StoredChatMessage, index: number) {
  const replyTarget = activeReplyTargetId() === message.id;
  const messageAttributes = `data-message-index="${index}" data-message-id="${escapeHtml(message.id)}"`;
  const branches = renderBranchNavigator(message);
  if (message.role === "user") {
    return `<article class="message user-message${replyTarget ? " reply-target" : ""}" ${messageAttributes}><div class="message-content user-content"><p>${escapeHtml(messagePartText(message, "text"))}</p></div><div class="user-message-actions">${replyAction(message, index)}<button class="icon-button" type="button" data-action="edit-message" data-index="${index}" aria-label="编辑消息"${state.streaming ? " disabled" : ""}>${icons.edit}</button>${branches}</div></article>`;
  }
  if (message.role !== "assistant") return "";
  const reasoning = messagePartText(message, "reasoning");
  const text = messagePartText(message, "text");
  const streamed = isStreamingAssistant(message, index);
  const renderedText = text ? renderMarkdownContainer(text, message.id, !streamed || finishingMarkdownMessages.has(message.id)) : null;
  const error = message.parts.find((part) => part.type === "error" && typeof part.text === "string")?.text;
  const response = message.metadata?.custom?.response;
  const modelLabel = response?.model ? `${response.providerId || state.providerId}/${response.model}` : `${state.providerId}/${state.model}`;
  const speed = typeof response?.tokensPerSecond === "number" ? `${response.tokensPerSecond.toFixed(1)} tok/s` : "速度 —";
  const detail = response?.durationMs ? `${(response.durationMs / 1000).toFixed(1)} 秒${typeof response.outputTokens === "number" ? ` · ${response.outputTokens} tokens` : ""}` : "历史回复未记录速度";
  const partial = message.completion.status === "partial" ? `<span class="partial-badge">未完成${message.completion.reason ? ` · ${escapeHtml(message.completion.reason)}` : ""}</span>` : "";
  return `<article class="message assistant-message${replyTarget ? " reply-target" : ""}" ${messageAttributes}><div class="message-content assistant-content">${reasoning ? `<details class="message-reasoning"><summary>思考过程</summary><div>${escapeHtml(reasoning)}</div></details>` : ""}${renderedText || state.streaming && state.conversation?.messages.at(-1)?.id === message.id ? renderedText || '<span class="response-loader"></span>' : ""}${error ? `<div class="message-error">${escapeHtml(error)}</div>` : ""}</div><div class="message-footer"><div class="response-summary"><div class="response-meta" title="${escapeHtml(detail)}"><span>${escapeHtml(modelLabel)}</span><span>${escapeHtml(speed)}</span></div>${partial}</div><div class="message-actions">${branches}${replyAction(message, index)}<button class="icon-button" type="button" data-action="copy-message" data-index="${index}" aria-label="复制回答">${icons.copy}</button>${state.advancedActions ? `<button class="icon-button" type="button" data-action="edit-message" data-index="${index}" aria-label="编辑回答"${state.streaming ? " disabled" : ""}>${icons.edit}</button>` : ""}<button class="icon-button" type="button" data-action="regenerate-message" data-index="${index}" aria-label="重新生成"${state.streaming ? " disabled" : ""}>${icons.retry}</button></div></div></article>`;
}

function renderBranchNavigator(message: StoredChatMessage) {
  const siblings = message.parentMessageId === null
    ? rootEditAlternativesInGraph(knownMessageMap(), message.id)
    : messageChildren(message.parentMessageId);
  if (siblings.length < 2) return "";
  const index = siblings.findIndex((candidate) => candidate.id === message.id);
  if (index < 0) return "";
  const previous = siblings[(index - 1 + siblings.length) % siblings.length];
  const next = siblings[(index + 1) % siblings.length];
  return `<span class="branch-navigator" aria-label="分支 ${index + 1}/${siblings.length}"><button class="icon-button" type="button" data-action="switch-branch" data-id="${escapeHtml(previous.id)}" aria-label="上一个分支">‹</button><span>${index + 1} / ${siblings.length}</span><button class="icon-button" type="button" data-action="switch-branch" data-id="${escapeHtml(next.id)}" aria-label="下一个分支">›</button></span>`;
}

function renderMessagesMarkup() {
  const messages = displayedMessages();
  if (!messages.length) {
    const description = !state.authenticated
      ? "Frontend Provider 由当前浏览器直连；对话与草稿保存在本机，登录后可启用个人同步仓库。"
      : provider()?.connection.type === "frontend"
      ? "Frontend Provider 由当前浏览器直连；对话记录按当前身份同步。"
      : "Backend Provider 由 Turnfold 服务端直连；对话记录按当前身份保存在服务端。";
    return `<div class="welcome"><div class="welcome-mark">TF</div><h1>今天想聊什么？</h1><p>${escapeHtml(description)}</p></div>`;
  }
  return messages.map(renderMessage).join("");
}

function activeDraft() {
  return state.workingItems.find((item) => item.id === state.activeDraftId && item.kind === "user-draft") || null;
}

function draftLabel(item: WorkingItem) {
  return item.editSourceMessageId ? "编辑草稿" : "草稿";
}

function workingItemText(item: WorkingItem) {
  return item.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("");
}

function renderWorkingPanel() {
  const drafts = state.workingItems.filter((item) => item.kind === "user-draft");
  const unfinished = state.workingItems.filter((item) => item.kind === "assistant-stream" && item.status !== "streaming");
  const requestAssistantReply = activeDraft()?.requestAssistantReply ?? true;
  const assistantReplyToggle = state.advancedActions
    ? `<label class="assistant-reply-toggle"><input type="checkbox" data-action="request-assistant-reply"${requestAssistantReply ? " checked" : ""}>需要回答</label>`
    : "";
  const draftRows = drafts.map((item) => {
    const text = workingItemText(item).trim().replace(/\s+/g, " ");
    return `<div class="draft-row${item.id === state.activeDraftId ? " active" : ""}"><button type="button" data-action="select-draft" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(text.slice(0, 36) || "空白草稿")}</strong><small>${draftLabel(item)} · ${new Date(item.updatedAt).toLocaleString()}</small></button><button type="button" data-action="delete-working" data-id="${escapeHtml(item.id)}" aria-label="删除草稿">${icons.trash}</button></div>`;
  }).join("");
  const unfinishedRows = unfinished.map((item) => {
    const text = workingItemText(item).trim().replace(/\s+/g, " ");
    return `<div class="unfinished-row"><span><strong>未完成回答</strong><small>${escapeHtml(text.slice(0, 64) || "尚未输出正文")} · ${new Date(item.updatedAt).toLocaleString()}</small></span><button type="button" data-action="commit-partial" data-id="${escapeHtml(item.id)}">保留</button><button type="button" data-action="delete-working" data-id="${escapeHtml(item.id)}">清理</button></div>`;
  }).join("");
  return `<div class="working-panel">${assistantReplyToggle}${renderComposerControls(activeDraft())}${unfinishedRows ? `<details class="unfinished-menu"><summary>未完成 ${unfinished.length}</summary><div>${unfinishedRows}</div></details>` : ""}<details class="draft-menu"><summary>草稿 ${drafts.length}</summary><div><button class="new-draft" type="button" data-action="new-draft">${icons.plus}新草稿</button>${draftRows}</div></details></div>`;
}

function replyTargetLabel(message: StoredChatMessage) {
  const role = message.role === "assistant" ? "助手" : message.role === "user" ? "用户" : "系统";
  const text = messagePartText(message, "text").replace(/\s+/g, " ").trim();
  const partial = message.completion.status === "partial" ? " · 未完成" : "";
  return `${role}${partial} · ${text.slice(0, 48) || "空消息"}`;
}

function renderComposerControls(draft: WorkingItem | null) {
  const messages = displayedMessages();
  const targetId = draft ? draft.observedHeadId : messages.at(-1)?.id || null;
  const target = targetId ? knownMessageMap().get(targetId) : null;
  const latestId = messages.at(-1)?.id || null;
  const showReplyContext = Boolean(draft && !draft.editSourceMessageId && targetId !== latestId);
  const replyContext = showReplyContext
    ? `<div class="reply-context" aria-label="指定回复目标"><span class="reply-context-icon" title="回复到" aria-hidden="true">${icons.reply}</span><button type="button" data-action="jump-reply-target" data-id="${escapeHtml(targetId || "__root__")}" aria-label="跳转到回复目标：${escapeHtml(target ? replyTargetLabel(target) : "会话开头")}">${escapeHtml(target ? replyTargetLabel(target) : "会话开头")}</button><button class="reply-cancel" type="button" data-action="cancel-reply-target" aria-label="取消指定回复目标">${icons.close}</button></div>`
    : "";
  const incompleteControl = target?.completion.status === "partial"
    ? `<label>未完成消息<select data-action="incomplete-target-action"><option value="append"${draft?.incompleteTargetAction !== "interrupt" ? " selected" : ""}>排在它下面</option><option value="interrupt"${draft?.incompleteTargetAction === "interrupt" ? " selected" : ""}>中断并替换它</option></select></label>`
    : "";
  return `<div class="composer-controls">${replyContext}${incompleteControl}</div>`;
}

function updateComposerControls() {
  const controls = root.querySelector<HTMLElement>(".composer-controls");
  if (controls) controls.outerHTML = renderComposerControls(activeDraft());
}

function renderBranchPreviewNotice() {
  if (!state.previewHeadId || state.previewHeadId === state.conversation?.headMessageId) return "";
  return `<div class="branch-preview-notice"><span>正在查看非当前分支</span><div><button type="button" data-action="leave-branch-preview">返回当前分支</button><button type="button" data-action="confirm-branch-preview">将当前会话切换到这里</button></div></div>`;
}

function renderThread() {
  const draft = activeDraft();
  const editing = Boolean(draft?.editSourceMessageId);
  const editRole = draft?.messageRole === "assistant" ? "助手回答" : "用户消息";
  const fullscreen = state.composerFullscreen;
  const queued = draft?.id === state.queuedDraftId;
  const note = queued ? "已排队；会在当前回答完成后提交。" : state.offline ? "离线模式：提交保存在本地仓库，联网后自动 push。" : "草稿自动保存在此浏览器；模型可能会出错。";
  const editorLabel = editing ? `正在编辑${editRole}` : "全屏编辑";
  const fullscreenHeader = fullscreen
    ? `<header class="fullscreen-editor-header"><span><strong>${editorLabel}</strong><small>草稿自动保存在此浏览器</small></span><button type="button" data-action="toggle-composer-fullscreen" aria-label="退出全屏编辑" title="退出全屏编辑（Esc）">${icons.close}</button></header>`
    : "";
  const placeholder = fullscreen
    ? editing ? "编辑消息；Ctrl/⌘ + Enter 提交" : "输入消息；Ctrl/⌘ + Enter 提交"
    : editing ? "编辑消息，提交后从此处继续" : "输入消息，Enter 发送，Shift + Enter 换行";
  return `<section class="thread-root"><div class="thread-viewport" id="thread-viewport">${renderBranchPreviewNotice()}<div id="message-list">${renderMessagesMarkup()}</div><div class="thread-footer${fullscreen ? " fullscreen-editor" : ""}">${fullscreenHeader}<button class="scroll-button" type="button" data-action="scroll-bottom" aria-label="滚动到底部">${icons.scroll}</button>${renderWorkingPanel()}${editing ? `<div class="edit-context"><span>正在编辑${editRole}；提交后当前会话将从这里继续</span><button type="button" data-action="cancel-edit">取消</button></div>` : ""}<form class="composer" id="composer"><textarea class="composer-input" name="message" placeholder="${placeholder}" rows="1" aria-label="聊天消息">${escapeHtml(draft ? workingItemText(draft) : "")}</textarea><div class="composer-actions">${state.streaming ? `<button class="stop-button" type="button" data-action="stop" aria-label="停止生成">${icons.stop}</button>` : ""}<button class="fullscreen-button" type="button" data-action="toggle-composer-fullscreen" aria-label="${fullscreen ? "退出全屏编辑" : "进入全屏编辑"}" title="${fullscreen ? "退出全屏编辑" : "全屏编辑"}">${fullscreen ? icons.collapse : icons.expand}</button></div>${renderModelPicker()}<button class="send-button" type="submit" data-action="send" aria-label="${state.streaming ? "排队发送" : "发送消息"}">${icons.send}</button></form><p class="composer-note${state.offline ? " offline" : ""}${queued ? " queued" : ""}">${note}</p></div></div></section>`;
}

function setComposerFullscreen(fullscreen: boolean) {
  const currentInput = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  const selectionStart = currentInput?.selectionStart ?? 0;
  const selectionEnd = currentInput?.selectionEnd ?? selectionStart;
  state.composerFullscreen = fullscreen;
  renderApp();
  window.requestAnimationFrame(() => {
    const nextInput = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    if (nextInput && !fullscreen) {
      nextInput.style.height = "auto";
      nextInput.style.height = `${Math.min(nextInput.scrollHeight, 180)}px`;
    }
    nextInput?.focus();
    nextInput?.setSelectionRange(selectionStart, selectionEnd);
  });
}

function syncIndicatorTitle() {
  if (!state.authenticated) return state.offline
    ? "当前离线；数据安全保存在当前浏览器"
    : "本地模式：数据仅保存在当前浏览器；后端可用时自动启用登录与同步";
  const last = state.lastFetchAt ? new Date(state.lastFetchAt).toLocaleString() : "从未完成 fetch";
  if (state.offline) return `当前离线；本地更改安全保存在浏览器中 · 上次完成：${last}`;
  if (state.syncing) return `正在 fetch · 上次完成：${last}`;
  if (state.syncError) return `本地更改安全保存在浏览器中 · ${state.syncError} · 上次完成：${last}`;
  if (!state.initialFetchComplete) return `尚未完成首次 fetch · 上次完成：${last}`;
  return `上次 fetch：${last}`;
}

function syncIndicatorState() {
  if (!state.authenticated) return {className: state.offline ? "offline" : "local", label: state.offline ? "离线" : "本地"};
  if (state.offline) return {className: "offline", label: "离线"};
  if (state.syncing) return {className: "fetching", label: "同步中"};
  if (state.syncError) return {className: "error", label: "待同步"};
  if (!state.initialFetchComplete) return {className: "fetching", label: "未 fetch"};
  return {className: "synced", label: "已同步"};
}

function updateSyncIndicator() {
  const indicator = root.querySelector<HTMLElement>(".identity-sync-control");
  if (!indicator) return;
  const visual = syncIndicatorState();
  indicator.className = `identity-sync-control ${visual.className}`;
  indicator.title = syncIndicatorTitle();
  indicator.setAttribute("aria-label", state.authenticated ? `打开我的账户；${visual.label}` : `${visual.label}仓库`);
  const label = indicator.querySelector<HTMLElement>(".identity-sync-label");
  if (label) label.textContent = visual.label;
}

function renderIdentitySyncControl(profile: ChatProfile) {
  const visual = syncIndicatorState();
  const title = syncIndicatorTitle();
  const href = state.authenticated ? state.accountUrl : "";
  const ariaLabel = state.authenticated ? `打开我的账户；${visual.label}` : `${visual.label}仓库`;
  const identity = state.authenticated
    ? `<span class="identity-sync-avatar"><img class="header-avatar" src="${avatarPlaceholder(profile)}" alt="${escapeHtml(profile.name || profile.username)} 的头像" referrerpolicy="no-referrer"><i class="identity-sync-status" aria-hidden="true"></i></span>`
    : `<span class="identity-sync-avatar identity-sync-local" aria-hidden="true">${icons.offline}<i class="identity-sync-status"></i></span>`;
  const content = `${identity}<span class="identity-sync-label">${escapeHtml(visual.label)}</span>`;
  return href
    ? `<a class="identity-sync-control ${visual.className}" href="${escapeHtml(href)}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(title)}">${content}</a>`
    : `<span class="identity-sync-control ${visual.className}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(title)}">${content}</span>`;
}

function renderApp() {
  clearMathTypesetting(root);
  if (state.error) {
    root.innerHTML = `<main class="state-page"><div class="state-card"><span class="state-mark">!</span><h1>聊天服务暂时不可用</h1><p>${escapeHtml(state.error)}</p>${renderProviderSettings()}</div></main>`;
    return;
  }
  if (state.loading || !state.config || !provider() || !state.conversation) {
    root.innerHTML = '<main class="state-page"><div class="state-card"><span class="loader"></span><p>正在读取聊天历史与 Provider Registry…</p></div></main>';
    return;
  }
  const profile = state.config.profile;
  root.innerHTML = `<main class="app-shell with-history${state.historyOpen ? " history-open" : ""}"><header class="app-header"><div class="header-leading"><button class="history-toggle" type="button" data-action="toggle-history" aria-label="聊天历史">${icons.history}</button></div><div class="brand"><a class="portal-home-link" href="${escapeHtml(homeUrl)}" aria-label="Turnfold 主页" title="Turnfold"><img src="${appUrl("/favicon.svg")}" alt=""></a></div><div class="chat-controls">${renderIdentitySyncControl(profile)}</div></header>${renderHistory()}${renderThread()}${renderImportPanel()}${renderSettingsPage()}</main>`;
  scheduleMathTypesetting(root);
  void updateAvatar();
}

function renderMessages(scroll = false) {
  const list = root.querySelector<HTMLElement>("#message-list");
  if (!list) {
    renderApp();
    return;
  }
  const viewport = root.querySelector<HTMLElement>("#thread-viewport");
  const wasAtBottom = isViewportAtBottom(viewport);
  const previousScrollTop = viewport?.scrollTop || 0;
  const reasoningOpenStates = captureReasoningOpenStates(list);
  const messages = displayedMessages();
  if (!messages.length) {
    clearMathTypesetting(list);
    list.innerHTML = renderMessagesMarkup();
  } else if (list.querySelector(".welcome")) {
    clearMathTypesetting(list);
    list.innerHTML = renderMessagesMarkup();
    scheduleMathTypesetting(list);
  } else {
    const visibleMessages = messages
      .map((message, index) => ({message, index}))
      .filter(({message}) => message.role === "user" || message.role === "assistant");
    const renderedMessages = Array.from(list.querySelectorAll<HTMLElement>(":scope > article[data-message-id]"));
    const prefixMatches = renderedMessages.every((node, renderedIndex) => node.dataset.messageId === visibleMessages[renderedIndex]?.message.id);
    if (!prefixMatches || renderedMessages.length > visibleMessages.length) {
      clearMathTypesetting(list);
      list.innerHTML = renderMessagesMarkup();
      scheduleMathTypesetting(list);
    } else {
      for (let renderedIndex = renderedMessages.length; renderedIndex < visibleMessages.length; renderedIndex += 1) {
        const {message, index} = visibleMessages[renderedIndex];
        const node = renderedMessageNode(message, index);
        if (node) {
          list.appendChild(node);
          scheduleMathTypesetting(node);
        }
      }
      const last = visibleMessages.at(-1);
      const existingLast = list.lastElementChild;
      if (last?.message.role === "assistant" && existingLast instanceof HTMLElement && existingLast.dataset.messageId === last.message.id) {
        patchAssistantMessage(existingLast, last.message, last.index);
      }
    }
  }
  restoreReasoningOpenStates(list, reasoningOpenStates);
  updateStreamingControls();
  if (scroll) {
    if (wasAtBottom) scrollBottom();
    else if (viewport) viewport.scrollTop = previousScrollTop;
  }
}

function isViewportAtBottom(viewport: HTMLElement | null): boolean {
  if (!viewport) return false;
  return viewport.scrollHeight - viewport.clientHeight <= viewport.scrollTop + 8;
}

function renderedMessageNode(message: StoredChatMessage, index: number): HTMLElement | null {
  const template = document.createElement("template");
  template.innerHTML = renderMessage(message, index);
  const node = template.content.firstElementChild;
  return node instanceof HTMLElement ? node : null;
}

function patchMathBlock(current: HTMLElement, desired: HTMLElement) {
  const currentFragments = new Map(
    Array.from(current.querySelectorAll<HTMLElement>(".math-fragment[data-math-key]"))
      .map((fragment) => [fragment.dataset.mathKey || "", fragment] as const)
  );
  const next = desired.cloneNode(true) as HTMLElement;
  for (const placeholder of next.querySelectorAll<HTMLElement>(".math-fragment[data-math-key]")) {
    const key = placeholder.dataset.mathKey || "";
    const preserved = currentFragments.get(key);
    if (!preserved) continue;
    placeholder.replaceWith(preserved);
    currentFragments.delete(key);
  }
  for (const obsolete of currentFragments.values()) clearMathTypesetting(obsolete);
  current.replaceChildren(...Array.from(next.childNodes));
  current.dataset.renderKey = desired.dataset.renderKey;
  current.dataset.hasMath = desired.dataset.hasMath;
  current.dataset.blockStable = desired.dataset.blockStable;
  current.dataset.blockType = desired.dataset.blockType;
  scheduleMathTypesetting(current);
}

function patchMarkdownContainer(current: HTMLElement, desired: HTMLElement) {
  const currentBlocks = Array.from(current.querySelectorAll<HTMLElement>(":scope > .markdown-block"));
  const desiredBlocks = Array.from(desired.querySelectorAll<HTMLElement>(":scope > .markdown-block"));
  const prefixMatches = currentBlocks.every((block, index) => block.dataset.blockId === desiredBlocks[index]?.dataset.blockId);
  if (!prefixMatches || currentBlocks.length > desiredBlocks.length) {
    clearMathTypesetting(current);
    current.replaceChildren(...desiredBlocks.map((block) => block.cloneNode(true)));
    current.dataset.renderKey = desired.dataset.renderKey;
    markdownRenderMetrics.domBlocksUpdated += desiredBlocks.length;
    scheduleMathTypesetting(current);
    return;
  }

  for (let index = 0; index < desiredBlocks.length; index += 1) {
    const desiredBlock = desiredBlocks[index];
    const currentBlock = currentBlocks[index];
    if (!currentBlock) {
      const appended = desiredBlock.cloneNode(true) as HTMLElement;
      current.appendChild(appended);
      markdownRenderMetrics.domBlocksUpdated += 1;
      scheduleMathTypesetting(appended);
      continue;
    }
    if (currentBlock.dataset.renderKey === desiredBlock.dataset.renderKey) {
      currentBlock.dataset.blockStable = desiredBlock.dataset.blockStable;
      continue;
    }
    markdownRenderMetrics.domBlocksUpdated += 1;
    if (desiredBlock.dataset.hasMath === "1") {
      patchMathBlock(currentBlock, desiredBlock);
    } else {
      clearMathTypesetting(currentBlock);
      currentBlock.innerHTML = desiredBlock.innerHTML;
      currentBlock.dataset.renderKey = desiredBlock.dataset.renderKey;
      currentBlock.dataset.hasMath = desiredBlock.dataset.hasMath;
      currentBlock.dataset.blockStable = desiredBlock.dataset.blockStable;
      currentBlock.dataset.blockType = desiredBlock.dataset.blockType;
      delete currentBlock.dataset.mathRendered;
    }
  }
  current.dataset.renderKey = desired.dataset.renderKey;
}

function patchAssistantMessage(existing: HTMLElement, message: StoredChatMessage, index: number) {
  const next = renderedMessageNode(message, index);
  if (!next) return;
  const existingContent = existing.querySelector<HTMLElement>(".assistant-content");
  const nextContent = next.querySelector<HTMLElement>(".assistant-content");
  if (!existingContent || !nextContent) return;

  const selectors = [".partial-badge", ".message-reasoning", ".aui-md", ".response-loader", ".message-error"];
  const retained = new Set<Element>();
  const changedMathElements = new Set<HTMLElement>();
  let insertionPoint = existingContent.firstElementChild;
  for (const selector of selectors) {
    const desired = nextContent.querySelector<HTMLElement>(`:scope > ${selector}`);
    let current = existingContent.querySelector<HTMLElement>(`:scope > ${selector}`);
    if (!desired) {
      if (current) {
        if (selector === ".aui-md") clearMathTypesetting(current);
        if (current === insertionPoint) insertionPoint = current.nextElementSibling;
        current.remove();
      }
      continue;
    }
    if (!current) {
      current = desired.cloneNode(true) as HTMLElement;
      if (selector === ".aui-md") changedMathElements.add(current);
    } else if (selector === ".message-reasoning") {
      const currentBody = current.querySelector<HTMLElement>(":scope > div");
      const desiredBody = desired.querySelector<HTMLElement>(":scope > div");
      if (currentBody && desiredBody && currentBody.textContent !== desiredBody.textContent) currentBody.textContent = desiredBody.textContent;
    } else if (selector === ".aui-md" && current.dataset.renderKey !== desired.dataset.renderKey) {
      patchMarkdownContainer(current, desired);
    } else if (selector === ".message-error" && current.textContent !== desired.textContent) {
      current.textContent = desired.textContent;
    }
    if (current !== insertionPoint) existingContent.insertBefore(current, insertionPoint);
    insertionPoint = current.nextElementSibling;
    retained.add(current);
  }
  for (const child of Array.from(existingContent.children)) {
    if (!retained.has(child)) child.remove();
  }

  const existingFooter = existing.querySelector<HTMLElement>(".message-footer");
  const nextFooter = next.querySelector<HTMLElement>(".message-footer");
  if (existingFooter && nextFooter && existingFooter.innerHTML !== nextFooter.innerHTML) existingFooter.innerHTML = nextFooter.innerHTML;
  for (const element of changedMathElements) scheduleMathTypesetting(element);
}

function updateStreamingControls() {
  const composer = root.querySelector<HTMLFormElement>("#composer");
  const composerActions = composer?.querySelector<HTMLElement>(".composer-actions") || null;
  const button = root.querySelector<HTMLButtonElement>(".send-button");
  if (button) {
    button.type = "submit";
    button.dataset.action = "send";
    button.setAttribute("aria-label", state.streaming ? "排队发送" : "发送消息");
    button.disabled = false;
    if (button.innerHTML !== icons.send) button.innerHTML = icons.send;
  }
  let stopButton = composer?.querySelector<HTMLButtonElement>(".stop-button") || null;
  if (state.streaming && composer && composerActions && !stopButton) {
    composerActions.insertAdjacentHTML("afterbegin", `<button class="stop-button" type="button" data-action="stop" aria-label="停止生成">${icons.stop}</button>`);
    stopButton = composer.querySelector<HTMLButtonElement>(".stop-button");
  }
  if (!state.streaming) stopButton?.remove();
  root.querySelectorAll<HTMLButtonElement>('[data-action="regenerate-message"]').forEach((button) => {
    button.disabled = state.streaming;
  });
  root.querySelectorAll<HTMLButtonElement>('[data-action="edit-message"]').forEach((button) => {
    button.disabled = state.streaming;
  });
}

function captureReasoningOpenStates(list: HTMLElement) {
  const states = new Map<string, boolean>();
  list.querySelectorAll<HTMLElement>("article[data-message-id] details.message-reasoning").forEach((details) => {
    const article = details.closest<HTMLElement>("article[data-message-id]");
    if (!article) return;
    const id = article.dataset.messageId || "";
    states.set(id, details.hasAttribute("open"));
  });
  return states;
}

function restoreReasoningOpenStates(list: HTMLElement, states: Map<string, boolean>) {
  list.querySelectorAll<HTMLElement>("article[data-message-id] details.message-reasoning").forEach((details) => {
    const article = details.closest<HTMLElement>("article[data-message-id]");
    if (!article) return;
    const id = article.dataset.messageId || "";
    const open = states.get(id);
    if (open === undefined) return;
    if (open) details.setAttribute("open", "open");
    else details.removeAttribute("open");
  });
}

function scheduleMessagesRender(scroll = true) {
  if (state.renderFrame) return;
  state.renderFrame = window.requestAnimationFrame(() => {
    state.renderFrame = 0;
    renderMessages(scroll);
  });
}

function scrollBottom(behavior: ScrollBehavior = "auto") {
  const viewport = root.querySelector<HTMLElement>("#thread-viewport");
  if (viewport) viewport.scrollTo({top: viewport.scrollHeight, behavior});
}

function closeHistoryOnMobile() {
  if (window.matchMedia("(max-width: 680px)").matches) state.historyOpen = false;
}

function providerHeaders(item: ChatProvider, secret: ProviderSecret, initial?: HeadersInit) {
  const headers = new Headers(initial);
  for (const [name, value] of Object.entries(item.headers || {})) headers.set(name, value);
  for (const [name, value] of Object.entries(secret.provider?.headers || {})) headers.set(name, value);
  const apiKey = secret.provider?.apiKey || "";
  if (item.auth.type === "bearer" && apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  if (item.auth.type === "header" && item.auth.header && apiKey) headers.set(item.auth.header, apiKey);
  return headers;
}

function normalizeModels(payload: unknown): ProviderModel[] {
  const root = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const source = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  return source.slice(0, 300).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const model = value as Record<string, unknown>;
    const rawId = model.id || model.name || model.model;
    if (typeof rawId !== "string" || !rawId.trim()) return [];
    const id = rawId.replace(/^models\//, "");
    return [{id, name: typeof model.displayName === "string" ? model.displayName : typeof model.name === "string" ? model.name.replace(/^models\//, "") : id}];
  });
}

async function discoverFrontendProvider(item: ChatProvider, secret: ProviderSecret) {
  const effective = applyBrowserProviderSettings(item, secret) as ChatProvider;
  const providerFetch = createBrowserProviderFetch(effective, secret);
  const response = await providerFetch(effective.discovery.url, {
    headers: providerHeaders(effective, secret, {"Accept": "application/json"}),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => null);
  let models = response.ok ? normalizeModels(payload) : [];
  if (effective.id === "llama.cpp" && !models.length) {
    const propsUrl = `${effective.connection.baseUrl.replace(/\/v1\/?$/, "")}/props`;
    const props = await providerFetch(propsUrl, {headers: providerHeaders(effective, secret), signal: AbortSignal.timeout(5000)});
    const value = await props.json() as {model_alias?: string; model_path?: string};
    const id = value.model_alias?.trim() || value.model_path?.split(/[\\/]/).filter(Boolean).at(-1) || effective.defaultModel;
    if (props.ok) models = [{id, name: id}];
  }
  if (!response.ok && !models.length) throw new Error(`Provider HTTP ${response.status}`);
  return {...effective, models, modelDiscoveryError: undefined};
}

async function parseLines(response: Response, onLine: (line: string) => void | Promise<void>) {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {error?: string} | null;
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Streaming response body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const {done, value} = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {stream: !done});
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) await onLine(line.trim());
    if (done) break;
  }
  if (buffer.trim()) await onLine(buffer.trim());
}

async function streamBackend(messages: StoredChatMessage[], onEvent: (event: StreamEvent) => void, signal: AbortSignal, context?: StreamRequestContext) {
  const item = context?.provider || provider()!;
  const credential = item.credentials.find((value) => value.name === "default") || item.credentials[0];
  if (!credential) throw new Error(`请先在 Key Vault 中配置 ${item.name}`);
  const response = await fetch(appUrl("/api/chat"), {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({conversationId: context?.conversationId || state.conversation!.id, providerId: item.id, credentialName: credential.name, model: context?.model || state.model, generationSettings: context?.generationSettings || state.generationSettings, messages}),
    signal
  });
  await parseLines(response, (line) => onEvent(JSON.parse(line) as StreamEvent));
}

async function streamFrontend(messages: StoredChatMessage[], onEvent: (event: StreamEvent) => void, signal: AbortSignal, context?: StreamRequestContext) {
  const item = context?.provider || provider()!;
  if (item.api !== "openai-completions") throw new Error(`Frontend Provider 暂不支持 ${item.api}`);
  const credential = localCredential(item.id);
  const secret = credential?.secret || {};
  const effective = applyBrowserProviderSettings(item, secret) as ChatProvider;
  const providerFetch = createBrowserProviderFetch(effective, secret);
  const startedAt = performance.now();
  let outputTokens: number | null = null;
  let responseText = "";
  const response = await providerFetch(`${effective.connection.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: providerHeaders(effective, secret, {"Content-Type": "application/json", "Accept": "text/event-stream"}),
    body: JSON.stringify({
      model: context?.model || state.model,
      messages: messages.filter((message) => message.role !== "system" || messagePartText(message, "text")).map((message) => ({role: message.role, content: messagePartText(message, "text")})),
      stream: true,
      stream_options: {include_usage: true},
      ...((context?.generationSettings || state.generationSettings).temperature !== null ? {temperature: (context?.generationSettings || state.generationSettings).temperature} : {}),
      ...((context?.generationSettings || state.generationSettings).maxOutputTokens !== null ? {max_tokens: (context?.generationSettings || state.generationSettings).maxOutputTokens} : {}),
      ...(!["auto", "none"].includes((context?.generationSettings || state.generationSettings).reasoning) ? {reasoning_effort: (context?.generationSettings || state.generationSettings).reasoning} : {})
    }),
    signal
  });
  await parseLines(response, (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const payload = JSON.parse(data) as {choices?: Array<{delta?: {content?: string; reasoning?: string; reasoning_content?: string}}>; usage?: {completion_tokens?: number; output_tokens?: number}};
    const delta = payload.choices?.[0]?.delta;
    if (delta?.reasoning_content || delta?.reasoning) onEvent({type: "reasoning-delta", text: delta.reasoning_content || delta.reasoning});
    if (delta?.content) {
      responseText += delta.content;
      onEvent({type: "text-delta", text: delta.content});
    }
    const reported = payload.usage?.completion_tokens ?? payload.usage?.output_tokens;
    if (typeof reported === "number") outputTokens = reported;
  });
  onEvent({type: "finish", metadata: responseMetadata(item.id, context?.model || state.model, startedAt, outputTokens, outputTokens === null ? estimateFrontendOutputTokens(responseText) : undefined)});
}

async function generateConversationTitle(conversation: Conversation, item: ChatProvider, model: string) {
  if (titleGenerationConversationIds.has(conversation.id)) return;
  titleGenerationConversationIds.add(conversation.id);
  try {
    const timestamp = messageNow();
    const promptMessage: StoredChatMessage = {
      id: uuid(),
      parentMessageId: null,
      role: "user",
      parts: [{type: "text", text: conversationTitlePrompt(conversation.messages)}],
      origin: {type: "system", source: "conversation-title"},
      completion: {status: "complete"},
      createdAt: timestamp,
      completedAt: timestamp
    };
    const generationSettings: GenerationSettings = {reasoning: "none", showReasoningSummary: false, temperature: 0.2, maxOutputTokens: 48};
    const context: StreamRequestContext = {provider: item, model, conversationId: conversation.id, generationSettings};
    let output = "";
    const onEvent = (event: StreamEvent) => {
      if (event.type === "text-delta" && event.text) output += event.text;
      if (event.type === "error") throw new Error(event.error || "标题生成失败");
    };
    const signal = AbortSignal.timeout(30000);
    if (item.connection.type === "backend") await streamBackend([promptMessage], onEvent, signal, context);
    else await streamFrontend([promptMessage], onEvent, signal, context);
    const generated = normalizeGeneratedConversationTitle(output);
    if (!generated) return;
    const current = await getConversationHistory(conversation.id);
    if (current.name) return;
    const name = nextAvailableConversationName(generated);
    const updated = await updateConversationHistory(current.id, current.providerId, current.model, current.generationSettings, name);
    if (state.conversation?.id === updated.id) state.conversation = updated;
    await refreshConversations();
    const historyList = root.querySelector<HTMLElement>(".history-list");
    if (historyList) historyList.innerHTML = renderHistoryItems();
    scheduleRepositorySync();
  } catch (error) {
    console.warn("Unable to generate conversation title", error);
  } finally {
    titleGenerationConversationIds.delete(conversation.id);
  }
}

async function refreshConversations() {
  state.conversations = await listConversationHistory();
}

function scheduleRepositorySync(delay = 50) {
  if (!state.authenticated) return;
  state.syncRequested = true;
  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => void synchronizeRepository(), delay);
}

async function synchronizeRepository() {
  if (!state.authenticated) return;
  if (state.syncing || !navigator.onLine) {
    if (!navigator.onLine) {
      state.offline = true;
      state.syncError = "当前离线，等待下次 fetch";
      updateSyncIndicator();
    }
    return;
  }
  state.syncRequested = false;
  state.syncing = true;
  state.syncError = "";
  updateSyncIndicator();
  try {
    const result = await synchronizeConversationRepository();
    state.lastFetchAt = result.fetchedAt;
    state.initialFetchComplete = true;
    state.offline = false;
    state.syncError = result.conflicts ? `${result.conflicts} 个会话发生分叉，本地 head 已保留` : "";
    state.conversations = result.summaries;
    state.messageGraph = await listCachedMessages();
    if (!state.streaming && state.conversation && state.conversations.some((item) => item.id === state.conversation!.id)) {
      state.conversation = await getConversationHistory(state.conversation.id);
      renderMessages(true);
      const historyList = root.querySelector<HTMLElement>(".history-list");
      if (historyList) historyList.innerHTML = renderHistoryItems();
    }
  } catch (error) {
    state.offline = !navigator.onLine;
    state.syncError = error instanceof Error ? error.message : "Fetch failed";
  } finally {
    state.syncing = false;
    updateSyncIndicator();
    if (state.syncRequested) scheduleRepositorySync();
  }
}

function messageNow() {
  return new Date().toISOString();
}

async function immutableMessage(input: Pick<StoredChatMessage, "parentMessageId" | "role" | "parts" | "origin" | "completion"> & {metadata?: StoredChatMessage["metadata"]}) {
  const timestamp = messageNow();
  return createMessageObject({...input, createdAt: timestamp, completedAt: timestamp}, state.identityKey);
}

async function loadConversationWorkingItems(conversationId: string) {
  state.messageGraph = await listCachedMessages();
  state.workingItems = await listWorkingItems(conversationId);
  for (const item of state.workingItems) {
    if (item.kind === "assistant-stream" && item.status === "streaming") {
      item.status = "interrupted";
      item.failureReason = "connection-lost";
      await saveWorkingItem(item);
    }
  }
  const drafts = state.workingItems.filter((item) => item.kind === "user-draft");
  if (!drafts.some((item) => item.id === state.activeDraftId)) state.activeDraftId = drafts[0]?.id || "";
}

async function persistWorkingItem(item: WorkingItem, render = false) {
  item.updatedAt = messageNow();
  await saveWorkingItem(item);
  const index = state.workingItems.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) state.workingItems[index] = item;
  else state.workingItems.unshift(item);
  if (render) renderApp();
}

function newDraftItem(conversationId: string, options: {observedHeadId?: string | null; editSourceMessageId?: string; text?: string; messageRole?: "user" | "assistant"; requestAssistantReply?: boolean} = {}): WorkingItem {
  const timestamp = messageNow();
  return {
    id: uuid(),
    conversationId,
    kind: "user-draft",
    observedHeadId: options.observedHeadId === undefined ? displayedMessages().at(-1)?.id || null : options.observedHeadId,
    ...(options.editSourceMessageId ? {editSourceMessageId: options.editSourceMessageId} : {}),
    messageRole: options.messageRole || "user",
    requestAssistantReply: options.requestAssistantReply ?? true,
    incompleteTargetAction: "append",
    parts: options.text ? [{type: "text", text: options.text}] : [],
    status: "editing",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function editMessage(index: number) {
  if (state.streaming || !state.conversation) return;
  const message = displayedMessages()[index];
  if (!message || (message.role !== "user" && message.role !== "assistant")) return;
  if (message.role === "assistant" && !state.advancedActions) return;
  const existing = state.workingItems.find((item) => item.kind === "user-draft" && item.editSourceMessageId === message.id);
  const draft = existing || newDraftItem(state.conversation.id, {
    observedHeadId: message.parentMessageId,
    editSourceMessageId: message.id,
    text: messagePartText(message, "text"),
    messageRole: message.role,
    requestAssistantReply: message.role !== "assistant"
  });
  state.activeDraftId = draft.id;
  state.composerFullscreen = shouldOpenFullscreenEditor(workingItemText(draft));
  await persistWorkingItem(draft, true);
  const input = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  if (input && !state.composerFullscreen) {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}

async function replyToMessage(index: number) {
  if (!state.conversation) return;
  const message = displayedMessages()[index];
  if (!message) return;
  let draft = activeDraft();
  if (!draft || draft.editSourceMessageId) draft = newDraftItem(state.conversation.id);
  draft.observedHeadId = message.id;
  state.activeDraftId = draft.id;
  await persistWorkingItem(draft, true);
  root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
}

async function cancelReplyTarget() {
  const draft = activeDraft();
  if (!draft || draft.editSourceMessageId) return;
  draft.observedHeadId = displayedMessages().at(-1)?.id || null;
  await persistWorkingItem(draft, true);
  root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
}

function jumpToReplyTarget(messageId: string) {
  const scrollToTarget = () => {
    if (messageId === "__root__") {
      root.querySelector<HTMLElement>("#thread-viewport")?.scrollTo({top: 0, behavior: "smooth"});
      return;
    }
    const target = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    target?.scrollIntoView({behavior: "smooth", block: "center"});
    target?.classList.add("reply-target-pulse");
    if (target) window.setTimeout(() => target.classList.remove("reply-target-pulse"), 900);
  };
  if (messageId !== "__root__" && !root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) && knownMessageMap().has(messageId)) {
    state.previewHeadId = newestBranchTip(messageId);
    renderApp();
    window.requestAnimationFrame(scrollToTarget);
    return;
  }
  scrollToTarget();
}

async function cancelEdit() {
  const draft = activeDraft();
  if (!draft?.editSourceMessageId) return;
  await discardWorkingItem(draft.id);
  state.workingItems = state.workingItems.filter((item) => item.id !== draft.id);
  state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
  state.composerFullscreen = false;
  renderApp();
}

async function createDraft() {
  if (!state.conversation) return;
  const item = newDraftItem(state.conversation.id);
  state.activeDraftId = item.id;
  await persistWorkingItem(item, true);
  root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
}

async function ensureActiveDraft() {
  let draft = activeDraft();
  if (draft) return draft;
  draft = newDraftItem(state.conversation!.id);
  state.activeDraftId = draft.id;
  state.workingItems.unshift(draft);
  await persistWorkingItem(draft);
  return draft;
}

async function deleteWorking(id: string) {
  await discardWorkingItem(id);
  state.workingItems = state.workingItems.filter((item) => item.id !== id);
  if (state.activeDraftId === id) {
    state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
    if (!state.activeDraftId) state.composerFullscreen = false;
  }
  renderApp();
}

async function discardWorkingItem(id: string) {
  window.clearTimeout(state.workingSaveTimers.get(id));
  state.workingSaveTimers.delete(id);
  await removeWorkingItem(id);
}

function checkpointWorkingItem(item: WorkingItem) {
  window.clearTimeout(state.workingSaveTimers.get(item.id));
  state.workingSaveTimers.set(item.id, window.setTimeout(() => {
    state.workingSaveTimers.delete(item.id);
    void persistWorkingItem(item).catch((error) => console.error("Unable to checkpoint working item", error));
  }, 300));
}

async function generateAssistant(baseMessages: StoredChatMessage[]) {
  if (!state.conversation) return;
  const responseProvider = provider()!;
  const responseModel = state.model;
  const conversationId = state.conversation.id;
  const baseHeadId = state.conversation.headMessageId;
  const attemptId = uuid();
  const timestamp = messageNow();
  const working: WorkingItem = {
    id: uuid(),
    conversationId,
    kind: "assistant-stream",
    observedHeadId: baseHeadId,
    parts: [],
    status: "streaming",
    attemptId,
    providerId: state.providerId,
    model: state.model,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const assistant: StoredChatMessage = {
    id: working.id,
    parentMessageId: baseHeadId,
    role: "assistant",
    parts: [],
    origin: {type: "model", providerId: state.providerId, model: state.model, attemptId},
    completion: {status: "partial"},
    createdAt: timestamp,
    completedAt: timestamp
  };
  state.conversation!.messages = [...baseMessages, assistant];
  state.streaming = true;
  state.streamController = new AbortController();
  await persistWorkingItem(working);
  renderMessages(true);
  updateComposerControls();
  let text = "";
  let reasoning = "";
  let finished = false;
  let cancelled = false;
  let committedAssistantId = "";
  let titleConversation: Conversation | null = null;
  const onEvent = (event: StreamEvent) => {
    if (event.type === "text-delta" && event.text) text += event.text;
    if (event.type === "reasoning-delta" && event.text) reasoning += event.text;
    assistant.parts = [
      ...(reasoning ? [{type: "reasoning", text: reasoning}] : []),
      ...(text ? [{type: "text", text}] : [])
    ];
    working.parts = assistant.parts;
    if (event.type === "finish" && event.metadata) {
      assistant.metadata = {custom: {response: event.metadata}};
      working.metadata = assistant.metadata;
      finished = true;
      finishingMarkdownMessages.add(assistant.id);
    }
    if (event.type === "error") throw new Error(event.error || "生成失败");
    checkpointWorkingItem(working);
    if (event.type === "finish") renderMessages(true);
    else scheduleMessagesRender();
  };
  try {
    if (provider()!.connection.type === "backend") await streamBackend(baseMessages, onEvent, state.streamController.signal);
    else await streamFrontend(baseMessages, onEvent, state.streamController.signal);
    if (!finished) throw new Error("Provider 未返回完成事件");
    const committedAssistant = await immutableMessage({
      parentMessageId: baseHeadId,
      role: "assistant",
      parts: assistant.parts,
      origin: assistant.origin,
      completion: {status: "complete"},
      metadata: assistant.metadata
    });
    state.conversation = await commitConversationMessage(conversationId, {
      id: committedAssistant.id,
      expectedHeadId: baseHeadId,
      parentMessageId: baseHeadId,
      role: "assistant",
      parts: committedAssistant.parts,
      origin: committedAssistant.origin,
      completion: committedAssistant.completion,
      createdAt: committedAssistant.createdAt,
      completedAt: committedAssistant.completedAt,
      metadata: committedAssistant.metadata,
      providerId: state.providerId,
      model: state.model
    });
    committedAssistantId = committedAssistant.id;
    streamingMarkdownCaches.move(assistant.id, committedAssistantId);
    finishingMarkdownMessages.delete(assistant.id);
    finishingMarkdownMessages.add(committedAssistantId);
    const streamedArticle = root.querySelector<HTMLElement>("#message-list > article.assistant-message:last-child");
    if (streamedArticle?.dataset.messageId === assistant.id) streamedArticle.dataset.messageId = committedAssistantId;
    await removeWorkingItem(working.id);
    state.workingItems = state.workingItems.filter((item) => item.id !== working.id);
    await refreshConversations();
    if (!state.conversation.name) titleConversation = state.conversation;
    scheduleRepositorySync();
  } catch (error) {
    cancelled = state.streamController.signal.aborted;
    working.status = cancelled ? "interrupted" : "failed";
    working.failureReason = cancelled ? "user-cancelled" : navigator.onLine ? "provider-error" : "connection-lost";
    working.parts = [
      ...(reasoning ? [{type: "reasoning", text: reasoning}] : []),
      ...(text ? [{type: "text", text}] : []),
      {type: "error", text: cancelled ? "已停止生成" : error instanceof Error ? error.message : "生成失败"}
    ];
    await persistWorkingItem(working);
    state.conversation!.messages = baseMessages;
  } finally {
    window.clearTimeout(state.workingSaveTimers.get(working.id));
    state.workingSaveTimers.delete(working.id);
    state.streaming = false;
    state.streamController = null;
    if (committedAssistantId) {
      renderMessages(true);
      const historyList = root.querySelector<HTMLElement>(".history-list");
      if (historyList) historyList.innerHTML = renderHistoryItems();
      finishingMarkdownMessages.delete(committedAssistantId);
    } else {
      streamingMarkdownCaches.delete(assistant.id);
      finishingMarkdownMessages.delete(assistant.id);
      renderApp();
    }
    const queuedDraft = state.workingItems.find((item) => item.id === state.queuedDraftId && item.kind === "user-draft");
    let submitQueuedDraft = false;
    if (queuedDraft) {
      if (queuedDraft.observedHeadId === assistant.id) {
        queuedDraft.observedHeadId = committedAssistantId || baseHeadId;
        await persistWorkingItem(queuedDraft);
      }
      submitQueuedDraft = Boolean(committedAssistantId) || cancelled && queuedDraft.incompleteTargetAction === "interrupt";
    }
    state.queuedDraftId = "";
    updateComposerControls();
    updateStreamingControls();
    const composerNote = root.querySelector<HTMLElement>(".composer-note");
    if (composerNote) {
      composerNote.classList.remove("queued");
      composerNote.textContent = state.offline ? "离线模式：提交保存在本地仓库，联网后自动 push。" : "草稿自动保存在此浏览器；模型可能会出错。";
    }
    if (titleConversation) void generateConversationTitle(titleConversation, responseProvider, responseModel);
    if (queuedDraft && submitQueuedDraft) void sendMessage(workingItemText(queuedDraft)).catch(showError);
  }
}

async function sendMessage(text: string) {
  if (!state.conversation || !text.trim()) return;
  const draft = activeDraft();
  if (state.streaming) {
    if (!draft) return;
    state.queuedDraftId = draft.id;
    await persistWorkingItem(draft);
    const activeAssistant = state.conversation.messages.at(-1);
    if (activeAssistant?.role === "assistant" && activeAssistant.completion.status === "partial" && draft.observedHeadId === activeAssistant.id && draft.incompleteTargetAction === "interrupt") {
      state.streamController?.abort();
    }
    const note = root.querySelector<HTMLElement>(".composer-note");
    if (note) {
      note.classList.add("queued");
      note.textContent = draft.incompleteTargetAction === "interrupt" ? "正在中断当前回答；随后会提交草稿。" : "已排队；会在当前回答完成后提交。";
    }
    return;
  }
  const editing = Boolean(draft?.editSourceMessageId);
  const messages = knownMessageMap();
  const selectedTargetId = draft ? draft.observedHeadId : displayedMessages().at(-1)?.id || null;
  const selectedTarget = selectedTargetId ? messages.get(selectedTargetId) : null;
  const parentMessageId = selectedTarget?.completion.status === "partial" && draft?.incompleteTargetAction === "interrupt"
    ? selectedTarget.parentMessageId
    : selectedTargetId;
  if (editing && !messages.has(draft!.editSourceMessageId!)) throw new Error("要编辑的消息已不在本地消息图中");
  if (parentMessageId !== null && !messages.has(parentMessageId)) throw new Error("回复目标已不在本地消息图中");
  state.messageGraph = [...messages.values()];
  if (state.conversation.headMessageId !== parentMessageId) state.conversation = await moveConversationHead(state.conversation.id, parentMessageId);
  state.previewHeadId = "";
  const role = draft?.messageRole || "user";
  const message = await immutableMessage({
    parentMessageId,
    role,
    parts: [{type: "text", text: text.trim()}],
    origin: role === "assistant"
      ? {type: "manual", clientId: window.localStorage.getItem("turnfold-client-id") || "browser", ...(draft?.editSourceMessageId ? {sourceMessageId: draft.editSourceMessageId} : {})}
      : {type: "user", clientId: window.localStorage.getItem("turnfold-client-id") || "browser", ...(draft?.editSourceMessageId ? {sourceMessageId: draft.editSourceMessageId} : {})},
    completion: {status: "complete"}
  });
  const input = root.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  if (input) {
    input.value = "";
    input.style.height = "auto";
  }
  const draftId = draft?.id || "";
  state.conversation = await commitConversationMessage(state.conversation.id, {
    id: message.id,
    expectedHeadId: parentMessageId,
    parentMessageId,
    role,
    parts: message.parts,
    origin: message.origin,
    completion: message.completion,
    createdAt: message.createdAt,
    completedAt: message.completedAt,
    providerId: state.providerId,
    model: state.model
  });
  if (draftId) await discardWorkingItem(draftId);
  state.workingItems = state.workingItems.filter((item) => item.id !== draftId);
  state.activeDraftId = state.workingItems.find((item) => item.kind === "user-draft")?.id || "";
  state.composerFullscreen = false;
  await refreshConversations();
  renderApp();
  scheduleRepositorySync();
  const requestAssistantReply = state.advancedActions
    ? draft?.requestAssistantReply ?? true
    : draft?.messageRole !== "assistant";
  if (requestAssistantReply) await generateAssistant(state.conversation.messages);
}

async function regenerate(index: number) {
  if (state.streaming || !state.conversation) return;
  const visible = displayedMessages();
  const message = visible[index];
  if (!message || message.role !== "assistant") return;
  const base = visible.slice(0, index);
  if (!base.some((item) => item.role === "user")) return;
  const baseHead = base.at(-1)?.id || null;
  state.messageGraph = [...knownMessageMap().values()];
  state.conversation = await moveConversationHead(state.conversation.id, baseHead);
  state.previewHeadId = "";
  await refreshConversations();
  scheduleRepositorySync();
  renderApp();
  await generateAssistant(state.conversation.messages);
}

function nextAvailableConversationName(base: string) {
  const conflicts = (candidate: string) => state.conversations.some((item) => item.name === candidate || item.name.startsWith(`${candidate}/`) || candidate.startsWith(`${item.name}/`));
  if (!conflicts(base)) return base;
  const flattened = base.replaceAll("/", "-");
  let suffix = 2;
  while (conflicts(`${flattened}-${suffix}`)) suffix += 1;
  return `${flattened}-${suffix}`;
}

function validatedConversationName(value: string, excludingId = "") {
  const name = value.trim();
  if (!name || name.length > 300 || name.startsWith("/") || name.endsWith("/") || name.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    window.alert("名称不能为空，不能以 / 开头或结尾，也不能包含空路径、.、.. 或控制字符。");
    return "";
  }
  const conflict = state.conversations.find((item) => item.id !== excludingId && (item.name === name || item.name.startsWith(`${name}/`) || name.startsWith(`${item.name}/`)));
  if (conflict) {
    window.alert(`名称与现有会话“${conflict.name}”重名或存在路径前缀冲突。`);
    return "";
  }
  return name;
}

async function renameConversation(id: string) {
  const target = state.conversations.find((item) => item.id === id);
  if (!target || !state.conversation) return;
  const proposed = window.prompt("重命名会话（不会重命名同路径下的其他会话）：", target.name);
  if (proposed === null) return;
  const name = validatedConversationName(proposed, id);
  if (!name || name === target.name) return;
  const updated = await updateConversationHistory(id, target.providerId, target.model, id === state.conversation.id ? state.generationSettings : (await getConversationHistory(id)).generationSettings, name);
  if (state.conversation.id === id) state.conversation = updated;
  await refreshConversations();
  renderApp();
  scheduleRepositorySync();
}

async function commitPartial(id: string) {
  let item = state.workingItems.find((candidate) => candidate.id === id && candidate.kind === "assistant-stream");
  if (!item || !state.conversation) return;
  let conversation = state.conversation;
  if (conversation.headMessageId !== item.observedHeadId) {
    const name = nextAvailableConversationName(`${conversation.name || untitledConversationLabel}-partial`);
    const baseIndex = conversation.messages.findIndex((message) => message.id === item.observedHeadId);
    const base = baseIndex >= 0 ? conversation.messages.slice(0, baseIndex + 1) : [];
    conversation = await createConversationHistory(item.providerId || state.providerId, item.model || state.model, state.generationSettings, name, item.observedHeadId, base);
  }
  const completion: MessageCompletion = {status: "partial", reason: item.failureReason || "connection-lost"};
  const partial = await immutableMessage({
    parentMessageId: item.observedHeadId,
    role: "assistant",
    parts: item.parts,
    origin: {type: "model", providerId: item.providerId || state.providerId, model: item.model || state.model, attemptId: item.attemptId || item.id},
    completion,
    metadata: item.metadata
  });
  state.conversation = await commitConversationMessage(conversation.id, {
    id: partial.id,
    expectedHeadId: item.observedHeadId,
    parentMessageId: item.observedHeadId,
    role: "assistant",
    parts: partial.parts,
    origin: partial.origin,
    completion,
    createdAt: partial.createdAt,
    completedAt: partial.completedAt,
    metadata: item.metadata,
    providerId: item.providerId || state.providerId,
    model: item.model || state.model
  });
  await removeWorkingItem(item.id);
  state.workingItems = state.workingItems.filter((candidate) => candidate.id !== item.id);
  await refreshConversations();
  updateConversationHash(state.conversation.id, "push");
  renderApp();
  scheduleRepositorySync();
}

async function selectConversation(id: string, navigation: HashNavigationMode = "push") {
  if (state.streaming || !state.config || state.conversation?.id === id) return;
  const selected = await getConversationHistory(id);
  const selectedProvider = state.config.providers.find((item) => item.id === selected.providerId) || state.config.providers[0];
  if (!selectedProvider) return;
  state.conversation = selected;
  state.previewHeadId = "";
  state.composerFullscreen = false;
  state.providerId = selectedProvider.id;
  state.model = selectedProvider.models.some((model) => model.id === selected.model)
    ? selected.model
    : settingsForProvider(selectedProvider).model;
  state.generationSettings = selected.generationSettings;
  await loadConversationWorkingItems(selected.id);
  rememberModel(state.providerId, state.model);
  closeHistoryOnMobile();
  if (navigation !== "none") updateConversationHash(selected.id, navigation);
  renderApp();
}

function switchBranch(messageId: string) {
  if (state.streaming || !knownMessageMap().has(messageId)) return;
  const tip = newestBranchTip(messageId);
  state.previewHeadId = tip === state.conversation?.headMessageId ? "" : tip;
  renderApp();
}

async function confirmBranchPreview() {
  if (!state.conversation || !state.previewHeadId) return;
  state.messageGraph = [...knownMessageMap().values()];
  state.conversation = await moveConversationHead(state.conversation.id, state.previewHeadId);
  state.previewHeadId = "";
  await refreshConversations();
  renderApp();
  scheduleRepositorySync();
}

async function newConversation() {
  const item = provider();
  if (!item || !state.model) return;
  const created = await createConversationHistory(item.id, state.model, state.generationSettings, "");
  state.conversation = created;
  state.workingItems = [];
  state.activeDraftId = "";
  state.composerFullscreen = false;
  state.generationSettings = created.generationSettings;
  await refreshConversations();
  closeHistoryOnMobile();
  updateConversationHash(created.id, "push");
  renderApp();
  scheduleRepositorySync();
}

async function removeConversation(id: string) {
  const target = state.conversations.find((item) => item.id === id);
  if (!target || !window.confirm(`删除会话“${target.name || untitledConversationLabel}”？消息节点仍会保留，直到以后手动清理。`)) return;
  await deleteConversationHistory(id);
  state.conversations = await listConversationHistory();
  if (state.conversation?.id === id) {
    if (state.conversations[0]) await selectConversation(state.conversations[0].id, "replace");
    else await newConversation();
  }
  renderApp();
  scheduleRepositorySync();
}

function chooseModel(providerId: string, model: string) {
  const item = state.config?.providers.find((candidate) => candidate.id === providerId);
  if (!item || !model || !state.conversation) return;
  state.providerId = item.id;
  state.model = model;
  state.conversation = {...state.conversation, providerId: item.id, model};
  state.modelQuery = "";
  window.localStorage.setItem("turnfold-provider", item.id);
  window.localStorage.setItem(`turnfold-model:${item.id}`, model);
  rememberModel(item.id, model);
  scheduleSettingsSave();
  renderApp();
}

function scheduleSettingsSave() {
  window.clearTimeout(state.settingsTimer);
  state.settingsTimer = window.setTimeout(() => {
    if (!state.conversation) return;
    void updateConversationHistory(state.conversation.id, state.providerId, state.model, state.generationSettings)
      .then(() => scheduleRepositorySync())
      .catch((error) => console.error("Unable to save conversation settings", error));
  }, 400);
}

async function configureLocal(providerId: string) {
  const item = state.frontendProviders.find((candidate) => candidate.id === providerId);
  if (!item) return;
  const current = await getLocalCredential(item.id);
  if (item.auth.type === "none") {
    const baseUrl = window.prompt(`${item.name} Base URL：`, current?.secret.provider?.baseUrl || item.connection.baseUrl);
    if (baseUrl === null) return;
    try {
      const parsed = new URL(baseUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    } catch {
      window.alert("Base URL 必须是有效的 http 或 https URL");
      return;
    }
    await saveLocalCredential(item.id, "default", {...current?.secret, provider: {...current?.secret.provider, baseUrl: baseUrl.replace(/\/+$/, "")}});
  } else {
    const apiKey = window.prompt(`${item.name} API Key：`, current?.secret.provider?.apiKey || "");
    if (apiKey === null) return;
    const proxyToken = item.connection.proxy?.type === "relay" ? window.prompt("Relay Token（没有则留空）：", current?.secret.proxy?.token || "") || "" : "";
    await saveLocalCredential(item.id, "default", {provider: {apiKey}, ...(proxyToken ? {proxy: {token: proxyToken}} : {})});
  }
  window.location.reload();
}

async function probeLocal(providerId: string) {
  const item = state.frontendProviders.find((candidate) => candidate.id === providerId);
  if (!item) return;
  try {
    const detected = await discoverFrontendProvider(item, (await getLocalCredential(item.id))?.secret || {});
    state.frontendProviders = state.frontendProviders.map((candidate) => candidate.id === detected.id ? detected : candidate);
    if (state.config) state.config.providers = [...state.config.providers.filter((candidate) => candidate.id !== detected.id), detected];
    window.alert(`探测成功：发现 ${detected.models.length} 个模型`);
    renderApp();
  } catch (error) {
    window.alert(`探测失败：${error instanceof Error ? error.message : "未知错误"}\n\n请确认浏览器已允许当前站点的“本地网络访问”权限。`);
  }
}

async function initializeLocalMode(clientId: string) {
  const profileId = `local:${clientId}`;
  state.authenticated = false;
  state.identityKey = profileId;
  state.syncing = false;
  state.syncRequested = false;
  state.initialFetchComplete = true;
  state.lastFetchAt = "";
  state.syncError = "";
  state.error = "";
  activateOfflineProfile(profileId);

  const fallbackProviders: ChatProvider[] = builtInFrontendProviders.map((item) => ({
    ...item,
    models: [{id: item.defaultModel || "local-model", name: item.defaultModel || "local-model"}]
  }));
  state.frontendProviders = fallbackProviders;
  state.config = {profile: {username: "local", name: "本地用户", email: ""}, providers: fallbackProviders};
  await cacheChatConfig(profileId, {config: state.config, frontendProviders: fallbackProviders});
  state.conversations = await listConversationHistory();
  const hashId = conversationIdFromHash(window.location.hash);
  const summary = state.conversations.find((item) => item.id === hashId) || state.conversations[0];
  const savedProviderId = window.localStorage.getItem("turnfold-provider") || "";
  let selectedProvider = fallbackProviders.find((item) => item.id === summary?.providerId)
    || fallbackProviders.find((item) => item.id === savedProviderId)
    || fallbackProviders[0];
  if (!selectedProvider) throw new Error("没有可用的浏览器本地 Provider");
  if (summary) {
    state.conversation = await getConversationHistory(summary.id);
    selectedProvider = fallbackProviders.find((item) => item.id === state.conversation!.providerId) || selectedProvider;
  } else {
    const selection = settingsForProvider(selectedProvider);
    state.conversation = await createConversationHistory(selectedProvider.id, selection.model, defaultGenerationSettings, "");
    state.conversations = [state.conversation];
  }
  const conversation = state.conversation!;
  state.providerId = selectedProvider.id;
  state.model = selectedProvider.models.some((model) => model.id === conversation.model)
    ? conversation.model
    : settingsForProvider(selectedProvider).model;
  state.generationSettings = conversation.generationSettings;
  await loadConversationWorkingItems(conversation.id);
  rememberModel(state.providerId, state.model);
  updateConversationHash(conversation.id, "replace");
  state.loading = false;
  state.offline = !navigator.onLine;
  renderApp();

  void Promise.all(fallbackProviders.map(async (item) => {
    const credential = state.localCredentials.find((value) => value.providerId === item.id && value.name === "default")
      || state.localCredentials.find((value) => value.providerId === item.id);
    if (!credential) return item;
    try {
      return await discoverFrontendProvider(item, credential?.secret || {});
    } catch (error) {
      return {...item, modelDiscoveryError: error instanceof Error ? error.message : "Model discovery failed"};
    }
  })).then(async (providers) => {
    if (state.authenticated || state.identityKey !== profileId || !state.config) return;
    state.frontendProviders = providers;
    state.config.providers = providers;
    const active = providers.find((item) => item.id === state.providerId);
    if (active?.models.length && !active.models.some((model) => model.id === state.model)) state.model = settingsForProvider(active).model;
    await cacheChatConfig(profileId, {config: state.config, frontendProviders: providers});
    renderApp();
  });
}

async function initialize() {
  if (!window.localStorage.getItem("turnfold-client-id")) window.localStorage.setItem("turnfold-client-id", uuid());
  const clientId = window.localStorage.getItem("turnfold-client-id")!;
  const repositoryId = `local:${clientId}`;
  state.localCredentials = await listLocalCredentials();
  try {
    const recent = JSON.parse(window.localStorage.getItem("turnfold-recent-models") || "[]");
    if (Array.isArray(recent)) state.recentModelKeys = recent.filter((item) => typeof item === "string").slice(0, 20);
  } catch {
    window.localStorage.removeItem("turnfold-recent-models");
  }
  const previouslyActive = await loadCachedChatConfig<CachedChatBootstrap>();
  if (previouslyActive && previouslyActive.profileId !== repositoryId) await mergeOfflineProfiles(previouslyActive.profileId, repositoryId);
  activateOfflineProfile(repositoryId);
  const stored = await loadCachedChatConfig<CachedChatBootstrap>(repositoryId);
  let renderedLocalRepository = false;
  if (stored) {
    state.identityKey = stored.profileId;
    activateOfflineProfile(stored.profileId);
    state.config = stored.config.config;
    state.frontendProviders = stored.config.frontendProviders;
    state.lastFetchAt = stored.lastFetchAt || await cachedLastFetchAt();
    state.conversations = await listConversationHistory();
    const hashId = conversationIdFromHash(window.location.hash);
    const summary = state.conversations.find((item) => item.id === hashId) || state.conversations[0];
    if (summary) {
      const selected = await getConversationHistory(summary.id);
      const selectedProvider = state.config.providers.find((item) => item.id === selected.providerId) || state.config.providers[0];
      if (selectedProvider) {
        state.conversation = selected;
        state.providerId = selectedProvider.id;
        state.model = selectedProvider.models.some((model) => model.id === selected.model) ? selected.model : settingsForProvider(selectedProvider).model;
        state.generationSettings = selected.generationSettings;
        await loadConversationWorkingItems(selected.id);
        rememberModel(state.providerId, state.model);
        updateConversationHash(selected.id, "replace");
        state.loading = false;
        state.syncing = false;
        state.offline = !navigator.onLine;
        renderApp();
        renderedLocalRepository = true;
      }
    } else {
      const savedProviderId = window.localStorage.getItem("turnfold-provider") || "";
      const selectedProvider = state.config.providers.find((item) => item.id === savedProviderId) || state.config.providers[0];
      if (selectedProvider) {
        const selection = settingsForProvider(selectedProvider);
        state.conversation = await createConversationHistory(selectedProvider.id, selection.model, defaultGenerationSettings, "");
        state.conversations = [state.conversation];
        state.providerId = selectedProvider.id;
        state.model = selection.model;
        state.generationSettings = state.conversation.generationSettings;
        state.loading = false;
        state.syncing = false;
        state.offline = !navigator.onLine;
        updateConversationHash(state.conversation.id, "replace");
        renderApp();
        renderedLocalRepository = true;
      }
    }
  }

  // The local repository is the application baseline. A server, when present,
  // enhances this already-rendered state with identity, sync, and backend providers.
  if (!renderedLocalRepository) {
    await initializeLocalMode(clientId);
    renderedLocalRepository = true;
  }

  try {
    const response = await fetch(appUrl("/api/config"), {cache: "no-store", redirect: "manual"});
    if (response.type === "opaqueredirect" || response.status === 0 || response.status === 401 || response.status >= 300 && response.status < 400) {
      return;
    }
    const payload = await response.json() as ServerChatConfig & {error?: string};
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    state.authenticated = true;
    state.accountUrl = payload.accountUrl || "";
    await mergeOfflineProfiles(payload.identityKey, repositoryId);
    state.identityKey = repositoryId;
    activateOfflineProfile(repositoryId);
    const providers = await Promise.all(payload.providers.map(async (item) => {
      if (item.connection.type === "backend") return item;
      const credential = state.localCredentials.find((value) => value.providerId === item.id && value.name === "default") || state.localCredentials.find((value) => value.providerId === item.id);
      if (!credential) return item.auth.type === "none" ? item : {...item, models: []};
      try {
        return await discoverFrontendProvider(item, credential?.secret || {});
      } catch (error) {
        return {...item, models: item.models.length ? item.models : [{id: item.defaultModel || "local-model", name: item.defaultModel || "local-model"}], modelDiscoveryError: error instanceof Error ? error.message : "Model discovery failed"};
      }
    }));
    state.frontendProviders = providers.filter((item) => item.connection.type === "frontend");
    const configured: ChatConfig = {
      profile: payload.profile,
      providers: providers.filter((item) => item.models.length > 0 && (item.connection.type === "backend" ? item.credentials.length > 0 : item.auth.type === "none" || state.localCredentials.some((credential) => credential.providerId === item.id)))
    };
    state.config = configured;
    await cacheChatConfig(repositoryId, {config: configured, frontendProviders: state.frontendProviders});
    state.syncing = true;
    updateSyncIndicator();
    const synchronized = await synchronizeConversationRepository();
    state.lastFetchAt = synchronized.fetchedAt;
    state.initialFetchComplete = true;
    state.syncError = synchronized.conflicts ? `${synchronized.conflicts} 个会话发生分叉，本地 head 已保留` : "";
    state.offline = false;
    state.conversations = synchronized.summaries;
    const hashId = conversationIdFromHash(window.location.hash);
    const selectedId = state.conversation && state.conversations.some((item) => item.id === state.conversation!.id)
      ? state.conversation.id
      : state.conversations.find((item) => item.id === hashId)?.id || state.conversations[0]?.id;
    if (selectedId) {
      const selected = await getConversationHistory(selectedId);
      const selectedProvider = configured.providers.find((item) => item.id === selected.providerId) || configured.providers[0];
      if (!selectedProvider) throw new Error("尚未配置可用的 Provider 凭据");
      state.conversation = selected;
      state.providerId = selectedProvider.id;
      state.model = selectedProvider.models.some((model) => model.id === selected.model) ? selected.model : settingsForProvider(selectedProvider).model;
      state.generationSettings = selected.generationSettings;
      await loadConversationWorkingItems(selected.id);
      rememberModel(state.providerId, state.model);
      updateConversationHash(selected.id, "replace");
    } else {
      const savedProviderId = window.localStorage.getItem("turnfold-provider") || "";
      const selectedProvider = configured.providers.find((item) => item.id === savedProviderId) || configured.providers[0];
      if (!selectedProvider) throw new Error("尚未配置可用的 Provider 凭据");
    const selection = settingsForProvider(selectedProvider);
    state.conversation = await createConversationHistory(selectedProvider.id, selection.model, defaultGenerationSettings, "");
    state.conversations = [state.conversation];
    state.workingItems = [];
    state.activeDraftId = "";
    state.providerId = selectedProvider.id;
    state.model = selection.model;
    state.generationSettings = state.conversation.generationSettings;
      rememberModel(state.providerId, state.model);
      updateConversationHash(state.conversation.id, "replace");
      scheduleRepositorySync();
    }
    state.loading = false;
    state.syncing = false;
    renderApp();
    if (state.syncRequested) scheduleRepositorySync();
  } catch (error) {
    state.syncing = false;
    state.offline = !navigator.onLine;
    state.syncError = state.authenticated ? error instanceof Error ? error.message : "Fetch failed" : "";
    if (!renderedLocalRepository) throw error;
    updateSyncIndicator();
    if (state.syncRequested && navigator.onLine) scheduleRepositorySync(1000);
  }
}

root.addEventListener("submit", (event) => {
  if (!(event.target instanceof HTMLFormElement) || event.target.id !== "composer") return;
  event.preventDefault();
  const input = event.target.elements.namedItem("message");
  if (input instanceof HTMLTextAreaElement) void sendMessage(input.value).catch(showError);
});

root.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.settingsOpen) {
    state.settingsOpen = false;
    state.modelQuery = "";
    renderApp();
    return;
  }
  if (event.key === "Escape" && state.importPanelOpen && !state.importing) {
    state.importPanelOpen = false;
    renderApp();
    return;
  }
  if (event.key === "Escape" && state.composerFullscreen) {
    event.preventDefault();
    setComposerFullscreen(false);
    return;
  }
  if (!(event.target instanceof HTMLTextAreaElement) || event.target.name !== "message") return;
  const fullscreenSubmit = state.composerFullscreen && event.key === "Enter" && (event.ctrlKey || event.metaKey);
  const compactSubmit = !state.composerFullscreen && event.key === "Enter" && !event.shiftKey;
  if (fullscreenSubmit || compactSubmit) {
    event.preventDefault();
    void sendMessage(event.target.value).catch(showError);
  }
});

root.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement && target.name === "message") {
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 180)}px`;
    if (state.conversation) {
      let draft = activeDraft();
      if (!draft) {
        draft = newDraftItem(state.conversation.id);
        state.activeDraftId = draft.id;
        state.workingItems.unshift(draft);
      }
      draft.parts = target.value ? [{type: "text", text: target.value}] : [];
      draft.updatedAt = messageNow();
      checkpointWorkingItem(draft);
    }
  }
  if (target instanceof HTMLInputElement && target.dataset.action === "model-search") {
    state.modelQuery = target.value;
    const details = target.closest("details");
    renderApp();
    const next = root.querySelector<HTMLInputElement>('[data-action="model-search"]');
    const nextDetails = next?.closest("details");
    if (nextDetails) nextDetails.open = true;
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
    if (details?.open && nextDetails) nextDetails.open = true;
  }
  if (target instanceof HTMLInputElement && target.dataset.action === "import-title-template") {
    state.importTitleTemplate = target.value;
    window.localStorage.setItem("turnfold-import-title-template", target.value);
    const preview = importTitleTemplatePreview();
    target.setAttribute("aria-invalid", String(preview.error));
    const output = root.querySelector<HTMLOutputElement>(".session-title-template-preview");
    if (output) {
      output.textContent = preview.text;
      output.classList.toggle("error", preview.error);
    }
  }
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.dataset.action === "advanced-actions" && target instanceof HTMLInputElement) {
    state.advancedActions = target.checked;
    window.localStorage.setItem("turnfold-advanced-actions", target.checked ? "1" : "0");
    renderApp();
    return;
  }
  if (target.dataset.action === "history-tree-setting" && target instanceof HTMLInputElement) {
    state.historyTree = target.checked;
    window.localStorage.setItem("turnfold-history-tree", target.checked ? "1" : "0");
    renderApp();
    return;
  }
  if (target.dataset.action === "session-file" && target instanceof HTMLInputElement) {
    const files = [...(target.files || [])];
    if (files.length) void expandImportFiles(files).then((items) => importSessionFiles(items, `${files.length} 个所选文件`)).catch(showError).finally(() => { target.value = ""; });
    else target.value = "";
    return;
  }
  if (target.dataset.action === "session-archive" && target instanceof HTMLInputElement) {
    const files = [...(target.files || [])];
    if (files.length) void expandImportFiles(files).then((items) => importSessionFiles(items, `${files.length} 个 ZIP 压缩包`)).catch(showError).finally(() => { target.value = ""; });
    else target.value = "";
    return;
  }
  if (target.dataset.action === "session-directory" && target instanceof HTMLInputElement) {
    const files = [...(target.files || [])];
    if (files.length) void expandImportFiles(files).then((items) => importSessionFiles(items, "所选文件夹")).catch(showError).finally(() => { target.value = ""; });
    else target.value = "";
    return;
  }
  if (target.dataset.action === "request-assistant-reply" && target instanceof HTMLInputElement && state.conversation) {
    void ensureActiveDraft().then(async (draft) => {
      draft.requestAssistantReply = target.checked;
      await persistWorkingItem(draft);
    }).catch(showError);
    return;
  }
  if (target.dataset.action === "incomplete-target-action" && target instanceof HTMLSelectElement && state.conversation) {
    void ensureActiveDraft().then(async (draft) => {
      draft.incompleteTargetAction = target.value === "interrupt" ? "interrupt" : "append";
      await persistWorkingItem(draft);
    }).catch(showError);
    return;
  }
  if (!target.dataset.setting) return;
  const key = target.dataset.setting as keyof GenerationSettings;
  if (key === "showReasoningSummary" && target instanceof HTMLInputElement) state.generationSettings.showReasoningSummary = target.checked;
  if (key === "reasoning") state.generationSettings.reasoning = target.value as GenerationSettings["reasoning"];
  if (key === "temperature") state.generationSettings.temperature = target.value === "" ? null : Math.min(2, Math.max(0, Number(target.value)));
  if (key === "maxOutputTokens") state.generationSettings.maxOutputTokens = target.value === "" ? null : Math.min(1_000_000, Math.max(1, Math.floor(Number(target.value))));
  if (state.conversation) state.conversation.generationSettings = {...state.generationSettings};
  scheduleSettingsSave();
});

root.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "open-settings") { state.settingsOpen = true; state.modelQuery = ""; renderApp(); }
  if (action === "close-settings") { state.settingsOpen = false; state.modelQuery = ""; renderApp(); }
  if (action === "scroll-settings-section" && button.dataset.id) scrollSettingsSection(button.dataset.id);
  if (action === "toggle-history") { state.historyOpen = !state.historyOpen; renderApp(); }
  if (action === "close-history") { state.historyOpen = false; renderApp(); }
  if (action === "toggle-history-tree") {
    state.historyTree = !state.historyTree;
    window.localStorage.setItem("turnfold-history-tree", state.historyTree ? "1" : "0");
    renderApp();
  }
  if (action === "import-session") { state.importPanelOpen = true; state.importStatus = ""; renderApp(); }
  if (action === "close-import-panel" && !state.importing && (!(event.target instanceof Element) || !event.target.closest("[data-import-panel]") || button.matches("button"))) { state.importPanelOpen = false; renderApp(); }
  if (action === "choose-session-files") root.querySelector<HTMLInputElement>('[data-action="session-file"]')?.click();
  if (action === "choose-session-archive") root.querySelector<HTMLInputElement>('[data-action="session-archive"]')?.click();
  if (action === "choose-session-directory") void chooseImportDirectory().catch(showError);
  if (action === "export-session" && button.dataset.format) void exportSessions(button.dataset.format as SessionTransferFormat).catch(showError);
  if (action === "new-conversation") void newConversation().catch(showError);
  if (action === "switch-branch" && button.dataset.id) switchBranch(button.dataset.id);
  if (action === "leave-branch-preview") { state.previewHeadId = ""; renderApp(); }
  if (action === "confirm-branch-preview") void confirmBranchPreview().catch(showError);
  if (action === "select-conversation" && button.dataset.id) void selectConversation(button.dataset.id).catch(showError);
  if (action === "rename-conversation" && button.dataset.id) void renameConversation(button.dataset.id).catch(showError);
  if (action === "delete-conversation" && button.dataset.id) void removeConversation(button.dataset.id).catch(showError);
  if (action === "new-draft") void createDraft().catch(showError);
  if (action === "toggle-composer-fullscreen") setComposerFullscreen(!state.composerFullscreen);
  if (action === "cancel-edit") void cancelEdit().catch(showError);
  if (action === "reply-message") void replyToMessage(Number(button.dataset.index)).catch(showError);
  if (action === "cancel-reply-target") void cancelReplyTarget().catch(showError);
  if (action === "jump-reply-target" && button.dataset.id) jumpToReplyTarget(button.dataset.id);
  if (action === "select-draft" && button.dataset.id) {
    state.activeDraftId = button.dataset.id;
    renderApp();
    root.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
  }
  if (action === "delete-working" && button.dataset.id) void deleteWorking(button.dataset.id).catch(showError);
  if (action === "commit-partial" && button.dataset.id) void commitPartial(button.dataset.id).catch(showError);
  if (action === "choose-model" && button.dataset.provider && button.dataset.model) chooseModel(button.dataset.provider, button.dataset.model);
  if (action === "configure-local" && button.dataset.provider) void configureLocal(button.dataset.provider).catch(showError);
  if (action === "probe-local" && button.dataset.provider) void probeLocal(button.dataset.provider).catch(showError);
  if (action === "delete-local" && button.dataset.provider) {
    const item = state.frontendProviders.find((candidate) => candidate.id === button.dataset.provider);
    if (item && window.confirm(`删除此浏览器中的 ${item.name} Credential？`)) void deleteLocalCredential(item.id).then(() => window.location.reload());
  }
  if (action === "reset-settings") { state.generationSettings = {...defaultGenerationSettings}; scheduleSettingsSave(); renderApp(); }
  if (action === "stop") state.streamController?.abort();
  if (action === "scroll-bottom") scrollBottom("smooth");
  if (action === "copy-message") {
    const index = Number(button.dataset.index);
    const message = displayedMessages()[index];
    if (message) void navigator.clipboard.writeText(messagePartText(message, "text")).then(() => {
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1200);
    });
  }
  if (action === "edit-message") void editMessage(Number(button.dataset.index)).catch(showError);
  if (action === "regenerate-message") void regenerate(Number(button.dataset.index)).catch(showError);
});

function showError(error: unknown) {
  window.alert(error instanceof Error ? error.message : "操作失败");
}

window.addEventListener("hashchange", () => {
  const id = conversationIdFromHash(window.location.hash);
  if (id && id !== state.conversation?.id && state.conversations.some((item) => item.id === id)) void selectConversation(id, "none").catch(showError);
});
window.addEventListener("offline", () => {
  state.offline = true;
  state.syncing = false;
  state.syncError = "当前离线，提交保存在本地仓库";
  renderApp();
});
window.addEventListener("online", () => {
  state.offline = false;
  scheduleRepositorySync(0);
  renderApp();
});
window.matchMedia("(min-width: 681px)").addEventListener("change", (event) => { state.historyOpen = event.matches; renderApp(); });
window.addEventListener("pagehide", () => {
  const draft = activeDraft();
  if (draft) void persistWorkingItem(draft);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  const draft = activeDraft();
  if (draft) void persistWorkingItem(draft);
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register(appUrl("/sw.js?v=7"), {scope: `${basePath}/`}).catch((error) => console.error("Unable to register service worker", error));

renderApp();
initialize().catch((error) => {
  state.loading = false;
  state.error = error instanceof Error ? error.message : "配置加载失败";
  renderApp();
});
