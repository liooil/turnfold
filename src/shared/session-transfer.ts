import type {Conversation, StoredChatMessage, WorkingItem} from "./conversation-types";
import {defaultGenerationSettings, normalizeGenerationSettings, type GenerationSettings} from "./generation-settings";

export type SessionTransferFormat = "turnfold" | "codex" | "claude" | "omp";

export type TransferNode = {
  sourceId: string;
  parentSourceId: string | null;
  role: StoredChatMessage["role"];
  parts: StoredChatMessage["parts"];
  createdAt: string;
  completedAt: string;
  completion?: StoredChatMessage["completion"];
  origin?: StoredChatMessage["origin"];
  metadata?: StoredChatMessage["metadata"];
};

export type TransferSession = {
  sourceId: string;
  name: string;
  headSourceId: string | null;
  providerId: string;
  model: string;
  generationSettings: GenerationSettings;
  createdAt: string;
  updatedAt: string;
};

export type TransferDocument = {
  format: SessionTransferFormat;
  sessions: TransferSession[];
  nodes: TransferNode[];
  workingItems?: WorkingItem[];
  /** JSONL 中无法解析而被跳过的行数（容错统计，不影响其余行）。 */
  skippedLines?: number;
  /** 整个文件被主动跳过时的原因（例如 Codex 子 agent 会话）。 */
  skippedReason?: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function isoTimestamp(value: unknown, fallback = new Date().toISOString()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function jsonLines(text: string) {
  const records: JsonRecord[] = [];
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
      else skipped += 1;
    } catch {
      // 容忍损坏/截断的行（例如正在写入的会话文件），统计后跳过，
      // 而不是让整个文件导入失败。
      skipped += 1;
    }
  }
  return {records, skipped};
}

function usageTokens(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.max(0, Math.round(Number(value)));
  return null;
}

