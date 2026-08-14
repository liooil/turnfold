import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import http from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {Database} from "bun:sqlite";
import {createHash} from "node:crypto";
import {createMessageObject} from "./src/shared/message-object.ts";

const root = process.cwd();
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "turnfold-history-test-"));
const databasePath = path.join(temporaryDirectory, "chat.db");

const legacyDatabase = new Database(databasePath, {create: true});
legacyDatabase.run(`
  CREATE TABLE chat_conversation (
    id TEXT PRIMARY KEY, owner_issuer TEXT NOT NULL, owner_sub TEXT NOT NULL, title TEXT NOT NULL,
    provider_id TEXT NOT NULL, model TEXT NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE chat_message (
    conversation_id TEXT NOT NULL REFERENCES chat_conversation(id) ON DELETE CASCADE,
    id TEXT NOT NULL, ordinal INTEGER NOT NULL, role TEXT NOT NULL, parts_json TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (conversation_id, id), UNIQUE (conversation_id, ordinal)
  );
`);
const legacyTimestamp = new Date().toISOString();
legacyDatabase.query("INSERT INTO chat_conversation VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run("legacy-conversation", "turnfold:test", "legacy-sub", "legacy/chat", "openai", "gpt-legacy", "{}", legacyTimestamp, legacyTimestamp);
legacyDatabase.query("INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?)")
  .run("legacy-conversation", "legacy-user", 0, "user", JSON.stringify([{type: "text", text: "legacy question"}]), legacyTimestamp);
legacyDatabase.query("INSERT INTO chat_message VALUES (?, ?, ?, ?, ?, ?)")
  .run("legacy-conversation", "legacy-assistant", 1, "assistant", JSON.stringify([{type: "text", text: "legacy answer"}]), legacyTimestamp);
legacyDatabase.close();

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Bun server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for history test server");
}

async function startServer() {
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(root, "src/server.ts")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      STATIC_ROOT: path.join(root, "dist"),
      CHAT_DATABASE_PATH: databasePath,
      BASE_PATH: "/chat",
      AUTH_ISSUER: "turnfold:test"
    },
    stdio: "ignore"
  });
  await waitForServer(`http://127.0.0.1:${port}/chat/api/health`, child);
  return {child, origin: `http://127.0.0.1:${port}`};
}

function stopServer(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
}

async function api(origin, identity, pathname, init = {}) {
  const response = await fetch(`${origin}/chat${pathname}`, {
    ...init,
    headers: {
      "X-Turnfold-Username": identity.username,
      "X-Turnfold-Sub": identity.sub,
      ...(init.body ? {"Content-Type": "application/json"} : {}),
      ...(init.headers || {})
    }
  });
  const payload = response.status === 204 ? null : await response.json();
  return {response, payload};
}

