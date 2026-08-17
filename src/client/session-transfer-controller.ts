import type {Conversation, StoredChatMessage} from "../shared/conversation-types";
import {applyImportTitleTemplate, importFileStem, importSourceFolder} from "../shared/import-title-template";
import {createMessageObject} from "../shared/message-object";
import {
  conversationTransferDocument,
  parseSessionTransfer,
  serializeSessionTransfer,
  serializeTurnfoldArchive,
  type SessionTransferFormat,
  type TransferDocument
} from "../shared/session-transfer";
import type {AppState} from "./app-state";
import {createConversationHistory, getConversationHistory, listConversationHistory} from "./conversation-client";
import {icons} from "./icons";
import {workingItemRepository} from "./repository/repositories";
import {expandImportFiles, filesFromDirectory, type ImportSourceFile} from "./session-files";
import {listCachedConversationRefs, listCachedMessages} from "./storage/offline-history";

type Dependencies = {
  root: HTMLElement;
  escapeHtml: (value: unknown) => string;
  uuid: () => string;
  render: () => void;
  conversationObjects: (conversation: Conversation) => StoredChatMessage[];
  selectConversation: (id: string) => Promise<void>;
  scheduleSync: () => void;
  reportError: (error: unknown) => void;
};

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

export function createSessionTransferController(state: AppState, dependencies: Dependencies) {
  const {root, render} = dependencies;

  async function exportSessions(format: SessionTransferFormat) {
    if (format === "turnfold") {
      const [conversations, objects, workingItems] = await Promise.all([listCachedConversationRefs(), listCachedMessages(), workingItemRepository.list()]);
      downloadText(exportFilename("turnfold-backup", "turnfold.json"), serializeTurnfoldArchive(conversations, objects, workingItems), "application/json");
      return;
    }
    if (!state.conversation) throw new Error("当前没有可导出的会话");
    const document = conversationTransferDocument(state.conversation, dependencies.conversationObjects(state.conversation));
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
          origin: node.origin || (node.role === "user" ? {type: "user", sourceMessageId: sourceId} : {type: "imported"}),
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

  function connectedSourceIds(document: TransferDocument, headSourceId: string | null) {
    if (!headSourceId) return new Set<string>();
    const adjacent = new Map<string, Set<string>>();
    for (const node of document.nodes) {
      if (!node.parentSourceId) continue;
      if (!adjacent.has(node.sourceId)) adjacent.set(node.sourceId, new Set());
      if (!adjacent.has(node.parentSourceId)) adjacent.set(node.parentSourceId, new Set());
      adjacent.get(node.sourceId)!.add(node.parentSourceId);
      adjacent.get(node.parentSourceId)!.add(node.sourceId);
    }
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
      const sessionMessages = [...connectedSourceIds(document, session.headSourceId)]
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
      const created = await createConversationHistory(session.providerId, session.model, session.generationSettings, uniqueImportedName(importedTitle, reservedNames), headMessageId, sessionMessages);
      conversationIds.set(session.sourceId, created.id);
      imported.push(await getConversationHistory(created.id));
    }
    for (const item of document.workingItems || []) {
      const conversationId = conversationIds.get(item.conversationId);
      if (!conversationId) continue;
      await workingItemRepository.save({
        ...item,
        id: dependencies.uuid(),
        conversationId,
        observedHeadId: item.observedHeadId ? mappedIds.get(item.observedHeadId) || null : null,
        ...(item.editSourceMessageId ? {editSourceMessageId: mappedIds.get(item.editSourceMessageId)} : {})
      });
    }
    return imported;
  }

  async function importSessionFiles(files: Iterable<ImportSourceFile>, sourceLabel: string) {
    const candidates = [...files];
    if (!candidates.length) throw new Error("没有找到可导入的 .json 或 .jsonl 会话文件");
    applyImportTitleTemplate(state.importTitleTemplate, {title: "标题", format: "codex", file: "rollout", folder: "sessions", date: "2026-08-13", model: "model", provider: "provider", index: 1});
    state.importing = true;
    state.importStatus = `正在扫描 ${sourceLabel} 中的 ${candidates.length} 个候选文件…`;
    render();
    let imported = 0;
    const formats = new Set<SessionTransferFormat>();
    const failures: string[] = [];
    const skippedFiles: string[] = [];
    let skippedLines = 0;
    const reservedNames = new Set(state.conversations.map((item) => item.name));
    let firstConversationId = "";
    for (const [index, candidate] of candidates.entries()) {
      state.importStatus = `正在导入 ${index + 1} / ${candidates.length}：${candidate.source}`;
      const status = root.querySelector<HTMLElement>(".session-import-status");
      if (status) status.textContent = state.importStatus;
      try {
        const document = parseSessionTransfer(await candidate.file.text(), candidate.file.name);
        formats.add(document.format);
        if (document.skippedReason) {
          skippedFiles.push(`${candidate.source}：${document.skippedReason}`);
          continue;
        }
        skippedLines += document.skippedLines || 0;
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
      if (firstConversationId) await dependencies.selectConversation(firstConversationId);
      if (imported) dependencies.scheduleSync();
      const formatLabel = formats.size ? ` · ${[...formats].join(" / ")}` : "";
      const notes = [
        ...(skippedLines ? [`跳过 ${skippedLines} 行损坏的 JSON`] : []),
        ...(skippedFiles.length ? [`跳过 ${skippedFiles.length} 个子会话`] : []),
        ...(failures.length ? [`跳过 ${failures.length} 个无法识别的文件`] : [])
      ];
      state.importStatus = `已导入 ${imported} 个会话${formatLabel}${notes.length ? `；${notes.join("，")}` : ""}`;
      if (failures.length) state.importStatus += `\n${failures.slice(0, 3).join("\n")}${failures.length > 3 ? `\n另有 ${failures.length - 3} 个…` : ""}`;
    } catch (error) {
      state.importStatus = `导入在保存阶段中断：${error instanceof Error ? error.message : "未知错误"}`;
      throw error;
    } finally {
      state.importing = false;
      render();
    }
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
      render();
      await importSessionFiles(await filesFromDirectory(handle), `文件夹 ${handle.name}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      state.importing = false;
      state.importStatus = `文件夹扫描失败：${error instanceof Error ? error.message : "未知错误"}`;
      render();
      throw error;
    }
  }

  function titleTemplatePreview() {
    try {
      return {text: `预览：${applyImportTitleTemplate(state.importTitleTemplate, {title: "修复登录问题", format: "codex", file: "rollout-123", folder: "sessions", date: "2026-08-13", model: "gpt-5.6-sol", provider: "openai", index: 1})}`, error: false};
    } catch (error) {
      return {text: error instanceof Error ? error.message : "标题模板无效", error: true};
    }
  }

  function renderImportPanel() {
    if (!state.importPanelOpen) return "";
    const disabled = state.importing ? " disabled" : "";
    const preview = titleTemplatePreview();
    const escapeHtml = dependencies.escapeHtml;
    return `<div class="session-import-overlay" role="presentation" data-action="close-import-panel"><section class="session-import-panel" role="dialog" aria-modal="true" aria-labelledby="session-import-title" data-import-panel><header><div><h2 id="session-import-title">导入聊天记录</h2><p>文件只在当前浏览器中读取；不会上传原始文件或申请写权限。</p></div><button type="button" data-action="close-import-panel" aria-label="关闭" title="关闭导入面板"${disabled}>${icons.close}</button></header><div class="session-location-help"><h3>这些文件通常在哪里？</h3><dl><div><dt>Codex CLI</dt><dd><code>~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl</code></dd></div><div><dt>Claude Code</dt><dd><code>~/.claude/projects/&lt;项目&gt;/*.jsonl</code></dd></div><div><dt>OMP</dt><dd><code>~/.omp/agent/sessions/&lt;项目&gt;/*.jsonl</code></dd></div><div><dt>Turnfold</dt><dd>浏览器“下载”目录中的 <code>*.turnfold.json</code></dd></div></dl><p>Windows 中的 <code>~</code> 对应 <code>%USERPROFILE%</code>。如果文件选择器默认隐藏点号目录，可直接输入路径，或先将目录打包为 ZIP。</p></div><label class="session-title-template"><span><strong>会话标题模板</strong><small>使用 <code>/</code> 可生成分组名称</small></span><input type="text" data-action="import-title-template" value="${escapeHtml(state.importTitleTemplate)}" aria-describedby="import-title-template-help" aria-invalid="${preview.error}"${disabled}></label><p class="session-title-template-help" id="import-title-template-help">可用变量：<code>{title}</code> <code>{format}</code> <code>{file}</code> <code>{folder}</code> <code>{date}</code> <code>{model}</code> <code>{provider}</code> <code>{index}</code></p><output class="session-title-template-preview${preview.error ? " error" : ""}">${escapeHtml(preview.text)}</output><div class="session-import-actions"><button type="button" data-action="choose-session-files" title="选择 JSON / JSONL 文件导入"${disabled}>${icons.upload}<span><strong>选择多个文件</strong><small>JSON / JSONL；可一次多选</small></span></button><button type="button" data-action="choose-session-archive" title="选择 ZIP 压缩包并递归查找 JSON / JSONL"${disabled}><span class="format-mark">ZIP</span><span><strong>选择 ZIP 压缩包</strong><small>递归查找其中的 JSON / JSONL</small></span></button><button type="button" data-action="choose-session-directory" title="授权读取文件夹并递归扫描 JSON / JSONL"${disabled}><span class="format-mark">DIR</span><span><strong>授权读取文件夹</strong><small>只读并递归扫描，浏览器会先询问</small></span></button></div>${state.importStatus ? `<pre class="session-import-status" aria-live="polite">${escapeHtml(state.importStatus)}</pre>` : ""}<input type="file" data-action="session-file" accept=".json,.jsonl,application/json,application/x-ndjson" multiple hidden><input type="file" data-action="session-archive" accept=".zip,application/zip" multiple hidden><input type="file" data-action="session-directory" accept=".json,.jsonl,application/json,application/x-ndjson" webkitdirectory directory multiple hidden></section></div>`;
  }

  function handleInput(target: EventTarget | null) {
    if (!(target instanceof HTMLInputElement) || target.dataset.action !== "import-title-template") return false;
    state.importTitleTemplate = target.value;
    window.localStorage.setItem("turnfold-import-title-template", target.value);
    const preview = titleTemplatePreview();
    target.setAttribute("aria-invalid", String(preview.error));
    const output = root.querySelector<HTMLOutputElement>(".session-title-template-preview");
    if (output) {
      output.textContent = preview.text;
      output.classList.toggle("error", preview.error);
    }
    return true;
  }

  function handleFileChange(target: EventTarget | null) {
    if (!(target instanceof HTMLInputElement)) return false;
    const action = target.dataset.action;
    if (!["session-file", "session-archive", "session-directory"].includes(action || "")) return false;
    const files = [...(target.files || [])];
    const label = action === "session-file" ? `${files.length} 个所选文件` : action === "session-archive" ? `${files.length} 个 ZIP 压缩包` : "所选文件夹";
    if (files.length) void expandImportFiles(files).then((items) => importSessionFiles(items, label)).catch(dependencies.reportError).finally(() => { target.value = ""; });
    else target.value = "";
    return true;
  }

  function handleAction(button: HTMLElement, eventTarget: EventTarget | null) {
    const action = button.dataset.action;
    if (action === "import-session") { state.importPanelOpen = true; state.importStatus = ""; render(); }
    else if (action === "close-import-panel" && !state.importing && (!(eventTarget instanceof Element) || !eventTarget.closest("[data-import-panel]") || button.matches("button"))) { state.importPanelOpen = false; render(); }
    else if (action === "choose-session-files") root.querySelector<HTMLInputElement>('[data-action="session-file"]')?.click();
    else if (action === "choose-session-archive") root.querySelector<HTMLInputElement>('[data-action="session-archive"]')?.click();
    else if (action === "choose-session-directory") void chooseImportDirectory().catch(dependencies.reportError);
    else if (action === "export-session" && button.dataset.format) void exportSessions(button.dataset.format as SessionTransferFormat).catch(dependencies.reportError);
    else return false;
    return true;
  }

  return {handleAction, handleFileChange, handleInput, renderImportPanel};
}
