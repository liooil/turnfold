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

});