function importedUsageMetadata(sourceFormat: "codex" | "claude" | "omp", model: unknown, stopReason: unknown, usage: unknown): StoredChatMessage["metadata"] | undefined {
  const usageRecord = isRecord(usage) ? usage : null;
  const read = (...keys: string[]) => {
    if (!usageRecord) return null;
    for (const key of keys) {
      const value = usageTokens(usageRecord[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const inputTokens = read("input_tokens", "input");
  const outputTokens = read("output_tokens", "output");
  const cacheReadTokens = read("cache_read_input_tokens", "cache_read_tokens", "cacheRead");
  const cacheCreationTokens = read("cache_creation_input_tokens", "cache_creation_tokens", "cacheWrite");
  const totalTokens = read("total_tokens", "totalTokens");
  const usageFields = {
    ...(typeof model === "string" && model ? {model} : {}),
    ...(inputTokens !== null ? {inputTokens} : {}),
    ...(outputTokens !== null ? {outputTokens} : {}),
    ...(cacheReadTokens !== null ? {cacheReadTokens} : {}),
    ...(cacheCreationTokens !== null ? {cacheCreationTokens} : {}),
    ...(totalTokens !== null ? {totalTokens} : {}),
    ...(typeof stopReason === "string" && stopReason ? {stopReason} : {})
  };
  if (!Object.keys(usageFields).length) return undefined;
  return {custom: {imported: {sourceFormat, usage: usageFields}}};
}

function contentParts(value: unknown, textTypes = ["text", "input_text", "output_text"]): StoredChatMessage["parts"] {
  if (typeof value === "string") return value ? [{type: "text", text: value}] : [];
  if (!Array.isArray(value)) return [];
  const parts: StoredChatMessage["parts"] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const type = stringValue(candidate.type);
    if (textTypes.includes(type) && typeof candidate.text === "string") {
      parts.push({type: "text", text: candidate.text});
    } else if (type === "thinking" && typeof candidate.thinking === "string") {
      parts.push({type: "reasoning", text: candidate.thinking, ...(typeof candidate.signature === "string" ? {signature: candidate.signature} : {})});
    } else if (type === "redacted_thinking") {
      // Anthropic 加密思考块：内容不可读，仅保留密文供存档
      parts.push({
        type: "redacted-thinking",
        ...(typeof candidate.data === "string" ? {data: candidate.data} : {}),
        ...(typeof candidate.ciphertext === "string" ? {ciphertext: candidate.ciphertext} : {}),
        ...(typeof candidate.signature === "string" ? {signature: candidate.signature} : {})
      });
    } else if (type === "refusal") {
      parts.push({type: "refusal", ...(typeof candidate.text === "string" ? {text: candidate.text} : {})});
    } else if (type === "image" && isRecord(candidate.source)) {
      const mediaType = stringValue(candidate.source.media_type);
      if (typeof candidate.source.data === "string" && candidate.source.data && mediaType) {
        parts.push({type: "image", data: candidate.source.data, mimeType: mediaType});
      } else if (typeof candidate.source.url === "string" && candidate.source.url) {
        parts.push({type: "image-url", url: candidate.source.url, ...(mediaType ? {mimeType: mediaType} : {})});
      }
    } else if (type === "input_image" && typeof candidate.image_url === "string") {
      parts.push({type: "image-url", url: candidate.image_url, ...(typeof candidate.detail === "string" ? {detail: candidate.detail} : {})});
    } else if (["server_tool_use", "computer_tool_use", "web_search_tool_use"].includes(type)) {
      // Anthropic 服务端工具块，形状与 tool_use 相同
      parts.push({
        type: "tool-call",
        id: stringValue(candidate.id),
        name: stringValue(candidate.name, type === "web_search_tool_use" ? "web_search" : type === "computer_tool_use" ? "computer" : "server"),
        arguments: isRecord(candidate.input) ? candidate.input : {}
      });
    } else if (type === "document" && isRecord(candidate.source)) {
      const name = typeof candidate.title === "string" ? candidate.title : undefined;
      const mimeType = stringValue(candidate.source.media_type);
      if (typeof candidate.source.data === "string" && candidate.source.data) {
        parts.push({type: "file", ...(name ? {name} : {}), ...(mimeType ? {mimeType} : {}), data: candidate.source.data});
      } else if (typeof candidate.source.url === "string" && candidate.source.url) {
        parts.push({type: "file", ...(name ? {name} : {}), ...(mimeType ? {mimeType} : {}), url: candidate.source.url});
      }
    } else if (type === "file" || type === "input_file") {
      // OpenAI Responses 的文件项：file_data 携带 file_id 或 file_url，内容可能不在本地
      const fileData = isRecord(candidate.file_data) ? candidate.file_data : null;
      parts.push({
        type: "file",
        ...(typeof candidate.filename === "string" ? {name: candidate.filename} : {}),
        ...(typeof candidate.file_id === "string" ? {fileId: candidate.file_id} : fileData && typeof fileData.file_id === "string" ? {fileId: fileData.file_id} : {}),
        ...(fileData && typeof fileData.file_url === "string" ? {url: fileData.file_url} : {}),
        ...(typeof candidate.status === "string" ? {status: candidate.status} : {})
      });
    } else if (type === "input_audio" && isRecord(candidate.input_audio)) {
      parts.push({
        type: "audio",
        ...(typeof candidate.input_audio.data === "string" ? {data: candidate.input_audio.data} : {}),
        ...(typeof candidate.input_audio.format === "string" ? {format: candidate.input_audio.format} : {})
      });
    } else if (type === "output_audio") {
      parts.push({
        type: "audio",
        ...(typeof candidate.id === "string" ? {id: candidate.id} : {}),
        ...(typeof candidate.data === "string" ? {data: candidate.data} : {}),
        ...(typeof candidate.transcript === "string" ? {transcript: candidate.transcript} : {})
      });
    } else if (type === "web_search_call") {
      parts.push({type: "web-search-call", ...(typeof candidate.id === "string" ? {id: candidate.id} : {})});
    } else if (type === "web_search_result") {
      parts.push({
        type: "web-search-result",
        ...(typeof candidate.id === "string" ? {id: candidate.id} : {}),
        ...(typeof candidate.title === "string" ? {title: candidate.title} : {}),
        ...(typeof candidate.url === "string" ? {url: candidate.url} : {}),
        ...(typeof candidate.text === "string" ? {text: candidate.text} : {}),
        ...(Array.isArray(candidate.content) ? {content: candidate.content.filter((item): item is JsonRecord => isRecord(item))} : {})
      });
    } else if (type === "context" && isRecord(candidate.document)) {
      // Anthropic context management 的 context 块：保留标题与摘录
      const document = candidate.document;
      const excerpts = Array.isArray(document.excerpts) ? document.excerpts.filter((item): item is JsonRecord => isRecord(item)) : [];
      parts.push({
        type: "context",
        ...(typeof document.title === "string" ? {title: document.title} : {}),
        ...(typeof document.citation === "string" ? {citation: document.citation} : {}),
        ...(excerpts.length ? {excerpts} : {})
      });
    }
  }
  return parts;
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is JsonRecord => isRecord(item) && typeof item.text === "string")
      .map((item) => String(item.text))
      .join("\n");
  }
  return "";
}

// Claude Code 会把过大的工具输出拆成多个同 tool_use_id 的 tool_result 块，
// 这里按 tool_use_id 合并为一个 tool-result part（内容按行连接）。
function mergeToolResultBlocks(blocks: JsonRecord[]): Array<{toolCallId: string; content: string; isError: boolean}> {
  const merged = new Map<string, {toolCallId: string; content: string; isError: boolean}>();
  const order: string[] = [];
  for (const block of blocks) {
    const toolCallId = stringValue(block.tool_use_id);
    if (!toolCallId) continue;
    let entry = merged.get(toolCallId);
    if (!entry) {
      entry = {toolCallId, content: "", isError: false};
      merged.set(toolCallId, entry);
      order.push(toolCallId);
    }
    const text = toolResultText(block.content);
    if (text) entry.content = entry.content ? `${entry.content}\n${text}` : text;
    if (block.is_error === true) entry.isError = true;
  }
  return order.map((toolCallId) => merged.get(toolCallId)!);
}

function firstText(nodes: TransferNode[]) {
  for (const node of nodes) {
    if (node.role !== "user") continue;
    const text = node.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("").trim();
    if (text && !/^<(environment_context|permissions instructions)>/i.test(text) && !/^# AGENTS\.md instructions/i.test(text)) return text.replace(/\s+/g, " ").slice(0, 80);
  }
  return "导入的会话";
}

function newestLeaf(nodes: TransferNode[]) {
  const parents = new Set(nodes.map((node) => node.parentSourceId).filter((id): id is string => Boolean(id)));
  return [...nodes].filter((node) => !parents.has(node.sourceId)).sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0]?.sourceId || nodes.at(-1)?.sourceId || null;
}

function transferNode(sourceId: string, parentSourceId: string | null, role: StoredChatMessage["role"], parts: StoredChatMessage["parts"], timestamp: string, extra: Partial<TransferNode> = {}): TransferNode {
  return {
    sourceId,
    parentSourceId,
    role,
    parts,
    createdAt: timestamp,
    completedAt: timestamp,
    completion: {status: "complete"},
    origin: role === "user" ? {type: "user"} : role === "system" ? {type: "system", source: "session-import"} : {type: "imported"},
    ...extra
  };
}

function parseTurnfold(value: JsonRecord): TransferDocument {
  if (value.type !== "turnfold-archive" || value.version !== 1 || !Array.isArray(value.conversations) || !Array.isArray(value.objects)) {
    throw new Error("不支持的 Turnfold 备份版本");
  }
  const nodes: TransferNode[] = [];
  for (const candidate of value.objects) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !["system", "user", "assistant"].includes(String(candidate.role)) || !Array.isArray(candidate.parts)) continue;
    nodes.push({
      sourceId: candidate.id,
      parentSourceId: typeof candidate.parentMessageId === "string" ? candidate.parentMessageId : null,
      role: candidate.role as StoredChatMessage["role"],
      parts: candidate.parts as StoredChatMessage["parts"],
      origin: isRecord(candidate.origin) ? candidate.origin as StoredChatMessage["origin"] : {type: "imported"},
      completion: isRecord(candidate.completion) ? candidate.completion as StoredChatMessage["completion"] : {status: "complete"},
      createdAt: isoTimestamp(candidate.createdAt),
      completedAt: isoTimestamp(candidate.completedAt, isoTimestamp(candidate.createdAt)),
      ...(isRecord(candidate.metadata) ? {metadata: candidate.metadata as StoredChatMessage["metadata"]} : {})
    });
  }
  const sessions: TransferSession[] = value.conversations.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string") return [];
    return [{
      sourceId: candidate.id,
      name: stringValue(candidate.name),
      headSourceId: typeof candidate.headMessageId === "string" ? candidate.headMessageId : null,
      providerId: stringValue(candidate.providerId, "imported"),
      model: stringValue(candidate.model, "imported"),
      generationSettings: normalizeGenerationSettings(candidate.generationSettings),
      createdAt: isoTimestamp(candidate.createdAt),
      updatedAt: isoTimestamp(candidate.updatedAt)
    }];
  });
  return {format: "turnfold", sessions, nodes, workingItems: Array.isArray(value.workingItems) ? value.workingItems as WorkingItem[] : []};
}

