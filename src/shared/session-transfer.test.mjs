import {describe, expect, test} from "bun:test";
import {
  currentPath,
  detectSessionTransferFormat,
  parseSessionTransfer,
  serializeSessionTransfer,
  serializeTurnfoldArchive
} from "./session-transfer.ts";

const lines = (values) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;

describe("session transfer formats", () => {
  test("imports Codex rollout records without duplicate event messages", () => {
    const text = lines([
      {type: "session_meta", timestamp: "2026-08-13T00:00:00Z", payload: {id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"}},
      {type: "turn_context", timestamp: "2026-08-13T00:00:00Z", payload: {model: "gpt-5.6-sol"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:01Z", payload: {type: "message", role: "user", content: [{type: "input_text", text: "hello"}]}},
      {type: "event_msg", timestamp: "2026-08-13T00:00:01Z", payload: {type: "user_message", message: "hello"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:02Z", payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "hi"}]}},
      {type: "event_msg", timestamp: "2026-08-13T00:00:02Z", payload: {type: "agent_message", message: "hi"}}
    ]);
    const parsed = parseSessionTransfer(text, "rollout.jsonl");
    expect(parsed.format).toBe("codex");
    expect(parsed.nodes.map((node) => node.role)).toEqual(["user", "assistant"]);
    expect(parsed.sessions[0].model).toBe("gpt-5.6-sol");
  });

  test("preserves Claude parent branches", () => {
    const text = lines([
      {type: "user", sessionId: "s1", uuid: "u1", parentUuid: null, timestamp: "2026-08-13T00:00:00Z", message: {role: "user", content: "question"}},
      {type: "assistant", sessionId: "s1", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-13T00:00:01Z", message: {role: "assistant", model: "claude-sonnet-4-5", content: [{type: "text", text: "first"}]}},
      {type: "assistant", sessionId: "s1", uuid: "a2", parentUuid: "u1", timestamp: "2026-08-13T00:00:02Z", message: {role: "assistant", model: "claude-sonnet-4-5", content: [{type: "text", text: "second"}]}},
      {type: "custom-title", sessionId: "s1", customTitle: "branched"}
    ]);
    const parsed = parseSessionTransfer(text, "claude.jsonl");
    expect(parsed.nodes.map((node) => node.parentSourceId)).toEqual([null, "u1", "u1"]);
    expect(parsed.sessions[0].headSourceId).toBe("a2");
    expect(parsed.sessions[0].name).toBe("branched");
  });

  test("imports current OMP title slot and tree", () => {
    const text = lines([
      {type: "title", v: 1, title: "OMP task", updatedAt: "2026-08-13T00:00:00Z", pad: ""},
      {type: "session", version: 3, id: "omp-1", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"},
      {type: "message", id: "u1", parentId: null, timestamp: "2026-08-13T00:00:01Z", message: {role: "user", content: [{type: "text", text: "hello"}]}},
      {type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-13T00:00:02Z", message: {role: "assistant", content: [{type: "text", text: "hi"}]}}
    ]);
    const parsed = parseSessionTransfer(text, "omp.jsonl");
    expect(parsed.sessions[0].name).toBe("OMP task");
    expect(currentPath(parsed.nodes, "a1").map((node) => node.sourceId)).toEqual(["u1", "a1"]);
  });

  test("exports parseable Codex, Claude and OMP JSONL", () => {
    const document = {
      format: "turnfold",
      sessions: [{sourceId: "22222222-2222-4222-8222-222222222222", name: "round trip", headSourceId: "a1", providerId: "openai", model: "gpt-5.6", generationSettings: {reasoning: "auto", showReasoningSummary: false, temperature: null, maxOutputTokens: null}, createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:02Z"}],
      nodes: [
        {sourceId: "u1", parentSourceId: null, role: "user", parts: [{type: "text", text: "hello"}], createdAt: "2026-08-13T00:00:01Z", completedAt: "2026-08-13T00:00:01Z"},
        {sourceId: "a1", parentSourceId: "u1", role: "assistant", parts: [{type: "reasoning", text: "brief"}, {type: "text", text: "hi"}], createdAt: "2026-08-13T00:00:02Z", completedAt: "2026-08-13T00:00:02Z"}
      ]
    };
    for (const format of ["codex", "claude", "omp"]) {
      const exported = serializeSessionTransfer(document, format);
      expect(detectSessionTransferFormat(exported)).toBe(format);
      const imported = parseSessionTransfer(exported);
      expect(imported.nodes.some((node) => node.parts.some((part) => part.type === "text" && part.text === "hi"))).toBe(true);
    }
  });

  test("native archive keeps graph objects and working items", () => {
    const text = serializeTurnfoldArchive([
      {id: "c1", name: "native", headMessageId: "m1", providerId: "p", model: "m", messageCount: 1, createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:01Z", generationSettings: {reasoning: "auto", showReasoningSummary: false, temperature: null, maxOutputTokens: null}}
    ], [
      {id: "m1", parentMessageId: null, role: "user", parts: [{type: "text", text: "draft"}], origin: {type: "user"}, completion: {status: "complete"}, createdAt: "2026-08-13T00:00:00Z", completedAt: "2026-08-13T00:00:00Z"}
    ], []);
    const parsed = parseSessionTransfer(text, "backup.turnfold.json");
    expect(parsed.format).toBe("turnfold");
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.nodes).toHaveLength(1);
  });

  test("deduplicates Claude streaming snapshots by message id", () => {
    const text = lines([
      {type: "user", sessionId: "s1", uuid: "u1", parentUuid: null, timestamp: "2026-08-13T00:00:00Z", message: {role: "user", content: "question"}},
      {type: "assistant", sessionId: "s1", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-13T00:00:01Z", message: {id: "msg_1", role: "assistant", model: "claude-sonnet-4-5", content: [{type: "text", text: "hel"}]}},
      {type: "assistant", sessionId: "s1", uuid: "a2", parentUuid: "a1", timestamp: "2026-08-13T00:00:02Z", message: {id: "msg_1", role: "assistant", model: "claude-sonnet-4-5", content: [{type: "text", text: "hello"}]}},
      {type: "assistant", sessionId: "s1", uuid: "a3", parentUuid: "a2", timestamp: "2026-08-13T00:00:03Z", message: {id: "msg_1", role: "assistant", model: "claude-sonnet-4-5", content: [{type: "text", text: "hello world"}], stop_reason: "end_turn", usage: {input_tokens: 5, output_tokens: 11, cache_read_input_tokens: 42}}}
    ]);
    const parsed = parseSessionTransfer(text, "claude.jsonl");
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[1].parts).toEqual([{type: "text", text: "hello world"}]);
    expect(parsed.nodes[1].parentSourceId).toBe("u1");
    // 节点保留首个快照的 sourceId，但其内容/完成时间已更新为最终快照
    expect(parsed.sessions[0].headSourceId).toBe("a1");
    expect(parsed.nodes[1].metadata?.custom?.imported?.usage).toEqual({model: "claude-sonnet-4-5", inputTokens: 5, outputTokens: 11, cacheReadTokens: 42, stopReason: "end_turn"});
  });

  test("tolerates malformed JSONL lines and reports skipped count", () => {
    const text = lines([
      {type: "session_meta", timestamp: "2026-08-13T00:00:00Z", payload: {id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"}},
      '{"type": "response_item", "payload": {"type": "message", "role": "user", "content": "hello"}',
      {type: "response_item", timestamp: "2026-08-13T00:00:01Z", payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "hi"}]}}
    ]) + '{"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": "cut off';
    const parsed = parseSessionTransfer(text, "rollout.jsonl");
    expect(parsed.skippedLines).toBe(2);
    expect(parsed.nodes.map((node) => node.role)).toEqual(["assistant"]);
  });

  test("detects Claude format when file starts with snapshot records", () => {
    const text = lines([
      {type: "file-history-snapshot", messageId: "msg-1", snapshot: {}, isSnapshotUpdate: false},
      {type: "user", sessionId: "s1", uuid: "u1", parentUuid: null, timestamp: "2026-08-13T00:00:00Z", message: {role: "user", content: "hello"}}
    ]);
    const parsed = parseSessionTransfer(text, "session.jsonl");
    expect(parsed.format).toBe("claude");
    expect(parsed.nodes).toHaveLength(1);
  });

  test("imports Codex local shell calls, developer messages and usage", () => {
    const text = lines([
      {type: "session_meta", timestamp: "2026-08-13T00:00:00Z", payload: {id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:01Z", payload: {type: "message", role: "developer", content: "# AGENTS.md instructions for /tmp"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:02Z", payload: {type: "message", role: "user", content: [{type: "input_text", text: "list files"}]}},
      {type: "response_item", timestamp: "2026-08-13T00:00:03Z", payload: {type: "local_shell_call", call_id: "call_1", argv: ["ls"], cwd: "/tmp"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:04Z", payload: {type: "local_shell_call_output", call_id: "call_1", exit_code: 0, output: "file1"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:05Z", payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "Done."}], status: "completed", usage: {input_tokens: 10, output_tokens: 2}}}
    ]);
    const parsed = parseSessionTransfer(text, "rollout.jsonl");
    expect(parsed.nodes.map((node) => node.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(parsed.nodes[1].parts[0]).toMatchObject({type: "tool-call", name: "local_shell"});
    expect(parsed.nodes[1].parts[0].arguments).toEqual({argv: ["ls"], cwd: "/tmp"});
    expect(parsed.nodes[2].parts[0]).toMatchObject({type: "tool-result", toolCallId: "call_1", isError: false});
    expect(parsed.nodes[3].metadata?.custom?.imported?.usage).toMatchObject({inputTokens: 10, outputTokens: 2, stopReason: "completed"});
  });

  test("keeps non-injected Codex developer messages as system nodes", () => {
    const text = lines([
      {type: "session_meta", timestamp: "2026-08-13T00:00:00Z", payload: {id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:01Z", payload: {type: "message", role: "developer", content: [{type: "input_text", text: "System note: keep it short"}]}},
      {type: "response_item", timestamp: "2026-08-13T00:00:02Z", payload: {type: "message", role: "user", content: "hello"}}
    ]);
    const parsed = parseSessionTransfer(text, "rollout.jsonl");
    expect(parsed.nodes.map((node) => node.role)).toEqual(["system", "user"]);
  });

  test("skips Codex subagent sessions", () => {
    const text = lines([
      {type: "session_meta", timestamp: "2026-08-13T00:00:00Z", payload: {id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp", source: {subagent: {thread_spawn: {parent_thread_id: "p", depth: 1}}}}},
      {type: "response_item", timestamp: "2026-08-13T00:00:01Z", payload: {type: "message", role: "user", content: "inspect"}}
    ]);
    const parsed = parseSessionTransfer(text, "rollout.jsonl");
    expect(parsed.sessions).toHaveLength(0);
    expect(parsed.skippedReason).toContain("子 agent");
  });

  test("imports Claude compaction summary as system node", () => {
    const text = lines([
      {type: "user", sessionId: "s1", uuid: "u1", parentUuid: null, timestamp: "2026-08-13T00:00:00Z", message: {role: "user", content: "question"}},
      {type: "assistant", sessionId: "s1", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-13T00:00:01Z", message: {id: "msg_1", role: "assistant", content: [{type: "text", text: "answer"}]}},
      {type: "summary", sessionId: "s1", uuid: "sum1", parentUuid: "u1", timestamp: "2026-08-13T00:00:02Z", summary: "已压缩：讨论了问题"},
      {type: "user", sessionId: "s1", uuid: "u2", parentUuid: "sum1", timestamp: "2026-08-13T00:00:03Z", message: {role: "user", content: "继续"}}
    ]);
    const parsed = parseSessionTransfer(text, "claude.jsonl");
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.nodes[2].role).toBe("system");
    expect(parsed.nodes[2].parts).toEqual([{type: "summary", text: "已压缩：讨论了问题"}]);
    expect(parsed.nodes[3].parentSourceId).toBe("sum1");
  });

  test("merges chunked Claude tool result blocks with the same tool id", () => {
    const text = lines([
      {type: "user", sessionId: "s1", uuid: "u1", parentUuid: null, timestamp: "2026-08-13T00:00:00Z", message: {role: "user", content: [
        {type: "tool_result", tool_use_id: "toolu_1", content: [{type: "text", text: "chunk1"}]},
        {type: "tool_result", tool_use_id: "toolu_1", content: [{type: "text", text: "chunk2"}], is_error: true}
      ]}}
    ]);
    const parsed = parseSessionTransfer(text, "claude.jsonl");
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].parts).toEqual([{type: "tool-result", toolCallId: "toolu_1", content: "chunk1\nchunk2", isError: true}]);
  });

  test("parses extended Codex content block types", () => {
    const text = lines([
      {type: "session_meta", timestamp: "2026-08-13T00:00:00Z", payload: {id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:01Z", payload: {type: "message", role: "user", content: [
        {type: "input_file", filename: "a.txt", file_data: {file_id: "file-1"}},
        {type: "input_image", image_url: "https://example.com/x.png"},
        {type: "input_audio", input_audio: {data: "AAAA", format: "wav"}}
      ]}},
      {type: "response_item", timestamp: "2026-08-13T00:00:02Z", payload: {type: "message", role: "assistant", content: [
        {type: "refusal", text: "I cannot do that"},
        {type: "redacted_thinking", data: "enc", ciphertext: "cipher", signature: "sig"},
        {type: "web_search_call", id: "ws_1"}
      ]}},
      {type: "response_item", timestamp: "2026-08-13T00:00:03Z", payload: {type: "message", role: "assistant", content: [
        {type: "server_tool_use", id: "st_1", name: "github", input: {repo: "x"}},
        {type: "document", title: "doc.md", source: {type: "base64", media_type: "text/markdown", data: "ZGF0YQ=="}},
        {type: "image", source: {type: "url", url: "https://example.com/i.png", media_type: "image/png"}},
        {type: "web_search_result", id: "ws_1", title: "T", url: "https://example.com", content: [{type: "web_search_result_item", title: "T", content: "text"}]}
      ]}}
    ]);
    const parsed = parseSessionTransfer(text, "rollout.jsonl");
    const parts = parsed.nodes.map((node) => node.parts);
    expect(parts[0]).toEqual([
      {type: "file", name: "a.txt", fileId: "file-1"},
      {type: "image-url", url: "https://example.com/x.png"},
      {type: "audio", data: "AAAA", format: "wav"}
    ]);
    expect(parts[1]).toEqual([
      {type: "refusal", text: "I cannot do that"},
      {type: "redacted-thinking", data: "enc", ciphertext: "cipher", signature: "sig"},
      {type: "web-search-call", id: "ws_1"}
    ]);
    expect(parts[2]).toEqual([
      {type: "tool-call", id: "st_1", name: "github", arguments: {repo: "x"}},
      {type: "file", name: "doc.md", mimeType: "text/markdown", data: "ZGF0YQ=="},
      {type: "image-url", url: "https://example.com/i.png", mimeType: "image/png"},
      {type: "web-search-result", id: "ws_1", title: "T", url: "https://example.com", content: [{type: "web_search_result_item", title: "T", content: "text"}]}
    ]);
  });

  test("imports OMP assistant usage metadata", () => {
    const text = lines([
      {type: "session", version: 3, id: "omp-1", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"},
      {type: "message", id: "u1", parentId: null, timestamp: "2026-08-13T00:00:01Z", message: {role: "user", content: [{type: "text", text: "hello"}]}},
      {type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-13T00:00:02Z", message: {role: "assistant", content: [{type: "text", text: "hi"}], model: "claude-sonnet-4-5", usage: {input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100}, stopReason: "stop"}}
    ]);
    const parsed = parseSessionTransfer(text, "omp.jsonl");
    expect(parsed.nodes[1].metadata?.custom?.imported?.usage).toEqual({model: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 40, totalTokens: 100, stopReason: "stop"});
  });

  test("imports Codex web search result payloads with titles", () => {
    const text = lines([
      {type: "session_meta", timestamp: "2026-08-13T00:00:00Z", payload: {id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-08-13T00:00:00Z", cwd: "/tmp"}},
      {type: "response_item", timestamp: "2026-08-13T00:00:01Z", payload: {type: "web_search_call", call_id: "call_ws", action: "search", search: {query: "rust"}}},
      {type: "response_item", timestamp: "2026-08-13T00:00:02Z", payload: {type: "web_search_result", call_id: "call_ws", title: "Rust", content: [{type: "web_search_result_item", title: "Rust site", content: "The Rust programming language"}]}}
    ]);
    const parsed = parseSessionTransfer(text, "rollout.jsonl");
    expect(parsed.nodes[0].parts[0]).toMatchObject({type: "tool-call", id: "call_ws", name: "web_search"});
    expect(parsed.nodes[1].parts[0]).toMatchObject({type: "tool-result", toolCallId: "call_ws"});
    expect(parsed.nodes[1].parts[0].content).toBe("Rust\n\nRust site\nThe Rust programming language");
  });

});
