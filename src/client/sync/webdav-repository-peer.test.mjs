import {describe, expect, test} from "bun:test";
import {createMessageObject} from "../../shared/message-object.ts";
import {WebDavRepositoryPeer, normalizeWebDavUrl} from "./webdav-repository-peer.ts";

function hrefs(source) {
  return [...source.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((match) => match[1]);
}

function memoryWebDav() {
  const root = "/root/";
  const collections = new Set([root]);
  const resources = new Map();
  const requests = [];
  let revision = 0;

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method || "GET";
    const headers = new Headers(init.headers);
    requests.push({url: url.href, method, headers, body: init.body});
    if (method === "MKCOL") {
      if (collections.has(url.pathname)) return new Response(null, {status: 405});
      const parent = `${url.pathname.replace(/[^/]+\/?$/, "")}`;
      if (!collections.has(parent)) return new Response(null, {status: 409});
      collections.add(url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`);
      return new Response(null, {status: 201});
    }
    if (method === "PUT") {
      const current = resources.get(url.pathname);
      if (headers.get("if-none-match") === "*" && current) return new Response(null, {status: 412});
      if (headers.has("if-match") && headers.get("if-match") !== current?.etag) return new Response(null, {status: 412});
      const etag = `"v${++revision}"`;
      resources.set(url.pathname, {body: String(init.body), etag});
      return new Response(null, {status: current ? 204 : 201, headers: {ETag: etag}});
    }
    if (method === "GET") {
      const current = resources.get(url.pathname);
      if (!current) return Response.json({error: "missing"}, {status: 404});
      return new Response(current.body, {headers: {"Content-Type": "application/json", ETag: current.etag}});
    }
    if (method === "PROPFIND") {
      const prefix = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
      const children = [...resources.keys()].filter((pathname) => pathname.startsWith(prefix) && !pathname.slice(prefix.length).includes("/"));
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${prefix}</d:href></d:response>${children.map((pathname) => `<d:response><d:href>${pathname}</d:href></d:response>`).join("")}</d:multistatus>`;
      return new Response(xml, {status: 207, headers: {"Content-Type": "application/xml"}});
    }
    return new Response(null, {status: 405});
  };
  return {fetch, requests, resources};
}

function refUpdate(headMessageId) {
  return {
    conversationId: "conversation-1",
    expectedHeadMessageId: null,
    expectedHeadVersion: 0,
    expectedMetadataVersion: 0,
    headMessageId,
    name: "First conversation",
    providerId: "openai",
    model: "gpt-test",
    generationSettings: {reasoning: "auto", showReasoningSummary: false, temperature: null, maxOutputTokens: null},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("WebDAV repository peer", () => {
  test("calls the browser fetch implementation with its required receiver", async () => {
    const server = memoryWebDav();
    const originalFetch = globalThis.fetch;
    let receiver;
    globalThis.fetch = async function(input, init) {
      receiver = this;
      return server.fetch(input, init);
    };
    try {
      const peer = new WebDavRepositoryPeer("https://dav.example.test/root/");
      await peer.identity();
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("normalizes a root URL without performing implicit discovery", async () => {
    const server = memoryWebDav();
    const peer = new WebDavRepositoryPeer(
      "https://dav.example.test/root",
      {type: "basic", username: "alice", password: "correct horse battery staple"},
      undefined,
      server.fetch,
      hrefs
    );
    expect(normalizeWebDavUrl("https://dav.example.test/root///")).toBe("https://dav.example.test/root/");
    expect(server.requests).toHaveLength(0);
    const identity = await peer.identity();
    expect(identity.id).toStartWith("webdav:");
    expect(server.requests[0].headers.get("authorization")).toStartWith("Basic ");
    expect(server.requests.some((request) => request.method === "PUT" && request.url.endsWith(".turnfold-repository.json"))).toBe(true);
  });

  test("round-trips verified objects, CAS refs, and device-scoped working snapshots", async () => {
    const server = memoryWebDav();
    const repositoryId = "local:test-client";
    const object = await createMessageObject({
      parentMessageId: null,
      role: "user",
      parts: [{type: "text", text: "hello"}],
      origin: {type: "user"},
      completion: {status: "complete"},
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z"
    }, repositoryId);
    const peer = new WebDavRepositoryPeer("https://dav.example.test/root/", {type: "none"}, undefined, server.fetch, hrefs);
    const pushed = await peer.push({repositoryId, objects: [object], refs: [refUpdate(object.id)]});
    expect(pushed.refs[0].status).toBe("ok");
    expect(pushed.refs[0].ref.headVersion).toBe(1);

    const stale = await peer.push({repositoryId, objects: [], refs: [refUpdate(object.id)]});
    expect(stale.refs[0].status).toBe("conflict");
    expect(stale.refs[0].ref.headVersion).toBe(1);

    await peer.backupWorking({
      deviceId: repositoryId,
      snapshotAt: "2026-01-01T00:00:01.000Z",
      items: [{
        id: "draft-1",
        conversationId: "conversation-1",
        kind: "user-draft",
        observedHeadId: object.id,
        parts: [{type: "text", text: "draft"}],
        status: "editing",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z"
      }]
    });
    const pulled = await peer.pull({haveObjectIds: []});
    expect(pulled.refs).toHaveLength(1);
    expect(pulled.objects).toEqual([object]);
    expect(pulled.objectRepositoryIds[object.id]).toBe(repositoryId);
    expect([...server.resources.keys()].some((pathname) => pathname.startsWith("/root/working/"))).toBe(true);

    const objectPath = `/root/objects/${object.id.slice(7)}.json`;
    const stored = server.resources.get(objectPath);
    const envelope = JSON.parse(stored.body);
    envelope.object.parts[0].text = "tampered";
    server.resources.set(objectPath, {...stored, body: JSON.stringify(envelope)});
    await expect(peer.pull({haveObjectIds: []})).rejects.toThrow("content verification");
  });
});