function parseCodex(records: JsonRecord[]): TransferDocument {
  const metadata = records.find((record) => record.type === "session_meta" && isRecord(record.payload));
  const sessionPayload = metadata && isRecord(metadata.payload) ? metadata.payload : {};
  // 子 agent 会话（source.subagent）不导入为独立会话（对应 cc-switch 的过滤策略）
  if (isRecord(sessionPayload.source) && sessionPayload.source.subagent !== undefined) {
    return {format: "codex", sessions: [], nodes: [], skippedReason: "Codex 子 agent 会话，已跳过"};
  }
  const sessionId = stringValue(sessionPayload.id, crypto.randomUUID());
  let model = "codex";
  let name = "";
  let parentSourceId: string | null = null;
  let ordinal = 0;
  const nodes: TransferNode[] = [];
  const canonicalUserText = new Set<string>();
  const canonicalAssistantText = new Set<string>();
  for (const record of records) {
    if (record.type !== "response_item" || !isRecord(record.payload) || record.payload.type !== "message") continue;
    const text = contentParts(record.payload.content).filter((part) => part.type === "text").map((part) => String(part.text || "")).join("");
    if (record.payload.role === "user") canonicalUserText.add(text);
    if (record.payload.role === "assistant") canonicalAssistantText.add(text);
  }
  const pushNode = (role: StoredChatMessage["role"], parts: StoredChatMessage["parts"], timestamp: string, metadata?: StoredChatMessage["metadata"]) => {
    if (!parts.length) return;
    const sourceId = `codex-${sessionId}-${++ordinal}`;
    const node = transferNode(sourceId, parentSourceId, role, parts, timestamp);
    if (metadata) node.metadata = metadata;
    nodes.push(node);
    parentSourceId = sourceId;
  };
  const injectedText = (parts: StoredChatMessage["parts"]) => parts.filter((part) => part.type === "text").map((part) => String(part.text || "")).join("").trim();
  for (const record of records) {
    const timestamp = isoTimestamp(record.timestamp, isoTimestamp(sessionPayload.timestamp));
    if (!isRecord(record.payload)) continue;
    const payload = record.payload;
    if (record.type === "turn_context" && typeof payload.model === "string") model = payload.model;
    if (record.type === "response_item") {
      if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
        const parts = contentParts(payload.content);
        const text = injectedText(parts);
        if (payload.role !== "user" || !/^<(environment_context|permissions instructions)>/i.test(text)) pushNode(payload.role, parts, timestamp, importedUsageMetadata("codex", payload.model, payload.status, payload.usage));
      } else if (payload.type === "message" && payload.role === "developer") {
        // Codex 的 developer 消息（AGENTS.md / 权限注入）映射为 system；
        // 与 user 注入相同的噪音规则过滤，其余内容保留
        const parts = contentParts(payload.content);
        const text = injectedText(parts);
        if (!/^(# AGENTS\.md instructions|<\s*(environment_context|permissions instructions)>)/i.test(text)) pushNode("system", parts, timestamp, importedUsageMetadata("codex", payload.model, payload.status, payload.usage));
      } else if (payload.type === "reasoning") {
        const parts: StoredChatMessage["parts"] = [...(Array.isArray(payload.summary) ? payload.summary : []), ...(Array.isArray(payload.content) ? payload.content : [])]
          .flatMap((item): StoredChatMessage["parts"] => {
            if (!isRecord(item)) return [];
            if (typeof item.text === "string") return [{type: "reasoning", text: item.text}];
            if (item.type === "encrypted_content") {
              return [{type: "redacted-thinking", ...(typeof item.data === "string" ? {data: item.data} : {}), ...(typeof item.ciphertext === "string" ? {ciphertext: item.ciphertext} : {})}];
            }
            return [];
          });
        pushNode("assistant", parts, timestamp);
      } else if (["function_call", "custom_tool_call", "web_search_call", "tool_search_call"].includes(String(payload.type))) {
        const callId = stringValue(payload.call_id, stringValue(payload.id, `call-${ordinal + 1}`));
        const toolName = stringValue(payload.name, payload.type === "web_search_call" ? "web_search" : payload.type === "tool_search_call" ? "tool_search" : "unknown");
        let argumentsValue: unknown = payload.type === "custom_tool_call" ? payload.input : payload.arguments ?? payload.action;
        if (typeof argumentsValue === "string") {
          try { argumentsValue = JSON.parse(argumentsValue); } catch { argumentsValue = {input: argumentsValue}; }
        }
        pushNode("assistant", [{type: "tool-call", id: callId, name: toolName, arguments: isRecord(argumentsValue) ? argumentsValue : {}}], timestamp);
      } else if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(payload.type))) {
        pushNode("assistant", [{type: "tool-result", toolCallId: stringValue(payload.call_id), content: payload.output ?? payload.tools, isError: payload.status === "failed"}], timestamp);
      } else if (payload.type === "local_shell_call") {
        pushNode("assistant", [{type: "tool-call", id: stringValue(payload.call_id, `call-${ordinal + 1}`), name: "local_shell", arguments: {argv: Array.isArray(payload.argv) ? payload.argv : [], ...(typeof payload.cwd === "string" ? {cwd: payload.cwd} : {})}}], timestamp);
      } else if (payload.type === "local_shell_call_output") {
        const output = typeof payload.output === "string" ? payload.output : typeof payload.stdout === "string" ? payload.stdout : typeof payload.stderr === "string" ? payload.stderr : "";
        pushNode("assistant", [{type: "tool-result", toolCallId: stringValue(payload.call_id), content: output, isError: payload.exit_code !== 0 || payload.timed_out === true}], timestamp);
      } else if (payload.type === "web_search_result") {
        const title = typeof payload.title === "string" ? payload.title : "";
        const body = (Array.isArray(payload.content) ? payload.content : [])
          .filter((item): item is JsonRecord => isRecord(item))
          .map((item) => [stringValue(item.title), stringValue(item.content)].filter(Boolean).join("\n"))
          .filter(Boolean)
          .join("\n\n");
        pushNode("assistant", [{type: "tool-result", toolCallId: stringValue(payload.call_id), content: [title, body].filter(Boolean).join("\n\n"), isError: false}], timestamp);
      }
    } else if (record.type === "event_msg") {
      if (payload.type === "thread_name_updated" && typeof payload.thread_name === "string") name = payload.thread_name;
      if (payload.type === "user_message" && typeof payload.message === "string" && !canonicalUserText.has(payload.message)) pushNode("user", [{type: "text", text: payload.message}], timestamp);
      if (payload.type === "agent_message" && typeof payload.message === "string" && !canonicalAssistantText.has(payload.message)) pushNode("assistant", [{type: "text", text: payload.message}], timestamp);
    }
  }
  const createdAt = isoTimestamp(sessionPayload.timestamp, nodes[0]?.createdAt);
  return {
    format: "codex",
    nodes,
    sessions: [{sourceId: sessionId, name: name || firstText(nodes), headSourceId: parentSourceId, providerId: "openai", model, generationSettings: defaultGenerationSettings, createdAt, updatedAt: nodes.at(-1)?.completedAt || createdAt}]
  };
}

