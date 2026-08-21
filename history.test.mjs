import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import http from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {createMessageObject} from "./src/shared/message-object.ts";

const root = process.cwd();
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "turnfold-history-test-"));
const databasePath = path.join(temporaryDirectory, "chat.db");

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
      NODE_ENV: "production",
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

const owner = {username: "sync-owner", sub: "owner-sub"};
const other = {username: "sync-other", sub: "other-sub"};
const repositoryId = "local:12345678-1234-4234-8234-123456789abc";
const legacyRepositoryId = "8daac02ed9a886768394ae58c97a63b9";
const generationSettings = {reasoning: "low", showReasoningSummary: false, temperature: null, maxOutputTokens: null};
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
  const removedConversationsRoute = await api(server.origin, owner, "/api/conversations");
  assert.equal(removedConversationsRoute.response.status, 404);

  const objectTimestamp = new Date().toISOString();
  const message = await createMessageObject({
    parentMessageId: null,
    role: "user",
    parts: [{type: "text", text: "local-first message"}],
    origin: {type: "user", clientId: "test-replica"},
    completion: {status: "complete"},
    createdAt: objectTimestamp,
    completedAt: objectTimestamp
  }, repositoryId);
  const ref = {
    conversationId: "sync-conversation",
    expectedHeadMessageId: null,
    expectedHeadVersion: 0,
    expectedMetadataVersion: 0,
    headMessageId: message.id,
    name: "sync conversation",
    providerId: "openai",
    model: "gpt-test",
    generationSettings,
    createdAt: objectTimestamp,
    updatedAt: objectTimestamp
  };

  const pushed = await api(server.origin, owner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({repositoryId, objects: [message], refs: [ref]})
  });
  assert.equal(pushed.response.status, 200);
  assert.equal(pushed.payload.refs[0].status, "ok");
  assert.equal(pushed.payload.refs[0].ref.headMessageId, message.id);

  const fetched = await api(server.origin, owner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: []})
  });
  assert.equal(fetched.response.status, 200);
  assert.equal(fetched.payload.objects[0].id, message.id);
  assert.equal(fetched.payload.objectRepositoryIds[message.id], repositoryId);
  assert.equal(fetched.payload.refs[0].id, "sync-conversation");
  assert.equal(fetched.payload.refs[0].name, "sync conversation");

  const fetchedWithHave = await api(server.origin, owner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: [message.id]})
  });
  assert.deepEqual(fetchedWithHave.payload.objects, []);
  assert.deepEqual(fetchedWithHave.payload.objectRepositoryIds, {});

  const legacyMessage = await createMessageObject({
    parentMessageId: null,
    role: "user",
    parts: [{type: "text", text: "legacy"}],
    origin: {type: "user"},
    completion: {status: "complete"},
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z"
  }, legacyRepositoryId);
  assert.equal(legacyMessage.id, "sha256:f86d83b562076f230bfa0abaea9461cf46cd6c8f218eb845a1d7f43d5bbc7898");
  const legacyPush = await api(server.origin, owner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      repositoryId,
      objectRepositoryIds: {[legacyMessage.id]: legacyRepositoryId},
      objects: [legacyMessage],
      refs: []
    })
  });
  assert.equal(legacyPush.response.status, 200);
  assert.equal(legacyPush.payload.insertedObjects, 1);
  const legacyFetch = await api(server.origin, owner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: [message.id]})
  });
  assert.deepEqual(legacyFetch.payload.objects, [legacyMessage]);
  assert.deepEqual(legacyFetch.payload.objectRepositoryIds, {[legacyMessage.id]: legacyRepositoryId});

  const alternateMessage = await createMessageObject({
    parentMessageId: null,
    role: "user",
    parts: [{type: "text", text: "alternate root"}],
    origin: {type: "user", clientId: "test-replica", sourceMessageId: message.id},
    completion: {status: "complete"},
    createdAt: new Date(Date.parse(objectTimestamp) + 1000).toISOString(),
    completedAt: new Date(Date.parse(objectTimestamp) + 1000).toISOString()
  }, repositoryId);
  const movedRef = await api(server.origin, owner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      repositoryId,
      objects: [alternateMessage],
      refs: [{
        ...ref,
        expectedHeadMessageId: message.id,
        expectedHeadVersion: pushed.payload.refs[0].ref.headVersion,
        expectedMetadataVersion: pushed.payload.refs[0].ref.metadataVersion,
        headMessageId: alternateMessage.id
      }]
    })
  });
  assert.equal(movedRef.response.status, 200);
  assert.equal(movedRef.payload.refs[0].status, "ok");

  const graphFetch = await api(server.origin, owner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: []})
  });
  assert.deepEqual(
    new Set(graphFetch.payload.objects.map((item) => item.id)),
    new Set([message.id, legacyMessage.id, alternateMessage.id])
  );

  const noModelPush = await api(server.origin, owner, "/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      repositoryId,
      objects: [],
      refs: [{...ref, conversationId: "no-model-conversation", headMessageId: null, providerId: "", model: ""}]
    })
  });
  assert.equal(noModelPush.response.status, 200);
  assert.equal(noModelPush.payload.refs[0].status, "ok");
  assert.equal(noModelPush.payload.refs[0].ref.providerId, "");
  assert.equal(noModelPush.payload.refs[0].ref.model, "");

  await stopServer(server.child);
  server = await startServer();

  const restored = await api(server.origin, owner, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: []})
  });
  assert.equal(restored.response.status, 200);
  assert.ok(restored.payload.objects.some((item) => item.id === message.id));
  assert.ok(restored.payload.refs.some((item) => item.id === "sync-conversation"));

  const otherFetch = await api(server.origin, other, "/api/sync/fetch", {
    method: "POST",
    body: JSON.stringify({haveObjectIds: []})
  });
  assert.deepEqual(otherFetch.payload.objects, []);
  assert.deepEqual(otherFetch.payload.refs, []);

  console.log("Repository sync tests passed");
} finally {
  if (server) await stopServer(server.child);
  rmSync(temporaryDirectory, {recursive: true, force: true});
}