const owner = {username: "history-owner", sub: "owner-sub"};
const other = {username: "history-other", sub: "other-sub"};
const legacyOwner = {username: "history-legacy", sub: "legacy-sub"};
const distributedOwner = {username: "distributed-owner", sub: "distributed-sub"};
const longHistoryOwner = {username: "long-history-owner", sub: "long-history-sub"};
const localRepositoryOwner = {username: "local-repository-owner", sub: "local-repository-sub"};
const untitledOwner = {username: "untitled-owner", sub: "untitled-sub"};
let server;
try {
  server = await startServer();
  const publicConfigResponse = await fetch(`${server.origin}/chat/api/public-config`);
  assert.equal(publicConfigResponse.status, 404);
  const anonymousPrivateConfig = await fetch(`${server.origin}/chat/api/config`);
  assert.equal(anonymousPrivateConfig.status, 401);
  const privateConfig = await api(server.origin, owner, "/api/config");
  assert.equal(privateConfig.response.status, 200);
  assert.equal("providers" in privateConfig.payload, false);
  const removedChatRoute = await api(server.origin, owner, "/api/chat", {method: "POST", body: "{}"});
  assert.equal(removedChatRoute.response.status, 404);
  const migratedLegacy = await api(server.origin, legacyOwner, "/api/conversations/legacy-conversation");
  assert.equal(migratedLegacy.response.status, 200);
  assert.equal(migratedLegacy.payload.conversation.name, "legacy/chat");
  assert.equal(migratedLegacy.payload.conversation.messages.length, 2);
  assert.ok(migratedLegacy.payload.conversation.messages.every((message) => message.id.startsWith("sha256:")));
  assert.equal(migratedLegacy.payload.conversation.messages[1].parentMessageId, migratedLegacy.payload.conversation.messages[0].id);
  const initialSettings = {reasoning: "low", showReasoningSummary: false, temperature: null, maxOutputTokens: null};
  const createdResult = await api(server.origin, owner, "/api/conversations", {
    method: "POST",
    body: JSON.stringify({providerId: "openai", model: "gpt-test", generationSettings: initialSettings, name: "work/chat"})
  });
  assert.equal(createdResult.response.status, 201);
  assert.deepEqual(createdResult.payload.conversation.generationSettings, initialSettings);
  assert.equal(createdResult.payload.conversation.name, "work/chat");
  assert.equal(createdResult.payload.conversation.headMessageId, null);
  const untitledResult = await api(server.origin, untitledOwner, "/api/conversations", {
    method: "POST",
    body: JSON.stringify({providerId: "openai", model: "gpt-test", generationSettings: initialSettings})
  });
  assert.equal(untitledResult.response.status, 201);
  assert.equal(untitledResult.payload.conversation.name, "");
  const untitledUser = await api(server.origin, untitledOwner, `/api/conversations/${untitledResult.payload.conversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      id: "untitled-user",
      expectedHeadId: null,
      parentMessageId: null,
      role: "user",
      parts: [{type: "text", text: "这段文字不能直接成为标题"}],
      origin: {type: "user"},
      completion: {status: "complete"}
    })
  });
  assert.equal(untitledUser.response.status, 201);
  assert.equal(untitledUser.payload.conversation.name, "");
  const conversationId = createdResult.payload.conversation.id;
  const userResult = await api(server.origin, owner, `/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      id: "user-1",
      expectedHeadId: null,
      parentMessageId: null,
      role: "user",
      parts: [{type: "text", text: "persistent question"}],
      origin: {type: "user", clientId: "history-test"},
      completion: {status: "complete"}
    })
  });
  assert.equal(userResult.response.status, 201);
  assert.equal(userResult.payload.conversation.headMessageId, "user-1");
  const responseMetadata = {providerId: "openai", model: "gpt-test", durationMs: 2000, outputTokens: 40, tokensPerSecond: 20};
  const assistantResult = await api(server.origin, owner, `/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      id: "assistant-1",
      expectedHeadId: "user-1",
      parentMessageId: "user-1",
      role: "assistant",
      parts: [{type: "reasoning", text: "persistent reasoning"}, {type: "text", text: "persistent answer"}],
      origin: {type: "model", providerId: "openai", model: "gpt-test", attemptId: "attempt-1"},
      completion: {status: "complete"},
      metadata: {custom: {response: responseMetadata}}
    })
  });
  assert.equal(assistantResult.response.status, 201);
  assert.equal(assistantResult.payload.conversation.messageCount, 2);
  const conflict = await api(server.origin, owner, `/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({id: "conflict", expectedHeadId: "user-1", parentMessageId: "user-1", role: "assistant", parts: [], origin: {type: "legacy"}, completion: {status: "complete"}})
  });
  assert.equal(conflict.response.status, 409);
  const updatedSettings = {reasoning: "high", showReasoningSummary: true, temperature: 0.7, maxOutputTokens: 4096};
  const settingsResult = await api(server.origin, owner, `/api/conversations/${conversationId}`, {
    method: "PATCH",
    body: JSON.stringify({providerId: "openai", model: "gpt-test", generationSettings: updatedSettings, name: "work/chat/main"})
  });
  assert.equal(settingsResult.response.status, 200);
  assert.equal(settingsResult.payload.conversation.name, "work/chat/main");

  const branchResult = await api(server.origin, owner, "/api/conversations", {
    method: "POST",
    body: JSON.stringify({providerId: "openai", model: "gpt-test", generationSettings: initialSettings, name: "work/chat/branch", headMessageId: "user-1"})
  });
  assert.equal(branchResult.response.status, 201);
  assert.equal(branchResult.payload.conversation.messageCount, 1);
  assert.equal(branchResult.payload.conversation.messages[0].id, "user-1");

  const namespace = createHash("sha256").update(`turnfold:test\0${distributedOwner.sub}`).digest("hex").slice(0, 32);
  const objectTimestamp = new Date().toISOString();
  const distributedMessage = await createMessageObject({
    parentMessageId: null,
    role: "user",
    parts: [{type: "text", text: "local-first message"}],
    origin: {type: "user", clientId: "test-replica"},
    completion: {status: "complete"},
    createdAt: objectTimestamp,
    completedAt: objectTimestamp
  }, namespace);
  const distributedRef = {
    conversationId: "distributed-conversation",
    expectedHeadMessageId: null,
    expectedHeadVersion: 0,
    expectedMetadataVersion: 0,
    headMessageId: distributedMessage.id,
    name: "",
    providerId: "openai",
    model: "gpt-test",
    generationSettings: initialSettings,
    createdAt: objectTimestamp,
    updatedAt: objectTimestamp
  };
  const pushed = await api(server.origin, distributedOwner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({objects: [distributedMessage], refs: [distributedRef]})
  });
  assert.equal(pushed.response.status, 200);
  assert.equal(pushed.payload.refs[0].status, "ok");
  assert.equal(pushed.payload.refs[0].ref.headMessageId, distributedMessage.id);
  const fetched = await api(server.origin, distributedOwner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: []})
  });
  assert.equal(fetched.response.status, 200);
  assert.equal(fetched.payload.objects[0].id, distributedMessage.id);
  assert.equal(fetched.payload.refs[0].id, "distributed-conversation");
  assert.equal(fetched.payload.refs[0].name, "");
  const fetchedWithHave = await api(server.origin, distributedOwner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: [distributedMessage.id]})
  });
  assert.deepEqual(fetchedWithHave.payload.objects, []);
  const alternateMessage = await createMessageObject({
    parentMessageId: null,
    role: "user",
    parts: [{type: "text", text: "alternate root"}],
    origin: {type: "user", clientId: "test-replica", sourceMessageId: distributedMessage.id},
    completion: {status: "complete"},
    createdAt: new Date(Date.parse(objectTimestamp) + 1000).toISOString(),
    completedAt: new Date(Date.parse(objectTimestamp) + 1000).toISOString()
  }, namespace);
  const movedRef = await api(server.origin, distributedOwner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      objects: [alternateMessage],
      refs: [{
        ...distributedRef,
        expectedHeadMessageId: distributedMessage.id,
        expectedHeadVersion: pushed.payload.refs[0].ref.headVersion,
        expectedMetadataVersion: pushed.payload.refs[0].ref.metadataVersion,
        headMessageId: alternateMessage.id
      }]
    })
  });
  assert.equal(movedRef.payload.refs[0].status, "ok");
  const graphFetch = await api(server.origin, distributedOwner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: []})
  });
  assert.deepEqual(new Set(graphFetch.payload.objects.map((message) => message.id)), new Set([distributedMessage.id, alternateMessage.id]));

  const longHistoryNamespace = createHash("sha256").update(`turnfold:test\0${longHistoryOwner.sub}`).digest("hex").slice(0, 32);
  const longHistoryObjects = [];
  let longHistoryParentId = null;
  for (let index = 0; index < 501; index += 1) {
    const message = await createMessageObject({
      parentMessageId: longHistoryParentId,
      role: index % 2 ? "assistant" : "user",
      parts: [{type: "text", text: `long history ${index}`}],
      origin: {type: "legacy"},
      completion: {status: "complete"},
      createdAt: new Date(Date.parse(objectTimestamp) + index).toISOString(),
      completedAt: new Date(Date.parse(objectTimestamp) + index).toISOString()
    }, longHistoryNamespace);
    longHistoryObjects.push(message);
    longHistoryParentId = message.id;
  }
  const longHistoryPush = await api(server.origin, longHistoryOwner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      objects: longHistoryObjects,
      refs: [{
        conversationId: "long-history-conversation",
        expectedHeadMessageId: null,
        expectedHeadVersion: 0,
        expectedMetadataVersion: 0,
        headMessageId: longHistoryParentId,
        name: "long history",
        providerId: "openai",
        model: "gpt-test",
        generationSettings: initialSettings,
        createdAt: objectTimestamp,
        updatedAt: objectTimestamp
      }]
    })
  });
  assert.equal(longHistoryPush.response.status, 200);
  const longHistory = await api(server.origin, longHistoryOwner, "/api/conversations/long-history-conversation");
  assert.equal(longHistory.response.status, 200);
  assert.equal(longHistory.payload.conversation.messages.length, 501);

  const localRepositoryId = "local:12345678-1234-4234-8234-123456789abc";
  const localRepositoryMessage = await createMessageObject({
    parentMessageId: null,
    role: "user",
    parts: [{type: "text", text: "created before login"}],
    origin: {type: "user", clientId: "12345678-1234-4234-8234-123456789abc"},
    completion: {status: "complete"},
    createdAt: objectTimestamp,
    completedAt: objectTimestamp
  }, localRepositoryId);
  const localRepositoryPush = await api(server.origin, localRepositoryOwner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      repositoryId: localRepositoryId,
      objects: [localRepositoryMessage],
      refs: [{...distributedRef, conversationId: "pre-login-conversation", headMessageId: localRepositoryMessage.id}]
    })
  });
  assert.equal(localRepositoryPush.response.status, 200);
  assert.equal(localRepositoryPush.payload.refs[0].status, "ok");
  const rejectedHash = await api(server.origin, distributedOwner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({objects: [{...distributedMessage, id: `sha256:${"0".repeat(64)}`}], refs: []})
  });
  assert.equal(rejectedHash.response.status, 400);
  const rejectedLease = await api(server.origin, distributedOwner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({objects: [], refs: [{...distributedRef, expectedHeadVersion: 0, headMessageId: null}]})
  });
  assert.equal(rejectedLease.payload.refs[0].status, "conflict");

  await stopServer(server.child);
  server = await startServer();
  const restored = await api(server.origin, owner, `/api/conversations/${conversationId}`);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.conversation.messages.length, 2);
  assert.ok(restored.payload.conversation.messages.every((message) => message.id.startsWith("sha256:")));
  assert.equal(restored.payload.conversation.messages[1].parentMessageId, restored.payload.conversation.messages[0].id);
  assert.deepEqual(restored.payload.conversation.messages[1].metadata.custom.response, responseMetadata);
  assert.deepEqual(restored.payload.conversation.generationSettings, updatedSettings);

  const ownerList = await api(server.origin, owner, "/api/conversations");
  assert.equal(ownerList.payload.conversations.length, 2);

  const otherList = await api(server.origin, other, "/api/conversations");
  assert.deepEqual(otherList.payload.conversations, []);
  assert.equal((await api(server.origin, other, `/api/conversations/${conversationId}`)).response.status, 404);
  assert.equal((await api(server.origin, other, `/api/conversations/${conversationId}`, {method: "DELETE"})).response.status, 404);

  assert.equal((await api(server.origin, owner, `/api/conversations/${conversationId}`, {method: "DELETE"})).response.status, 204);
  assert.equal((await api(server.origin, owner, `/api/conversations/${conversationId}`)).response.status, 404);
  assert.equal((await api(server.origin, owner, `/api/conversations/${branchResult.payload.conversation.id}`)).payload.conversation.messages[0].parts[0].text, "persistent question");
  console.log("Chat history API tests passed");
} finally {
  if (server) await stopServer(server.child);
  rmSync(temporaryDirectory, {recursive: true, force: true});
}