function nearestRetainedParent(sourceParentId: string | null, sourceParents: Map<string, string | null>, retained: Map<string, string>) {
  const seen = new Set<string>();
  let cursor = sourceParentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const retainedId = retained.get(cursor);
    if (retainedId) return retainedId;
    cursor = sourceParents.get(cursor) || null;
  }
  return null;
}

function parseClaude(records: JsonRecord[]): TransferDocument {
  const sourceParents = new Map<string, string | null>();
  for (const record of records) if (typeof record.uuid === "string") sourceParents.set(record.uuid, typeof record.parentUuid === "string" ? record.parentUuid : null);
  const retained = new Map<string, string>();
  const nodes: TransferNode[] = [];
  let sessionId = "";
  let name = "";
  let model = "claude";
  const seenMessageNodes = new Map<string, TransferNode>();
  for (const [index, record] of records.entries()) {
    sessionId ||= stringValue(record.sessionId);
    if (record.type === "custom-title") name = stringValue(record.customTitle, name);
    if (record.type === "ai-title" && !name) name = stringValue(record.aiTitle, name);
    if (record.type === "summary" && typeof record.summary === "string" && record.summary.trim()) {
      // /compact 压缩摘要：作为 system 节点插入压缩点，后续消息通过
      // nearestRetainedParent 继续链接到它，保留续聊结构
      const sourceUuid = stringValue(record.uuid, `claude-summary-${index + 1}`);
      nodes.push(transferNode(sourceUuid, nearestRetainedParent(typeof record.parentUuid === "string" ? record.parentUuid : null, sourceParents, retained), "system", [{type: "summary", text: record.summary}], isoTimestamp(record.timestamp)));
      retained.set(sourceUuid, sourceUuid);
      continue;
    }
    if ((record.type !== "user" && record.type !== "assistant") || record.isSidechain === true || record.isMeta === true || !isRecord(record.message)) continue;
    const sourceUuid = stringValue(record.uuid, `claude-line-${index + 1}`);
    let parentSourceId = nearestRetainedParent(typeof record.parentUuid === "string" ? record.parentUuid : null, sourceParents, retained);
    const timestamp = isoTimestamp(record.timestamp);
    const converted: TransferNode[] = [];
    if (record.type === "assistant") {
      const messageId = typeof record.message.id === "string" ? record.message.id : null;
      model = stringValue(record.message.model, model);
      const parts = contentParts(record.message.content);
      if (Array.isArray(record.message.content)) {
        for (const block of record.message.content) {
          if (!isRecord(block) || block.type !== "tool_use") continue;
          parts.push({type: "tool-call", id: stringValue(block.id), name: stringValue(block.name, "unknown"), arguments: isRecord(block.input) ? block.input : {}});
        }
      }
      const metadata = importedUsageMetadata("claude", record.message.model, record.message.stop_reason, record.message.usage);
      if (messageId) {
        const existing = seenMessageNodes.get(messageId);
        if (existing) {
          // 同一 message.id 的后续行是流式重写的完整快照（cc-switch 同样按
          // message.id 去重）：更新已建节点的内容与完成时间，保留最后一行
          existing.parts = parts;
          existing.completedAt = timestamp;
          if (metadata) existing.metadata = metadata;
          continue;
        }
      }
      if (parts.length) {
        const node = transferNode(sourceUuid, parentSourceId, "assistant", parts, timestamp, {metadata});
        if (messageId) seenMessageNodes.set(messageId, node);
        converted.push(node);
      }
    } else {
      const toolResults = Array.isArray(record.message.content) ? record.message.content.filter((block): block is JsonRecord => isRecord(block) && ["tool_result", "server_tool_result", "computer_tool_result", "web_search_tool_result"].includes(String(block.type))) : [];
      if (toolResults.length) {
        for (const result of mergeToolResultBlocks(toolResults)) {
          converted.push(transferNode(`${sourceUuid}-tool-result-${converted.length}`, parentSourceId, "assistant", [{type: "tool-result", toolCallId: result.toolCallId, content: result.content, isError: result.isError}], timestamp));
          parentSourceId = converted.at(-1)!.sourceId;
        }
      } else {
        const parts = contentParts(record.message.content);
        if (parts.length) converted.push(transferNode(sourceUuid, parentSourceId, "user", parts, timestamp));
      }
    }
    for (const node of converted) nodes.push(node);
    const tail = converted.at(-1)?.sourceId;
    if (tail) retained.set(sourceUuid, tail);
  }
  sessionId ||= crypto.randomUUID();
  const createdAt = nodes[0]?.createdAt || new Date().toISOString();
  return {format: "claude", nodes, sessions: [{sourceId: sessionId, name: name || firstText(nodes), headSourceId: newestLeaf(nodes), providerId: "anthropic", model, generationSettings: defaultGenerationSettings, createdAt, updatedAt: nodes.at(-1)?.completedAt || createdAt}]};
}

function ompMessageParts(message: JsonRecord) {
  const parts = contentParts(message.content);
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "toolCall") parts.push({type: "tool-call", id: stringValue(block.id), name: stringValue(block.name, "unknown"), arguments: isRecord(block.arguments) ? block.arguments : {}});
    }
  }
  return parts;
}

function parseOmp(records: JsonRecord[]): TransferDocument {
  const header = records.find((record) => record.type === "session");
  if (!header) throw new Error("OMP JSONL 缺少 session header");
  const titleSlot = records.find((record) => record.type === "title");
  const titleChanges = records.filter((record) => record.type === "title_change");
  const sourceParents = new Map<string, string | null>();
  for (const record of records) if (typeof record.id === "string" && record.type !== "session") sourceParents.set(record.id, typeof record.parentId === "string" ? record.parentId : null);
  const retained = new Map<string, string>();
  const nodes: TransferNode[] = [];
  let model = "omp";
  for (const record of records) {
    if (record.type === "model_change" && typeof record.model === "string") model = record.model.includes("/") ? record.model.slice(record.model.indexOf("/") + 1) : record.model;
    if (record.type !== "message" || typeof record.id !== "string" || !isRecord(record.message)) continue;
    const parentSourceId = nearestRetainedParent(typeof record.parentId === "string" ? record.parentId : null, sourceParents, retained);
    const timestamp = isoTimestamp(record.timestamp);
    const role = record.message.role;
    let parts: StoredChatMessage["parts"] = [];
    if (role === "toolResult") parts = [{type: "tool-result", toolCallId: stringValue(record.message.toolCallId), toolName: stringValue(record.message.toolName, "unknown"), content: record.message.content, isError: record.message.isError === true}];
    else parts = ompMessageParts(record.message);
    if (!parts.length || (role !== "user" && role !== "assistant" && role !== "toolResult")) continue;
    nodes.push(transferNode(record.id, parentSourceId, role === "toolResult" ? "assistant" : role, parts, timestamp, {metadata: importedUsageMetadata("omp", record.message.model, record.message.stopReason, record.message.usage)}));
    retained.set(record.id, record.id);
  }
  const createdAt = isoTimestamp(header.timestamp, nodes[0]?.createdAt);
  const latestTitle = titleChanges.at(-1);
  const name = stringValue(latestTitle?.title, stringValue(titleSlot?.title, stringValue(header.title, firstText(nodes))));
  return {format: "omp", nodes, sessions: [{sourceId: stringValue(header.id, crypto.randomUUID()), name, headSourceId: nodes.at(-1)?.sourceId || null, providerId: model.includes("claude") ? "anthropic" : model.includes("gpt") || model.includes("codex") ? "openai" : "imported", model, generationSettings: defaultGenerationSettings, createdAt, updatedAt: nodes.at(-1)?.completedAt || createdAt}]};
}

export function detectSessionTransferFormat(text: string, filename = ""): SessionTransferFormat {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    // 扫描前若干行而不是只看第一行：Claude Code 文件可能以
    // file-history-snapshot / system / summary 等元记录开头
    const headLines = trimmed.split(/\r?\n/, 12);
    for (const headLine of headLines) {
      if (!headLine.trim()) continue;
      let firstLine: unknown;
      try {
        firstLine = JSON.parse(headLine);
      } catch {
        continue;
      }
      if (!isRecord(firstLine)) continue;
      if (firstLine.type === "turnfold-archive") return "turnfold";
      if (firstLine.type === "session_meta") return "codex";
      if (firstLine.type === "session" || firstLine.type === "title") return "omp";
      if (typeof firstLine.sessionId === "string" || typeof firstLine.uuid === "string" || ["user", "assistant", "custom-title", "ai-title", "system", "summary", "file-history-snapshot"].includes(String(firstLine.type))) return "claude";
    }
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".turnfold.json")) return "turnfold";
  throw new Error("无法识别会话格式；请选择 Turnfold JSON 或 Codex / Claude Code / OMP JSONL");
}

export function parseSessionTransfer(text: string, filename = ""): TransferDocument {
  const format = detectSessionTransferFormat(text, filename);
  if (format === "turnfold") {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error("Turnfold 备份不是 JSON 对象");
    return parseTurnfold(value);
  }
  const {records, skipped} = jsonLines(text);
  if (format === "codex") return {...parseCodex(records), skippedLines: skipped};
  if (format === "claude") return {...parseClaude(records), skippedLines: skipped};
  return {...parseOmp(records), skippedLines: skipped};
}

function nodeTextParts(node: TransferNode) {
  return node.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => ({type: node.role === "assistant" ? "output_text" : "input_text", text: String(part.text)}));
}

function assistantReasoningParts(node: TransferNode) {
  return node.parts.filter((part) => part.type === "reasoning" && typeof part.text === "string").map((part) => String(part.text));
}

function portableUuid(value: string) {
  const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(value);
  return match?.[0] || crypto.randomUUID();
}

function jsonl(records: JsonRecord[]) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function serializeCodex(document: TransferDocument) {
  const session = document.sessions[0];
  if (!session) throw new Error("没有可导出的会话");
  const id = portableUuid(session.sourceId);
  const records: JsonRecord[] = [{type: "session_meta", timestamp: session.createdAt, payload: {id, timestamp: session.createdAt, cwd: "/workspace", originator: "turnfold", cli_version: "1.0.0", source: "cli", model_provider: session.providerId}}];
  records.push({type: "turn_context", timestamp: session.createdAt, payload: {cwd: "/workspace", model: session.model}});
  for (const node of currentPath(document.nodes, session.headSourceId)) {
    const text = nodeTextParts(node);
    if (text.length) records.push({type: "response_item", timestamp: node.createdAt, payload: {type: "message", role: node.role, content: text, ...(node.role === "assistant" ? {phase: "final_answer"} : {})}});
    for (const reasoning of assistantReasoningParts(node)) records.push({type: "response_item", timestamp: node.createdAt, payload: {type: "reasoning", summary: [{type: "summary_text", text: reasoning}]}});
    for (const part of node.parts) {
      if (part.type === "tool-call") records.push({type: "response_item", timestamp: node.createdAt, payload: {type: "function_call", call_id: stringValue(part.id, crypto.randomUUID()), name: stringValue(part.name, "unknown"), arguments: JSON.stringify(isRecord(part.arguments) ? part.arguments : {})}});
      if (part.type === "tool-result") records.push({type: "response_item", timestamp: node.createdAt, payload: {type: "function_call_output", call_id: stringValue(part.toolCallId), output: part.content ?? ""}});
    }
  }
  if (session.name) records.push({type: "event_msg", timestamp: session.updatedAt, payload: {type: "thread_name_updated", thread_name: session.name}});
  return jsonl(records);
}

function claudeContent(node: TransferNode) {
  const content: JsonRecord[] = [];
  for (const part of node.parts) {
    if (part.type === "text" && typeof part.text === "string") content.push({type: "text", text: part.text});
    if (part.type === "reasoning" && typeof part.text === "string") content.push({type: "thinking", thinking: part.text, signature: stringValue(part.signature)});
    if (part.type === "tool-call") content.push({type: "tool_use", id: stringValue(part.id, crypto.randomUUID()), name: stringValue(part.name, "unknown"), input: isRecord(part.arguments) ? part.arguments : {}});
  }
  return content;
}

function serializeClaude(document: TransferDocument) {
  const session = document.sessions[0];
  if (!session) throw new Error("没有可导出的会话");
  const sessionId = portableUuid(session.sourceId);
  const idMap = new Map(document.nodes.map((node) => [node.sourceId, portableUuid(node.sourceId)]));
  const records: JsonRecord[] = [];
  for (const node of document.nodes) {
    const common = {sessionId, uuid: idMap.get(node.sourceId), parentUuid: node.parentSourceId ? idMap.get(node.parentSourceId) || null : null, timestamp: node.createdAt, cwd: "/workspace", version: "2.1.81", gitBranch: ""};
    const toolResults = node.parts.filter((part) => part.type === "tool-result");
    const content = claudeContent(node);
    if (toolResults.length) {
      records.push({...common, type: "user", message: {role: "user", content: toolResults.map((part) => ({type: "tool_result", tool_use_id: stringValue(part.toolCallId), content: part.content ?? "", is_error: part.isError === true}))}});
    } else if (node.role === "user") {
      records.push({...common, type: "user", message: {role: "user", content}});
    } else if (node.role === "assistant" && content.length) {
      records.push({...common, type: "assistant", message: {id: `msg_${idMap.get(node.sourceId)?.replaceAll("-", "")}`, type: "message", role: "assistant", model: session.model, content, stop_reason: "end_turn", stop_sequence: null, usage: {input_tokens: 0, output_tokens: 0}}});
    }
  }
  if (session.name) records.push({type: "custom-title", customTitle: session.name, sessionId});
  return jsonl(records);
}

function ompContent(node: TransferNode) {
  const content: JsonRecord[] = [];
  for (const part of node.parts) {
    if (part.type === "text" && typeof part.text === "string") content.push({type: "text", text: part.text});
    if (part.type === "reasoning" && typeof part.text === "string") content.push({type: "thinking", thinking: part.text});
    if (part.type === "tool-call") content.push({type: "toolCall", id: stringValue(part.id, crypto.randomUUID()), name: stringValue(part.name, "unknown"), arguments: isRecord(part.arguments) ? part.arguments : {}});
  }
  return content;
}

function serializeOmp(document: TransferDocument) {
  const session = document.sessions[0];
  if (!session) throw new Error("没有可导出的会话");
  const idMap = new Map(document.nodes.map((node, index) => [node.sourceId, `xt${(index + 1).toString(36).padStart(6, "0")}`]));
  const records: JsonRecord[] = [{type: "session", version: 3, id: portableUuid(session.sourceId), timestamp: session.createdAt, cwd: "/workspace", title: session.name, titleSource: "user"}];
  let modelParent: string | null = null;
  if (session.model) {
    modelParent = "xtmodel0";
    records.push({type: "model_change", id: modelParent, parentId: null, timestamp: session.createdAt, model: `${session.providerId}/${session.model}`});
  }
  for (const node of document.nodes) {
    const parentId = node.parentSourceId ? idMap.get(node.parentSourceId) || null : modelParent;
    const toolResult = node.parts.find((part) => part.type === "tool-result");
    if (toolResult) {
      records.push({type: "message", id: idMap.get(node.sourceId), parentId, timestamp: node.createdAt, message: {role: "toolResult", toolCallId: stringValue(toolResult.toolCallId), toolName: stringValue(toolResult.toolName, "unknown"), content: toolResult.content ?? "", isError: toolResult.isError === true, timestamp: Date.parse(node.createdAt)}});
    } else {
      records.push({type: "message", id: idMap.get(node.sourceId), parentId, timestamp: node.createdAt, message: {role: node.role, content: ompContent(node), ...(node.role === "assistant" ? {api: "openai-responses", provider: session.providerId, model: session.model, usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, stopReason: "stop"} : {}), timestamp: Date.parse(node.createdAt)}});
    }
  }
  return jsonl(records);
}

export function currentPath(nodes: TransferNode[], headSourceId: string | null) {
  const byId = new Map(nodes.map((node) => [node.sourceId, node]));
  const reversed: TransferNode[] = [];
  const seen = new Set<string>();
  let cursor = headSourceId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    reversed.push(node);
    cursor = node.parentSourceId;
  }
  return reversed.reverse();
}

export function serializeSessionTransfer(document: TransferDocument, format: Exclude<SessionTransferFormat, "turnfold">) {
  if (format === "codex") return serializeCodex(document);
  if (format === "claude") return serializeClaude(document);
  return serializeOmp(document);
}

export function serializeTurnfoldArchive(conversations: Array<Omit<Conversation, "messages"> & {messages?: StoredChatMessage[]}>, objects: StoredChatMessage[], workingItems: WorkingItem[]) {
  return JSON.stringify({
    type: "turnfold-archive",
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations: conversations.map(({messages: _messages, ...conversation}) => conversation),
    objects,
    workingItems
  }, null, 2);
}

export function conversationTransferDocument(conversation: Conversation, nodes: StoredChatMessage[]): TransferDocument {
  return {
    format: "turnfold",
    sessions: [{sourceId: conversation.id, name: conversation.name, headSourceId: conversation.headMessageId, providerId: conversation.providerId, model: conversation.model, generationSettings: conversation.generationSettings, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt}],
    nodes: nodes.map((message) => ({sourceId: message.id, parentSourceId: message.parentMessageId, role: message.role, parts: message.parts, origin: message.origin, completion: message.completion, createdAt: message.createdAt, completedAt: message.completedAt, ...(message.metadata ? {metadata: message.metadata} : {})}))
  };
}
